import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), 
  projectPath: text("project_path").notNull(),
  containerId: text("container_id").notNull(),
  status: text("status", {
    enum: ["active", "completed", "error", "terminated_by_user"],
  })
    .notNull()
    .default("active"),
  createdAt: text("created_at").notNull(), 
  endedAt: text("ended_at"),
});

export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  type: text("type", {
    enum: [
      "mcp_tool_call",
      "container_stdout",
      "container_stderr",
      "system_event",
    ],
  }).notNull(),
  payload: text("payload").notNull(),
  timestamp: text("timestamp").notNull(), 
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Log = typeof logs.$inferSelect;
export type NewLog = typeof logs.$inferInsert;
export type SessionStatus = Session["status"];
export type LogType = Log["type"];
