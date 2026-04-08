import { defineConfig } from "vitest/config";
import fs from "node:fs";
import path from "node:path";

function loadEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf8");
  const env: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }

  return env;
}

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    environment: "node",
    env: (() => {
      const rootDir = new URL("../..", import.meta.url).pathname;
      const rootEnv = loadEnvFile(path.join(rootDir, ".env.test"));
      const appEnv = loadEnvFile(path.join(process.cwd(), ".env.test"));
      const baseEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string") baseEnv[key] = value;
      }
      return { ...baseEnv, ...rootEnv, ...appEnv };
    })(),
    include: process.env.RUN_AI_TESTS === "1" ? ["**/*.ai.test.ts"] : ["**/*.ai.smoke.test.ts"],
  },
});
