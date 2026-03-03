// 管理 Docker 容器的生命周期以及 bind mount 和权限同步等。

import Docker from "dockerode";
import fs from "node:fs";
import * as p from "@clack/prompts";
import os from "node:os";
import { randomBytes } from "node:crypto";
import {
  type SandboxConfig,
  type SandboxState,
  DOCKER_SOCKET,
  LABELS,
  LABEL_PREFIX,
  defaultConfig,
} from "./config.js";
import { getHostUser, ensureImage } from "./env.js";

export interface SandboxInfo {
  id: string;
  name: string;
  state: SandboxState;
  image: string;
  projectDir: string;
  createdAt: string;
}

function generateSessionId(): string {
  return randomBytes(4).toString("hex");
}

function parseContainerState(status: string): SandboxState {
  const s = status.toLowerCase();
  if (s === "running") return "active";
  if (s === "exited" || s === "dead") return "stopped";
  if (s === "created") return "template";
  return "persisted";
}

export class SandboxManager {
  private docker: Docker;
  private quiet: boolean;

  constructor(docker: Docker, options?: { quiet?: boolean }) {
    this.docker = docker;
    this.quiet = options?.quiet ?? false;
  }

  private createSpinner(): {
    start: (msg: string) => void;
    stop: (msg: string) => void;
    message: (msg: string) => void;
  } {
    if (this.quiet) {
      return {
        start: (msg: string) => console.error(msg),
        stop: (msg: string) => console.error(msg),
        message: (msg: string) => console.error(msg),
      };
    }
    return p.spinner();
  }

  private logInfo(msg: string): void {
    if (this.quiet) {
      console.error(msg);
    } else {
      p.log.info(msg);
    }
  }

  async create(config: SandboxConfig): Promise<SandboxInfo> {
    await ensureImage(this.docker, config.image, this.quiet);

    const sessionId = generateSessionId();
    const containerName = config.name ?? `agent-docker-${sessionId}`;
    const { uid, gid } = getHostUser();

    const s = this.createSpinner();
    s.start(`Creating sandbox ${containerName}...`);

    try {
      // 让容器和宿主机 bind 同一个目录
      const binds: string[] = [`${config.workDir}:${config.workDir}`];

      // Docker socket for DooD
      const groupAdd: string[] = [];
      if (fs.existsSync(DOCKER_SOCKET)) {
        binds.push(`${DOCKER_SOCKET}:${DOCKER_SOCKET}`);
        try {
          const socketGid = fs.statSync(DOCKER_SOCKET).gid;
          groupAdd.push(socketGid.toString());
        } catch {
          // ignore stat errors
        }
      }

      // 将 .git 挂载为只读以保护 git 历史
      const gitDir = `${config.workDir}/.git`;
      if (fs.existsSync(gitDir)) {
        binds.push(`${gitDir}:${gitDir}:ro`);
      }

      const container = await this.docker.createContainer({
        Image: config.image,
        name: containerName,
        Cmd: ["sleep", "infinity"],
        User: `${uid}:${gid}`,
        WorkingDir: config.workDir,
        Env: ["HOME=/tmp", ...(config.env ?? [])],
        Labels: {
          [LABELS.MANAGED_BY]: LABEL_PREFIX,
          [LABELS.PROJECT_DIR]: config.workDir,
          [LABELS.SESSION_ID]: sessionId,
          [LABELS.CREATED_AT]: new Date().toISOString(),
        },
        HostConfig: {
          Binds: binds,
          AutoRemove: config.autoRemove,
          NetworkMode: os.platform() === "linux" ? "host" : "default",
          ...(groupAdd.length > 0 ? { GroupAdd: groupAdd } : {}),
        },
        Tty: true,
        OpenStdin: true,
      });

      await container.start();

      s.stop(
        `Sandbox ${containerName} (${container.id.slice(0, 12)}) is running`,
      );

      return {
        id: container.id,
        name: containerName,
        state: "active",
        image: config.image,
        projectDir: config.workDir,
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      s.stop("Failed to create sandbox");
      throw err;
    }
  }

  async stop(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const s = this.createSpinner();
    s.start(`Stopping sandbox ${containerId.slice(0, 12)}...`);

    try {
      await container.stop({ t: 10 });
      s.stop(`Sandbox ${containerId.slice(0, 12)} stopped`);
    } catch (err: unknown) {
      const dockerErr = err as { statusCode?: number };
      if (dockerErr.statusCode === 304) {
        s.stop(`Sandbox ${containerId.slice(0, 12)} was already stopped`);
      } else {
        s.stop("Failed to stop sandbox");
        throw err;
      }
    }
  }

  async remove(containerId: string, force: boolean = false): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.remove({ force });
    this.logInfo(`Sandbox ${containerId.slice(0, 12)} removed`);
  }

  async list(): Promise<SandboxInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [`${LABELS.MANAGED_BY}=${LABEL_PREFIX}`],
      },
    });

    return containers.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? "").replace(/^\//, ""),
      state: parseContainerState(c.State ?? ""),
      image: c.Image,
      projectDir: c.Labels[LABELS.PROJECT_DIR] ?? "unknown",
      createdAt: c.Labels[LABELS.CREATED_AT] ?? "",
    }));
  }

  async findForProject(projectDir: string): Promise<SandboxInfo | null> {
    const all = await this.list();
    // 如果有多个符合条件的容器，优先返回 active 状态的，其次是 persisted，最后是 stopped
    const sorted = all
      .filter((s) => s.projectDir === projectDir)
      .sort((a, b) => {
        const priority: Record<SandboxState, number> = {
          active: 0,
          persisted: 1,
          template: 2,
          stopped: 3,
        };
        return priority[a.state] - priority[b.state];
      });

    return sorted[0] ?? null;
  }

  async resume(containerId: string): Promise<SandboxInfo> {
    const container = this.docker.getContainer(containerId);
    const info = await container.inspect();

    const s = this.createSpinner();
    const shortId = containerId.slice(0, 12);
    s.start(`Resuming sandbox ${shortId}...`);

    if (info.State.Running) {
      s.stop(`Sandbox ${shortId} is already running`);
    } else {
      await container.start();
      s.stop(`Sandbox ${shortId} resumed`);
    }

    return {
      id: containerId,
      name: info.Name.replace(/^\//, ""),
      state: "active",
      image: info.Config.Image,
      projectDir: info.Config.Labels?.[LABELS.PROJECT_DIR] ?? process.cwd(),
      createdAt: info.Config.Labels?.[LABELS.CREATED_AT] ?? "",
    };
  }

  async cleanup(): Promise<number> {
    const { existsSync } = await import("node:fs");
    const all = await this.list();
    let removed = 0;

    for (const sandbox of all) {
      if (!existsSync(sandbox.projectDir)) {
        try {
          await this.remove(sandbox.id, true);
          removed++;
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    return removed;
  }
}
