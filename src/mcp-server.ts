/**
 *  exec_bash                  – 在沙箱内执行 bash 命令
 *  get_job_output             – 获取后台任务输出
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
import { VERSION } from "./version.js";
import { existsSync } from "node:fs";
import { createSession, endSession, appendLog } from "./db/session.js";
import { initDb } from "./db/index.js";
import { resolveSandboxOptions } from "./project-config.js";
import { truncateHeadTail, DEFAULT_MAX_OUTPUT_CHARS } from "./output.js";
import {
  createJob,
  appendJobOutput,
  finishJob,
  failJob,
  getJob,
} from "./jobs.js";

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

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name);
}

function buildServerInstructions(projectDir: string): string {
  return `You are running in a strictly mapped ephemeral sandbox. The host project directory is identity-mounted at the SAME absolute path inside the container: ${projectDir}.

CRITICAL RULES FOR LLMs / AGENTS:
1. NO HOST COMMANDS: ALL code execution (shell commands, runs, tests, linting, git) MUST happen inside this sandbox via the \`exec_bash\` tool. You are STRICTLY FORBIDDEN from using any built-in host terminal/shell tools.
2. ARGUMENTS ARE MANDATORY: When using CallMcpTool or invoking \`exec_bash\`, you MUST provide a valid JSON argument containing the \`command\` property. NEVER pass an empty or undefined argument. Example format: { "command": "npm run dev" }
3. NO FILE SYSTEM TOOLS NEEDED: The sandbox uses identity-mount. All your local file reading/writing tools work natively. Just edit files using your built-in edit tools, they sync instantly to the container.
4. DEPENDENCIES: If you need a database/redis, orchestrate via \`docker-compose.yml\`. If you need root system libraries (jq, make, curl), use \`install_system_dependency\`. Do NOT use host \`apt-get\`.
5. DO NOT fallback to host tools if MCP fails. If \`exec_bash\` returns an argument error (-32602), it means YOU formatted the arguments wrong. Fix your JSON instead of giving up.
6. LONG COMMANDS: For dev servers, watch mode, or anything long-lived, use exec_bash with background=true and poll via get_job_output. Do not block on foreground exec for these.
7. OUTPUT LIMITS: exec_bash output is truncated head+tail beyond maxOutputChars (default ${DEFAULT_MAX_OUTPUT_CHARS}). If you need full output, redirect to a file and read it with your file tools.
8. STRICT MODE: If docker commands fail with "Cannot connect to the Docker daemon", the sandbox is running in strict mode (no DooD). Run services directly or ask the user to relax the config.

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
      version: VERSION,
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
      title: "Execute Bash",
      description:
        "Execute a bash command inside the Docker sandbox and return stdout/stderr. " +
        "Output is truncated head+tail if it exceeds maxOutputChars. " +
        "Set background=true for long-running commands (dev servers, watch mode) and poll with get_job_output. " +
        "The sandbox runs as a non-root user. Use install_system_dependency for packages requiring root.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        workDir: z
          .string()
          .optional()
          .describe(`Working directory inside the container (default: ${projectDir})`),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in milliseconds (default: no timeout). Ignored when background=true."),
        background: z
          .boolean()
          .optional()
          .describe("Run in background and return a jobId immediately (default: false)"),
        maxOutputChars: z
          .number()
          .optional()
          .describe(`Per-stream output cap in chars (default: ${DEFAULT_MAX_OUTPUT_CHARS})`),
        containerId: z
          .string()
          .optional()
          .describe("Target container ID (auto-detected if omitted)"),
      }),
      outputSchema: z.object({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number(),
        truncated: z.boolean(),
      }),
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ command, workDir, timeout, background, maxOutputChars, containerId }) => {
      const cid = await resolveContainer(manager, containerId);

      if (sessionId) {
        appendLog(sessionId, "mcp_tool_call", `exec_bash: ${command}`).catch(
          () => {},
        );
      }

      // 后台模式：立即返回 jobId
      if (background) {
        const job = createJob(command);
        execInContainer(docker, cid, command, {
          workDir: workDir ?? projectDir,
          streamStdout: false,
          streamStderr: false,
          onStdout: (d) => appendJobOutput(job, d),
          onStderr: (d) => appendJobOutput(job, d),
        })
          .then((r) => finishJob(job, r.exitCode))
          .catch((e) => failJob(job, e));
        return {
          structuredContent: {
            stdout: "",
            stderr: "",
            exitCode: 0,
            truncated: false,
          },
          content: [
            {
              type: "text",
              text: `Started background job ${job.id}. Poll with get_job_output({jobId: "${job.id}"}).`,
            },
          ],
        };
      }

      // 前台模式（现状逻辑 + 截断 + structuredContent）
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

      const out = truncateHeadTail(result.stdout, maxOutputChars);
      const err = truncateHeadTail(result.stderr, maxOutputChars);

      const text = [
        out.text ? `STDOUT:\n${out.text}` : "",
        err.text ? `STDERR:\n${err.text}` : "",
        `EXIT CODE: ${result.exitCode}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        structuredContent: {
          stdout: out.text,
          stderr: err.text,
          exitCode: result.exitCode,
          truncated: out.truncated || err.truncated,
        },
        content: [{ type: "text", text }],
        isError: result.exitCode !== 0,
      };
    },
  );

  server.registerTool(
    "get_job_output",
    {
      title: "Get Job Output",
      description:
        "Poll the status and buffered output of a background job started by exec_bash(background=true).",
      inputSchema: z.object({
        jobId: z.string().describe("Job ID returned by exec_bash background mode"),
        maxChars: z
          .number()
          .optional()
          .describe("Return at most this many chars from the END of the buffer (default: 20000)"),
      }),
      outputSchema: z.object({
        status: z.enum(["running", "exited", "error"]),
        exitCode: z.number().optional(),
        output: z.string(),
        truncated: z.boolean(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ jobId, maxChars }) => {
      const job = getJob(jobId);
      if (!job) {
        return {
          content: [{ type: "text", text: `Job not found: ${jobId}` }],
          isError: true,
        };
      }
      const cap = maxChars ?? 20_000;
      const truncated = job.buffer.length > cap;
      const output = truncated
        ? job.buffer.slice(job.buffer.length - cap)
        : job.buffer;
      const text = [
        `STATUS: ${job.status}` +
          (job.exitCode !== undefined ? ` (exit ${job.exitCode})` : "") +
          (job.error ? ` — ${job.error}` : ""),
        output ? `OUTPUT:\n${output}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        structuredContent: {
          status: job.status,
          exitCode: job.exitCode,
          output,
          truncated,
        },
        content: [{ type: "text", text }],
        isError: job.status === "error",
      };
    },
  );

  server.registerTool(
    "install_system_dependency",
    {
      title: "Install System Dependency",
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
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ packages, containerId }) => {
      const cid = await resolveContainer(manager, containerId);

      if (packages.length === 0) {
        return {
          content: [{ type: "text", text: "No packages specified." }],
          isError: true,
        };
      }

      // 探测 apt-get：非 Debian/Ubuntu 镜像给出明确错误
      const aptCheck = await execQuiet(docker, cid, "command -v apt-get");
      if (aptCheck.exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "apt-get not found in this sandbox image. " +
                "install_system_dependency only supports Debian/Ubuntu-based images. " +
                "For other distributions, write a custom .agent-docker/Dockerfile and call rebuild_sandbox.",
            },
          ],
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
      title: "Rebuild Sandbox",
      description:
        "Rebuild the sandbox from a custom Dockerfile at `.agent-docker/Dockerfile` in the project root. " +
        "Use this when you need a fundamentally different base environment (e.g. different OS, " +
        "different runtime major version). The current container will be destroyed and replaced. " +
        "First create the Dockerfile using fs_write, then call this tool.",
      inputSchema: z.object({
        containerId: z.string().optional(),
      }),
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ containerId }, extra) => {
      const cid = await resolveContainer(manager, containerId);

      // 1. elicitation 确认（渐进增强：客户端不支持则按现状直接执行）
      try {
        const answer = await server.server.elicitInput({
          message:
            "rebuild_sandbox will DESTROY the current container and replace it with a new image " +
            "built from .agent-docker/Dockerfile. Proceed?",
          requestedSchema: {
            type: "object",
            properties: { confirm: { type: "boolean", title: "Confirm rebuild" } },
            required: ["confirm"],
          },
        });
        if (answer.action !== "accept" || answer.content?.confirm !== true) {
          return {
            content: [{ type: "text", text: "Rebuild cancelled by user." }],
          };
        }
      } catch {
        // 客户端未声明 elicitation 能力 → 保持现状直接执行
      }

      const sendProgress = async (
        progress: number,
        total: number,
        message: string,
      ) => {
        const progressToken = extra._meta?.progressToken;
        if (progressToken === undefined) return;
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress, total, message },
        });
      };

      await sendProgress(1, 4, "Validating Dockerfile...");

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
      await sendProgress(2, 4, "Building image from .agent-docker/Dockerfile...");
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
      await sendProgress(3, 4, "Replacing container...");
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
      await sendProgress(4, 4, "Health check...");
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
      title: "Get Environment Variables",
      description: "Read environment variables from the running sandbox container",
      inputSchema: z.object({
        names: z
          .array(z.string())
          .optional()
          .describe(
            "Specific variable names to read (default: return all env vars)",
          ),
        containerId: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ names, containerId }) => {
      const cid = await resolveContainer(manager, containerId);

      for (const n of names ?? []) {
        if (!isValidEnvName(n)) {
          return {
            content: [{ type: "text", text: `Invalid env var name: ${n}` }],
            isError: true,
          };
        }
      }

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
  strict?: boolean;
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
    const resolved = resolveSandboxOptions(projectDir, {
      strict: options?.strict,
      image,
    });
    const config: SandboxConfig = {
      ...defaultConfig,
      image: resolved.image ?? image,
      workDir: projectDir,
      network: resolved.network,
      allowDocker: resolved.allowDocker,
      resources: resolved.resources,
      protectPaths: resolved.protectPaths,
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
