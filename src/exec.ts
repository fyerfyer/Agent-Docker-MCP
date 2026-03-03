import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { DANGEROUS_PATTERNS } from "./config.js";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function validateCommand(cmd: string): void {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      throw new Error(
        `BLOCKED: ${reason}.\n` +
          `Command: ${cmd}\n` +
          "This command has been blocked by the agent-docker safety guard.",
      );
    }
  }
}

// 在 Docker 内执行命令
export async function execInContainer(
  docker: Docker,
  containerId: string,
  cmd: string,
  options: {
    workDir?: string;
    env?: string[];
    user?: string;
    streamStdout?: boolean;
    streamStderr?: boolean;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  } = {},
): Promise<ExecResult> {
  validateCommand(cmd);

  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ["bash", "-c", cmd],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: options.workDir,
    Env: options.env,
    User: options.user,
  });

  const stream = await exec.start({ Detach: false, Tty: false });

  return new Promise<ExecResult>((resolve, reject) => {
    const stdoutBuf: Buffer[] = [];
    const stderrBuf: Buffer[] = [];

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    stdoutStream.on("data", (chunk: Buffer) => {
      stdoutBuf.push(chunk);
      const text = chunk.toString();
      if (options.streamStdout !== false) {
        if (options.onStdout) {
          options.onStdout(text);
        } else {
          process.stdout.write(text);
        }
      }
    });

    stderrStream.on("data", (chunk: Buffer) => {
      stderrBuf.push(chunk);
      const text = chunk.toString();
      if (options.streamStderr !== false) {
        if (options.onStderr) {
          options.onStderr(text);
        } else {
          process.stderr.write(text);
        }
      }
    });

    // 将 Docker 的输出分为 stdout 和 stderr
    docker.modem.demuxStream(stream, stdoutStream, stderrStream);

    stream.on("end", async () => {
      stdoutStream.end();
      stderrStream.end();

      try {
        const inspection = await exec.inspect();
        resolve({
          exitCode: inspection.ExitCode ?? 0,
          stdout: Buffer.concat(stdoutBuf).toString(),
          stderr: Buffer.concat(stderrBuf).toString(),
        });
      } catch (err) {
        reject(err);
      }
    });

    stream.on("error", reject);
  });
}

export async function execQuiet(
  docker: Docker,
  containerId: string,
  cmd: string,
  workDir?: string,
): Promise<ExecResult> {
  return execInContainer(docker, containerId, cmd, {
    workDir,
    streamStdout: false,
    streamStderr: false,
  });
}

export async function healthCheck(
  docker: Docker,
  containerId: string,
): Promise<boolean> {
  try {
    const result = await execQuiet(docker, containerId, "echo ok");
    return result.exitCode === 0 && result.stdout.trim() === "ok";
  } catch {
    return false;
  }
}
