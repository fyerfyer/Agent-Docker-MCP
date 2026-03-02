import fs from "node:fs";
import os from "node:os";
import Docker from "dockerode";
import * as p from "@clack/prompts";
import color from "picocolors";
import { DEFAULT_IMAGE } from "./config.js";

const DOCKER_SOCKET = "/var/run/docker.sock";

export function getDockerClient(): Docker {
  return new Docker({ socketPath: DOCKER_SOCKET });
}

export async function checkDocker(): Promise<boolean> {
  if (!fs.existsSync(DOCKER_SOCKET)) {
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

export async function ensureDocker(): Promise<Docker> {
  const available = await checkDocker();
  if (!available) {
    p.log.error(
      color.red("Docker Engine is not available.") +
        "\n  Please ensure Docker is installed and running." +
        `\n  Socket path: ${color.dim(DOCKER_SOCKET)}`,
    );
    process.exit(1);
  }
  const docker = getDockerClient();
  p.log.success(color.green("Docker Engine connected"));
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
): Promise<void> {
  const exists = await imageExists(docker, imageName);
  if (exists) {
    p.log.info(`Image ${color.cyan(imageName)} is available locally`);
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
