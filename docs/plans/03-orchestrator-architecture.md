# Plan 03 — Orchestrator architecture

> **How to use this document.** Execute the steps in order. Every step gives you the exact file path and the exact code. Do not redesign anything. Do not skip steps. If a step says "replace lines X–Y", open the file and replace exactly those lines. When you finish all steps, run the checks in Section 14.

---

## 1. What this project is

**Signal Interview** is a browser-based automated coding interview app.

A candidate joins. An AI voice agent (OpenAI Realtime) runs a timed interview. The candidate writes code in a Monaco editor and can draw on a tldraw whiteboard. The voice agent listens, inspects both surfaces through tool calls, and asks questions. A backend workflow scores the interview afterwards.

**Stack:** Go 1.19+ backend (standard library only), React 18 + TypeScript + Vite frontend, `@openai/agents` v0.15 for the voice agent.

**Run it:**
```bash
make install
make run            # http://localhost:8080
```

**Dev mode (two terminals):**
```bash
go run ./cmd/server -dev-dir web
cd web && npm run dev      # http://localhost:5173, proxies /api to :8080
```

**Check it:**
```bash
make check          # runs: npm run typecheck, go test ./...
```

---

## 2. The problem you are fixing

Right now the voice agent decides everything by itself, in the moment.

A browser timer fires every 15 seconds. If the code or whiteboard changed, it pushes a message into the voice session saying "review the workspace, ask a question if useful." The voice agent then decides whether to speak.

This produces three problems:

1. **It talks too much.** A realtime voice model prodded every 15 seconds will find something to say.
2. **Questions are shallow.** The model reacts to the last edit. It has no memory of what it already tested.
3. **Rubric coverage is random.** Nothing tracks which rubric areas have evidence and which do not.

**Your job:** add a planning layer above the voice agent.

- Cheap deterministic checks decide **when** to think. No model calls.
- Specialist observer agents interpret **what happened**. One model call each.
- An orchestrator agent tracks **rubric coverage** and queues the next question ahead of time.
- The voice agent becomes the mouth. It asks what was queued. Otherwise it stays silent.

---

## 3. Current file layout

```
interview-agent/
├── cmd/server/
│   ├── main.go                  All Go HTTP handlers, single file
│   └── main_test.go             Existing tests
├── questions/default.json       Problem, starter code, tests, demo presets
├── runtime/*.jsonl              Evidence and completion logs (gitignored)
├── docs/plans/                  This file
└── web/src/
    ├── App.tsx                  All UI. Lobby / interview / finished screens.
    ├── useInterviewAgent.ts     Realtime agents, tools, handoffs, the 15s poll
    ├── RunPanel.tsx             Test results panel
    ├── WhiteboardPanel.tsx      tldraw wrapper
    ├── runner/                  Code execution in a Web Worker
    │   ├── execute.worker.ts
    │   ├── runCode.ts
    │   └── types.ts
    ├── whiteboard/
    │   ├── scene.ts             summarizeWhiteboard() → JSON text description
    │   └── types.ts             WhiteboardSnapshot, WhiteboardPanelHandle
    └── styles.css
```

### 3.1 What already works — do not rebuild these

| Thing | Where | Notes |
|---|---|---|
| Code execution | `web/src/runner/` | Web Worker, 3s timeout, returns `RunResult` |
| Whiteboard | `WhiteboardPanel.tsx`, `whiteboard/scene.ts` | tldraw v5. `summarizeWhiteboard()` returns a **JSON text description** of every shape: type, text content, bounds, bindings. |
| Whiteboard PNG | `config.getWhiteboardImage()` | Returns a base64 data URL |
| Image into voice | `useInterviewAgent.ts:295` | `session.addImage(dataUrl, { triggerResponse: false })` already works |
| Evidence log | `POST /api/interview/evidence` | Appends to `runtime/evidence.jsonl` |
| Final report | `POST /api/interview/evaluate` | Reads evidence, calls Responses API |

### 3.2 The `InterviewAgentConfig` type you will extend

`web/src/useInterviewAgent.ts` lines 8–25:

```ts
export type InterviewAgentConfig = {
  sessionId: string;
  candidate: string;
  role: string;
  durationSeconds: number;
  media: MediaStream;
  voiceEnabled: boolean;
  getRubric: () => string;
  getCode: () => string;
  getCodeRevision: () => number;
  getLastRun: () => RunResult | null;
  getWhiteboardRevision: () => number;
  getWhiteboardChangedAt: () => number;
  getWhiteboardSummary: () => string;
  getWhiteboardImage: () => Promise<string | null>;
  onQuestion: (question: string) => void;
  onFinished: (reason: string) => void;
};
```

---

## 4. Target architecture

```
┌─ BROWSER ────────────────────────────────────────────────────────────┐
│                                                                      │
│  SIGNAL BUS  (plain TypeScript, zero model calls)                    │
│    watches: code revision, whiteboard revision, test runs, silence   │
│    gates:   45s since last question                                  │
│             3s since last keystroke                                  │
│             2s since last whiteboard stroke                          │
│             agent status is "listening"                              │
│             not in final 20 seconds                                  │
│                          │                                           │
│                          ▼  (all gates passed)                       │
│  OBSERVERS  (Agents SDK, one model call each, run in parallel)       │
│    ├── Code Observer        reads code + previous code               │
│    ├── Whiteboard Observer  reads scene summary text (not the PNG)   │
│    └── Test Observer        pure TypeScript, NO model call           │
│                          │                                           │
│                          ▼  Observation[]                            │
│  ORCHESTRATOR  (Agents SDK, one model call)                          │
│    reads: plan + coverage + observations + asked questions + time    │
│    writes: { shouldAsk, question, areaId, basis }                    │
│                          │                                           │
│                          ▼  stored in a ref                          │
│  REALTIME VOICE AGENT  (the mouth)                                   │
│    tool get_next_question → reads the ref, clears it                 │
│    outputGuardrails → cuts hint leakage before it is heard           │
└──────────────────────────────────────────────────────────────────────┘
                          │ all model calls go through
                          ▼
┌─ GO SERVER ──────────────────────────────────────────────────────────┐
│  /api/openai/*  → proxies to api.openai.com, injects the API key     │
│  /api/config    → returns model names from env                       │
└──────────────────────────────────────────────────────────────────────┘
```

**The core idea:** the orchestrator is a **coverage tracker**. It knows which rubric areas still lack evidence and steers questions there. It runs ahead, so the voice agent never waits on a model call.

---

## 5. Locked decisions — do not change these

| Decision | Value |
|---|---|
| Observers + orchestrator run in | **The browser**, using `@openai/agents` |
| API key location | **Go server only.** Browser talks to `/api/openai/v1` |
| Session state | **Browser refs.** No database, no Go state, no polling |
| Whiteboard observer input | **The scene summary text**, not the PNG |
| Whiteboard PNG | Still sent to the voice agent via `addImage`. Leave that alone |
| Video / webcam frame analysis | **Do not build.** `HLD.md` §3 lists gaze detection as a non-goal |
| Default voice agent behaviour | **Silence** |
| Model IDs | From `/api/config`, sourced from env. Never hardcode a model name |
| Tracing | Disabled in the browser. Call `setTracingDisabled(true)` |

**Why the whiteboard observer reads text, not the image:** `summarizeWhiteboard()` already returns every shape's type, text content, position, and connections as JSON. That is richer and cheaper than asking a vision model to read a picture of the same thing. The PNG still goes to the voice agent, which benefits from seeing the layout.

---

## 6. Step 1 — Install the OpenAI client package

```bash
cd web && npm install openai
```

The Agents SDK needs an `OpenAI` client instance to accept a custom `baseURL`. This package is not currently a direct dependency.

---

## 7. Step 2 — Add the Go proxy and config endpoints

Create a new file `cmd/server/proxy.go`:

```go
package main

import (
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// allowedProxyPaths lists the OpenAI API paths the browser may reach.
// Anything else is rejected so the proxy cannot be used as an open relay.
var allowedProxyPaths = map[string]bool{
	"/v1/responses":        true,
	"/v1/chat/completions": true,
}

func openAIProxyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/openai")
	if !allowedProxyPaths[path] {
		http.Error(w, "path not allowed", http.StatusForbidden)
		return
	}
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		http.Error(w, "OPENAI_API_KEY is not configured", http.StatusServiceUnavailable)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
	if err != nil {
		http.Error(w, "could not read request body", http.StatusBadRequest)
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://api.openai.com"+path, strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, "could not create upstream request", http.StatusInternalServerError)
		return
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("OpenAI-Safety-Identifier", "local-interview-demo")

	response, err := (&http.Client{Timeout: 60 * time.Second}).Do(request)
	if err != nil {
		http.Error(w, "OpenAI is unreachable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()

	upstream, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		http.Error(w, "could not read upstream response", http.StatusBadGateway)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		log.Printf("openai proxy %s returned %d: %s", path, response.StatusCode, strings.TrimSpace(string(upstream)))
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(upstream)
}

func configHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	observer := strings.TrimSpace(os.Getenv("OPENAI_OBSERVER_MODEL"))
	orchestrator := strings.TrimSpace(os.Getenv("OPENAI_ORCHESTRATOR_MODEL"))
	fallback := strings.TrimSpace(os.Getenv("OPENAI_EVALUATION_MODEL"))
	if fallback == "" {
		fallback = "gpt-5.2-codex"
	}
	if observer == "" {
		observer = fallback
	}
	if orchestrator == "" {
		orchestrator = fallback
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"observerModel":"` + observer + `","orchestratorModel":"` + orchestrator + `"}`))
}
```

In `cmd/server/main.go`, find the block of `mux.HandleFunc` lines inside `main()`. Add these two lines to it:

```go
	mux.HandleFunc("/api/openai/", openAIProxyHandler)
	mux.HandleFunc("/api/config", configHandler)
```

Add these two lines to `.env.example`:

```dotenv
OPENAI_OBSERVER_MODEL=
OPENAI_ORCHESTRATOR_MODEL=
```

Leaving them blank makes them fall back to `OPENAI_EVALUATION_MODEL`.

---

## 8. Step 3 — Shared types

Create `web/src/orchestrator/types.ts`:

```ts
export type RubricArea = {
  id: string;
  label: string;
  weight: number;
  targetEvidence: string;
  evidenceCount: number;
};

export type InterviewPlan = {
  areas: RubricArea[];
};

export type SignalKind = "code_changed" | "whiteboard_changed" | "tests_run" | "silence";

export type Signal = {
  kind: SignalKind;
  codeRevision: number;
  whiteboardRevision: number;
  elapsedSeconds: number;
  remainingSeconds: number;
};

export type Observation = {
  observer: string;
  areaId: string;
  finding: string;
  confidence: number;
  at: number;
};

export type QueuedQuestion = {
  question: string;
  areaId: string;
  basis: string;
};

export type ActivityRow = {
  type: "signal" | "observer" | "orchestrator" | "tool" | "guardrail";
  text: string;
  at: number;
};
```

---

## 9. Step 4 — Agents SDK bootstrap

Create `web/src/orchestrator/client.ts`:

```ts
import OpenAI from "openai";
import { setDefaultOpenAIClient, setTracingDisabled } from "@openai/agents";

export type ModelConfig = {
  observerModel: string;
  orchestratorModel: string;
};

let modelConfig: ModelConfig | null = null;

/**
 * Points the Agents SDK at the Go proxy so the real API key never reaches the
 * browser. Call this once before running any Agent. Safe to call repeatedly.
 */
export async function initialiseAgentClient(): Promise<ModelConfig> {
  if (modelConfig) return modelConfig;

  setDefaultOpenAIClient(
    new OpenAI({
      baseURL: `${window.location.origin}/api/openai/v1`,
      apiKey: "proxied-by-go-server",
      dangerouslyAllowBrowser: true
    })
  );
  // Tracing does not work when the core SDK is bundled for the browser.
  setTracingDisabled(true);

  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("Could not load model configuration.");
  modelConfig = (await response.json()) as ModelConfig;
  return modelConfig;
}

export function getModelConfig(): ModelConfig {
  if (!modelConfig) throw new Error("initialiseAgentClient() was not called.");
  return modelConfig;
}
```

---

## 10. Step 5 — The planning agent

Create `web/src/orchestrator/plan.ts`:

```ts
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { getModelConfig } from "./client";
import type { InterviewPlan } from "./types";

const PlanSchema = z.object({
  areas: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      weight: z.number(),
      targetEvidence: z.string()
    })
  )
});

const PLAN_INSTRUCTIONS = `You convert an interview rubric into a coverage plan.

Rules:
- Derive areas ONLY from the supplied rubric. Never invent a scored dimension.
- Use a short lowercase snake_case id for each area, for example problem_understanding.
- Order areas by when they naturally arise. Understanding first. Complexity and trade-offs last.
- Produce at most one area per minute of interview time. A five minute interview gets four or five areas maximum.
- targetEvidence states what the interviewer must observe to consider the area covered. Make it concrete and observable.
- weight is the percentage from the rubric. If the rubric gives no weights, distribute evenly so the total is 100.`;

export async function buildInterviewPlan(input: {
  role: string;
  rubric: string;
  question: string;
  durationSeconds: number;
}): Promise<InterviewPlan> {
  const agent = new Agent({
    name: "Interview Planner",
    instructions: PLAN_INSTRUCTIONS,
    model: getModelConfig().orchestratorModel,
    outputType: PlanSchema
  });

  const result = await run(
    agent,
    `Role: ${input.role}
Interview length: ${Math.round(input.durationSeconds / 60)} minutes

Rubric:
${input.rubric}

Coding problem:
${input.question}`
  );

  const output = result.finalOutput;
  if (!output) throw new Error("Planner returned no plan.");

  return {
    areas: output.areas.map((area) => ({ ...area, evidenceCount: 0 }))
  };
}
```

---

## 11. Step 6 — The observers

Create `web/src/orchestrator/observers.ts`:

```ts
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { getModelConfig } from "./client";
import type { RunResult } from "../runner/types";
import type { InterviewPlan, Observation, Signal } from "./types";

const ObservationSchema = z.object({
  isNoteworthy: z.boolean(),
  areaId: z.string(),
  finding: z.string(),
  confidence: z.number()
});

function coverageSummary(plan: InterviewPlan | null): string {
  if (!plan) return "No plan available. Use your judgement.";
  return plan.areas
    .map((area) => `- ${area.id} (${area.label}, weight ${area.weight}%): ${area.evidenceCount} observations so far. Target: ${area.targetEvidence}`)
    .join("\n");
}

const CODE_OBSERVER_INSTRUCTIONS = `You watch a candidate's code during a technical interview.

You are given the previous version and the current version. Report ONE observation about what changed and what it reveals.

Rules:
- Set isNoteworthy to false when the change is cosmetic, trivial, or reveals nothing about the candidate's ability. Most changes are not noteworthy. Saying nothing is the correct answer most of the time.
- areaId must be one of the rubric area ids listed in the input.
- finding must describe something concrete and observable in the code. Never speculate about the candidate's personality, confidence, or intent.
- confidence is between 0 and 1.`;

export async function observeCode(input: {
  previousCode: string;
  currentCode: string;
  question: string;
  plan: InterviewPlan | null;
}): Promise<Observation | null> {
  const agent = new Agent({
    name: "Code Observer",
    instructions: CODE_OBSERVER_INSTRUCTIONS,
    model: getModelConfig().observerModel,
    outputType: ObservationSchema
  });

  const result = await run(
    agent,
    `Problem:
${input.question}

Rubric areas and current coverage:
${coverageSummary(input.plan)}

Previous code:
${input.previousCode || "(empty)"}

Current code:
${input.currentCode}`
  );

  const output = result.finalOutput;
  if (!output || !output.isNoteworthy) return null;
  return {
    observer: "code",
    areaId: output.areaId,
    finding: output.finding,
    confidence: output.confidence,
    at: Date.now()
  };
}

const WHITEBOARD_OBSERVER_INSTRUCTIONS = `You watch a candidate's whiteboard during a technical interview.

The whiteboard is described as JSON. Each shape has a type, optional text, bounds, and bindings to other shapes. Bindings are arrows or connections. Use text and bindings to understand the structure the candidate is drawing.

Report ONE observation about what the diagram reveals about their plan.

Rules:
- Set isNoteworthy to false when the diagram is empty, trivial, or unchanged in meaning. Saying nothing is the correct answer most of the time.
- Treat the diagram as evidence of REASONING, never as proof that the code works.
- Never infer meaning from appearance alone. If labels or connections are ambiguous, say so in the finding and lower the confidence.
- areaId must be one of the rubric area ids listed in the input.`;

export async function observeWhiteboard(input: {
  previousSummary: string;
  currentSummary: string;
  question: string;
  plan: InterviewPlan | null;
}): Promise<Observation | null> {
  const agent = new Agent({
    name: "Whiteboard Observer",
    instructions: WHITEBOARD_OBSERVER_INSTRUCTIONS,
    model: getModelConfig().observerModel,
    outputType: ObservationSchema
  });

  const result = await run(
    agent,
    `Problem:
${input.question}

Rubric areas and current coverage:
${coverageSummary(input.plan)}

Previous whiteboard:
${input.previousSummary}

Current whiteboard:
${input.currentSummary}`
  );

  const output = result.finalOutput;
  if (!output || !output.isNoteworthy) return null;
  return {
    observer: "whiteboard",
    areaId: output.areaId,
    finding: output.finding,
    confidence: output.confidence,
    at: Date.now()
  };
}

/**
 * Turns a code run into an observation. This is a FACT, not a judgement.
 * It makes no model call. Do not add one.
 */
export function observeTestRun(lastRun: RunResult | null): Observation | null {
  if (!lastRun) return null;

  let finding: string;
  if (lastRun.status === "compile_error") {
    finding = `Code did not compile at revision ${lastRun.codeRevision}: ${lastRun.message ?? "unknown error"}`;
  } else if (lastRun.status === "timeout") {
    finding = `Code timed out at revision ${lastRun.codeRevision}.`;
  } else if (lastRun.status === "fatal_error") {
    finding = `Code failed to run at revision ${lastRun.codeRevision}: ${lastRun.message ?? "unknown error"}`;
  } else {
    const failures = lastRun.tests
      .filter((test) => !test.passed)
      .map((test) => `test ${test.index} (input ${JSON.stringify(test.args)}) returned ${JSON.stringify(test.got)}`)
      .join("; ");
    finding = `Ran tests at revision ${lastRun.codeRevision}: ${lastRun.passedCount} of ${lastRun.totalCount} passed.`;
    if (failures) finding += ` Failures: ${failures}.`;
  }

  return { observer: "tests", areaId: "correctness", finding, confidence: 1, at: Date.now() };
}
```

---

## 12. Step 7 — The orchestrator

Create `web/src/orchestrator/orchestrator.ts`:

```ts
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { getModelConfig } from "./client";
import type { InterviewPlan, Observation, QueuedQuestion, Signal } from "./types";

const DecisionSchema = z.object({
  shouldAsk: z.boolean(),
  areaId: z.string(),
  question: z.string(),
  basis: z.string(),
  reasoning: z.string()
});

const ORCHESTRATOR_INSTRUCTIONS = `You decide the next question in a technical coding interview. You do not speak. You write the question a voice interviewer will read out verbatim.

How to choose:
- Prefer the rubric area with the LEAST evidence and the HIGHEST weight.
- In the final quarter of the interview, prefer complexity and trade-off areas.
- The question must reference something concrete: the candidate's code, a test result, or something on their whiteboard. Put that anchor in the basis field.

Hard rules for the question text:
- Under 12 words.
- One question. No preamble, no explanation of why you are asking.
- Never reveal an algorithm name, a data structure recommendation, pseudocode, or any part of the solution.
- Never state or imply the expected output of a test.
- Never praise, reassure, or tell the candidate whether they are correct.
- Never repeat a question already asked. The asked list is in the input.

Set shouldAsk to false when there is nothing worth asking right now. Silence is a valid and expected output. Choose it whenever the candidate is mid-thought, the observations are thin, or every area already has solid evidence. When shouldAsk is false, put empty strings in areaId, question, and basis.`;

export async function decideNextQuestion(input: {
  plan: InterviewPlan | null;
  observations: Observation[];
  askedQuestions: string[];
  signal: Signal;
  rubric: string;
}): Promise<QueuedQuestion | null> {
  const agent = new Agent({
    name: "Interview Orchestrator",
    instructions: ORCHESTRATOR_INSTRUCTIONS,
    model: getModelConfig().orchestratorModel,
    outputType: DecisionSchema
  });

  const coverage = input.plan
    ? input.plan.areas
        .map((area) => `- ${area.id} (${area.label}, weight ${area.weight}%): ${area.evidenceCount} observations. Target: ${area.targetEvidence}`)
        .join("\n")
    : `No plan available. Use this rubric directly:\n${input.rubric}`;

  const recent = input.observations
    .slice(-12)
    .map((observation) => `- [${observation.observer} → ${observation.areaId}] ${observation.finding}`)
    .join("\n");

  const result = await run(
    agent,
    `Rubric areas and coverage:
${coverage}

Recent observations:
${recent || "(none yet)"}

Questions already asked:
${input.askedQuestions.map((question) => `- ${question}`).join("\n") || "(none yet)"}

Timing: ${input.signal.elapsedSeconds}s elapsed, ${input.signal.remainingSeconds}s remaining.
Triggering signal: ${input.signal.kind}`
  );

  const output = result.finalOutput;
  if (!output || !output.shouldAsk || !output.question.trim()) return null;
  return { question: output.question.trim(), areaId: output.areaId, basis: output.basis };
}
```

---

## 13. Step 8 — The signal bus

Create `web/src/orchestrator/signalBus.ts`:

```ts
import type { RunResult } from "../runner/types";
import type { ActivityRow, InterviewPlan, Observation, QueuedQuestion, Signal } from "./types";
import { observeCode, observeTestRun, observeWhiteboard } from "./observers";
import { decideNextQuestion } from "./orchestrator";

export const MIN_SECONDS_BETWEEN_QUESTIONS = 45;
const TYPING_QUIET_MS = 3000;
const WHITEBOARD_QUIET_MS = 2000;
const SILENCE_TRIGGER_MS = 20000;
const TICK_MS = 2000;
const ENDGAME_SECONDS = 20;

export type SignalBusDeps = {
  getCode: () => string;
  getCodeRevision: () => number;
  getCodeChangedAt: () => number;
  getWhiteboardSummary: () => string;
  getWhiteboardRevision: () => number;
  getWhiteboardChangedAt: () => number;
  getLastRun: () => RunResult | null;
  getRemainingSeconds: () => number;
  getElapsedSeconds: () => number;
  getAgentStatus: () => string;
  getQuestion: () => string;
  getRubric: () => string;
  getPlan: () => InterviewPlan | null;
  onObservation: (observation: Observation) => void;
  onQuestionQueued: (question: QueuedQuestion) => void;
  onActivity: (row: ActivityRow) => void;
  getAskedQuestions: () => string[];
  getObservations: () => Observation[];
};

export function startSignalBus(deps: SignalBusDeps) {
  let lastQuestionAt = Date.now();
  let lastCodeRevision = deps.getCodeRevision();
  let lastWhiteboardRevision = deps.getWhiteboardRevision();
  let lastRunAt = deps.getLastRun()?.ranAt ?? 0;
  let lastActivityAt = Date.now();
  let previousCode = deps.getCode();
  let previousWhiteboard = deps.getWhiteboardSummary();
  let busy = false;

  const timer = window.setInterval(() => {
    void tick();
  }, TICK_MS);

  async function tick() {
    if (busy) return;

    const now = Date.now();
    const codeRevision = deps.getCodeRevision();
    const whiteboardRevision = deps.getWhiteboardRevision();
    const lastRun = deps.getLastRun();

    // Work out which signal, if any, fired.
    let kind: Signal["kind"] | null = null;

    if (lastRun && lastRun.ranAt > lastRunAt) {
      kind = "tests_run";
    } else if (codeRevision !== lastCodeRevision && now - deps.getCodeChangedAt() >= TYPING_QUIET_MS) {
      kind = "code_changed";
    } else if (whiteboardRevision !== lastWhiteboardRevision && now - deps.getWhiteboardChangedAt() >= WHITEBOARD_QUIET_MS) {
      kind = "whiteboard_changed";
    } else if (now - lastActivityAt >= SILENCE_TRIGGER_MS) {
      kind = "silence";
    }

    if (!kind) return;

    // ---- GATES. All must pass. No model call happens before this point. ----
    if (deps.getAgentStatus() !== "listening") return;
    if (deps.getRemainingSeconds() <= ENDGAME_SECONDS) return;
    if ((now - lastQuestionAt) / 1000 < MIN_SECONDS_BETWEEN_QUESTIONS) return;
    // -----------------------------------------------------------------------

    busy = true;
    lastActivityAt = now;

    const signal: Signal = {
      kind,
      codeRevision,
      whiteboardRevision,
      elapsedSeconds: deps.getElapsedSeconds(),
      remainingSeconds: deps.getRemainingSeconds()
    };

    deps.onActivity({ type: "signal", text: `${kind} · code r${codeRevision} · board r${whiteboardRevision}`, at: now });

    try {
      const jobs: Promise<Observation | null>[] = [];

      if (kind === "tests_run") {
        lastRunAt = lastRun?.ranAt ?? lastRunAt;
        jobs.push(Promise.resolve(observeTestRun(lastRun)));
      }
      if (kind === "code_changed" || kind === "silence") {
        const currentCode = deps.getCode();
        jobs.push(
          observeCode({
            previousCode,
            currentCode,
            question: deps.getQuestion(),
            plan: deps.getPlan()
          })
        );
        previousCode = currentCode;
        lastCodeRevision = codeRevision;
      }
      if (kind === "whiteboard_changed" || kind === "silence") {
        const currentWhiteboard = deps.getWhiteboardSummary();
        jobs.push(
          observeWhiteboard({
            previousSummary: previousWhiteboard,
            currentSummary: currentWhiteboard,
            question: deps.getQuestion(),
            plan: deps.getPlan()
          })
        );
        previousWhiteboard = currentWhiteboard;
        lastWhiteboardRevision = whiteboardRevision;
      }

      const settled = await Promise.allSettled(jobs);
      for (const entry of settled) {
        if (entry.status === "fulfilled" && entry.value) {
          deps.onObservation(entry.value);
          deps.onActivity({
            type: "observer",
            text: `${entry.value.observer} → ${entry.value.areaId}`,
            at: Date.now()
          });
        }
      }

      const decision = await decideNextQuestion({
        plan: deps.getPlan(),
        observations: deps.getObservations(),
        askedQuestions: deps.getAskedQuestions(),
        signal,
        rubric: deps.getRubric()
      });

      if (decision) {
        lastQuestionAt = Date.now();
        deps.onQuestionQueued(decision);
        deps.onActivity({ type: "orchestrator", text: `queued: ${decision.areaId}`, at: Date.now() });
      } else {
        deps.onActivity({ type: "orchestrator", text: "stayed silent", at: Date.now() });
      }
    } catch (error) {
      deps.onActivity({
        type: "orchestrator",
        text: `error: ${error instanceof Error ? error.message : "unknown"}`,
        at: Date.now()
      });
    } finally {
      busy = false;
    }
  }

  return () => window.clearInterval(timer);
}
```

**Note on `lastRun.ranAt`:** Plan 01 defines `ranAt: number` on `RunResult`. If that field is missing, add it — set it to `Date.now()` when a run completes.

**Note on `getCodeChangedAt`:** this does not exist yet. In `App.tsx`, add a ref that stamps `Date.now()` inside the Monaco `onChange` handler, next to where `setRevision` is called.

---

## 14. Step 9 — Wire it into the voice agent

Open `web/src/useInterviewAgent.ts`.

### 14.1 Extend the config type

In `InterviewAgentConfig` (lines 8–25), add these fields after `getWhiteboardImage`:

```ts
  getCodeChangedAt: () => number;
  getPlan: () => InterviewPlan | null;
  getQuestionText: () => string;
  getRemainingSeconds: () => number;
  getElapsedSeconds: () => number;
  onActivity: (row: ActivityRow) => void;
```

Add the import at the top:

```ts
import type { ActivityRow, InterviewPlan, Observation, QueuedQuestion } from "./orchestrator/types";
import { startSignalBus } from "./orchestrator/signalBus";
```

### 14.2 Add refs

Next to the other refs inside `useInterviewAgent` (around line 50), add:

```ts
  const queuedQuestionRef = useRef<QueuedQuestion | null>(null);
  const observationsRef = useRef<Observation[]>([]);
  const askedQuestionsRef = useRef<string[]>([]);
  const stopSignalBusRef = useRef<(() => void) | null>(null);
```

### 14.3 Add the `get_next_question` tool

Add this alongside the other `tool({...})` definitions inside `connect`:

```ts
    const getNextQuestion = tool({
      name: "get_next_question",
      description: "Retrieve the question the interview planner prepared. Call this when told a question is available. If hasQuestion is false, say nothing at all and keep listening.",
      parameters: z.object({}),
      async execute() {
        const queued = queuedQuestionRef.current;
        if (!queued) return { hasQuestion: false };
        queuedQuestionRef.current = null;
        askedQuestionsRef.current = [...askedQuestionsRef.current, queued.question];
        return { hasQuestion: true, question: queued.question, areaId: queued.areaId, basis: queued.basis };
      }
    });
```

Add `getNextQuestion` to the `tools` array of **both** the Coding Interviewer and the Reflection Agent. Do **not** give it to the Introduction Agent.

### 14.4 Replace the 15-second poll

Find the block starting at line 269 (`lastScannedRevisionRef.current = config.getCodeRevision();`) and ending at line 310 (`}, 15000);`).

**Delete all of it.** Replace with:

```ts
    stopSignalBusRef.current = startSignalBus({
      getCode: config.getCode,
      getCodeRevision: config.getCodeRevision,
      getCodeChangedAt: config.getCodeChangedAt,
      getWhiteboardSummary: config.getWhiteboardSummary,
      getWhiteboardRevision: config.getWhiteboardRevision,
      getWhiteboardChangedAt: config.getWhiteboardChangedAt,
      getLastRun: config.getLastRun,
      getRemainingSeconds: config.getRemainingSeconds,
      getElapsedSeconds: config.getElapsedSeconds,
      getAgentStatus: () => statusRef.current,
      getQuestion: config.getQuestionText,
      getRubric: config.getRubric,
      getPlan: config.getPlan,
      getAskedQuestions: () => askedQuestionsRef.current,
      getObservations: () => observationsRef.current,
      onActivity: config.onActivity,
      onObservation: (observation) => {
        observationsRef.current = [...observationsRef.current, observation];
        void fetch("/api/interview/evidence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: config.sessionId,
            category: observation.areaId,
            observation: `[${observation.observer}] ${observation.finding}`,
            confidence: observation.confidence,
            codeRevision: config.getCodeRevision()
          })
        }).catch(() => undefined);
      },
      onQuestionQueued: async (queued) => {
        queuedQuestionRef.current = queued;
        // Send the whiteboard image alongside, so the voice agent sees the layout.
        try {
          const image = await config.getWhiteboardImage();
          if (image) session.addImage(image, { triggerResponse: false });
        } catch {
          /* the scene summary already reached the observer; the image is a bonus */
        }
        session.sendMessage(
          "A prepared question is available. Call get_next_question and ask it verbatim. Add no preamble and no explanation."
        );
      }
    });
```

Delete the now-unused refs `lastScannedRevisionRef`, `lastScannedWhiteboardRevisionRef`, and `workspaceReviewInFlightRef`.

### 14.5 Clean up on close

In `closeNow` and `disconnect`, add:

```ts
    stopSignalBusRef.current?.();
    stopSignalBusRef.current = null;
```

### 14.6 Rewrite the Coding Interviewer instructions

Replace the `instructions` string of the Coding Interviewer agent with:

```
You are a terse technical interviewer. You do NOT choose what to probe. A planner does that for you.

When told a prepared question is available, call get_next_question and ask the returned question VERBATIM. Do not rephrase it. Do not add a preamble. Do not explain why you asked. If hasQuestion is false, say nothing at all.

Between prepared questions, stay silent and listen. Silence is correct and expected.

You may respond directly when the candidate speaks to you:
- Clarify the literal problem statement, without revealing strategy.
- Redirect off-topic conversation with exactly: "Stay on the problem."
- If asked for a hint, an answer, or whether they are correct, say: "No hints. Explain your reasoning."

Use get_current_workspace before referring to code or a diagram. Use get_execution_results before discussing correctness. Treat the whiteboard as evidence of reasoning, never as proof the code works.

ZERO-HINT POLICY: Never provide a solution, code, pseudocode, algorithm name, recommended data structure, leading example, correction, or partial answer. Never state or imply expected test outputs. Never complete the candidate's thought. Do not praise, reassure, encourage, congratulate, apologise, or use filler. Remain professional and non-hostile.

You may hand off to the Reflection Agent when time is nearly over.
```

Apply the same "ask verbatim, otherwise stay silent" rules to the Reflection Agent, keeping its existing focus on complexity, invariants, edge cases, and trade-offs.

---

## 15. Step 10 — Output guardrails

Create `web/src/orchestrator/guardrails.ts`:

```ts
import type { RealtimeOutputGuardrail } from "@openai/agents/realtime";

const BANNED_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "algorithm suggestion", pattern: /\b(use|try|consider|maybe)\b[^.?!]{0,40}\b(hash ?map|hash ?set|dictionary|two pointers?|sliding window|binary search|memoi[sz]|dynamic programming|frequency (map|counter|array))\b/i },
  { label: "correctness verdict", pattern: /\b(that('s| is) (correct|right|wrong)|you got it|exactly right|that works|incorrect)\b/i },
  { label: "praise", pattern: /\b(great|good) (job|work|answer|approach)\b|\b(nice|excellent|perfect|well done|awesome)\b/i },
  { label: "code leak", pattern: /(for\s*\(|while\s*\(|function\s+\w+\s*\(|=>\s*\{|\.set\(|\.get\()/ }
];

export const zeroHintGuardrail: RealtimeOutputGuardrail = {
  name: "zero_hint",
  async execute({ agentOutput }) {
    for (const entry of BANNED_PATTERNS) {
      if (entry.pattern.test(agentOutput)) {
        return { tripwireTriggered: true, outputInfo: { reason: entry.label } };
      }
    }
    return { tripwireTriggered: false, outputInfo: {} };
  }
};
```

In `useInterviewAgent.ts`, add to the `RealtimeSession` constructor options:

```ts
      outputGuardrails: [zeroHintGuardrail],
```

Add a listener next to the other `session.on(...)` calls:

```ts
    session.on("guardrail_tripped", (_context, _agent, details) => {
      config.onActivity({ type: "guardrail", text: `zero_hint blocked: ${JSON.stringify(details)}`, at: Date.now() });
    });
```

Guardrails run every ~100 characters of generated text, in parallel with speech. Because generating text is faster than speaking it, this usually cuts unsafe output before the candidate hears it. **Keep the checks as local regexes. Never make a model call inside a guardrail.**

---

## 16. Step 11 — App.tsx wiring

### 16.1 Build the plan at interview start

Inside `startInterview`, after the session ID is created and before `agent.connect(...)`, add:

```ts
      void (async () => {
        try {
          await initialiseAgentClient();
          const plan = await buildInterviewPlan({
            role: role.trim(),
            rubric: rubricRef.current,
            question: questionRef.current,
            durationSeconds
          });
          planRef.current = plan;
          setPlan(plan);
        } catch (planError) {
          // The interview must still run without a plan.
          console.warn("Interview plan unavailable", planError);
        }
      })();
```

Add state and a ref: `const [plan, setPlan] = useState<InterviewPlan | null>(null);` and `const planRef = useRef<InterviewPlan | null>(null);`.

**The interview must work if this fails.** The orchestrator falls back to the raw rubric text.

### 16.2 Track code change time

In the Monaco `onChange` handler, alongside `setRevision`, add:

```ts
codeChangedAtRef.current = Date.now();
```

Declare `const codeChangedAtRef = useRef(0);`.

### 16.3 Increment coverage when observations arrive

When an observation is recorded, increment the matching area's `evidenceCount`:

```ts
  function recordCoverage(areaId: string) {
    setPlan((current) => {
      if (!current) return current;
      const next = {
        areas: current.areas.map((area) =>
          area.id === areaId ? { ...area, evidenceCount: area.evidenceCount + 1 } : area
        )
      };
      planRef.current = next;
      return next;
    });
  }
```

Call it from the `onObservation` callback.

### 16.4 Pass the new config fields

Add to the `agent.connect({...})` call:

```ts
        getCodeChangedAt: () => codeChangedAtRef.current,
        getPlan: () => planRef.current,
        getQuestionText: () => questionRef.current,
        getRemainingSeconds: () => remainingRef.current,
        getElapsedSeconds: () => durationSeconds - remainingRef.current,
        onActivity: (row) => setActivity((rows) => [...rows.slice(-11), row]),
```

Add `const remainingRef = useRef(0);` and keep it in sync with the `remaining` state, the same way `codeRef` mirrors `code`. Add `const questionRef = useRef("");` mirroring `question`.

---

## 17. Step 12 — Activity panel

Replace the existing `AGENT TOOL CALLS` sidebar panel with an `AGENT ACTIVITY` panel driven by `ActivityRow[]`.

Add state: `const [activity, setActivity] = useState<ActivityRow[]>([]);`

Row colours:

| type | colour |
|---|---|
| `signal` | grey |
| `observer` | blue |
| `orchestrator` | purple |
| `tool` | default |
| `guardrail` | red |

Keep the last 12 rows.

Above it, add a coverage strip: one thin horizontal bar per rubric area from `plan.areas`. Fill each bar proportionally to `evidenceCount`, capping at 3 observations for a full bar. Label each with `area.label`. When `plan` is null, render nothing.

Add matching CSS to `web/src/styles.css`, following the existing panel styles.

---

## 18. Acceptance criteria

Run the app and check each one.

1. `make check` passes.
2. `grep -n "15000" web/src/useInterviewAgent.ts` returns nothing. The old poll is gone.
3. `grep -rn "sk-" web/src/` returns nothing. No API key in browser source.
4. Open DevTools → Network. All model traffic goes to `/api/openai/v1/responses`, never to `api.openai.com`.
5. Start an interview. The coverage strip appears within ~10 seconds with one bar per rubric area.
6. Type continuously for 30 seconds. **Zero** questions are asked. The 3-second typing gate holds.
7. Stop typing. Within ~5 seconds a `signal` row appears in the activity panel.
8. Over a 5-minute interview, at least one `orchestrator · stayed silent` row appears.
9. No two questions are less than 45 seconds apart.
10. Load the buggy preset and press Run. An `observer · tests → correctness` row appears with no model call in the Network tab.
11. Draw two labelled boxes with an arrow on the whiteboard. Wait 3 seconds. An `observer · whiteboard → …` row appears.
12. When a question is queued, the voice agent asks it verbatim, with no preamble.
13. Stop the Go server, start an interview, restart the server. The interview still runs without a plan.
14. Every observation appears in `runtime/evidence.jsonl` and in the final report.

---

## 19. Troubleshooting

**`outputType` gives a TypeScript error with Zod.** There is a known incompatibility between the Agents SDK and Zod 3.25.68+. This project uses Zod 4. If `tsc` complains that the schema type is not assignable, cast at the call site:

```ts
outputType: PlanSchema as never
```

Do not downgrade Zod. The realtime tools depend on the installed version.

**`setDefaultOpenAIClient` is not exported from `@openai/agents`.** Try `@openai/agents-core` instead. Both re-export it.

**The OpenAI client refuses to run in the browser.** Confirm `dangerouslyAllowBrowser: true` is set. It is safe here because the key is the literal string `"proxied-by-go-server"`, not a credential.

**Proxy returns 403.** The path is not in `allowedProxyPaths`. Check what URL the SDK called in the Network tab and add that path.

**Observers fire too often and cost too much.** Raise `MIN_SECONDS_BETWEEN_QUESTIONS` in `signalBus.ts`. Do not remove the gates.

---

## 20. Out of scope — do not build

- Webcam or video-frame analysis of any kind. Gaze, attention, emotion, and presence detection are all excluded. `HLD.md` §3 forbids them.
- Auth, login, databases, webhooks, recruiter dashboards.
- Extracting a reusable SDK package. A separate plan covers that.
- Multi-session support. One session at a time is fine.
- The dead files `web/src/useLocalVoice.ts` and `web/src/useRealtimeVoice.ts`, and the `/api/local-voice/chat` and `/api/realtime/session` handlers in `main.go`.
