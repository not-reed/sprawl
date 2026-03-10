import { Type } from "@sinclair/typebox";
import { reloadExtensions } from "../../extensions/index.js";
import { invalidateSystemPromptCache } from "../../system-prompt.js";

const ExtensionReloadParams = Type.Object({});

export function createExtensionReloadTool() {
  return {
    name: "extension_reload",
    description:
      "Reload all extensions (skills, tools, SOUL.md, IDENTITY.md, USER.md) from disk. Call this after creating or editing extension files to activate changes.",
    parameters: ExtensionReloadParams,
    execute: async () => {
      invalidateSystemPromptCache();
      const registry = await reloadExtensions();

      const { identity } = registry;
      const summary = [
        `SOUL.md: ${identity.soul ? "loaded" : "not found"}`,
        `IDENTITY.md: ${identity.identity ? "loaded" : "not found"}`,
        `USER.md: ${identity.user ? "loaded" : "not found"}`,
        `Skills: ${registry.skills.length}${registry.skills.length > 0 ? ` (${registry.skills.map((s) => s.name).join(", ")})` : ""}`,
        `Dynamic packs: ${registry.dynamicPacks.length}${registry.dynamicPacks.length > 0 ? ` (${registry.dynamicPacks.map((p) => p.name).join(", ")})` : ""}`,
      ].join("\n");

      return {
        output: `Extensions reloaded.\n${summary}`,
        details: {
          identity: {
            soul: !!identity.soul,
            identity: !!identity.identity,
            user: !!identity.user,
          },
          skills: registry.skills.map((s) => s.name),
          dynamicPacks: registry.dynamicPacks.map((p) => p.name),
        },
      };
    },
  };
}
