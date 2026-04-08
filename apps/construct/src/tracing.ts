import { Laminar } from "@lmnr-ai/lmnr";

let enabled = false;

export function initTracing(apiKey: string | undefined, baseUrl: string | undefined): void {
  if (!apiKey) return;
  Laminar.initialize({ projectApiKey: apiKey, baseUrl });
  enabled = true;
}

export interface TracingSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attrs: Record<string, string | number | boolean>): void;
  end(): void;
}

const noopSpan: TracingSpan = {
  setAttribute() {},
  setAttributes() {},
  end() {},
};

export interface SpanOptions {
  name: string;
  input?: unknown;
  spanType?: "DEFAULT" | "LLM" | "TOOL" | "EXECUTOR" | "EVALUATOR";
  tags?: string[];
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export function startActiveSpan(opts: SpanOptions): TracingSpan {
  if (!enabled) return noopSpan;
  const span = Laminar.startActiveSpan(opts);
  return {
    setAttribute(key, value) {
      span.setAttribute(key, value);
    },
    setAttributes(attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        span.setAttribute(k, v);
      }
    },
    end() {
      span.end();
    },
  };
}
