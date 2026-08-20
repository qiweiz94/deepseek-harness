# Agent Note: 慢速运行器测试超时缩放

Status: implemented

[English](2026-08-20-slow-runner-timeout-scaling.md) | 中文

## 问题

Fork CI 的首次运行（32333218317）有六个测试因墙钟时间而非行为失败：fork 的托管通道运行在 4 核 `ubuntu-latest` 上，而仓库中的每个超时都是在更快的开发机和上游 16 核池上调定的。`scripts/oxlint-contract.spec.ts` 有三个测试在 5 秒 vitest 默认值下失败（实际 6-9 秒），`packages/core/tools/tests/py-types.spec.ts:937` 与 `packages/client/ui-primitives/tests/code-block.client.spec.tsx:44` 以约 1.3 倍超出同一默认值，`packages/typert/generator/tests/tools-catalog.spec.ts:20` 在 37.8 秒时撞上其显式 `{ timeout: 30_000 }`，acp 的 `subagent-continuable-inheritance` 场景耗尽了快照 harness 硬编码的 10 秒持久化等待上限。另外，`pwsh-tool-turn` 的固定 header（issue #24）在 Linux 上出现分歧：其 `tool-schemas.expected.json` 早于 tool-jobs 的 task 到 job 措辞重命名以及 pwsh 工具描述新增的沙箱拒绝句 —— 这种陈旧在本地不可见，因为该场景在没有 pwsh 的开发主机上自动跳过，而 ubuntu 运行器自带 pwsh。

## 决定

`vitest.shared.ts` 导出 `testTimeoutFactor()` 与 `scaledTimeout(baseMs)`，读取 `DSH_TEST_TIMEOUT_FACTOR`：未设置或为空表示 1（每个上限完全按原样）；已设置的值必须解析为有限且 >= 1 的数字，否则调用方抛错。`vitest.config.ts` 将 vitest 自身的 5 秒默认值经 `scaledTimeout(5_000)` 应用于根配置和两个 project。有两个消费方无法导入这个根模块，各自出于不同的编译边界原因在本地保留了同一份小校验逻辑：acp-snapshot harness 的 `packages/test-support/acp-snapshot/src/harness.ts` 导出自己的 `waitTimeoutFactor()`（`rootDir: src` 下的包源码无法导入仓库根的配置模块），并按调用计算 `defaultWaitTimeoutMs()`——一个默认参数表达式，随场景发起的每次等待重新求值，这也让 `waitTimeoutFactor()` 无需模块重置技巧即可直接单测；`packages/typert/generator/tests/tools-catalog.spec.ts` 保留了本地的 `scaledTimeout(baseMs)`，因为该测试文件在 `tsconfig.host.json` 下编译，其显式文件列表（以及更严格的 `exactOptionalPropertyTypes`）无法触及仓库根模块——在那里导入 `vitest.shared.ts` 会让 `tsc -b tsconfig.host.json` 报 TS6307 项目文件列表错误，不只是运行时问题。`fork-ci.yml` 仅在 coverage 与 consumers 通道设置因子 `4` —— 观测到的最大超出比约 1.3 倍，4 在门禁争用下仍留有余量，且不触碰任何本地默认值。陈旧的 `pwsh-tool-turn` sidecar 在安装了 pwsh 的 macOS 主机上无密钥再生成（`DSH_SNAPSHOT=refresh`，仅限该场景）；产生的差异是工具描述文本加上一个工具顺序变化（`pwsh` 从第一位移到最后一位），不含路径或平台内容，在 fast-forward 到 PR #26 之后的树上，刷新后的回放用同一份录制通过。`ToolRegistry.schemas()`（`packages/core/tools/src/index.ts:1234`）按 `Map` 插入顺序投影可见工具，注册表和规范化器里都没有任何排序，因此固定 header 里的工具顺序确实依赖注册顺序——新顺序已验证为确定性的（对再生成的 golden 跑了 7 次，其中 2 次在人为制造的全核 CPU 压力下，每次顺序都一致），并且与 `examples/acp-agent/tests/pwsh.cordis.yml` 的实际声明顺序相符（`tool-pwsh` 是最后一个顶层条目，在 `acp-agent` 拉入 `tool-jobs` 的 `job_kill`/`job_output` 之后挂载）；此前已提交的 golden 里 `pwsh` 排第一的顺序才是陈旧的那个。`tool-pwsh` 或 `pwsh-local` 在非 Windows 上的注册路径里没有任何带超时的探测——`resolvePwshPath()`（`packages/shell/pwsh-local/src/resolve.ts`）在非 Windows 上零 I/O 地直接返回字面量字符串 `'pwsh'`，两个包的 `apply()`/构造函数都是同步的——所以无论是顺序还是"工具缺失"报告，用注册竞态来解释都调查过了，既不被注册代码支持，也不被多次加压重跑复现。

## 考虑过的替代方案

- 绝对值覆盖 `DSH_TEST_TIMEOUT_MS`（issue #23 的草案）：单一绝对值无法在不抹掉原作者比例的情况下触及 tools-catalog 的 30 秒这类显式逐测试上限，且它要么饿死长套件要么虚增短套件。因子保留每个上限的含义。
- 为所有环境提高默认值：放松本地运行的超时，在快速机器上掩盖回归；issue 明令禁止。
- 按平台重新录制 pwsh fixture：分歧是 fixture 陈旧而非平台相关内容 —— 在任何带 pwsh 的主机上刷新都会复现逐字节相同的文本，一份录制仍服务所有平台。
- harness 默认等待超时用模块加载常量（最初草案）：通过一个在导入时求值的 IIFE 一次性计算，其抛错分支只能靠重置模块缓存、在坏环境值下重新导入来触发——可行但比必要的更重；改为按调用计算的函数后，同一校验可以直接单测，`harness.spec.ts` 的 `waitTimeoutFactor` 用例套件无需任何模块重置的杂技。

## 后果

- CI 通道对每个测试和每个持久化等待容忍 4 倍墙钟时间；非法因子会在 `vitest.shared.ts`/`tools-catalog.spec.ts` 的配置求值处，或 harness 场景发起的第一次未缩放等待处大声失败，而不是静默地不缩放运行。
- 未经因子路由的上限不会缩放。已知实例：`apps/web/tests/chat-scroll-contract.e2e.ts` 内 `expect.poll` 的 10 秒上限以及其他 spec 本地字面量；若其通道继续抖动，需各自采用。
- `pwsh-tool-turn` 重新可以用一份录制在 macOS 与 Linux 上回放。未来 tool-jobs 或 tool-pwsh 的模型可见措辞变化会在任何带 pwsh 的主机上使该固定 header 失败 —— 这种检测正是 pin 的目的；在同一变更中刷新 sidecar。
- `scaledTimeout` 的小校验现在有三份拷贝（`vitest.shared.ts`、`harness.ts`、`tools-catalog.spec.ts`），各自钉在一个禁止导入根模块的、不同的编译项目边界上。要抽出第四份共享拷贝，需要一个 `tsconfig.host.json` 与每个消费方项目的 tsconfig 都能触及的包——当前没有任何包能满足这一点而不沦为产品源码的构建工具依赖，所以这份重复暂时保留。
- 调查 issue #24 的 `apps/web` fixture 时又发现两个本次未修复的失败：`apps/web/tests/minimal-preset.snapshot.ts` 与 `apps/web/tests/shipped-composition.e2e.ts:84` 都拒绝在尚未挂载任何 agent/preset 的 `ctx.tools.schemas()` 上出现 `get_file_outline`/`get_directory_outline`——这是一个有文档记载的不变量（"全局层不持有任何东西"），而非像 pwsh-tool-turn 那样单纯的快照陈旧。同一 `packages/bundle/base/cordis.patch.yml` 区块中的同级条目（`tool-goal`、`tool-todo`、`tool-ralph`）并不会泄漏进这个挂载前的作用域；`plugin-ast-context` 自身的 `apply()` 使用与这些同级条目完全相同的 `ctx.tools.register` 写法，因此这一不对称没有被定位到具体某一行。很可能是由已落在 master 上、早于本次运行的 `0a78be1a48`（`feat(wiring): ship ast-context plugin in base bundle`）引入——它只改动了 `packages/bundle/base/cordis.patch.yml` 与 headless 示例，未触及这些 `apps/web` 测试。本次未修复的原因：`packages/bundle/base/cordis.patch.yml` 在本变更的所有权之外，而且把两个 golden 都改成接受泄漏的工具，可能会掩盖一个看起来真实存在的注册作用域回归。由于 `shipped-composition.e2e.ts:84` 会先于第 87 行的 `EXPECTED_TOOLS` 断言抛错，一旦作用域修好后该名单是否也需要加上这两个 outline 工具尚未验证——是未知，而非"已确认没事"。`apps/web/tests/pwsh-terminal.e2e.ts` 单独失败，报 `duplicate loader entry id: tool-pwsh`（一个 loader/cordis-include 缺陷，与超时或陈旧 fixture 无关）。`apps/web/tests/chat-scroll-contract.e2e.ts` 的失败源于其自身未缩放的 10 秒 `expect.poll` 上限，已在上方列出。
