import { useCallback, useState } from 'react'

/**
 * Which week groups the user opened or folded on the Board (#160), by `foldKey` (column and
 * week), kept in localStorage like the colour scheme: a local preference that survives a restart.
 * Only choices that differ from the default are worth keeping, and old weeks are pruned.
 */

export const FOLDS_STORAGE_KEY = 'huntgry-board-folds'

/** Choices about weeks older than this are dropped when the folds are saved. */
const KEEP_DAYS = 400

type Folds = Record<string, boolean>

export function readFolds(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage): Folds {
  try {
    const raw = JSON.parse(storage?.getItem(FOLDS_STORAGE_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'boolean')) as Folds
  } catch {
    return {}
  }
}

/** `folds` without the weeks older than `KEEP_DAYS` (keys end in the week's `YYYY-MM-DD`). */
export function pruneFolds(folds: Folds, now = new Date()): Folds {
  const cutoff = now.getTime() - KEEP_DAYS * 86_400_000
  return Object.fromEntries(
    Object.entries(folds).filter(([k]) => {
      const t = Date.parse(k.slice(k.indexOf(':') + 1))
      return !Number.isFinite(t) || t >= cutoff
    })
  )
}

export function writeFolds(folds: Folds, storage: Pick<Storage, 'setItem'> | null = globalThis.localStorage): void {
  try {
    storage?.setItem(FOLDS_STORAGE_KEY, JSON.stringify(pruneFolds(folds)))
  } catch {
    // Storage full or unavailable: the choice holds until the page is left.
  }
}

/** The stored folds and a setter that saves them. */
export function useFolds(): [Folds, (key: string, folded: boolean) => void] {
  const [folds, setFolds] = useState<Folds>(() => readFolds())
  const set = useCallback((key: string, folded: boolean) => {
    setFolds((cur) => {
      const next = { ...cur, [key]: folded }
      writeFolds(next)
      return next
    })
  }, [])
  return [folds, set]
}
