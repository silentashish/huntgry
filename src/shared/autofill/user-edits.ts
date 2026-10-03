/**
 * Which fields the person changed after Huntgry wrote them (#63 review): the
 * verify passes must keep those, and restore only what the page itself wiped
 * (hydration) or replaced (a resume parser). An edit is an `input` / `change`
 * event that Huntgry did not fire itself; in the tab's preload only trusted
 * (keyboard, paste) events count, so the page's own scripts are not users.
 */

const watched = new WeakSet<Document>()
const edited = new WeakSet<Element>()
/** Depth of Huntgry's own writes: their synchronous events are never the user's. */
let writing = 0

export interface UserEditOptions {
  /** Which events come from the person (default: `isTrusted`; jsdom tests pass their own). */
  isUserEvent?: (event: Event) => boolean
}

/** Starts noting user edits in `doc` (once per document; the first options win). */
export function watchUserEdits(doc: Document, { isUserEvent = (e) => e.isTrusted }: UserEditOptions = {}): void {
  if (watched.has(doc)) return
  watched.add(doc)
  const note = (event: Event) => {
    const target = event.target as Element | null
    if (writing === 0 && target && typeof target.tagName === 'string' && isUserEvent(event)) edited.add(target)
  }
  doc.addEventListener('input', note, true)
  doc.addEventListener('change', note, true)
}

/** Whether the person edited `el` since it was watched. */
export function editedByUser(el: Element): boolean {
  return edited.has(el)
}

/** Runs one of Huntgry's own writes; the events it fires are not user edits. */
export function asHuntgry<T>(write: () => T): T {
  writing++
  try {
    return write()
  } finally {
    writing--
  }
}
