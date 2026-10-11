import { useEffect, useMemo, useState } from 'react'
import { ActionIcon, Alert, Button, Center, Chip, Loader, SegmentedControl, Select, TextInput, Tooltip } from '@mantine/core'
import { IconBriefcase, IconChartDots3, IconRefresh, IconSearch } from '@tabler/icons-react'
import type { JobText, KnowledgeGraph, NodeKind } from '@shared/knowledge-graph'
import { GAP_COLOR, KIND_COLOR, KIND_LABEL } from '../../components/graph/colors'
import { GraphCanvas } from '../../components/graph/GraphCanvas'
import graphClasses from '../../components/graph/graph.module.css'
import { NodePanel } from '../../components/graph/NodePanel'
import {
  SKILL_SORT_LABEL,
  defaultDirection,
  isStrong,
  type SkillFilter,
  type SkillSort,
  type SortDirection
} from '../../components/graph/skills'
import { SkillsTable } from '../../components/graph/SkillsTable'
import { useKnowledgeGraph } from '../../components/graph/useKnowledgeGraph'
import { EmptyState, MonoLabel } from '../../components/ui'
import classes from './profile.module.css'

const LEGEND: NodeKind[] = ['person', 'experience', 'company', 'project', 'skill', 'education', 'certification', 'publication', 'job']

/** The graph data and what the Knowledge graph and Skills views share: the overlay switch and the selected node. */
export interface KnowledgeState {
  graph: KnowledgeGraph | null
  jobs: JobText[]
  error: string | null
  reload(): void
  showJobs: boolean
  setShowJobs(on: boolean): void
  selected: string | null
  setSelected(id: string | null): void
}

/**
 * Loads the graph once for both views. `nodeId` (from the location) selects a node whenever the
 * location changes, so `navigate('profile', { view: 'graph', nodeId })` opens on it.
 * `profileVersion` is the open document's version: a save or a reload from disk rebuilds the graph.
 */
export function useKnowledgeState(nodeId: string | undefined, location: unknown, profileVersion?: string): KnowledgeState {
  const [showJobs, setShowJobs] = useState(true)
  const [selected, setSelected] = useState<string | null>(nodeId ?? null)
  const { graph, jobs, error, reload } = useKnowledgeGraph(showJobs, profileVersion)

  useEffect(() => {
    if (nodeId) setSelected(nodeId)
    // Every navigation brings a new params object: re-apply the node even when it is the same id.
  }, [location])

  // A selected node can disappear (overlay turned off, profile edited): drop the selection with it.
  useEffect(() => {
    if (graph && selected && !graph.nodes.some((n) => n.id === selected)) setSelected(null)
  }, [graph, selected])

  return { graph, jobs, error, reload, showJobs, setShowJobs, selected, setSelected }
}

/** Loading, error and "nothing to draw" states; `null` once there is a graph to show. */
function Status({ state, onOpenEditor }: { state: KnowledgeState; onOpenEditor(): void }) {
  const { graph, error, reload } = state
  if (error)
    return (
      <Alert color="red" variant="light" title="Could not build the graph">
        {error}
        <div>
          <Button mt="sm" size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={reload}>
            Try again
          </Button>
        </div>
      </Alert>
    )
  if (!graph)
    return (
      <Center py="xl">
        <Loader />
      </Center>
    )
  if (graph.nodes.length <= 1)
    return (
      <div className={classes.emptyCard}>
        <EmptyState
          icon={<IconChartDots3 size={28} />}
          title="Nothing to draw yet"
          description="The graph is built from your master profile: roles, projects, education and skills. Fill it in and come back."
          actions={
            <Button variant="primary" onClick={onOpenEditor}>
              Open the editor
            </Button>
          }
        />
      </div>
    )
  return null
}

function JobsOverlayChip({ state }: { state: KnowledgeState }) {
  return (
    <Chip
      checked={state.showJobs}
      onChange={state.setShowJobs}
      disabled={state.jobs.length === 0}
      size="xs"
      classNames={{ label: graphClasses.overlayLabel, iconWrapper: graphClasses.overlayIconWrapper }}
    >
      <span className={graphClasses.overlayContent}>
        <IconBriefcase size={12} aria-hidden />
        Jobs overlay ({state.jobs.length})
      </span>
    </Chip>
  )
}

/** Reads master-profile.md and the saved jobs again, for edits made outside the app. */
function RefreshButton({ state }: { state: KnowledgeState }) {
  return (
    <Tooltip label="Read master-profile.md and the saved jobs again">
      <ActionIcon variant="default" size="lg" aria-label="Refresh" onClick={state.reload}>
        <IconRefresh size={16} />
      </ActionIcon>
    </Tooltip>
  )
}

/** Profile → Knowledge graph: the canvas with search, "Jump to…", the jobs overlay, the legend and the node panel. */
export function GraphView({ state, onOpenEditor }: { state: KnowledgeState; onOpenEditor(): void }) {
  const { graph, selected, setSelected } = state
  const [search, setSearch] = useState('')
  const hiddenKinds = useMemo(() => new Set<NodeKind>(), [])
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q || !graph) return null
    return new Set(
      graph.nodes.filter((n) => n.label.toLowerCase().includes(q) || n.detail.toLowerCase().includes(q)).map((n) => n.id)
    )
  }, [graph, search])

  const status = <Status state={state} onOpenEditor={onOpenEditor} />
  if (!graph || graph.nodes.length <= 1 || state.error) return status

  const kinds = LEGEND.filter((k) => graph.nodes.some((n) => n.kind === k))
  return (
    <div className={classes.view}>
      <div className={classes.toolbar}>
        <TextInput
          className={classes.search}
          leftSection={<IconSearch size={16} />}
          placeholder="Highlight skills, roles, companies…"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        {/* Keyboard (and screen reader) way to select a node; the canvas itself is pointer-only. */}
        <Select
          className={classes.jump}
          searchable
          clearable
          placeholder="Jump to…"
          aria-label="Select a node of the graph"
          data={graph.nodes.map((n) => ({ value: n.id, label: `${KIND_LABEL[n.kind]}: ${n.label}` }))}
          value={selected}
          onChange={setSelected}
          limit={50}
        />
        <JobsOverlayChip state={state} />
        <RefreshButton state={state} />
        <span className={classes.spacer} />
        <ul className={graphClasses.legend} aria-label="Legend">
          {kinds.map((k) => (
            <li key={k} className={graphClasses.legendItem}>
              <span className={graphClasses.legendDot} style={{ backgroundColor: KIND_COLOR[k] }} />
              {KIND_LABEL[k]}
            </li>
          ))}
          {graph.skills.some((s) => s.gap) && (
            <li className={graphClasses.legendItem} title="Asked for by saved jobs, not in your profile">
              <span className={graphClasses.legendDot} style={{ backgroundColor: GAP_COLOR }} />
              Gap
            </li>
          )}
        </ul>
      </div>

      <div className={classes.split}>
        <div className={graphClasses.canvasCard}>
          <GraphCanvas graph={graph} selected={selected} matches={matches} hiddenKinds={hiddenKinds} onSelect={setSelected} height={560} />
        </div>
        <div className={classes.side}>
          {selected ? (
            <NodePanel graph={graph} id={selected} onSelect={setSelected} />
          ) : (
            <div className={`${graphClasses.panel} ${graphClasses.placeholder}`}>
              <MonoLabel tone="muted" component="p">
                Nothing selected
              </MonoLabel>
              <p className={graphClasses.panelText}>
                Click a node, or pick one from “Jump to…”, to see its evidence, the jobs that ask for it and where to edit it.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Profile → Skills: every skill with its evidence and the jobs asking for it, filterable and sortable. */
export function SkillsView({ state, onOpenEditor }: { state: KnowledgeState; onOpenEditor(): void }) {
  const { graph, selected, setSelected } = state
  const [search, setSearch] = useState('')
  const [show, setShow] = useState<SkillFilter>('all')
  const [{ key: sort, direction }, setSort] = useState<{ key: SkillSort; direction: SortDirection }>({ key: 'jobs', direction: 'desc' })

  const status = <Status state={state} onOpenEditor={onOpenEditor} />
  if (!graph || graph.nodes.length <= 1 || state.error) return status

  const gaps = graph.skills.filter((s) => s.gap).length
  const strong = graph.skills.filter(isStrong).length
  return (
    <div className={classes.view}>
      <div className={classes.toolbar}>
        <TextInput
          className={classes.search}
          leftSection={<IconSearch size={16} />}
          placeholder="Filter skills or groups…"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <SegmentedControl
          aria-label="Show skills"
          value={show}
          onChange={(v) => setShow(v as SkillFilter)}
          data={[
            { value: 'all', label: `All (${graph.skills.length})` },
            { value: 'gaps', label: `Gaps (${gaps})` },
            { value: 'strong', label: `Strong (${strong})` }
          ]}
        />
        <JobsOverlayChip state={state} />
        <RefreshButton state={state} />
        <span className={classes.spacer} />
        <Select
          className={classes.sort}
          aria-label="Sort skills"
          allowDeselect={false}
          value={sort}
          onChange={(v) => v && setSort({ key: v as SkillSort, direction: defaultDirection(v as SkillSort) })}
          data={(Object.keys(SKILL_SORT_LABEL) as SkillSort[]).map((k) => ({ value: k, label: SKILL_SORT_LABEL[k] }))}
        />
      </div>

      <div className={classes.split} data-panel={selected ? 'open' : undefined}>
        <SkillsTable
          graph={graph}
          filter={search}
          show={show}
          sort={sort}
          direction={direction}
          onSortChange={(key, dir) => setSort({ key, direction: dir })}
          selected={selected}
          onSelect={setSelected}
        />
        {selected && (
          <div className={classes.side}>
            <NodePanel graph={graph} id={selected} onSelect={setSelected} />
          </div>
        )}
      </div>
    </div>
  )
}
