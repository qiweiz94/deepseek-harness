# Agent Note：共享的前台委派结算

Status: implemented

[English](2026-08-19-shared-foreground-settlement.md) | 中文

## 问题

`dsh-plugin-subagent-router` 上线时逐字复制了 `dsh-tool-subagent` 私有的前台结算代码——`settleForegroundRun`、停止原因映射、部分输出保留、`outputValueText` 以及 `ForegroundToolResult` 类型——约一百行重复。自那次合并起 `pnpm run duplication` 门禁一直是红的（两包之间 6 处克隆，外加 `scripts/slot-walk.ts` 一处既有的自我克隆），而红门禁会阻塞任何运行 `check:ci:lint:contracts-ready` 的 CI 通道。结算语义的副本还会漂移：加进一个工具映射的停止原因会悄悄漏掉另一个。

## 决定

前台结算移入 `@deepseek-ai/dsh-subagent` 的 [foreground-settlement](../../../../packages/subagent/subagent/src/foreground-settlement.ts)，与后台 Task 对应物 `run-settlement.ts` 平级。它导出 `settleForegroundRun`、`outputValueText` 和 `ForegroundToolResult` 类型；停止原因映射与部分输出保留保持模块私有。两个委派工具 Consumer 都从这里导入；router 复制的 `foreground.ts` 已删除。两个 Consumer 共享同一结算语义时，由能力包承载该共享面正是"为所有现有 Consumer 设计 Service Definition"。包内专属测试（[foreground-settlement.spec.ts](../../../../packages/subagent/subagent/tests/foreground-settlement.spec.ts)）承担该模块的逐文件覆盖率；各 Consumer 的 Loader 组合测试继续经由调用点验证它。

两个工具之间的三处小型平行结构按设计保持重复，并在 router 中带有说明理由的 `jscpd:ignore` 块：委派选项 Config 字段（两个工具独立演化——`dsh-tool-subagent` 将 `maxDepth` 默认为 3，router 不设默认以保持能力需求为空）、工具输出 schema（依能力接缝规则工具 schema 归 Consumer 所有；每个工具各自以 schema 形式声明 `ForegroundToolResult`）、以及启动请求的选项转发（它跟随各工具自己的 Config）。`slot-walk.ts` 的自我克隆已消除：两个扫描函数现共享 `readMatchedFiles` 生成器完成 glob-规范化-去重-排序-读取循环。

## 考虑过的替代方案

**用 `jscpd:ignore` 标记包住被复制的模块。** 便宜，但把一百行逐字副本固化下来并留下漂移隐患；重复检测门禁的存在正是为了逼出这次抽取。

**从 `dsh-tool-subagent` 导出这些辅助函数供 router 导入。** 依赖方向错误：router 是并列的 Consumer 而非另一个工具插件的消费者，为取辅助函数而导入插件模块会耦合两个工具的发布面。

**连 schema 片段一并抽取。** 工具 schema 归 Consumer 所有；共享 schema 片段会让一个 Consumer 的 schema 改动悄悄改写另一个的模型可见契约。

## 后果

`pnpm run duplication` 重新报告零克隆，解除了 fork CI consumers 通道的阻塞。停止原因映射的改动现在落在一个模块并同时到达两个工具。`ForegroundToolResult` 类型只有一个归属；router 的 `types.ts` 只保留其能力需求契约。三处带注释的平行结构仍是刻意保留的可见重复——改动一侧时应重新审视另一侧是否需要同样的改动。
