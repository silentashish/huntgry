import { isLoopbackUrl, localUrlsAllowed } from '../cli/dev-urls'
import { JOBRIGHT_HOSTS, JOBRIGHT_NEW_GRAD_README } from './parse'

/**
 * The e2e harness serves a fixture README from its mock server: with `HUNTGRY_EXPLORE_SOURCE_URL` set to a
 * loopback URL (and `HUNTGRY_ALLOW_LOCAL_URLS=1`), an unpackaged build reads the list from there and accepts
 * job links on that host. A packaged build, or any other value, reads the one GitHub URL.
 */
export const EXPLORE_SOURCE_ENV = 'HUNTGRY_EXPLORE_SOURCE_URL'

export function exploreSource(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): { sourceUrl: string; hosts: readonly string[] } {
  const override = env[EXPLORE_SOURCE_ENV]
  if (override && localUrlsAllowed(isPackaged, env) && isLoopbackUrl(override)) {
    return { sourceUrl: override, hosts: [...JOBRIGHT_HOSTS, new URL(override).host.toLowerCase()] }
  }
  return { sourceUrl: JOBRIGHT_NEW_GRAD_README, hosts: JOBRIGHT_HOSTS }
}
