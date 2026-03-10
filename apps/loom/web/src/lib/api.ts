const BASE = "/api";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  // Campaigns
  listCampaigns: () => fetchJson<{ campaigns: import("./types.js").Campaign[] }>("/campaigns"),

  getCampaign: (id: string) => fetchJson<import("./types.js").CampaignDetail>(`/campaigns/${id}`),

  createCampaign: (data: { name: string; system?: string; description?: string }) =>
    fetchJson<import("./types.js").Campaign>("/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  deleteCampaign: (id: string) =>
    fetchJson<{ ok: boolean }>(`/campaigns/${id}`, { method: "DELETE" }),

  // Sessions
  createSession: (campaignId: string, data?: { name?: string; mode?: string }) =>
    fetchJson<import("./types.js").Session>(`/campaigns/${campaignId}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data ?? {}),
    }),

  getSession: (id: string) => fetchJson<import("./types.js").Session>(`/sessions/${id}`),

  updateSession: (id: string, data: { name?: string; mode?: string; status?: string }) =>
    fetchJson<import("./types.js").Session>(`/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  getObservations: (sessionId: string) =>
    fetchJson<{ observations: import("./types.js").Observation[] }>(
      `/sessions/${sessionId}/observations`,
    ),

  // Chat
  getChatHistory: (sessionId: string) =>
    fetchJson<{ messages: import("./types.js").Message[] }>(`/chat/${sessionId}/history`),

  // TTS — returns a streaming URL
  generateAudio: (text: string) =>
    fetchJson<{ url: string }>("/chat/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),

  // Voice / TTS
  getVoices: () =>
    fetchJson<{ voices: import("./types.js").Voice[]; ttsEnabled: boolean }>("/settings/voices"),

  getVoiceConfig: () => fetchJson<import("./types.js").VoiceConfig>("/settings/voice-config"),

  saveVoiceConfig: (config: import("./types.js").VoiceConfig) =>
    fetchJson<import("./types.js").VoiceConfig>("/settings/voice-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }),

  previewVoice: async (voice: string, text?: string): Promise<string> => {
    const res = await fetch(`${BASE}/settings/voice-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice, text }),
    });
    if (!res.ok) throw new Error(`Preview error: ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },

  getCharacters: () => fetchJson<{ characters: string[] }>("/settings/characters"),
};
