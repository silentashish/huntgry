import { useEffect, useMemo, useRef, useState } from 'react'
import { useComputedColorScheme, useMantineTheme } from '@mantine/core'
import { forceX, forceY } from 'd3-force-3d'
import ForceGraph2D, { type ForceGraphMethods, type NodeObject } from 'react-force-graph-2d'
import type { GraphEdge, GraphNode, KnowledgeGraph, NodeKind } from '@shared/knowledge-graph'
import { KIND_COLOR } from './colors'

type Node = NodeObject<GraphNode & { degree: number }>

interface Props {
  graph: KnowledgeGraph
  selected: string | null
  /** Node ids matching the search; others are dimmed. `null` = no search. */
  matches: Set<string> | null
  hiddenKinds: Set<NodeKind>
  onSelect(id: string | null): void
  height: number
}

/** Force-directed view of the graph: colour by kind, size by connections, labels when zoomed in. */
export function GraphCanvas({ graph, selected, matches, hiddenKinds, onSelect, height }: Props) {
  const theme = useMantineTheme()
  const scheme = useComputedColorScheme('light')
  const box = useRef<HTMLDivElement>(null)
  const fg = useRef<ForceGraphMethods<Node> | undefined>(undefined)
  const [width, setWidth] = useState(600)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor(entry.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Stable objects across renders keep the simulation's positions when only styling changes.
  const data = useMemo(() => {
    const visible = graph.nodes.filter((n) => !hiddenKinds.has(n.kind))
    const ids = new Set(visible.map((n) => n.id))
    const links = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ ...e }))
    const degree = new Map<string, number>()
    for (const e of links) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }
    // Unconnected nodes (a job that mentions none of the known skills) would drift off and shrink the fit.
    const nodes = visible.filter((n) => n.kind === 'person' || degree.has(n.id))
    return { nodes: nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })), links }
  }, [graph, hiddenKinds])

  const neighbours = useMemo(() => {
    if (!selected) return null
    const set = new Set([selected])
    for (const e of graph.edges) {
      if (e.source === selected) set.add(e.target)
      if (e.target === selected) set.add(e.source)
    }
    return set
  }, [graph, selected])

  useEffect(() => {
    fg.current?.d3Force('charge')?.strength?.(-140)
    // Weak gravity keeps separate components (a job linked only to gaps) near the rest.
    fg.current?.d3Force('x', forceX(0).strength(0.06) as never)
    fg.current?.d3Force('y', forceY(0).strength(0.06) as never)
    const link = fg.current?.d3Force('link') as { distance?: (d: number) => void } | undefined
    link?.distance?.(55)
  }, [data])

  const text = scheme === 'dark' ? theme.colors.dark[0] : theme.colors.gray[8]
  const faded = (id: string) => (neighbours ? !neighbours.has(id) : matches ? !matches.has(id) : false)
  const color = (kind: NodeKind, gap: boolean) =>
    theme.colors[gap ? 'orange' : KIND_COLOR[kind]][scheme === 'dark' ? 4 : 6]
  const gapIds = useMemo(() => new Set(graph.skills.filter((s) => s.gap).map((s) => s.id)), [graph])

  return (
    <div ref={box} style={{ width: '100%', height, borderRadius: 'var(--mantine-radius-md)', overflow: 'hidden' }}>
      <ForceGraph2D<GraphNode & { degree: number }, GraphEdge>
        ref={fg}
        width={width}
        height={height}
        graphData={data}
        backgroundColor="transparent"
        cooldownTicks={120}
        onEngineStop={() => fg.current?.zoomToFit(400, 40)}
        nodeLabel={(n) => `${n.label}${n.detail ? ` — ${n.detail}` : ''}`}
        onNodeClick={(n) => onSelect(n.id === selected ? null : String(n.id))}
        onBackgroundClick={() => onSelect(null)}
        linkColor={(l) => {
          const [s, t] = [endId(l.source), endId(l.target)]
          const dim = faded(s) || faded(t)
          const base =
            l.kind === 'asks_for'
              ? theme.colors.yellow[6]
              : scheme === 'dark'
                ? theme.colors.dark[3]
                : theme.colors.gray[4]
          return dim ? `${base}33` : base
        }}
        linkWidth={(l) => (selected && (endId(l.source) === selected || endId(l.target) === selected) ? 2 : 1)}
        nodeCanvasObject={(n, ctx, scale) => {
          const r = n.kind === 'person' ? 9 : 3 + Math.min(6, Math.sqrt(n.degree) * 1.4)
          const alpha = faded(String(n.id)) ? 0.18 : 1
          ctx.globalAlpha = alpha
          ctx.beginPath()
          ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI)
          ctx.fillStyle = color(n.kind, gapIds.has(String(n.id)))
          ctx.fill()
          if (n.id === selected) {
            ctx.lineWidth = 2 / scale
            ctx.strokeStyle = text
            ctx.stroke()
          }
          // Labels for big nodes always, for the rest once zoomed in.
          if (scale > 1.6 || r >= 7 || n.id === selected || (neighbours?.has(String(n.id)) ?? false)) {
            const size = Math.max(10 / scale, 2.5)
            ctx.font = `${n.kind === 'person' ? 600 : 400} ${size}px ${theme.fontFamily}`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            ctx.fillStyle = text
            const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label
            ctx.fillText(label, n.x ?? 0, (n.y ?? 0) + r + 1.5)
          }
          ctx.globalAlpha = 1
        }}
        nodePointerAreaPaint={(n, paint, ctx) => {
          ctx.fillStyle = paint
          ctx.beginPath()
          ctx.arc(n.x ?? 0, n.y ?? 0, 10, 0, 2 * Math.PI)
          ctx.fill()
        }}
      />
    </div>
  )
}

/** A link end is an id before the simulation starts and the node object after. */
function endId(end: unknown): string {
  return typeof end === 'object' && end !== null ? String((end as { id?: unknown }).id) : String(end)
}
