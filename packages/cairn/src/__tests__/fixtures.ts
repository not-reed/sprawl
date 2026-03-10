/**
 * Factory functions for creating test data with sensible defaults.
 * Use the spread pattern: createTestX({ field: override })
 */

import type { Observation, GraphNode, GraphEdge, CairnMessage } from "../types.js";
import type { Memory, NewMemory, NewObservation } from "../db/types.js";

// ── Observations (runtime type from types.ts) ──────────────────────

export function createTestObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs-test-1",
    conversation_id: "conv-test-1",
    content: "Test observation content",
    priority: "medium",
    observation_date: "2024-01-15",
    source_message_ids: [],
    token_count: 10,
    generation: 0,
    superseded_at: null,
    created_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

// ── Memories (DB selectable type) ──────────────────────────────────

export function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-test-1",
    content: "Test memory content",
    category: "general",
    tags: null,
    source: "user",
    embedding: null,
    created_at: "2024-01-15T00:00:00Z",
    updated_at: "2024-01-15T00:00:00Z",
    archived_at: null,
    ...overrides,
  };
}

export function createTestNewMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    id: "mem-test-1",
    content: "Test memory content",
    source: "user",
    ...overrides,
  };
}

// ── Graph Nodes ────────────────────────────────────────────────────

export function createTestGraphNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "node-test-1",
    name: "test entity",
    display_name: "Test Entity",
    node_type: "entity",
    description: null,
    embedding: null,
    created_at: "2024-01-15T00:00:00Z",
    updated_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

// ── Graph Edges ────────────────────────────────────────────────────

export function createTestGraphEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: "edge-test-1",
    source_id: "node-test-1",
    target_id: "node-test-2",
    relation: "related_to",
    weight: 1,
    properties: null,
    memory_id: null,
    created_at: "2024-01-15T00:00:00Z",
    updated_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

// ── Messages ───────────────────────────────────────────────────────

export function createTestMessage(overrides: Partial<CairnMessage> = {}): CairnMessage {
  return {
    id: "msg-test-1",
    role: "user",
    content: "Test message content",
    created_at: "2024-01-15T00:00:00Z",
    ...overrides,
  };
}

// ── New Observations (insertable shape) ────────────────────────────

export function createTestNewObservation(overrides: Partial<NewObservation> = {}): NewObservation {
  return {
    id: "obs-test-1",
    conversation_id: "conv-test-1",
    content: "Test observation content",
    observation_date: "2024-01-15",
    token_count: 10,
    ...overrides,
  };
}
