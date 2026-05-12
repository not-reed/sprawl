import { useEffect } from "react";
import type { LayoutNode } from "../lib/graph-layout";
import { getNodeRadius } from "../lib/graph-layout";

interface Transform {
  x: number;
  y: number;
  k: number;
}

interface GraphAPI {
  nodes: LayoutNode[];
  typeFilters: Set<string>;
  setHover: (node: LayoutNode | null, pos: { x: number; y: number } | null) => void;
  pinNode: (id: string, x: number, y: number) => void;
  selectNode: (id: string | null) => void;
  expandNode: (id: string, depth?: number) => void;
}

function hitTestNode(
  canvas: HTMLCanvasElement,
  nodes: LayoutNode[],
  typeFilters: Set<string>,
  t: Transform,
  pos: { cx: number; cy: number },
): LayoutNode | null {
  const rect = canvas.getBoundingClientRect();
  const mx = (pos.cx - rect.left - t.x) / t.k;
  const my = (pos.cy - rect.top - t.y) / t.k;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.x == null || node.y == null) continue;
    if (!typeFilters.has(node.node_type)) continue;
    const r = getNodeRadius(node.edgeCount);
    const dx = mx - node.x;
    const dy = my - node.y;
    if (dx * dx + dy * dy <= (r + 4) * (r + 4)) return node;
  }
  return null;
}

function attachPointerListeners(
  canvas: HTMLCanvasElement,
  graph: GraphAPI,
  render: () => void,
  transformRef: React.MutableRefObject<Transform>,
) {
  let drag: { node: LayoutNode | null; startX: number; startY: number; isPan: boolean } | null =
    null;

  const onMouseDown = (e: MouseEvent) => {
    const node = hitTestNode(canvas, graph.nodes, graph.typeFilters, transformRef.current, {
      cx: e.clientX,
      cy: e.clientY,
    });
    drag = { node, startX: e.clientX, startY: e.clientY, isPan: !node };
    if (node) graph.pinNode(node.id, node.x!, node.y!);
  };

  const onMouseMove = (e: MouseEvent) => {
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
        graph.pinNode(drag.node.id, drag.node.x! + dx / t.k, drag.node.y! + dy / t.k);
      }
      return;
    }
    const node = hitTestNode(canvas, graph.nodes, graph.typeFilters, transformRef.current, {
      cx: e.clientX,
      cy: e.clientY,
    });
    if (node) {
      const rect = canvas.getBoundingClientRect();
      graph.setHover(node, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      canvas.style.cursor = "pointer";
    } else {
      graph.setHover(null, null);
      canvas.style.cursor = "grab";
    }
  };

  const onMouseUp = () => {
    drag = null;
  };

  const onClick = (e: MouseEvent) => {
    const node = hitTestNode(canvas, graph.nodes, graph.typeFilters, transformRef.current, {
      cx: e.clientX,
      cy: e.clientY,
    });
    graph.selectNode(node ? node.id : null);
  };

  const onDblClick = (e: MouseEvent) => {
    const node = hitTestNode(canvas, graph.nodes, graph.typeFilters, transformRef.current, {
      cx: e.clientX,
      cy: e.clientY,
    });
    if (node) graph.expandNode(node.id, 2);
  };

  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("mouseleave", onMouseUp);
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("dblclick", onDblClick);

  return () => {
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("mouseup", onMouseUp);
    canvas.removeEventListener("mouseleave", onMouseUp);
    canvas.removeEventListener("click", onClick);
    canvas.removeEventListener("dblclick", onDblClick);
  };
}

function attachWheelListener(
  canvas: HTMLCanvasElement,
  render: () => void,
  transformRef: React.MutableRefObject<Transform>,
) {
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const t = transformRef.current;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const zoom = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newK = Math.max(0.1, Math.min(10, t.k * zoom));
    t.x = mx - ((mx - t.x) / t.k) * newK;
    t.y = my - ((my - t.y) / t.k) * newK;
    t.k = newK;
    render();
  };

  canvas.addEventListener("wheel", onWheel);
  return () => canvas.removeEventListener("wheel", onWheel);
}

export function useGraphInteraction(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  graph: GraphAPI,
  render: () => void,
  transformRef: React.MutableRefObject<Transform>,
) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cleanup1 = attachPointerListeners(canvas, graph, render, transformRef);
    const cleanup2 = attachWheelListener(canvas, render, transformRef);
    return () => {
      cleanup1();
      cleanup2();
    };
  }, [canvasRef, graph, render, transformRef]);
}
