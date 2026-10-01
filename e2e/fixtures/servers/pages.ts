/**
 * The pages the mock server renders. Every company, person and posting is
 * fictional. The board pages carry their results the way the real boards do,
 * which is what the parsers in `src/main/jobs/sources/*` read: hiring.cafe
 * server-renders `__NEXT_DATA__` with `pageProps.ssrHits`; Indeed embeds the
 * result cards in `window.mosaic.providerData['mosaic-provider-jobcards']`.
 */

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** `<script>` payload: `</script>` inside the JSON must not end the script early. */
const json = (value: unknown) => JSON.stringify(value).replace(/<\//g, '<\\/')

export interface EmployerPosting {
  id: string
  title: string
  company: string
  location: string
  remote: boolean
  salary: [number, number]
  tools: string[]
  requirements: string
  description: string[]
  datePosted: string
}

/** The employer pages behind the mock hiring.cafe hits (`/postings/employer/<id>`). */
export const EMPLOYER_POSTINGS: EmployerPosting[] = [
  {
    id: '101',
    title: 'Platform Engineer',
    company: 'Initrode',
    location: 'Remote',
    remote: true,
    salary: [150000, 180000],
    tools: ['Go', 'Kubernetes', 'Terraform'],
    requirements: 'Five years running production Kubernetes, Go services and infrastructure as code.',
    description: [
      'Initrode builds the scheduling platform behind two thousand regional delivery routes. The platform team owns the Kubernetes clusters, the Go services that route every order and the Terraform that describes it all.',
      'You will design the next generation of our deployment pipeline, keep the clusters boring and mentor two engineers who joined this year.',
      'We are remote across North America and meet in person twice a year. The salary band is published and the interview loop takes two weeks.'
    ],
    datePosted: '2026-09-24'
  },
  {
    id: '102',
    title: 'Backend Engineer',
    company: 'Vandelay Industries',
    location: 'Portland, Oregon, United States',
    remote: false,
    salary: [130000, 155000],
    tools: ['Python', 'PostgreSQL', 'AWS'],
    requirements: 'Three years of Python services on AWS with PostgreSQL in production.',
    description: [
      'Vandelay Industries imports and exports fine latex goods, and its backend team keeps the order and customs systems running for forty warehouses.',
      'You will build Python services on AWS, own their PostgreSQL schemas and take part in a calm on-call rotation with eight colleagues.',
      'The office is in Portland, Oregon, with two days a week from home. Relocation help is available.'
    ],
    datePosted: '2026-09-22'
  },
  {
    // Not a board hit: the `mocks` workspace saves this one as a job added by URL, so it never merges with a search result.
    id: '103',
    title: 'Infrastructure Engineer',
    company: 'Tyrell Robotics',
    location: 'Remote',
    remote: true,
    salary: [140000, 170000],
    tools: ['Go', 'Kubernetes', 'AWS'],
    requirements: 'Four years of infrastructure work with Kubernetes on AWS and Go tooling.',
    description: [
      'Tyrell Robotics builds inspection robots for wind farms, and the infrastructure team runs the fleet backend: Kubernetes on AWS, Go services and a small Terraform estate.',
      'You will own the clusters, keep deployments boring and build the Go tooling the robot teams use to ship firmware. The team is four engineers across three time zones.',
      'Fully remote with a yearly meetup; the salary band is published and the loop takes two weeks.'
    ],
    datePosted: '2026-09-20'
  }
]

/** The postings the mock hiring.cafe search page lists (`103` is left out on purpose). */
const BOARD_HITS = EMPLOYER_POSTINGS.filter((p) => p.id !== '103')

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9.+#]+/).filter(Boolean)

/** Hits whose title or tools mention a searched word; `nothing` finds nothing, an empty query everything. */
function matching<T extends { title: string; tools?: string[] }>(items: T[], query: string): T[] {
  const terms = words(query)
  if (terms.includes('nothing')) return []
  if (terms.length === 0) return items
  return items.filter((item) => {
    const hay = words(`${item.title} ${(item.tools ?? []).join(' ')} engineer`)
    return terms.some((t) => hay.includes(t))
  })
}

/** hiring.cafe-shaped search page: `__NEXT_DATA__` with `ssrHits` (the shape `parseHiringCafeHits` reads), plus a visible list. */
export function hiringCafePage(searchState: string, origin: string): string {
  let query = ''
  let remoteOnly = false
  try {
    const state = JSON.parse(searchState) as { searchQuery?: string; workplaceTypes?: string[] }
    query = state.searchQuery ?? ''
    remoteOnly = state.workplaceTypes?.includes('Remote') ?? false
  } catch {
    query = ''
  }
  const hits = matching(BOARD_HITS, query)
    .filter((p) => !remoteOnly || p.remote)
    .map((p) => ({
      id: `mock___${p.company.toLowerCase().replace(/\W+/g, '-')}___${p.id}`,
      source: 'mock',
      apply_url: `${origin}/postings/employer/${p.id}`,
      is_expired: false,
      job_information: { title: p.title },
      v5_processed_job_data: {
        core_job_title: p.title,
        requirements_summary: p.requirements,
        technical_tools: p.tools,
        role_activities: ['building services', 'running infrastructure'],
        commitment: ['Full Time'],
        role_type: 'Individual Contributor',
        seniority_level: 'Senior Level',
        workplace_type: p.remote ? 'Remote' : 'Onsite',
        formatted_workplace_location: p.location,
        yearly_min_compensation: p.salary[0],
        yearly_max_compensation: p.salary[1],
        listed_compensation_currency: 'USD',
        estimated_publish_date: `${p.datePosted}T12:00:00.000Z`,
        company_name: p.company
      },
      enriched_company_data: { name: p.company }
    }))
  const data = { props: { pageProps: { ssrHits: hits, ssrTotalCount: hits.length } } }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Mock hiring.cafe</title></head><body>
<h1>Mock hiring.cafe</h1><p>${hits.length} jobs for "${escape(query)}"</p>
<ul>${hits.map((h) => `<li><a href="${h.apply_url}">${escape(h.job_information.title)} at ${escape(h.enriched_company_data.name)}</a></li>`).join('')}</ul>
<script id="__NEXT_DATA__" type="application/json">${json(data)}</script>
<script>window.__NEXT_DATA__ = JSON.parse(document.getElementById('__NEXT_DATA__').textContent)</script>
</body></html>`
}

/** The Indeed-shaped cards: snippets only, like the real board (job pages sit behind a human check). */
const INDEED_CARDS = [
  {
    jobkey: 'a1b2c3d4e5f60718',
    title: 'Site Reliability Engineer',
    displayTitle: 'Site Reliability Engineer',
    company: 'Umbrella Logistics',
    formattedLocation: 'Atlanta, GA',
    snippet: '<ul><li>Keep the fleet tracking <b>platform</b> up across three regions.</li><li>Terraform, Kubernetes and Go.</li></ul>',
    salarySnippet: { text: '$140,000 - $165,000 a year' },
    pubDate: Date.parse('2026-09-23T12:00:00Z'),
    remoteLocation: false,
    jobTypes: ['Full-time'],
    tools: ['Terraform', 'Kubernetes', 'Go']
  },
  {
    jobkey: '0f1e2d3c4b5a6978',
    title: 'Data Engineer',
    displayTitle: 'Data Engineer',
    company: 'Soylent Analytics',
    formattedLocation: 'Remote',
    snippet: '<ul><li>Build the warehouse pipelines in Python and SQL.</li><li>Remote, US time zones.</li></ul>',
    salarySnippet: { text: '$120,000 - $150,000 a year' },
    pubDate: Date.parse('2026-09-21T12:00:00Z'),
    remoteLocation: true,
    jobTypes: ['Full-time'],
    tools: ['Python', 'SQL']
  }
]

/** Indeed-shaped search page: `window.mosaic.providerData['mosaic-provider-jobcards']` (the shape `parseIndeedCards` reads). */
export function indeedPage(query: string): string {
  const results = matching(INDEED_CARDS, query).map(({ tools: _tools, ...card }) => card)
  const mosaic = { providerData: { 'mosaic-provider-jobcards': { metaData: { mosaicProviderJobCardsModel: { results } } } } }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Mock Indeed</title></head><body>
<h1>Mock Indeed</h1><p>${results.length} jobs for "${escape(query)}"</p>
<ul>${results.map((r) => `<li>${escape(r.title)} at ${escape(r.company)}</li>`).join('')}</ul>
<script>window.mosaic = ${json(mosaic)}</script>
</body></html>`
}

function employerPage(p: EmployerPosting): string {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: p.title,
    datePosted: p.datePosted,
    hiringOrganization: { '@type': 'Organization', name: p.company },
    jobLocationType: p.remote ? 'TELECOMMUTE' : undefined,
    jobLocation: p.remote
      ? undefined
      : [{ '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Portland', addressRegion: 'OR', addressCountry: 'US' } }],
    baseSalary: {
      '@type': 'MonetaryAmount',
      currency: 'USD',
      value: { '@type': 'QuantitativeValue', minValue: p.salary[0], maxValue: p.salary[1], unitText: 'YEAR' }
    },
    description: p.description.map((para) => `<p>${escape(para)}</p>`).join('')
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escape(p.title)} – ${escape(p.company)}</title>
<script type="application/ld+json">${json(ld)}</script></head><body>
<main><h1>${escape(p.title)}</h1><p class="company">${escape(p.company)} · ${escape(p.location)}</p>
${p.description.map((para) => `<p>${escape(para)}</p>`).join('\n')}
<p><a href="/lever/">Apply for this job</a></p></main></body></html>`
}

/** A Lever-style posting (`jobs.lever.co/<company>/<id>` markup: JSON-LD plus the posting body). */
const LEVER_STYLE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Acme - Software Engineer</title>
<script type="application/ld+json">${json({
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Software Engineer',
  datePosted: '2026-09-25',
  hiringOrganization: { '@type': 'Organization', name: 'Acme' },
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Denver', addressRegion: 'CO', addressCountry: 'US' } },
  description:
    '<div>Acme makes anvils, rockets and the software that ships them. The engineering team is twelve people who own everything from the order form to the warehouse scanners.</div><div>You will write TypeScript services and React screens, review code every day and ship to production several times a week. We pay for conferences and give every engineer a hardware budget.</div>'
})}</script></head><body>
<div class="posting-headline"><h2>Software Engineer</h2><div class="posting-categories"><span class="location">Denver, CO</span><span class="commitment">Full-time</span></div></div>
<div class="section-wrapper page-full-width"><div class="section page-centered"><div>Acme makes anvils, rockets and the software that ships them. The engineering team is twelve people who own everything from the order form to the warehouse scanners.</div>
<div>You will write TypeScript services and React screens, review code every day and ship to production several times a week. We pay for conferences and give every engineer a hardware budget.</div></div>
<div class="section page-centered"><a class="postings-btn" href="/lever/">Apply for this job</a></div></div>
</body></html>`

/** An Ashby-style posting: no JSON-LD, the page text is the posting (the parser's text fallback). */
const ASHBY_STYLE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Data Platform Engineer | Hooli</title></head><body>
<div id="root"><main>
<h1>Data Platform Engineer</h1><p>Hooli · Remote (United States) · Full time</p>
<section><h2>About the role</h2>
<p>Hooli's data platform team runs the pipelines that feed every dashboard in the company. We are hiring a Data Platform Engineer to own the ingestion layer: Kafka, Flink and a growing set of Python jobs that land data in the warehouse.</p>
<p>You will work with three analysts and two engineers, design schemas that stay readable a year later and keep the pipelines cheap. Remote across the United States; we meet quarterly.</p>
<p>Requirements: four years of data engineering, Python and SQL every day, and one streaming system in production.</p></section>
<a href="/generic/">Apply for this Job</a>
</main></div></body></html>`

/** The posting page for `/postings/<path>`, or `null`. */
export function postingPage(path: string, _origin: string): string | null {
  const employer = /^employer\/(\d+)$/.exec(path)
  if (employer) {
    const posting = EMPLOYER_POSTINGS.find((p) => p.id === employer[1])
    return posting ? employerPage(posting) : null
  }
  if (path === 'lever-style') return LEVER_STYLE
  if (path === 'ashby-style') return ASHBY_STYLE
  return null
}
