export interface Campaign {
  id: string;
  name: string;
  system: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignDetail extends Campaign {
  sessions: Session[];
}

export interface Session {
  id: string;
  campaign_id: string;
  conversation_id: string;
  name: string | null;
  mode: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: string;
  audioUrl?: string;
}

export interface Voice {
  id: string;
  name: string;
  gender: "female" | "male";
  accent: string;
  grade: string;
}

export interface VoiceConfig {
  defaultVoice: string;
  npcVoices: Record<string, string>;
  savedBlends?: Array<{ name: string; expression: string }>;
}

export interface Observation {
  id: string;
  conversation_id: string;
  content: string;
  priority: string;
  observation_date: string;
  token_count: number | null;
  generation: number;
  superseded_at: string | null;
  created_at: string;
}
