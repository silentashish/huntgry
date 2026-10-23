/**
 * A fictional Jobright new-grad list (#142) for the Explore e2e spec, in the shape of
 * jobright-ai/2026-Software-Engineer-New-Grad's README, plus the Jobright posting pages its rows link to.
 *
 * The README's dates are relative to `now` (the list keeps the last few days and gives `Mon D` without a
 * year), so the page's "today" is always the run's today. Job links point at `<origin>/jobs/info/<id>`,
 * the host the app accepts besides jobright.ai when the README comes from the mock server.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Rows of the list: `daysAgo` 0 is today. `blocked` postings answer with a human check. `employer` is the path
 * of the employer's posting (on the mock's other origin) a signed-in posting page gives as `applyLink` (#146).
 */
export const JOBRIGHT_JOBS = [
  { id: 'e2e0000000000000000000a1', company: 'Northwind Labs', site: 'https://northwind.example.com', title: 'Software Engineer, New Grad', location: 'Seattle, WA, United States', work: 'On Site', daysAgo: 0, employer: '/postings/employer/101' },
  { id: 'e2e0000000000000000000a2', company: '↳', title: 'Backend Engineer I', location: 'Remote, United States', work: 'Remote', daysAgo: 0 },
  { id: 'e2e0000000000000000000a3', company: 'Contoso Robotics', site: 'https://contoso.example.com', title: 'Embedded Software Engineer', location: 'Austin, TX, United States', work: 'Hybrid', daysAgo: 0 },
  { id: 'e2e0000000000000000000b1', company: 'Fabrikam', site: 'https://fabrikam.example.com', title: 'Associate Data Engineer', location: 'Chicago, IL, United States', work: 'Remote', daysAgo: 1, blocked: true },
  { id: 'e2e0000000000000000000b2', company: '↳', title: 'Platform Engineer, Early Career', location: 'Chicago, IL, United States', work: 'On Site', daysAgo: 1 },
  { id: 'e2e0000000000000000000c1', company: 'Tailspin Toys', site: 'https://tailspin.example.com', title: 'Frontend Engineer, New Grad', location: 'Denver, CO, United States', work: 'Hybrid', daysAgo: 3 }
]

const mdDate = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`

/** The README, with one malformed row (a link to another host) that the app must drop. */
export function jobrightReadme(origin, now = new Date()) {
  const rows = JOBRIGHT_JOBS.map((j) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - j.daysAgo)
    const company = j.company === '↳' ? '↳' : `**[${j.company}](${j.site})**`
    const link = `${origin}/jobs/info/${j.id}?utm_campaign=Software%20Engineering&utm_source=1103`
    return `| ${company} | **[${j.title}](${link})** | ${j.location} | ${j.work} | ${mdDate(day)} |`
  })
  rows.splice(2, 0, `| **[Phisher](https://phish.example.com)** | **[Too good to be true](https://phish.example.com/jobs/info/e2e0000000000000000000ff)** | Anywhere | Remote | ${mdDate(now)} |`)
  return [
    '# 2026 Software Engineer New Grad Positions (mock)',
    '',
    '## Daily Job List  🌐 🧭 🏆',
    '',
    '<!-- Please leave a one line gap between this and the table TABLE_START (DO NOT CHANGE THIS LINE) -->',
    '',
    '| Company | Job Title | Location | Work Model | Date Posted |',
    '| ----- | --------- |  --------- | ---- | ------- |',
    ...rows,
    '',
    '<!-- Please leave a one line gap between this and the table TABLE_END (DO NOT CHANGE THIS LINE) -->',
    ''
  ].join('\n')
}

const BOT_WALL = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Just a moment...</title></head><body>
<h1>Checking your browser before accessing the site.</h1><p>Please verify you are human to continue.</p></body></html>`

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The mock Jobright sign-in cookie (#146): set by `/jobright/signin`, httpOnly like a real session. */
export const JOBRIGHT_SESSION_COOKIE = 'jr_session'

/** `/jobright/signin`: one button that "signs in" and goes back to `next` (a posting page). */
export function jobrightSignInPage(next) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sign in | Jobright</title></head><body>
<main><h1>Sign in to Jobright</h1><form method="post" action="/jobright/signin"><input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Sign in</button></form></main></body></html>`
}

/**
 * A Jobright posting page (`/jobs/info/<id>`): JSON-LD `JobPosting`, the text, and Next.js data like
 * jobright.ai's: `pageProps.logined`, and signed in only, `jobResult.applyLink` / `originalUrl` with the
 * employer's posting on `employerOrigin` (#146). `null` for an unknown id.
 */
export function jobrightPostingPage(id, { signedIn = false, employerOrigin = '' } = {}) {
  const job = JOBRIGHT_JOBS.find((j) => j.id === id)
  if (!job) return null
  if (job.blocked) return { status: 403, html: BOT_WALL }
  let company = job.company
  if (company === '↳') company = JOBRIGHT_JOBS.slice(0, JOBRIGHT_JOBS.indexOf(job)).reverse().find((j) => j.company !== '↳')?.company ?? ''
  const description = `<p>${esc(company)} is hiring a ${esc(job.title)} to build reliable services in Go and TypeScript.</p>
<ul><li>Write, test and ship production code with a mentor.</li><li>Own small features end to end, from design to on-call handover.</li></ul>
<p>Requirements: a degree in computer science or equivalent experience, and curiosity about distributed systems.</p>`
  const ld = { '@context': 'https://schema.org', '@type': 'JobPosting', title: job.title, description, hiringOrganization: { '@type': 'Organization', name: company }, jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: job.location.split(',')[0] } } }
  const employer = signedIn && job.employer ? `${employerOrigin}${job.employer}` : undefined
  const jobResult = { jobId: job.id, isCompanySiteLink: !!job.employer, ...(employer ? { applyLink: employer, originalUrl: employer } : {}) }
  const next = { props: { pageProps: { logined: signedIn, dataSource: { jobResult } } } }
  const account = signedIn ? '<p>Signed in</p>' : `<p><a href="/jobright/signin?next=${encodeURIComponent(`/jobs/info/${job.id}`)}">Sign in</a></p>`
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(job.title)} - ${esc(company)} | Jobright</title>
<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><header>${account}</header><main><h1>${esc(job.title)}</h1><h2>${esc(company)}</h2>${description}</main>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next).replace(/</g, '\\u003c')}</script></body></html>`
  return { status: 200, html }
}
