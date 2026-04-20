import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  initIssueTaskStore,
  createIssueTask,
  getIssueTask,
  findIssueTaskByIssue,
  listIssueTasks,
  updateIssueTask,
  incrementIterationCount,
  type IssueTask,
} from "../src/shared/issue-task-store.js";

function makeDb() {
  const db = new Database(":memory:");
  initIssueTaskStore(db);
  return db;
}

const BASE_TASK = {
  id: "task-uuid-1",
  gitlab_project_path: "org/repo",
  gitlab_project_id: 42,
  issue_iid: 7,
  issue_title: "Add export CSV button",
  issue_url: "http://git.example.com/org/repo/-/issues/7",
  env: "testing",
  service: "backend",
  branch: "feature/20260417_add-export-csv-button",
  worktree_path: "/tmp/worktrees/spirit-issue/7",
} as const;

describe("initIssueTaskStore", () => {
  it("creates the table without error", () => {
    const db = makeDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='issue_tasks'").get();
    expect(row).toBeTruthy();
  });

  it("is idempotent — calling twice does not throw", () => {
    const db = new Database(":memory:");
    expect(() => {
      initIssueTaskStore(db);
      initIssueTaskStore(db);
    }).not.toThrow();
  });
});

describe("createIssueTask", () => {
  it("inserts a row with defaults", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    const row = getIssueTask(db, BASE_TASK.id) as IssueTask;
    expect(row.id).toBe(BASE_TASK.id);
    expect(row.status).toBe("pending");
    expect(row.iteration_count).toBe(0);
    expect(row.last_note_id).toBe(0);
    expect(row.mr_iid).toBeNull();
    expect(row.claude_session_id).toBeNull();
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  it("respects explicit status override", () => {
    const db = makeDb();
    createIssueTask(db, { ...BASE_TASK, status: "active" });
    expect(getIssueTask(db, BASE_TASK.id)?.status).toBe("active");
  });

  it("throws on duplicate (project_id, issue_iid)", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    expect(() => createIssueTask(db, { ...BASE_TASK, id: "other-uuid" })).toThrow();
  });
});

describe("findIssueTaskByIssue", () => {
  it("finds by project_id + issue_iid", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    const found = findIssueTaskByIssue(db, 42, 7);
    expect(found?.id).toBe(BASE_TASK.id);
  });

  it("returns undefined for unknown issue", () => {
    const db = makeDb();
    expect(findIssueTaskByIssue(db, 42, 999)).toBeUndefined();
  });
});

describe("listIssueTasks", () => {
  it("returns all tasks when no filter", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    createIssueTask(db, { ...BASE_TASK, id: "task-2", issue_iid: 8 });
    expect(listIssueTasks(db).length).toBe(2);
  });

  it("filters by single status", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    createIssueTask(db, { ...BASE_TASK, id: "task-2", issue_iid: 8, status: "active" });
    expect(listIssueTasks(db, { status: "pending" }).length).toBe(1);
    expect(listIssueTasks(db, { status: "active" }).length).toBe(1);
  });

  it("filters by multiple statuses", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    createIssueTask(db, { ...BASE_TASK, id: "task-2", issue_iid: 8, status: "active" });
    createIssueTask(db, { ...BASE_TASK, id: "task-3", issue_iid: 9, status: "done" });
    const results = listIssueTasks(db, { status: ["pending", "active"] });
    expect(results.length).toBe(2);
  });

  it("respects limit", () => {
    const db = makeDb();
    for (let i = 1; i <= 5; i++) {
      createIssueTask(db, { ...BASE_TASK, id: `task-${i}`, issue_iid: i });
    }
    expect(listIssueTasks(db, { limit: 3 }).length).toBe(3);
  });
});

describe("updateIssueTask", () => {
  it("updates allowed fields", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    updateIssueTask(db, BASE_TASK.id, { status: "active", last_note_id: 55 });
    const row = getIssueTask(db, BASE_TASK.id) as IssueTask;
    expect(row.status).toBe("active");
    expect(row.last_note_id).toBe(55);
  });

  it("updates updated_at timestamp", async () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    const before = getIssueTask(db, BASE_TASK.id)!.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    updateIssueTask(db, BASE_TASK.id, { status: "active" });
    const after = getIssueTask(db, BASE_TASK.id)!.updated_at;
    expect(after >= before).toBe(true);
  });

  it("ignores non-updatable fields (id, gitlab_project_id)", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    // Should not throw, but also should not change id
    updateIssueTask(db, BASE_TASK.id, { id: "hacked" } as any);
    expect(getIssueTask(db, BASE_TASK.id)?.id).toBe(BASE_TASK.id);
  });

  it("is a no-op when fields object is empty", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    expect(() => updateIssueTask(db, BASE_TASK.id, {})).not.toThrow();
  });
});

describe("incrementIterationCount", () => {
  it("increments from 0 to 1", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    incrementIterationCount(db, BASE_TASK.id);
    expect(getIssueTask(db, BASE_TASK.id)?.iteration_count).toBe(1);
  });

  it("increments multiple times", () => {
    const db = makeDb();
    createIssueTask(db, BASE_TASK);
    incrementIterationCount(db, BASE_TASK.id);
    incrementIterationCount(db, BASE_TASK.id);
    incrementIterationCount(db, BASE_TASK.id);
    expect(getIssueTask(db, BASE_TASK.id)?.iteration_count).toBe(3);
  });
});
