import { Type, type Static } from "@sinclair/typebox";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { setSecret, listSecretKeys, deleteSecret } from "../../extensions/secrets.js";

const SecretStoreParams = Type.Object({
  key: Type.String({ description: "Secret key name (e.g. OPENWEATHERMAP_API_KEY)" }),
  value: Type.String({ description: "Secret value" }),
});

type SecretStoreInput = Static<typeof SecretStoreParams>;

export function createSecretStoreTool(db: Kysely<Database>) {
  return {
    name: "secret_store",
    description:
      "Store a secret (API key, token, etc.) for use by extensions. Secrets persist across restarts and are available to dynamic tools via their context.",
    parameters: SecretStoreParams,
    execute: async (_toolCallId: string, args: SecretStoreInput) => {
      await setSecret(db, args.key, args.value, "agent");
      return {
        output: `Secret "${args.key}" stored successfully.`,
        details: { key: args.key },
      };
    },
  };
}

const SecretListParams = Type.Object({});

export function createSecretListTool(db: Kysely<Database>) {
  return {
    name: "secret_list",
    description:
      "List all stored secret key names. Returns keys and their source (env or agent) but never the values.",
    parameters: SecretListParams,
    execute: async () => {
      const keys = await listSecretKeys(db);
      if (keys.length === 0) {
        return { output: "No secrets stored.", details: { count: 0 } };
      }
      const listing = keys.map((k) => `- ${k.key} (source: ${k.source})`).join("\n");
      return {
        output: `${keys.length} secret(s):\n${listing}`,
        details: { keys: keys.map((k) => k.key), count: keys.length },
      };
    },
  };
}

const SecretDeleteParams = Type.Object({
  key: Type.String({ description: "Secret key name to delete" }),
});

type SecretDeleteInput = Static<typeof SecretDeleteParams>;

export function createSecretDeleteTool(db: Kysely<Database>) {
  return {
    name: "secret_delete",
    description: "Delete a stored secret by key name.",
    parameters: SecretDeleteParams,
    execute: async (_toolCallId: string, args: SecretDeleteInput) => {
      const deleted = await deleteSecret(db, args.key);
      if (deleted) {
        return {
          output: `Secret "${args.key}" deleted.`,
          details: { key: args.key, deleted: true },
        };
      }
      return {
        output: `Secret "${args.key}" not found.`,
        details: { key: args.key, deleted: false },
      };
    },
  };
}
