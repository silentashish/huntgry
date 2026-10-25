/**
 * A fictional Jobright new-grad list for the Explore e2e specs: the newgrad-jobs API's answer
 * (`POST /swan/mini-sites/list`, #169), the jobright-ai/2026-Software-Engineer-New-Grad README it falls back to
 * (#142), and the Jobright posting pages their rows link to.
 *
 * Dates are relative to `now`, so the page's "today" is always the run's today. Job links point at
 * `<origin>/jobs/info/<id>`, the host the app accepts besides jobright.ai when the lists come from the mock server.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The API's `qualifications` of today's rows (#150): against the mocks workspace's profile (Go, Python, TypeScript,
 * SQL, AWS, Terraform, Docker, PostgreSQL) they score 25 (Northwind: Go of Go, Java, Kubernetes, React), 80
 * (Backend Engineer I: Go and Python, Kafka only a plus) and 100 (Contoso: everything, so Automation's e2e picks
 * it from the list, #154). Other rows get the generic list below.
 */
const QUALIFICATIONS = {
  a1: '1. A degree in computer science or equivalent experience.\n2. Experience with Java, Kubernetes and Go.\n3. Familiarity with React.',
  a2: '1. A degree in computer science or equivalent experience.\n2. Experience with Go and Python.\n3. Kafka is a plus.',
  a3: '1. A degree in computer science or equivalent experience.\n2. Go and Python services on AWS.\n3. PostgreSQL and Docker.\n4. Terraform is a plus.'
}

/**
 * Rows of the list: `daysAgo` 0 is today. `blocked` postings answer with a human check. `employer` is the path
 * of the employer's posting (on the mock's other origin) a signed-in posting page gives as `applyLink` (#146);
 * Contoso's is only an application form, so its description comes from Jobright's summary (#148). `api` holds the
 * API's per-job fields (#169); `apiOnly` rows are older than the README's few days, so only the API lists them.
 */
export const JOBRIGHT_JOBS = [
  { id: 'e2e0000000000000000000a1', company: 'Northwind Labs', site: 'https://northwind.example.com', title: 'Software Engineer, New Grad', location: 'Seattle, WA, United States', work: 'On Site', daysAgo: 0, employer: '/postings/employer/101', api: { salary: '$120000-$145000/yr', h1bSponsored: 'Yes', industry: ['Cloud Computing', 'Software'], companySize: '1001-5000', qualifications: QUALIFICATIONS.a1 } },
  { id: 'e2e0000000000000000000a2', company: '↳', title: 'Backend Engineer I', location: 'Remote, United States', work: 'Remote', daysAgo: 0, api: { salary: '$95000-$110000/yr', h1bSponsored: 'No', industry: ['Cloud Computing'], companySize: '1001-5000', qualifications: QUALIFICATIONS.a2 } },
  { id: 'e2e0000000000000000000a3', company: 'Contoso Robotics', site: 'https://contoso.example.com', title: 'Embedded Software Engineer', location: 'Austin, TX, United States', work: 'Hybrid', daysAgo: 0, employer: '/postings/apply-only', api: { salary: '$48-$60/hr', h1bSponsored: 'Not Sure', industry: ['Robotics'], companySize: '51-200', qualifications: QUALIFICATIONS.a3 } },
  { id: 'e2e0000000000000000000b1', company: 'Fabrikam', site: 'https://fabrikam.example.com', title: 'Associate Data Engineer', location: 'Chicago, IL, United States', work: 'Remote', daysAgo: 1, blocked: true, api: { h1bSponsored: 'Yes', industry: ['FinTech'] } },
  { id: 'e2e0000000000000000000b2', company: '↳', title: 'Platform Engineer, Early Career', location: 'Chicago, IL, United States', work: 'On Site', daysAgo: 1, api: { salary: '$100000-$125000/yr', h1bSponsored: 'Not Sure', industry: ['FinTech'] } },
  { id: 'e2e0000000000000000000c1', company: 'Tailspin Toys', site: 'https://tailspin.example.com', title: 'Frontend Engineer, New Grad', location: 'Denver, CO, United States', work: 'Hybrid', daysAgo: 3, api: { salary: '$90000-$105000/yr', h1bSponsored: 'No', industry: ['Gaming'] } },
  ...[4, 5, 6, 7, 8, 10].map((daysAgo) => ({
    id: `e2e00000000000000000d0${String(daysAgo).padStart(2, '0')}`,
    company: 'Woodgrove Bank',
    site: 'https://woodgrove.example.com',
    title: `Software Engineer I, Team ${daysAgo}`,
    location: 'New York, NY, United States',
    work: 'On Site',
    daysAgo,
    apiOnly: true,
    api: { salary: '$110000-$130000/yr', h1bSponsored: 'Yes', industry: ['Banking'], companySize: '10000+' }
  }))
]

/**
 * Automation's e2e (#154): Contoso's summary asks for skills of the mocks workspace's profile, so once its
 * description is read (#148's fallback) it scores above the default threshold. Only the qualifications change.
 */
const SUMMARY_QUALIFICATIONS = {
  e2e0000000000000000000a3: {
    mustHave: ['A degree in computer science or equivalent experience.', 'Go and Python services on AWS.', 'PostgreSQL and Docker.'],
    niceToHave: ['Terraform.']
  }
}

/** The category the rows above are in; the mock's other category holds `JOBRIGHT_OTHER_JOBS`. */
export const JOBRIGHT_CATEGORY = 'newgrad:us:swe'

/** `newgrad:us:data_analysis` (#169's category picker): one job, API only. */
export const JOBRIGHT_OTHER_JOBS = [
  { id: 'e2e0000000000000000000e1', company: 'Litware', site: 'https://litware.example.com', title: 'Junior Data Analyst', location: 'Boston, MA, United States', work: 'Hybrid', daysAgo: 0, apiOnly: true, api: { salary: '$70000-$85000/yr', h1bSponsored: 'Not Sure', industry: ['Analytics'] } }
]

const ALL_JOBS = [...JOBRIGHT_JOBS, ...JOBRIGHT_OTHER_JOBS]

/** The company of a row (`↳` is the previous row's). */
function companyOf(list, job) {
  if (job.company !== '↳') return job.company
  return list.slice(0, list.indexOf(job)).reverse().find((j) => j.company !== '↳')?.company ?? ''
}

/**
 * The newgrad-jobs API's answer for `body.category`, newest first, paged by `position` / `count` like the real
 * one. The SWE category also sends two malformed entries (a bad id, no title) that the app must drop. An unknown
 * category answers success with total 0.
 */
export function jobrightApi(body, position, count, now = new Date()) {
  const list = body?.category === JOBRIGHT_CATEGORY ? JOBRIGHT_JOBS : body?.category === 'newgrad:us:data_analysis' ? JOBRIGHT_OTHER_JOBS : []
  const entries = list.map((j) => ({
    jobId: j.id,
    tabCategory: [body.category],
    // 00:30 local on the posted day: in the past (or minutes ahead, which the app allows) whatever the hour.
    postedAt: new Date(now.getFullYear(), now.getMonth(), now.getDate() - j.daysAgo, 0, 30).getTime(),
    properties: {
      title: j.title,
      company: companyOf(list, j),
      location: j.location,
      salary: null,
      workModel: j.work,
      industry: null,
      companySize: null,
      qualifications: `1. A degree in computer science or equivalent experience.\n2. Experience with ${j.title.includes('Data') ? 'SQL and Python' : 'Go or TypeScript'}.\n...`,
      expLevel: null,
      jobFunction: null,
      h1bSponsored: null,
      isNewGrad: true,
      roleType: null,
      ...j.api
    }
  }))
  if (list === JOBRIGHT_JOBS) {
    entries.splice(1, 0, { jobId: 'not a jobright id', tabCategory: [body.category], postedAt: now.getTime() - 60_000, properties: { title: 'Too good to be true', company: 'Phisher' } })
    entries.splice(4, 0, { jobId: 'e2e0000000000000000000fe', tabCategory: [body.category], postedAt: now.getTime() - 60_000, properties: { company: 'No Title Inc' } })
  }
  entries.sort((a, b) => b.postedAt - a.postedAt)
  return { success: true, errorCode: 10000, errorMsg: null, result: { jobList: entries.slice(position, position + count), total: entries.length } }
}

const mdDate = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`

/** The README, with one malformed row (a link to another host) that the app must drop. */
export function jobrightReadme(origin, now = new Date()) {
  const rows = JOBRIGHT_JOBS.filter((j) => !j.apiOnly).map((j) => {
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
 * jobright.ai's: `pageProps.logined`, Jobright's summary (`jobSummary`, `coreResponsibilities`,
 * `qualifications`, signed in or not, #148), and signed in only, `jobResult.applyLink` / `originalUrl` with the
 * employer's posting on `employerOrigin` (#146). `null` for an unknown id.
 */
export function jobrightPostingPage(id, { signedIn = false, employerOrigin = '' } = {}) {
  const job = ALL_JOBS.find((j) => j.id === id)
  if (!job) return null
  if (job.blocked) return { status: 403, html: BOT_WALL }
  const company = companyOf(ALL_JOBS, job)
  const description = `<p>${esc(company)} is hiring a ${esc(job.title)} to build reliable services in Go and TypeScript.</p>
<ul><li>Write, test and ship production code with a mentor.</li><li>Own small features end to end, from design to on-call handover.</li></ul>
<p>Requirements: a degree in computer science or equivalent experience, and curiosity about distributed systems.</p>`
  const ld = { '@context': 'https://schema.org', '@type': 'JobPosting', title: job.title, description, hiringOrganization: { '@type': 'Organization', name: company }, jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: job.location.split(',')[0] } } }
  const employer = signedIn && job.employer ? `${employerOrigin}${job.employer}` : undefined
  const summary = {
    jobSummary: `Jobright's summary: ${company} is looking for a ${job.title} to join a small team shipping production software.`,
    coreResponsibilities: ['Write and test firmware and services with a mentor.', 'Take part in design reviews and on-call handovers.'],
    qualifications: SUMMARY_QUALIFICATIONS[job.id] ?? { mustHave: ['A degree in computer science or equivalent experience.', 'C, C++ or Go.'], niceToHave: ['Experience with real-time systems.'] }
  }
  const jobResult = { jobId: job.id, isCompanySiteLink: !!job.employer, ...summary, ...(employer ? { applyLink: employer, originalUrl: employer } : {}) }
  const next = { props: { pageProps: { logined: signedIn, dataSource: { jobResult } } } }
  const account = signedIn ? '<p>Signed in</p>' : `<p><a href="/jobright/signin?next=${encodeURIComponent(`/jobs/info/${job.id}`)}">Sign in</a></p>`
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(job.title)} - ${esc(company)} | Jobright</title>
<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><header>${account}</header><main><h1>${esc(job.title)}</h1><h2>${esc(company)}</h2>${description}</main>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next).replace(/</g, '\\u003c')}</script></body></html>`
  return { status: 200, html }
}
