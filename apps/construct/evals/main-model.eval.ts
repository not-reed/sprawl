import { evaluate } from "@lmnr-ai/lmnr";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_PRICING } from "../src/model-pricing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---

const apiKey = process.env.OPENROUTER_API_KEY;
const projectApiKey = process.env.LMNR_PROJECT_API_KEY;
const lmnrBaseUrl = process.env.LMNR_BASE_URL;
const lmnrHttpPort = process.env.LMNR_HTTP_PORT ? Number(process.env.LMNR_HTTP_PORT) : undefined;
const lmnrGrpcPort = process.env.LMNR_GRPC_PORT ? Number(process.env.LMNR_GRPC_PORT) : undefined;

if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
if (!projectApiKey) throw new Error("LMNR_PROJECT_API_KEY is required");

const model = process.env.OPENROUTER_MODEL ?? "google/gemini-3-flash-preview";
const judgeModel = process.env.EVAL_JUDGE_MODEL ?? "deepseek/deepseek-v3-2";
const groupName = process.env.EVAL_GROUP_ID ?? `main-model-${model.replace(/\//g, "-")}`;

function estimateCostStr(m: string, inputTokens: number, outputTokens: number): string {
  const pricing = MODEL_PRICING[m];
  if (!pricing) return `${inputTokens}in/${outputTokens}out (no pricing)`;
  const [inRate, outRate] = pricing;
  const cost = (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
  return `${inputTokens}in/${outputTokens}out ($${cost.toFixed(5)})`;
}

// --- Tool schemas (minimal, no DB needed) ---

const TOOLS = [
  {
    type: "function",
    function: {
      name: "schedule_create",
      description:
        "Create a scheduled reminder or agent task. Provide cron_expression for recurring, or run_at for one-shot.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: 'Human-readable description (e.g. "Dentist appointment reminder")',
          },
          instruction: {
            type: "string",
            description: "What the agent should do when the schedule fires.",
          },
          cron_expression: {
            type: "string",
            description: 'Cron expression for recurring schedules (e.g. "0 9 * * 1")',
          },
          run_at: {
            type: "string",
            description:
              "Datetime in user's local timezone, without Z or offset (e.g. '2025-03-05T09:00:00')",
          },
        },
        required: ["description", "instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_store",
      description:
        "Store a memory for long-term recall. Use proactively when the user shares facts, preferences, notes, or anything worth remembering.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The memory to store (fact, note, preference, reminder, etc.)",
          },
          category: {
            type: "string",
            description:
              "Category: general, preference, fact, reminder, note. Defaults to general.",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_recall",
      description:
        "Search long-term memories by keyword or topic. Use when the user asks about something you might have stored.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — keywords or topic to search for in memories",
          },
          category: {
            type: "string",
            description: "Filter by category: general, preference, fact, reminder, note",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information, news, or topics not in memory.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
        },
        required: ["query"],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a personal companion. Your tools describe their own capabilities. Use them freely; don't ask permission.

## Rules

- Be concise. Short replies unless detail is needed.
- Proactively store memories when the user shares something worth remembering.
- Search broadly when recalling — use general keywords, then filter.
- Confirm time and message before creating reminders.
- When the user says a memory is wrong, immediately call memory_forget on it before responding.
- If you tell the user you will remind them about something, create a schedule_create immediately.`;

// --- Dataset ---

type Datapoint = {
  data: { message: string };
  target: {
    expectedTool: string | null;
    requiredArgs: string[];
    mustAvoid: string[];
  };
  metadata: { description: string };
};

const dataset: Datapoint[] = JSON.parse(
  readFileSync(join(__dirname, "data/main-model.json"), "utf8"),
);

// --- Execution ---

type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type ExecResult = {
  toolCalls: ToolCall[];
  responseText: string;
  usage: { input: number; output: number };
};

const caseTokens = new Map<
  string,
  { main: { in: number; out: number }; judge: { in: number; out: number } }
>();
const judgeCache = new Map<string, Promise<{ score: number; rationale: string }>>();

function caseKey(data: Datapoint["data"]): string {
  return data.message.slice(0, 40);
}

async function callModel(message: string): Promise<ExecResult> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `[Current time: ${new Date().toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })} | ${new Date().toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} | UTC | telegram]\n\n${message}`,
        },
      ],
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${body}`);
  }

  const body = (await response.json()) as {
    choices: Array<{
      message: {
        content: string | null;
        tool_calls?: ToolCall[];
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const msg = body.choices[0]?.message;
  return {
    toolCalls: msg?.tool_calls ?? [],
    responseText: msg?.content ?? "",
    usage: {
      input: body.usage?.prompt_tokens ?? 0,
      output: body.usage?.completion_tokens ?? 0,
    },
  };
}

async function callJudge(
  message: string,
  result: ExecResult,
  target: Datapoint["target"],
  data: Datapoint["data"],
): Promise<{ score: number; rationale: string }> {
  const key = caseKey(data);
  if (judgeCache.has(key)) return judgeCache.get(key)!;

  const promise = (async () => {
    const toolSummary =
      result.toolCalls.length > 0
        ? result.toolCalls
            .map((tc) => `${tc.function.name}(${tc.function.arguments.slice(0, 200)})`)
            .join(", ")
        : "(no tool calls)";

    const userMessage = `You are evaluating an AI assistant's response to a user message.

USER MESSAGE: "${message}"

MODEL RESPONSE:
- Tool calls: ${toolSummary}
- Text response: "${result.responseText.slice(0, 500) || "(none)"}"

EXPECTED BEHAVIOR: ${
      target.expectedTool
        ? `Should call tool "${target.expectedTool}" with args: ${target.requiredArgs.join(", ")}`
        : "Should NOT call any tool — answer directly"
    }

Score 1-10 on:
- Correctness: did it do what was asked? (most important)
- Quality: is the response/tool call accurate and well-formed?
- Conciseness: appropriate length, not verbose
- No hallucinations or fabricated data in tool arguments

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

    const k = caseKey(data);
    const existing = caseTokens.get(k) ?? { main: { in: 0, out: 0 }, judge: { in: 0, out: 0 } };
    existing.judge = {
      in: body.usage?.prompt_tokens ?? 0,
      out: body.usage?.completion_tokens ?? 0,
    };
    caseTokens.set(k, existing);

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("no JSON");
      const parsed = JSON.parse(jsonMatch[0]) as { score: number; rationale: string };
      return {
        score: Math.max(0, Math.min(1, (parsed.score - 1) / 9)),
        rationale: parsed.rationale ?? "",
      };
    } catch {
      return { score: 0, rationale: `Failed to parse: ${text.slice(0, 100)}` };
    }
  })();

  judgeCache.set(key, promise);
  return promise;
}

// --- Evaluators ---

function correctTool(result: ExecResult, target: Datapoint["target"]): number {
  const calledTools = result.toolCalls.map((tc) => tc.function.name);
  if (target.expectedTool === null) {
    // Should not call any tool — check mustAvoid
    const badCall = calledTools.some((t) => target.mustAvoid.includes(t));
    return badCall ? 0 : 1;
  }
  return calledTools.includes(target.expectedTool) ? 1 : 0;
}

function argValidity(result: ExecResult, target: Datapoint["target"]): number {
  if (target.expectedTool === null || target.requiredArgs.length === 0) return 1;
  const tc = result.toolCalls.find((c) => c.function.name === target.expectedTool);
  if (!tc) return 0;
  try {
    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    const present = target.requiredArgs.filter(
      (k) => k in args && args[k] !== null && args[k] !== "",
    );
    return present.length / target.requiredArgs.length;
  } catch {
    return 0;
  }
}

// --- Run ---

const execResults = new Map<string, ExecResult>();
const judgeRationales = new Map<string, string>();

console.log(
  `Running main model evals: ${dataset.length} cases, model=${model}, group=${groupName}`,
);

const result = await evaluate({
  data: dataset,
  executor: async (data: Datapoint["data"]): Promise<ExecResult> => {
    const execResult = await callModel(data.message);
    const k = caseKey(data);
    execResults.set(k, execResult);
    const existing = caseTokens.get(k) ?? { main: { in: 0, out: 0 }, judge: { in: 0, out: 0 } };
    existing.main = { in: execResult.usage.input, out: execResult.usage.output };
    caseTokens.set(k, existing);
    return execResult;
  },
  evaluators: {
    correct_tool: (output: ExecResult, target: Datapoint["target"]) => correctTool(output, target),
    arg_validity: (output: ExecResult, target: Datapoint["target"]) => argValidity(output, target),
    judge: async (output: ExecResult, target: Datapoint["target"], data: Datapoint["data"]) => {
      const res = await callJudge(data.message, output, target, data);
      judgeRationales.set(caseKey(data), res.rationale);
      return res.score;
    },
    overall: async (output: ExecResult, target: Datapoint["target"], data: Datapoint["data"]) => {
      const ct = correctTool(output, target);
      const av = argValidity(output, target);
      const j = (await callJudge(data.message, output, target, data)).score;
      return ct * 0.4 + av * 0.2 + j * 0.4;
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

let totalMainIn = 0,
  totalMainOut = 0,
  totalJudgeIn = 0,
  totalJudgeOut = 0;

console.log("\n--- Results ---");
for (const [i, dp] of dataset.entries()) {
  const k = caseKey(dp.data);
  const tokens = caseTokens.get(k);
  const exec = execResults.get(k);
  totalMainIn += tokens?.main.in ?? 0;
  totalMainOut += tokens?.main.out ?? 0;
  totalJudgeIn += tokens?.judge.in ?? 0;
  totalJudgeOut += tokens?.judge.out ?? 0;
  const toolCalled = exec?.toolCalls.map((tc) => tc.function.name).join(", ") || "(none)";
  const rationale = judgeRationales.get(k) ?? "(no judge result)";
  console.log(`case ${i}  ${dp.metadata.description}`);
  console.log(`         tools called: ${toolCalled}`);
  console.log(`         expected:     ${dp.target.expectedTool ?? "(none)"}`);
  console.log(
    `         model:        ${estimateCostStr(model, tokens?.main.in ?? 0, tokens?.main.out ?? 0)}`,
  );
  console.log(
    `         judge:        ${estimateCostStr(judgeModel, tokens?.judge.in ?? 0, tokens?.judge.out ?? 0)}`,
  );
  console.log(`         ${rationale}`);
}

console.log();
console.log(
  `mean  correct_tool=${pad(avg.correct_tool)} arg_validity=${pad(avg.arg_validity)} judge=${pad(avg.judge)} overall=${pad(avg.overall)}`,
);
console.log();
console.log(`total model: ${estimateCostStr(model, totalMainIn, totalMainOut)}`);
console.log(`total judge: ${estimateCostStr(judgeModel, totalJudgeIn, totalJudgeOut)}`);
