# @deepseek-ai/dsh-web-fetch-http

English | [中文](README.zh.md)

An anonymous public HTTP(S) `WebFetchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It retrieves a concrete URL and returns a status code plus bounded decoded content.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the key and it does not register a model-facing tool. It is a function/namespace plugin (`inject: ['web']`).

## Responsibility split

The provider owns **safe resource retrieval**: URL validation, HTTP transport, redirect policy, a resource-backstop timeout, abort propagation, byte caps, charset decoding, content-type classification, and binary rejection. `@deepseek-ai/dsh-tool-web` owns **presentation** (HTML→markdown, truncation formatting). A non-2xx HTTP response is a *result* (status code + decoded body), not an error; `WebError` is reserved for failures to safely retrieve or represent the resource.

The provider's `timeoutMs` is a resource backstop for direct `ctx.web.fetch()` callers and misconfigured deployments, not the model-facing tool-call budget. [`dsh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md) owns the `web_fetch` tool-call budget by arming `exec.signal`.

A shipping web-tool deployment sets the provider backstop above the tool budget, so model calls normally return `TOOL_TIMEOUT`. If the outer deadline reaches the provider first, the provider reports `WEB_ABORTED` and the outer policy replaces it with `TOOL_TIMEOUT`. `WEB_FETCH_TIMEOUT` therefore identifies a direct service caller whose provider budget elapsed.

## Transport hygiene

- Accepts only `http:` and `https:` URLs; rejects credentials in URLs (`WEB_BLOCKED_URL`) and over-long/malformed URLs (`WEB_INVALID_URL`).
- Enforces a max URL length, response byte cap (`WEB_FETCH_TOO_LARGE`), decoded body character cap, timeout (`WEB_FETCH_TIMEOUT`), and redirect hop cap.
- Propagates the caller's abort signal (`WEB_ABORTED`) into the network request and the streaming read.
- Follows only **same-origin** redirects; a cross-origin redirect fails with `WEB_REDIRECT_BLOCKED`, requiring a fresh tool call (the model of Claude Code's WebFetch).
- Refuses a private, loopback, link-local, carrier-grade-NAT, or otherwise non-globally-routable destination (`WEB_BLOCKED_PRIVATE_NETWORK`) — see [Private-network blocking](#private-network-blocking).
- Sends an explicit product `User-Agent`, never a browser disguise.
- Rejects unsupported (e.g. binary) content types with `WEB_UNSUPPORTED_CONTENT_TYPE`.

## Private-network blocking

On by default (`Config.blockPrivateNetworks`, default `true`). Before the initial request and again before following each redirect hop:

- A literal IP hostname (`http://127.0.0.1/`, `http://[::1]/`) is classified directly.
- A DNS hostname is resolved (`dns.lookup(hostname, { all: true })`) and **every** returned address is classified; one private address among several public ones still refuses the request.
- A classified address in a private (RFC 1918), loopback, link-local (including the `169.254.169.254` cloud-instance-metadata endpoint), carrier-grade-NAT (RFC 6598), IETF-protocol-assignment, documentation/benchmarking, multicast, or reserved/unspecified range throws `WEB_BLOCKED_PRIVATE_NETWORK`. An IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) is classified by its embedded IPv4 address.
- Re-running the check on the redirect target (not just the initial URL) catches a same-origin hostname whose DNS records changed between hops, not only a cross-origin redirect (which `WEB_REDIRECT_BLOCKED` already refuses regardless of destination).

A deployment that deliberately needs this provider to reach internal network targets sets `blockPrivateNetworks: false`.

**Known residual gap**: the address this check validates is not the address the subsequent `fetch()` connects to — `fetch()` re-resolves DNS independently moments later. A hostname whose DNS record changes between this check and that connection (DNS rebinding) is not defended against; see [the private-network blocking Agent Note](../../../.agents/notes/implemented/feature/2026-08-20-web-fetch-http-private-network-blocking.md) for what would close that gap. DNS resolution for this check also does not observe the request's timeout or abort signal, so a slow or hung resolver can extend a request past its configured `timeoutMs`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `maxUrlLength` | `2048` | Maximum accepted request URL length. |
| `maxResponseBytes` | `5_000_000` | Maximum response body size in bytes. |
| `maxBodyChars` | `100_000` | Maximum decoded body length in characters. |
| `timeoutMs` | `30_000` | Fetch timeout within Node's timer range — a resource backstop for direct `ctx.web.fetch()` callers, not the model-facing tool-call budget (that is `dsh-tool-call-timeout-policy`). |
| `maxRedirects` | `5` | Maximum same-origin redirect hops (`0` follows none). |
| `userAgent` | `deepseek-harness/…` | `User-Agent` header. |
| `blockPrivateNetworks` | `true` | Refuse a private/loopback/link-local/non-public destination — see [Private-network blocking](#private-network-blocking). |

The numeric limits are validated at plugin construction: every cap except `maxRedirects` must be a positive finite number, and `maxRedirects` must be a non-negative integer. An invalid value throws rather than silently constructing a provider with nonsensical limits.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which places this provider's `maxBodyChars`-bounded decoded text or markdown-shaped HTML under its fetch-result wrapper and retains provider failures while redirects, headers, and transport mechanics remain hidden.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Private-network blocking does not pin the validated address into the connection** — see [Private-network blocking](#private-network-blocking) for the DNS-rebinding gap this leaves and the deployments it does not fully protect.
- **Only textual content decodes** — html/xhtml and `text/*`-plus-JSON/XML families; a missing `Content-Type` or any binary type throws `WEB_UNSUPPORTED_CONTENT_TYPE`, and text-extractable PDF decoding is named deferred work.
- **Charset comes only from the `Content-Type` header** (UTF-8 default) — an HTML `<meta charset>` declaration is ignored, and a declared-but-unrecognized charset label throws rather than falling back.
