import { useCallback, useMemo, useState } from 'react'

/**
 * Which week groups the user opened or folded on the Board (#160), by `foldKey` (column and
 * week), kept in localStorage like the colour scheme: a local preference that survives a restart.
 * Each choice records when it was last made; choices nobody has touched for a long time are
 * pruned, whatever the age of the week they are about (an old week can still be on the board).
 */

export const FOLDS_STORAGE_KEY = 'huntgry-board-folds'

/** Choices not made again for this long are dropped when the folds are saved. */
const KEEP_DAYS = 400

/** A stored choice: folded or not, and when it was made (ms). */
export interface FoldChoice {
  folded: boolean
  at: number
}

export type StoredFolds = Record<string, FoldChoice>

/** Reads the stored choices; a choice saved as a bare boolean (the first version) counts as made now. */
export function readFolds(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage, now = Date.now()): StoredFolds {
  try {
    const raw = JSON.parse(storage?.getItem(FOLDS_STORAGE_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: StoredFolds = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'boolean') out[k] = { folded: v, at: now }
      else if (v && typeof v === 'object' && typeof v.folded === 'boolean' && Number.isFinite(v.at)) out[k] = { folded: v.folded, at: v.at }
    }
    return out
  } catch {
    return {}
  }
}

/** `folds` without the choices last made more than `KEEP_DAYS` ago. */
export function pruneFolds(folds: StoredFolds, now = Date.now()): StoredFolds {
  const cutoff = now - KEEP_DAYS * 86_400_000
  return Object.fromEntries(Object.entries(folds).filter(([, c]) => c.at >= cutoff))
}

export function writeFolds(folds: StoredFolds, storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage, now = Date.now()): void {
  try {
    storage?.setItem(FOLDS_STORAGE_KEY, JSON.stringify(pruneFolds(folds, now)))
  } catch {
    // Storage full or unavailable: the choice holds until the page is left.
  }
}

/** The stored folds (folded or not, by key) and a setter that saves them. */
export function useFolds(): [Record<string, boolean>, (key: string, folded: boolean) => void] {
  const [stored, setStored] = useState<StoredFolds>(() => readFolds())
  const folds = useMemo(() => Object.fromEntries(Object.entries(stored).map(([k, c]) => [k, c.folded])), [stored])
  const set = useCallback((key: string, folded: boolean) => {
    setStored((cur) => {
      const next = { ...cur, [key]: { folded, at: Date.now() } }
      writeFolds(next)
      return next
    })
  }, [])
  return [folds, set]
}
