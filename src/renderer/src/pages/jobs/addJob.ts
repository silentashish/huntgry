/**
 * The one way to add a job (#189): "Add job" takes either a posting's link or its text, in one box. What the box
 * holds decides how it is saved, so the dialog can say so before Save. Pure, so it is unit-tested.
 */

/** Pasted text shorter than this is not a posting. */
export const MIN_CHARS = 50

/**
 * What the box holds: nothing yet, a `link` (one http(s) URL and nothing else: Huntgry reads the posting from it),
 * the `text` of a posting, or text too `short` to be one.
 */
export type AddJobInput = 'empty' | 'link' | 'text' | 'short'

export function addJobInput(value: string): AddJobInput {
  const v = value.trim()
  if (!v) return 'empty'
  if (/^https?:\/\/\S+$/i.test(v)) return 'link'
  return v.length < MIN_CHARS ? 'short' : 'text'
}
