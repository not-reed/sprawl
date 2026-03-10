/** Error during tool execution. */
export class ToolError extends Error {
  override name = "ToolError" as const;
}

/** Error loading or running extensions (skills, dynamic tools). */
export class ExtensionError extends Error {
  override name = "ExtensionError" as const;
}

/** Error in agent message processing pipeline. */
export class AgentError extends Error {
  override name = "AgentError" as const;
}

/** Error due to missing or invalid configuration. */
export class ConfigError extends Error {
  override name = "ConfigError" as const;
}
