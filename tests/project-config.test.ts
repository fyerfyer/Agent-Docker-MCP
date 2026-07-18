import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProjectConfig,
  resolveSandboxOptions,
  DEFAULT_RESOURCES,
} from "../src/project-config.js";

describe("project-config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-docker-config-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(json: unknown): void {
    const configDir = path.join(tmpDir, ".agent-docker");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(json),
      "utf8",
    );
  }

  it("returns defaults when no config file exists", () => {
    const cfg = loadProjectConfig(tmpDir);
    expect(cfg.strict).toBe(false);
    expect(cfg.allowDocker).toBe(true);
    expect(cfg.composeProxy).toBe(true);
    expect(cfg.network).toBeUndefined();
    expect(cfg.resources).toBeUndefined();
    expect(cfg.env).toBeUndefined();
    expect(cfg.protectPaths).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    const configDir = path.join(tmpDir, ".agent-docker");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      "{not json",
      "utf8",
    );
    expect(() => loadProjectConfig(tmpDir)).toThrow("Invalid JSON");
  });

  it("throws a path-aware error on schema mismatch", () => {
    writeConfig({ network: "host2" });
    expect(() => loadProjectConfig(tmpDir)).toThrow("network");
  });

  it("strict file config disables docker and switches network", () => {
    writeConfig({ strict: true });
    const resolved = resolveSandboxOptions(tmpDir);
    expect(resolved.allowDocker).toBe(false);
    expect(resolved.composeProxy).toBe(true);
    expect(resolved.network).toBe("bridge");
    expect(resolved.protectPaths).toContain(".env");
  });

  it("composeProxy can be disabled in strict mode via config", () => {
    writeConfig({ strict: true, composeProxy: false });
    const resolved = resolveSandboxOptions(tmpDir);
    expect(resolved.allowDocker).toBe(false);
    expect(resolved.composeProxy).toBe(false);
  });

  it("composeProxy is false in non-strict mode regardless of config", () => {
    writeConfig({ strict: false, composeProxy: true });
    const resolved = resolveSandboxOptions(tmpDir);
    expect(resolved.composeProxy).toBe(false);
  });

  it("explicit network in file overrides strict default", () => {
    writeConfig({ strict: true, network: "none" });
    const resolved = resolveSandboxOptions(tmpDir);
    expect(resolved.network).toBe("none");
  });

  it("CLI strict flag works without config file", () => {
    const resolved = resolveSandboxOptions(tmpDir, { strict: true });
    expect(resolved.allowDocker).toBe(false);
    expect(resolved.network).toBe("bridge");
    expect(resolved.protectPaths).toContain(".env");
  });

  it("merges env arrays with file first, CLI last", () => {
    writeConfig({ env: ["A=1"] });
    const resolved = resolveSandboxOptions(tmpDir, { env: ["B=2"] });
    expect(resolved.env).toEqual(["A=1", "B=2"]);
  });

  it("uses default resources when not configured", () => {
    const resolved = resolveSandboxOptions(tmpDir);
    expect(resolved.resources).toEqual(DEFAULT_RESOURCES);
  });

  it("overrides individual resource fields", () => {
    writeConfig({ resources: { memoryMb: 2048 } });
    const resolved = resolveSandboxOptions(tmpDir);
    expect(resolved.resources.memoryMb).toBe(2048);
    expect(resolved.resources.cpus).toBe(DEFAULT_RESOURCES.cpus);
    expect(resolved.resources.pidsLimit).toBe(DEFAULT_RESOURCES.pidsLimit);
  });

  it("CLI image flag overrides file image", () => {
    writeConfig({ image: "ubuntu:22.04" });
    const resolved = resolveSandboxOptions(tmpDir, { image: "node:20" });
    expect(resolved.image).toBe("node:20");
  });
});
