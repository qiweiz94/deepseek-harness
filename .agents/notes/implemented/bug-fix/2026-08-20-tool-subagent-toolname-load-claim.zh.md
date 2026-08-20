# Agent Note：tool-subagent 在插件加载时认领其 toolName

Status: implemented

[English](2026-08-20-tool-subagent-toolname-load-claim.md) | 中文

## 问题

两个配置了相同 `toolName`、且其提供方尚未注册的 `tool-subagent` 实例，之前只会在 `subagent/provider-added` 分发内部相撞：那里的重复名称 `tools.register` 抛出会回滚提供方注册本身，于是一个配置错误的等待实例可能拖垮两个实例共同依赖的后端（`TODO(subagent-dup-toolname)`）。可继续实例更早失败只是其 `tool:<name>` 提示词 section 预留的副作用；一次性实例完全没有加载期认领。

## 决定

一个按根上下文划分的意图注册表——模块级 `WeakMap<Context, Set<string>>`，以 `ctx.root` 为键，即 `mcp-client` 的 `serverName` 模式——在 `apply()` 开头的 `ctx.effect` 中认领 `toolName`，先于任何监听器、section 或工具注册。重复名称会让第二个实例在插件加载时失败，并给出指明配置键的可操作错误；较早的实例与之后的提供方注册保持完好。effect 的销毁器释放认领，因此 HMR 替换可以复用该名称。与其他插件注册的工具之间的跨插件冲突仍在挂载时经由 `tools.register` 暴露。

## 考虑过的替代方案

- 为一次性实例注册空提示词 section 作为预留：把无关注册表当作锁使用，且其重复错误指向提示词 section 而非工具配置。
- 在 `ctx.tools` 上增加预留 API：为单个消费者的配置错误扩展服务契约；seam 设计规则要求消费者特有行为留在消费者内。
- 保留延迟抛出：保留提供方注册回滚，即缺陷本身。

## 后果

重复名称的错误配置现在在所有模式组合下都会在加载时响亮失败，等待实例的冲突再也不能回滚提供方。该注册表有意保持进程内：它隔离互不相关的根上下文（测试），不增加任何持久或跨进程状态。
