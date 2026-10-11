import { useEffect, useMemo, useRef, useState } from 'react'
import { forceCollide, forceX, forceY } from 'd3-force-3d'
import ForceGraph2D, { type ForceGraphMethods, type NodeObject } from 'react-force-graph-2d'
import type { GraphEdge, GraphNode, KnowledgeGraph, NodeKind } from '@shared/knowledge-graph'
import { GAP_COLOR, KIND_COLOR, useTokenValues, withAlpha } from './colors'

type Node = NodeObject<GraphNode & { degree: number }>

/** Every colour the canvas paints with, as tokens; resolved to values on each theme change. */
const CANVAS_TOKENS = {
  ...KIND_COLOR,
  gap: GAP_COLOR,
  label: 'var(--hg-text-secondary)',
  selected: 'var(--hg-text-primary)',
  link: 'var(--hg-border-strong)',
  asks: 'var(--hg-status-warning)',
  mono: 'var(--hg-font-mono)'
} satisfies Record<NodeKind | string, string>

interface Props {
  graph: KnowledgeGraph
  selected: string | null
  /** Node ids matching the search; others are dimmed. `null` = no search. */
  matches: Set<string> | null
  hiddenKinds: Set<NodeKind>
  onSelect(id: string | null): void
  height: number
}

/**
 * Force-directed view of the graph (Figma: Profile — Knowledge graph): ringed nodes coloured by
 * kind, sized by connections, mono labels beside them, dashed amber lines for what jobs ask for.
 */
export function GraphCanvas({ graph, selected, matches, hiddenKinds, onSelect, height }: Props) {
  const colors = useTokenValues(CANVAS_TOKENS)
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
    fg.current?.d3Force('charge')?.strength?.(-120)
    // Weak gravity keeps separate components (a job linked only to gaps) near the rest.
    fg.current?.d3Force('x', forceX(0).strength(0.07) as never)
    fg.current?.d3Force('y', forceY(0).strength(0.07) as never)
    // Room for each ring and the start of its label, so nodes do not sit on each other.
    fg.current?.d3Force('collide', forceCollide((n) => radius(n as Node) + 8).strength(0.9) as never)
    const link = fg.current?.d3Force('link') as { distance?: (d: number) => void } | undefined
    link?.distance?.(48)
  }, [data])

  const faded = (id: string) => (neighbours ? !neighbours.has(id) : matches ? !matches.has(id) : false)
  const gapIds = useMemo(() => new Set(graph.skills.filter((s) => s.gap).map((s) => s.id)), [graph])
  const fill = (n: Node) => (gapIds.has(String(n.id)) ? colors.gap : colors[n.kind])

  return (
    <div ref={box} style={{ width: '100%', height }}>
      <ForceGraph2D<GraphNode & { degree: number }, GraphEdge>
        ref={fg}
        width={width}
        height={height}
        graphData={data}
        backgroundColor="rgba(0, 0, 0, 0)"
        cooldownTicks={120}
        onEngineStop={() => fg.current?.zoomToFit(400, 40)}
        nodeLabel={(n) => `${n.label}${n.detail ? ` — ${n.detail}` : ''}`}
        onNodeClick={(n) => onSelect(n.id === selected ? null : String(n.id))}
        onBackgroundClick={() => onSelect(null)}
        linkColor={(l) => {
          const dim = faded(endId(l.source)) || faded(endId(l.target))
          const base = l.kind === 'asks_for' ? colors.asks : colors.link
          return dim ? withAlpha(base, 0.2) : base
        }}
        linkLineDash={(l) => (l.kind === 'asks_for' ? [4, 3] : null)}
        linkWidth={(l) => (selected && (endId(l.source) === selected || endId(l.target) === selected) ? 2 : 1)}
        nodeCanvasObject={(n, ctx, scale) => {
          const r = radius(n)
          const [x, y] = [n.x ?? 0, n.y ?? 0]
          const color = fill(n)
          ctx.globalAlpha = faded(String(n.id)) ? 0.28 : 1
          if (n.kind === 'person') {
            // The halo around "You".
            ctx.beginPath()
            ctx.arc(x, y, r * 1.9, 0, 2 * Math.PI)
            ctx.fillStyle = withAlpha(color, 0.14)
            ctx.fill()
          }
          ctx.beginPath()
          ctx.arc(x, y, r, 0, 2 * Math.PI)
          ctx.fillStyle = withAlpha(color, 0.2)
          ctx.fill()
          ctx.lineWidth = (n.id === selected ? 2.5 : 1.5) / scale
          ctx.strokeStyle = n.id === selected ? colors.selected : color
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(x, y, Math.max(1, r * 0.12), 0, 2 * Math.PI)
          ctx.fillStyle = color
          ctx.fill()
          // Every node is labelled (Figma); in a crowded graph only the bigger ones until zoomed in.
          if (data.nodes.length <= 80 || scale > 1.3 || r >= 7 || n.id === selected || (neighbours?.has(String(n.id)) ?? false)) {
            const size = Math.max(10.5 / scale, 2.5)
            ctx.font = `500 ${size}px ${colors.mono || 'monospace'}`
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            ctx.fillStyle = n.id === selected ? colors.selected : colors.label
            const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label
            ctx.fillText(label, x + r + 4 / scale, y)
          }
          ctx.globalAlpha = 1
        }}
        nodePointerAreaPaint={(n, paint, ctx) => {
          ctx.fillStyle = paint
          ctx.beginPath()
          ctx.arc(n.x ?? 0, n.y ?? 0, 11, 0, 2 * Math.PI)
          ctx.fill()
        }}
      />
    </div>
  )
}

/** Ring radius: "You" biggest, the rest by how connected they are. */
function radius(n: Node): number {
  return n.kind === 'person' ? 11 : 5 + Math.min(6, Math.sqrt(n.degree) * 1.4)
}

/** A link end is an id before the simulation starts and the node object after. */
function endId(end: unknown): string {
  return typeof end === 'object' && end !== null ? String((end as { id?: unknown }).id) : String(end)
}
