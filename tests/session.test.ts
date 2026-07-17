import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSession,
  appendLog,
  getSessionLogs,
  findSessionByPrefix,
  endSession,
  getSession,
} from "../src/db/session.js";

describe("session db", () => {
  let originalXdg: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-docker-db-"));
    process.env.XDG_CONFIG_HOME = tmpDir;
    // Clear module-level singleton by re-importing not needed; env is read at first use.
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    // Keep the temp dir alive for the libsql connection; remove on next beforeEach.
  });

  it("creates a session and returns logs in insertion order", async () => {
    const session = await createSession("/tmp/project", "container-id-123");
    await appendLog(session.id, "container_stdout", "line1");
    await appendLog(session.id, "container_stdout", "line2");
    await appendLog(session.id, "container_stderr", "line3");

    const logs = await getSessionLogs(session.id);
    expect(logs).toHaveLength(3);
    expect(logs.map((l) => l.payload)).toEqual(["line1", "line2", "line3"]);
  });

  it("finds session by prefix", async () => {
    const session = await createSession("/tmp/project", "container-id");
    const found = await findSessionByPrefix(session.id.slice(0, 4));
    expect(found?.id).toBe(session.id);
  });

  it("ends session with status and timestamp", async () => {
    const session = await createSession("/tmp/project", "container-id");
    await endSession(session.id, "completed");
    const updated = await getSession(session.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.endedAt).toBeTruthy();
  });
});
