import { Button } from '@mantine/core'
import { IconPencil } from '@tabler/icons-react'
import type { GraphNode, KnowledgeGraph } from '@shared/knowledge-graph'
import { useNavigation } from '../../navigation'
import { MonoLabel, StatusPill } from '../ui'
import { KIND_COLOR, KIND_LABEL, KIND_TONE } from './colors'
import classes from './graph.module.css'

/**
 * Details of the selected node (Figma: the card beside the graph): for a skill its years,
 * evidence and the jobs asking for it; otherwise its skills and the nodes it connects to.
 */
export function NodePanel({ graph, id, onSelect }: { graph: KnowledgeGraph; id: string; onSelect(id: string): void }) {
  const { navigate } = useNavigation()
  const node = graph.nodes.find((n) => n.id === id)
  if (!node) return null
  const skill = graph.skills.find((s) => s.id === id)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const edges = graph.edges.filter((e) => e.source === id || e.target === id)
  const linked = edges
    .map((e) => byId.get(e.source === id ? e.target : e.source))
    .filter((n): n is GraphNode => n !== undefined)
  const linkedSkills = linked.filter((n) => n.kind === 'skill')
  const linkedJobs = linked.filter((n) => n.kind === 'job')
  const linkedOther = linked.filter((n) => n.kind !== 'skill' && (!skill || n.kind !== 'job'))

  return (
    <aside className={classes.panel} aria-label={`${KIND_LABEL[node.kind]}: ${node.label}`}>
      <div className={classes.panelHead}>
        <StatusPill tone={skill?.gap ? 'accent' : KIND_TONE[node.kind]}>{skill?.gap ? 'Gap' : KIND_LABEL[node.kind]}</StatusPill>
        <h4 className={classes.panelTitle}>{node.label}</h4>
      </div>
      {node.detail && node.kind !== 'job' && <p className={classes.panelDetail}>{node.detail}</p>}

      {skill && (
        <>
          <div className={classes.pills}>
            {skill.years > 0 && <StatusPill variant="outline">{skill.years} years</StatusPill>}
            <StatusPill variant="outline">{skill.evidence.length} evidence</StatusPill>
            {skill.jobs.length > 0 && (
              <StatusPill variant="outline" tone="accent">
                {skill.jobs.length} job{skill.jobs.length === 1 ? '' : 's'} ask
              </StatusPill>
            )}
          </div>
          {skill.gap ? (
            <p className={classes.panelText}>
              Saved job descriptions ask for {skill.name}, but your master profile never mentions it. If you have real
              experience with it, add it; otherwise leave the gap open.
            </p>
          ) : (
            <>
              <MonoLabel tone="muted" component="p" className={classes.sectionLabel}>
                Evidence
              </MonoLabel>
              {skill.evidence.map((ev, i) => (
                <div key={i} className={classes.evidence}>
                  {ev.nodeId ? (
                    <button type="button" className={classes.evidenceSource} onClick={() => onSelect(ev.nodeId!)}>
                      {ev.source}
                    </button>
                  ) : (
                    <span className={classes.evidenceSource}>{ev.source}</span>
                  )}
                  <p className={classes.evidenceText}>{ev.text}</p>
                </div>
              ))}
            </>
          )}
          {linkedJobs.length > 0 && (
            <>
              <MonoLabel tone="muted" component="p" className={classes.sectionLabel}>
                Asked for by
              </MonoLabel>
              <div className={classes.pills}>
                {linkedJobs.map((j) => (
                  <button key={j.id} type="button" className={classes.pillButton} onClick={() => onSelect(j.id)} aria-label={`Show ${j.label}`}>
                    <StatusPill variant="outline" tone="warning">
                      {j.label}
                    </StatusPill>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {!skill && linkedSkills.length > 0 && (
        <>
          <MonoLabel tone="muted" component="p" className={classes.sectionLabel}>
            {node.kind === 'job' ? 'Asks for' : 'Skills'}
          </MonoLabel>
          <div className={classes.pills}>
            {linkedSkills.map((s) => {
              const info = graph.skills.find((x) => x.id === s.id)
              return (
                <button key={s.id} type="button" className={classes.pillButton} onClick={() => onSelect(s.id)} aria-label={`Show ${s.label}`}>
                  <StatusPill tone={info?.gap ? 'accent' : 'success'}>{s.label}</StatusPill>
                </button>
              )
            })}
          </div>
        </>
      )}

      {linkedOther.length > 0 && (
        <>
          <MonoLabel tone="muted" component="p" className={classes.sectionLabel}>
            Connected
          </MonoLabel>
          <div className={classes.linkedList}>
            {linkedOther.map((n) => (
              <button key={n.id} type="button" className={classes.linked} onClick={() => onSelect(n.id)} title={KIND_LABEL[n.kind]}>
                <span className={classes.linkedKind} style={{ backgroundColor: KIND_COLOR[n.kind] }} aria-hidden />
                <span className={classes.linkedLabel}>
                  <MonoLabel size="xs" tone="muted">
                    {KIND_LABEL[n.kind]}
                  </MonoLabel>{' '}
                  {n.label}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {node.section && (
        <Button variant="default" fullWidth leftSection={<IconPencil size={16} />} onClick={() => navigate('profile', { section: node.section! })}>
          Edit in master profile
        </Button>
      )}
    </aside>
  )
}
