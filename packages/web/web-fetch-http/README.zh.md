# @deepseek-ai/dsh-web-fetch-http

[English](README.md) | 中文

一个匿名公共 HTTP(S) `WebFetchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。它获取具体 URL，返回状态码和长度受限的解码内容。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有该键，也不注册面向模型的工具。它是函数／命名空间插件（`inject: ['web']`）。

## 职责拆分

提供方拥有**安全资源获取**：URL 验证、HTTP 传输、重定向策略、资源兜底超时、中止传播、字节上限、charset 解码、内容类型分类与二进制拒绝。`@deepseek-ai/dsh-tool-web` 拥有**呈现**（HTML→markdown、截断格式）。非 2xx HTTP 响应是*结果*（状态码 + 解码主体），不是错误；`WebError` 只用于无法安全获取或表示资源的失败。

提供方的 `timeoutMs` 是直接 `ctx.web.fetch()` 调用方和配置有误的部署所用的资源兜底，不是面向模型的工具调用预算。[`dsh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md) 拥有 `web_fetch` 工具调用预算，并让 `exec.signal` 在超时时触发，以强制执行该预算。

已交付的 web 工具部署会把提供方兜底设为高于工具预算，因此模型调用通常返回 `TOOL_TIMEOUT`。如果外层截止期限先于提供方的兜底超时触发，提供方会报告 `WEB_ABORTED`，外层策略再将其替换为 `TOOL_TIMEOUT`。因此，`WEB_FETCH_TIMEOUT` 表明直接服务调用方的提供方预算已经耗尽。

## 传输卫生

- 只接受 `http:` 和 `https:` URL；拒绝 URL 中的凭据（`WEB_BLOCKED_URL`）以及过长／格式错误的 URL（`WEB_INVALID_URL`）。
- 强制执行 URL 最大长度、响应字节上限（`WEB_FETCH_TOO_LARGE`）、解码主体字符上限、超时（`WEB_FETCH_TIMEOUT`）和重定向跳数上限。
- 把调用方的中止信号（`WEB_ABORTED`）传播到网络请求与流式读取。
- 只跟随**同源**重定向；跨源重定向以 `WEB_REDIRECT_BLOCKED` 失败，要求发起新的工具调用（沿用 Claude Code 的 WebFetch 模式）。
- 拒绝私有、loopback、link-local、运营商级 NAT 或其他非全局可路由的目的地（`WEB_BLOCKED_PRIVATE_NETWORK`）——见[私有网络阻断](#private-network-blocking)。
- 发送显式的产品 `User-Agent`，绝不伪装成浏览器。
- 不受支持的内容类型（例如二进制）以 `WEB_UNSUPPORTED_CONTENT_TYPE` 拒绝。

<a id="private-network-blocking"></a>

## 私有网络阻断

默认开启（`Config.blockPrivateNetworks`，默认 `true`）。在发起初次请求之前、以及在跟随每一跳重定向之前：

- 字面量 IP 主机名（`http://127.0.0.1/`、`http://[::1]/`）直接分类。
- DNS 主机名会被解析（`dns.lookup(hostname, { all: true })`），并**逐个**分类每一条返回的地址；多条公网地址中混入一条私有地址依然会拒绝该请求。
- 分类结果落在私有（RFC 1918）、loopback、link-local（包括云实例元数据端点 `169.254.169.254`）、运营商级 NAT（RFC 6598）、IETF 协议保留、文档/基准测试、多播或保留/未指定范围内的地址，会抛出 `WEB_BLOCKED_PRIVATE_NETWORK`。IPv4 映射的 IPv6 地址（`::ffff:127.0.0.1`）按其内嵌的 IPv4 地址分类。
- 在重定向目标上（而不仅仅是最初的 URL）重新运行该检查，可以捕获一个同源主机名在跳转之间 DNS 记录发生变化的情况，而不只是跨源重定向（后者无论目的地如何，都已被 `WEB_REDIRECT_BLOCKED` 拒绝）。

确实需要该提供方触达内部网络目标的部署可设置 `blockPrivateNetworks: false`。

**已知的残留缺口**：该检查所验证的地址，并不是随后 `fetch()` 实际连接的地址——`fetch()` 会在片刻之后独立地重新解析 DNS。一个 DNS 记录在此检查与那次连接之间发生变化的主机名（DNS rebinding）不在防御范围内；关于要弥补这个缺口需要做什么，见[私有网络阻断 Agent Note](../../../.agents/notes/implemented/feature/2026-08-20-web-fetch-http-private-network-blocking.md)。该检查所做的 DNS 解析也不遵循请求的超时或中止信号，因此一个缓慢或挂起的解析器可能让请求超出其配置的 `timeoutMs`。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `maxUrlLength` | `2048` | 接受的请求 URL 最大长度。 |
| `maxResponseBytes` | `5_000_000` | 响应主体最大字节数。 |
| `maxBodyChars` | `100_000` | 解码主体最大字符数。 |
| `timeoutMs` | `30_000` | Node 定时器范围内的抓取超时：直接 `ctx.web.fetch()` 调用方的资源兜底，而非面向模型的工具调用预算（后者属于 `dsh-tool-call-timeout-policy`）。 |
| `maxRedirects` | `5` | 同源重定向最大跳数（`0` 表示完全不跟随）。 |
| `userAgent` | `deepseek-harness/…` | `User-Agent` 标头。 |
| `blockPrivateNetworks` | `true` | 拒绝私有/loopback/link-local/非公开目的地——见[私有网络阻断](#private-network-blocking)。 |

数值限制会在插件构造时验证：除 `maxRedirects` 外，每个上限都必须是正的有限数；`maxRedirects` 必须是非负整数。无效值会抛出异常，不会静默构造限制荒谬的提供方。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.md) 间接影响；该工具把此提供方经 `maxBodyChars` 限制的解码文本或由 HTML 转换得到的 markdown 置于抓取结果包装层中，并保留提供方失败；重定向、标头与传输机制保持隐藏。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **私有网络阻断未把已验证的地址钉入连接**——见[私有网络阻断](#private-network-blocking)了解这留下的 DNS rebinding 缺口，以及它未能完全保护哪些部署。
- **只解码文本内容**：包括 html/xhtml 与 `text/*` 加 JSON/XML 家族；缺少 `Content-Type` 或任何二进制类型都会抛出 `WEB_UNSUPPORTED_CONTENT_TYPE`，可提取文本的 PDF 解码属于明确的暂缓工作。
- **charset 只来自 `Content-Type` 标头**（默认为 UTF-8）：HTML `<meta charset>` 声明会被忽略；声明但无法识别的 charset 标签会抛出异常，而非回退。
