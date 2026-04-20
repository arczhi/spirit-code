# Spirit 工作流构建 Prompt

> 目标读者：想构建类似"日志监控 → AI 自动修复 → GitLab MR"、"编写issue -> AI 自动开发 -> GitLab MR"工作流的开发者。
> 本文提炼自 Spirit 项目的落地实践，可直接作为 prompt 喂给 AI 来生成类似系统。

---

## 一、用一句话描述这个系统

**监听生产/测试环境错误日志 → Claude 分析根因 → 在隔离 worktree 里自动修复代码 → 推送分支 → 创建 GitLab MR → 开发者只需 review 和 merge。**

同时支持第二条路径：**开发者在 GitLab Issue 上写需求 → Claude 在 worktree 里实现 → 通过 Issue 评论对话迭代 → 自动提 MR。**

---

## 二、核心架构 Prompt

```
请帮我构建一个 AI 驱动的自动修复工作流系统，包含以下三层：

1. MCP Server 层（供 Claude Code IDE 调用）
   - 提供 read 工具：搜索日志、查询数据库、读取代码文件、grep 搜索
   - 提供 incident 工具：列出/获取/确认/解决告警
   - 提供 git 执行工具：创建分支、管理 worktree、应用补丁、提交、推送、创建 MR
   - 提供 CI 工具：触发流水线、查询状态
   - 通过 stdio 协议暴露，配置到 .mcp.json

2. Log Watcher 层（长驻后台进程）
   - 每 30s 轮询 Elasticsearch 错误日志
   - 同时用 chokidar 监听本地日志文件变化
   - 对新错误做指纹去重（1h 窗口）+ LLM 语义去重
   - 调用 Claude API 分析根因，输出风险等级 A/B/C
   - A/B 类自动进入修复流程，C 类仅记录

3. Issue Watcher 层（可选，GitLab Issue 驱动开发）
   - 每 30s 轮询带 ai-dev 标签的 GitLab Issue
   - 为每个 Issue 创建独立 worktree + feature 分支
   - 用 Anthropic SDK tool-use loop 执行开发任务
   - 每 60s 轮询 Issue 评论，支持多轮对话迭代
   - 自动 commit + push + 创建 MR，MR merge 后关闭 Issue

技术栈：TypeScript + Node.js，SQLite 存储状态，simple-git 操作 git，@anthropic-ai/sdk 调用 Claude。
```

---

## 二.五、Spirit MCP 工具清单（18 个工具）

Spirit 通过 MCP Server 暴露 18 个工具，分为 5 类：

### 读取面（5 个工具）

| 工具 | 用途 | 关键参数 |
|------|------|---------|
| `search_logs` | 搜索 Elasticsearch 日志 | env, keyword, level, timeFrom, timeTo, size |
| `query_database` | 查询 MySQL/PostgreSQL | env, dbName, sql, readonly |
| `read_file` | 读取代码文件（支持行范围） | filePath, startLine, endLine |
| `search_code` | grep 代码搜索 | pattern, codePath, filePattern, maxResults |
| `list_files` | 列出目录文件 | dirPath, recursive |

### Incident 面（4 个工具）

| 工具 | 用途 | 关键参数 |
|------|------|---------|
| `list_incidents` | 列出最近 incident | env, status, limit |
| `get_incident` | 获取 incident 详情 | incidentId |
| `ack_incident` | 确认 incident（标记为处理中） | incidentId |
| `resolve_incident` | 解决 incident（关联修复分支/MR） | incidentId, branch, mrUrl |

### Git 执行面（7 个工具）

| 工具 | 用途 | 关键参数 |
|------|------|---------|
| `create_branch` | 创建新分支 | repoPath, branchName, baseBranch |
| `manage_worktree` | 创建/删除 worktree | repoPath, action, branchName, worktreePath |
| `apply_patch` | 应用代码补丁（写入文件） | worktreePath, filePath, content |
| `commit_changes` | 提交改动（git add -A + commit） | worktreePath, message |
| `push_branch` | 推送分支到远端 | worktreePath, remote |
| `create_mr` | 创建 GitLab MR | projectPath, sourceBranch, targetBranch, title, description |
| `get_mr_status` | 查询 MR 状态 | projectPath, mrIid |

### CI 面（2 个工具）

| 工具 | 用途 | 关键参数 |
|------|------|---------|
| `run_ci` | 触发 GitLab CI 流水线 | projectPath, ref |
| `get_ci_status` | 查询流水线状态 | projectPath, pipelineId |

**使用示例**：
```typescript
// 1. 搜索错误日志
await search_logs({ env: "production", keyword: "NullPointerException", level: "ERROR" })

// 2. 读取相关代码
await read_file({ filePath: "/workspace/backend/handler.go", startLine: 100, endLine: 150 })

// 3. 创建修复分支
await create_branch({ repoPath: "/workspace/backend", branchName: "fix-null-pointer" })

// 4. 应用修复
await apply_patch({ worktreePath: ".worktrees/spirit/auto-fix", filePath: "handler.go", content: "..." })

// 5. 提交并推送
await commit_changes({ worktreePath: ".worktrees/spirit/auto-fix", message: "[Spirit] Fix null pointer" })
await push_branch({ worktreePath: ".worktrees/spirit/auto-fix" })

// 6. 创建 MR
await create_mr({ 
  projectPath: "group/backend", 
  sourceBranch: "fix-null-pointer",
  title: "[Spirit] Fix null pointer in handler",
  description: "Auto-generated fix for incident #123"
})
```

---

## 三、关键设计决策（逐条可复用）

### 3.1 错误指纹去重

**问题**：同一个 bug 在 30s 内可能产生几百条日志，不能每条都触发分析。

**方案**：
```
生成指纹的规则：
1. 对 error message 做规范化：
   - 移除 UUID、timestamp、trace ID、IP 地址
   - 移除 URL 中的动态参数
   - 移除 JSON payload 和 hex string
   - 保留错误类型名称和堆栈顶部 3 帧
2. 对规范化后的字符串取 SHA256
3. 相同指纹在 1h 窗口内只处理一次
4. 不确定是否相同时，用 LLM 做语义判断（30s 超时，超时则视为不同）
```

### 3.2 风险分级与自动化边界

**核心原则**：AI 只在低风险区域全自动，高风险区域只分析不动手。

```
风险等级定义：
- A 级（自动修复 + 自动提 MR）：类型错误、空指针、日志格式、配置项缺失
- B 级（自动修复 + 提 MR，需人工 review）：限流逻辑、状态机、队列处理、业务规则
- C 级（仅分析记录，不修复）：认证授权、数据删除、DB migration、权限变更

让 Claude 在分析时输出 riskLevel 字段，watcher 根据此字段决定是否进入修复流程。
```

### 3.3 Worktree 隔离策略

**问题**：多个 incident 并发修复时，不能互相污染代码。

**方案**：
```
Auto-fix 路径（多个 incident 共享一个 worktree）：
- 路径：.worktrees/spirit/auto-fix
- 分支：spirit/auto-fix（每次修复前 reset 到 origin/main）
- 修复完成后 cherry-pick 到 per-incident 分支 spirit/fix-{id}
- 每个 incident 独立提 MR

Issue 开发路径（每个 Issue 独占一个 worktree）：
- 路径：.worktrees/spirit-issue/{issue_iid}/
- 分支：feature/YYYYMMDD_{slug}
- Issue 之间完全隔离，不共享 commit

安全护栏：
- 所有 git 操作前 assertWorktree()，拒绝在主仓库分支上 commit/push
- worktree 清理走 git worktree remove --force，不直接删文件系统
```

### 3.4 Claude API 调用模式

**分析场景**（单次调用，结构化输出）：
```typescript
// 分析错误时，给 Claude 提供：
// 1. 错误日志（message + stackTrace）
// 2. 从堆栈提取的相关代码文件内容（限制 80KB）
// 3. 要求输出 JSON：{ diagnosis, riskLevel, suspectedFiles, fixPlan }
// fixPlan 格式：[{ filePath, description, oldContent, newContent }]

// 重试策略：最多 10 次，延迟序列 [5s, 15s, 30s, 60s, 90s, 120s, 150s, 180s, 210s]
// 触发重试：429 / 503 / 529 / overloaded_error / rate_limit_error
```

**Issue 开发场景**（tool-use loop，多轮对话）：
```typescript
// 使用 Anthropic SDK 的 tool-use 模式，不依赖 Claude Code CLI
// 工具集：read_file, write_file, list_files, run_command, search_code
// 最多 100 轮 tool 调用
// 对话历史序列化为 JSON 存入数据库，支持跨进程 resume
// 安全限制：
//   - 文件操作在 tool 层校验路径，拒绝 worktree 外的读写
//   - run_command 拦截 git checkout/switch/worktree 等危险命令
//   - 单次 API 调用超时 120s
```

### 3.5 本地验证（修复后自动构建检查）

```
修复代码后，在 worktree 内执行：
1. go vet ./...（Go 项目）或 tsc --noEmit（TypeScript 项目）
2. go build ./...（Go 项目）或 npm run build（Node 项目）
3. 若失败，将构建错误反馈给 Claude，最多重试 2 次
4. 验证通过后才 commit + push
```

### 3.6 MR 评论自动响应

```
每 60s 轮询所有 status=resolved 且有 mr_iid 的 incident：
1. 获取 MR 的所有 note
2. 过滤系统评论和机器人评论
3. 与 last_note_id 水位线比较，找出新的人工评论
4. 将评论内容 + MR 变更文件 → Claude 分析 → 生成修复
5. 修复后 commit + push 到同一分支（MR 自动更新）
6. 更新 last_note_id 水位线
```

### 3.7 Issue 评论防死循环

```
Spirit 自己发的评论需要打水印，避免被自己的 poller 重复处理：
- 评论末尾加 HTML 注释：<!-- spirit-issue-bot -->
- poller 过滤时跳过包含此水印的评论
- 同时过滤 author.bot = true 的系统评论
```

### 3.8 并发控制

```
- maxConcurrentFixes（默认 3）：同时进行的修复任务上限
- 同一 codeRoot 的修复串行执行（worktree 锁）
- 每个 issue task 有独立的互斥锁，防止 initial 和 resume 并发
- Issue 开发与 auto-fix 共享并发配额
```

---

## 四、数据模型

### incidents 表（被动发现的告警）

```sql
CREATE TABLE incidents (
  id              TEXT PRIMARY KEY,
  fingerprint     TEXT NOT NULL,
  title           TEXT NOT NULL,
  env             TEXT NOT NULL,
  service         TEXT,
  error_message   TEXT NOT NULL,
  stack_trace     TEXT,
  count           INTEGER DEFAULT 1,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  status          TEXT DEFAULT 'open',  -- open/ack/fixing/resolved/wontfix
  risk_level      TEXT,                 -- A/B/C
  analysis        TEXT,                 -- JSON: diagnosis + fixPlan
  suspected_files TEXT,                 -- JSON array
  branch          TEXT,
  mr_url          TEXT,
  mr_iid          INTEGER,
  last_note_id    INTEGER DEFAULT 0
);
```

### issue_tasks 表（主动认领的需求）

```sql
CREATE TABLE issue_tasks (
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
  agent_messages      TEXT,             -- JSON: 完整对话历史，支持 resume
  mr_iid              INTEGER,
  mr_url              TEXT,
  status              TEXT DEFAULT 'pending',  -- pending/active/wip/done/closed/failed/stalled
  last_note_id        INTEGER DEFAULT 0,
  iteration_count     INTEGER DEFAULT 0,
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(gitlab_project_id, issue_iid)
);
```

**issue_tasks 状态机**：
```
pending → active → wip → done      (MR merged，自动关闭 Issue)
   │        │       └──→ stalled   (MR closed without merge)
   └────────┴──────────→ closed    (Issue closed，无 MR)
                        → failed   (codeRoot 未配置 / Claude 初次启动异常)
                        → stalled  (iteration_count ≥ maxIterations)
```

---

## 五、配置结构

```yaml
claude:
  apiKey: "sk-ant-..."
  model: "claude-opus-4-5"
  baseURL: "https://api.anthropic.com"  # 支持代理

gitlab:
  url: "https://gitlab.example.com"
  token: "glpat-..."
  defaultTargetBranch: "test"

environments:
  - name: production
    elasticsearch:
      url: "http://es-prod:9200"
      indices: ["app-logs-*"]
      errorQuery: "level:ERROR"
    logFiles: ["/var/log/app/*.log"]
    codeRoots:
      - path: "/workspace/backend"
        gitlabProjectPath: "group/backend"
        language: "go"
      - path: "/workspace/frontend"
        gitlabProjectPath: "group/frontend"
        language: "typescript"
    databases:
      - name: "main"
        connectionString: "mysql://..."

watcher:
  esPollingInterval: 30000       # ms
  dedupeWindow: 3600             # seconds
  maxConcurrentFixes: 3
  riskAutoFix: ["A", "B"]
  issueWatcher:
    enabled: true
    label: "ai-dev"
    issuePollingInterval: 30000
    commentPollingInterval: 60000
    maxIterations: 20
    preferEnv: "testing"
```

---

## 六、AI 基建分层设计思路

Spirit 的架构体现了"AI-first harness engineering"的核心理念：**不是给现有流程加 Copilot，而是重构流程本身，让 AI 能看见全局、稳定产出**。

### 6.1 四层平台架构

```
┌─────────────────────────────────────────────────────────────┐
│                    治理层（Risk Control）                    │
│  权限边界 | 变更审计 | 风险分级 | 自动关闭/reopen | 环境隔离  │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────┐
│                    执行层（Execution）                       │
│  建分支 | 改代码 | 提交 commit | 推送 | 创建 PR/MR           │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────┐
│                    验证层（Validation）                      │
│  静态检查 | 单测 | 构建 | smoke | E2E | 发布后验证           │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────┐
│                    观测层（Observability）                   │
│  日志 | 健康检查 | 队列状态 | worker 活性 | CI 状态 | 测试产物│
└─────────────────────────────────────────────────────────────┘
```

### 6.2 核心设计原则

#### 原则 1：让 AI 能"看见全局"

**问题**：传统工具链割裂，AI 只能局部试错。

**Spirit 方案**：
- 日志、代码、数据库、CI 状态统一到一个工作空间模型
- 每个 environment 绑定 ES、codeRoots、databases、GitLab 项目
- AI 通过 MCP 工具可以跨层查询：从日志 → 代码 → 数据库 → CI 状态

#### 原则 2：验证先于自动化

**问题**：没有稳定验证基线，自动修复只会放大风险。

**Spirit 方案**：
- 修复后强制本地构建验证（go build / tsc）
- 失败时将构建错误反馈给 Claude，最多重试 2 次
- 验证通过才 commit + push
- 未来扩展：smoke / E2E 门禁

#### 原则 3：结构化 incident 管理

**问题**：日志是非结构化文本，AI 无法稳定复现和闭环。

**Spirit 方案**：
- 错误指纹去重（1h 窗口）+ LLM 语义去重
- incident 数据模型：fingerprint, title, env, service, count, first_seen, last_seen, status, risk_level, analysis, branch, mr_url
- 状态机：open → ack → fixing → resolved → closed
- 支持 incident 与 MR 关联，MR merge 后自动关闭 incident

#### 原则 4：风险分级与自动化边界

**问题**：AI 在所有场景全自动会带来安全风险。

**Spirit 方案**：
- A 级（自动修复 + 自动提 MR）：类型错误、空指针、日志格式
- B 级（自动修复 + 提 MR，需人工 review）：限流逻辑、状态机、队列处理
- C 级（仅分析记录，不修复）：认证授权、数据删除、DB migration

#### 原则 5：Worktree 隔离与并发安全

**问题**：多个 incident 并发修复时，不能互相污染代码。

**Spirit 方案**：
- Auto-fix 路径：共享 worktree `.worktrees/spirit/auto-fix`，每次修复前 reset 到 origin/main，修复后 cherry-pick 到 per-incident 分支
- Issue 开发路径：每个 Issue 独占 worktree `.worktrees/spirit-issue/{issue_iid}/`
- 所有 git 操作前 assertWorktree()，拒绝在主仓库分支上 commit/push

#### 原则 6：对话历史持久化与 resume

**问题**：Issue 开发需要多轮迭代，进程重启不能丢上下文。

**Spirit 方案**：
- 使用 Anthropic SDK tool-use loop，不依赖 Claude Code CLI
- 对话历史（`Anthropic.MessageParam[]`）序列化为 JSON 存入 `issue_tasks.agent_messages`
- 下次迭代时反序列化后追加新 user message 继续对话
- 支持跨进程 resume，不依赖本地 session 文件

### 6.3 为什么这条路线是可行的

Spirit 已经完成了最难的前半段：

1. **观测层已打通**：日志、代码、数据库已经在同一个操作平面
2. **Agent 框架已存在**：聊天代理和工具调用协议已实现
3. **真实业务接入**：生产日志已经进入系统，不是 demo
4. **MCP 标准化**：18 个工具通过 MCP 协议暴露，可被任何 MCP 客户端调用

只需继续往下扩"执行面"和"验证面"，就能形成完整闭环。

### 6.4 与传统 CI/CD 的区别

| 维度 | 传统 CI/CD | Spirit AI 基建 |
|------|-----------|---------------|
| 触发方式 | 人工提交代码 → CI | 日志告警 → AI 分析 → 自动修复 |
| 验证时机 | 代码提交后 | 修复生成后、提交前 |
| 错误处理 | 人工排查 → 人工修复 | AI 分析 → AI 修复 → 人工 review |
| 上下文 | 只看代码变更 | 日志 + 代码 + 数据库 + CI 状态 |
| 闭环 | 需要人工关联 issue 和 PR | 自动关联 incident 和 MR |
| 风险控制 | 依赖人工 review | 风险分级 + worktree 隔离 + 验证门禁 |

### 6.5 实施路线图

**阶段 1：验证基线建设（1-2 周）**
- 后端统一 CI 命令（go vet / go build / go test）
- 前端统一 CI 命令（tsc / npm run build）
- CI 专用 docker-compose
- smoke 脚本（健康检查 / 队列状态 / 核心接口）

**阶段 2：平台升级为验证控制台（2-4 周）**
- incident 数据模型 + 错误聚类去重
- 验证任务面板
- 测试产物回灌
- 多代码根环境模型

**阶段 3：AI 自动修复闭环（4-8 周）**
- Claude 可调用的 monitor / validate / git 工具
- 低风险自动修复流
- PR/MR 机器人账户和审计机制
- 自动关联 incident 与 PR/MR
- 修复完成后二次验证与自动关闭

---

## 七、完整 Prompt（可直接使用）

将以下 prompt 发给 Claude，可生成类似 Spirit 的系统骨架：

```
请帮我构建一个名为 [项目名] 的 AI 驱动自动修复系统。

## 系统目标
监听 [Elasticsearch/本地日志文件] 中的错误日志，用 Claude API 分析根因，
在 git worktree 隔离环境中自动修复代码，推送分支并创建 GitLab MR。

## 技术栈
- TypeScript + Node.js
- @anthropic-ai/sdk（Claude API）
- better-sqlite3（状态存储）
- simple-git（git 操作）
- @elastic/elasticsearch（日志查询）
- chokidar（文件监听）
- zod（配置验证）

## 核心模块

### 1. 错误指纹模块（src/shared/fingerprint.ts）
实现 generateFingerprint(message, stackTrace) → string
规范化规则：移除 UUID/timestamp/IP/URL 参数/JSON payload，保留错误类型和堆栈顶部，取 SHA256。

### 2. 语义去重模块（src/shared/semantic-dedup.ts）
实现 isSameIssue(error1, error2, claudeClient) → boolean
先用文本相似度快速判断，不确定时调用 Claude（30s 超时）。

### 3. 分析模块（src/watcher/analyzer.ts）
实现 analyzeError(errors, codeRootPath, config) → AnalysisResult
- 从堆栈提取文件路径 hint
- grep 关键词找相关代码文件
- 读取文件内容（限制 80KB）
- 调用 Claude，要求输出 { diagnosis, riskLevel, suspectedFiles, fixPlan }
- fixPlan 格式：[{ filePath, description, oldContent, newContent }]
- 重试策略：最多 10 次，指数退避

### 4. 自动修复模块（src/watcher/auto-fix.ts）
实现 autoFix(incident, config) → { success, mrUrl }
- 创建/复用共享 worktree（.worktrees/spirit/auto-fix）
- 应用 fixPlan 中的文件修改
- 本地构建验证（go build 或 tsc）
- commit + push 到 spirit/auto-fix 分支
- cherry-pick 到 per-incident 分支 spirit/fix-{id}
- 创建 GitLab MR

### 5. Issue Agent 模块（src/watcher/issue-agent.ts）
实现 runIssueAgent({ prompt, worktreePath, messages, config }) → IssueAgentResult
- 使用 Anthropic SDK tool-use loop
- 工具集：read_file, write_file, list_files, run_command, search_code
- 路径校验：拒绝 worktree 外的文件操作
- 命令拦截：拒绝 git checkout/switch/worktree
- 最多 100 轮 tool 调用
- 返回 { ok, text, messages }（messages 用于 resume）

### 6. 状态存储（src/shared/incident-store.ts + issue-task-store.ts）
用 SQLite 存储 incidents 和 issue_tasks 两张表（见上方数据模型）。

### 7. MCP Server（src/mcp/index.ts）
通过 stdio 暴露 18 个工具（见上方工具列表），供 Claude Code IDE 调用。

## 关键约束
1. worktree 操作前必须 assertWorktree()，禁止在主仓库分支上 commit
2. 风险等级 C 只分析不修复
3. Issue 评论打水印 <!-- spirit-issue-bot --> 防死循环
4. 对话历史序列化存 DB，支持跨进程 resume
5. 并发修复上限 maxConcurrentFixes，同一 codeRoot 串行

请先输出完整的目录结构，再逐文件实现核心模块。
```

---

## 八、亮点设计总结

| 亮点 | 描述 | 为什么重要 |
|------|------|-----------|
| **双路径架构** | 被动（日志告警）+ 主动（Issue 驱动）两条路径共享基础设施 | 覆盖修复和开发两个场景，复用率高 |
| **Worktree 隔离** | 每次修复在独立 worktree 进行，主仓库不受影响 | 并发安全，失败可回滚，不污染工作区 |
| **指纹 + 语义双重去重** | 先哈希快速去重，再 LLM 语义兜底 | 避免同一 bug 触发几百次分析，节省 token |
| **风险分级自动化边界** | A/B 自动修复，C 只分析 | AI 只在低风险区域全自动，高风险保留人工 |
| **本地构建验证** | 修复后先跑 go build/tsc，失败重试 | 避免提交无法编译的代码 |
| **对话历史持久化** | messages 序列化存 SQLite，支持跨进程 resume | Issue 开发可多轮迭代，进程重启不丢上下文 |
| **MR 评论自动响应** | 轮询 MR 评论，自动处理 reviewer 反馈 | 减少来回沟通，reviewer 评论即触发修复 |
| **水位线去重** | last_note_id 记录已处理评论位置 | 幂等处理，重启不重复，不漏评论 |
| **MCP + Watcher 分离** | MCP Server 供 IDE 交互，Watcher 后台自动运行 | 两种使用模式互不干扰，可独立部署 |
| **配置驱动多环境** | YAML 配置多个 environment，每个有独立 ES/DB/codeRoot | 一套系统同时监控 prod 和 test 环境 |
