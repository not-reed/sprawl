import { evaluate } from "@lmnr-ai/lmnr";
import { reflect, DEFAULT_REFLECTOR_PROMPT } from "../src/index.js";
import type { ReflectorInput, ReflectorOutput, WorkerModelConfig } from "../src/index.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Model pricing ($/M tokens) — update from https://openrouter.ai as needed ---
// Values are [inputPricePerM, outputPricePerM]
// Eval results (overall/judge): minimax=0.94/0.93, gpt-oss-120b=0.93/0.91, gemini-2.5-flash-lite=0.88/0.78,
// glm-4.7-flash=0.94/0.93, mimo-v2-flash=0.87/0.74 (hallucinated), qwen=0.62/0.52 (slow + unreliable)
// stepfun/step-3.5-flash skipped — no compression on case 2, similar cost to minimax
// glm-4.5-air skipped — empty response on case 5
const MODEL_PRICING: Record<string, [number, number]> = {
  // --- Judge ---
  "deepseek/deepseek-v3.2": [0.26, 0.38],
  // --- Tested memory workers (best to worst overall score) ---
  "minimax/minimax-m2.5": [0.118, 0.99], // overall=0.94, reliable
  "z-ai/glm-4.7-flash": [0.06, 0.4], // overall=0.94, reliable
  "openai/gpt-oss-120b": [0.039, 0.19], // overall=0.93, best value (5x cheaper than minimax)
  "google/gemini-2.5-flash-lite": [0.1, 0.4],
  "xiaomi/mimo-v2-flash": [0.09, 0.29], // overall=0.87, hallucinated Oregon + Ratatui
  "qwen/qwen3.5-flash-02-23": [0.065, 0.26], // overall=0.62, slow + ignores max_tokens
  "z-ai/glm-4.5-air": [0.13, 0.85],
  // --- Untested / future models ---
  "google/gemini-3-flash-preview": [0.5, 3],
  "google/gemini-3.1-flash-lite-preview": [0.25, 1.5],
  "xiaomi/mimo-v2-omni": [0.4, 2],
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): string {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return `${inputTokens}in/${outputTokens}out (no pricing)`;
  const [inRate, outRate] = pricing;
  const cost = (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
  return `${inputTokens}in/${outputTokens}out ($${cost.toFixed(5)})`;
}

// --- Config ---

const apiKey = process.env.OPENROUTER_API_KEY;
const projectApiKey = process.env.LMNR_PROJECT_API_KEY;

// LMNR_BASE_URL = e.g. http://localhost for local dev (no port — use LMNR_HTTP_PORT / LMNR_GRPC_PORT)
const lmnrBaseUrl = process.env.LMNR_BASE_URL;
const lmnrHttpPort = process.env.LMNR_HTTP_PORT ? Number(process.env.LMNR_HTTP_PORT) : undefined;
const lmnrGrpcPort = process.env.LMNR_GRPC_PORT ? Number(process.env.LMNR_GRPC_PORT) : undefined;

if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
if (!projectApiKey) throw new Error("LMNR_PROJECT_API_KEY is required");

const workerConfig: WorkerModelConfig = {
  apiKey,
  model: process.env.MEMORY_WORKER_MODEL ?? "google/gemini-2.5-flash-preview",
};

const groupName = process.env.EVAL_GROUP_ID ?? "reflector-baseline";

// --- Dataset ---

type Datapoint = {
  data: {
    observations: ReflectorInput["observations"];
    today: string;
    prompt?: string;
  };
  target: {
    mustKeep: string[];
    shouldDrop?: string[];
    supersedePairs?: { oldId: string }[];
  };
  metadata: { description: string };
};

function loadDataset(): Datapoint[] {
  const publicPath = join(__dirname, "data/reflector.json");
  const privatePath = join(__dirname, "data-private/reflector-real.json");

  const publicData: Datapoint[] = JSON.parse(readFileSync(publicPath, "utf8"));
  const privateData: Datapoint[] = existsSync(privatePath)
    ? JSON.parse(readFileSync(privatePath, "utf8"))
    : [];

  return [...publicData, ...privateData];
}

const judgeModel = process.env.EVAL_JUDGE_MODEL ?? "deepseek/deepseek-v3-2";

// --- Judge ---

// Cache judge results to avoid calling the LLM twice per datapoint
// (judge evaluator + overall evaluator both need the score)
const judgeCache = new Map<string, Promise<{ score: number; rationale: string }>>();

function judgeKey(data: Datapoint["data"], output: ReflectorOutput): string {
  return JSON.stringify({
    obs: data.observations.map((o) => o.id),
    out: output.observations.length,
  });
}

async function callJudge(
  data: Datapoint["data"],
  output: ReflectorOutput,
  target: Datapoint["target"],
): Promise<{ score: number; rationale: string }> {
  const key = judgeKey(data, output);
  if (judgeCache.has(key)) return judgeCache.get(key)!;

  const promise = (async () => {
    const inputText = data.observations
      .map((o) => `[${o.id}] (${o.priority}) ${o.content}`)
      .join("\n");
    const outputText =
      output.observations.length === 0
        ? "(empty — all observations dropped)"
        : output.observations.map((o) => `(${o.priority}) ${o.content}`).join("\n");

    const userMessage = `You are evaluating a memory compression system that condenses a list of observations.

INPUT observations (${data.observations.length} total, today=${data.today}):
${inputText}

OUTPUT observations after compression (${output.observations.length} total):
${outputText}

REQUIRED FACTS that must appear in the output: ${target.mustKeep.join(", ")}

Note: observations in superseded_ids were intentionally removed as stale or merged into others. Judge only the OUTPUT observations above.

Score 1-10 on:
- Fact retention: do all required facts appear in the OUTPUT? (most important)
- Merge quality: redundant inputs merged into richer single observations?
- No hallucinations: output contains only information present in the input?
- Appropriate dropping: low-value or past one-time events removed while ongoing facts kept?

Respond with JSON only: {"score": <1-10>, "rationale": "<one sentence>"}`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: judgeModel,
        messages: [{ role: "user", content: userMessage }],
        temperature: 0,
        max_tokens: 256,
      }),
    });

    if (!response.ok) {
      return { score: 0, rationale: `Judge API error: ${response.status}` };
    }

    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body.choices[0]?.message?.content ?? "";

    // Track judge token usage
    const caseId = caseKey(data);
    const existing = caseTokens.get(caseId) ?? {
      reflector: { in: 0, out: 0 },
      judge: { in: 0, out: 0 },
    };
    existing.judge = {
      in: body.usage?.prompt_tokens ?? 0,
      out: body.usage?.completion_tokens ?? 0,
    };
    caseTokens.set(caseId, existing);

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("no JSON found");
      const parsed = JSON.parse(jsonMatch[0]) as { score: number; rationale: string };
      const normalized = Math.max(0, Math.min(1, (parsed.score - 1) / 9));
      return { score: normalized, rationale: parsed.rationale ?? "" };
    } catch {
      return { score: 0, rationale: `Failed to parse: ${text.slice(0, 100)}` };
    }
  })();

  judgeCache.set(key, promise);
  return promise;
}

// --- Evaluators ---

const TARGET_COMPRESSION_RATIO = 0.6;

function coverage(output: ReflectorOutput, target: Datapoint["target"]): number {
  if (target.mustKeep.length === 0) return 1;
  const allContent = output.observations.map((o) => o.content.toLowerCase()).join("\n");
  const matched = target.mustKeep.filter((fact) => allContent.includes(fact.toLowerCase()));
  return matched.length / target.mustKeep.length;
}

function conciseness(
  output: ReflectorOutput,
  _target: Datapoint["target"],
  data: Datapoint["data"],
): number {
  if (data.observations.length === 0) return 1;
  const ratio = output.observations.length / data.observations.length;
  return 1 - Math.min(Math.abs(ratio - TARGET_COMPRESSION_RATIO), 1);
}

function supersession(output: ReflectorOutput, target: Datapoint["target"]): number {
  if (!target.supersedePairs?.length) return 1;
  const supersededIds = new Set(output.superseded_ids);
  const matched = target.supersedePairs.filter((p) => supersededIds.has(p.oldId));
  return matched.length / target.supersedePairs.length;
}

function overall(scores: Record<string, number>): number {
  const { coverage: c, conciseness: co, supersession: s, judge: j } = scores;
  return c * 0.4 + j * 0.4 + co * 0.1 + s * 0.1;
}

// --- Run ---

const dataset = loadDataset();
// Keyed by first observation ID — populated during executor/judge runs
const judgeRationales = new Map<string, string>();
const caseTokens = new Map<
  string,
  { reflector: { in: number; out: number }; judge: { in: number; out: number } }
>();

function caseKey(data: Datapoint["data"]): string {
  return data.observations[0]?.id ?? "unknown";
}

console.log(
  `Running reflector evals: ${dataset.length} cases, model=${workerConfig.model}, group=${groupName}`,
);

const result = await evaluate({
  data: dataset,
  executor: async (data: Datapoint["data"]): Promise<ReflectorOutput> => {
    const prompt = data.prompt ?? DEFAULT_REFLECTOR_PROMPT;
    const output = await reflect(
      { ...workerConfig },
      { observations: data.observations, today: data.today },
      undefined,
      prompt,
    );
    const key = caseKey(data);
    const existing = caseTokens.get(key) ?? {
      reflector: { in: 0, out: 0 },
      judge: { in: 0, out: 0 },
    };
    existing.reflector = {
      in: output.usage?.input_tokens ?? 0,
      out: output.usage?.output_tokens ?? 0,
    };
    caseTokens.set(key, existing);
    return output;
  },
  evaluators: {
    coverage: (output: ReflectorOutput, target: Datapoint["target"]) => coverage(output, target),
    conciseness: (output: ReflectorOutput, target: Datapoint["target"], data: Datapoint["data"]) =>
      conciseness(output, target, data),
    supersession: (output: ReflectorOutput, target: Datapoint["target"]) =>
      supersession(output, target),
    judge: async (
      output: ReflectorOutput,
      target: Datapoint["target"],
      data: Datapoint["data"],
    ) => {
      const res = await callJudge(data, output, target);
      judgeRationales.set(caseKey(data), res.rationale);
      return res.score;
    },
    overall: async (
      output: ReflectorOutput,
      target: Datapoint["target"],
      data: Datapoint["data"],
    ) => {
      const j = (await callJudge(data, output, target)).score;
      return overall({
        coverage: coverage(output, target),
        conciseness: conciseness(output, target, data),
        supersession: supersession(output, target),
        judge: j,
      });
    },
  },
  groupName,
  config: {
    projectApiKey,
    ...(lmnrBaseUrl ? { baseUrl: lmnrBaseUrl } : {}),
    ...(lmnrHttpPort ? { httpPort: lmnrHttpPort } : {}),
    ...(lmnrGrpcPort ? { grpcPort: lmnrGrpcPort } : {}),
  },
});

// --- Summary ---

const avg = result.averageScores;
const pad = (n: number | undefined) => (n ?? 0).toFixed(2).padStart(5);
const cols = (s: Record<string, number | undefined>) =>
  `cov=${pad(s.coverage)} concise=${pad(s.conciseness)} super=${pad(s.supersession)} judge=${pad(s.judge)} overall=${pad(s.overall)}`;

let totalReflectorIn = 0,
  totalReflectorOut = 0,
  totalJudgeIn = 0,
  totalJudgeOut = 0;

console.log("\n--- Results ---");
for (const [i, dp] of dataset.entries()) {
  const key = caseKey(dp.data);
  const rationale = judgeRationales.get(key) ?? "(no judge result)";
  const tokens = caseTokens.get(key);
  totalReflectorIn += tokens?.reflector.in ?? 0;
  totalReflectorOut += tokens?.reflector.out ?? 0;
  totalJudgeIn += tokens?.judge.in ?? 0;
  totalJudgeOut += tokens?.judge.out ?? 0;
  const reflectorCost = tokens
    ? estimateCost(workerConfig.model, tokens.reflector.in, tokens.reflector.out)
    : "n/a";
  const judgeCost = tokens ? estimateCost(judgeModel, tokens.judge.in, tokens.judge.out) : "n/a";
  console.log(`case ${i}  ${dp.metadata.description}`);
  console.log(`         reflector: ${reflectorCost}`);
  console.log(`         judge:     ${judgeCost}`);
  console.log(`         ${rationale}`);
}

console.log();
console.log(`mean  ${cols(avg)}`);
console.log();
console.log(
  `total reflector: ${estimateCost(workerConfig.model, totalReflectorIn, totalReflectorOut)}`,
);
console.log(`total judge:     ${estimateCost(judgeModel, totalJudgeIn, totalJudgeOut)}`);
