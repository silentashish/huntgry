import { isLoopbackUrl, localUrlsAllowed } from '../cli/dev-urls'
import { JOBRIGHT_API_URL } from './api'
import { JOBRIGHT_HOSTS, JOBRIGHT_NEW_GRAD_README } from './parse'

/**
 * The e2e harness serves a fixture API and README from its mock server: with `HUNTGRY_EXPLORE_API_URL` and
 * `HUNTGRY_EXPLORE_SOURCE_URL` set to loopback URLs (and `HUNTGRY_ALLOW_LOCAL_URLS=1`), an unpackaged build reads
 * the lists from there and accepts job links on those hosts. A packaged build, or any other value, reads the real
 * API and the one GitHub URL. Each override stands on its own: a non-loopback one is ignored.
 */
export const EXPLORE_SOURCE_ENV = 'HUNTGRY_EXPLORE_SOURCE_URL'
export const EXPLORE_API_ENV = 'HUNTGRY_EXPLORE_API_URL'

export function exploreSource(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): { apiUrl: string; readmeUrl: string; hosts: readonly string[] } {
  const local = (name: string) => {
    const v = env[name]
    return v && localUrlsAllowed(isPackaged, env) && isLoopbackUrl(v) ? v : null
  }
  const api = local(EXPLORE_API_ENV)
  const readme = local(EXPLORE_SOURCE_ENV)
  const extra = [api, readme].filter((u): u is string => u !== null).map((u) => new URL(u).host.toLowerCase())
  return {
    apiUrl: api ?? JOBRIGHT_API_URL,
    readmeUrl: readme ?? JOBRIGHT_NEW_GRAD_README,
    hosts: [...new Set([...JOBRIGHT_HOSTS, ...extra])]
  }
}
