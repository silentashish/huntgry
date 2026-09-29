import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/**
 * Guards main-process fetches of user-supplied URLs (job postings) against
 * reaching the local machine or the private network (SSRF), including via
 * redirects: every hop goes through `assertPublicUrl`.
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

/**
 * Throws unless `url` is http(s) on a public host: not `localhost`, not a
 * private IP literal, and not a name that resolves to one.
 */
export async function assertPublicUrl(url: string, resolve: ResolveHost = resolveHost): Promise<URL> {
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
    return parsed
  }
  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch {
    throw new Error(`Could not find ${parsed.host}.`)
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw refuse()
  return parsed
}
