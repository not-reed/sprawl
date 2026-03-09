import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force'
import type { DocNode, DocEdge } from './types'

export interface LayoutNode extends SimulationNodeDatum {
  id: string
  name: string
  display_name: string
  node_type: string
  description: string | null
  edgeCount: number
  pinned: boolean
}

export interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  id: string
  relation: string
  weight: number
}

const NODE_TYPE_COLORS: Record<string, string> = {
  app: '#7c6cf0',
  package: '#5b9cf5',
  concept: '#e070a0',
  pattern: '#e8a656',
  technology: '#5bc49f',
  person: '#888898',
  entity: '#888898',
}

export const NODE_TYPES = Object.keys(NODE_TYPE_COLORS)

export function getNodeColor(type: string): string {
  return NODE_TYPE_COLORS[type] ?? NODE_TYPE_COLORS.entity
}

export function getNodeRadius(edgeCount: number): number {
  return Math.max(4, Math.min(16, 4 + Math.sqrt(edgeCount) * 2))
}

export function createSimulation(
  nodes: LayoutNode[],
  links: LayoutLink[],
  width: number,
  height: number,
) {
  return forceSimulation(nodes)
    .force(
      'link',
      forceLink<LayoutNode, LayoutLink>(links)
        .id((d) => d.id)
        .distance(60)
        .strength((d) => Math.min(1, 0.3 + d.weight * 0.1)),
    )
    .force('charge', forceManyBody().strength(-120).distanceMax(300))
    .force('center', forceCenter(width / 2, height / 2).strength(0.05))
    .force('collide', forceCollide<LayoutNode>((d) => getNodeRadius(d.edgeCount) + 2))
    .alphaDecay(0.02)
    .velocityDecay(0.3)
}

export function buildLayoutData(
  graphNodes: DocNode[],
  graphEdges: DocEdge[],
  existingNodes?: Map<string, LayoutNode>,
): { nodes: LayoutNode[]; links: LayoutLink[] } {
  const edgeCounts = new Map<string, number>()
  for (const e of graphEdges) {
    edgeCounts.set(e.source_id, (edgeCounts.get(e.source_id) ?? 0) + 1)
    edgeCounts.set(e.target_id, (edgeCounts.get(e.target_id) ?? 0) + 1)
  }

  const nodeSet = new Set(graphNodes.map((n) => n.id))

  const nodes: LayoutNode[] = graphNodes.map((n) => {
    const existing = existingNodes?.get(n.id)
    return {
      id: n.id,
      name: n.name,
      display_name: n.display_name,
      node_type: n.node_type,
      description: n.description,
      edgeCount: edgeCounts.get(n.id) ?? 0,
      pinned: existing?.pinned ?? false,
      x: existing?.x,
      y: existing?.y,
      vx: existing?.vx,
      vy: existing?.vy,
      fx: existing?.pinned ? existing.fx : undefined,
      fy: existing?.pinned ? existing.fy : undefined,
    }
  })

  const links: LayoutLink[] = graphEdges
    .filter((e) => nodeSet.has(e.source_id) && nodeSet.has(e.target_id))
    .map((e) => ({
      id: e.id,
      source: e.source_id,
      target: e.target_id,
      relation: e.relation,
      weight: e.weight,
    }))

  return { nodes, links }
}
