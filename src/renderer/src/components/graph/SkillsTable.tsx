import { useMemo, useState } from 'react'
import { Badge, Table, Text, UnstyledButton } from '@mantine/core'
import type { KnowledgeGraph, SkillInfo } from '@shared/knowledge-graph'

type SortKey = 'name' | 'years' | 'evidence' | 'jobs'

/** Every skill with its years, evidence count and how many saved jobs ask for it. */
export function SkillsTable({
  graph,
  filter,
  onSelect
}: {
  graph: KnowledgeGraph
  filter: string
  onSelect(id: string): void
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'evidence', desc: true })
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const value = (s: SkillInfo) =>
      sort.key === 'name'
        ? s.name.toLowerCase()
        : sort.key === 'years'
          ? s.years
          : sort.key === 'evidence'
            ? s.evidence.length
            : s.jobs.length
    return graph.skills
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.categories.some((c) => c.toLowerCase().includes(q)))
      .sort((a, b) => {
        const [x, y] = [value(a), value(b)]
        const cmp = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)
        return sort.desc ? -cmp : cmp
      })
  }, [graph, filter, sort])

  const th = (key: SortKey, label: string, w?: number) => (
    <Table.Th w={w}>
      <UnstyledButton onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}>
        <Text size="sm" fw={600}>
          {label}
          {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
        </Text>
      </UnstyledButton>
    </Table.Th>
  )

  return (
    <Table highlightOnHover striped>
      <Table.Thead>
        <Table.Tr>
          {th('name', 'Skill')}
          <Table.Th>Group</Table.Th>
          {th('years', 'Years', 90)}
          {th('evidence', 'Evidence', 100)}
          {th('jobs', 'Jobs asking', 110)}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((s) => (
          <Table.Tr key={s.id} onClick={() => onSelect(s.id)} style={{ cursor: 'pointer' }}>
            <Table.Td>
              <Text size="sm" fw={500}>
                {s.name}{' '}
                {s.gap && (
                  <Badge size="xs" color="orange" variant="light">
                    gap
                  </Badge>
                )}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c="dimmed">
                {s.categories.join(', ')}
              </Text>
            </Table.Td>
            <Table.Td>{s.years > 0 ? s.years : '–'}</Table.Td>
            <Table.Td>{s.gap ? '–' : s.evidence.length}</Table.Td>
            <Table.Td>{s.jobs.length || '–'}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )
}
