import type { ResourceLimits } from "./project-config.js";

export const DEFAULT_IMAGE = "agent-docker-base:latest";

export const DOCKER_SOCKET = "/var/run/docker.sock";

export const LABEL_PREFIX = "agent-docker";

export const LABELS = {
  MANAGED_BY: `${LABEL_PREFIX}.managed-by`,
  PROJECT_DIR: `${LABEL_PREFIX}.project-dir`,
  SESSION_ID: `${LABEL_PREFIX}.session-id`,
  CREATED_AT: `${LABEL_PREFIX}.created-at`,
} as const;

export type SandboxState = "template" | "active" | "persisted" | "stopped";

export interface SandboxConfig {
  image: string;
  workDir: string;
  autoRemove: boolean;
  name?: string;
  env?: string[];
  network?: "host" | "bridge" | "none";
  allowDocker?: boolean;
  composeProxy?: boolean;
  resources?: ResourceLimits;
  protectPaths?: string[];
}

export const defaultConfig: Omit<SandboxConfig, "workDir"> = {
  image: DEFAULT_IMAGE,
  autoRemove: false,
};

// Socket proxy sidecar configuration
export const SIDECAR_IMAGE = "wollomatic/socket-proxy:1";
export const FILTER_IMAGE = "node:20-bookworm-slim";
export const PROXY_NETWORK_PREFIX = "agent-docker-proxy";
export const FILTER_HOSTNAME = "filter-proxy";
export const SIDECAR_HOSTNAME = "socket-proxy";
export const SIDECAR_LABELS = {
  IS_SIDECAR: `${LABEL_PREFIX}.is-sidecar`,
  IS_FILTER: `${LABEL_PREFIX}.is-filter`,
  SIDECAR_FOR: `${LABEL_PREFIX}.sidecar-for`,
} as const;

// 危险指令拦截 — 防呆提示，非安全边界。
// 真正的隔离边界由 cgroups / capabilities / no-new-privileges / 非 root 用户提供。
export const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\brm\s+(-[^\s]*\s+)*\/\s*$/,
    reason: "Attempted to remove filesystem root",
  },
  {
    pattern: /\brm\s+(-[^\s]*\s+)*\/\*/,
    reason: "Attempted to remove all files from root",
  },
  {
    pattern: /\brm\s+(-[^\s]*\s+)*--no-preserve-root/,
    reason: "Attempted rm with --no-preserve-root",
  },
  {
    pattern: /\bmkfs\./,
    reason: "Attempted to format a filesystem",
  },
  {
    pattern: /\bdd\b.*\bof\s*=\s*\/dev\//,
    reason: "Attempted to write directly to a device",
  },
  {
    pattern: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&\s*\}\s*;\s*:/,
    reason: "Fork bomb detected",
  },
  {
    pattern: /\bgit\s+push\s+.*--force/,
    reason: "Attempted force push (git history is read-only protected)",
  },
];
