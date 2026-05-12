import { useRef, useEffect, useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useGraph } from "../hooks/useGraph";
import { useGraphInteraction } from "../hooks/useGraphInteraction";
import { drawEdges, drawNodes } from "../lib/graph-render";
import { GraphControls } from "./GraphControls";
import { GraphDetail } from "./GraphDetail";
import { NodeTooltip } from "./NodeTooltip";

export function GraphView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const [searchParams] = useSearchParams();
  const graph = useGraph(dims.w, dims.h);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = transformRef.current;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);
    drawEdges(ctx, graph, t);
    drawNodes(ctx, graph, t);
    ctx.restore();
  }, [graph]);

  useGraphInteraction(canvasRef, graph, render, transformRef);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDims({ w: width, h: height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Handle ?node= param
  useEffect(() => {
    const nodeId = searchParams.get("node");
    if (nodeId) graph.selectNode(nodeId);
  }, [searchParams, graph]);

  // Set up tick-based rendering
  useEffect(() => {
    graph.setOnTick(render);
    return () => graph.setOnTick(null);
  }, [render, graph]);

  // Also render on filter/selection changes
  useEffect(() => {
    render();
  }, [render]);

  const allNodeNames = new Map(
    graph.nodes.map((n) => [n.id, { display_name: n.display_name, node_type: n.node_type }]),
  );

  if (graph.loading) {
    return (
      <div className="loading" style={{ flex: 1 }}>
        Loading graph...
      </div>
    );
  }

  return (
    <div className="graph-container">
      <div className="graph-canvas-wrapper" ref={containerRef}>
        <canvas ref={canvasRef} style={{ cursor: "grab", width: "100%", height: "100%" }} />
        <GraphControls
          typeFilters={graph.typeFilters}
          onToggleType={graph.toggleTypeFilter}
          onReset={graph.reheat}
          onSearch={graph.searchAndFocus}
        />
        {graph.hoveredNode && graph.hoverPos && (
          <NodeTooltip node={graph.hoveredNode} position={graph.hoverPos} />
        )}
      </div>
      {graph.selectedNode && (
        <GraphDetail
          node={graph.selectedNode}
          edges={graph.selectedNodeEdges}
          memories={graph.selectedNodeMemories}
          allNodeNames={allNodeNames}
          onSelectNode={graph.selectNode}
          onClose={() => graph.selectNode(null)}
        />
      )}
    </div>
  );
}
