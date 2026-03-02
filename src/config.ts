export const DEFAULT_IMAGE = "node:20-bookworm";

export const WORKSPACE_PATH = "/workspace";

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
}

export const defaultConfig: Omit<SandboxConfig, "workDir"> = {
  image: DEFAULT_IMAGE,
  autoRemove: false,
};
