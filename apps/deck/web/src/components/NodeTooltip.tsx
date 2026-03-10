import type { LayoutNode } from "../lib/graph-layout";

interface NodeTooltipProps {
  node: LayoutNode;
  position: { x: number; y: number };
}

export function NodeTooltip({ node, position }: NodeTooltipProps) {
  return (
    <div
      className="graph-tooltip"
      style={{
        left: position.x + 12,
        top: position.y - 8,
      }}
    >
      <div className="graph-tooltip-name">{node.display_name}</div>
      <div className="graph-tooltip-type">{node.node_type}</div>
      {node.description && <div className="graph-tooltip-desc">{node.description}</div>}
      <div className="graph-tooltip-edges">{node.edgeCount} connections</div>
    </div>
  );
}
