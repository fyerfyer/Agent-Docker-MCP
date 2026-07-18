#!/usr/bin/env node
// 薄 HTTP shim：位于沙箱与 wollomatic/socket-proxy 之间
// 仅对 /containers/create 做请求体检查，其余请求直接透传。

import http from "node:http";
import { validateContainerCreate } from "./body-filter.js";

const CONTAINER_CREATE_PATTERN = /^\/v\d+\.\d+\/containers\/create(\?.*)?$/;
const DEFAULT_LISTEN_PORT = 2376;
const DEFAULT_UPSTREAM_HOST = "socket-proxy";
const DEFAULT_UPSTREAM_PORT = 2375;

export interface FilterShimOptions {
  listenPort?: number;
  upstreamHost?: string;
  upstreamPort?: number;
  projectDir?: string;
}

function getEnvOrDefault(
  name: string,
  defaultValue: string | undefined,
): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return value;
}

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forward(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  body: Buffer | null,
  upstreamHost: string,
  upstreamPort: number,
): void {
  const options: http.RequestOptions = {
    hostname: upstreamHost,
    port: upstreamPort,
    path: clientReq.url ?? "/",
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: `${upstreamHost}:${upstreamPort}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on("error", (err) => {
    clientRes.writeHead(502, { "Content-Type": "application/json" });
    clientRes.end(
      JSON.stringify({
        message: `Filter shim upstream error: ${err.message}`,
      }),
    );
  });

  clientReq.on("aborted", () => {
    proxyReq.destroy();
  });
  clientReq.on("close", () => {
    if (!clientReq.complete) {
      proxyReq.destroy();
    }
  });

  if (body && body.length > 0) {
    proxyReq.write(body);
    proxyReq.end();
    clientReq.resume(); // drain any remaining data
  } else {
    clientReq.pipe(proxyReq);
  }
}

export function startFilterShim(
  options: FilterShimOptions = {},
): http.Server {
  const listenPort = options.listenPort ?? DEFAULT_LISTEN_PORT;
  const upstreamHost = options.upstreamHost ?? DEFAULT_UPSTREAM_HOST;
  const upstreamPort = options.upstreamPort ?? DEFAULT_UPSTREAM_PORT;
  const projectDir = options.projectDir;

  const server = http.createServer(
    async (clientReq, clientRes) => {
      const url = clientReq.url ?? "/";
      const method = clientReq.method ?? "GET";

      if (
        method.toUpperCase() === "POST" &&
        CONTAINER_CREATE_PATTERN.test(url)
      ) {
        try {
          const body = await collectBody(clientReq);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString("utf8"));
          } catch {
            clientRes.writeHead(400, { "Content-Type": "application/json" });
            clientRes.end(
              JSON.stringify({
                message: "Filter shim: invalid JSON in container create body",
              }),
            );
            return;
          }

          const result = validateContainerCreate(parsed, projectDir);
          if (!result.ok) {
            clientRes.writeHead(403, { "Content-Type": "application/json" });
            clientRes.end(
              JSON.stringify({
                message: `Blocked by agent-docker filter: ${result.reason}`,
              }),
            );
            return;
          }

          forward(clientReq, clientRes, body, upstreamHost, upstreamPort);
        } catch {
          clientRes.writeHead(500, { "Content-Type": "application/json" });
          clientRes.end(
            JSON.stringify({
              message: "Filter shim: failed to process request",
            }),
          );
        }
        return;
      }

      forward(clientReq, clientRes, null, upstreamHost, upstreamPort);
    },
  );

  server.listen(listenPort, "0.0.0.0", () => {
    console.error(
      `agent-docker filter shim listening on 0.0.0.0:${listenPort} -> ${upstreamHost}:${upstreamPort}`,
    );
  });

  return server;
}

function main(): void {
  const listenPort = parseInt(
    getEnvOrDefault("LISTEN_PORT", String(DEFAULT_LISTEN_PORT)) ??
      String(DEFAULT_LISTEN_PORT),
    10,
  );
  const upstreamHost =
    getEnvOrDefault("UPSTREAM_HOST", DEFAULT_UPSTREAM_HOST) ??
    DEFAULT_UPSTREAM_HOST;
  const upstreamPort = parseInt(
    getEnvOrDefault("UPSTREAM_PORT", String(DEFAULT_UPSTREAM_PORT)) ??
      String(DEFAULT_UPSTREAM_PORT),
    10,
  );
  const projectDir = getEnvOrDefault("AGENT_DOCKER_PROJECT_DIR", undefined);

  startFilterShim({ listenPort, upstreamHost, upstreamPort, projectDir });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
