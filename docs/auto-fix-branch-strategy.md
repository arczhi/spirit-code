# Spirit Auto-Fix 分支策略重构方案

## 背景

当前设计：所有 auto-fix 累积在单一 `spirit/auto-fix` 分支，单个 MR 批量包含所有修复。问题是 GitLab MR 只能整体 merge，无法选择性合并部分 commit。

需求：保留共享 worktree 的性能优势（避免频繁创建/删除 worktree），但每个 incident 有独立 MR，可以独立 review 和 merge。

## 方案：共享 Worktree + Per-Incident Cherry-Pick 分支

### 核心思路

```
                    共享 worktree (暂存区)                    Per-Incident 分支 (发布)
                    ─────────────────────                    ──────────────────────────
Incident A fix  →   commit on spirit/auto-fix  →  cherry-pick →  spirit/fix-{A_id}  →  MR !101
Incident B fix  →   commit on spirit/auto-fix  →  cherry-pick →  spirit/fix-{B_id}  →  MR !102
Review fix A    →   commit on spirit/auto-fix  →  cherry-pick →  spirit/fix-{A_id}  →  push to MR !101
```

1. 保留共享 worktree `.worktrees/spirit/auto-fix` 在 `spirit/auto-fix` 分支上工作
2. 每次 commit 后，立即 cherry-pick 该 commit 到新的 per-incident 分支 `spirit/fix-{incident_id_short}`
3. 为 per-incident 分支创建独立 MR，可以独立 approve/merge
4. Incident 记录 per-incident 分支和 MR，而非共享分支

### 优势

- 保留共享 worktree 性能（不用每次创建/删除）
- 每个 incident 独立 MR，可选择性 merge
- 共享分支作为"暂存区"，per-incident 分支作为"发布分支"
- MR review 后的修复仍然可以 cherry-pick 到对应 per-incident 分支

## 实现计划

### 1. 新增 `cherryPickAndPush()` — `src/shared/git-ops.ts`

在主仓库（非 worktree）中操作，将 commit cherry-pick 到 per-incident 分支并推送。

```typescript
export async function cherryPickAndPush(
  repoPath: string,
  commitHash: string,
  newBranchName: string,
  baseBranch: string,
  remote: string = "origin",
): Promise<void> {
  const g = git(repoPath);
  const originalBranch = await getCurrentBranch(repoPath);

  try {
    await g.fetch(remote, baseBranch);

    // 检查分支是否已存在
    let branchExists = false;
    try {
      await g.revparse(["--verify", newBranchName]);
      branchExists = true;
    } catch { /* 不存在 */ }

    if (branchExists) {
      await g.checkout(newBranchName);
    } else {
      await g.checkoutBranch(newBranchName, `${remote}/${baseBranch}`);
    }

    await g.raw(["cherry-pick", commitHash]);
    await g.push(remote, newBranchName, ["--set-upstream"]);
  } finally {
    // 恢复原分支
    try { await g.checkout(originalBranch); } catch { /* best effort */ }
  }
}
```

注意：此函数不经过 `assertWorktree` 检查，因为它在主仓库中操作（创建临时分支、cherry-pick、push、恢复原分支）。

### 2. 修改 `autoFix()` — `src/watcher/auto-fix.ts`

当前流程：
```
Commit → Push 共享分支 → 查找/创建单一 MR → 更新 incident
```

新流程：
```
Commit → Push 共享分支 → Cherry-pick 到 per-incident 分支 → 创建独立 MR → 更新 incident
```

关键变更（替换 lines 147-187）：

```typescript
// Commit 到共享分支
const commitHash = await gitOps.commitChanges(worktreePath, commitMsg);

// Push 共享分支（暂存区，rebase 后需要 force-with-lease）
await gitOps.pushBranch(worktreePath, codeRoot.gitRemote, { forceWithLease: true });

// Cherry-pick 到 per-incident 分支并推送
const incidentBranchName = `spirit/fix-${incident.id.slice(0, 8)}`;
await gitOps.cherryPickAndPush(
  codeRoot.path, commitHash, incidentBranchName, targetBranch, codeRoot.gitRemote,
);

// 为 per-incident 分支创建独立 MR
const projectId = await getProjectId(config.gitlab.url, config.gitlab.token, codeRoot.gitlabProjectPath);
const mr = await createMergeRequest({
  gitlabUrl: config.gitlab.url,
  token: config.gitlab.token,
  projectId,
  sourceBranch: incidentBranchName,
  targetBranch,
  title: `[Spirit] Fix: ${incident.title.slice(0, 80)}`,
  description: buildMrDescription(incident, analysis),
});

// 更新 incident，记录 per-incident 分支
updateIncident(db, incident.id, {
  status: "resolved",
  branch: incidentBranchName,  // 不再是 "spirit/auto-fix"
  mr_url: mr.web_url,
  mr_iid: mr.iid,
});
```

移除不再需要的调用：
- `findOpenMergeRequest`（不再复用 MR）
- `updateMergeRequestDescription`（不再追加描述）

### 3. 修改 `handleMrReview()` — `src/watcher/auto-fix.ts`

Review 修复同样先 commit 到共享分支，再 cherry-pick 到 per-incident 分支。

替换 lines 333-336：

```typescript
// Commit 到共享分支
const commitHash = await gitOps.commitChanges(worktreePath, commitMessage);

// Push 共享分支
await gitOps.pushBranch(worktreePath, codeRoot.gitRemote, { forceWithLease: true });

// Cherry-pick 到 per-incident 分支并推送
await gitOps.cherryPickAndPush(
  codeRoot.path, commitHash, branch, config.gitlab.defaultTargetBranch, codeRoot.gitRemote,
);
```

Review worktree 创建逻辑不变 — 仍然在共享分支 `spirit/auto-fix` 上工作。

## 迁移兼容性

- 旧 incident 的 `branch` 字段为 `"spirit/auto-fix"`，`mr_iid` 指向共享 MR
- 新 incident 的 `branch` 字段为 `"spirit/fix-{id}"`，`mr_iid` 指向独立 MR
- 两者共存，无需数据迁移

## 验证计划

1. `npx tsc --noEmit` 编译通过
2. 启动 watcher，等待两个 incident 触发 auto-fix
3. 验证：
   - 共享分支 `spirit/auto-fix` 包含两个 commit
   - 两个独立分支 `spirit/fix-{A}` 和 `spirit/fix-{B}` 各包含一个 commit
   - GitLab 上有两个独立 MR，可以分别 merge
   - DB 中 incident 记录各自的分支和 MR
