import { Code } from '@mantine/core'
import type { PageParams } from '../../navigation'
import { PagePlaceholder } from '../../components/shell/PagePlaceholder'

/** Runs the Claude resume-tailor skill against the workspace for one job. */
export function TailorPage({ params }: { params: PageParams['tailor'] }) {
  return (
    <PagePlaceholder
      title="Tailor"
      description="Run the Claude resume-tailor skill for a job: paste a description or a posting URL and follow the conversation."
    >
      {params && (
        <Code block mt="md">
          {JSON.stringify(params, null, 2)}
        </Code>
      )}
    </PagePlaceholder>
  )
}
