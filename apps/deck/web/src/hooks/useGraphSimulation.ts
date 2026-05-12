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

export interface GraphSimulationState {
  nodes: LayoutNode[];
  links: LayoutLink[];
  loading: boolean;
}

export interface GraphSimulationAPI {
  nodes: LayoutNode[];
  links: LayoutLink[];
  loading: boolean;
  rebuildSimulation: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  expandNode: (nodeId: string, depth?: number) => Promise<void>;
  setOnTick: (cb: (() => void) | null) => void;
  simulationRef: React.MutableRefObject<Simulation<LayoutNode, LayoutLink> | null>;
  nodesMapRef: React.MutableRefObject<Map<string, LayoutNode>>;
}

export function useGraphSimulation(width: number, height: number): GraphSimulationAPI {
  const [state, setState] = useState<GraphSimulationState>({
    nodes: [],
    links: [],
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
      nodesMapRef.current = new Map(nodes.map((n) => [n.id, n]));
      if (simulationRef.current) simulationRef.current.stop();
      simulationRef.current = createSimulation(nodes, links, width, height);
      simulationRef.current.on("tick", () => {
        setState((s) => ({ ...s, nodes: [...nodes], links: [...links] }));
        onTickRef.current?.();
      });
      setState((s) => ({ ...s, nodes, links, loading: false }));
    },
    [width, height],
  );

  useEffect(() => {
    api.getFullGraph(200).then((data) => rebuildSimulation(data.nodes, data.edges));
  }, [rebuildSimulation]);

  const expandNode = useCallback(
    async (nodeId: string, depth = 2) => {
      const traversal = await api.traverseNode(nodeId, depth);
      const existingIds = new Set(rawNodesRef.current.map((n) => n.id));
      const mergedNodes = [
        ...rawNodesRef.current,
        ...traversal.nodes.filter((n) => !existingIds.has(n.id)),
      ];
      const allNodeIds = mergedNodes.map((n) => n.id);
      const fullGraph = await api.getFullGraph(allNodeIds.length + 50);
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

  const setOnTick = useCallback((cb: (() => void) | null) => {
    onTickRef.current = cb;
  }, []);

  return {
    ...state,
    rebuildSimulation,
    expandNode,
    setOnTick,
    simulationRef,
    nodesMapRef,
  };
}
