import { configDefaults, defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    environment: "node",
    env: loadEnv("test", process.cwd(), ""),
    exclude: [...configDefaults.exclude, "**/*.ai.test.ts"],
  },
});
