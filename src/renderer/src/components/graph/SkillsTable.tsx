import { useMemo } from 'react'
import { Table } from '@mantine/core'
import type { KnowledgeGraph } from '@shared/knowledge-graph'
import { MonoLabel, ProgressBar, StatusPill } from '../ui'
import classes from './graph.module.css'
import { evidenceSummary, matchesFilter, matchesQuery, sortSkills, yearsLabel, type SkillFilter, type SkillSort } from './skills'

/** Every skill with its group, years, evidence and how many saved jobs ask for it (Figma: Profile — Skills). */
export function SkillsTable({
  graph,
  filter,
  show = 'all',
  sort = 'jobs',
  selected = null,
  onSelect
}: {
  graph: KnowledgeGraph
  /** Text filter on the name and the groups. */
  filter: string
  show?: SkillFilter
  sort?: SkillSort
  selected?: string | null
  onSelect(id: string): void
}) {
  const rows = useMemo(
    () => sortSkills(graph.skills.filter((s) => matchesQuery(s, filter) && matchesFilter(s, show)), sort),
    [graph, filter, show, sort]
  )
  const maxYears = useMemo(() => Math.max(1, ...graph.skills.map((s) => s.years)), [graph])

  return (
    <div className={classes.tableCard}>
      <Table className={classes.table} highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w="26%">Skill</Table.Th>
            <Table.Th w="16%">Group</Table.Th>
            <Table.Th w={150}>Years</Table.Th>
            <Table.Th>Evidence</Table.Th>
            <Table.Th w={110}>Jobs asking</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((s) => (
            <Table.Tr key={s.id} onClick={() => onSelect(s.id)} data-selected={s.id === selected || undefined}>
              <Table.Td>
                <span className={classes.skillCell}>
                  {/* The row stays a table row for screen readers; the name is the keyboard-operable control. */}
                  <button
                    type="button"
                    className={classes.skillName}
                    aria-label={`Show details for ${s.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelect(s.id)
                    }}
                  >
                    {s.name}
                  </button>
                  {s.gap && <StatusPill tone="warning">gap</StatusPill>}
                </span>
              </Table.Td>
              <Table.Td>{s.categories.join(', ') || <span className={classes.muted}>–</span>}</Table.Td>
              <Table.Td>
                {s.years > 0 ? (
                  <span className={classes.years}>
                    <ProgressBar value={(s.years / maxYears) * 100} size="xs" tone="success" className={classes.yearsBar} aria-label={`${s.years} years`} />
                    <MonoLabel tone="secondary">{yearsLabel(s.years)}</MonoLabel>
                  </span>
                ) : (
                  <span className={classes.muted}>–</span>
                )}
              </Table.Td>
              <Table.Td>
                <span className={s.gap ? classes.muted : undefined}>{evidenceSummary(graph, s)}</span>
              </Table.Td>
              <Table.Td>{s.jobs.length || <span className={classes.muted}>–</span>}</Table.Td>
            </Table.Tr>
          ))}
          {rows.length === 0 && (
            <Table.Tr>
              <Table.Td colSpan={5}>
                <span className={classes.muted}>No skills match.</span>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </div>
  )
}
