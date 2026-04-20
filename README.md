# Spirit 精灵

Spirit 是一个把观测、分析、改码、提 MR 串成闭环的 AI 工作流。

设计思路和提示词，请参考仓库：https://github.com/arczhi/spirit

它现在有三条主线：

- 日志驱动：监听 Elasticsearch 和本地日志，聚合错误，分析根因，低风险自动修复并提交 GitLab MR
- Issue 驱动：轮询带指定标签的 GitLab Issue，在独立 worktree 里让 Claude 开发、提交、推 MR
- 自监控：Spirit 自己的 watcher 出现阻塞错误时，尝试分析并自修复

设计思路不是“给现有流程加个 Copilot”，而是把系统拆成可观测、可执行、可验证、可审计的自动化链路。

## 当前实现

- MCP Server：通过 stdio 暴露 18 个工具，覆盖日志、代码、数据库、incident、git、CI
- Watcher：同时轮询 ES 和监听文件日志，按 fingerprint 去重，并结合语义去重减少重复告警
- Analyzer：调用 Claude 输出结构化诊断、风险等级和 fix plan
- Auto Fix：在 git worktree 中改代码、本地校验、提交、推送，并创建 per-incident MR
- MR 评论回修：轮询 Spirit 创建的 MR，发现新的人工评论后继续修复同一分支
- Issue 工作流：轮询带标签的 Issue，创建独立 worktree，持久化 agent 对话，支持评论驱动多轮迭代
- 状态存储：使用 SQLite 保存 incidents、issue_tasks 和评论水位线

## 快速开始

安装依赖：

```bash
npm install
```

复制配置：

```bash
cp config.example.yaml config.local.yaml
```

至少需要补齐这些配置：

- `environments[].elasticsearch`
- `environments[].codeRoots`
- `gitlab.url` / `gitlab.token`
- `claude.apiKey` / `claude.baseUrl` / `claude.model`
- `storage.path`

## 运行方式

启动 MCP Server：

```bash
npm run mcp
```

在 Claude Code / IDE 中可按下面方式接入：

```json
{
  "mcpServers": {
    "spirit": {
      "command": "npx",
      "args": ["tsx", "/path/to/spirit/src/mcp/index.ts"]
    }
  }
}
```

启动主 watcher：

```bash
npm run watcher
```

启动自监控模式：

```bash
npm run self-monitor
```

常用检查命令：

```bash
npm run typecheck
npm test
```

## 工作流

日志告警流：

```text
ES / File Log
  -> fingerprint / semantic dedupe
  -> Claude analysis
  -> risk gate
  -> worktree fix
  -> local verification
  -> GitLab MR
```

Issue 开发流：

```text
GitLab Issue(label)
  -> task record in SQLite
  -> dedicated worktree + feature branch
  -> Claude tool-use loop
  -> commit / push / MR
  -> issue comments resume the same task
```

## 配置重点

- `environments[]` 把日志源、数据库和代码仓库绑定到同一个环境模型
- `watcher.riskAutoFix` 控制哪些风险等级允许进入自动修复
- `watcher.issueWatcher.*` 控制 issue 轮询、评论轮询、最大迭代次数和优先环境
- `gitlab.defaultTargetBranch` 决定 auto-fix 和 issue MR 的默认目标分支

完整字段见 `config.example.yaml`。
