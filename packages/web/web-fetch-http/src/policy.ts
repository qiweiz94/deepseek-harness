/**
 * URL validation and content-type classification for the local HTTP(S) fetch
 * provider — the pure, network-free half. The provider's `fetch()` composes
 * these with transport (redirect following, byte caps, decoding).
 *
 * @module @deepseek-ai/dsh-web-fetch-http/policy
 */

import { BlockList, isIP } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'

/** The body kinds this provider decodes. */
export type FetchableKind = 'html' | 'text'

/**
 * Validate a request URL against the basic transport hygiene the provider
 * enforces before any network access: http(s) only, no embedded credentials,
 * bounded length. Returns the parsed `URL`. Throws {@link WebError} otherwise.
 * Destination address validation (private-network blocking) is separate —
 * see {@link literalAddressOf} and {@link isPrivateNetworkAddress} — because
 * it requires DNS resolution for a non-literal hostname and so is not
 * network-free like the rest of this module.
 *
 * @param input - the raw URL string from the fetch request.
 * @param maxUrlLength - inclusive upper bound on `input`'s length.
 * @returns the parsed `URL`.
 */
export function validateFetchUrl(input: string, maxUrlLength: number): URL {
  if (input.length > maxUrlLength) {
    throw new WebError(`URL exceeds the maximum length of ${maxUrlLength}`, 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/**
 * Two URLs are same-origin when scheme, hostname, and port match. A redirect
 * that crosses origins is refused so each new origin requires a fresh tool call
 * (and thus a fresh provider/permission decision).
 *
 * @param a - one of the two URLs to compare.
 * @param b - the other URL to compare.
 * @returns true when `a` and `b` share scheme, hostname, and port.
 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * Non-globally-routable IPv4/IPv6 ranges {@link isPrivateNetworkAddress} checks against: RFC 1918
 * private space, loopback, link-local (including the 169.254.169.254 cloud-instance-metadata
 * endpoint), carrier-grade NAT, IETF protocol assignments, documentation/benchmarking ranges,
 * multicast, and reserved/unspecified space (IANA IPv4 and IPv6 Special-Purpose Address
 * Registries). These are fixed protocol constants, not configuration — only whether the check
 * runs at all is a provider `Config` field.
 */
const PRIVATE_NETWORK_RANGES: ReadonlyArray<{ address: string; prefix: number; family: 'ipv4' | 'ipv6' }> = [
  { address: '0.0.0.0', prefix: 8, family: 'ipv4' }, // "this network" (RFC 791)
  { address: '10.0.0.0', prefix: 8, family: 'ipv4' }, // RFC 1918 private
  { address: '100.64.0.0', prefix: 10, family: 'ipv4' }, // RFC 6598 carrier-grade NAT
  { address: '127.0.0.0', prefix: 8, family: 'ipv4' }, // loopback
  { address: '169.254.0.0', prefix: 16, family: 'ipv4' }, // RFC 3927 link-local
  { address: '172.16.0.0', prefix: 12, family: 'ipv4' }, // RFC 1918 private
  { address: '192.0.0.0', prefix: 24, family: 'ipv4' }, // IETF protocol assignments
  { address: '192.0.2.0', prefix: 24, family: 'ipv4' }, // TEST-NET-1
  { address: '192.168.0.0', prefix: 16, family: 'ipv4' }, // RFC 1918 private
  { address: '198.18.0.0', prefix: 15, family: 'ipv4' }, // benchmarking
  { address: '198.51.100.0', prefix: 24, family: 'ipv4' }, // TEST-NET-2
  { address: '203.0.113.0', prefix: 24, family: 'ipv4' }, // TEST-NET-3
  { address: '224.0.0.0', prefix: 4, family: 'ipv4' }, // multicast
  { address: '240.0.0.0', prefix: 4, family: 'ipv4' }, // reserved, including the 255.255.255.255 broadcast address
  { address: '::', prefix: 128, family: 'ipv6' }, // unspecified
  { address: '::1', prefix: 128, family: 'ipv6' }, // loopback
  { address: 'fc00::', prefix: 7, family: 'ipv6' }, // RFC 4193 unique local
  { address: 'fe80::', prefix: 10, family: 'ipv6' }, // RFC 4291 link-local
  { address: 'ff00::', prefix: 8, family: 'ipv6' }, // multicast
]

/**
 * One shared, immutable rule set: `BlockList` has no mutation method this module calls after
 * construction, and checking an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) against it also
 * matches the embedded IPv4 address against the IPv4 rules above (Node's `net.BlockList`
 * behavior), so no separate mapped-address rule is needed.
 */
const privateNetworkBlockList = new BlockList()
for (const range of PRIVATE_NETWORK_RANGES) {
  privateNetworkBlockList.addSubnet(range.address, range.prefix, range.family)
}

/**
 * Whether `address` — a literal IP already known to be `family` (from
 * {@link literalAddressOf} or a DNS resolution result) — falls in a private,
 * loopback, link-local, carrier-grade-NAT, documentation/benchmarking,
 * multicast, or otherwise non-globally-routable range.
 * @param address - a literal IPv4 or IPv6 address, without brackets or a zone id.
 * @param family - the address family, as already determined by the caller.
 * @returns whether the address is non-public.
 */
export function isPrivateNetworkAddress(address: string, family: 4 | 6): boolean {
  return privateNetworkBlockList.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * The literal IP address a URL hostname already IS (unwrapping the `[...]`
 * brackets a URL puts around an IPv6 literal), or `undefined` when the
 * hostname is a DNS name that would need resolution to reach an address.
 * @param hostname - `URL.hostname` from an already-validated fetch URL.
 * @returns the literal address and its family, or `undefined` for a DNS name.
 */
export function literalAddressOf(hostname: string): { address: string; family: 4 | 6 } | undefined {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const family = isIP(unwrapped)
  if (family === 4 || family === 6) return { address: unwrapped, family }
  return undefined
}

/**
 * Classify a response `Content-Type` into a decodable body kind, or `undefined`
 * for an unsupported (e.g. binary) type. `text/html` and `application/xhtml+xml`
 * are `html`; other `text/*` plus a few structured text types are `text`.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none (unsupported).
 * @returns the decodable kind, or `undefined` for an unsupported type.
 */
export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/**
 * Extract the `charset` parameter from a response `Content-Type`, lower-cased,
 * or `undefined` when absent. The provider feeds this label to `TextDecoder`
 * so a non-UTF-8 response is decoded with its declared encoding rather than
 * silently mangled into replacement characters.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none.
 * @returns the lower-cased charset label, or `undefined` when none is declared.
 */
export function parseCharset(contentType: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1]?.trim().toLowerCase()
}

/**
 * Build a `TextDecoder` for the declared charset, falling back to UTF-8 when
 * none is declared. Throws {@link WebError} `WEB_UNSUPPORTED_CONTENT_TYPE` when
 * the label is present but not a charset `TextDecoder` recognizes — better to
 * fail loudly than return mojibake.
 *
 * @param charset - the declared charset label (from {@link parseCharset}), or
 *   `undefined` to default to UTF-8.
 * @returns a decoder for the declared (or defaulted) encoding.
 */
export function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch (error: unknown) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
  }
}
