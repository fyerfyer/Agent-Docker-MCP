import { Command } from "commander";
import * as p from "@clack/prompts";
import color from "picocolors";
import process from "node:process";
import { ensureDocker, ensureImage } from "./env.js";
import { SandboxManager } from "./sandbox.js";
import { execInContainer, healthCheck } from "./exec.js";
import { DEFAULT_IMAGE, type SandboxConfig, defaultConfig } from "./config.js";

const VERSION = "0.1.0";

const ASCII_ART = `
${color.cyan("╔══════════════════════════════════╗")}
${color.cyan("║")}  ${color.bold(color.white("agent-docker"))}  ${color.dim(`v${VERSION}`)}          ${color.cyan("║")}
${color.cyan("║")}  ${color.dim("Docker sandbox for AI agents")}   ${color.cyan("║")}
${color.cyan("╚══════════════════════════════════╝")}
`;

const program = new Command();

program
  .name("agent-docker")
  .description("Lightweight Docker sandbox CLI with MCP protocol support")
  .version(VERSION);

program
  .command("init")
  .description("Initialize the sandbox environment (check Docker, pull image)")
  .option("-i, --image <image>", "Docker image to use", DEFAULT_IMAGE)
  .action(async (opts: { image: string }) => {
    console.log(ASCII_ART);
    p.intro(color.bgCyan(color.black(" agent-docker init ")));

    const docker = await ensureDocker();
    await ensureImage(docker, opts.image);

    p.outro(color.green("Environment is ready!"));
  });

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

      p.log.info(
        `Workspace: ${color.dim(workDir)} → ${color.dim("/workspace")}`,
      );
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
