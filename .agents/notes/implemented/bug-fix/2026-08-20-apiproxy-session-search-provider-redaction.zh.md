# Agent Note: session.search 对位于提供方边界的失败做脱敏

Status: implemented

[English](2026-08-20-apiproxy-session-search-provider-redaction.md) | 中文

## 问题

`session.search` 的外层 catch 会用 `message: \`session search failed: ${String(error)}\`` 回应每一次失败，把 session-query 提供方自身拒绝所携带的任何内容原样插入线路。真实的 sqlite 后端的 `SESSION_QUERY_INDEX_FAILED` 与 `SESSION_QUERY_PERSISTENCE_FAILED` 代码会把底层 SQLite/文件系统的错误文本嵌入自己的 message 中（`session-search SQLite index failed to open: ${errorMessage(error)}`），其中可能携带索引文件路径或其他本地存储细节。该处代码原本一直带着一条 `XXX: Redact provider details before exposing this gateway beyond its current single-user local deployment` 标记。

## 决定

脱敏被移到了捕获提供方自身拒绝的确切边界处——围绕 `sessionQuery.searchSessions(...)` 的内层 `try`/`catch`，而不是同时也处理本网关自身协议守卫错误（提供方调用的工作预算、超量的一页、重复的续读游标）的外层 catch。在这个内层边界处：

- `SESSION_QUERY_ABORTED` 会原样透传：它的 message 是一个固定且安全的字符串（`'session-search aborted'`），而外层 catch 的 `error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'` 检查需要拿到原始的带类型实例，才能继续路由到 `cancelled()`。
- `SESSION_QUERY_INVALID_LIMIT`（仅首页）与 `SESSION_QUERY_STALE_CURSOR`（仅续读）保持不变：既有的自适应重试分支已经会消费它们，不会让它们的 message 到达调用方。
- 其他任何拒绝——一个未被分类的 `SessionQueryError` 代码、一个普通 `Error`，或提供方抛出的任何其他内容——都会通过 `ctx.logger.warn` 完整记录日志，并在传播到外层 catch 之前替换为一个通用的 `Error('session search provider failed')`；因此外层 catch 既有的 `String(error)` 插值天然是安全的：从这条路径出发，不会再有任何原始内容到达那里。

外层 catch 本身未作改动。本网关自身的协议守卫 `Error`（在分页循环体内抛出，位于内层 try 之外）永远不会经过这个脱敏点，因此它们的诊断文本——"session search provider exceeded the 100-call work budget"、"session search provider returned N items; maximum is M"、"session search provider repeated a continuation cursor"——依旧未脱敏地到达调用方；这些文本都不是提供方给出的。

## 考虑过的替代方案

- **在外层 catch 处（对该方法的每一次失败）做脱敏**——实现后予以拒绝：这也会吞掉本网关自身安全、受控的协议守卫诊断信息，而这些并非提供方细节，对调用方是有用的（它们解释了搜索为何被拒绝，而不是暴露后端内部长什么样）。有六个既有测试断言了这段确切文本；对它们做脱敏将是错误的，而不只是不方便。
- **按 `instanceof SessionQueryError` 来区分**——已拒绝：`SESSION_QUERY_INDEX_FAILED` 与 `SESSION_QUERY_PERSISTENCE_FAILED` 本身就是 `SessionQueryError` 实例，其 message 却嵌入了原始的后端文本，因此仅凭类型无法区分安全与不安全。真正的分界线是代码中的脱敏点（提供方调用处的 catch），而不是错误的类。
- **对本文件中其他每一个 `session.*`/`subagents.*` 等方法做同样的脱敏**——已推迟，符合"narrow（窄范围）"的既定范围：其中许多目前仍以未脱敏的 `String(error)` 或 `error.message` 回应给同一个单用户本地调用方。README 的"已知限制与暂缓事项"条目现在明确指出了这一点，而不是暗示整个网关都已获得这种处理。

## 后果

- 一次索引损坏或持久化故障（或诸如数据库不可用之类的原始提供方错误）不再让 `session.search` 的调用方拿到后端细节；无论哪种情况，操作者日志都会保留完整错误。
- `tests/api-proxy-search.spec.ts` 覆盖了一个原始的提供方 `Error`（`'database unavailable'`，断言线路上的 message 不包含它，且 `ctx.logger.warn` 收到了它）以及一个嵌有文件路径的 `SESSION_QUERY_INDEX_FAILED`（同样的断言），作为这次脱敏的已知错误用例。
- 每一个断言本网关自身协议守卫诊断文本（工作预算、超量的一页、重复的游标）以及两条自适应重试路径的既有测试都无需改动：它们都不会经过这个脱敏点。
- `session.search` 是 `api-proxy.ts` 中唯一获得这种处理的方法；文件中其他每一个 `code: 'internal'` 响应仍然会插值原始错误文本，README 现在明确说明了这就是本次改动交付的边界。
