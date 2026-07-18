// 管理 strict 模式下的 socket-proxy + filter shim sidecar 生命周期

import Docker from "dockerode";
import * as p from "@clack/prompts";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import {
  SIDECAR_IMAGE,
  FILTER_IMAGE,
  PROXY_NETWORK_PREFIX,
  SIDECAR_HOSTNAME,
  FILTER_HOSTNAME,
  LABELS,
  SIDECAR_LABELS,
  DOCKER_SOCKET,
} from "./config.js";

export interface SidecarInfo {
  proxyContainerId: string;
  filterContainerId: string;
  networkName: string;
  networkId: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/sidecar.js 与 dist/proxy/ 同级
function getProxyDistDir(): string {
  return path.resolve(__dirname, "..", "dist", "proxy");
}

function generateSessionId(): string {
  return randomBytes(4).toString("hex");
}

async function imageExists(docker: Docker, imageName: string): Promise<boolean> {
  try {
    const image = docker.getImage(imageName);
    await image.inspect();
    return true;
  } catch {
    return false;
  }
}

async function pullImage(
  docker: Docker,
  imageName: string,
  logInfo: (msg: string) => void,
): Promise<void> {
  logInfo(`Pulling sidecar image ${imageName}...`);
  const stream = await docker.pull(imageName);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
  logInfo(`Sidecar image ${imageName} pulled`);
}

async function ensureImage(
  docker: Docker,
  imageName: string,
  logInfo: (msg: string) => void,
): Promise<void> {
  if (!(await imageExists(docker, imageName))) {
    await pullImage(docker, imageName, logInfo);
  }
}

function makeLogInfo(quiet?: boolean): (msg: string) => void {
  if (quiet) {
    return (msg: string) => console.error(msg);
  }
  return (msg: string) => p.log.info(msg);
}

function proxyAllowListArgs(projectDir: string): string[] {
  return [
    "-loglevel=info",
    "-listenip=0.0.0.0",
    "-proxyport=2375",
    "-shutdowngracetime=5",
    // 仅允许 filter shim 连接
    `-allowfrom=${FILTER_HOSTNAME}`,
    // 限制 bind mount 源路径必须在项目目录内
    `-allowbindmountfrom=${projectDir}`,

    // GET
    "-allowGET=/_ping",
    "-allowHEAD=/_ping",
    "-allowGET=/version",
    "-allowGET=/v1\\..*/version",
    "-allowGET=/info",
    "-allowGET=/v1\\..*/info",
    "-allowGET=/v1\\..*/containers/json",
    "-allowGET=/v1\\..*/containers/.*/json",
    "-allowGET=/v1\\..*/containers/.*/logs",
    "-allowGET=/v1\\..*/exec/.*/json",
    "-allowGET=/v1\\..*/networks.*",
    "-allowGET=/v1\\..*/volumes.*",
    "-allowGET=/v1\\..*/images.*",
    "-allowGET=/v1\\..*/events.*",

    // POST
    "-allowPOST=/v1\\..*/containers/create.*",
    "-allowPOST=/v1\\..*/containers/.*/start.*",
    "-allowPOST=/v1\\..*/containers/.*/stop.*",
    "-allowPOST=/v1\\..*/containers/.*/kill.*",
    "-allowPOST=/v1\\..*/containers/.*/wait.*",
    "-allowPOST=/v1\\..*/containers/.*/attach.*",
    "-allowPOST=/v1\\..*/containers/.*/exec",
    "-allowPOST=/v1\\..*/containers/.*/restart.*",
    "-allowPOST=/v1\\..*/exec/.*/start",
    "-allowPOST=/v1\\..*/networks/create",
    "-allowPOST=/v1\\..*/networks/.*/connect",
    "-allowPOST=/v1\\..*/networks/.*/disconnect",
    "-allowPOST=/v1\\..*/volumes/create",
    "-allowPOST=/v1\\..*/images/create",
    "-allowPOST=/v1\\..*/build.*",

    // DELETE
    "-allowDELETE=/v1\\..*/containers/.*",
    "-allowDELETE=/v1\\..*/networks/.*",
    "-allowDELETE=/v1\\..*/volumes/.*",
    "-allowDELETE=/v1\\..*/images/.*",
  ];
}

async function createNetwork(
  docker: Docker,
  networkName: string,
): Promise<string> {
  try {
    const network = await docker.createNetwork({
      Name: networkName,
      Driver: "bridge",
      CheckDuplicate: true,
    });
    return network.id;
  } catch (err: unknown) {
    const dockerErr = err as { statusCode?: number; json?: { message?: string } };
    if (dockerErr.statusCode === 409) {
      // already exists
      const network = docker.getNetwork(networkName);
      const info = await network.inspect();
      return info.Id;
    }
    throw err;
  }
}

async function getContainerIp(
  docker: Docker,
  containerId: string,
  networkName: string,
): Promise<string> {
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  const ip = info.NetworkSettings.Networks[networkName]?.IPAddress;
  if (!ip) {
    throw new Error(`Container ${containerId} has no IP on network ${networkName}`);
  }
  return ip;
}

async function waitForFilter(
  ip: string,
  port: number,
  timeoutMs = 30000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: ip,
            port,
            path: "/_ping",
            method: "GET",
            timeout: 2000,
          },
          (res) => {
            if (res.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`status ${res.statusCode}`));
            }
          },
        );
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("timeout"));
        });
        req.end();
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Filter shim did not become ready within ${timeoutMs}ms`);
}

export async function ensureSidecarImages(
  docker: Docker,
  quiet?: boolean,
): Promise<void> {
  const logInfo = makeLogInfo(quiet);
  await ensureImage(docker, SIDECAR_IMAGE, logInfo);
  await ensureImage(docker, FILTER_IMAGE, logInfo);
}

export async function createSidecar(
  docker: Docker,
  projectDir: string,
  sandboxContainerName: string,
  quiet?: boolean,
): Promise<SidecarInfo> {
  const logInfo = makeLogInfo(quiet);
  const sessionId = generateSessionId();
  const networkName = `${PROXY_NETWORK_PREFIX}-${sessionId}`;
  const proxyName = `agent-docker-proxy-${sessionId}`;
  const filterName = `agent-docker-filter-${sessionId}`;

  logInfo(`Creating socket-proxy sidecar network ${networkName}...`);
  const networkId = await createNetwork(docker, networkName);

  await ensureSidecarImages(docker, quiet);

  const proxyDir = getProxyDistDir();

  // 让 socket-proxy 容器用户加入宿主机 docker.sock 所属组，避免 permission denied
  const socketGid = fs.existsSync(DOCKER_SOCKET)
    ? fs.statSync(DOCKER_SOCKET).gid
    : undefined;
  const proxyGroupAdd = socketGid ? [socketGid.toString()] : [];

  logInfo(`Creating socket-proxy container ${proxyName}...`);
  const proxyContainer = await docker.createContainer({
    Image: SIDECAR_IMAGE,
    name: proxyName,
    Hostname: SIDECAR_HOSTNAME,
    Cmd: proxyAllowListArgs(projectDir),
    HostConfig: {
      // :ro 标记对 unix socket 无效，proxy 需要写 API
      Binds: [`${DOCKER_SOCKET}:${DOCKER_SOCKET}`],
      NetworkMode: networkName,
      AutoRemove: false,
      Memory: 64 * 1024 * 1024,
      PidsLimit: 64,
      ...(proxyGroupAdd.length > 0
        ? { GroupAdd: proxyGroupAdd }
        : {}),
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
    },
    Labels: {
      [LABELS.MANAGED_BY]: "agent-docker",
      [SIDECAR_LABELS.IS_SIDECAR]: "true",
      [SIDECAR_LABELS.SIDECAR_FOR]: sandboxContainerName,
      [LABELS.PROJECT_DIR]: projectDir,
      [LABELS.SESSION_ID]: sessionId,
    },
  });

  logInfo(`Creating filter shim container ${filterName}...`);
  const filterContainer = await docker.createContainer({
    Image: FILTER_IMAGE,
    name: filterName,
    Hostname: FILTER_HOSTNAME,
    Cmd: ["node", "/proxy/filter-shim.js"],
    Env: [
      "UPSTREAM_HOST=socket-proxy",
      "UPSTREAM_PORT=2375",
      "LISTEN_PORT=2376",
      `AGENT_DOCKER_PROJECT_DIR=${projectDir}`,
    ],
    HostConfig: {
      Binds: [`${proxyDir}:/proxy:ro`],
      NetworkMode: networkName,
      AutoRemove: false,
      Memory: 64 * 1024 * 1024,
      PidsLimit: 64,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
    },
    Labels: {
      [LABELS.MANAGED_BY]: "agent-docker",
      [SIDECAR_LABELS.IS_FILTER]: "true",
      [SIDECAR_LABELS.SIDECAR_FOR]: sandboxContainerName,
      [LABELS.PROJECT_DIR]: projectDir,
      [LABELS.SESSION_ID]: sessionId,
    },
  });

  await proxyContainer.start();
  await filterContainer.start();

  // 等待 filter shim 就绪
  const filterIp = await getContainerIp(docker, filterContainer.id, networkName);
  logInfo("Waiting for filter shim to be ready...");
  await waitForFilter(filterIp, 2376);
  logInfo("Filter shim is ready");

  return {
    proxyContainerId: proxyContainer.id,
    filterContainerId: filterContainer.id,
    networkName,
    networkId,
  };
}

export async function stopSidecar(
  docker: Docker,
  info: SidecarInfo,
  quiet?: boolean,
): Promise<void> {
  const logInfo = makeLogInfo(quiet);
  const { proxyContainerId, filterContainerId } = info;

  for (const cid of [filterContainerId, proxyContainerId]) {
    const container = docker.getContainer(cid);
    try {
      await container.stop({ t: 5 });
    } catch (err: unknown) {
      const dockerErr = err as { statusCode?: number };
      if (dockerErr.statusCode === 304) {
        // already stopped
      } else {
        logInfo(`Failed to stop sidecar container ${cid.slice(0, 12)}: ${err}`);
      }
    }
  }
}

export async function startSidecar(
  docker: Docker,
  info: SidecarInfo,
  quiet?: boolean,
): Promise<void> {
  const logInfo = makeLogInfo(quiet);
  const { proxyContainerId, filterContainerId, networkName } = info;

  const proxy = docker.getContainer(proxyContainerId);
  const filter = docker.getContainer(filterContainerId);

  const proxyInfo = await proxy.inspect();
  if (!proxyInfo.State.Running) {
    logInfo("Starting socket-proxy sidecar...");
    await proxy.start();
  }

  const filterInfo = await filter.inspect();
  if (!filterInfo.State.Running) {
    logInfo("Starting filter shim sidecar...");
    await filter.start();
  }

  const filterIp = await getContainerIp(docker, filterContainerId, networkName);
  await waitForFilter(filterIp, 2376);
  logInfo("Filter shim is ready");
}

export async function removeSidecar(
  docker: Docker,
  info: SidecarInfo,
  force?: boolean,
  quiet?: boolean,
): Promise<void> {
  const logInfo = makeLogInfo(quiet);
  const { proxyContainerId, filterContainerId, networkName } = info;

  for (const cid of [filterContainerId, proxyContainerId]) {
    const container = docker.getContainer(cid);
    try {
      await container.remove({ force });
    } catch (err) {
      logInfo(`Failed to remove sidecar container ${cid.slice(0, 12)}: ${err}`);
    }
  }

  try {
    const network = docker.getNetwork(networkName);
    await network.remove();
  } catch (err) {
    logInfo(`Failed to remove sidecar network ${networkName}: ${err}`);
  }
}

export async function findSidecarForSandbox(
  docker: Docker,
  sandboxContainerName: string,
): Promise<SidecarInfo | null> {
  const containers = await docker.listContainers({ all: true });
  const proxy = containers.find(
    (c) =>
      c.Labels[SIDECAR_LABELS.IS_SIDECAR] === "true" &&
      c.Labels[SIDECAR_LABELS.SIDECAR_FOR] === sandboxContainerName,
  );
  const filter = containers.find(
    (c) =>
      c.Labels[SIDECAR_LABELS.IS_FILTER] === "true" &&
      c.Labels[SIDECAR_LABELS.SIDECAR_FOR] === sandboxContainerName,
  );

  if (!proxy || !filter) return null;

  const networkName = Object.keys(proxy.NetworkSettings.Networks)[0];
  if (!networkName) return null;

  const network = docker.getNetwork(networkName);
  const networkInfo = await network.inspect();

  return {
    proxyContainerId: proxy.Id,
    filterContainerId: filter.Id,
    networkName,
    networkId: networkInfo.Id,
  };
}
