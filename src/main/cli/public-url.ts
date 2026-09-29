import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'

/**
 * Guards main-process fetches of user-supplied URLs (job postings) against
 * reaching the local machine or the private network (SSRF), including via
 * redirects: every hop goes through `assertPublicUrl`, and `pinnedFetch`
 * connects only to the addresses that were checked, so a DNS answer that
 * changes between the check and the connection (DNS rebinding) cannot
 * redirect the request.
 */

const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8] // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

/** True for loopback, private, link-local and other non-public addresses (IPv4-mapped IPv6 included). */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped) return blocked.check(mapped, 'ipv4')
  const family = isIP(address)
  if (family === 0) return true
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export type ResolveHost = (hostname: string) => Promise<string[]>

export const resolveHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address)

/** A URL that passed `assertPublicUrl`, with the public addresses its host resolved to. */
export interface PublicTarget {
  url: URL
  addresses: string[]
}

/**
 * Throws unless `url` is http(s) on a public host: not `localhost`, not a
 * private IP literal, and not a name that resolves to one. Connect only to
 * the returned `addresses` (see `pinnedFetch`).
 */
export async function assertPublicUrl(url: string, resolve: ResolveHost = resolveHost): Promise<PublicTarget> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('The posting URL is not valid.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The posting URL must start with http:// or https://.')
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const refuse = () => new Error(`Refusing to load ${parsed.host}: it is a local or private-network address.`)
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw refuse()
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw refuse()
    return { url: parsed, addresses: [host] }
  }
  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch {
    throw new Error(`Could not find ${parsed.host}.`)
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw refuse()
  return { url: parsed, addresses }
}

/** A DNS lookup that answers every query with `address`, so the socket can only reach it. */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address)
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }])
    else callback(null, address, family)
  }
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * GET `url` over `node:http(s)`, connecting to `init.addresses[0]` whatever DNS
 * says now. The URL keeps its hostname, so the Host header, SNI and the TLS
 * certificate check are unchanged. Never follows redirects: they come back as
 * 3xx responses for the caller to check. The body is not decompressed, so no
 * `accept-encoding` is sent.
 */
export function pinnedFetch(
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string>; addresses: readonly string[] }
): Promise<Response> {
  const target = new URL(url)
  const address = init.addresses[0]
  if (!address) return Promise.reject(new Error('No address to connect to.'))
  const client = target.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method: 'GET',
      headers: init.headers,
      signal: init.signal,
      lookup: pinnedLookup(address)
    })
    req.on('error', reject)
    req.on('response', (res) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v)
      }
      const status = res.statusCode ?? 502
      const body = NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>)
      if (!body) res.resume()
      try {
        resolve(new Response(body, { status, headers }))
      } catch (err) {
        res.destroy()
        reject(err)
      }
    })
    req.end()
  })
}
