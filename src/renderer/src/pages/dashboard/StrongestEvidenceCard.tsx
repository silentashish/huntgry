import { useEffect } from 'react'
import { Button } from '@mantine/core'
import { IconArrowRight } from '@tabler/icons-react'
import { api } from '../../api'
import { useKnowledgeGraph } from '../../components/graph/useKnowledgeGraph'
import { SectionCard } from '../../components/ui'
import { useNavigation } from '../../navigation'
import classes from './dashboard.module.css'
import { PROFILE_SAVED_EVENT } from './ProfileInsightsCard'

const LIMIT = 8

/**
 * The best-evidenced skills of the master profile (the Skills card merged into the insights
 * column, #95): each chip opens that skill in the Knowledge graph. Nothing until the profile has skills.
 */
export function StrongestEvidenceCard() {
  const { navigate } = useNavigation()
  const { graph, reload } = useKnowledgeGraph()
  // Same triggers as the application list: new or changed job descriptions change the job counts.
  useEffect(() => {
    const off = api.on('applications:changed', reload)
    window.addEventListener('focus', reload)
    window.addEventListener(PROFILE_SAVED_EVENT, reload)
    return () => {
      off()
      window.removeEventListener('focus', reload)
      window.removeEventListener(PROFILE_SAVED_EVENT, reload)
    }
  }, [reload])
  const top = graph?.skills.filter((s) => !s.gap).slice(0, LIMIT) ?? []
  if (top.length === 0) return null
  return (
    <SectionCard
      title="Strongest evidence"
      titleOrder={4}
      padding="md"
      actions={
        <Button size="xs" variant="subtle" color="trail" rightSection={<IconArrowRight size={14} />} onClick={() => navigate('graph')}>
          Knowledge graph
        </Button>
      }
    >
      <div className={classes.chips}>
        {top.map((s) => (
          <button
            key={s.id}
            type="button"
            className={classes.chip}
            title={`Open ${s.name} in the Knowledge graph`}
            onClick={() => navigate('graph', { nodeId: s.id })}
          >
            {s.name}
            {s.years > 0 ? ` · ${s.years}y` : ''}
          </button>
        ))}
      </div>
    </SectionCard>
  )
}
