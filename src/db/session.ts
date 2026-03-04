import { randomBytes } from "node:crypto";
import { eq, desc, and, like } from "drizzle-orm";
import { getDb, initDb } from "./index.js";
import {
  sessions,
  logs,
  type Session,
  type SessionStatus,
  type LogType,
} from "./schema.js";

function generateShortId(): string {
  return randomBytes(4).toString("hex"); // 8-char hex string
}

export async function createSession(
  projectPath: string,
  containerId: string,
): Promise<Session> {
  await initDb();
  const db = getDb();
  const id = generateShortId();
  const now = new Date().toISOString();

  const newSession = {
    id,
    projectPath,
    containerId,
    status: "active" as const,
    createdAt: now,
    endedAt: null,
  };

  await db.insert(sessions).values(newSession);
  return newSession;
}

export async function endSession(
  sessionId: string,
  status: SessionStatus = "completed",
): Promise<void> {
  await initDb();
  const db = getDb();
  const now = new Date().toISOString();

  await db
    .update(sessions)
    .set({ status, endedAt: now })
    .where(eq(sessions.id, sessionId));
}

export async function getSession(
  sessionId: string,
): Promise<Session | undefined> {
  await initDb();
  const db = getDb();

  const results = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  return results[0];
}

export async function findSessionByPrefix(
  prefix: string,
): Promise<Session | undefined> {
  await initDb();
  const db = getDb();

  const results = await db
    .select()
    .from(sessions)
    .where(like(sessions.id, `${prefix}%`))
    .limit(1);

  return results[0];
}

export async function getActiveSessionForProject(
  projectPath: string,
): Promise<Session | undefined> {
  await initDb();
  const db = getDb();

  const results = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.projectPath, projectPath), eq(sessions.status, "active")),
    )
    .limit(1);

  return results[0];
}

export async function listSessions(limit: number = 20): Promise<Session[]> {
  await initDb();
  const db = getDb();

  return db
    .select()
    .from(sessions)
    .orderBy(desc(sessions.createdAt))
    .limit(limit);
}

export async function listSessionsByProject(
  projectPath: string,
  limit: number = 20,
): Promise<Session[]> {
  await initDb();
  const db = getDb();

  return db
    .select()
    .from(sessions)
    .where(eq(sessions.projectPath, projectPath))
    .orderBy(desc(sessions.createdAt))
    .limit(limit);
}

export async function appendLog(
  sessionId: string,
  type: LogType,
  payload: string,
): Promise<void> {
  await initDb();
  const db = getDb();
  const now = new Date().toISOString();

  await db.insert(logs).values({
    sessionId,
    type,
    payload,
    timestamp: now,
  });
}

export async function getSessionLogs(
  sessionId: string,
): Promise<(typeof logs.$inferSelect)[]> {
  await initDb();
  const db = getDb();

  return db
    .select()
    .from(logs)
    .where(eq(logs.sessionId, sessionId))
    .orderBy(logs.timestamp);
}

export function formatDuration(
  startIso: string,
  endIso?: string | null,
): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const diffMs = end - start;

  if (diffMs < 0) return "0s";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;

  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}

export function shortenPath(fullPath: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && fullPath.startsWith(home)) {
    return "~" + fullPath.slice(home.length);
  }
  return fullPath;
}
