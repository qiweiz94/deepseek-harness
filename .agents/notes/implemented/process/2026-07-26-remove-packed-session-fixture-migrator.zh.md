# Agent Note: 移除打包会话 fixture 分支迁移器

Status: implemented

[English](2026-07-26-remove-packed-session-fixture-migrator.md) | 中文

## 问题

仓库的默认写入器和快照检查会使会话 fixture（测试前置数据）保持规范打包行布局。在永久强制机制之外仍保留 `pnpm run migrate:packed-session-fixtures`，唯一原因是让携带旧版 fixture 改动的在途分支可以合并当前 `master`，并在不重新录制模型输出的情况下通过机械转换收敛。

一旦每个此类分支均已合并、关闭或符合规范，写入命令及其分支收敛指引便不再有持续维护者。过渡结束后继续保留会修改仓库内容的命令，会在永久只读快照检查旁增加第二条看似有效的维护路径。

## 决定

临时 CLI `scripts/migrate-packed-session-fixtures.ts` 与根包命令 `migrate:packed-session-fixtures` 已移除。实时清单未发现任何需要转换会话格式 JSONL 的开放 PR（Pull Request），但发现了一个提案未建模的持续使用者：文档化的实况重录流程（`test:snapshot:record`）收割的是原始的急切排水打包会话日志，依赖迁移器在事后规范化。因此本次移除同时在源头关闭了该依赖：record 与 refresh 写回会通过 `canonicalSessionFixture` 规范化每一份 fixture，该函数从脚本移入 `@deepseek-ai/dsh-acp-snapshot`（`src/session-fixture-canonical.ts`），使写回点与门禁共享同一实现。

`scripts/session-fixture-layout.ts` 保留为永久门禁 `scripts/session-fixture-layout.snapshot.ts` 的仓库发现层，并从包中导入规范布局转换器；纯函数单元测试移至 `packages/test-support/acp-snapshot/tests/session-fixture-canonical.spec.ts`。门禁的修复指引与具体命令无关。测试政策、ACP 快照 README 和[打包行 Agent Note](../architecture/2026-07-26-packed-chunk-rows-by-default.md) 中指向过渡命令的链接均已移除。

## 曾考虑的替代方案

**无限期保留该命令。** 这会让旧 fixture 转换更方便，但也会在唯一已知迁移窗口关闭后，留下一个仓库级写入工具。只读门禁已经提供可长期保留的行为与诊断。

**随 CLI 一同移除规范布局转换模块。** 该模块不是过渡残留：快照 CI 使用它发现未来 fixture、解码混合物理记录，并与规范打包表示进行比较。移除该模块也会移除强制机制。

**打包行进入 `master` 后立即删除命令。** 较旧的开放分支在调整目标分支后，只能使用临时脚本或手动重新生成快照，这会增加冲突风险，也会让解码事件保真度更难评审。

## 验证

- 移除时（2026-08-20）的实时开放 PR 清单为零开放 PR；没有分支携带依赖迁移命令的会话格式 JSONL 改动。
- 临时 CLI、根包命令、所有分支收敛链接与仅适用于该命令的门禁诊断均不存在；永久规范布局转换器、其单元测试和快照检查仍然保留。
- record/refresh 写回规范化由 acp-snapshot 套件的 record-suite fixture 覆盖；仓库级布局门禁、`pnpm run doc-sync`、lint 和空白校验在没有临时命令的情况下通过。（有两个快照场景在本变更前后均失败，源于 fork CI issue 跟踪的与此无关的既有 fixture 缺陷。）
- 当前文档仅描述打包默认值和永久规范布局强制机制。

## 后果

仍携带非打包 fixture 改动的分支可通过重新运行 refresh（`pnpm run test:snapshot:refresh`）或对文件调用 `canonicalSessionFixture` 完成收敛；不再存在可能被误运行的仓库级写入命令，且永久门禁会指名每一份不符合规范的文件。
