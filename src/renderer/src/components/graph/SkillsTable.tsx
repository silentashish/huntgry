import { useMemo } from 'react'
import { Table, UnstyledButton } from '@mantine/core'
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react'
import type { KnowledgeGraph } from '@shared/knowledge-graph'
import { MonoLabel, ProgressBar, StatusPill } from '../ui'
import classes from './graph.module.css'
import {
  defaultDirection,
  evidenceSummary,
  matchesFilter,
  matchesQuery,
  sortSkills,
  yearsLabel,
  type SkillFilter,
  type SkillSort,
  type SortDirection
} from './skills'

/** Every skill with its group, years, evidence and how many saved jobs ask for it (Figma: Profile — Skills). */
export function SkillsTable({
  graph,
  filter,
  show = 'all',
  sort = 'jobs',
  direction = defaultDirection(sort),
  onSortChange,
  selected = null,
  onSelect
}: {
  graph: KnowledgeGraph
  /** Text filter on the name and the groups. */
  filter: string
  show?: SkillFilter
  sort?: SkillSort
  direction?: SortDirection
  /** A sortable header was clicked: the same column flips the direction, another starts at its default. */
  onSortChange?(sort: SkillSort, direction: SortDirection): void
  selected?: string | null
  onSelect(id: string): void
}) {
  const rows = useMemo(
    () => sortSkills(graph, graph.skills.filter((s) => matchesQuery(s, filter) && matchesFilter(s, show)), sort, direction),
    [graph, filter, show, sort, direction]
  )
  const maxYears = useMemo(() => Math.max(1, ...graph.skills.map((s) => s.years)), [graph])

  const th = (key: SkillSort, label: string, w?: number | string) => {
    const active = sort === key
    const Arrow = direction === 'asc' ? IconArrowUp : IconArrowDown
    return (
      <Table.Th w={w} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>
        <UnstyledButton
          className={classes.sortHeader}
          data-active={active || undefined}
          onClick={() => onSortChange?.(key, active ? (direction === 'asc' ? 'desc' : 'asc') : defaultDirection(key))}
        >
          {label}
          {active && <Arrow size={12} aria-hidden />}
        </UnstyledButton>
      </Table.Th>
    )
  }

  return (
    <div className={classes.tableCard}>
      <Table className={classes.table} highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            {th('name', 'Skill', '26%')}
            <Table.Th w="16%">Group</Table.Th>
            {th('years', 'Years', 150)}
            {th('evidence', 'Evidence')}
            {th('jobs', 'Jobs asking', 120)}
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
