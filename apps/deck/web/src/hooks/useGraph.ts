import { useState, useCallback, useRef, useEffect } from "react";
import type { Simulation } from "d3-force";
import type { GraphNode, GraphEdge } from "../lib/types";
import {
  buildLayoutData,
  createSimulation,
  type LayoutNode,
  type LayoutLink,
} from "../lib/graph-layout";
import { api } from "../lib/api";

export interface GraphState {
  nodes: LayoutNode[];
  links: LayoutLink[];
  selectedNodeId: string | null;
  selectedNode: GraphNode | null;
  selectedNodeEdges: GraphEdge[];
  selectedNodeMemories: any[];
  hoveredNode: LayoutNode | null;
  hoverPos: { x: number; y: number } | null;
  typeFilters: Set<string>;
  loading: boolean;
}

const ALL_TYPES = new Set(["person", "place", "concept", "event", "entity"]);

export function useGraph(width: number, height: number) {
  const [state, setState] = useState<GraphState>({
    nodes: [],
    links: [],
    selectedNodeId: null,
    selectedNode: null,
    selectedNodeEdges: [],
    selectedNodeMemories: [],
    hoveredNode: null,
    hoverPos: null,
    typeFilters: new Set(ALL_TYPES),
    loading: true,
  });

  const simulationRef = useRef<Simulation<LayoutNode, LayoutLink> | null>(null);
  const nodesMapRef = useRef(new Map<string, LayoutNode>());
  const rawNodesRef = useRef<GraphNode[]>([]);
  const rawEdgesRef = useRef<GraphEdge[]>([]);
  const onTickRef = useRef<(() => void) | null>(null);

  const rebuildSimulation = useCallback(
    (graphNodes: GraphNode[], graphEdges: GraphEdge[]) => {
      rawNodesRef.current = graphNodes;
      rawEdgesRef.current = graphEdges;

      const { nodes, links } = buildLayoutData(graphNodes, graphEdges, nodesMapRef.current);

      // Update node map
      nodesMapRef.current = new Map(nodes.map((n) => [n.id, n]));

      if (simulationRef.current) {
        simulationRef.current.stop();
      }

      simulationRef.current = createSimulation(nodes, links, width, height);
      simulationRef.current.on("tick", () => {
        setState((s) => ({ ...s, nodes: [...nodes], links: [...links] }));
        onTickRef.current?.();
      });

      setState((s) => ({ ...s, nodes, links, loading: false }));
    },
    [width, height],
  );

  // Initial load
  useEffect(() => {
    api.getFullGraph(200).then((data) => {
      rebuildSimulation(data.nodes, data.edges);
    });
  }, [rebuildSimulation]);

  const selectNode = useCallback(async (nodeId: string | null) => {
    if (!nodeId) {
      setState((s) => ({
        ...s,
        selectedNodeId: null,
        selectedNode: null,
        selectedNodeEdges: [],
        selectedNodeMemories: [],
      }));
      return;
    }

    setState((s) => ({ ...s, selectedNodeId: nodeId }));

    const [nodeData, edgesData, memoriesData] = await Promise.all([
      api.getNode(nodeId),
      api.getNodeEdges(nodeId),
      api.getNodeMemories(nodeId),
    ]);

    setState((s) => ({
      ...s,
      selectedNode: nodeData,
      selectedNodeEdges: edgesData.edges,
      selectedNodeMemories: memoriesData.memories,
    }));
  }, []);

  const expandNode = useCallback(
    async (nodeId: string, depth = 2) => {
      const traversal = await api.traverseNode(nodeId, depth);

      // Merge with existing
      const existingIds = new Set(rawNodesRef.current.map((n) => n.id));
      const mergedNodes = [
        ...rawNodesRef.current,
        ...traversal.nodes.filter((n) => !existingIds.has(n.id)),
      ];

      // Fetch edges for new nodes
      const allNodeIds = mergedNodes.map((n) => n.id);
      const fullGraph = await api.getFullGraph(allNodeIds.length + 50);

      // Filter edges to only include our merged nodes
      const nodeIdSet = new Set(allNodeIds);
      const relevantEdges = fullGraph.edges.filter(
        (e) => nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id),
      );

      const mergedEdgeIds = new Set(rawEdgesRef.current.map((e) => e.id));
      const mergedEdges = [
        ...rawEdgesRef.current,
        ...relevantEdges.filter((e) => !mergedEdgeIds.has(e.id)),
      ];

      rebuildSimulation(mergedNodes, mergedEdges);
    },
    [rebuildSimulation],
  );

  const setHover = useCallback((node: LayoutNode | null, pos: { x: number; y: number } | null) => {
    setState((s) => ({ ...s, hoveredNode: node, hoverPos: pos }));
  }, []);

  const toggleTypeFilter = useCallback((type: string) => {
    setState((s) => {
      const next = new Set(s.typeFilters);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return { ...s, typeFilters: next };
    });
  }, []);

  const pinNode = useCallback((nodeId: string, x: number, y: number) => {
    const node = nodesMapRef.current.get(nodeId);
    if (node) {
      node.fx = x;
      node.fy = y;
      node.pinned = true;
      simulationRef.current?.alpha(0.1).restart();
    }
  }, []);

  const unpinNode = useCallback((nodeId: string) => {
    const node = nodesMapRef.current.get(nodeId);
    if (node) {
      node.fx = undefined;
      node.fy = undefined;
      node.pinned = false;
      simulationRef.current?.alpha(0.1).restart();
    }
  }, []);

  const reheat = useCallback(() => {
    simulationRef.current?.alpha(0.5).restart();
  }, []);

  const setOnTick = useCallback((cb: (() => void) | null) => {
    onTickRef.current = cb;
  }, []);

  const searchAndFocus = useCallback(
    async (query: string) => {
      if (!query.trim()) return;
      const res = await api.searchNodes(query, 5);
      if (res.nodes.length > 0) {
        const targetId = res.nodes[0].id;
        // Check if node is in current graph
        if (nodesMapRef.current.has(targetId)) {
          selectNode(targetId);
        } else {
          // Expand from this node
          await expandNode(targetId);
          selectNode(targetId);
        }
      }
    },
    [selectNode, expandNode],
  );

  return {
    ...state,
    selectNode,
    expandNode,
    setHover,
    toggleTypeFilter,
    pinNode,
    unpinNode,
    reheat,
    setOnTick,
    searchAndFocus,
    simulationRef,
    nodesMapRef,
  };
}
