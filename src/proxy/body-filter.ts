// 请求体过滤器：检查 Docker /containers/create 等危险字段

import path from "node:path";

const SENSITIVE_PATH_PREFIXES = [
  "/var/run/docker.sock",
  "/var/run/docker.sock/",
  "/proc",
  "/proc/",
  "/sys",
  "/sys/",
  "/dev",
  "/dev/",
  "/etc",
  "/etc/",
  "/root",
  "/root/",
];

const DANGEROUS_CAPS = [
  "SYS_ADMIN",
  "SYS_PTRACE",
  "SYS_MODULE",
  "NET_ADMIN",
  "SYS_RAWIO",
  "SYS_BOOT",
  "SYS_TIME",
  "SYSLOG",
  "DAC_READ_SEARCH",
  "LINUX_IMMUTABLE",
  "NET_BROADCAST",
  "NET_RAW",
  "IPC_LOCK",
  "IPC_OWNER",
  "SYS_CHROOT",
  "SYS_PACCT",
  "SYS_NICE",
  "SYS_RESOURCE",
  "WAKE_ALARM",
  "BLOCK_SUSPEND",
  "AUDIT_CONTROL",
  "AUDIT_READ",
  "MAC_ADMIN",
  "MAC_OVERRIDE",
];

export interface ValidationResult {
  ok: true;
}

export interface ValidationError {
  ok: false;
  reason: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isSensitivePath(checkPath: string): boolean {
  const normalized = path.normalize(checkPath.replace(/\\/g, "/"));
  if (normalized === "/") return true;
  return SENSITIVE_PATH_PREFIXES.some((prefix) =>
    normalized === prefix || normalized.startsWith(prefix),
  );
}

function isProjectPath(checkPath: string, projectDir: string): boolean {
  const normalized = path.normalize(checkPath.replace(/\\/g, "/"));
  const normalizedProject = path.normalize(
    projectDir.replace(/\\/g, "/").replace(/\/$/, ""),
  );
  return (
    normalized === normalizedProject ||
    normalized.startsWith(`${normalizedProject}/`)
  );
}

function resolveBindSource(source: string, projectDir?: string): string {
  const normalized = source.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return path.normalize(normalized);
  if (!projectDir) return normalized;
  const base = projectDir.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized === ".") return path.normalize(base);
  if (normalized.startsWith("./")) {
    return path.normalize(`${base}/${normalized.slice(2)}`);
  }
  return path.normalize(`${base}/${normalized}`);
}

function isBindMountSource(source: string): boolean {
  // Docker -v syntax: absolute paths are bind mounts; names are volumes.
  // Relative paths used by compose are resolved by the daemon and treated as bind mounts.
  return source.startsWith("/") || source.startsWith("./") || source.startsWith("../");
}

export function validateContainerCreate(
  body: unknown,
  projectDir?: string,
): ValidationResult | ValidationError {
  if (!isObject(body)) {
    return { ok: false, reason: "Invalid container create body" };
  }

  const hostConfig = isObject(body.HostConfig) ? body.HostConfig : {};

  if (hostConfig.Privileged === true) {
    return { ok: false, reason: "Privileged containers are not allowed" };
  }

  const networkMode = String(hostConfig.NetworkMode ?? "").toLowerCase();
  if (networkMode === "host") {
    return { ok: false, reason: "Host network mode is not allowed" };
  }

  const pidMode = String(hostConfig.PidMode ?? "").toLowerCase();
  if (pidMode === "host") {
    return { ok: false, reason: "Host pid mode is not allowed" };
  }

  if (isStringArray(hostConfig.Devices) && hostConfig.Devices.length > 0) {
    return { ok: false, reason: "Device mounts are not allowed" };
  }

  const runtime = hostConfig.Runtime;
  if (typeof runtime === "string" && runtime !== "" && runtime !== "runc") {
    return { ok: false, reason: `Runtime "${runtime}" is not allowed` };
  }

  const capAdd = hostConfig.CapAdd;
  if (isStringArray(capAdd)) {
    const dangerous = capAdd.filter((cap) =>
      DANGEROUS_CAPS.includes(cap.toUpperCase()),
    );
    if (dangerous.length > 0) {
      return {
        ok: false,
        reason: `Dangerous capabilities are not allowed: ${dangerous.join(", ")}`,
      };
    }
  }

  const securityOpt = hostConfig.SecurityOpt;
  if (isStringArray(securityOpt)) {
    const bad = securityOpt.find(
      (opt) =>
        opt.toLowerCase().includes("seccomp=unconfined") ||
        opt.toLowerCase().includes("apparmor=unconfined") ||
        opt.toLowerCase().includes("no-new-privileges:false"),
    );
    if (bad) {
      return {
        ok: false,
        reason: `Security option "${bad}" is not allowed`,
      };
    }
  }

  const binds = hostConfig.Binds;
  if (isStringArray(binds)) {
    for (const bind of binds) {
      const source = bind.split(":")[0];
      if (!source) continue;
      const resolvedSource = resolveBindSource(source, projectDir);
      if (isSensitivePath(resolvedSource)) {
        return {
          ok: false,
          reason: `Bind mount source "${source}" is not allowed`,
        };
      }
      if (
        projectDir &&
        resolvedSource !== "/dev/null" &&
        isBindMountSource(source) &&
        !isProjectPath(resolvedSource, projectDir)
      ) {
        return {
          ok: false,
          reason: `Bind mount source "${source}" is outside the project directory`,
        };
      }
    }
  }

  const mounts = hostConfig.Mounts;
  if (Array.isArray(mounts)) {
    for (const mount of mounts) {
      if (!isObject(mount)) continue;
      if (mount.Type === "bind") {
        const source = String(mount.Source ?? "");
        if (!source) continue;
        const resolvedSource = resolveBindSource(source, projectDir);
        if (isSensitivePath(resolvedSource)) {
          return {
            ok: false,
            reason: `Bind mount source "${source}" is not allowed`,
          };
        }
        if (
          projectDir &&
          resolvedSource !== "/dev/null" &&
          !isProjectPath(resolvedSource, projectDir)
        ) {
          return {
            ok: false,
            reason: `Bind mount source "${source}" is outside the project directory`,
          };
        }
      }
    }
  }

  return { ok: true };
}
