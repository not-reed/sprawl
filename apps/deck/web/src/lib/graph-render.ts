import type { LayoutNode } from "./graph-layout";
import { getNodeColor, getNodeRadius } from "./graph-layout";

interface GraphData {
  nodes: LayoutNode[];
  links: Array<{ source: LayoutNode | string; target: LayoutNode | string; weight: number }>;
  typeFilters: Set<string>;
  selectedNodeId: string | null;
  hoveredNode: LayoutNode | null;
}

export function drawEdges(
  ctx: CanvasRenderingContext2D,
  graph: GraphData,
  t: { x: number; y: number; k: number },
) {
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
}

export function drawNodes(
  ctx: CanvasRenderingContext2D,
  graph: GraphData,
  t: { x: number; y: number; k: number },
) {
  for (const node of graph.nodes) {
    if (node.x == null || node.y == null) continue;
    if (!graph.typeFilters.has(node.node_type)) continue;

    const r = getNodeRadius(node.edgeCount);
    const color = getNodeColor(node.node_type);
    const isSelected = graph.selectedNodeId === node.id;
    const isHovered = graph.hoveredNode?.id === node.id;

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

    if (isSelected || isHovered) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5 / t.k;
      ctx.stroke();
    }

    if (r > 6 || isSelected || isHovered || t.k > 1.5) {
      ctx.fillStyle = "rgba(228, 228, 239, 0.9)";
      ctx.font = `${Math.max(9, 11 / t.k)}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(node.display_name, node.x, node.y + r + 3);
    }
  }
}
