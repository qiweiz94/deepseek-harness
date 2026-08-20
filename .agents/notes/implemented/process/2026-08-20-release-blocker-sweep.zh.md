# Agent Note: 发布阻塞项清扫——过期 FIXME、apiproxy 版本、归因 URL

Status: implemented

[English](2026-08-20-release-blocker-sweep.md) | 中文

## 问题

在[迁移器移除](2026-07-26-remove-packed-session-fixture-migrator.md)之外，还有三个小的发布前阻塞项悬而未决，每一项单独看都很廉价，但都承载着需要记录的决定：`packages/guard/timeout-policy/src/index.ts` 中过期的重命名 FIXME、`host.describe`（`packages/host/apiproxy/src/api-proxy.ts`）中硬编码的 `version: '0.0.1'` 占位值，以及 `packages/llm/llm` 已知限制中"`APP_IDENTITY.url` 指向一个尚不存在的仓库"的条目。

## 决定

**timeout-policy FIXME：删除，不重命名。** 该 FIXME 要求"在解决时"敲定 `@deepseek-ai/dsh-timeout-guard` 重命名。[命名契约与重命名台账](../architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md)已经解决了它：包名为 `@deepseek-ai/dsh-tool-call-timeout-policy`，且其 `guard/timeout-policy/` 目录与 `timeout-policy` 插件 id 被明确保留。该 FIXME 早于这一决定；删除它即为敲定，而重新推翻台账的选择需要新的提案，而不是一个标记。

**`host.describe` 版本：使用包自身 manifest 中的同步工作区版本。** 每个 harness 包（包括 CLI 应用）都以同一工作区版本发布，因此 `createRequire(import.meta.url)('../package.json')`——`packages/llm/llm/src/attribution.ts` 已在生产中使用的完全相同的模式——无需新接缝即可报告宿主应用版本。读取 `apps/cli` 的 manifest 被否决：apiproxy 不能依赖应用，且任何跨工作区根的相对路径在构建后的 `lib/` 下都会失效。在 `ApiProxyDefaults` 中增加 `version` 字段被否决：这会把一个常量强加给每个调用方，而该表面已计划由 API 平面替换。

**`APP_IDENTITY.url` 限制：因条件已满足而移除，值不变。** 该限制自身的条件是发布前可访问。`https://github.com/deepseek-ai/deepseek-harness` 已于 2026-08-20 验证为公开仓库（GitHub API：`"private": false, "visibility": "public"`），因此该条目已过期；该值本就指向规范仓库，无需更改。

## 曾考虑的替代方案

**将 URL 限制转为 issue 跟踪而非移除。** 否决：它所守护的条件已可验证地满足；issue 将无物可跟踪。

**为角色词准确性重命名为 `dsh-timeout-guard`。** 台账自身的 `Policy` 行确实说明该插件执行的是机制，但台账在写下该行之后仍权衡并保留了现名；推翻它属于携带完整引用清单的新提案 note，而不是一次清扫。

## 验证

- `pnpm run typecheck` 以及 apiproxy、llm、timeout-policy 套件通过；没有测试或 fixture 固定旧的 `'0.0.1'` 值。
- llm README 语言对不再列出该 URL 限制；翻译配对已重新记录。
- `git grep 'dsh-timeout-guard'` 只命中本 note 与台账的历史记录。

## 后果

`host.describe` 报告真实发布版本，并随工作区版本同步演进，无需额外维护。timeout-guard 问题无法再以标记形式复活：重新提出需要一份针对台账的提案 note。移除 URL 限制后，llm 包剩余的已知限制均为当前有效；未来若仓库迁移，那是需要独立变更的新事实，而不是旧条目的复活。
