/**
 *  exec_bash                  – 在沙箱内执行 bash 命令
 *  install_system_dependency  – 以 root 权限热安装系统依赖
 *  rebuild_sandbox            – 根据 .agent-docker/Dockerfile 重建沙箱
 *  get_env                    – 读取沙箱内的环境变量
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Docker from "dockerode";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { execInContainer, execQuiet, healthCheck } from "./exec.js";
import { DEFAULT_IMAGE, type SandboxConfig, defaultConfig } from "./config.js";
import { SandboxManager } from "./sandbox.js";
import { ensureDocker, ensureImage } from "./env.js";
import { existsSync } from "node:fs";
import { createSession, endSession, appendLog } from "./db/session.js";
import { initDb } from "./db/index.js";

async function resolveContainer(
  manager: SandboxManager,
  containerId?: string,
): Promise<string> {
  if (containerId) return containerId;

  const projectDir = process.env.AGENT_DOCKER_PROJECT_DIR ?? process.cwd();
  const sandbox = await manager.findForProject(projectDir);
  if (!sandbox || sandbox.state !== "active") {
    throw new Error(
      `No active sandbox found for project directory: ${projectDir}. ` +
        "Start one with `agent-docker start` first.",
    );
  }
  return sandbox.id;
}

function buildServerInstructions(projectDir: string): string {
  return `You are running in a strictly mapped ephemeral sandbox. The host project directory is identity-mounted at the SAME absolute path inside the container: ${projectDir}.

CRITICAL RULES FOR LLMs / AGENTS:
1. NO HOST COMMANDS: ALL code execution (shell commands, runs, tests, linting, git) MUST happen inside this sandbox via the \`exec_bash\` tool. You are STRICTLY FORBIDDEN from using any built-in host terminal/shell tools.
2. ARGUMENTS ARE MANDATORY: When using CallMcpTool or invoking \`exec_bash\`, you MUST provide a valid JSON argument containing the \`command\` property. NEVER pass an empty or undefined argument. Example format: { "command": "npm run dev" }
3. NO FILE SYSTEM TOOLS NEEDED: The sandbox uses identity-mount. All your local file reading/writing tools work natively. Just edit files using your built-in edit tools, they sync instantly to the container.
4. DEPENDENCIES: If you need a database/redis, orchestrate via \`docker-compose.yml\`. If you need root system libraries (jq, make, curl), use \`install_system_dependency\`. Do NOT use host \`apt-get\`.
5. DO NOT fallback to host tools if MCP fails. If \`exec_bash\` returns an argument error (-32602), it means YOU formatted the arguments wrong. Fix your JSON instead of giving up.

WORKFLOW:
- Edit files using your normal built-in local file editing/writing tools.
- Run builds, tests, installs, etc., inside the sandbox via \`exec_bash\` with proper JSON arguments.
- Report results.`;
}

export function createMcpServer(
  docker: Docker,
  manager: SandboxManager,
  projectDir: string,
  sessionId?: string,
): McpServer {
  const server = new McpServer(
    {
      name: "agent-docker",
      version: "0.2.0",
    },
    {
      capabilities: {
        logging: {},
        tools: {},
      },
      instructions: buildServerInstructions(projectDir),
    },
  );

  server.registerTool(
    "exec_bash",
    {
      description:
        "Execute a bash command inside the Docker sandbox and return stdout/stderr. " +
        "All commands run in an isolated container with the project directory identity-mounted. " +
        "The sandbox runs as a non-root user. Use install_system_dependency for packages requiring root.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        workDir: z
          .string()
          .optional()
          .describe(
            `Working directory inside the container (default: ${projectDir})`,
          ),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in milliseconds (default: no timeout)"),
        containerId: z
          .string()
          .optional()
          .describe("Target container ID (auto-detected if omitted)"),
      }),
    },
    async ({ command, workDir, timeout, containerId }) => {
      const cid = await resolveContainer(manager, containerId);

      if (sessionId) {
        appendLog(sessionId, "mcp_tool_call", `exec_bash: ${command}`).catch(
          () => {},
        );
      }

      const cmd = timeout
        ? `timeout ${Math.ceil(timeout / 1000)} bash -c ${JSON.stringify(command)}`
        : command;

      const result = await execInContainer(docker, cid, cmd, {
        workDir: workDir ?? projectDir,
        streamStdout: false,
        streamStderr: false,
      });

      if (sessionId) {
        if (result.stdout) {
          appendLog(sessionId, "container_stdout", result.stdout).catch(
            () => {},
          );
        }
        if (result.stderr) {
          appendLog(sessionId, "container_stderr", result.stderr).catch(
            () => {},
          );
        }
      }

      const output = [
        result.stdout ? `STDOUT:\n${result.stdout}` : "",
        result.stderr ? `STDERR:\n${result.stderr}` : "",
        `EXIT CODE: ${result.exitCode}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        content: [{ type: "text", text: output }],
        isError: result.exitCode !== 0,
      };
    },
  );

  server.registerTool(
    "install_system_dependency",
    {
      description:
        "Install system packages into the sandbox using root privileges. " +
        "Use this when you need system-level tools (e.g. jq, make, curl, build-essential) " +
        "that cannot be installed as a non-root user via exec_bash. " +
        "DO NOT use this for language-level packages (use npm/pip/cargo via exec_bash instead).",
      inputSchema: z.object({
        packages: z
          .array(z.string())
          .describe(
            "List of apt package names to install (e.g. ['jq', 'make', 'libssl-dev'])",
          ),
        containerId: z.string().optional(),
      }),
    },
    async ({ packages, containerId }) => {
      const cid = await resolveContainer(manager, containerId);

      if (packages.length === 0) {
        return {
          content: [{ type: "text", text: "No packages specified." }],
          isError: true,
        };
      }

      // 验证 package 名称来避免注入
      const pkgNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9.+\-:]+$/;
      for (const pkg of packages) {
        if (!pkgNamePattern.test(pkg)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid package name: ${pkg}. Package names must be alphanumeric with ., +, -, : characters.`,
              },
            ],
            isError: true,
          };
        }
      }

      const pkgList = packages.join(" ");

      // 使用 root 权限来安装依赖
      const container = docker.getContainer(cid);
      const exec = await container.exec({
        Cmd: [
          "bash",
          "-c",
          `apt-get update -qq && apt-get install -y --no-install-recommends ${pkgList} 2>&1`,
        ],
        AttachStdout: true,
        AttachStderr: true,
        User: "0",
        Tty: false,
      });

      const stream = await exec.start({ Detach: false, Tty: false });

      const output = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stdout = new PassThrough();
        const stderr = new PassThrough();

        stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

        docker.modem.demuxStream(stream, stdout, stderr);

        stream.on("end", () => {
          stdout.end();
          stderr.end();
          resolve(Buffer.concat(chunks).toString());
        });
        stream.on("error", reject);
      });

      const inspection = await exec.inspect();
      const exitCode = inspection.ExitCode ?? 0;

      if (exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to install packages [${pkgList}].\nExit code: ${exitCode}\n\n${output}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully installed: ${pkgList}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "rebuild_sandbox",
    {
      description:
        "Rebuild the sandbox from a custom Dockerfile at `.agent-docker/Dockerfile` in the project root. " +
        "Use this when you need a fundamentally different base environment (e.g. different OS, " +
        "different runtime major version). The current container will be destroyed and replaced. " +
        "First create the Dockerfile using fs_write, then call this tool.",
      inputSchema: z.object({
        containerId: z.string().optional(),
      }),
    },
    async ({ containerId }) => {
      const cid = await resolveContainer(manager, containerId);

      // 1. 验证 Dockerfile 是否存在
      const dockerfilePath = `${projectDir}/.agent-docker/Dockerfile`;

      if (!existsSync(dockerfilePath)) {
        return {
          content: [
            {
              type: "text",
              text:
                `No Dockerfile found at ${dockerfilePath}. ` +
                "Please create one first using fs_write at .agent-docker/Dockerfile, then call rebuild_sandbox again.",
            },
          ],
          isError: true,
        };
      }

      // 2. 使用 Dockerfile 进行构建
      const sessionTag = randomBytes(4).toString("hex");
      const customImageName = `agent-docker-custom:${sessionTag}`;

      try {
        const contextDir = `${projectDir}/.agent-docker`;

        const buildStream = await docker.buildImage(
          {
            context: contextDir,
            src: ["."],
          } as unknown as NodeJS.ReadableStream,
          {
            t: customImageName,
            dockerfile: "Dockerfile",
          },
        );

        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(buildStream, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch (buildErr) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to build custom image: ${buildErr}`,
            },
          ],
          isError: true,
        };
      }

      // 3. 获取当前容器信息
      const containerObj = docker.getContainer(cid);
      const info = await containerObj.inspect();
      const oldName = info.Name.replace(/^\//, "");

      // 4. 移除旧容器
      try {
        await containerObj.stop({ t: 5 });
      } catch {
        // May already be stopped
      }
      await containerObj.remove({ force: true });

      // 5. 创建新容器
      const newConfig: SandboxConfig = {
        ...defaultConfig,
        image: customImageName,
        workDir: projectDir,
        name: `${oldName}-rebuilt-${sessionTag}`,
      };

      const newSandbox = await manager.create(newConfig);
      const healthy = await healthCheck(docker, newSandbox.id);

      return {
        content: [
          {
            type: "text",
            text: [
              "Sandbox rebuilt successfully!",
              `New image: ${customImageName}`,
              `New container: ${newSandbox.name} (${newSandbox.id.slice(0, 12)})`,
              `Health check: ${healthy ? "PASSED" : "WARNING - may not be fully ready"}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_env",
    {
      description:
        "Read environment variables from the running sandbox container",
      inputSchema: z.object({
        names: z
          .array(z.string())
          .optional()
          .describe(
            "Specific variable names to read (default: return all env vars)",
          ),
        containerId: z.string().optional(),
      }),
    },
    async ({ names, containerId }) => {
      const cid = await resolveContainer(manager, containerId);

      if (names && names.length > 0) {
        const cmds = names.map((n) => `echo "${n}=\${${n}:-}"`).join(" && ");
        const result = await execQuiet(docker, cid, cmds);
        return { content: [{ type: "text", text: result.stdout }] };
      }

      const result = await execQuiet(docker, cid, "env | sort");
      return { content: [{ type: "text", text: result.stdout }] };
    },
  );

  return server;
}

export interface McpServerOptions {
  projectDir?: string;
  image?: string;
}

export async function startMcpServer(
  options?: McpServerOptions,
): Promise<void> {
  const projectDir =
    options?.projectDir ??
    process.env.AGENT_DOCKER_PROJECT_DIR ??
    process.cwd();
  const image = options?.image ?? DEFAULT_IMAGE;

  // 所有都走 stderr（stdout 给 MCP-JSON 了）
  const docker = await ensureDocker(true);
  const manager = new SandboxManager(docker, { quiet: true });

  let existing = await manager.findForProject(projectDir);

  if (existing && existing.state === "active") {
    console.error(
      `Reusing active sandbox: ${existing.name} (${existing.id.slice(0, 12)})`,
    );
  } else if (existing && existing.state !== "active") {
    console.error(`Resuming sandbox: ${existing.name}...`);
    existing = await manager.resume(existing.id);
    const healthy = await healthCheck(docker, existing.id);
    if (!healthy) {
      console.error(
        "Warning: sandbox health check failed after resume, continuing anyway",
      );
    }
  } else {
    console.error(`Creating new sandbox for ${projectDir}...`);
    await ensureImage(docker, image, true);
    const config: SandboxConfig = {
      ...defaultConfig,
      image,
      workDir: projectDir,
    };
    existing = await manager.create(config);
    const healthy = await healthCheck(docker, existing.id);
    if (!healthy) {
      console.error(
        "Warning: sandbox health check failed after creation, continuing anyway",
      );
    }
  }

  // 设置项目目录
  process.env.AGENT_DOCKER_PROJECT_DIR = projectDir;

  let sessionId: string | undefined;
  try {
    await initDb();
    const session = await createSession(projectDir, existing!.id);
    sessionId = session.id;
    await appendLog(
      session.id,
      "system_event",
      `MCP Server started for ${projectDir}`,
    );
    console.error(`Session tracking: ${session.id}`);
  } catch (err) {
    console.error("Warning: session tracking unavailable:", err);
  }

  const server = createMcpServer(docker, manager, projectDir, sessionId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("agent-docker MCP Server running on stdio");

  const cleanup = async () => {
    console.error("MCP Server shutting down...");
    if (sessionId) {
      try {
        await appendLog(sessionId, "system_event", "MCP Server shutting down");
        await endSession(sessionId, "completed");
      } catch {
        // Non-fatal
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
