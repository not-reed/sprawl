export interface DocNode {
  id: string;
  name: string;
  display_name: string;
  node_type: string;
  description: string | null;
}

export interface DocEdge {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
}

export interface PageGraphData {
  pages: Record<string, { nodeIds: string[]; edgeIds: string[] }>;
  nodeAppearsIn: Record<string, string[]>;
}
