# Agent Note：双语文档同步自动化插件

Status: implemented

[English](2026-08-20-plugin-doc-sync-automator.md) | 中文

## Problem

`docs/`、`.agents/notes/` 或某个包 README 下的每个英文文档都与一个 `.zh.md` 镜像和一个 `.i18n.yaml` 一致性记录配对，而只要某个英文小节改动却没有把镜像一并带上，`pnpm run verify-translation-pairing` 立即失败。手工保持该对同步——把改动的小节拼接进镜像、重写记录、并保持在文档预算内——正是主导本次插件套件集成的重复劳动，而一个编辑文档的模型没有对应工具：它要么手工做这套多步拼接，要么让该对悄然漂移直到门禁稍后发现。

## Decision

`@deepseek-ai/dsh-plugin-doc-sync-automator` 注册一个面向模型的工具 `sync_bilingual_pair({ docPath, updatedSection: { heading } })`，它把改动的英文小节拼接进其 `.zh.md` 镜像，包在 `NEEDS-TRANSLATION` 标记后（它**不**翻译——拼接内容是原样英文文本），重写 `.i18n.yaml` 记录使配对门禁接受结果，并报告镜像是否仍在其文档预算内。`derivePairPaths` 在任何 resolve 之前拒绝绝对路径或穿越路径的 `docPath`，因为派生的镜像与 sidecar 路径是被写入的——仓库相对的源路径是契约，逃逸路径会被失败即报错地拒绝。若拼接会破坏标题轴的结构对应，则拒绝拼接，因此既有的配对漂移无法被掩盖。它只注入 `tools`，在 `config.root`（默认 cwd）下读写。

该插件从并行分支（`feat/plugin-doc-sync-automator`）到来时没有 Agent Note、也没有路径穿越守卫；两者都在集成时补齐，插件已在当前 master 上以标准集成接线重建。

## Alternatives considered

**翻译该小节，而不只是拼接。** harness 没有离线翻译器，机器翻译质量参差；诚实的契约是保持该对门禁有效的结构拼接，并留下带标记的英文供人工译者处理，恰好与配对记录的 NEEDS-TRANSLATION 债务既有工作方式一致。

**跳过穿越守卫，仅依赖 `config.root`。** `resolve(root, '../../x')` 仍会逃逸 root；模型提供的 `docPath` 是写入的不受信输入，因此守卫在任何文件系统调用之前、在字符串层面拒绝它。

## Consequences

编辑英文文档的模型可以一次调用就让其镜像保持门禁有效，把多步手工拼接变成单个工具。镜像携带可见的 NEEDS-TRANSLATION 债务直到有人翻译，因此该对绝不会悄然出错；预算越界被报告而非强制。穿越守卫意味着该工具只可能写在仓库内部。
