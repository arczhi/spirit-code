import { describe, it, expect } from "vitest";
import {
  resolveCodeRoot,
  selectNewHumanComments,
  isSpiritNote,
} from "../src/watcher/issue-orchestrator.js";
import type { Config } from "../src/shared/config.js";
import type { GitlabNote } from "../src/shared/gitlab-api.js";

// Minimal config fixture
function makeConfig(overrides: Partial<Config["watcher"]["issueWatcher"]> = {}): Config {
  return {
    environments: [
      {
        name: "testing",
        type: "test",
        elasticsearch: { url: "http://localhost:9200", indices: [], errorQuery: "" },
        logFiles: [],
        databases: [],
        codeRoots: [
          {
            name: "backend",
            path: "/repo/backend",
            gitRemote: "origin",
            defaultBranch: "master",
            gitlabProjectPath: "org/backend",
          },
        ],
      },
      {
        name: "production",
        type: "prod",
        elasticsearch: { url: "http://localhost:9200", indices: [], errorQuery: "" },
        logFiles: [],
        databases: [],
        codeRoots: [
          {
            name: "backend",
            path: "/repo/backend-prod",
            gitRemote: "origin",
            defaultBranch: "master",
            gitlabProjectPath: "org/backend",
          },
        ],
      },
    ],
    gitlab: { url: "http://git.example.com", token: "tok", defaultTargetBranch: "test" },
    claude: { apiKey: "key", baseUrl: "http://api", model: "claude-opus-4-6" },
    watcher: {
      esPollingInterval: 30,
      dedupeWindow: 3600,
      maxConcurrentFixes: 3,
      riskAutoFix: ["A", "B"],
      mrCommentPollingInterval: 60000,
      issueWatcher: {
        enabled: true,
        label: "ai-dev",
        issuePollingInterval: 30000,
        commentPollingInterval: 60000,
        claudeTimeout: 1800000,
        claudeBin: "claude",
        claudeExtraArgs: [],
        preferEnv: "testing",
        maxIterations: 20,
        maxConcurrent: 3,
        ...overrides,
      },
    },
    storage: { type: "sqlite", path: ":memory:" },
  } as unknown as Config;
}

function makeNote(overrides: Partial<GitlabNote> = {}): GitlabNote {
  return {
    id: 1,
    body: "hello",
    author: { id: 10, username: "dev", name: "Dev" },
    created_at: "2026-04-17T00:00:00Z",
    system: false,
    ...overrides,
  };
}

// ─── resolveCodeRoot ──────────────────────────────────────────

describe("resolveCodeRoot", () => {
  it("returns the testing env codeRoot when preferEnv=testing", () => {
    const config = makeConfig({ preferEnv: "testing" });
    const match = resolveCodeRoot(config, "org/backend");
    expect(match).not.toBeNull();
    expect(match!.env.name).toBe("testing");
    expect(match!.codeRoot.path).toBe("/repo/backend");
  });

  it("returns the production env codeRoot when preferEnv=production", () => {
    const config = makeConfig({ preferEnv: "production" });
    const match = resolveCodeRoot(config, "org/backend");
    expect(match).not.toBeNull();
    expect(match!.env.name).toBe("production");
    expect(match!.codeRoot.path).toBe("/repo/backend-prod");
  });

  it("returns null for unknown project path", () => {
    const config = makeConfig();
    expect(resolveCodeRoot(config, "org/unknown")).toBeNull();
  });

  it("falls back to any env when preferEnv does not match", () => {
    const config = makeConfig({ preferEnv: "staging" });
    const match = resolveCodeRoot(config, "org/backend");
    // Should still find one (either testing or production)
    expect(match).not.toBeNull();
  });
});

// ─── isSpiritNote ─────────────────────────────────────────────

describe("isSpiritNote", () => {
  it("returns true for system notes", () => {
    expect(isSpiritNote(makeNote({ system: true }))).toBe(true);
  });

  it("returns true for notes containing the Spirit marker", () => {
    const note = makeNote({ body: "## 🧠 Spirit\n\n<!-- spirit-issue-bot -->\nsome text" });
    expect(isSpiritNote(note)).toBe(true);
  });

  it("returns false for regular human comments", () => {
    expect(isSpiritNote(makeNote({ body: "Please also handle edge case X" }))).toBe(false);
  });

  it("returns false for empty body human note", () => {
    expect(isSpiritNote(makeNote({ body: "" }))).toBe(false);
  });
});

// ─── selectNewHumanComments ───────────────────────────────────

describe("selectNewHumanComments", () => {
  it("returns only notes with id > lastNoteId", () => {
    const notes = [
      makeNote({ id: 1, body: "old" }),
      makeNote({ id: 2, body: "new" }),
      makeNote({ id: 3, body: "newer" }),
    ];
    const result = selectNewHumanComments(notes, 1);
    expect(result.map((n) => n.id)).toEqual([2, 3]);
  });

  it("excludes system notes", () => {
    const notes = [
      makeNote({ id: 2, body: "assigned to dev", system: true }),
      makeNote({ id: 3, body: "real comment" }),
    ];
    expect(selectNewHumanComments(notes, 0).length).toBe(1);
    expect(selectNewHumanComments(notes, 0)[0].id).toBe(3);
  });

  it("excludes Spirit bot notes", () => {
    const notes = [
      makeNote({ id: 2, body: "## 🧠 Spirit\n\n<!-- spirit-issue-bot -->\nI did X" }),
      makeNote({ id: 3, body: "developer reply" }),
    ];
    const result = selectNewHumanComments(notes, 0);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(3);
  });

  it("excludes blank-body notes", () => {
    const notes = [makeNote({ id: 2, body: "   " }), makeNote({ id: 3, body: "real" })];
    const result = selectNewHumanComments(notes, 0);
    expect(result.length).toBe(1);
  });

  it("returns empty array when all notes are old", () => {
    const notes = [makeNote({ id: 1 }), makeNote({ id: 2 })];
    expect(selectNewHumanComments(notes, 5)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(selectNewHumanComments([], 0)).toEqual([]);
  });
});
