import { describe, it, expect } from "vitest";
import {
  createJob,
  appendJobOutput,
  finishJob,
  failJob,
  getJob,
} from "../src/jobs.js";

describe("jobs", () => {
  it("creates a running job", () => {
    const job = createJob("sleep 10");
    expect(job.status).toBe("running");
    expect(job.command).toBe("sleep 10");
    expect(job.buffer).toBe("");
    expect(getJob(job.id)).toBe(job);
  });

  it("drops old output when buffer exceeds limit", () => {
    const job = createJob("cmd");
    const prefix = "a".repeat(5_000);
    const suffix = "b".repeat(210_000);
    appendJobOutput(job, prefix);
    appendJobOutput(job, suffix);
    expect(job.buffer.length).toBeLessThanOrEqual(200_000);
    expect(job.buffer.startsWith("a")).toBe(false);
    expect(job.buffer.endsWith("b".repeat(1000))).toBe(true);
  });

  it("transitions to exited", () => {
    const job = createJob("cmd");
    finishJob(job, 0);
    expect(job.status).toBe("exited");
    expect(job.exitCode).toBe(0);
  });

  it("transitions to error with message", () => {
    const job = createJob("cmd");
    failJob(job, new Error("boom"));
    expect(job.status).toBe("error");
    expect(job.error).toBe("boom");
  });

  it("returns undefined for unknown job", () => {
    expect(getJob("unknown")).toBeUndefined();
  });
});
