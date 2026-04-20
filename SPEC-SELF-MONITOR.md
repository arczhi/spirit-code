# Spec: Spirit Self-Monitor

## Objective

构建一个独立的监控进程，监听 spirit watcher 自身的运行日志和文件日志，当检测到严重的阻塞性错误时自动修复 spirit 的代码。

**用户故事：**
- 作为 spirit 的运维者，当 spirit watcher 崩溃或出现阻塞性错误时，我希望系统能自动诊断并修复代码，无需人工介入
- 作为开发者，我希望 spirit 能"自愈"，利用现有的 watcher 热重载机制自动应用修复

**成功标准：**
- 监控进程能同时监听 spirit 的 stdout/stderr 和文件日志（spirit-YYYYMMDD.log）
- 能识别阻塞性错误（uncaught exception, unhandled rejection, 启动失败, 连续错误）
- 自动调用 Claude 分析错误并生成修复代码
- 修复后依赖现有的 tsx watch 热重载机制自动重启
- 监控进程本身不能影响 spirit 主服务的运行

## Tech Stack

- **Runtime:** Node.js + TypeScript (tsx)
- **Process monitoring:** child_process.spawn + stream parsing
- **File watching:** chokidar (已有依赖)
- **AI analysis:** @anthropic-ai/sdk (已有依赖)
- **Code modification:** 复用 analyzer.ts + claude-code-runner.ts 的逻辑

## Commands

```bash
# 开发模式（spirit watcher + self-monitor）
npm run watcher:dev          # 启动 spirit watcher（已有）
npm run self-monitor         # 启动 self-monitor（新增）

# 生产模式
npm run watcher              # 启动 spirit watcher
npm run self-monitor:prod    # 启动 self-monitor（不输出到文件）

# 测试
npm run test:self-monitor    # 单元测试
```

## Project Structure

```
src/
  self-monitor/
    index.ts              → 主入口，启动监控
    log-monitor.ts        → 日志监听器（stdout/stderr + 文件）
    error-detector.ts     → 错误检测器（识别阻塞性错误）
    self-fixer.ts         → 自修复逻辑（调用 Claude 分析+修复）
  shared/
    logger.ts             → 复用现有 logger
    config.ts             → 扩展配置（新增 selfMonitor 配置）
    claude-code-runner.ts → 复用现有 Claude 调用逻辑
```

## Code Style

**示例代码：**

```typescript
// src/self-monitor/error-detector.ts
export interface BlockingError {
  type: 'uncaught_exception' | 'unhandled_rejection' | 'startup_failure' | 'consecutive_errors';
  message: string;
  stackTrace?: string;
  timestamp: Date;
  context: string[]; // 前后 5 行日志
}

export function detectBlockingError(logLine: string, history: string[]): BlockingError | null {
  // 检测 uncaught exception
  if (logLine.includes('Uncaught') || logLine.includes('UnhandledPromiseRejection')) {
    return {
      type: logLine.includes('Promise') ? 'unhandled_rejection' : 'uncaught_exception',
      message: logLine,
      timestamp: new Date(),
      context: history.slice(-5),
    };
  }
  
  // 检测启动失败（5 秒内连续 ERROR）
  const recentErrors = history.filter(l => 
    l.includes('[ERROR]') && 
    Date.now() - new Date(l.match(/\[(.*?)\]/)?.[1] || 0).getTime() < 5000
  );
  if (recentErrors.length >= 3) {
    return {
      type: 'startup_failure',
      message: 'Multiple errors during startup',
      timestamp: new Date(),
      context: recentErrors,
    };
  }
  
  return null;
}
```

**命名约定：**
- 文件名：kebab-case（log-monitor.ts）
- 类名：PascalCase（LogMonitor）
- 函数名：camelCase（detectBlockingError）
- 常量：UPPER_SNAKE_CASE（MAX_HISTORY_LINES）

## Testing Strategy

**框架：** Vitest（已有）

**测试位置：** `src/self-monitor/__tests__/`

**测试覆盖：**
- `error-detector.test.ts` - 测试各种错误模式的识别
- `log-monitor.test.ts` - 测试日志解析和缓冲逻辑
- `self-fixer.test.ts` - 测试修复流程（mock Claude API）

**覆盖率要求：** 核心逻辑 >80%

## Boundaries

**Always do:**
- 在修复前备份当前代码（git stash 或 commit）
- 记录所有修复尝试到 SQLite（复用 incident-store）
- 限制修复频率（同一错误 5 分钟内只修复一次）
- 验证修复后的代码能通过 typecheck

**Ask first:**
- 修改 spirit 的核心配置文件（config.yaml）
- 删除或重命名现有文件
- 修改数据库 schema

**Never do:**
- 修改 node_modules
- 修改 .git 目录
- 在没有错误时主动修改代码
- 绕过 TypeScript 类型检查

## Configuration

扩展 `config.yaml` 新增 `selfMonitor` 配置：

```yaml
selfMonitor:
  enabled: true
  logFile: "spirit-*.log"  # glob pattern
  maxHistoryLines: 100     # 保留最近 N 行日志用于上下文
  cooldownSeconds: 300     # 同一错误的修复冷却时间
  maxFixAttempts: 3        # 同一错误最多修复次数
  blockingPatterns:        # 阻塞性错误的正则模式
    - "Uncaught"
    - "UnhandledPromiseRejection"
    - "ECONNREFUSED"
    - "Cannot find module"
```

## Success Criteria

1. **监听能力：** 能同时监听 spirit watcher 的 stdout/stderr 和文件日志
2. **错误检测：** 能识别 4 种阻塞性错误类型（uncaught exception, unhandled rejection, startup failure, consecutive errors）
3. **自动修复：** 检测到错误后 30 秒内调用 Claude 生成修复方案
4. **热重载验证：** 修复代码后，tsx watch 能在 5 秒内自动重启 spirit watcher
5. **防重复修复：** 同一错误 5 分钟内不重复修复
6. **可观测性：** 所有修复尝试记录到 SQLite，可通过 MCP 工具查询

## Implementation Plan

### Phase 1: 基础监听（1 小时）
1. 实现 `LogMonitor` 类，监听 stdout/stderr
2. 实现文件日志监听（chokidar）
3. 实现日志缓冲和上下文提取

### Phase 2: 错误检测（30 分钟）
1. 实现 `ErrorDetector` 类
2. 定义 4 种阻塞性错误的检测规则
3. 添加配置化的错误模式匹配

### Phase 3: 自修复逻辑（1 小时）
1. 实现 `SelfFixer` 类
2. 复用 `analyzer.ts` 的 Claude 调用逻辑
3. 实现修复前的代码备份
4. 实现修复后的 typecheck 验证

### Phase 4: 集成和测试（30 分钟）
1. 编写单元测试
2. 手动触发错误验证端到端流程
3. 添加 npm scripts

## Open Questions

1. **修复失败处理：** 如果 Claude 生成的修复代码仍然有错误，是否需要回滚？
   - 建议：最多重试 3 次，失败后发送通知（Slack/邮件）并停止修复
   
2. **监控进程自身的错误：** 如果 self-monitor 自己崩溃了怎么办？
   - 建议：使用 systemd/pm2 等进程管理器监控 self-monitor，或者实现一个更轻量的 watchdog
   
3. **修复范围：** 是否只修复 spirit 自己的代码，还是也修复依赖的配置文件？
   - 建议：初期只修复 src/ 下的 TypeScript 代码，配置文件需要人工审核

4. **日志文件轮转：** spirit-YYYYMMDD.log 每天会生成新文件，如何处理？
   - 建议：使用 glob pattern 监听，每天 00:00 自动切换到新文件
