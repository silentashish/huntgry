import { Button, Stack } from '@mantine/core'
import { IconUser } from '@tabler/icons-react'
import { PageHeader } from '../../components/ui'
import { useNavigation, type PageParams } from '../../navigation'
import { GraphView, useKnowledgeState } from '../profile/KnowledgeViews'

/**
 * The Knowledge graph on its own. Since #95 the graph is a view of the Profile page
 * (`navigate('profile', { view: 'graph', nodeId })`); this stays for a `graph` location until
 * the shell sends those to the Profile page, and shows the same view.
 */
export function GraphPage({ params }: { params: PageParams['graph'] }) {
  const { navigate } = useNavigation()
  const state = useKnowledgeState(params?.nodeId, params)
  return (
    <Stack gap="lg">
      <PageHeader
        eyebrow="Your experience as a graph, with the jobs you saved laid over it"
        title="Knowledge graph"
        actions={
          <Button
            variant="default"
            leftSection={<IconUser size={16} />}
            onClick={() => navigate('profile', { view: 'graph', nodeId: state.selected ?? undefined })}
          >
            Open in Profile
          </Button>
        }
      />
      <GraphView state={state} onOpenEditor={() => navigate('profile', { view: 'editor' })} />
    </Stack>
  )
}
