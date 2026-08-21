# Agent Note：每会话 hooks.json 发现采用默认拒绝，置于工作区信任门之后

Status: implemented

[English](2026-08-20-hooks-session-discovery-trust-gate.md) | 中文

## 问题

两个 hook 桥接（`@deepseek-ai/dsh-hooks-claude-code`、`@deepseek-ai/dsh-hooks-codex`）都支持可选的 `sessionConfigFile`——按会话发现的项目本地 `hooks.json`，相对于每个会话的工作区 cwd 解析，在首次使用 hook 时读取一次。共享的发现缓存（`@deepseek-ai/dsh-hook-protocol` 中的 `createSessionHookConfigCache`）会为**任何**会话 cwd 读取并运行该文件，没有任何信任门。`hooks.json` 会在任何用户操作之前运行任意 shell（`PreToolUse`、`SessionStart` 等），因此在一个新克隆、不受信任的仓库中打开的会话可以植入一个 `hooks.json`，在 agent 一接触该工作区时就执行——这是一个无需用户选择加入、也不产生任何信号的代码执行漏洞。

## 决策

将每会话发现改为**默认拒绝**，置于一个显式的工作区信任谓词之后。

- `createSessionHookConfigCache` 新增两个选项：可选的 `isWorkspaceTrusted(cwd): boolean` 谓词，以及**必需的** `warnUntrusted(cwd, agentId)` 回调。在读取会话文件之前，缓存会检查该谓词；谓词缺失或返回 `false` 时，会完全跳过读取（植入的文件永远不会被打开），警告一次，并为该 agent 缓存 `empty`。`warnUntrusted` 是必需的（而非可选），因此 TypeScript 会在任何忘记接线它的桥接调用点上使构建失败——强制来自类型，而非评审者的谨慎。
- 新导出的辅助函数 `workspaceTrustPredicate(roots, launchCwd)` 构建桥接传入的谓词：未配置任何根时返回 `undefined`（因此缓存不信任任何内容），否则返回一个谓词，信任等于某个部署配置根、或嵌套在其之下的会话 cwd（每个根根据进程启动 cwd 解析）。包含关系由 `resolve` 后的 `path.relative` 决定——`..` 前缀或绝对的相对结果（不同的 Windows 盘符）即在根之外。
- 两个桥接新增 `trustedWorkspaceRoots: string[]` 配置字段（默认 `[]`）。桥接调用 `workspaceTrustPredicate(config.trustedWorkspaceRoots, process.cwd())`，并将谓词（仅在其有定义时）连同一个带桥接前缀的 `warnUntrusted` 传入缓存。默认 `[]` ⇒ 谓词为 `undefined` ⇒ 拒绝每个工作区，因此部署必须先命名一个受信任的根，任何项目本地 hook 才会运行。

信任按解析后的路径匹配，**不做**符号链接解析：根必须以会话报告其 cwd 的相同形式列出（例如在 macOS 上用 `/private/tmp/proj`，而非 `/tmp/proj`）。这会失败即拒绝——不匹配时拒绝而非过度信任——并在两个 README 中与「相对根根据环境隐含的进程启动 cwd 解析，因此绝对根是稳健形式」这一说明一并记录。

## 考虑过的替代方案

- **默认允许，配合选择退出的拒绝名单**——拒绝：颠倒了安全默认。整个缺陷就在于发现无需任何人选择加入即运行；拒绝名单让每个尚未命名的工作区继续暴露漏洞。
- **匹配前解析符号链接（`realpath`）**——本次变更拒绝：如果 `realpath` 与会话记录 cwd 的方式不一致，它会把失败即拒绝的不匹配变成失败即放行的风险，并在一个安全决策上增加一次文件系统 stat。以报告形式列出根是有文档、可预测的约定；若某个具体部署确有需要，可再引入 realpath 归一化。
- **让 `warnUntrusted` 可选**——拒绝：可选的警告会被桥接悄悄遗忘，把一次安全跳过变成一次不可见的跳过。类型上必需意味着每个当前与未来的桥接都必须处理被拒绝的路径。
- **把信任检查放在各桥接内而非共享缓存中**——拒绝：读取发生在共享缓存中，因此门必须置于读取所在处，否则某个替代调用方会绕过它（`packages/AGENTS.md`：「在做出决定的操作中强制该决定」）。

## 后果

- 设置了 `sessionConfigFile` 但未设置 `trustedWorkspaceRoots` 的现有部署会停止运行项目本地 hook，并为每个工作区发出一次性警告。没有任何已发布的 `cordis.yml`（已检查：`examples/`、bundle、preset）设置 `sessionConfigFile`，也没有 keyless 快照演练会话发现，因此仓库内没有任何东西以损坏状态发布，也无需重新录制快照。
- 已有的七个桥接／缓存发现测试被更新为配置一个受信任的根（编码「发现对*受信任工作区*有效」），新增测试覆盖默认拒绝、谓词返回 `false`，以及 `workspaceTrustPredicate` 辅助函数（精确／嵌套／父级／同级）。预发布立场（`CLAUDE.md`：基础优先于兼容，无外部消费者）认可这一破坏性默认。
- 未来新增项目本地发现的桥接，只需接线这两个缓存选项即可免费继承该门；编译器会拒绝忽略 `warnUntrusted` 的接线。
