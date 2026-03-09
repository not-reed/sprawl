import { useState, useCallback, useRef, useEffect } from 'react'
import type { Simulation } from 'd3-force'
import type { DocNode, DocEdge, PageGraphData } from './types'
import {
  buildLayoutData,
  createSimulation,
  type LayoutNode,
  type LayoutLink,
  NODE_TYPES,
} from './graph-layout'

// Static imports
import nodesData from '../../data/graph/nodes.json'
import edgesData from '../../data/graph/edges.json'
import pageGraphsData from '../../data/graph/page-graphs.json'

const allNodes = nodesData as DocNode[]
const allEdges = edgesData as DocEdge[]
const graphData = pageGraphsData as PageGraphData

export interface StaticGraphState {
  nodes: LayoutNode[]
  links: LayoutLink[]
  selectedNodeId: string | null
  selectedNode: DocNode | null
  selectedNodeEdges: DocEdge[]
  selectedNodePages: string[]
  hoveredNode: LayoutNode | null
  hoverPos: { x: number; y: number } | null
  typeFilters: Set<string>
  loading: boolean
  empty: boolean
}

export function useStaticGraph(width: number, height: number) {
  const [state, setState] = useState<StaticGraphState>({
    nodes: [],
    links: [],
    selectedNodeId: null,
    selectedNode: null,
    selectedNodeEdges: [],
    selectedNodePages: [],
    hoveredNode: null,
    hoverPos: null,
    typeFilters: new Set(NODE_TYPES),
    loading: true,
    empty: allNodes.length === 0,
  })

  const simulationRef = useRef<Simulation<LayoutNode, LayoutLink> | null>(null)
  const nodesMapRef = useRef(new Map<string, LayoutNode>())
  const onTickRef = useRef<(() => void) | null>(null)

  // Build simulation on mount
  useEffect(() => {
    if (allNodes.length === 0) {
      setState((s) => ({ ...s, loading: false, empty: true }))
      return
    }

    const { nodes, links } = buildLayoutData(allNodes, allEdges)
    nodesMapRef.current = new Map(nodes.map((n) => [n.id, n]))

    const sim = createSimulation(nodes, links, width, height)
    simulationRef.current = sim

    sim.on('tick', () => {
      setState((s) => ({ ...s, nodes: [...nodes], links: [...links] }))
      onTickRef.current?.()
    })

    setState((s) => ({ ...s, nodes, links, loading: false }))

    return () => {
      sim.stop()
    }
  }, [width, height])

  const selectNode = useCallback((nodeId: string | null) => {
    if (!nodeId) {
      setState((s) => ({
        ...s,
        selectedNodeId: null,
        selectedNode: null,
        selectedNodeEdges: [],
        selectedNodePages: [],
      }))
      return
    }

    const node = allNodes.find((n) => n.id === nodeId) ?? null
    const edges = allEdges.filter(
      (e) => e.source_id === nodeId || e.target_id === nodeId,
    )
    const pages = graphData.nodeAppearsIn?.[nodeId] ?? []

    setState((s) => ({
      ...s,
      selectedNodeId: nodeId,
      selectedNode: node,
      selectedNodeEdges: edges,
      selectedNodePages: pages,
    }))
  }, [])

  const setHover = useCallback(
    (node: LayoutNode | null, pos: { x: number; y: number } | null) => {
      setState((s) => ({ ...s, hoveredNode: node, hoverPos: pos }))
    },
    [],
  )

  const toggleTypeFilter = useCallback((type: string) => {
    setState((s) => {
      const next = new Set(s.typeFilters)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return { ...s, typeFilters: next }
    })
  }, [])

  const pinNode = useCallback((nodeId: string, x: number, y: number) => {
    const node = nodesMapRef.current.get(nodeId)
    if (node) {
      node.fx = x
      node.fy = y
      node.pinned = true
      simulationRef.current?.alpha(0.1).restart()
    }
  }, [])

  const unpinNode = useCallback((nodeId: string) => {
    const node = nodesMapRef.current.get(nodeId)
    if (node) {
      node.fx = undefined
      node.fy = undefined
      node.pinned = false
      simulationRef.current?.alpha(0.1).restart()
    }
  }, [])

  const reheat = useCallback(() => {
    simulationRef.current?.alpha(0.5).restart()
  }, [])

  const setOnTick = useCallback((cb: (() => void) | null) => {
    onTickRef.current = cb
  }, [])

  const searchAndFocus = useCallback(
    (query: string) => {
      if (!query.trim()) return
      const q = query.toLowerCase()
      const match = allNodes.find(
        (n) => n.name.includes(q) || n.display_name.toLowerCase().includes(q),
      )
      if (match) {
        selectNode(match.id)
      }
    },
    [selectNode],
  )

  return {
    ...state,
    selectNode,
    setHover,
    toggleTypeFilter,
    pinNode,
    unpinNode,
    reheat,
    setOnTick,
    searchAndFocus,
    simulationRef,
    nodesMapRef,
    graphData,
  }
}
