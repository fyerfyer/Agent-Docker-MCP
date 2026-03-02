// 管理 Docker 容器的生命周期以及 bind mount 和权限同步等。

import Docker from "dockerode";
import * as p from "@clack/prompts";
import color from "picocolors";
import { randomBytes } from "node:crypto";
import {
  type SandboxConfig,
  type SandboxState,
  WORKSPACE_PATH,
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

  constructor(docker: Docker) {
    this.docker = docker;
  }

  async create(config: SandboxConfig): Promise<SandboxInfo> {
    await ensureImage(this.docker, config.image);

    const sessionId = generateSessionId();
    const containerName = config.name ?? `agent-docker-${sessionId}`;
    const { uid, gid } = getHostUser();

    const s = p.spinner();
    s.start(`Creating sandbox ${color.cyan(containerName)}...`);

    try {
      const container = await this.docker.createContainer({
        Image: config.image,
        name: containerName,
        Cmd: ["sleep", "infinity"],
        User: `${uid}:${gid}`,
        WorkingDir: WORKSPACE_PATH,
        Env: config.env ?? [],
        Labels: {
          [LABELS.MANAGED_BY]: LABEL_PREFIX,
          [LABELS.PROJECT_DIR]: config.workDir,
          [LABELS.SESSION_ID]: sessionId,
          [LABELS.CREATED_AT]: new Date().toISOString(),
        },
        HostConfig: {
          Binds: [`${config.workDir}:${WORKSPACE_PATH}`],
          AutoRemove: config.autoRemove,
        },
        Tty: true,
        OpenStdin: true,
      });

      await container.start();

      s.stop(
        `Sandbox ${color.cyan(containerName)} (${color.dim(container.id.slice(0, 12))}) is running`,
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
      s.stop(color.red("Failed to create sandbox"));
      throw err;
    }
  }

  async stop(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const s = p.spinner();
    s.start(`Stopping sandbox ${color.dim(containerId.slice(0, 12))}...`);

    try {
      await container.stop({ t: 10 });
      s.stop(`Sandbox ${color.dim(containerId.slice(0, 12))} stopped`);
    } catch (err: unknown) {
      const dockerErr = err as { statusCode?: number };
      if (dockerErr.statusCode === 304) {
        s.stop(
          `Sandbox ${color.dim(containerId.slice(0, 12))} was already stopped`,
        );
      } else {
        s.stop(color.red("Failed to stop sandbox"));
        throw err;
      }
    }
  }

  async remove(containerId: string, force: boolean = false): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.remove({ force });
    p.log.info(`Sandbox ${color.dim(containerId.slice(0, 12))} removed`);
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

    const s = p.spinner();
    const shortId = containerId.slice(0, 12);
    s.start(`Resuming sandbox ${color.dim(shortId)}...`);

    if (info.State.Running) {
      s.stop(`Sandbox ${color.dim(shortId)} is already running`);
    } else {
      await container.start();
      s.stop(`Sandbox ${color.dim(shortId)} resumed`);
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
