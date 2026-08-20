# Agent Note：持久化的 subagent 报告信箱

Status: implemented

[English](2026-08-20-durable-subagent-report-mailbox.md) | 中文

## 问题

可继续子 agent（智能体）的报告以一次内存中的收件箱投递到达父级。收件箱本身是持久化投影（`agent/inbox/spliced`），但父级侧已接受报告的记录并不保证在父进程结束后仍然存在：有序销毁是一次 `keepInbox: false` 取消，会持久地清除未认领条目；崩溃也可能在 splice 落盘前丢失这次接受。重启后的父级没有待读的报告；只有子级自己的 transcript 保留内容。subagent README 将此记录为 "No durable report mailbox"，报告工具 README 记录为 "Acceptance is weaker than durable delivery"。

## 决定

`reportFrom` 在同一无 await 的接受区间内、收件箱发送之前，向父级的持久会话日志追加一条仅日志的 `subagent/report` 会话事件。负载带版本号（`SUBAGENT_REPORT_MAILBOX_VERSION`，`src/report-mailbox.ts`），携带解析后的投递策略以及被接受的完整封装 `UserMessage`——id、内容与其 `subagent-report` source。

投递状态从日志既有的提交点推导，绝不使用第二种标记事件：消息 id 为 M 的信箱记录被视为已投递，当且仅当存在 id 为 M 的 `user/message` 事件，因为认领该消息的轮次会把被认领消息本身写入日志。

在 `source: 'resume'` 的 `agent/session-start` 上，subagent 服务折叠被恢复会话自己的后缀（从 `header.seedLength` 开始，与收件箱重放的边界相同），收集未投递的信箱记录，跳过重放收件箱中仍然待处理的 id，然后重新发送每条剩余记录的原始消息——`wakeup` 记录用 `followup`，`quiet` 记录用 `inject`。重投递复用原始消息 id，因此反复的崩溃/恢复循环保持幂等，之后的认领会经由普通 `user/message` 路径关闭该记录。单条记录的重投递失败会被记录日志，绝不使恢复失败。

信箱追加位于发送之前，因此在父级解析成功后发送抛出（失败 `followup` 被译为 `PARENT_UNAVAILABLE`）时，持久记录已经存在，之后的恢复会投递它；报告工具文档中的"失败的调用并不能证明未投递"现在指向一条真实的投递路径，而不只是不确定性。追加本身也可能先失败：内容无法通过无损 JSON 日志边界时会在追加或发送任何内容之前抛出 `SubagentError` `NOT_SERIALIZABLE`，因此该次调用干净地失败，既无持久记录也无投递。

结算通知有意不进入信箱：它们是运行时叙述，其销毁时丢失是已记录的行为；恢复后的父级通过 `list_agents` 与子会话了解结局。

Model-visible ⟺ logged 双向成立：信箱事件本身绝不进入模型历史，而真正到达模型的消息可以从它重建——并在被认领时另行作为 `user/message` 写入日志。

## 考虑过的替代方案

- 仅依赖收件箱 splice 重放（不新增事件）：只覆盖插入 splice 已落盘的崩溃，而有序销毁会持久取消未认领报告——正是本决定要关闭的缺口。
- 信箱放在子级日志、父级恢复时扫描：每次父级恢复都要枚举并读取后代会话文件；因成本以及将恢复耦合到持久目录而被拒绝。
- 显式的认领/确认事件：第二种投递来源，可能与 `user/message` 矛盾；投递状态改为从既有提交点推导。
- 向非存活父级的持久会话离线追加：写入未加载的会话需要持久化 seam 并不提供的跨进程协调；v1 不改变"存活直接父级"的接受规则。
- 会话日志之外的存储：一个需要自带重放与修复规则的新持久层；会话日志已经负责持久性与重放。

## 后果

- 子级的报告在父级重启与有序销毁后仍然存在。在认领轮次的 `user/message` 丢失的落盘窗口内仍可能重复——即带日志推导去重的至少一次语义，已写入两个包的 README。
- 每条被接受的报告被持久记录两次：一次在子级 transcript，一次是父级的信箱事件。
- `subagent/report` 加入读取时必须识别的事件集合：不认识该类型的构建会拒绝此日志，而不是悄悄丢弃未投递的报告（与 `subagent/descriptor` 立场一致）。
- 恰好一次投递、已读回执、宿主用户接收方与跨进程租约仍在范围之外；两个 README 中的剩余限制条目相应收窄。

## 测试

`packages/subagent/subagent/tests/report-mailbox.spec.ts` 中的单元覆盖针对一个真实的内存 `Session` 与一个最小化的伪造 `Agent` 单独折叠信箱：认领去重、种子后缀边界、信箱版本过滤、`isRedeliverable` 的每一种拒绝形态、已在收件箱中待处理时的跳过、以及重投递发送失败时告警而不抛出——达到该文件的完整覆盖。

`continuation.spec.ts` 中 "durable subagent report mailbox" 套件提供 REAL 组合覆盖，运行完整的可继续栈：一个测试对不可序列化的报告断言抛出 `SubagentError` `NOT_SERIALIZABLE` 且未追加任何内容；一个测试基于同一持久化根重启父级，断言未认领的已接受报告恰好一次到达恢复后父级的收件箱（过滤出该报告后的 `nextStep` 长度为 1，`nextTurn` 为空)——证明既不存在重投递缺口，也不会与普通的 `agent/inbox/spliced` 重放竞态产生重复投递；一个测试直接向父级会话追加一条投递策略不受支持的信箱记录（只有不同/未来版本的运行时才可能写出的形态），恢复后断言恢复成功完成、收件箱为空，且出现了一次将该记录标记为损坏的 `warn` 调用。"已认领报告不会被重投递"这一半的去重结论在单元层面证明(`undeliveredSubagentReports` 会排除消息 id 被后续 `user/message` 事件携带的记录)，不再重复作为第二个全栈测试。经由可运行示例的免密钥快照场景已排队给 examples 集成者（不在本包的所有权范围内）。
