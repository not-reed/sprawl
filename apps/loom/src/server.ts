import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Kysely } from "kysely";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./db/schema.js";
import { chatRoutes } from "./routes/chat.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { sessionRoutes } from "./routes/sessions.js";
import { audioRoutes } from "./routes/audio.js";
import { settingsRoutes } from "./routes/settings.js";
import { debugRoutes } from "./routes/debug.js";

export type Env = {
  Variables: {
    db: Kysely<Database>;
  };
};

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(db: Kysely<Database>) {
  const app = new Hono<Env>();

  app.use(cors());

  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  app.route("/api/chat", chatRoutes);
  app.route("/api/campaigns", campaignRoutes);
  app.route("/api", sessionRoutes);
  app.route("/api/audio", audioRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/debug", debugRoutes);

  if (process.env.NODE_ENV !== "development") {
    app.use("*", serveStatic({ root: join(__dirname, "..", "web", "dist") }));
    app.use("*", serveStatic({ root: join(__dirname, "..", "web", "dist"), path: "/index.html" }));
  }

  return app;
}
