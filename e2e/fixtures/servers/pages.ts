/**
 * The pages the mock server renders. Every company, person and posting is
 * fictional. Employer postings carry a JSON-LD `JobPosting`, which is what
 * `src/main/jobs/sources/posting.ts` reads.
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
  /** hiring.cafe's `visa_sponsorship` (default `false`, the board's "not mentioned"). */
  visaSponsorship?: boolean
  /** hiring.cafe's `seniority_level` (default `Senior Level`). */
  seniority?: string
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
    datePosted: '2026-09-24',
    // The one hit that sponsors: the sponsorship filter (#73) keeps it and hides the others.
    visaSponsorship: true
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
    datePosted: '2026-09-22',
    seniority: 'Mid Level'
  },
  {
    // The `mocks` workspace saves this one as a job added by URL.
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
