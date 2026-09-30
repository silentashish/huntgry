import type { SearchSource } from '@shared/jobs-types'
import { isLoopbackUrl } from '../cli/dev-urls'
import { isPackagedBuild } from '../cli/env'
import { HIRINGCAFE_ORIGIN } from './sources/hiringcafe'
import { INDEED_ORIGIN } from './sources/indeed'

/**
 * Where each job board lives. The end-to-end tests point a board at a mock
 * server on `127.0.0.1` through an environment variable, in the spirit of
 * `HUNTGRY_ALLOW_LOCAL_URLS` (cli/dev-urls.ts): only in an unpackaged build,
 * and only a loopback http(s) origin is accepted, so the variable can never
 * send a search to another site. Packaged builds ignore it.
 */

export const BOARD_ORIGIN_ENV: Record<SearchSource, string> = {
  'hiring.cafe': 'HUNTGRY_JOB_BOARD_BASE_URL_HIRINGCAFE',
  indeed: 'HUNTGRY_JOB_BOARD_BASE_URL_INDEED'
}

const DEFAULT_ORIGIN: Record<SearchSource, string> = {
  'hiring.cafe': HIRINGCAFE_ORIGIN,
  indeed: INDEED_ORIGIN
}

/** The board's origin (`https://hiringcafe.com`), or the loopback override of a dev/test build. */
export function boardOrigin(
  board: SearchSource,
  env: NodeJS.ProcessEnv = process.env,
  isPackaged: boolean = isPackagedBuild()
): string {
  const value = env[BOARD_ORIGIN_ENV[board]]?.trim()
  if (isPackaged || !value || !isLoopbackUrl(value)) return DEFAULT_ORIGIN[board]
  return new URL(value).origin
}
