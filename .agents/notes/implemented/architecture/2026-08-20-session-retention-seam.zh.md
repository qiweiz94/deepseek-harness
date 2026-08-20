# Agent Note：会话保留能力 seam

Status: implemented

[English](2026-08-20-session-retention-seam.md) | 中文

## 问题

harness 中没有任何机制可以删除或使持久化数据过期。六个包的 README 都以各自的措辞记录了同一个消费方缺口：JSONL 日志会累积，直到被外部移除；SQLite 行会累积，直到被外部移除；persistence seam 没有删除接口；本地 spill 文件会持续存在，直到外部清理；spill seam 没有删除接口；附件对象会无限期保留。`dsh-workspace` 则从消费方一侧点出了同一个空缺：会话删除是一项独立且缺失的能力，绝不能用"注销登记"来替代。因此，删除某个会话的持久化数据，需要人工在最多三个存储中手动查找并移除相应工件，既没有跨存储枚举，也没有存活状态保护,更没有按存储分别报告结果。

## 决策

一个能力 seam——`@deepseek-ai/dsh-session-retention`（`packages/session/session-retention`）——负责跨存储删除某个会话的持久化数据。

- **Service Definition 与编排** —— `SessionRetentionRuntime` 以 `ctx.sessionRetention` 的形式注册,并拥有这套词汇：`RetentionParticipant`（每个存储一个，`store` 标签唯一）暴露 `plan`（枚举一次删除会移除的内容，不做修改）和 `deleteSession`（执行删除并报告结果）。结果均为封闭联合类型：plan 的结果是 `targets`（可能为空）或 `retains`（该存储按设计保留数据，并附带原因）；删除的结果是 `deleted`（附带被移除的 `RetentionTarget`）、`absent` 或 `retained`。运行时的报告还会为其捕获到的某个参与者的拒绝追加 `failed`，使一个存储的失败不会掩盖另一个存储的结果。
- **消费方接口** —— `ctx.sessionRetention.plan(id)` 与 `ctx.sessionRetention.deleteSession(id)` 是预期供 `dsh-workspace` 调用的会话管理服务方法；v1 刻意不提供任何面向模型的工具。`deleteSession` 会拒绝处理存活会话，也会在零个参与者已注册时拒绝执行——一个空的 fan-out 却报告"成功"，将是一个永远无法失败的控制点。
- **Provider** —— 每个存储都通过 `ctx.inject(['sessionRetention'], …)` 完成注册，因此没有该运行时的组合不受影响。共享的 `PersistenceCoordinator` 会为每个持久化后端注册一个参与者，依赖两个新增的、**可选**的后端 hook——`planStored` 与 `deleteStored`；之所以是可选的，是因为一个与本变更无关的测试 fixture（`packages/host/apiproxy`）实现了 `PersistenceBackend` 却未提供这两个 hook；省略其中任一 hook 的后端，只是不会获得 retention 参与者，仅此而已。它的 `delete` 运行在按 id 划分的串行链上，会等待退役完成，拒绝处理存活会话与已被预留用于恢复的准备状态，并在物理删除之前先清空协调器自身的缓存，使一次失败的后端删除能够重新从磁盘派生状态。JSONL 后端会移除会话所属目录；SQLite 后端会在一个事务中删除 `sessions` 行，并借助 `ON DELETE CASCADE` 一并移除其事件。`dsh-spill-local` 会移除其按会话确定性划分的 spill 目录。`dsh-attachment-local` 注册的是一个诚实的 `retained` 参与者：对象按内容寻址，且跨会话去重，因此在不具备引用感知垃圾回收的前提下，逐会话删除对象是不安全的。`dsh-attachment-local` 接入参与者的方式有所不同：它在一个普通的 `ctx.effect` 内部使用 `ctx.on('internal/service', …)` 搭配 `ctx.get('sessionRetention')`，而非 `ctx.inject`——该包自身的整套测试基础设施（`scripts/test-invariants.ts`）会在测试 root 上首次出现任何 `ctx.plugin` 系列调用时，自动挂载一个与之竞争的 `attachments` fixture，这会使基于 `ctx.inject` 的注册回调本身在该测试基础设施下陷入死锁；`internal/service` 事件在不经过 `ctx.plugin` 的前提下，提供了与之相同的、不依赖到达顺序的接入行为。
- **v1 不提供自动策略** —— 基于时间和配额的保留策略是可配置的后续工作；正确实现单会话删除，是它们未来会调用调度的基础。

## 考虑过的替代方案

- **在每个既有 seam 上各自添加删除方法**（在 `SessionPersistence`、`SpillStore`、`AttachmentStore` 上各加一个 `delete`）——被否决：每个方法都只会有唯一预期的调用方（会话管理层），消费方将不得不了解每一个存储，且跨存储的枚举/报告逻辑会在每个调用点重复实现。"只有一个调用方的公共服务方法"是文档中已明确记载的反向坏味道。
- **先做策略引擎**（把按时间/配额淘汰作为内部细节，删除只是其一部分）——被否决：目前没有任何消费方证据支持某个默认策略，而在没有正确的单会话删除原语之前，策略引擎无法安全地自动化任何事情。策略后续会成为参与者的调用方。
- **通过扫描被删除会话的日志中的引用来删除附件对象**——被否决：被 fork 和被恢复的会话会共享按内容寻址的对象，因此仅凭单份日志的证据无法证明某个对象已无引用；要在此处删除，需要跨存储的引用计数（已推迟），而一次错误的判断会破坏其他会话的回放。
- **在每个后端包中各自注册 persistence 参与者**，而不是放在共享的协调器中——被否决：两个后端将各自重复完全相同的注册与存活状态判断逻辑；协调器已经拥有按 id 的串行化、退役机制,以及一次删除必须清空的缓存。
- **`retention/session-deleted` context 事件**——已推迟，未在本次交付：目前没有真实消费方（projection-cache 淘汰与 workspace header 索引会是最先可能的消费方），而一个没有消费方的事件只是无主的接口面。

## 后果

- 收益：一次调用即可跨 JSONL/SQLite persistence 与本地 spill 存储删除某个会话，并按存储分别给出结果；workspace 层无需了解各存储内部细节即可接入会话删除；每个存储 README 中的限制说明现在都指向该 seam，而不再是"外部清理"。
- 成本：`PersistenceBackend` 新增了两个可选 hook；`dsh-session-persistence`、`dsh-spill-local` 与 `dsh-attachment-local` 现在都依赖 `dsh-session-retention`。
- `dsh-session-persistence-sqlite` 与 `dsh-storage-sqlite`（`packages/storage/storage-sqlite`）都各自手写了打开 SQLite 连接的流程，`openDatabase(path, journalMode)` 的步骤几乎完全相同（`new DatabaseSync`、`PRAGMA foreign_keys`、`PRAGMA journal_mode`、读取并设置 `PRAGMA user_version`）。本次改动没有触及任何一方的打开流程,因此这里只作记录而不做抽取,留待下一次改动其中一方时处理。
- 附件字节仍然永远不会被回收（`retained` 结果）；跨会话的引用感知垃圾回收在 `dsh-attachment`/`dsh-attachment-local` 中仍被推迟。
- 删除按会话 id 逐个进行：被 fork 出的会话日志可能引用父会话的 spill 定位信息与附件对象；删除父会话会使该 fork 的 spill 引用变成悬空引用。感知世系关系的删除已被推迟，并记录在运行时的 README 中。
- 已删除会话在 `dsh-session-projection-cache` 中的行,会一直保留到该包自身的（同样被推迟的）淘汰接口出现为止；由于这些行只按会话 id 读取，它们是不可达的垃圾数据，而不是错误的应答内容。
- workspace 一侧的消费方接线本身（确认交互、文件夹删除的配套逻辑）仍然是 `dsh-workspace` 中的开放事项；本 seam 只提供供其调用的方法。
- 一次被中止或部分失败的 `deleteSession`，可能已经删除了部分存储而未删除其余存储；报告会说明具体是哪些；重新执行会收敛，因为每个参与者都会将已删除的数据视为 `absent`。

## 测试

每个 provider 包都通过一个真实的 `Context` 组合，联合该运行时，针对真实存储（临时 JSONL 根目录、内存态 SQLite、临时 spill 根目录、临时 DSH_HOME）对自己的参与者做端到端测试；运行时包本身则用受控的参与者测试分发、拒绝、失败捕获与释放。`dsh-attachment-local` 的 retention 测试使用直接构造（`new SessionRetentionRuntime(ctx)` / `new LocalAttachmentStore(ctx, …)`）而非 `ctx.plugin`，原因与接线本身相同,都是出于该包自身测试基础设施的限制。若要在按包分范围的覆盖率运行中让 `src/invariant.ts` 达到 100%，需要在被改动包自身的 `tests/` 之外再加入 `scripts/test-invariants.spec.ts`：该文件的伴生模块只会通过整套测试基础设施的 topology 测试挂载,任何按包分范围的 spec 都不会触发它。没有需要更新的 keyless 快照：v1 没有面向模型或产品用户可见的输出。
