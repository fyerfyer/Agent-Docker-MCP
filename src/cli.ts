import { Command } from "commander";
import * as p from "@clack/prompts";
import color from "picocolors";
import process from "node:process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import figlet from "figlet";
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
import {
  createSession,
  endSession,
  listSessions,
  listSessionsByProject,
  getSession,
  findSessionByPrefix,
  getSessionLogs,
  appendLog,
  formatDuration,
  shortenPath,
} from "./db/session.js";
import { initDb } from "./db/index.js";

const VERSION = "0.1.0";

function renderBanner(): string {
  try {
    const raw = figlet.textSync("agent-docker", {
      font: "Small",
      horizontalLayout: "default",
    });

    const lines = raw.split("\n");
    const colors = [
      color.cyan,
      color.blue,
      color.magenta,
      color.blue,
      color.cyan,
    ];
    const gradient = lines
      .map((line, i) => {
        const colorFn = colors[i % colors.length]!;
        return colorFn(line);
      })
      .join("\n");

    return `\n${gradient}\n  ${color.dim(`v${VERSION}`)}  ${color.dim("— Docker sandbox for AI agents")}\n`;
  } catch {
    return `\n${color.cyan(color.bold("  agent-docker"))}  ${color.dim(`v${VERSION}`)}\n  ${color.dim("Docker sandbox for AI agents")}\n`;
  }
}

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
      console.log(renderBanner());
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
      console.log(renderBanner());
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

      // 跟踪 Session
      try {
        const session = await createSession(workDir, info.id);
        await appendLog(
          session.id,
          "system_event",
          `Sandbox created: ${info.name} (${info.id.slice(0, 12)})`,
        );
        p.log.info(`Session: ${color.cyan(session.id)}`);
      } catch {
        // Non-fatal
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
      try {
        const allSessions = await listSessions(100);
        for (const s of allSessions) {
          if (s.containerId === opts.id && s.status === "active") {
            await endSession(s.id, "completed");
            await appendLog(
              s.id,
              "system_event",
              "Sandbox stopped by user (--id)",
            );
          }
        }
      } catch {
        // non-fatal
      }
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
    try {
      const allSessions = await listSessions(100);
      for (const s of allSessions) {
        if (s.containerId === existing.id && s.status === "active") {
          await endSession(s.id, "completed");
          await appendLog(s.id, "system_event", "Sandbox stopped by user");
        }
      }
    } catch {
      // non-fatal
    }
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
  .command("history")
  .alias("ls")
  .description("List past sandbox sessions")
  .option("-n, --limit <number>", "Number of sessions to show", "20")
  .option("-p, --project", "Show only sessions for current directory", false)
  .option("--json", "Output as JSON", false)
  .action(async (opts: { limit: string; project: boolean; json: boolean }) => {
    await initDb();
    const limit = parseInt(opts.limit, 10) || 20;

    const results = opts.project
      ? await listSessionsByProject(process.cwd(), limit)
      : await listSessions(limit);

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      p.log.info("No sessions found.");
      return;
    }

    console.log(renderBanner());
    p.intro(color.bgCyan(color.black(" agent-docker history ")));

    const header = [
      color.bold(color.white("SESSION ID".padEnd(12))),
      color.bold(color.white("PROJECT".padEnd(30))),
      color.bold(color.white("STATUS".padEnd(20))),
      color.bold(color.white("DURATION".padEnd(12))),
      color.bold(color.white("CREATED AT")),
    ].join("  ");

    console.log(`  ${header}`);
    console.log(`  ${color.dim("─".repeat(100))}`);

    const statusColors: Record<string, (s: string) => string> = {
      active: color.green,
      completed: color.blue,
      error: color.red,
      terminated_by_user: color.yellow,
    };

    for (const session of results) {
      const statusColor = statusColors[session.status] ?? color.dim;
      const duration = formatDuration(session.createdAt, session.endedAt);
      const projectDisplay = shortenPath(session.projectPath);

      const row = [
        color.cyan(session.id.padEnd(12)),
        color.dim(
          projectDisplay.length > 28
            ? projectDisplay.slice(-28)
            : projectDisplay.padEnd(30),
        ),
        statusColor(session.status.padEnd(20)),
        color.white(duration.padEnd(12)),
        color.dim(session.createdAt.replace("T", " ").slice(0, 19)),
      ].join("  ");

      console.log(`  ${row}`);
    }

    console.log();
    p.outro(`${results.length} session(s) shown`);
  });

program
  .command("replay")
  .description(
    "Replay the log output of a past session (like asciinema for your sandbox)",
  )
  .argument("<sessionId>", "Session ID (or unique prefix)")
  .option(
    "-f, --follow",
    "Simulate real-time playback with delays between log entries",
    false,
  )
  .option(
    "-s, --speed <multiplier>",
    "Playback speed multiplier (e.g. 2 = 2x faster, 0.5 = half speed)",
    "1",
  )
  .action(
    async (sessionId: string, opts: { follow: boolean; speed: string }) => {
      await initDb();

      let session = await getSession(sessionId);
      if (!session) {
        session = await findSessionByPrefix(sessionId);
      }
      if (!session) {
        p.log.error(
          `Session ${color.cyan(sessionId)} not found. Run ${color.cyan("agent-docker history")} to see available sessions.`,
        );
        process.exit(1);
      }

      const sessionLogs = await getSessionLogs(session.id);

      if (sessionLogs.length === 0) {
        p.log.info(`Session ${color.cyan(session.id)} has no logs.`);
        return;
      }

      console.log(renderBanner());
      p.intro(color.bgCyan(color.black(" agent-docker replay ")));

      const statusColors: Record<string, (s: string) => string> = {
        active: color.green,
        completed: color.blue,
        error: color.red,
        terminated_by_user: color.yellow,
      };
      const statusColor = statusColors[session.status] ?? color.dim;

      p.log.message(
        [
          `${color.bold("Session:")}  ${color.cyan(session.id)}`,
          `${color.bold("Project:")}  ${color.dim(shortenPath(session.projectPath))}`,
          `${color.bold("Status:")}   ${statusColor(session.status)}`,
          `${color.bold("Created:")}  ${color.dim(session.createdAt.replace("T", " ").slice(0, 19))}`,
          session.endedAt
            ? `${color.bold("Ended:")}    ${color.dim(session.endedAt.replace("T", " ").slice(0, 19))}`
            : "",
          `${color.bold("Duration:")} ${formatDuration(session.createdAt, session.endedAt)}`,
          `${color.bold("Logs:")}     ${sessionLogs.length} entries`,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      console.log(`\n  ${color.dim("─".repeat(80))}\n`);

      const speed = parseFloat(opts.speed) || 1;
      const typeStyles: Record<
        string,
        { prefix: string; colorFn: (s: string) => string }
      > = {
        mcp_tool_call: {
          prefix: "▶ MCP",
          colorFn: color.green,
        },
        container_stdout: {
          prefix: "  OUT",
          colorFn: color.dim,
        },
        container_stderr: {
          prefix: "  ERR",
          colorFn: color.red,
        },
        system_event: {
          prefix: "  SYS",
          colorFn: color.blue,
        },
      };

      let prevTimestamp: number | null = null;

      for (const log of sessionLogs) {
        const style = typeStyles[log.type] ?? {
          prefix: "  ???",
          colorFn: color.dim,
        };

        if (opts.follow && prevTimestamp !== null) {
          const currentTs = new Date(log.timestamp).getTime();
          const diff = currentTs - prevTimestamp;
          const delay = Math.min(diff / speed, 3000); 
          if (delay > 50) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
        prevTimestamp = new Date(log.timestamp).getTime();

        const timeStr = log.timestamp.replace("T", " ").slice(11, 19);
        const prefix = style.colorFn(`[${timeStr}] ${style.prefix}`);

        const lines = log.payload.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (i === 0) {
            console.log(`  ${prefix}  ${style.colorFn(lines[i]!)}`);
          } else {
            const padding = " ".repeat(
              timeStr.length + style.prefix.length + 5,
            );
            console.log(`  ${padding}${style.colorFn(lines[i]!)}`);
          }
        }
      }

      console.log();
      p.outro(`Replay complete — ${sessionLogs.length} log entries`);
    },
  );

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
