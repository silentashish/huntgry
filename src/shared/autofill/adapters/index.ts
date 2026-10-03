import { ashby } from './ashby'
import { generic } from './generic'
import { greenhouse } from './greenhouse'
import { lever } from './lever'
import type { Adapter } from './types'
import { workday } from './workday'

/**
 * The adapter registry. To add an ATS: write `adapters/<ats>.ts` exporting an
 * `Adapter` (see `types.ts` for the optional `ready`, `step`, `uploadOrder`,
 * `uploadGroup`, `uploadAttached` and `afterUpload` hooks), list it below
 * before `generic`, and add its fixture under `fixtures/`. A form the ATS
 * embeds in company pages is one entry in `src/shared/apply-embeds.ts`. The
 * engine, the preload and the apply service need no change.
 */
export const ADAPTERS: readonly Adapter[] = [greenhouse, lever, ashby, workday, generic]

export type { Adapter, UploadProbe } from './types'
export { ashby, generic, greenhouse, lever, workday }

/** The first adapter that recognises the page; `generic` always matches. */
export function adapterFor(url: URL, doc: Document): Adapter {
  return ADAPTERS.find((a) => a.matches(url, doc)) ?? generic
}

