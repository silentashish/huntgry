/**
 * Bot walls (Cloudflare, captchas, "verify you are human") look like a normal
 * page with no data. Detecting them lets the app say "blocked" instead of
 * returning an empty result.
 */
export function isBlockedPage(page: { title: string; text: string; status?: number | null }): boolean {
  if (page.status === 403 || page.status === 429 || page.status === 503) return true
  const t = `${page.title}\n${page.text.slice(0, 3000)}`
  return /just a moment|attention required|additional verification required|verify you are human|are you a robot|captcha|access denied|unusual traffic|ray id for this request/i.test(
    t
  )
}
