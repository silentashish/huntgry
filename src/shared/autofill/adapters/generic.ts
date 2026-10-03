import { headingText, SUBMITTED } from './text'
import type { Adapter } from './types'

const TEXTISH = 'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"]'

/** Any other site: the form with a file input, else the one with the most text fields. */
export const generic: Adapter = {
  ats: 'generic',
  matches: () => true,
  formRoot: (doc) => {
    const forms = Array.from(doc.querySelectorAll('form'))
    const withFile = forms.find((f) => f.querySelector('input[type="file"]'))
    if (withFile) return withFile
    const best = forms.map((f) => ({ f, n: f.querySelectorAll(TEXTISH).length })).sort((a, b) => b.n - a.n)[0]
    if (best && best.n >= 2) return best.f
    // Client-rendered forms without a <form> element: only when there is an upload field.
    return doc.querySelector('input[type="file"]') ? doc.body : null
  },
  known: [],
  isConfirmation: (_url, doc) => SUBMITTED.test(headingText(doc)) && generic.formRoot(doc) === null
}
