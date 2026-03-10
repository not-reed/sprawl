export interface Memory {
  id: string;
  content: string;
  category: string;
  tags: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  score?: number;
  matchType?: string;
}

export interface GraphNode {
  id: string;
  name: string;
  display_name: string;
  node_type: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  // Added by traverse
  depth?: number;
  via_relation?: string | null;
}

export interface GraphEdge {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
  properties: string | null;
  memory_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Observation {
  id: string;
  conversation_id: string;
  content: string;
  priority: string;
  observation_date: string;
  source_message_ids: string | null;
  token_count: number | null;
  generation: number;
  superseded_at: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  source: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
  observation_count: number;
}

export interface Stats {
  memories: number;
  nodes: number;
  edges: number;
  observations: number;
  categories: { category: string; count: number }[];
  daily: { date: string; count: number }[];
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
