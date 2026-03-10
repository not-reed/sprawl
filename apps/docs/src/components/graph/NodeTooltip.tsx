import type { LayoutNode } from "./graph-layout";

interface NodeTooltipProps {
  node: LayoutNode;
  position: { x: number; y: number };
}

export function NodeTooltip({ node, position }: NodeTooltipProps) {
  return (
    <div
      style={{
        position: "absolute",
        left: position.x + 12,
        top: position.y - 8,
        background: "rgba(18, 18, 26, 0.95)",
        border: "1px solid rgba(124, 108, 240, 0.3)",
        borderRadius: 4,
        padding: "6px 10px",
        pointerEvents: "none",
        zIndex: 20,
        maxWidth: 250,
      }}
    >
      <div style={{ color: "#e4e4ef", fontSize: 13, fontWeight: 600 }}>{node.display_name}</div>
      <div style={{ color: "#9898a8", fontSize: 11 }}>{node.node_type}</div>
      {node.description && (
        <div style={{ color: "#c8c8d8", fontSize: 11, marginTop: 3 }}>{node.description}</div>
      )}
      <div style={{ color: "#686878", fontSize: 10, marginTop: 2 }}>
        {node.edgeCount} connections
      </div>
    </div>
  );
}
