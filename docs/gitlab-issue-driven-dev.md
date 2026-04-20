# Spirit — GitLab Issue 驱动的 AI 开发看板

> 日期：2026-04-17
> 状态：S1 基础设施（进行中）
> 上一版：见 `docs/design.md` v0.1.0 仅覆盖 log→auto-fix 流程

## 1. 背景与目标

当前 Spirit 只处理"生产日志告警 → 自动修复"路径。现在把 AI 开发入口前移到需求侧：

**开发者在 GitLab 上提 Issue → Spirit 派 Claude Code 接需求 → 双方通过 Issue 评论对话 → Claude Code 在 worktree 里写代码并提 MR**

GitLab Issue 成为 AI 开发看板，开发者不再需要切命令行，评论即指令。

## 2. 产品流程（抓手级）

```
开发者                        GitLab Issue             Spirit Watcher                  Claude Code
  │                              │                          │                              │
  │── 创建 Issue（带 ai-dev 标签）──▶                          │                              │
  │                              │                          │                              │
  │                              │◀── issue-poller（每 30s）──│                              │
  │                              │                          │── 建 worktree + 分支 ──────▶│
  │                              │                          │  feature/20260417_xxx        │
  │                              │                          │                              │
  │                              │                          │── spawn claude --print ────▶│
  │                              │                          │   --session-id <uuid>        │
  │                              │                          │   (prompt = issue body)      │
  │                              │                          │                              │
  │                              │◀── 发评论（Claude 回复）──│◀── 捕获 stdout ──────────────│
  │                              │                          │                              │
  │── 回复评论（追加需求）────────▶│                          │                              │
  │                              │                          │                              │
  │                              │◀── comment-poller（60s）──│                              │
  │                              │                          │── claude --resume <id> ────▶│
  │                              │                          │   (prompt = 评论正文)        │
  │                              │                          │                              │
  │                              │◀── 发评论（Claude 回复）──│◀── 捕获 stdout ──────────────│
  │                              │                          │                              │
  │                              │                          │── 检测 worktree 有改动 ──────│
  │                              │                          │   auto-commit + push         │
  │                              │                          │── 建 MR（关联 Issue）───────▶│
  │                              │                          │                              │
  │── Merge MR ──────────────────▶                          │── issue 关闭 → 清理 worktree │
```

## 3. 关键设计决策（需 owner 对齐）

### 3.1 触发入口 — 标签白名单 `ai-dev`

- 只监听带指定标签的 Issue（默认 `ai-dev`，可配）
- 未打标签的 Issue 一律忽略 —— 避免 Spirit 接管所有 Issue 造成噪声
- 假设：开发者通过加标签主动 opt-in

**替代方案**（若 owner 不认同）：监听所有 Issue，但 Issue 描述里必须包含关键词 `@spirit` 或 `/spirit ack`。

### 3.2 分支命名 — `feature/YYYYMMDD_{slug}`

- 日期取 Issue 创建时的本地日期（`Asia/Shanghai`）
- `slug` = Issue 标题经过 slugify 处理后截断前 30 字符
  - 中文标题：拼音转换 or 直接用 issue_iid 作为 fallback
  - 非字母数字替换为 `-`，多个连续 `-` 合并
- 完整示例：`feature/20260417_add-export-csv-button`

**规则决定权**：slug 由 Spirit 确定性生成，不让 Claude 决定（避免命名漂移）。

### 3.3 Agent 执行方式 — Anthropic SDK agent-loop（v0.2.1 重构）

> **原方案**（`claude --print --session-id`）已废弃。原因：CLI 子进程在 permission denial 时返回 exit 1 但输出有效，`--resume` 依赖本地 session 文件不可靠，进程卡死难以诊断。

**新方案**：与 `analyzer.ts` 完全对齐，使用 Anthropic SDK tool-use loop：

```typescript
// src/watcher/issue-agent.ts
const response = await client.messages.create({
  model: config.claude.model,
  max_tokens: 8192,
  system: systemPrompt,
  messages,   // 完整对话历史，支持 resume
  tools,      // read_file / write_file / list_files / run_command / search_code
});
```

**工具集**：

| 工具 | 用途 |
|------|------|
| `read_file` | 读取 worktree 内文件 |
| `write_file` | 写入/创建文件（自动建父目录） |
| `list_files` | 列出目录内容 |
| `run_command` | 执行 shell 命令（git status/diff/add/commit、go build、npm test 等） |
| `search_code` | grep 代码模式 |

**Resume 机制**：对话历史（`Anthropic.MessageParam[]`）序列化为 JSON 存入 `issue_tasks.agent_messages`，下次迭代时反序列化后追加新 user message 继续对话。不依赖任何本地 session 文件。

**安全护栏**：
- 所有文件操作在 tool 执行层做路径校验，拒绝 worktree 外的读写
- `run_command` 拦截 `git checkout/switch/worktree` 命令
- 超时控制：Anthropic SDK `timeout: 120_000`（单次 API 调用），整体由 `MAX_TOOL_ROUNDS=100` 限制

### 3.4 评论回环 — 轮询而非 webhook

- GitLab webhook 需要公网可达的 endpoint，本地开发机不具备
- 采用与 `mr-comment-poller.ts` 同样的轮询模式
- 默认 60s 轮询一次，可配
- 通过 `last_note_id` 水位线避免重复处理

### 3.5 数据模型 — 新增 `issue_tasks` 表

与 `incidents` 表平级，不复用。语义不同：incident 是被动发现的告警，issue_task 是主动认领的需求。

```sql
CREATE TABLE IF NOT EXISTS issue_tasks (
  id                  TEXT PRIMARY KEY,         -- UUID
  gitlab_project_path TEXT NOT NULL,            -- idreamsky/.../mobgi_ai_backend
  gitlab_project_id   INTEGER NOT NULL,
  issue_iid           INTEGER NOT NULL,
  issue_title         TEXT NOT NULL,
  issue_url           TEXT NOT NULL,
  env                 TEXT NOT NULL,            -- 复用 environment 概念定位 codeRoot
  service             TEXT NOT NULL,            -- backend / frontend
  branch              TEXT NOT NULL,            -- feature/20260417_xxx
  worktree_path       TEXT NOT NULL,
  claude_session_id   TEXT,                     -- --session-id / --resume 用
  mr_iid              INTEGER,
  mr_url              TEXT,
  status              TEXT DEFAULT 'pending',
  last_note_id        INTEGER DEFAULT 0,        -- 评论水位线
  iteration_count     INTEGER DEFAULT 0,        -- Claude 运行次数
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(gitlab_project_id, issue_iid)
);
```

**状态机**：
```
pending  →  active  →  wip      →  done       →  closed
 (新建)   (首次跑完)   (有 MR)    (MR merged)   (issue 关)
    │         │          │           │
    └─────────┴──────────┴───────────┴───→  failed
```

### 3.6 并发与资源隔离

- 继承 `watcher.maxConcurrentFixes`（默认 3），与 auto-fix 共享配额
- 每个 issue 独占一个 worktree `.worktrees/spirit-issue/{issue_iid}/`
- 不共享 worktree（和 auto-fix 的 `.worktrees/spirit/auto-fix` 共用模式不同）—— issue 之间无法合并 commit

### 3.7 Codebase 映射

Issue 在某个 `gitlab_project_path` 下。通过反查 `config.environments[].codeRoots[]` 找到本地 `codeRoot.path`：

- 若多个 env 都有同名 codeRoot（prod + test），优先 **test**（AI 开发走测试环境）
- 若找不到映射 → 记录 `failed`，发评论说明未配置

## 4. 新增配置项

```yaml
watcher:
  # 既有字段...
  issueWatcher:
    enabled: true
    label: "ai-dev"                          # 标签过滤
    issuePollingInterval: 30000              # ms
    commentPollingInterval: 60000            # ms
    claudeTimeout: 1800000                   # 30 min
    claudeBin: "claude"                      # 支持绝对路径
    claudeExtraArgs: []                      # 额外 CLI 参数
    preferEnv: "testing"                     # 同名 codeRoot 取哪个 env
```

## 5. 模块拆分

| 模块 | 职责 | 依赖 |
|------|------|------|
| `src/shared/issue-task-store.ts` | `issue_tasks` 表 CRUD | better-sqlite3 |
| `src/shared/claude-code-runner.ts` | spawn `claude` 子进程 + 解析 JSON | child_process |
| `src/shared/gitlab-api.ts`（扩展） | `listIssues`, `getIssue`, `getIssueNotes`, `createIssueNote`, `linkIssueToMr` | — |
| `src/watcher/issue-poller.ts` | 轮询新 issue，创建 task | store, api |
| `src/watcher/issue-comment-poller.ts` | 轮询活跃 task 的评论，触发 resume | store, api |
| `src/watcher/issue-orchestrator.ts` | 编排：建分支/worktree/跑 claude/发评论/建 MR | 全部 |
| `src/watcher/index.ts`（扩展） | 启动新 poller | — |

## 6. 实现 Slice 计划

### Slice 1 — 基础设施 ✅（已交付）

- 本设计文档
- `config.ts` 新增 `issueWatcher` schema
- `issue-task-store.ts`：建表 + CRUD
- `gitlab-api.ts`：issue 相关 API（listIssues / getIssueNotes / createIssueNote）
- `claude-code-runner.ts`：子进程封装（有单元可以 mock）

### Slice 2 — 编排闭环 ✅（已交付）

- `issue-orchestrator.ts`：
  - `handleNewIssue` — 建 worktree + 首次 spawn Claude + 发评论
  - `handleNewComments` — resume Claude + 发评论
  - `selectNewHumanComments` — 评论水位线过滤（跳过 Spirit 自发评论，识别标记 `<!-- spirit-issue-bot -->`）
  - `resolveAllProjectIds` — 一次性解析所有 codeRoot 的 GitLab project_id
  - 每 task 级互斥锁 `taskLocks` — 串化 initial 与 resume
  - 迭代上限保护：`iteration_count >= maxIterations` 时标 `stalled`
- `issue-poller.ts` (`IssueWatcher`)：
  - 按 `label` 轮询每个项目的 opened issues
  - 已有 issue_task 的 issue 跳过（幂等）
  - 不依赖 `updated_after`，数据库幂等性兜底
- `issue-comment-poller.ts` (`IssueCommentWatcher`)：
  - 轮询 `active` / `pending` 状态的 task
  - 按 `last_note_id` 水位线过滤新评论
  - 过滤自身评论避免死循环
- `watcher/index.ts`：wire up + `shutdown()` 清理 + 启动日志
- 行为特性：
  - `issueWatcher.enabled=false` 时零开销，不启动 poller
  - 项目 ID 解析失败不阻塞其他项目
  - Claude 子进程超时/异常均不打穿主进程，错误写入 `issue_tasks.last_error`

### Slice 3 — 闭环产出 ✅（已交付）

- `issue-finalizer.ts`：
  - `finalizeIteration(deps, task, match, claudeSummary)` — 每次 Claude 跑完后调用：
    1. `git status --porcelain` 检测未提交改动 → `git add -A && git commit` 带 issue 上下文
    2. `git rev-list --count <remote>/<branch>..HEAD` 检测是否需要 push
    3. 若分支 `origin/<targetBranch>..HEAD > 0` 且无 MR → `createMergeRequest` 带 `Closes #{iid}` 和 Issue 链接；已有 open MR 则复用
    4. 返回富文本 suffix，追加到当次的 issue 评论（显示提交 hash、文件清单、MR 链接）
  - `reconcileTaskState(deps, task, match)` — 每次评论 poll 前调用：
    - MR merged → 标 `done` + 清理 worktree
    - MR closed → 标 `stalled`（保留 worktree 给人工检查）
    - Issue closed（无 MR） → 标 `closed` + 清理 worktree
- `issue-orchestrator.ts`：
  - initial iteration 的 worktree base 改为 `gitlab.defaultTargetBranch`（与 auto-fix 对齐）
  - initial / resume 收到 Claude 结果后都调 `finalizeIteration`
  - 评论正文 = Claude 输出 + finalize suffix（提交/MR 状态）
- `issue-comment-poller.ts`：
  - 轮询前先 `reconcileTaskState`，terminal 的 task 本轮跳过
  - 状态过滤扩展到 `active` / `pending` / `wip`

**终态状态机**：
```
pending ─▶ active ─▶ wip ─▶ done       (MR merged)
   │         │        └───▶ stalled    (MR closed without merge)
   └─────────┴────────────▶ closed     (issue closed, no MR)
                           ─▶ failed   (codeRoot 解析失败 / Claude 初次启动异常)
                           ─▶ stalled  (iteration_count ≥ maxIterations)
```

**安全护栏**：
- MR 只在"分支领先目标分支 ≥ 1 commit"时才建，避免空 MR
- worktree 清理通过 `gitOps.removeWorktree --force` 走 git 官方路径，不走文件系统直删
- `assertWorktree` 继续双保险，禁止 Spirit 在主仓库分支上 commit/push

## 7. 安全与风险

| 风险 | 缓解 |
|------|------|
| Claude `--dangerously-skip-permissions` 被滥用 | `--add-dir` 限定写入范围为 worktree；git-ops `assertWorktree` 拒绝主仓库写入 |
| 子进程僵死 | 30 min 硬超时 + SIGTERM 清理 |
| 评论风暴（Claude 刷屏） | 每次 iteration 限制一条评论，超长 `result` 截断 + 附件链接 |
| Issue 被无权限用户滥用 | 仅响应 `assignee` 或 `author` 评论（可配） |
| 代码被 Claude 误删主分支文件 | worktree 隔离 + feature 分支 + MR review 强制 |
| Token 成本爆炸 | `--max-budget-usd` CLI 层限制；单 task 迭代次数上限（config `maxIterations`，默认 20） |

## 8. 后续工作（非本迭代）

- Webhook 模式（若部署到公网 server）
- GitLab Task（子任务）层级支持
- 多语言 slug（中文拼音）
- 并发配额独立于 auto-fix

---

## 变更日志

| 日期 | Slice | 内容 |
|------|-------|------|
| 2026-04-17 | S1 | 设计文档初版；config schema；issue-task-store；gitlab-api issue 扩展；claude-code-runner |
| 2026-04-17 | S2 | issue-orchestrator（handleNewIssue / handleNewComments / taskLocks / maxIterations 保护 / Spirit 评论水印）；IssueWatcher；IssueCommentWatcher；wired into watcher/index.ts 且 feature-flag 控制 |
| 2026-04-17 | S3 | issue-finalizer（finalizeIteration 自动 commit+push+建 MR；reconcileTaskState MR merged/closed + issue closed 清理）；worktree base 切换到 defaultTargetBranch；状态机扩展到 wip/done/closed/stalled；评论附提交/MR 状态 suffix |
| 2026-04-17 | S4 | **架构重构**：废弃 claude CLI 子进程方案，改用 Anthropic SDK agent-loop（issue-agent.ts）；工具集 read_file/write_file/list_files/run_command/search_code；messages 持久化到 issue_tasks.agent_messages 支持 resume；issue-task-store 加 migration；orchestrator 切换到 runIssueAgent |
| 2026-04-17 | S5 | **工具抽离解耦**：创建 shared/agent-tools.ts 公共模块，getAgentTools() + executeAgentTool()；analyzer.ts 和 issue-agent.ts 都改用公共模块；工具集扩展到 search_logs + query_database；与 mcp/tools 完全解耦，纯函数实现 |
