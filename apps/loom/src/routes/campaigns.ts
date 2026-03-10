import { Hono } from "hono";
import type { Env } from "../server.js";
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  deleteCampaign,
  getSessionsForCampaign,
  createSession,
} from "../db/queries.js";

export const campaignRoutes = new Hono<Env>();

campaignRoutes.get("/", async (c) => {
  const db = c.get("db");
  const campaigns = await listCampaigns(db);
  return c.json({ campaigns });
});

campaignRoutes.post("/", async (c) => {
  const db = c.get("db");
  const body = await c.req.json<{ name: string; system?: string; description?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  const campaign = await createCampaign(db, body);
  return c.json(campaign, 201);
});

campaignRoutes.get("/:id", async (c) => {
  const db = c.get("db");
  const campaign = await getCampaign(db, c.req.param("id"));
  if (!campaign) return c.json({ error: "Not found" }, 404);
  const sessions = await getSessionsForCampaign(db, campaign.id);
  return c.json({ ...campaign, sessions });
});

campaignRoutes.delete("/:id", async (c) => {
  const db = c.get("db");
  const ok = await deleteCampaign(db, c.req.param("id"));
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Create session within a campaign
campaignRoutes.post("/:id/sessions", async (c) => {
  const db = c.get("db");
  const campaignId = c.req.param("id");
  const body = await c.req.json<{ name?: string; mode?: string }>().catch(() => ({}));
  const session = await createSession(db, { campaignId, ...body });
  return c.json(session, 201);
});
