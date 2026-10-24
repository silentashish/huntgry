import type { ApplicationRecord } from './applications-types'
import type { Board, BoardCard } from './board'
import type { JobSourceId } from './jobs-types'

/**
 * The Board's search and source filter (#160). It narrows every column at once, and the column
 * counts are taken after it. Pure, for tests; #161 moves the Dashboard table's search here, so
 * new criteria (the Archived filter, a status) are added as fields of `BoardFilter`.
 */

/** The sources the Board filters on, in menu order. */
export const BOARD_SOURCES = ['jobright', 'url', 'pasted', 'hiring.cafe', 'indeed'] as const satisfies readonly JobSourceId[]
export type BoardSource = (typeof BOARD_SOURCES)[number]

export const BOARD_SOURCE_LABEL: Record<BoardSource, string> = {
  jobright: 'Jobright',
  url: 'Link',
  pasted: 'Pasted',
  'hiring.cafe': 'hiring.cafe',
  indeed: 'Indeed'
}

export interface BoardFilter {
  /** Matched, case-insensitively, against company, role, title and notes. Blank matches all. */
  text: string
  /** Empty = every source, and cards whose source is unknown. */
  sources: BoardSource[]
}

export const EMPTY_BOARD_FILTER: BoardFilter = { text: '', sources: [] }

export const isFilterActive = (f: BoardFilter): boolean => f.text.trim() !== '' || f.sources.length > 0

const isBoardSource = (s: string | undefined): s is BoardSource => (BOARD_SOURCES as readonly string[]).includes(s ?? '')

/**
 * Where a card's job came from: the saved job's source, else the application's recorded one.
 * `null` when not known (an application made outside the app, a run whose job was removed).
 */
export function cardSource(card: BoardCard): BoardSource | null {
  if (card.job) return isBoardSource(card.job.source) ? card.job.source : null
  if (card.kind === 'application') return isBoardSource(card.app.tracking.source) ? card.app.tracking.source : null
  return null
}

/** The text an application is searched by: company, role, job title and notes. */
export function applicationSearchText(app: ApplicationRecord): string[] {
  return [app.company, app.role, app.jobTitle, app.tracking.notes]
}

/** The text a card is searched by: its title and subtitle, plus its application's or job's fields. */
export function cardSearchText(card: BoardCard): string[] {
  const out = [card.title, card.subtitle]
  if (card.job) out.push(card.job.company, card.job.title)
  if (card.kind === 'application') out.push(...applicationSearchText(card.app))
  if (card.kind === 'queue') out.push(card.item.title)
  return out
}

export function matchesBoardFilter(card: BoardCard, f: BoardFilter): boolean {
  if (f.sources.length > 0) {
    const source = cardSource(card)
    if (!source || !f.sources.includes(source)) return false
  }
  const q = f.text.trim().toLowerCase()
  return !q || cardSearchText(card).some((s) => s.toLowerCase().includes(q))
}

/** The board with only the cards that match, in every column; `hiddenArchived` is unchanged. */
export function filterBoard(board: Board, f: BoardFilter): Board {
  if (!isFilterActive(f)) return board
  return { ...board, columns: board.columns.map((c) => ({ ...c, cards: c.cards.filter((card) => matchesBoardFilter(card, f)) })) }
}
