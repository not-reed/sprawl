import { useState, useCallback } from "react";
import { api } from "../lib/api";
import type { GraphNode, GraphEdge } from "../lib/types";
import type { LayoutNode } from "../lib/graph-layout";
import { useGraphSimulation } from "./useGraphSimulation";

import type { LayoutLink } from "../lib/graph-layout";

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

function useGraphSimulationControl(sim: ReturnType<typeof useGraphSimulation>) {
  const pinNode = useCallback(
    (nodeId: string, x: number, y: number) => {
      const node = sim.nodesMapRef.current.get(nodeId);
      if (node) {
        node.fx = x;
        node.fy = y;
        node.pinned = true;
        sim.simulationRef.current?.alpha(0.1).restart();
      }
    },
    [sim],
  );

  const unpinNode = useCallback(
    (nodeId: string) => {
      const node = sim.nodesMapRef.current.get(nodeId);
      if (node) {
        node.fx = undefined;
        node.fy = undefined;
        node.pinned = false;
        sim.simulationRef.current?.alpha(0.1).restart();
      }
    },
    [sim],
  );

  const reheat = useCallback(() => {
    sim.simulationRef.current?.alpha(0.5).restart();
  }, [sim]);

  return { pinNode, unpinNode, reheat };
}

export function useGraph(width: number, height: number) {
  const sim = useGraphSimulation(width, height);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedNodeEdges, setSelectedNodeEdges] = useState<GraphEdge[]>([]);
  const [selectedNodeMemories, setSelectedNodeMemories] = useState<any[]>([]);
  const [hoveredNode, setHoveredNode] = useState<LayoutNode | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [typeFilters, setTypeFilters] = useState(new Set(ALL_TYPES));
  const { pinNode, unpinNode, reheat } = useGraphSimulationControl(sim);

  const selectNode = useCallback(async (nodeId: string | null) => {
    if (!nodeId) {
      setSelectedNodeId(null);
      setSelectedNode(null);
      setSelectedNodeEdges([]);
      setSelectedNodeMemories([]);
      return;
    }
    setSelectedNodeId(nodeId);
    const [nodeData, edgesData, memoriesData] = await Promise.all([
      api.getNode(nodeId),
      api.getNodeEdges(nodeId),
      api.getNodeMemories(nodeId),
    ]);
    setSelectedNode(nodeData);
    setSelectedNodeEdges(edgesData.edges);
    setSelectedNodeMemories(memoriesData.memories);
  }, []);

  const setHover = useCallback((node: LayoutNode | null, pos: { x: number; y: number } | null) => {
    setHoveredNode(node);
    setHoverPos(pos);
  }, []);

  const toggleTypeFilter = useCallback((type: string) => {
    setTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const searchAndFocus = useCallback(
    async (query: string) => {
      if (!query.trim()) return;
      const res = await api.searchNodes(query, 5);
      if (res.nodes.length > 0) {
        const targetId = res.nodes[0].id;
        if (sim.nodesMapRef.current.has(targetId)) {
          selectNode(targetId);
        } else {
          await sim.expandNode(targetId);
          selectNode(targetId);
        }
      }
    },
    [selectNode, sim],
  );

  return {
    nodes: sim.nodes,
    links: sim.links,
    selectedNodeId,
    selectedNode,
    selectedNodeEdges,
    selectedNodeMemories,
    hoveredNode,
    hoverPos,
    typeFilters,
    loading: sim.loading,
    selectNode,
    expandNode: sim.expandNode,
    setHover,
    toggleTypeFilter,
    pinNode,
    unpinNode,
    reheat,
    setOnTick: sim.setOnTick,
    searchAndFocus,
    simulationRef: sim.simulationRef,
    nodesMapRef: sim.nodesMapRef,
  };
}
