const BASE = "/api";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  // Memories
  searchMemories: (q: string, mode = "auto", limit = 20) =>
    fetchJson<{ results: import("./types.js").Memory[] }>(
      `/memories/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=${limit}`,
    ),

  recentMemories: (limit = 20) =>
    fetchJson<{ results: import("./types.js").Memory[] }>(`/memories/recent?limit=${limit}`),

  getMemory: (id: string) => fetchJson<import("./types.js").Memory>(`/memories/${id}`),

  getMemoryNodes: (id: string) =>
    fetchJson<{ nodes: import("./types.js").GraphNode[] }>(`/memories/${id}/nodes`),

  // Graph
  searchNodes: (q: string, limit = 20) =>
    fetchJson<{ nodes: import("./types.js").GraphNode[] }>(
      `/graph/nodes/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  getNode: (id: string) => fetchJson<import("./types.js").GraphNode>(`/graph/nodes/${id}`),

  getNodeEdges: (id: string) =>
    fetchJson<{ edges: import("./types.js").GraphEdge[] }>(`/graph/nodes/${id}/edges`),

  traverseNode: (id: string, depth = 2) =>
    fetchJson<{
      nodes: (import("./types.js").GraphNode & { depth: number; via_relation: string | null })[];
    }>(`/graph/nodes/${id}/traverse?depth=${depth}`),

  getNodeMemories: (id: string) =>
    fetchJson<{ memories: import("./types.js").Memory[] }>(`/graph/nodes/${id}/memories`),

  getFullGraph: (limit = 200) =>
    fetchJson<import("./types.js").GraphData>(`/graph/full?limit=${limit}`),

  // Observations
  getConversations: () =>
    fetchJson<{ conversations: import("./types.js").Conversation[] }>(
      "/observations/conversations",
    ),

  getObservations: (conversationId: string) =>
    fetchJson<{ observations: import("./types.js").Observation[] }>(
      `/observations/conversations/${conversationId}`,
    ),

  getAllObservations: (conversationId: string) =>
    fetchJson<{ observations: import("./types.js").Observation[] }>(
      `/observations/conversations/${conversationId}/all`,
    ),

  // Stats
  getStats: () => fetchJson<import("./types.js").Stats>("/stats"),
};
