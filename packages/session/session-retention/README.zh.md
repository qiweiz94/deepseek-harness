# @deepseek-ai/dsh-session-retention

[English](README.md) | 中文

**`SessionRetentionRuntime`**（`ctx.sessionRetention`）负责跨所有已接入的存储，删除某个会话的持久化数据。这正是每个存储包 README 中都指向的消费方缺口所对应的能力 seam：先枚举删除某个会话会移除哪些内容，再执行删除，并按存储分别报告结果,而不是返回单一的、不透明的成功状态。

## 服务 API（`ctx.sessionRetention`）

| 成员 | 语义 |
|---|---|
| `plan(id, signal?)` | 按已注册的每个存储，枚举删除 `id` 会移除的内容,不做任何修改。 |
| `deleteSession(id, signal?)` | 在每个已注册的存储中删除 `id` 的持久化数据。若会话处于存活状态则拒绝执行;若零个存储已注册,同样拒绝执行。 |
| `register(participant)` | 存储的注册入口(供存储包使用,而非 `deleteSession` 的调用方使用);返回用于注销该注册的释放函数。 |

`plan` 与 `deleteSession` 均按注册顺序,为每个已注册的 `RetentionParticipant` 返回一条结果:

- `plan` 的结果为 `{ kind: 'targets', targets }`(可能为空)或 `{ kind: 'retains', reason }`(表示该存储按设计保留其数据)。
- `deleteSession` 的结果为 `{ kind: 'deleted', targets }`、`{ kind: 'absent' }`(表示该存储原本就没有 `id` 的数据)、`{ kind: 'retained', reason }`,或 `{ kind: 'failed', message }`——运行时会捕获某一存储的拒绝,使其不会掩盖其他存储的结果,且后续存储仍会继续执行。

`RetentionTarget` 用于描述被移除的一项工件或记录集合:`kind`(`file` | `directory` | `records`)、特定于存储的 `location`,以及可选的、计算成本低的 `count`。重复执行同一次删除是收敛的:每个存储都会将已删除的数据视为 `absent`,而不会拒绝。

本包是 Service Definition 与编排者;各存储包是其 Provider。`dsh-session-persistence` 为每个持久化后端注册一个存储参与者(由 `dsh-session-persistence-jsonl` 与 `dsh-session-persistence-sqlite` 共用),依赖后端的两个 hook——`planStored`/`deleteStored`;这两个 hook 是可选的,因此早于 retention seam 存在的后端(或测试用的 fixture)不受影响。`dsh-spill-local` 会移除其按会话划分的 spill 目录。`dsh-attachment-local` 注册的是一个诚实的 `retains`/`retained` 参与者:其对象按内容寻址并跨会话去重,若不做具备引用感知能力的垃圾回收,逐会话删除是不安全的。

v1 版本刻意不提供**基于时间或配额的自动保留策略**,也**不提供面向模型的工具**:该 seam 只是单会话删除的原语,供未来的策略或会话管理层(`dsh-workspace`)调用调度。

## 模型体验

无,因为该 seam 仅响应调用方的显式请求删除持久化数据,不涉及任何提示词、消息、schema、流式输出或工具结果。

#### KV Cache 影响

无;该 seam 从不组装或发送任何 provider 请求。

## 已知限制与暂缓事项

- **没有自动保留策略**——基于时间或配额的淘汰机制被推迟;本 seam 是它们未来会调用的删除原语。
- **附件字节永远不会被回收**——`dsh-attachment-local` 始终报告 `retained`;跨会话的引用感知垃圾回收在 `dsh-attachment`/`dsh-attachment-local` 中被推迟。
- **删除只按会话 id 进行,不感知世系关系**——被 fork 出的会话日志可能引用其父会话的 spill 定位信息与附件对象;删除父会话会使 fork 会话的 spill 引用悬空。感知世系关系的删除(在删除前遍历 fork/resume 的祖先关系)被推迟。
- **没有 `retention/session-deleted` 事件**——在出现真实消费方之前被推迟(projection-cache 的淘汰或 workspace 的 header 索引会是第一批潜在消费方);没有消费方的事件只是无主的接口面。
- **没有 workspace 消费方接线**——`dsh-workspace` 仍然缺少确认交互与文件夹删除的配套逻辑,这些逻辑本应调用 `deleteSession`;本 seam 只提供该方法,不提供调用方。
