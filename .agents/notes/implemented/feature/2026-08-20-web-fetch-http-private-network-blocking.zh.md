# Agent Note: web-fetch-http 默认阻断私有网络目的地

Status: implemented

[English](2026-08-20-web-fetch-http-private-network-blocking.md) | 中文

## 问题

`dsh-web-fetch-http` 会获取调用方提供的任意 `http(s)` URL，除了 `validateFetchUrl` 已经强制执行的凭证/协议卫生检查外，没有任何针对目的地址的检查。它自己的模块文档以及 [web 能力 seam Agent Note](../architecture/2026-06-24-web-capability-seam.md) 都明确指出了这一点："该提供方是一个 SSRF 原语，禁止在能触达敏感内部网络目标的部署中启用。" 一个可以使用 `web_fetch` 的模型可以触达 `169.254.169.254`（大多数云厂商向主机上任意进程暴露的实例元数据端点）、RFC 1918 私有范围、loopback 及其他仅限内部使用的地址，而该提供方会像获取一个公开页面一样把它们获取回来。

## 决定

`HttpFetchProvider` 新增了一项私有网络检查 `assertPublicDestination`，会在最初的请求 URL 上运行，并在跟随每一个重定向目标之前再次运行——不只是第一跳；因此即便 `isSameOrigin` 已经无论目的地如何都会拒绝跨源重定向，同源主机名仍会被重新检查：

- 字面量 IP 主机名（`http://127.0.0.1/`、`http://[::1]/`）通过 `net.isIP` 直接分类，并去掉 `URL.hostname` 为 IPv6 字面量保留的 `[...]` 方括号。
- DNS 主机名会用 `dns.promises.lookup(hostname, { all: true, order: 'verbatim' })` 解析，并逐个分类每一条返回的地址——多条公网地址中混入一条私有记录依然会拒绝该请求，而不是只检查单结果查询本会返回的那一个地址。
- 分类逻辑（`policy.ts` 中的 `isPrivateNetworkAddress`）借助 `node:net` 内置的 `BlockList`，把地址与一份固定的 IANA 特殊用途范围表对照：RFC 1918 私有空间、loopback、link-local（覆盖了云元数据端点）、RFC 6598 运营商级 NAT、IETF 协议保留、文档/基准测试范围、多播，以及保留/未指定空间。`BlockList.check(address, 'ipv6')` 会自动按 IPv4 映射的 IPv6 地址（`::ffff:10.0.0.5`）内嵌的 IPv4 地址来分类，因此无需单独添加映射地址规则。这些范围是固定的协议常量（CLAUDE.md："协议常量、外部规范与安全不变量保持固定"），不是配置项。
- 被阻断的目的地会抛出 `WebError` `WEB_BLOCKED_PRIVATE_NETWORK`，并指明已解析的地址与被请求的主机。
- DNS 解析失败（主机无法解析）会抛出 `WEB_PROVIDER_ERROR`，与此变更之前一个无法解析的主机已经会通过 `fetch()` 自身的网络错误失败的方式一致。

该检查是一个 `Config` 字段 `blockPrivateNetworks`，默认值为 `true`（schemastery 的 `.default(true)`，与此包既有的显式默认模式一致——这里的每一个其他限制都以同样方式给出默认值，因此没有调用方能观察到未设置默认值的字段）。确实需要该提供方触达内部目标的部署可将其设为 `false`。默认收紧而不是需要显式选择加入才能开启保护，正是这个设计的要点：一个启用了 `web_fetch` 的部署默认受保护，除非明确选择退出，而不是默认暴露，除非明确选择加入。

## 考虑过的替代方案

- **把已验证的地址钉入实际连接**（一个自定义的 `fetch()` dispatcher/agent，其 `lookup` 只返回已验证的地址，同时仍然把原始主机名用于 TLS SNI 与 `Host` 头）——这正是能够彻底防御验证与连接之间的 DNS rebinding 的做法，也正是 web 能力 seam Agent Note 最初的"推迟工作"条目所要求的。本次未做：它需要这个包目前没有先例可循的连接期 DNS 覆盖管线（仓库中没有可参照的既有 `node:dns`/自定义 dispatcher 用法），而由此留下的残留缺口——一次被限定在本检查与 `fetch()` 自身解析之间这条狭窄窗口内的 rebind——相比本次变更所关闭的缺口（此前完全没有私有网络检查）要小得多。已记录为仍然开放的[推迟工作条目](../architecture/2026-06-24-web-capability-seam.md#deferred-work)，而不是悄悄不提。
- **仅做主机名字符串黑名单**（匹配字面量 `localhost`/`127.*` 字符串，不做 DNS 解析）——已拒绝：任何攻击者可控的、A/AAAA 记录指向私有地址的 DNS 名称都能绕过它，而这正是该检查要阻止的 SSRF 手法本身，不是它的边缘情形。
- **仅做 IP 字面量检查，不做 DNS 解析**——因同样原因拒绝；这只能满足任务已知错误列表中字面量 IP 的那一半，而把所有基于 DNS 主机名的 SSRF 途径留在敞开状态。
- **用针对具体主机名/CIDR 的私有网络白名单取代单一开关**——作为未被请求的能力面推迟：当前没有消费方需要部分访问（部分内部目标可达、其他不可达），且 CLAUDE.md 的"在没有当前消费方证据的情况下，可配置性不能成为支持某种……格式的理由"这一原则不支持投机性地构建它。布尔值是任务"可通过配置切换"要求所需的最小配置面。
- **一个经维护的 IP 范围检查依赖**（例如做 CIDR 匹配的 npm 包）——拒绝，转而使用 `node:net` 内置的 `BlockList`：它本身已经是经维护的（Node 核心），对一项安全敏感的检查无需引入新的供应链信任，而且范围表本身是一份小型、固定、有据可查的清单，这个包完全可以自行维护。

## 后果

- `web_fetch`（以及任何直接的 `ctx.web.fetch()` 调用方）默认拒绝 `169.254.169.254`、RFC 1918 范围、loopback（IPv4 与 IPv6）及其他 IANA 特殊用途范围，关闭了 seam Agent Note 标记为该 harness 主要 SSRF 暴露面的缺口。
- 依赖该提供方触达内部目标的部署现在必须显式设置 `blockPrivateNetworks: false`；三个既有测试套件和两份 `examples/acp-agent` Cordis 配置，因为出于确定性、无外部网络测试的目的而故意以 loopback 固件服务器为目标，都需要恰好这一项覆盖设置（`packages/web/tool-web/tests/integration.spec.ts`、`packages/web/tool-web/tests/spill.spec.ts`、`packages/web/web-fetch-http/tests/fetch-http.spec.ts` 的共享固件、`examples/acp-agent/web.cordis.yml`、`examples/acp-agent/web.cordis.snapshot.yml`）——这些都不属于与 SSRF 相关的行为，因此这项覆盖设置是正确的修复，而非权宜之计。
- 本检查与真实连接之间的 DNS rebinding 仍未关闭（见"考虑过的替代方案"）；把该提供方当作完整 SSRF 防御手段的部署应当阅读 README 中关于该残留缺口的说明。
- 本检查自身的 DNS 查询不遵循请求的超时或中止信号（`dns.promises.lookup` 不接受 `AbortSignal`），因此一个缓慢或挂起的解析器可能让请求超出其配置的 `timeoutMs`。这一点在包 README 中做了披露，而非在此解决——要妥善解决它，需要与弥补 rebinding 缺口相同的连接期覆盖管线，超出了本次变更的范围。
- `tests/fetch-http.spec.ts` 覆盖了任务中列出的已知错误目的地字面量（`169.254.169.254`、`127.0.0.1`、一个 RFC 1918 地址、`::1`）、一次 DNS 记录在两跳之间发生变化的同源重定向（通过对 `node:dns/promises` 排队打桩来模拟，因为真实的 rebind 在 CI 中无法确定性复现）、一条已解析但为私有地址的 IPv6 记录、一次 DNS 解析失败、`blockPrivateNetworks: false` 的绕过开关，以及不带任何配置时的收紧默认值。按包划定范围的覆盖率（`packages/web/web-fetch-http/src`）达到语句/分支/函数/行 100%。
- 没有任何面向模型的工具 schema 发生变化（`web_fetch` 的参数与结果形态不变）；新的失败会经过每一个其他提供方错误码已经在用的同一条通用 `WebError` 到结构化工具错误的路径浮现，因此没有为该错误文本本身新增快照固件。既有的 `examples/acp-agent` `web-fetch` 快照（一条成功路径）在加上前述固件服务器覆盖设置后依然通过。
