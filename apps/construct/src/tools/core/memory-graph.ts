import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { searchNodes, findNodeByName, traverseGraph, getNodeEdges } from "@repo/cairn";

const MemoryGraphParams = Type.Object({
  action: Type.Union([Type.Literal("explore"), Type.Literal("connect"), Type.Literal("search")], {
    description:
      'Action: "explore" traverses connections from a concept, "connect" finds paths between two concepts, "search" finds matching nodes',
  }),
  query: Type.String({
    description: "Concept name or search term",
  }),
  target: Type.Optional(
    Type.String({
      description: 'Second concept for "connect" action',
    }),
  ),
  depth: Type.Optional(
    Type.Number({
      description: "Max traversal hops (default: 2, max: 3)",
    }),
  ),
});

type MemoryGraphInput = Static<typeof MemoryGraphParams>;

export function createMemoryGraphTool(db: Kysely<Database>) {
  return {
    name: "memory_graph",
    description:
      "Explore connections between concepts and memories. Use to discover relationships, find related context, or understand how stored knowledge connects.",
    parameters: MemoryGraphParams,
    execute: async (_toolCallId: string, args: MemoryGraphInput) => {
      const maxDepth = Math.min(args.depth ?? 2, 3);

      if (args.action === "search") {
        const nodes = await searchNodes(db, args.query, 10);
        if (nodes.length === 0) {
          return { output: `No graph nodes matching "${args.query}".` };
        }

        const lines = nodes.map(
          (n) => `- ${n.display_name} (${n.node_type})${n.description ? `: ${n.description}` : ""}`,
        );
        return {
          output: `Found ${nodes.length} nodes:\n${lines.join("\n")}`,
          details: { nodes },
        };
      }

      if (args.action === "explore") {
        const node = await findNodeByName(db, args.query);
        if (!node) {
          return { output: `No node found for "${args.query}". Try "search" first.` };
        }

        const edges = await getNodeEdges(db, node.id);
        const traversed = await traverseGraph(db, node.id, maxDepth);

        const directLines = edges.map((e) => {
          const isSource = e.source_id === node.id;
          const direction = isSource ? "→" : "←";
          return `  ${direction} ${e.relation} (weight: ${e.weight})`;
        });

        const hopLines = traversed.map(
          (t) =>
            `  ${"  ".repeat(t.depth - 1)}↳ ${t.node.display_name} (${t.node.node_type}, depth ${t.depth}${t.via_relation ? `, via "${t.via_relation}"` : ""})`,
        );

        let output = `Node: ${node.display_name} (${node.node_type})`;
        if (node.description) output += `\n${node.description}`;
        if (directLines.length > 0) output += `\n\nDirect connections:\n${directLines.join("\n")}`;
        if (hopLines.length > 0)
          output += `\n\nReachable within ${maxDepth} hops:\n${hopLines.join("\n")}`;
        if (directLines.length === 0 && hopLines.length === 0)
          output += "\n\nNo connections found.";

        return {
          output,
          details: { node, edges, traversed },
        };
      }

      if (args.action === "connect") {
        if (!args.target) {
          return { output: 'The "connect" action requires a "target" parameter.' };
        }

        const sourceNode = await findNodeByName(db, args.query);
        const targetNode = await findNodeByName(db, args.target);

        if (!sourceNode) return { output: `No node found for "${args.query}".` };
        if (!targetNode) return { output: `No node found for "${args.target}".` };

        // Traverse from source and check if target is reachable
        const traversed = await traverseGraph(db, sourceNode.id, maxDepth);
        const targetHit = traversed.find((t) => t.node.id === targetNode.id);

        if (targetHit) {
          return {
            output: `"${sourceNode.display_name}" connects to "${targetNode.display_name}" at depth ${targetHit.depth} via "${targetHit.via_relation}".`,
            details: { source: sourceNode, target: targetNode, path: targetHit },
          };
        }

        return {
          output: `No connection found between "${sourceNode.display_name}" and "${targetNode.display_name}" within ${maxDepth} hops.`,
          details: { source: sourceNode, target: targetNode },
        };
      }

      return { output: `Unknown action: ${args.action}` };
    },
  };
}
