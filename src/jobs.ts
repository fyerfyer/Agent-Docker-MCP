import { randomBytes } from "node:crypto";

const MAX_JOB_BUFFER = 200_000; // 环形缓冲上限（字符）

export interface Job {
  id: string;
  command: string;
  status: "running" | "exited" | "error";
  exitCode?: number;
  error?: string;
  buffer: string;
  startedAt: string;
}

const jobs = new Map<string, Job>();

export function createJob(command: string): Job {
  const job: Job = {
    id: randomBytes(4).toString("hex"),
    command,
    status: "running",
    buffer: "",
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  return job;
}

export function appendJobOutput(job: Job, chunk: string): void {
  job.buffer += chunk;
  if (job.buffer.length > MAX_JOB_BUFFER) {
    job.buffer = job.buffer.slice(job.buffer.length - MAX_JOB_BUFFER);
  }
}

export function finishJob(job: Job, exitCode: number): void {
  job.status = "exited";
  job.exitCode = exitCode;
}

export function failJob(job: Job, err: unknown): void {
  job.status = "error";
  job.error = err instanceof Error ? err.message : String(err);
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}
