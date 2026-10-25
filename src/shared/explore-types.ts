/**
 * Explore (#142): Jobright's new-grad jobs, cached in the workspace (`.huntgry/explore/`) and addable to the
 * Jobs page. Since #169 they come from the API behind newgrad-jobs.com, one category at a time; the public
 * GitHub README (new-grad software only) is the fallback when the API fails.
 */

import type { Job } from './jobs-types'

/** The list's "Work Model" column. */
export type WorkModel = 'Remote' | 'Hybrid' | 'On Site'

export const WORK_MODELS: readonly WorkModel[] = ['Remote', 'Hybrid', 'On Site']

/** One row of the list. */
export interface ExploreJob {
  /** Jobright's posting id (`jobright.ai/jobs/info/<id>`); the saved job is `jobright:<id>`. */
  id: string
  company: string
  /** The company's site, when the row links one (public http(s) only). */
  companyUrl: string | null
  title: string
  /** `https://jobright.ai/jobs/info/<id>`, tracking parameters removed. */
  url: string
  location: string
  /** `null` when the row's work model is not one of the three. */
  workModel: WorkModel | null
  /** Posted day, `YYYY-MM-DD` in local time (the API gives a time; the README gives `Mon D`, the year inferred). */
  postedAt: string
  // The API's per-job fields (#169); absent on rows from the README.
  /** Jobright's pay text, e.g. `$150000-$168000/yr`. */
  salary?: string
  /** Jobright's numbered list of the posting's qualifications (#150 scores from it). */
  qualifications?: string
  h1b?: H1bSponsored
  industry?: string[]
  /** e.g. `1001-5000`, `10000+`. */
  companySize?: string
  expLevel?: string
}

/** The API's `h1bSponsored`. */
export type H1bSponsored = 'Yes' | 'No' | 'Not Sure'

export const H1B_VALUES: readonly H1bSponsored[] = ['Yes', 'No', 'Not Sure']

/** Where a list came from: the newgrad-jobs API, or the GitHub README after the API failed. */
export type ExploreSource = 'api' | 'readme'

export interface ExploreList {
  jobs: ExploreJob[]
  /** When the list was last fetched; `null` when it never was. */
  fetchedAt: string | null
  /** The category it lists (`newgrad:us:swe`, …). */
  category: string
  source: ExploreSource
  /** How many jobs the API has in the category (only the newest `EXPLORE_MAX_ROWS` are fetched); API only. */
  total?: number
  /** Why the README is shown instead of the API (the API's error); README only. */
  fallbackReason?: string
}

/** The category Explore opens on, and the only one the README fallback covers. */
export const DEFAULT_EXPLORE_CATEGORY = 'newgrad:us:swe'

/** At most this many rows are fetched per refresh (the API pages 500 at a time). */
export const EXPLORE_MAX_ROWS = 1000

/** Labels of the categories' last part (`swe`, `ml_ai`, …). */
const FIELD_LABELS: Record<string, string> = {
  swe: 'Software Engineering',
  data_analysis: 'Data Analysis',
  ml_ai: 'Machine Learning & AI',
  product_management: 'Product Management',
  accounting_finance: 'Accounting & Finance',
  engineering_development: 'Engineering & Development',
  business_analyst: 'Business Analyst',
  marketing_gen: 'Marketing',
  cyber_security: 'Cybersecurity',
  consulting: 'Consulting',
  creatives_design: 'Creative & Design',
  management_executive: 'Management & Executive',
  public_sector: 'Public Sector',
  legal_compliance: 'Legal & Compliance',
  human_resources: 'Human Resources',
  arts_entertainment: 'Arts & Entertainment',
  sales: 'Sales',
  customer_service: 'Customer Service',
  education_training: 'Education & Training',
  healthcare: 'Healthcare',
  supply_chain: 'Supply Chain',
  data_engineer: 'Data Engineering',
  project_manager: 'Project Management'
}

/** The categories newgrad-jobs.com lists (from its site, 2026-10-24), by group. */
const CATEGORY_FIELDS: Record<string, string[]> = {
  'newgrad:us': ['swe', 'data_analysis', 'ml_ai', 'data_engineer', 'product_management', 'accounting_finance', 'engineering_development', 'business_analyst', 'marketing_gen', 'cyber_security', 'consulting', 'creatives_design', 'management_executive', 'public_sector', 'legal_compliance', 'human_resources', 'arts_entertainment', 'sales', 'customer_service', 'education_training', 'healthcare', 'supply_chain'],
  'newgrad:ca': ['swe', 'engineering_development', 'accounting_finance', 'data_analysis', 'management_executive', 'sales', 'marketing_gen', 'human_resources', 'education_training', 'consulting', 'healthcare', 'customer_service', 'supply_chain'],
  'intern:us': ['swe', 'data_analysis', 'ml_ai', 'data_engineer', 'product_management', 'business_analyst', 'marketing_gen', 'creatives_design', 'accounting_finance', 'consulting', 'engineering_development', 'cyber_security', 'project_manager', 'human_resources', 'arts_entertainment', 'management_executive', 'customer_service', 'legal_compliance', 'sales', 'public_sector', 'education_training', 'healthcare', 'supply_chain'],
  'intern:ca': ['swe', 'engineering_development', 'accounting_finance', 'data_analysis', 'ml_ai', 'management_executive', 'sales', 'marketing_gen', 'human_resources']
}

const GROUP_LABELS: Record<string, string> = {
  'newgrad:us': 'New grad · US',
  'newgrad:ca': 'New grad · Canada',
  'intern:us': 'Internship · US',
  'intern:ca': 'Internship · Canada'
}

export interface ExploreCategory {
  /** The API's `category`, e.g. `newgrad:us:swe`. */
  id: string
  label: string
  group: string
}

/** Every category the picker offers; main accepts no other. */
export const EXPLORE_CATEGORIES: readonly ExploreCategory[] = Object.entries(CATEGORY_FIELDS).flatMap(([prefix, fields]) =>
  fields.map((f) => ({ id: `${prefix}:${f}`, label: FIELD_LABELS[f] ?? f, group: GROUP_LABELS[prefix] }))
)

export const isExploreCategory = (c: unknown): c is string => typeof c === 'string' && EXPLORE_CATEGORIES.some((x) => x.id === c)

/**
 * The Jobright sign-in of the hidden job-board browser (#146). Signed in, a Jobright posting page carries the
 * employer's own posting link, which then replaces the Jobright page as the saved job's link.
 */
export interface JobrightAccount {
  /** Whether the last Jobright posting page Huntgry loaded was rendered for a signed-in user; `null` = never checked. */
  connected: boolean | null
  /** When that was (ISO), or `null`. */
  checkedAt: string | null
}

export interface ExploreApi {
  /** The category's cached list; fetched when the workspace has none yet. */
  list(category?: string): Promise<ExploreList>
  /** Fetches the category again (the API, else the README) and caches it. */
  refresh(category?: string): Promise<ExploreList>
  /**
   * Saves a job listed in `category` to the Jobs page (idempotent); returns the saved (canonical) job. While
   * Jobright is connected, a new job's link is the employer's posting when Jobright gives one (#146).
   */
  add(id: string, category?: string): Promise<Job>
  /** The Jobright sign-in as last seen, without loading anything. */
  account(): Promise<JobrightAccount>
  /** Opens Jobright in a sign-in window; resolves when it reports a signed-in user or the window is closed. */
  connect(): Promise<JobrightAccount>
  /** Loads one Jobright posting page to see whether the sign-in still holds. */
  checkAccount(): Promise<JobrightAccount>
  /** Signs the hidden browser out of Jobright (removes its cookies). */
  disconnect(): Promise<JobrightAccount>
}

export const EXPLORE_CHANNELS = {
  list: 'explore:list',
  refresh: 'explore:refresh',
  add: 'explore:add',
  account: 'explore:account',
  connect: 'explore:connect',
  checkAccount: 'explore:check-account',
  disconnect: 'explore:disconnect'
} as const

/** Shape of a Jobright posting id, checked on every id the renderer sends. */
export const JOBRIGHT_ID_PATTERN = /^[A-Za-z0-9]{6,64}$/

/** The id of the saved job for a listed one. */
export const savedJobId = (id: string): string => `jobright:${id}`
