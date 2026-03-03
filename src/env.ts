import fs from "node:fs";
import os from "node:os";
import Docker from "dockerode";
import * as p from "@clack/prompts";
import color from "picocolors";
import { DEFAULT_IMAGE, DOCKER_SOCKET } from "./config.js";
import { BASE_DOCKERFILE } from "./templates.js";
import { Readable } from "node:stream";

const DOCKER_SOCKET_PATH = DOCKER_SOCKET;

export function getDockerClient(): Docker {
  return new Docker({ socketPath: DOCKER_SOCKET_PATH });
}

export async function checkDocker(): Promise<boolean> {
  if (!fs.existsSync(DOCKER_SOCKET_PATH)) {
    return false;
  }

  try {
    const docker = getDockerClient();
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export async function ensureDocker(quiet = false): Promise<Docker> {
  const available = await checkDocker();
  if (!available) {
    const msg =
      "Docker Engine is not available.\n" +
      "  Please ensure Docker is installed and running.\n" +
      `  Socket path: ${DOCKER_SOCKET_PATH}`;
    if (quiet) {
      console.error(msg);
      process.exit(1);
    } else {
      p.log.error(
        color.red("Docker Engine is not available.") +
          "\n  Please ensure Docker is installed and running." +
          `\n  Socket path: ${color.dim(DOCKER_SOCKET_PATH)}`,
      );
      process.exit(1);
    }
  }
  const docker = getDockerClient();
  if (!quiet) {
    p.log.success(color.green("Docker Engine connected"));
  }
  return docker;
}

export async function imageExists(
  docker: Docker,
  imageName: string,
): Promise<boolean> {
  try {
    const image = docker.getImage(imageName);
    await image.inspect();
    return true;
  } catch {
    return false;
  }
}

export async function ensureImage(
  docker: Docker,
  imageName: string = DEFAULT_IMAGE,
  quiet = false,
): Promise<void> {
  const exists = await imageExists(docker, imageName);
  if (exists) {
    if (!quiet) {
      p.log.info(`Image ${color.cyan(imageName)} is available locally`);
    }
    return;
  }

  if (imageName === DEFAULT_IMAGE) {
    // 如果是默认镜像的话，直接构建
    await buildBaseImage(docker, quiet);
    return;
  }

  if (quiet) {
    console.error(`Pulling image ${imageName}...`);
    try {
      const stream = await docker.pull(imageName);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.error(`Image ${imageName} pulled successfully`);
    } catch (err) {
      console.error(`Failed to pull image ${imageName}`);
      throw err;
    }
    return;
  }

  const s = p.spinner();
  s.start(`Pulling image ${color.cyan(imageName)}...`);

  try {
    const stream = await docker.pull(imageName);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        },
        (event: { status?: string; progress?: string }) => {
          if (event.status && event.progress) {
            s.message(
              `Pulling ${color.cyan(imageName)}: ${event.status} ${event.progress}`,
            );
          } else if (event.status) {
            s.message(`Pulling ${color.cyan(imageName)}: ${event.status}`);
          }
        },
      );
    });

    s.stop(`Image ${color.cyan(imageName)} pulled successfully`);
  } catch (err) {
    s.stop(color.red(`Failed to pull image ${imageName}`));
    throw err;
  }
}

export function getHostUser(): { uid: number; gid: number } {
  return {
    uid: os.userInfo().uid,
    gid: os.userInfo().gid,
  };
}

// 构建基础镜像，包含必需的依赖
export async function buildBaseImage(
  docker: Docker,
  quiet = false,
): Promise<void> {
  const imageName = DEFAULT_IMAGE;

  const log = quiet
    ? (msg: string) => console.error(msg)
    : (msg: string) => p.log.info(msg);

  log(
    `Building ${imageName} from embedded Dockerfile (this may take a few minutes)...`,
  );

  const tarBuffer = await createTarFromDockerfile(BASE_DOCKERFILE);
  const tarStream = Readable.from(tarBuffer);

  const buildStream = await docker.buildImage(
    tarStream as NodeJS.ReadableStream,
    {
      t: imageName,
      dockerfile: "Dockerfile",
    },
  );

  let buildError: string | null = null;

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
      (event: {
        stream?: string;
        error?: string;
        errorDetail?: { message?: string };
      }) => {
        if (event.error) {
          buildError = event.error;
          if (!quiet) console.error(`Build error: ${event.error}`);
        }
      },
    );
  });

  // Docker 构建流即使在 RUN 步骤失败时也可能在没有顶级错误的情况下完成
  // 失败仅通过 event.error 报告。我们必须显式检查并抛出异常，
  // 以便调用者知道镜像尚未创建。
  if (buildError) {
    throw new Error(`Image build failed: ${buildError}`);
  }

  log(`Image ${imageName} built successfully`);
}

// 创建一个包含单个 Dockerfile 的最小 tar
async function createTarFromDockerfile(
  dockerfileContent: string,
): Promise<Buffer> {
  const content = Buffer.from(dockerfileContent, "utf-8");
  const name = "Dockerfile";

  const header = Buffer.alloc(512, 0);

  header.write(name, 0, 100, "utf-8");
  header.write("0000644\0", 100, 8, "utf-8");
  header.write("0001000\0", 108, 8, "utf-8");
  header.write("0001000\0", 116, 8, "utf-8");
  header.write(
    content.length.toString(8).padStart(11, "0") + "\0",
    124,
    12,
    "utf-8",
  );

  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "utf-8");
  header.write("        ", 148, 8, "utf-8");
  header.write("0", 156, 1, "utf-8");

  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i]!;
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");

  const padding = 512 - (content.length % 512);
  const paddedContent =
    padding === 512
      ? content
      : Buffer.concat([content, Buffer.alloc(padding, 0)]);

  const end = Buffer.alloc(1024, 0);

  return Buffer.concat([header, paddedContent, end]);
}
