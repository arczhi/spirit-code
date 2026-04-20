import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { runClaudeCode } from "../src/shared/claude-code-runner.js";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  kill(signal?: string) {
    this.killed = true;
    // Simulate async kill — emit 'close' after a tick
    setImmediate(() => this.emit("close", null));
  }
}

describe("runClaudeCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses JSON output and returns result text", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test prompt",
      cwd: "/tmp",
      sessionId: "sess-123",
    });

    // Simulate Claude CLI JSON output
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            type: "result",
            result: "I analyzed the code and found X",
            session_id: "sess-123",
            total_cost_usd: 0.05,
            duration_ms: 1234,
          }),
        ),
      );
      child.emit("close", 0);
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("I analyzed the code and found X");
    expect(result.sessionId).toBe("sess-123");
    expect(result.exitCode).toBe(0);
  });

  it("falls back to raw stdout when JSON parse fails", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test",
      cwd: "/tmp",
    });

    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("plain text output\n"));
      child.emit("close", 0);
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("plain text output");
    expect(result.rawJson).toBeNull();
  });

  it("marks ok=false when exit code is non-zero", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test",
      cwd: "/tmp",
    });

    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("Error: something failed\n"));
      child.emit("close", 1);
    });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("something failed");
  });

  it("marks ok=false when output is empty", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test",
      cwd: "/tmp",
    });

    setImmediate(() => {
      child.emit("close", 0);
    });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.text).toBe("");
  });

  it("kills the process on timeout", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test",
      cwd: "/tmp",
      timeoutMs: 100,
    });

    // Don't emit close immediately — let timeout fire
    await new Promise((r) => setTimeout(r, 150));

    expect(child.killed).toBe(true);

    const result = await promise;
    expect(result.ok).toBe(false);
  });

  it("handles spawn error", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test",
      cwd: "/tmp",
    });

    setImmediate(() => {
      child.emit("error", new Error("ENOENT: command not found"));
    });

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("ENOENT");
    expect(result.exitCode).toBeNull();
  });

  it("passes --resume when resume=true", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "continue",
      cwd: "/tmp",
      sessionId: "sess-456",
      resume: true,
    });

    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("resumed"));
      child.emit("close", 0);
    });

    await promise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--resume");
    expect(spawnArgs).toContain("sess-456");
    expect(spawnArgs).not.toContain("--session-id");
  });

  it("passes --session-id when resume=false", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "start",
      cwd: "/tmp",
      sessionId: "sess-789",
      resume: false,
    });

    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("started"));
      child.emit("close", 0);
    });

    await promise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--session-id");
    expect(spawnArgs).toContain("sess-789");
    expect(spawnArgs).not.toContain("--resume");
  });

  it("includes --add-dir for each allowedDirs entry", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test",
      cwd: "/tmp",
      allowedDirs: ["/repo/a", "/repo/b"],
    });

    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("ok"));
      child.emit("close", 0);
    });

    await promise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--add-dir");
    expect(spawnArgs).toContain("/repo/a");
    expect(spawnArgs).toContain("/repo/b");
  });

  it("includes --model when provided", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test",
      cwd: "/tmp",
      model: "claude-opus-4-6",
    });

    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("ok"));
      child.emit("close", 0);
    });

    await promise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--model");
    expect(spawnArgs).toContain("claude-opus-4-6");
  });

  it("appends extraArgs to the command", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test",
      cwd: "/tmp",
      extraArgs: ["--verbose", "--debug"],
    });

    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("ok"));
      child.emit("close", 0);
    });

    await promise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--verbose");
    expect(spawnArgs).toContain("--debug");
  });

  it("always includes --print, --output-format json, --dangerously-skip-permissions", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test",
      cwd: "/tmp",
    });

    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("ok"));
      child.emit("close", 0);
    });

    await promise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--print");
    expect(spawnArgs).toContain("--output-format");
    expect(spawnArgs).toContain("json");
    expect(spawnArgs).toContain("--dangerously-skip-permissions");
  });

  it("batches multiple stdout chunks", async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const promise = runClaudeCode({
      bin: "claude",
      prompt: "test",
      cwd: "/tmp",
    });

    setImmediate(() => {
      child.stdout.emit("data", Buffer.from('{"type":"result",'));
      child.stdout.emit("data", Buffer.from('"result":"hello",'));
      child.stdout.emit("data", Buffer.from('"session_id":"s1"}'));
      child.emit("close", 0);
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("hello");
    expect(result.sessionId).toBe("s1");
  });
});
