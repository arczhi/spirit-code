import type Database from "better-sqlite3";
import { logger } from "./logger.js";

export interface IssueTask {
  id: string;
  gitlab_project_path: string;
  gitlab_project_id: number;
  issue_iid: number;
  issue_title: string;
  issue_url: string;
  env: string;
  service: string;
  branch: string;
  worktree_path: string;
  claude_session_id: string | null;
  agent_messages: string | null; // JSON-serialized Anthropic.MessageParam[] for resume
  mr_iid: number | null;
  mr_url: string | null;
  status: string;
  last_note_id: number;
  iteration_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS issue_tasks (
  id                  TEXT PRIMARY KEY,
  gitlab_project_path TEXT NOT NULL,
  gitlab_project_id   INTEGER NOT NULL,
  issue_iid           INTEGER NOT NULL,
  issue_title         TEXT NOT NULL,
  issue_url           TEXT NOT NULL,
  env                 TEXT NOT NULL,
  service             TEXT NOT NULL,
  branch              TEXT NOT NULL,
  worktree_path       TEXT NOT NULL,
  claude_session_id   TEXT,
  agent_messages      TEXT,
  mr_iid              INTEGER,
  mr_url              TEXT,
  status              TEXT DEFAULT 'pending',
  last_note_id        INTEGER DEFAULT 0,
  iteration_count     INTEGER DEFAULT 0,
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(gitlab_project_id, issue_iid)
);
CREATE INDEX IF NOT EXISTS idx_issue_tasks_status ON issue_tasks(status);
CREATE INDEX IF NOT EXISTS idx_issue_tasks_project_issue ON issue_tasks(gitlab_project_id, issue_iid);
`;

export function initIssueTaskStore(db: Database.Database): void {
  db.exec(CREATE_TABLE);
  // Migration: add agent_messages column if it doesn't exist (existing DBs)
  const cols = (db.prepare("PRAGMA table_info(issue_tasks)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("agent_messages")) {
    db.exec("ALTER TABLE issue_tasks ADD COLUMN agent_messages TEXT");
    logger.info("issue_tasks: migrated — added agent_messages column");
  }
  logger.info("issue_tasks table ready");
}

export function createIssueTask(
  db: Database.Database,
  task: Omit<IssueTask, "created_at" | "updated_at" | "claude_session_id" | "agent_messages" | "mr_iid" | "mr_url" | "status" | "last_note_id" | "iteration_count" | "last_error"> &
    Partial<Pick<IssueTask, "claude_session_id" | "agent_messages" | "mr_iid" | "mr_url" | "status" | "last_note_id" | "iteration_count" | "last_error">>,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO issue_tasks
      (id, gitlab_project_path, gitlab_project_id, issue_iid, issue_title, issue_url,
       env, service, branch, worktree_path, claude_session_id, agent_messages, mr_iid, mr_url, status,
       last_note_id, iteration_count, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.gitlab_project_path,
    task.gitlab_project_id,
    task.issue_iid,
    task.issue_title,
    task.issue_url,
    task.env,
    task.service,
    task.branch,
    task.worktree_path,
    task.claude_session_id ?? null,
    task.agent_messages ?? null,
    task.mr_iid ?? null,
    task.mr_url ?? null,
    task.status ?? "pending",
    task.last_note_id ?? 0,
    task.iteration_count ?? 0,
    task.last_error ?? null,
    now,
    now,
  );
}

export function getIssueTask(db: Database.Database, id: string): IssueTask | undefined {
  return db.prepare("SELECT * FROM issue_tasks WHERE id = ?").get(id) as IssueTask | undefined;
}

export function findIssueTaskByIssue(
  db: Database.Database,
  projectId: number,
  issueIid: number,
): IssueTask | undefined {
  return db
    .prepare("SELECT * FROM issue_tasks WHERE gitlab_project_id = ? AND issue_iid = ?")
    .get(projectId, issueIid) as IssueTask | undefined;
}

export interface ListIssueTasksParams {
  status?: string | string[];
  limit?: number;
}

export function listIssueTasks(
  db: Database.Database,
  params: ListIssueTasksParams = {},
): IssueTask[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.status) {
    if (Array.isArray(params.status)) {
      conditions.push(`status IN (${params.status.map(() => "?").join(",")})`);
      values.push(...params.status);
    } else {
      conditions.push("status = ?");
      values.push(params.status);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 100;

  return db
    .prepare(`SELECT * FROM issue_tasks ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...values, limit) as IssueTask[];
}

const UPDATABLE_FIELDS = new Set<keyof IssueTask>([
  "claude_session_id",
  "agent_messages",
  "mr_iid",
  "mr_url",
  "status",
  "last_note_id",
  "iteration_count",
  "last_error",
  "branch",
  "worktree_path",
]);

export function updateIssueTask(
  db: Database.Database,
  id: string,
  fields: Partial<IssueTask>,
): void {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (!UPDATABLE_FIELDS.has(key as keyof IssueTask)) continue;
    setClauses.push(`${key} = ?`);
    values.push(value);
  }

  if (setClauses.length === 0) return;

  setClauses.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE issue_tasks SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function incrementIterationCount(db: Database.Database, id: string): void {
  db.prepare(
    "UPDATE issue_tasks SET iteration_count = iteration_count + 1, updated_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), id);
}
