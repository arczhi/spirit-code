# Spirit PR 评论自动修复功能

## 功能说明

Spirit 现在支持监听 GitLab MR 评论，当开发者在 MR 上留下评论指出问题时，Spirit 会：

1. **自动读取评论内容** - 识别人工评论（排除机器人和系统评论）
2. **分析代码上下文** - 读取 MR 中修改的文件完整内容
3. **调用 Claude 生成修复方案** - 理解评论要求并生成代码修复
4. **本地验证** - 执行 `go vet`、`go build`（Go 项目）或 `tsc`（Node 项目）
5. **自动提交并推送** - 验证通过后提交新 commit 到原分支

## 工作流程

```
开发者在 MR 上评论
    │
    ▼
Spirit MR Comment Poller 检测到新评论（每 60 秒轮询）
    │
    ▼
读取评论内容 + MR 变更文件
    │
    ▼
调用 Claude API 分析并生成修复方案
    │
    ▼
在 worktree 中应用修复
    │
    ▼
本地验证（go vet / go build / tsc）
    │
    ├─ 失败 → 重试一次（让 Claude 修复构建错误）
    │
    └─ 成功 → 提交并推送到原分支
```

## 配置

### 1. 更新 config.yaml

在 `watcher` 配置中添加 `mrCommentPollingInterval`（可选，默认 60 秒）：

```yaml
watcher:
  esPollingInterval: 30
  dedupeWindow: 3600
  maxConcurrentFixes: 3
  riskAutoFix: ["A", "B"]
  mrCommentPollingInterval: 60  # MR 评论轮询间隔（秒）
```

### 2. 启动 Watcher

```bash
cd spirit
npm run watcher
```

Watcher 会同时启动：
- ES 日志轮询
- 本地日志文件监听
- **MR 评论轮询**（新增）

## 使用示例

### 场景 1：修复 import 错误

**开发者在 MR 上评论：**
```
这个文件导入了 `mobgi_ai_backend/internal/integration` 但没有使用，
导致 go vet 报错。请删除这个 import。
```

**Spirit 自动处理：**
1. 检测到评论
2. 读取 `internal/workerjobs/job_video.go` 完整内容
3. Claude 分析：需要删除第 11 行的 unused import
4. 生成修复方案：删除 `"mobgi_ai_backend/internal/integration"`
5. 应用修复并验证：`go vet ./...` 通过
6. 提交：`fix(spirit): address review feedback`
7. 推送到原分支

### 场景 2：修复逻辑错误

**开发者在 MR 上评论：**
```
这里的条件判断有问题，应该是 `if err != nil` 而不是 `if err == nil`
```

**Spirit 自动处理：**
1. 读取评论和相关代码
2. Claude 定位到错误的条件判断
3. 生成修复：将 `if err == nil` 改为 `if err != nil`
4. 验证通过后提交推送

## 评论格式建议

为了让 Spirit 更好地理解你的意图，建议评论格式：

### ✅ 好的评论格式

```
文件 internal/workerjobs/job_video.go 第 11 行：
导入了 "mobgi_ai_backend/internal/integration" 但未使用，
请删除这个 import。
```

```
这个函数缺少错误处理，建议在调用 processVideo() 后检查 err。
```

```
变量名 `tmp` 不够清晰，建议改为 `videoMetadata`。
```

### ❌ 不好的评论格式

```
有问题
```

```
改一下
```

```
不对
```

## 跳过自动修复

如果某个评论不需要 Spirit 自动修复，可以在评论中添加 `[skip-spirit]` 标记：

```
[skip-spirit] 这个问题需要人工处理，涉及业务逻辑调整。
```

## 监控和日志

### 查看 Watcher 日志

```bash
# 实时查看日志
tail -f spirit-watcher.log

# 搜索 MR 评论处理日志
grep "MR comment" spirit-watcher.log
```

### 日志示例

```
2026-04-16 14:30:15 INFO MR Comment Poller starting (interval: 60s)
2026-04-16 14:31:20 INFO New comment detected on MR !123 from alex: 删除 unused import
2026-04-16 14:31:21 INFO Processing MR comment for incident abc12345, MR !123
2026-04-16 14:31:25 INFO Calling Claude for analysis (prompt size: 5432 chars)
2026-04-16 14:31:30 INFO Applied search-replace to internal/workerjobs/job_video.go
2026-04-16 14:31:32 INFO go vet: PASS
2026-04-16 14:31:35 INFO go build: PASS
2026-04-16 14:31:36 INFO Pushed review fix for MR !123
```

## 数据库表

Spirit 会创建 `mr_comment_state` 表来跟踪已处理的评论：

```sql
CREATE TABLE mr_comment_state (
  mr_iid INTEGER PRIMARY KEY,
  last_note_id INTEGER NOT NULL,
  last_checked TEXT NOT NULL
);
```

这样可以避免重复处理同一条评论。

## 故障排查

### 问题 1：Spirit 没有响应评论

**检查：**
1. Watcher 是否正在运行：`ps aux | grep watcher`
2. 配置文件中 GitLab token 是否有效
3. 查看日志是否有错误：`tail -f spirit-watcher.log`

### 问题 2：修复后仍然有构建错误

**原因：**
- Claude 可能没有完全理解问题
- 代码上下文不足

**解决：**
1. 在评论中提供更详细的说明
2. 指出具体的文件名和行号
3. 如果 Spirit 连续失败，会停止自动修复，需要人工介入

### 问题 3：轮询间隔太长

**调整：**
在 `config.yaml` 中减小 `mrCommentPollingInterval`：

```yaml
watcher:
  mrCommentPollingInterval: 30  # 改为 30 秒
```

重启 Watcher 生效。

## 与 Webhook 方案对比

| 特性 | MR Comment Poller（当前方案） | Webhook 方案 |
|------|------------------------------|-------------|
| 部署复杂度 | 低（只需运行 Watcher） | 中（需要配置 GitLab Webhook） |
| 响应速度 | 轮询间隔（默认 60 秒） | 实时（秒级） |
| 服务器要求 | 无需公网 IP | 需要 GitLab 能访问的地址 |
| 适用场景 | 内网环境、开发测试 | 生产环境、高频 MR |

## 未来改进

- [ ] 支持 Webhook 触发（实时响应）
- [ ] 支持多轮对话（在评论中继续讨论）
- [ ] 支持评论中的代码建议（GitHub Copilot 风格）
- [ ] 支持批量处理多个评论
- [ ] 集成 CI/CD 状态检查

## 相关文件

- `src/watcher/mr-comment-poller.ts` - MR 评论轮询器
- `src/watcher/auto-fix.ts` - 自动修复逻辑（包含 `handleMrReview` 函数）
- `src/watcher/index.ts` - Watcher 主入口
- `src/shared/gitlab-api.ts` - GitLab API 封装
