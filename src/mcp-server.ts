/**
 *  exec_bash                  – 在沙箱内执行 bash 命令
 *  fs_read                    – 读取沙箱挂载目录中的文件
 *  fs_write                   – 写入沙箱挂载目录中的文件
 *  fs_list                    – 列出沙箱工作目录结构
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

function safeHeredocTag(content: string): string {
  let tag = "AGENT_DOCKER_EOF";
  while (content.includes(tag)) {
    tag = `AGENT_DOCKER_EOF_${randomBytes(4).toString("hex")}`;
  }
  return tag;
}

function buildServerInstructions(projectDir: string): string {
  return `You are running in a strictly mapped ephemeral sandbox. The host project directory is identity-mounted at the SAME absolute path inside the container: ${projectDir}.

CRITICAL RULES:
1. ALL code execution (shell commands, builds, tests, linting) MUST happen inside this sandbox via the exec_bash tool. Do NOT run commands on the host directly.
2. All your written files are ALREADY on the host. The sandbox uses identity-mount (host path == container path). DO NOT attempt to copy files back and forth manually.
3. You have Docker Compose equipped! If the project needs DB/Message queues/Redis, NEVER install them via apt-get into the sandbox. YOU MUST orchestrate them via a \`docker-compose.yml\`.
4. Due to Drop-Privileges, your \`exec_bash\` tool lacks root permission. If you are missing system libraries like jq, make, curl, etc., YOU MUST call the specific \`install_system_dependency\` tool to request them.
5. The .git directory is mounted as READ-ONLY. You cannot modify git history directly. Use git commands for reading (log, status, diff) only.
6. After making changes, verify correctness with tests or builds using exec_bash before reporting completion.
7. If you need a fundamentally different runtime environment (e.g. switching from Node to Python base), write a Dockerfile to \`.agent-docker/Dockerfile\` and call \`rebuild_sandbox\`.

WORKFLOW:
- Read/understand requirements
- Use exec_bash to run builds, tests, installs, etc. inside the sandbox
- Use fs_write to create or modify files
- Use exec_bash to verify changes (run tests, lint, build)
- Report results to the user`;
}

export function createMcpServer(
  docker: Docker,
  manager: SandboxManager,
  projectDir: string,
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

      const cmd = timeout
        ? `timeout ${Math.ceil(timeout / 1000)} bash -c ${JSON.stringify(command)}`
        : command;

      const result = await execInContainer(docker, cid, cmd, {
        workDir: workDir ?? projectDir,
        streamStdout: false,
        streamStderr: false,
      });

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
    "fs_read",
    {
      description: "Read a file from the sandbox workspace",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            `File path relative to ${projectDir} (or absolute inside container)`,
          ),
        containerId: z.string().optional(),
      }),
    },
    async ({ path, containerId }) => {
      const cid = await resolveContainer(manager, containerId);
      const absPath = path.startsWith("/") ? path : `${projectDir}/${path}`;

      const result = await execQuiet(
        docker,
        cid,
        `cat ${JSON.stringify(absPath)}`,
      );

      if (result.exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading file: ${result.stderr.trim()}`,
            },
          ],
          isError: true,
        };
      }

      return { content: [{ type: "text", text: result.stdout }] };
    },
  );

  server.registerTool(
    "fs_write",
    {
      description:
        "Write content to a file in the sandbox workspace. " +
        "Files are immediately visible on the host via identity-mount.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            `File path relative to ${projectDir} (or absolute inside container)`,
          ),
        content: z.string().describe("File content to write"),
        append: z
          .boolean()
          .optional()
          .describe("Append instead of overwrite (default: false)"),
        containerId: z.string().optional(),
      }),
    },
    async ({ path, content, append, containerId }) => {
      const cid = await resolveContainer(manager, containerId);
      const absPath = path.startsWith("/") ? path : `${projectDir}/${path}`;

      const dir = absPath.substring(0, absPath.lastIndexOf("/"));
      if (dir) {
        await execQuiet(docker, cid, `mkdir -p ${JSON.stringify(dir)}`);
      }

      const op = append ? ">>" : ">";
      const heredocTag = safeHeredocTag(content);
      const cmd = `cat ${op} ${JSON.stringify(absPath)} << '${heredocTag}'\n${content}\n${heredocTag}`;

      const result = await execQuiet(docker, cid, cmd);

      if (result.exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `Error writing file: ${result.stderr.trim()}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully wrote ${content.length} bytes to ${absPath}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "fs_list",
    {
      description: "List directory structure in the sandbox workspace",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe(
            `Directory path relative to ${projectDir} (default: workspace root)`,
          ),
        depth: z
          .number()
          .optional()
          .describe("Maximum depth to recurse (default: 3)"),
        containerId: z.string().optional(),
      }),
    },
    async ({ path, depth, containerId }) => {
      const cid = await resolveContainer(manager, containerId);
      const targetPath = path
        ? path.startsWith("/")
          ? path
          : `${projectDir}/${path}`
        : projectDir;
      const maxDepth = depth ?? 3;

      const result = await execQuiet(
        docker,
        cid,
        `find ${JSON.stringify(targetPath)} -maxdepth ${maxDepth} -not -path '*/node_modules/*' -not -path '*/.git/*' | head -500 | sort`,
      );

      if (result.exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing directory: ${result.stderr.trim()}`,
            },
          ],
          isError: true,
        };
      }

      return { content: [{ type: "text", text: result.stdout }] };
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

  const server = createMcpServer(docker, manager, projectDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("agent-docker MCP Server running on stdio");

  const cleanup = async () => {
    console.error("MCP Server shutting down...");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
