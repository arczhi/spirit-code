import Database from "better-sqlite3";
import { logger } from "./logger.js";

export interface Incident {
  id: string;
  fingerprint: string;
  title: string;
  env: string;
  service: string;
  level: string;
  count: number;
  first_seen: string;
  last_seen: string;
  sample_logs: string | null;
  trace_ids: string | null;
  suspected_files: string | null;
  risk_level: string | null;
  analysis: string | null;
  fix_plan: string | null;
  status: string;
  branch: string | null;
  mr_url: string | null;
  mr_iid: number | null;
  created_at: string;
  updated_at: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS incidents (
  id              TEXT PRIMARY KEY,
  fingerprint     TEXT NOT NULL,
  title           TEXT NOT NULL,
  env             TEXT NOT NULL,
  service         TEXT NOT NULL,
  level           TEXT NOT NULL,
  count           INTEGER DEFAULT 1,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  sample_logs     TEXT,
  trace_ids       TEXT,
  suspected_files TEXT,
  risk_level      TEXT,
  analysis        TEXT,
  fix_plan        TEXT,
  status          TEXT DEFAULT 'open',
  branch          TEXT,
  mr_url          TEXT,
  mr_iid          INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fingerprint ON incidents(fingerprint);
CREATE INDEX IF NOT EXISTS idx_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_env ON incidents(env);
`;

export function initDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE);
  logger.info(`SQLite initialized at ${dbPath}`);
  return db;
}

export function createIncident(
  db: Database.Database,
  incident: Omit<Incident, "count" | "sample_logs" | "trace_ids" | "suspected_files" | "risk_level" | "analysis" | "fix_plan" | "status" | "branch" | "mr_url" | "mr_iid" | "created_at" | "updated_at"> & Partial<Incident>,
): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO incidents (id, fingerprint, title, env, service, level, count, first_seen, last_seen,
      sample_logs, trace_ids, suspected_files, risk_level, analysis, fix_plan, status, branch, mr_url, mr_iid, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    incident.id,
    incident.fingerprint,
    incident.title,
    incident.env,
    incident.service,
    incident.level,
    incident.count ?? 1,
    incident.first_seen,
    incident.last_seen,
    incident.sample_logs ?? null,
    incident.trace_ids ?? null,
    incident.suspected_files ?? null,
    incident.risk_level ?? null,
    incident.analysis ?? null,
    incident.fix_plan ?? null,
    incident.status ?? "open",
    incident.branch ?? null,
    incident.mr_url ?? null,
    incident.mr_iid ?? null,
    now,
    now,
  );
}

export function getIncident(db: Database.Database, id: string): Incident | undefined {
  return db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Incident | undefined;
}

export interface ListIncidentsParams {
  env?: string;
  status?: string;
  limit?: number;
}

export function listIncidents(db: Database.Database, params: ListIncidentsParams = {}): Incident[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.env) {
    conditions.push("env = ?");
    values.push(params.env);
  }
  if (params.status) {
    conditions.push("status = ?");
    values.push(params.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;

  return db.prepare(`SELECT * FROM incidents ${where} ORDER BY updated_at DESC LIMIT ?`).all(...values, limit) as Incident[];
}

export function updateIncident(db: Database.Database, id: string, fields: Partial<Incident>): void {
  const now = new Date().toISOString();
  const entries = Object.entries(fields).filter(([k]) => k !== "id" && k !== "created_at");
  if (entries.length === 0) return;

  const sets = entries.map(([k]) => `${k} = ?`);
  sets.push("updated_at = ?");
  const values = entries.map(([, v]) => v);
  values.push(now, id);

  db.prepare(`UPDATE incidents SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function findByFingerprint(db: Database.Database, fingerprint: string, dedupeWindowSec: number): Incident | undefined {
  const since = new Date(Date.now() - dedupeWindowSec * 1000).toISOString();
  return db.prepare("SELECT * FROM incidents WHERE fingerprint = ? AND last_seen > ? ORDER BY last_seen DESC LIMIT 1").get(fingerprint, since) as Incident | undefined;
}

export function incrementCount(db: Database.Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE incidents SET count = count + 1, last_seen = ?, updated_at = ? WHERE id = ?").run(now, now, id);
}

/**
 * Recompute fingerprints for all incidents using the current fingerprint algorithm.
 * When duplicates are found (same new fingerprint), keep the one with the highest count
 * and merge counts into it, then delete the rest.
 */
export function recomputeFingerprints(
  db: Database.Database,
  fingerprintFn: (message: string, stackTop?: string) => string,
): { updated: number; merged: number } {
  const all = db.prepare("SELECT id, title, fingerprint FROM incidents").all() as Pick<Incident, "id" | "title" | "fingerprint">[];

  let updated = 0;
  const newFpMap = new Map<string, string>(); // id -> new fingerprint

  for (const row of all) {
    const newFp = fingerprintFn(row.title);
    newFpMap.set(row.id, newFp);
    if (newFp !== row.fingerprint) {
      updated++;
    }
  }

  // Group by new fingerprint to find duplicates
  const groups = new Map<string, string[]>(); // newFp -> [id, ...]
  for (const [id, fp] of newFpMap) {
    const list = groups.get(fp) ?? [];
    list.push(id);
    groups.set(fp, list);
  }

  let merged = 0;
  const now = new Date().toISOString();

  const updateFp = db.prepare("UPDATE incidents SET fingerprint = ?, updated_at = ? WHERE id = ?");
  const getRow = db.prepare("SELECT id, count, status, mr_iid FROM incidents WHERE id = ?");
  const mergeCount = db.prepare("UPDATE incidents SET count = count + ?, updated_at = ? WHERE id = ?");
  const deleteRow = db.prepare("DELETE FROM incidents WHERE id = ?");

  const txn = db.transaction(() => {
    for (const [newFp, ids] of groups) {
      if (ids.length === 1) {
        // No duplicates, just update fingerprint if changed
        const row = all.find(r => r.id === ids[0])!;
        if (newFp !== row.fingerprint) {
          updateFp.run(newFp, now, ids[0]);
        }
        continue;
      }

      // Multiple incidents with same new fingerprint — merge into the best one
      // Prefer: resolved with MR > highest count > most recent
      const rows = ids.map(id => getRow.get(id) as any).filter(Boolean);
      rows.sort((a: any, b: any) => {
        // Prefer resolved with MR
        if (a.mr_iid && !b.mr_iid) return -1;
        if (!a.mr_iid && b.mr_iid) return 1;
        // Then by count
        return b.count - a.count;
      });

      const keeper = rows[0];
      const duplicates = rows.slice(1);

      // Update keeper's fingerprint
      updateFp.run(newFp, now, keeper.id);

      // Merge duplicates into keeper
      for (const dup of duplicates) {
        mergeCount.run(dup.count, now, keeper.id);
        deleteRow.run(dup.id);
        merged++;
      }
    }
  });

  txn();

  if (updated > 0 || merged > 0) {
    logger.info(`Fingerprint migration: ${updated} updated, ${merged} duplicates merged`);
  }

  return { updated, merged };
}
