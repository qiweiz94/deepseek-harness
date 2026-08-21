# Agent Note：diagnostic-sifter 将 targetPath 限制在工作目录内

Status: implemented

[English](2026-08-21-sifter-targetpath-containment.md) | 中文

## 问题

`@deepseek-ai/dsh-plugin-diagnostic-sifter` 的 `run_diagnostic_check` 工具接收模型提供的 `targetPath`，并将其原样追加到派生的 `vitest run` / `tsc -b` argv（`src/index.ts`）。唯一的防御是前导短横检查（选项注入）。一个逃逸出所配置 `cwd` 的路径——`../../elsewhere` 或绝对路径——能通过该检查，而由于 `vitest run <dir>` 与 `tsc -b <project>` 会加载目标目录自身的 `vitest.config.ts` / `tsconfig.json`，一次检查因此可能加载并执行外部配置：在项目之外任意执行代码，或构建无关的目录树。工具 schema 将 `targetPath` 记述为「相对工作目录」，但没有任何机制强制这一限制。

## 决策

在 `targetPath` 成为 argv 之前，用一个小的纯函数 `containTargetPath(raw, cwd)` 将其限制在 `cwd` 内：

- 保留前导短横／空值拒绝（选项注入）。
- 将路径相对 `cwd` 解析，取 `relative(cwd, resolve(cwd, raw))`；当它以 `..` 开头（POSIX 上相对或绝对逃逸都表现为此）或为绝对路径（不同的 Windows 盘符）时拒绝。传入受限后的 cwd 相对路径（cwd 本身则为 `.`）。
- 模型可见的 schema 描述以及 README／`README.zh` 现在都说明该路径被限制在工作目录内，使强制的约定与文档一致。

有意**不**添加 `--` argv 分隔符（issue 建议了它）：前导短横检查已对单个非 shell argv 元素完全阻止选项注入，因此 `--` 不增加边际安全性，反而可能破坏 `targetPath` 定位——`vitest` 的 cac 解析器与 `tsc -b` 对 `--` 之后的 token 与位置参数处理不同，会悄悄丢弃范围过滤。限制才是安全修复；`--` 并不需要。

## 考虑过的替代方案

- **仅按 issue 添加 `--`** — 拒绝：`--` 无法阻止路径穿越（真正的漏洞），且有静默的定位回归风险。限制才是堵住漏洞的关键。
- **解析为绝对路径并传入它** — 拒绝，改为传入经校验的 cwd 相对路径：它使 argv 保持在文档所述「相对 cwd」的约定内、在 transcript 中读起来一致，且检查本就以 `cwd` 作为工作目录运行。
- **realpath／符号链接解析** — 未添加：与 `#58` 的决策一致——限制在不跟随符号链接的情况下比较解析后的路径（失败即拒绝），且此处没有消费者需要符号链接归一化。

## 后果

- 逃逸出 `cwd` 的 `targetPath` 现在会在任何派生之前成为工具错误；四个校验分支（空／短横、`..` 逃逸、绝对-在外、合法嵌套，以及 cwd 本身）均被覆盖，逐文件 100% 保持。绝对 `rel` 分支仅在 Windows 可达，带 `/* v8 ignore */` 及与 `workspaceTrustPredicate`（#58）相同的理由。
- `run_diagnostic_check` 不在任何被固定的工具 schema 快照中（不在 `text-turn` ACP 场景内），因此模型可见的描述变更无需重新录制快照。
- 这属于一类模型可控路径工具（semantic-patcher 已拒绝 `..`／绝对路径）；sifter 现在与该姿态一致。
