# Spirit 精灵 — 设计文档

> 日期：2026-04-16（初版），2026-04-17（新增 Issue 驱动开发能力）
> 项目：Spirit（精灵）— AI 驱动的日志监控与自动修复 MCP 平台
> 位置：/Users/alex/test/shell/spirit/
> 状态：v0.1.0 实现完成；v0.2.0 GitLab Issue 驱动开发（建设中，见 [gitlab-issue-driven-dev.md](./gitlab-issue-driven-dev.md)）

## 1. 项目定位

Spirit 是一个独立的 TypeScript 项目，提供三个核心能力：

1. **MCP Server** — 暴露 18 个 tools，供 Claude Code / IDE 调用，覆盖日志读取、代码分析、incident 管理、git 操作、GitLab MR 创建
2. **Log Watcher 服务** — 长驻后台进程，轮询 ES + 监听本地日志文件，发现错误后自动调用 Claude API 分析，通过 git worktree 隔离开发，自动提交 MR 到 GitLab
3. **Issue Watcher 服务**（v0.2.0 建设中）— 监听 GitLab Issue（带 `ai-dev` 标签），自动拉起本地 Claude Code 实例在 worktree 中开发，让开发者通过 Issue 评论与 AI 对话。详见 [gitlab-issue-driven-dev.md](./gitlab-issue-driven-dev.md)

Spirit 不依赖 debugpilot 后端，直连 Elasticsearch、文件系统、Git、GitLab API。

## 2. 关键决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| 与 debugpilot 的关系 | 完全独立项目，同级目录 | 零耦合，独立演进 |
| 开发语言 | TypeScript | MCP SDK 官方支持最好，开发迭代快 |
| 日志数据源 | ES 轮询 + 本地日志文件监听 | 双保险，ES 为主，本地文件为补充 |
| GitLab 交互 | REST API 自动创建 MR | 真正闭环，MR 自动填充分析结论 |
| 架构模式 | MCP Server + 独立 Watcher 双进程 | stdio MCP 不适合跑后台任务，职责分离 |
| Incident 存储 | 本地 SQLite | 轻量，不依赖外部数据库 |

## 3. 项目结构

```
spirit/
├── package.json
├── tsconfig.json
├── config.example.yaml        # 配置模板（不含敏感信息）
├── config.local.yaml          # 本地配置（.gitignore）
├── docs/
│   └── design.md              # 本文档
├── src/
│   ├── mcp/                   # MCP Server
│   │   ├── index.ts           # stdio 启动入口
│   │   └── tools/             # 每个 tool 一个文件
│   │       ├── search-logs.ts
│   │       ├── query-database.ts
│   │       ├── read-file.ts
│   │       ├── search-code.ts
│   │       ├── list-files.ts
│   │       ├── list-incidents.ts
│   │       ├── get-incident.ts
│   │       ├── ack-incident.ts
│   │       ├── resolve-incident.ts
│   │       ├── create-branch.ts
│   │       ├── manage-worktree.ts
│   │       ├── apply-patch.ts
│   │       ├── commit-changes.ts
│   │       ├── push-branch.ts
│   │       ├── create-mr.ts
│   │       ├── get-mr-status.ts
│   │       ├── run-ci.ts
│   │       └── get-ci-status.ts
│   ├── watcher/               # Log Watcher 长驻服务
│   │   ├── index.ts           # Watcher 启动入口
│   │   ├── es-poller.ts       # ES 轮询器
│   │   ├── file-watcher.ts    # 本地日志文件监听（chokidar）
│   │   ├── analyzer.ts        # 调用 Claude API 分析错误
│   │   └── auto-fix.ts        # worktree + 修复 + 提 MR 流程
│   └── shared/                # 共享模块
│       ├── config.ts          # 配置加载（yaml）
│       ├── es-client.ts       # Elasticsearch 客户端
│       ├── git-ops.ts         # git 操作封装（simple-git）
│       ├── gitlab-api.ts      # GitLab REST API 封装
│       ├── incident-store.ts  # Incident SQLite 存储
│       ├── fingerprint.ts     # 错误指纹生成
│       └── logger.ts          # 日志工具
└── data/                      # 运行时数据（.gitignore）
    └── incidents.db           # SQLite 数据库
```

两个入口：
- `npx tsx src/mcp/index.ts` — MCP Server（stdio 模式，被 IDE 调用）
- `npx tsx src/watcher/index.ts` — Watcher 服务（长驻后台）

## 4. MCP Tools 清单

### 4.1 读取面（5 个）

| Tool | 描述 | 关键参数 |
|------|------|----------|
| `search_logs` | 查询 ES 日志 | `env`, `keyword`, `level`, `timeRange`, `index` |
| `query_database` | 执行 SQL（生产只读） | `connectionString`, `sql`, `readonly` |
| `read_file` | 读取源码文件 | `filePath`, `startLine?`, `endLine?` |
| `search_code` | 正则搜索代码 | `pattern`, `codePath`, `filePattern?` |
| `list_files` | 浏览目录结构 | `dirPath`, `recursive?` |

### 4.2 Incident 面（4 个）

| Tool | 描述 | 关键参数 |
|------|------|----------|
| `list_incidents` | 列出最近 incident | `env?`, `status?`, `limit?` |
| `get_incident` | 获取 incident 完整上下文 | `incidentId` |
| `ack_incident` | 标记处理中 | `incidentId` |
| `resolve_incident` | 关联修复分支/MR 并关闭 | `incidentId`, `mrUrl?`, `branch?` |

### 4.3 Git 执行面（7 个）

| Tool | 描述 | 关键参数 |
|------|------|----------|
| `create_branch` | 基于主分支创建修复分支 | `repoPath`, `branchName`, `baseBranch?` |
| `manage_worktree` | 创建/删除 git worktree | `repoPath`, `action`, `branchName` |
| `apply_patch` | 在 worktree 中写入修改 | `worktreePath`, `filePath`, `content` |
| `commit_changes` | 提交变更 | `worktreePath`, `message` |
| `push_branch` | 推送到远程 | `worktreePath`, `remote?` |
| `create_mr` | 调用 GitLab API 创建 MR | `projectPath`, `sourceBranch`, `targetBranch`, `title`, `description` |
| `get_mr_status` | 查询 MR 状态 | `projectPath`, `mrIid` |

### 4.4 验证面（2 个）

| Tool | 描述 | 关键参数 |
|------|------|----------|
| `run_ci` | 触发 GitLab CI pipeline | `projectPath`, `ref` |
| `get_ci_status` | 查询 pipeline 状态 | `projectPath`, `pipelineId` |

## 5. Watcher 工作流

```
ES Poller (30s) + File Watcher (chokidar)
         │
         ▼
  错误聚类 & 去重（fingerprint，1h 窗口）
         │
         ▼ 新错误
  创建 Incident → SQLite
         │
         ▼
  Claude API 分析（带日志 + 代码上下文）
  → 输出：诊断结论、风险等级(A/B/C)、修复方案
         │
         ▼
    风险分级判断
    ├── A/B 类：可自动修复
    │     │
    │     ▼
    │   创建 worktree（spirit/fix-{id}-{ts}）
    │   应用修复代码
    │   commit + push
    │   创建 GitLab MR（自动填充分析结论）
    │   更新 incident 状态 → fixing/resolved
    │
    └── C 类：仅记录分析结论，不修复
```

关键参数：
- 错误去重：`error_message + stack_trace_top_frame` → SHA256 fingerprint
- 去重窗口：1 小时（可配置）
- 并发控制：最多 3 个修复任务同时进行
- 分支命名：`spirit/fix-{incident_id}-{timestamp}`
- MR 描述：包含 incident 信息、错误日志摘要、Claude 分析结论、修复说明

## 6. 风险分级

| 等级 | 允许操作 | 示例 |
|------|----------|------|
| A | 自动改代码 + 自动提 MR | 类型错误、空指针、日志格式、配置读取 |
| B | 自动改代码 + 提 MR（需人工审核） | 限流逻辑、任务状态机、队列处理 |
| C | 仅分析和记录，不自动提交 | 认证授权、数据删除、安全边界、DB migration |

## 7. 配置模型

见 `config.example.yaml`，关键配置项：

- `environments[]` — 多环境支持，每个环境包含 ES 配置、本地日志路径、数据库连接列表、多代码根
- `environments[].databases[]` — 每个环境可配多个数据库连接（name, driverType, host, port, username, password, dbName, readonly）
- `gitlab` — GitLab URL + Token
- `claude` — API Key + Base URL + Model
- `watcher` — 轮询间隔、去重窗口、并发数、允许自动修复的风险等级
- `storage` — SQLite 路径

敏感信息通过 `config.local.yaml`（已 gitignore）管理。

## 8. Incident 数据模型

```sql
CREATE TABLE incidents (
  id              TEXT PRIMARY KEY,
  fingerprint     TEXT NOT NULL,
  title           TEXT NOT NULL,
  env             TEXT NOT NULL,
  service         TEXT NOT NULL,
  level           TEXT NOT NULL,
  count           INTEGER DEFAULT 1,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  sample_logs     TEXT,              -- JSON array, max 5
  trace_ids       TEXT,              -- JSON array
  suspected_files TEXT,              -- JSON array
  risk_level      TEXT,              -- A / B / C
  analysis        TEXT,              -- Claude 分析结论
  fix_plan        TEXT,              -- Claude 修复方案
  status          TEXT DEFAULT 'open',
  branch          TEXT,
  mr_url          TEXT,
  mr_iid          INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

生命周期：`open` → `ack` → `fixing` → `resolved` / `wontfix`

## 9. 技术栈

| 依赖 | 用途 |
|------|------|
| `@modelcontextprotocol/sdk` | MCP 协议实现 |
| `@elastic/elasticsearch` | ES 查询 |
| `simple-git` | Git 操作 |
| `chokidar` | 文件监听 |
| `@anthropic-ai/sdk` | Claude API |
| `better-sqlite3` | SQLite 存储 |
| `yaml` | 配置解析 |
| `node-cron` | 定时任务 |
| `tsx` | TypeScript 直接运行 |

## 10. 实施顺序

1. 项目初始化（package.json, tsconfig, 配置加载）
2. shared 模块（config, es-client, git-ops, gitlab-api, incident-store, fingerprint, logger）
3. MCP Server + 读取面 tools（5 个）
4. Incident 面 tools（4 个）
5. Git 执行面 tools（7 个）
6. 验证面 tools（2 个）
7. Watcher 服务（es-poller, file-watcher, analyzer, auto-fix）
8. 集成测试 & 端到端验证
