/**
 * A mock Oracle HCM Candidate Experience site (#191): the single-page app's shell, which names the tenant's API host
 * on its `<base>` tag (the mock server's own origin here, reached through the loopback allowance), and the
 * requisition-details API it reads the job from. Shaped like the real ones (`src/main/jobs/fixtures/oracle-ce-*`);
 * the company and posting are fictional.
 */

export const ORACLE_SITE = 'CX_1'
/** The posting the API knows; any other id answers like a closed job (no items). */
export const ORACLE_JOB_ID = '4242'
export const ORACLE_API_PATH = '/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails'

const TITLE = 'Staff Platform Engineer - Payments'

/** The shell at `/en/sites/<site>/job/<id>`: no JSON-LD, no description, only Open Graph tags. */
export function oracleShell(origin: string): string {
  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
  <head>
    <meta charset="utf-8">
    <meta property="og:title" content="${TITLE}"/>
    <meta property="og:description" content="Initech moves money for small businesses. The payments platform team..."/>
    <meta property="og:site_name" content="Initech"/>
    <title>Initech</title>
    <base href="/en/sites/${ORACLE_SITE}" data-apibaseurl="${origin}" data-fahosturl="${origin}" data-sitenumber="${ORACLE_SITE}"/>
  </head>
  <body class="app-loading">
    <div class="app-loading-spinner"></div>
    <div class="app" data-bind="view: 'layout'"></div>
  </body>
</html>`
}

/** The API's answer for `finder=ById;Id="<id>",siteNumber=<site>`. */
export function oracleRequisition(finder: string): unknown {
  const m = /^ById;Id="(\d+)",siteNumber=([\w-]+)$/.exec(finder)
  if (!m || m[1] !== ORACLE_JOB_ID || m[2] !== ORACLE_SITE) return { items: [], count: 0, hasMore: false }
  return {
    items: [
      {
        Id: ORACLE_JOB_ID,
        Title: TITLE,
        ExternalPostedStartDate: '2026-10-28T11:17:46+00:00',
        PrimaryLocation: 'Austin, TX, United States',
        WorkplaceTypeCode: 'ORA_HYBRID',
        WorkplaceType: 'Hybrid',
        ExternalDescriptionStr:
          '<p><strong>About the team</strong></p><p>Initech moves money for small businesses. The payments platform team runs the ledger and the settlement pipeline.</p>',
        ExternalResponsibilitiesStr: '<ul><li>Own the settlement pipeline end to end.</li><li>Mentor engineers on the ledger.</li></ul>',
        ExternalQualificationsStr: '<ul><li>8 or more years building distributed systems in Go or Java.</li></ul>',
        secondaryLocations: [],
        requisitionFlexFields: [{ Prompt: 'Salary Range', Value: '$180000 - $230000 annually' }]
      }
    ],
    count: 1,
    hasMore: false
  }
}
