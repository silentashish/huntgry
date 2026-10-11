import { Button } from '@mantine/core'
import type { KnowledgeGraph } from '@shared/knowledge-graph'
import { useNavigation } from '../../navigation'
import { MonoLabel, SectionCard, StatusPill } from '../ui'
import classes from './graph.module.css'
import { yearsLabel } from './skills'

/**
 * Compact "top skills / gaps" card for the Dashboard: the best-evidenced skills
 * and the technologies saved job descriptions ask for that the profile lacks.
 */
export function SkillsSummaryCard({
  graph,
  limit = 8,
  showLink = true
}: {
  graph: KnowledgeGraph
  limit?: number
  /** Hide the link to the Profile's Knowledge graph view when already on it. */
  showLink?: boolean
}) {
  const { navigate } = useNavigation()
  const top = graph.skills.filter((s) => !s.gap).slice(0, limit)
  const gaps = graph.skills
    .filter((s) => s.gap)
    .sort((a, b) => b.jobs.length - a.jobs.length)
    .slice(0, limit)
  return (
    <SectionCard
      title="Skills"
      titleOrder={4}
      padding="md"
      actions={
        showLink && (
          <Button size="xs" variant="subtle" onClick={() => navigate('profile', { view: 'graph' })}>
            Knowledge graph
          </Button>
        )
      }
    >
      <div className={classes.summaryGroup}>
        <MonoLabel tone="muted" component="p">
          Strongest evidence
        </MonoLabel>
        <div className={classes.pills}>
          {top.map((s) => (
            <StatusPill key={s.id} tone="success">
              {s.name}
              {s.years > 0 ? ` · ${yearsLabel(s.years)}` : ''}
            </StatusPill>
          ))}
          {top.length === 0 && <p className={classes.summaryEmpty}>Add skills and experience to your master profile.</p>}
        </div>
      </div>
      <div className={classes.summaryGroup}>
        <MonoLabel tone="muted" component="p">
          Asked for, missing from your profile
        </MonoLabel>
        <div className={classes.pills}>
          {gaps.map((s) => (
            <StatusPill key={s.id} tone="warning">
              {s.name} · {s.jobs.length} job{s.jobs.length === 1 ? '' : 's'}
            </StatusPill>
          ))}
          {gaps.length === 0 && <p className={classes.summaryEmpty}>No gaps found in your saved job descriptions.</p>}
        </div>
      </div>
    </SectionCard>
  )
}
