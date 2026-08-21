# Agent Note：快照 refresh 现在更新 vitest 快照、构建预检，以及 subagent 场景争用调优

Status: implemented

[English](2026-08-21-snapshot-tooling-reliability.md) | 中文

## 问题

关闭 ast-context 快照陈旧问题时，暴露了三个快照工具链缺口：

1. **`test:snapshot:refresh` / `test:web:refresh` 不更新 vitest 快照。** `DSH_SNAPSHOT=refresh` 会重写 acp-snapshot harness 自己的 fixture（回放 JSONL 与预期输出文件），但未传入 `--update`，因此 vitest 的 `toMatchInlineSnapshot`／`toMatchSnapshot` 块——例如 `apps/web/tests/minimal-preset.snapshot.ts` 与 `examples/headless-agent/tests/headless.snapshot.ts` 中的工具列表——在一次无密钥、回放仍有效的变更之后仍然陈旧。没有一条命令能无密钥地刷新它们；只能用 `:record`（用于真实 transcript 变化）或手动限定范围的 `-u`。
2. **没有事先构建时 `test:snapshot` 会以晦涩的 `ERR_MODULE_NOT_FOUND` 失败。** 示例／CLI 场景启动的组装会通过 `<pkg>/typert` 导出导入每个包的 typert host registry，它解析到 `lib/typert.host.js`——一个仅构建产物、无源码形式的模块，且在 `src` 与 `lib` 示例 mode 下都以相同方式到达，因为子路径导出绕过了 tsconfig-paths facade。CI 不受影响（其快照 gate 会先 `build`），但本地裸运行会深陷在被 spawn 的子进程中报错，毫无「先构建」的提示。
3. **acp `subagent-continuable`／`-inheritance` 场景在 fork build lane 上超时**，原因是 4 核争用：每个场景都会 spawn 多个真实 agent 子进程，而 `DSH_SNAPSHOT_MAX_CONCURRENCY=4` 个场景同时运行；lane 注释已记录 `DSH_TEST_TIMEOUT_FACTOR=8` 是「首次放宽，而非经测量的充分上界」。

## 决策

1. **给两个 refresh 脚本追加 `--update`**（`package.json`），与 `test:snapshot:record` 一致。Refresh 是无密钥回放，模型 transcript 不变，因此 `--update` 只重写确定性的派生差异（例如工具列表）。它写入 vitest 的 `.snap`／内联块，与 harness 的 JSONL／预期输出写回互不相交，也不改变串行的 refresh 执行。既有的「审查每一处差异」纪律已覆盖它。`docs/testing.md`（及 zh 对）现在说明 refresh 也会更新 vitest 快照。
2. **新增一个 vitest `globalSetup` 构建预检**（`scripts/snapshot-build-preflight.ts`，在 `vitest.snapshot.config.ts` 中接线），检查代表性的已构建 host 库（`packages/interaction/commands/lib/typert.host.js`、`packages/goal/goal/lib/typert.host.js`），缺失时抛出点名 `pnpm run build:lib:host` 的清晰错误。它在任何场景 spawn 之前于 vitest 进程内明确失败，而非以子进程栈回溯呈现。之所以不选择把构建强加进 `test:snapshot`，是为在库已构建时保留快速路径。
3. **降低 fork build lane 的争用**（`.github/workflows/fork-ci.yml`）：把 `DSH_SNAPSHOT_MAX_CONCURRENCY` 4 → 2（更少场景争抢 4 核——根因），并把 `DSH_TEST_TIMEOUT_FACTOR` 8 → 12（内部等待 120s）作为余量。90 分钟的 lane 预算可吸收并行度的下降。

## 考虑过的替代方案

- **改文档而非加 `--update`** — 拒绝：文档从未真正声称 refresh 更新内联快照，真正的摩擦是能力缺失，而非文档错误。`--update` 提供该能力；文档澄清随之而来。
- **强制 `test:snapshot` 先构建（像 `test:web`）** — 依维护者选择拒绝：它给每次本地快照运行都加上完整构建时间，在库已构建时抵消快速路径。预检保留快速路径，且在确实缺少构建时仍明确失败。
- **只为 subagent 场景提高超时因子** — 作为「仅治标」拒绝：fork-ci 注释已表明仅提高因子「非经测量的充分上界」。降低并发攻击导致超时的核心争用；因子提升是其上的额外余量。

## 后果

- `test:snapshot:refresh` 现在是让 harness fixture 与 vitest 快照同时跟上一次回放有效变更的唯一无密钥命令。
- 没有构建时裸运行 `test:snapshot` 会以可操作的信息失败。注意该预检是无条件的（只要已构建 host 库缺失就触发）：一个假想的、仅 `scripts/` 源 mode、且不导入任何 `<pkg>/typert` 的子集将不再完全零构建，但那种狭窄工作流只需运行一次热态 `build:lib:host`；这一取舍为常见的 `test:snapshot` 调用换来清晰的错误。
- 变更 3 无法本地验证（超时只在真实 4 核 CI 争用下出现）；由下一次 fork build-lane 运行验证。若场景仍超时，下一步是进一步降低并发，或将较重的 subagent 场景拆分到各自的串行步骤。
