import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

export const resourcesSchema = z.object({
  memoryMb: z.number().int().positive().default(4096),
  cpus: z.number().positive().default(2),
  pidsLimit: z.number().int().positive().default(512),
});

export const projectConfigSchema = z.object({
  image: z.string().optional(),
  strict: z.boolean().default(false),
  network: z.enum(["host", "bridge", "none"]).optional(),
  allowDocker: z.boolean().default(true),
  composeProxy: z.boolean().default(true),
  resources: resourcesSchema.optional(),
  env: z.array(z.string()).optional(),
  protectPaths: z.array(z.string()).default([]),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type ResourceLimits = z.infer<typeof resourcesSchema>;

export const DEFAULT_RESOURCES: ResourceLimits = {
  memoryMb: 4096,
  cpus: 2,
  pidsLimit: 512,
};

export function loadProjectConfig(workDir: string): ProjectConfig {
  const configPath = path.join(workDir, ".agent-docker", "config.json");
  if (!fs.existsSync(configPath)) {
    return projectConfigSchema.parse({});
  }
  const raw = fs.readFileSync(configPath, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${configPath}`);
  }
  const result = projectConfigSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `Invalid ${configPath}: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

export interface ResolvedSandboxOptions {
  image?: string;
  network: "host" | "bridge" | "none" | undefined;
  allowDocker: boolean;
  composeProxy: boolean;
  resources: ResourceLimits;
  env?: string[];
  protectPaths: string[];
}

export function resolveSandboxOptions(
  workDir: string,
  cliFlags: { strict?: boolean; image?: string; env?: string[] } = {},
): ResolvedSandboxOptions {
  const cfg = loadProjectConfig(workDir);
  const strict = cliFlags.strict ?? cfg.strict;

  return {
    image: cliFlags.image ?? cfg.image,
    network: cfg.network ?? (strict ? "bridge" : undefined),
    allowDocker: strict ? false : cfg.allowDocker,
    composeProxy: strict ? cfg.composeProxy : false,
    resources: { ...DEFAULT_RESOURCES, ...cfg.resources },
    env: [...(cfg.env ?? []), ...(cliFlags.env ?? [])],
    protectPaths: strict
      ? [...new Set([".env", ...cfg.protectPaths])]
      : cfg.protectPaths,
  };
}
