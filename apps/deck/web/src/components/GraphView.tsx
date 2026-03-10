import { useRef, useEffect, useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useGraph } from "../hooks/useGraph";
import { getNodeColor, getNodeRadius, type LayoutNode } from "../lib/graph-layout";
import { GraphControls } from "./GraphControls";
import { GraphDetail } from "./GraphDetail";
import { NodeTooltip } from "./NodeTooltip";

export function GraphView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const [searchParams] = useSearchParams();

  // Transform state for zoom/pan
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{
    node: LayoutNode | null;
    startX: number;
    startY: number;
    isPan: boolean;
  } | null>(null);

  const graph = useGraph(dims.w, dims.h);

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
    if (nodeId) {
      graph.selectNode(nodeId);
    }
  }, [searchParams]);

  // Canvas rendering
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

    // Draw edges
    ctx.lineWidth = 0.5 / t.k;
    for (const link of graph.links) {
      const source = link.source as LayoutNode;
      const target = link.target as LayoutNode;
      if (source.x == null || source.y == null || target.x == null || target.y == null) continue;

      if (!graph.typeFilters.has(source.node_type) || !graph.typeFilters.has(target.node_type))
        continue;

      const isSelected = graph.selectedNodeId === source.id || graph.selectedNodeId === target.id;

      ctx.strokeStyle = isSelected ? "rgba(124, 108, 240, 0.4)" : "rgba(60, 60, 80, 0.3)";
      ctx.lineWidth = isSelected ? (1 + link.weight * 0.3) / t.k : (0.5 + link.weight * 0.15) / t.k;

      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
    }

    // Draw nodes
    for (const node of graph.nodes) {
      if (node.x == null || node.y == null) continue;
      if (!graph.typeFilters.has(node.node_type)) continue;

      const r = getNodeRadius(node.edgeCount);
      const color = getNodeColor(node.node_type);
      const isSelected = graph.selectedNodeId === node.id;
      const isHovered = graph.hoveredNode?.id === node.id;

      // Glow for selected
      if (isSelected) {
        ctx.fillStyle = color + "30";
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Border
      if (isSelected || isHovered) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5 / t.k;
        ctx.stroke();
      }

      // Label for larger or selected nodes
      if (r > 6 || isSelected || isHovered || t.k > 1.5) {
        ctx.fillStyle = "rgba(228, 228, 239, 0.9)";
        ctx.font = `${Math.max(9, 11 / t.k)}px -apple-system, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(node.display_name, node.x, node.y + r + 3);
      }
    }

    ctx.restore();
  }, [graph.nodes, graph.links, graph.typeFilters, graph.selectedNodeId, graph.hoveredNode, dims]);

  // Set up tick-based rendering
  useEffect(() => {
    graph.setOnTick(render);
    return () => graph.setOnTick(null);
  }, [render, graph.setOnTick]);

  // Also render on filter/selection changes
  useEffect(() => {
    render();
  }, [render]);

  // Hit testing
  const hitTest = useCallback(
    (clientX: number, clientY: number): LayoutNode | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      const mx = (clientX - rect.left - t.x) / t.k;
      const my = (clientY - rect.top - t.y) / t.k;

      for (let i = graph.nodes.length - 1; i >= 0; i--) {
        const node = graph.nodes[i];
        if (node.x == null || node.y == null) continue;
        if (!graph.typeFilters.has(node.node_type)) continue;
        const r = getNodeRadius(node.edgeCount);
        const dx = mx - node.x;
        const dy = my - node.y;
        if (dx * dx + dy * dy <= (r + 4) * (r + 4)) {
          return node;
        }
      }
      return null;
    },
    [graph.nodes, graph.typeFilters],
  );

  // Mouse handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const node = hitTest(e.clientX, e.clientY);
      dragRef.current = {
        node,
        startX: e.clientX,
        startY: e.clientY,
        isPan: !node,
      };
      if (node) {
        graph.pinNode(node.id, node.x!, node.y!);
      }
    },
    [hitTest, graph.pinNode],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const drag = dragRef.current;
      if (drag) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        drag.startX = e.clientX;
        drag.startY = e.clientY;

        if (drag.isPan) {
          transformRef.current.x += dx;
          transformRef.current.y += dy;
          render();
        } else if (drag.node) {
          const t = transformRef.current;
          const nx = drag.node.x! + dx / t.k;
          const ny = drag.node.y! + dy / t.k;
          graph.pinNode(drag.node.id, nx, ny);
        }
        return;
      }

      // Hover
      const node = hitTest(e.clientX, e.clientY);
      if (node) {
        const rect = canvasRef.current!.getBoundingClientRect();
        graph.setHover(node, {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
        canvasRef.current!.style.cursor = "pointer";
      } else {
        graph.setHover(null, null);
        if (canvasRef.current) canvasRef.current.style.cursor = "grab";
      }
    },
    [hitTest, render, graph.pinNode, graph.setHover],
  );

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const node = hitTest(e.clientX, e.clientY);
      if (node) {
        graph.selectNode(node.id);
      } else {
        graph.selectNode(null);
      }
    },
    [hitTest, graph.selectNode],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const node = hitTest(e.clientX, e.clientY);
      if (node) {
        graph.expandNode(node.id, 2);
      }
    },
    [hitTest, graph.expandNode],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const t = transformRef.current;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const zoom = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newK = Math.max(0.1, Math.min(10, t.k * zoom));

      t.x = mx - ((mx - t.x) / t.k) * newK;
      t.y = my - ((my - t.y) / t.k) * newK;
      t.k = newK;

      render();
    },
    [render],
  );

  // Build node name map for detail panel
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
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onWheel={handleWheel}
          style={{ cursor: "grab", width: "100%", height: "100%" }}
        />
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
