import { Command } from "commander";
import * as p from "@clack/prompts";
import color from "picocolors";
import process from "node:process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ensureDocker, ensureImage } from "./env.js";
import { SandboxManager } from "./sandbox.js";
import { execInContainer, healthCheck } from "./exec.js";
import { DEFAULT_IMAGE, type SandboxConfig, defaultConfig } from "./config.js";
import { startMcpServer, type McpServerOptions } from "./mcp-server.js";
import {
  COPILOT_INSTRUCTIONS,
  CURSOR_RULES,
  MCP_SERVER_ENTRY,
} from "./templates.js";

const VERSION = "0.1.0";

const ASCII_ART = `
${color.cyan("╔══════════════════════════════════╗")}
${color.cyan("║")}  ${color.bold(color.white("agent-docker"))}  ${color.dim(`v${VERSION}`)}          ${color.cyan("║")}
${color.cyan("║")}  ${color.dim("Docker sandbox for AI agents")}   ${color.cyan("║")}
${color.cyan("╚══════════════════════════════════╝")}
`;

const program = new Command();

// 在项目创建 .vscode/mcp.json、.cursor/mcp.json 等配置
async function scaffoldProject(dir: string): Promise<void> {
  const githubDir = path.join(dir, ".github");
  const instructionsPath = path.join(githubDir, "copilot-instructions.md");

  await fsp.mkdir(githubDir, { recursive: true });

  if (fs.existsSync(instructionsPath)) {
    p.log.info(
      `${color.dim(".github/copilot-instructions.md")} already exists — skipping`,
    );
  } else {
    await fsp.writeFile(instructionsPath, COPILOT_INSTRUCTIONS, "utf8");
    p.log.success(`Created ${color.cyan(".github/copilot-instructions.md")}`);
  }

  const vscodeDir = path.join(dir, ".vscode");
  const mcpPath = path.join(vscodeDir, "mcp.json");

  await fsp.mkdir(vscodeDir, { recursive: true });

  interface McpConfig {
    servers?: Record<string, unknown>;
    mcpServers?: Record<string, unknown>;
    [key: string]: unknown;
  }

  let mcpConfig: McpConfig = { servers: {} };

  if (fs.existsSync(mcpPath)) {
    try {
      const raw = await fsp.readFile(mcpPath, "utf8");
      mcpConfig = JSON.parse(raw) as McpConfig;
      if (!mcpConfig.servers) mcpConfig.servers = {};
    } catch {
      p.log.warn(
        `${color.dim(".vscode/mcp.json")} exists but is not valid JSON — overwriting`,
      );
      mcpConfig = { servers: {} };
    }
  }

  if ("agent-docker" in (mcpConfig.servers ?? {})) {
    p.log.info(
      `${color.dim(".vscode/mcp.json")} already contains ${color.cyan("agent-docker")} entry — skipping`,
    );
  } else {
    mcpConfig.servers = {
      ...mcpConfig.servers,
      "agent-docker": MCP_SERVER_ENTRY,
    };
    await fsp.writeFile(
      mcpPath,
      JSON.stringify(mcpConfig, null, 2) + "\n",
      "utf8",
    );
    p.log.success(
      `Updated ${color.cyan(".vscode/mcp.json")} with agent-docker server`,
    );
  }

  const cursorRulesPath = path.join(dir, ".cursorrules");
  if (fs.existsSync(cursorRulesPath)) {
    p.log.info(`${color.dim(".cursorrules")} already exists — skipping`);
  } else {
    await fsp.writeFile(cursorRulesPath, CURSOR_RULES, "utf8");
    p.log.success(`Created ${color.cyan(".cursorrules")}`);
  }

  const cursorDir = path.join(dir, ".cursor");
  const cursorMcpPath = path.join(cursorDir, "mcp.json");
  await fsp.mkdir(cursorDir, { recursive: true });

  let cursorMcpConfig: McpConfig = { mcpServers: {} };

  if (fs.existsSync(cursorMcpPath)) {
    try {
      const raw = await fsp.readFile(cursorMcpPath, "utf8");
      cursorMcpConfig = JSON.parse(raw) as McpConfig;
      if (!cursorMcpConfig.mcpServers) cursorMcpConfig.mcpServers = {};
    } catch {
      p.log.warn(
        `${color.dim(".cursor/mcp.json")} exists but is not valid JSON — overwriting`,
      );
      cursorMcpConfig = { mcpServers: {} };
    }
  }

  if ("agent-docker" in (cursorMcpConfig.mcpServers ?? {})) {
    p.log.info(
      `${color.dim(".cursor/mcp.json")} already contains ${color.cyan("agent-docker")} entry — skipping`,
    );
  } else {
    cursorMcpConfig.mcpServers = {
      ...cursorMcpConfig.mcpServers,
      "agent-docker": MCP_SERVER_ENTRY,
    };
    await fsp.writeFile(
      cursorMcpPath,
      JSON.stringify(cursorMcpConfig, null, 2) + "\n",
      "utf8",
    );
    p.log.success(
      `Updated ${color.cyan(".cursor/mcp.json")} with agent-docker server`,
    );
  }
}

program
  .name("agent-docker")
  .description("Lightweight Docker sandbox CLI with MCP protocol support")
  .version(VERSION);

program
  .command("init")
  .description(
    "Initialize the sandbox environment (check Docker, pull image, scaffold MCP config)",
  )
  .option("-i, --image <image>", "Docker image to use", DEFAULT_IMAGE)
  .option(
    "--skip-scaffold",
    "Skip writing .vscode/mcp.json and .github/copilot-instructions.md",
    false,
  )
  .option(
    "--serve",
    "Start the MCP server after initialization (blocks the terminal)",
    false,
  )
  .action(
    async (opts: { image: string; skipScaffold: boolean; serve: boolean }) => {
      console.log(ASCII_ART);
      p.intro(color.bgCyan(color.black(" agent-docker init ")));

      const docker = await ensureDocker();
      await ensureImage(docker, opts.image);

      if (!opts.skipScaffold) {
        await scaffoldProject(process.cwd());
      }

      const manager = new SandboxManager(docker);
      const workDir = process.cwd();
      let existing = await manager.findForProject(workDir);

      if (existing) {
        if (existing.state !== "active") {
          p.log.info(`Resuming existing sandbox: ${color.cyan(existing.name)}`);
          const info = await manager.resume(existing.id);
          const healthy = await healthCheck(docker, info.id);
          if (healthy) {
            p.log.success("Health check passed");
          }
        } else {
          p.log.info(`Sandbox is already active: ${color.cyan(existing.name)}`);
        }
      } else {
        p.log.info("Creating new sandbox...");
        const config: SandboxConfig = {
          ...defaultConfig,
          image: opts.image,
          workDir,
          autoRemove: false,
        };
        const info = await manager.create(config);
        const healthy = await healthCheck(docker, info.id);
        if (healthy) {
          p.log.success("Health check passed");
        }
        p.log.info(`Workspace: ${color.dim(workDir)} (identity-mounted)`);
      }

      if (opts.serve) {
        p.outro(color.green("Environment is ready! Starting MCP Server..."));
        await startMcpServer({ projectDir: workDir, image: opts.image });
      } else {
        p.outro(color.green("Environment is ready!"));
      }
    },
  );

program
  .command("start")
  .description("Start a new sandbox container for the current directory")
  .option("-i, --image <image>", "Docker image to use", DEFAULT_IMAGE)
  .option("-n, --name <name>", "Container name")
  .option("--rm", "Automatically remove container on exit", false)
  .option("-e, --env <vars...>", "Environment variables (KEY=VALUE)")
  .option("--resume", "Resume an existing sandbox if available", false)
  .action(
    async (opts: {
      image: string;
      name?: string;
      rm: boolean;
      env?: string[];
      resume: boolean;
    }) => {
      console.log(ASCII_ART);
      p.intro(color.bgCyan(color.black(" agent-docker start ")));

      const docker = await ensureDocker();
      const manager = new SandboxManager(docker);
      const workDir = process.cwd();

      if (opts.resume) {
        const existing = await manager.findForProject(workDir);
        if (existing) {
          if (existing.state === "active") {
            p.log.info(
              `Found active sandbox: ${color.cyan(existing.name)} (${color.dim(existing.id.slice(0, 12))})`,
            );
            p.outro(color.green("Sandbox is already running!"));
            return;
          }

          const shouldResume = await p.confirm({
            message: `Found existing sandbox ${color.cyan(existing.name)}. Resume it?`,
          });

          if (p.isCancel(shouldResume)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
          }

          if (shouldResume) {
            const info = await manager.resume(existing.id);
            const healthy = await healthCheck(docker, info.id);
            if (healthy) {
              p.log.success("Health check passed");
            } else {
              p.log.warn(
                "Health check failed - container may not be fully ready",
              );
            }
            p.outro(color.green(`Sandbox resumed: ${color.cyan(info.name)}`));
            return;
          }
        }
      }

      const config: SandboxConfig = {
        ...defaultConfig,
        image: opts.image,
        workDir,
        autoRemove: opts.rm,
        name: opts.name,
        env: opts.env,
      };

      const info = await manager.create(config);

      const healthy = await healthCheck(docker, info.id);
      if (healthy) {
        p.log.success("Health check passed");
      } else {
        p.log.warn("Health check failed - container may not be fully ready");
      }

      p.log.info(`Workspace: ${color.dim(workDir)} (identity-mounted)`);
      p.log.info(`Container: ${color.dim(info.id.slice(0, 12))}`);

      p.outro(color.green(`Sandbox ${color.cyan(info.name)} is ready!`));
    },
  );

program
  .command("stop")
  .description("Stop the sandbox container for the current directory")
  .option("-a, --all", "Stop all managed sandboxes", false)
  .option("--id <containerId>", "Stop a specific container by ID")
  .action(async (opts: { all: boolean; id?: string }) => {
    p.intro(color.bgCyan(color.black(" agent-docker stop ")));

    const docker = await ensureDocker();
    const manager = new SandboxManager(docker);

    if (opts.id) {
      await manager.stop(opts.id);
      p.outro(color.green("Sandbox stopped."));
      return;
    }

    if (opts.all) {
      const sandboxes = await manager.list();
      const active = sandboxes.filter((s) => s.state === "active");
      if (active.length === 0) {
        p.log.info("No active sandboxes found.");
        p.outro("Nothing to do.");
        return;
      }
      for (const sandbox of active) {
        await manager.stop(sandbox.id);
      }
      p.outro(color.green(`Stopped ${active.length} sandbox(es).`));
      return;
    }

    // 默认停止当前目录容器
    const existing = await manager.findForProject(process.cwd());
    if (!existing || existing.state !== "active") {
      p.log.info("No active sandbox found for this directory.");
      p.outro("Nothing to do.");
      return;
    }

    await manager.stop(existing.id);
    p.outro(color.green("Sandbox stopped."));
  });

program
  .command("ps")
  .description("List all managed sandbox containers")
  .option("--json", "Output as JSON", false)
  .action(async (opts: { json: boolean }) => {
    const docker = await ensureDocker();
    const manager = new SandboxManager(docker);
    const sandboxes = await manager.list();

    if (opts.json) {
      console.log(JSON.stringify(sandboxes, null, 2));
      return;
    }

    if (sandboxes.length === 0) {
      p.log.info("No managed sandboxes found.");
      return;
    }

    p.intro(color.bgCyan(color.black(" agent-docker ps ")));

    const stateColors: Record<string, (s: string) => string> = {
      active: color.green,
      persisted: color.yellow,
      stopped: color.red,
      template: color.dim,
    };

    for (const sandbox of sandboxes) {
      const stateColor = stateColors[sandbox.state] ?? color.dim;
      p.log.message(
        [
          `${color.bold(sandbox.name)} ${stateColor(`[${sandbox.state}]`)}`,
          `  ID:      ${color.dim(sandbox.id.slice(0, 12))}`,
          `  Image:   ${sandbox.image}`,
          `  Project: ${color.dim(sandbox.projectDir)}`,
          `  Created: ${color.dim(sandbox.createdAt)}`,
        ].join("\n"),
      );
    }

    p.outro(`${sandboxes.length} sandbox(es) total`);
  });

program
  .command("exec")
  .description("Execute a command in the sandbox for the current directory")
  .argument("<cmd...>", "Command to execute")
  .option("--id <containerId>", "Target a specific container by ID")
  .action(async (cmd: string[], opts: { id?: string }) => {
    const docker = await ensureDocker();
    const manager = new SandboxManager(docker);

    let containerId: string;

    if (opts.id) {
      containerId = opts.id;
    } else {
      const existing = await manager.findForProject(process.cwd());
      if (!existing || existing.state !== "active") {
        p.log.error(
          "No active sandbox found for this directory. Run " +
            color.cyan("agent-docker start") +
            " first.",
        );
        process.exit(1);
      }
      containerId = existing.id;
    }

    const command = cmd.join(" ");
    const result = await execInContainer(docker, containerId, command);
    process.exit(result.exitCode);
  });

program
  .command("rm")
  .description("Remove a stopped sandbox container")
  .option("--id <containerId>", "Remove a specific container by ID")
  .option("-f, --force", "Force remove (even if running)", false)
  .option("-a, --all", "Remove all managed sandboxes", false)
  .action(async (opts: { id?: string; force: boolean; all: boolean }) => {
    p.intro(color.bgCyan(color.black(" agent-docker rm ")));

    const docker = await ensureDocker();
    const manager = new SandboxManager(docker);

    if (opts.all) {
      const sandboxes = await manager.list();
      if (sandboxes.length === 0) {
        p.log.info("No managed sandboxes found.");
        p.outro("Nothing to do.");
        return;
      }
      for (const sandbox of sandboxes) {
        await manager.remove(sandbox.id, opts.force);
      }
      p.outro(color.green(`Removed ${sandboxes.length} sandbox(es).`));
      return;
    }

    if (opts.id) {
      await manager.remove(opts.id, opts.force);
      p.outro(color.green("Sandbox removed."));
      return;
    }

    const existing = await manager.findForProject(process.cwd());
    if (!existing) {
      p.log.info("No sandbox found for this directory.");
      p.outro("Nothing to do.");
      return;
    }

    await manager.remove(existing.id, opts.force);
    p.outro(color.green("Sandbox removed."));
  });

program
  .command("cleanup")
  .description(
    "Remove orphaned containers whose project directories no longer exist",
  )
  .action(async () => {
    p.intro(color.bgCyan(color.black(" agent-docker cleanup ")));

    const docker = await ensureDocker();
    const manager = new SandboxManager(docker);
    const removed = await manager.cleanup();

    if (removed === 0) {
      p.log.info("No orphaned containers found.");
    } else {
      p.log.success(`Removed ${removed} orphaned container(s).`);
    }

    p.outro("Cleanup complete.");
  });

program
  .command("serve")
  .description(
    "Start the MCP server (stdio transport) for AI agent integration. " +
      "Automatically creates/resumes a sandbox for the project directory.",
  )
  .option("--project-dir <dir>", "Project directory to bind (default: cwd)")
  .option("-i, --image <image>", "Docker image to use", DEFAULT_IMAGE)
  .action(async (opts: { projectDir?: string; image?: string }) => {
    const mcpOpts: McpServerOptions = {};
    if (opts.projectDir) {
      mcpOpts.projectDir = opts.projectDir;
    }
    if (opts.image) {
      mcpOpts.image = opts.image;
    }

    await startMcpServer(mcpOpts);
  });

process.on("SIGINT", async () => {
  p.log.warn("\nReceived SIGINT, shutting down...");

  try {
    const docker = new (await import("dockerode")).default({
      socketPath: "/var/run/docker.sock",
    });
    const manager = new SandboxManager(docker);
    const sandboxes = await manager.list();
    const active = sandboxes.filter((s) => s.state === "active");

    if (active.length > 0) {
      p.log.info(`Stopping ${active.length} active sandbox(es)...`);
      for (const sandbox of active) {
        try {
          await manager.stop(sandbox.id);
        } catch {
          // Best effort on SIGINT
        }
      }
    }
  } catch {
    // Ignore errors during shutdown
  }

  process.exit(0);
});

program.parse();
