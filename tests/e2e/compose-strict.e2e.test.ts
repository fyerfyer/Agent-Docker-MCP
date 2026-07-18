import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Docker from "dockerode";
import { SandboxManager } from "../../src/sandbox.js";
import { execInContainer } from "../../src/exec.js";
import { DEFAULT_IMAGE } from "../../src/config.js";

const describeE2e = describe.skipIf(
  process.env.AGENT_DOCKER_E2E !== "1",
);

describeE2e("strict mode docker compose", () => {
  let tmpDir: string;
  let manager: SandboxManager;
  let docker: Docker;
  let sandbox: { id: string; name: string; sidecar?: { networkName: string } };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-docker-e2e-"));
    fs.writeFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      `services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379"
`,
      "utf8",
    );

    docker = new Docker({ socketPath: "/var/run/docker.sock" });
    manager = new SandboxManager(docker);

    // 使用默认 base 镜像，其中已包含 Docker CLI
    sandbox = await manager.create({
      image: DEFAULT_IMAGE,
      workDir: tmpDir,
      autoRemove: false,
      network: "bridge",
      allowDocker: false,
      composeProxy: true,
      resources: { memoryMb: 512, cpus: 0.5, pidsLimit: 64 },
    });
  }, 600000);

  afterAll(async () => {
    if (sandbox) {
      try {
        await manager.remove(sandbox.id, true);
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 120000);

  it("can run docker compose up in strict mode", async () => {
    const up = await execInContainer(
      docker,
      sandbox.id,
      "docker compose up -d",
      { workDir: tmpDir },
    );
    console.log("compose up stdout:", up.stdout);
    console.log("compose up stderr:", up.stderr);
    console.log("compose up exitCode:", up.exitCode);
    expect(up.exitCode).toBe(0);
  }, 300000);

  it("can list compose services", async () => {
    const ps = await execInContainer(
      docker,
      sandbox.id,
      "docker compose ps",
      { workDir: tmpDir },
    );
    expect(ps.exitCode).toBe(0);
    expect(ps.stdout).toContain("redis");
    expect(ps.stdout.toLowerCase()).toContain("up");
  }, 60000);

  it("blocks privileged containers through the filter", async () => {
    const blocked = await execInContainer(
      docker,
      sandbox.id,
      "docker run --privileged alpine echo pwn",
      { workDir: tmpDir },
    );
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr + blocked.stdout).toContain("Blocked by agent-docker filter");
  }, 60000);

  it("blocks host network mode through the filter", async () => {
    const blocked = await execInContainer(
      docker,
      sandbox.id,
      "docker run --network host alpine echo pwn",
      { workDir: tmpDir },
    );
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr + blocked.stdout).toContain("Blocked by agent-docker filter");
  }, 60000);

  it("can run docker compose down", async () => {
    const down = await execInContainer(
      docker,
      sandbox.id,
      "docker compose down",
      { workDir: tmpDir },
    );
    expect(down.exitCode).toBe(0);
  }, 60000);
});
