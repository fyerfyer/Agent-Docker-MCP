import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { startFilterShim } from "../src/proxy/filter-shim.js";

async function request(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("filter shim", () => {
  let upstream: http.Server;
  let shim: http.Server;
  let upstreamPort: number;
  let shimPort: number;
  let lastUpstreamBody: string | undefined;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        lastUpstreamBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ method: req.method, url: req.url, body: lastUpstreamBody }));
      });
    });

    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => {
        upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
        resolve();
      });
    });

    shim = startFilterShim({
      listenPort: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort,
      projectDir: "/home/user/project",
    });

    await new Promise<void>((resolve) => {
      shim.listen(0, "127.0.0.1", () => {
        shimPort = (shim.address() as import("node:net").AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => shim.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("forwards non-container-create POST requests with body", async () => {
    const payload = JSON.stringify({ Name: "testnet", Driver: "bridge" });
    const res = await request(shimPort, "POST", "/v1.47/networks/create", payload);
    expect(res.statusCode).toBe(200);
    expect(lastUpstreamBody).toBe(payload);
  });

  it("blocks privileged container create requests", async () => {
    const payload = JSON.stringify({
      Image: "alpine",
      HostConfig: { Privileged: true },
    });
    const res = await request(shimPort, "POST", "/v1.47/containers/create", payload);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Blocked by agent-docker filter");
  });

  it("forwards safe container create requests", async () => {
    const payload = JSON.stringify({
      Image: "alpine",
      HostConfig: { NetworkMode: "bridge" },
    });
    const res = await request(shimPort, "POST", "/v1.47/containers/create", payload);
    expect(res.statusCode).toBe(200);
    expect(lastUpstreamBody).toBe(payload);
  });

  it("forwards GET requests", async () => {
    const res = await request(shimPort, "GET", "/v1.47/containers/json");
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.method).toBe("GET");
    expect(parsed.url).toBe("/v1.47/containers/json");
  });

  it("rejects invalid JSON in container create body", async () => {
    const res = await request(shimPort, "POST", "/v1.47/containers/create", "not-json");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("invalid JSON");
  });
});
