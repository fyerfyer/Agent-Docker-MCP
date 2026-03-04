// 数据存储在 ~/.config/agent-docker/database.sqlite 目录
// 第一次启动自动 migrate
import { drizzle } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import * as schema from "./schema.js";

function getDbDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    return path.join(xdgConfig, "agent-docker");
  }
  return path.join(os.homedir(), ".config", "agent-docker");
}

function getDbPath(): string {
  return path.join(getDbDir(), "database.sqlite");
}

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _initPromise: Promise<void> | null = null;

export function getDb() {
  if (_db) return _db;

  const dbDir = getDbDir();
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = getDbPath();
  _db = drizzle(`file:${dbPath}`, { schema });

  return _db;
}

export function initDb(): Promise<void> {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const db = getDb();
    try {
      await db.run(sql`
        CREATE TABLE IF NOT EXISTS sessions (
          id              TEXT PRIMARY KEY,
          project_path    TEXT NOT NULL,
          container_id    TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'active',
          created_at      TEXT NOT NULL,
          ended_at        TEXT
        )
      `);

      await db.run(sql`
        CREATE TABLE IF NOT EXISTS logs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  TEXT NOT NULL REFERENCES sessions(id),
          type        TEXT NOT NULL,
          payload     TEXT NOT NULL,
          timestamp   TEXT NOT NULL
        )
      `);

      // 索引
      await db.run(sql`
        CREATE INDEX IF NOT EXISTS idx_sessions_status
          ON sessions(status)
      `);

      await db.run(sql`
        CREATE INDEX IF NOT EXISTS idx_sessions_project_path
          ON sessions(project_path)
      `);

      await db.run(sql`
        CREATE INDEX IF NOT EXISTS idx_logs_session_id
          ON logs(session_id)
      `);

      await db.run(sql`
        CREATE INDEX IF NOT EXISTS idx_logs_timestamp
          ON logs(timestamp)
      `);
    } catch (err) {
      _initPromise = null; // 重试
      throw err;
    }
  })();

  return _initPromise;
}

export { schema };
