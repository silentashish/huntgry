import { app } from 'electron'
import { refusalFor } from '../browser/url'
import { localUrlsAllowed, loopbackOnly } from '../cli/dev-urls'
import { settingsFile } from '../current-workspace'
import { loadAndExtract } from '../jobs/loader'
import type { JobrightAccount } from '@shared/explore-types'
import { createAccountState, createSignInLifecycle } from './account-state'
import type { LinkDeps } from './employer-link'
import { fetchReadme, postJson, type ExploreDeps } from './service'
import { exploreSource } from './source'

/** The app's one Jobright account state (#146), in `userData/settings.json`. */
export const accountState = createAccountState(settingsFile)

/** Connect / Disconnect coordination (`account.ts`); no employer link is looked up while Disconnect cleans up. */
export const signIn = createSignInLifecycle<JobrightAccount>()

/**
 * The same guard as the in-app browser and the posting loader: public hosts only (loopback only in a dev build
 * with the mock-server allowance, and nothing but loopback under the e2e harness).
 */
export const refusal = (url: string): Promise<string | null> =>
  refusalFor(url, undefined, localUrlsAllowed(app.isPackaged), loopbackOnly(app.isPackaged))

/**
 * What `addExplore` and Fetch full description use to look up employer links. The account generation is taken
 * now, before anything loads: a page that finishes after a Disconnect cannot mark the account connected again.
 */
export function linkDeps(): LinkDeps & { connected(): Promise<boolean> } {
  const generation = accountState.generation()
  return {
    load: loadAndExtract,
    hosts: exploreSource(app.isPackaged).hosts,
    refusal,
    onLogin: async (logined) => void (await accountState.record(logined, generation)),
    connected: async () => !signIn.disconnecting && (await accountState.read()).connected === true
  }
}

/** Explore's dependencies in the app: the API and README (or the e2e mock's), the guard and the employer-link lookup. */
export function exploreDeps(): ExploreDeps {
  return {
    ...exploreSource(app.isPackaged),
    postJson: (url, body) => postJson(url, body),
    fetchText: (url) => fetchReadme(url),
    refusal,
    link: linkDeps()
  }
}
