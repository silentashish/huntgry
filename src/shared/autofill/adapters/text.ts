/** Page-text helpers shared by the adapters' confirmation checks. */

export const headingText = (doc: Document) =>
  Array.from(doc.querySelectorAll('h1, h2, h3, [role="alert"], [data-qa="msg-submit-success"]'))
    .map((h) => h.textContent ?? '')
    .join('\n')

/** Headings sites show after a submitted application ("thanks for your interest" alone does not count). */
export const SUBMITTED =
  /thank(s| you)\b[^.!\n]{0,40}\b(for )?(applying|your application|submitting)|application (was |has been )?(submitted|received|sent)|we('ve| have) received your application/i
