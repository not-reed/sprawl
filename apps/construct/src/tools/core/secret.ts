import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { setSecret, listSecretKeys, deleteSecret } from "../../extensions/secrets.js";

const SecretParams = Type.Object({
  action: Type.Union([Type.Literal("store"), Type.Literal("list"), Type.Literal("delete")], {
    description:
      'Action: "store" to save a secret, "list" to see key names, "delete" to remove one',
  }),
  key: Type.Optional(
    Type.String({ description: "Secret key name (required for store and delete)" }),
  ),
  value: Type.Optional(Type.String({ description: "Secret value (required for store)" })),
});

type SecretInput = Static<typeof SecretParams>;

export function createSecretTool(db: Kysely<Database>) {
  return {
    name: "secret" as const,
    description:
      'Manage secrets (API keys, tokens). Actions: "store" saves a key-value pair, "list" shows key names (never values), "delete" removes a key.',
    parameters: SecretParams,
    execute: async (_toolCallId: string, args: unknown) => {
      const typed = args as SecretInput;

      switch (typed.action) {
        case "store": {
          if (!typed.key || typed.value === undefined || typed.value === "") {
            return {
              output: 'The "store" action requires both "key" and "value" parameters.',
              details: { error: "missing_params" },
            };
          }
          await setSecret(db, typed.key, typed.value, "agent");
          return {
            output: `Secret "${typed.key}" stored successfully.`,
            details: { key: typed.key },
          };
        }

        case "list": {
          const keys = await listSecretKeys(db);
          if (keys.length === 0) {
            return { output: "No secrets stored.", details: { count: 0 } };
          }
          const listing = keys.map((k) => `- ${k.key} (source: ${k.source})`).join("\n");
          return {
            output: `${keys.length} secret(s):\n${listing}`,
            details: { keys: keys.map((k) => k.key), count: keys.length },
          };
        }

        case "delete": {
          if (!typed.key) {
            return {
              output: 'The "delete" action requires a "key" parameter.',
              details: { error: "missing_params" },
            };
          }
          const deleted = await deleteSecret(db, typed.key);
          if (deleted) {
            return {
              output: `Secret "${typed.key}" deleted.`,
              details: { key: typed.key, deleted: true },
            };
          }
          return {
            output: `Secret "${typed.key}" not found.`,
            details: { key: typed.key, deleted: false },
          };
        }

        default:
          return {
            output: `Unknown action: ${typed.action}`,
            details: { error: "unknown_action" },
          };
      }
    },
  };
}
