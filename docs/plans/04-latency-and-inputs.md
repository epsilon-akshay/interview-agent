# Plan 04 — Cut interview latency and capture every input

> **How to use this document.** Execute the steps in order. Every step gives the exact file, the exact code, and what to delete. Do not redesign anything. When you finish, run the checks in Section 13.

---

## 1. What this project is

**Signal Interview** is a browser-based automated coding interview app.

A candidate joins. An OpenAI Realtime voice agent runs a timed interview. The candidate writes TypeScript in a Monaco editor and can draw on a tldraw whiteboard. Code runs in a Web Worker against hidden tests. A planning layer watches all of it and decides what the voice agent should ask next. A backend call scores the interview afterwards.

**Stack:** Go backend (standard library), React 18 + TypeScript + Vite, `@openai/agents` v0.15 for both the voice agent and the planning agents.

```bash
make install
make run                                  # http://localhost:8080
make check                                # npm run typecheck + go test ./...

# dev, two terminals
go run ./cmd/server -dev-dir web
cd web && npm run dev                     # :5173, proxies /api to :8080
```

---

## 2. The problem you are fixing

Two problems, measured against the current code.

**Problem A — a proactive question takes 6 to 14 seconds to arrive.**

| Step | Cost |
|---|---|
| Typing-quiet window (`TYPING_QUIET_MS`) | 3.0s fixed |
| Tick alignment (`TICK_MS`) | 0–2.0s fixed |
| Observer model call | 1–3s |
| Orchestrator model call | 1–3s |
| Whiteboard PNG export (blocks) | 0.1–0.5s |
| `sendMessage` → model decides to call a tool | 0.5–1.5s |
| Tool returns → model speaks | 0.5–1.5s |

Four causes:
1. The observer call and the orchestrator call run strictly in series.
2. A whole realtime model turn is spent fetching a question string the browser already holds.
3. Nothing is ever precomputed. The chain starts cold on every signal.
4. The whiteboard PNG export sits on the critical path.

**Problem B — the candidate's speech is never captured.**

`web/src/useInterviewAgent.ts` configures the session with turn detection but no transcription:

```ts
audio: { input: { turnDetection: { type: "semantic_vad" } } }
```

So no transcript exists. The observers cannot read it, the orchestrator cannot use it, and the final report never sees it. The rubric scores communication and nothing can hear.

**Target:** proactive questions in ~4–5 seconds, and every input captured.

---

## 3. Current file layout

```
cmd/server/
├── main.go              All HTTP handlers. evaluationHandler is around line 250.
├── proxy.go             /api/openai/* proxy and /api/config
└── main_test.go
web/src/
├── App.tsx              All UI, 637 lines
├── useInterviewAgent.ts Realtime session, agents, tools, 404 lines
├── RunPanel.tsx         Test results
├── WhiteboardPanel.tsx  tldraw wrapper
├── orchestrator/
│   ├── client.ts        Agents SDK bootstrap, points at the Go proxy
│   ├── types.ts         Shared types
│   ├── plan.ts          Builds the rubric coverage plan at interview start
│   ├── observers.ts     observeCode, observeWhiteboard, observeTestRun
│   ├── orchestrator.ts  decideNextQuestion
│   ├── signalBus.ts     The 2s tick, gates, and the observe→decide chain
│   └── guardrails.ts    zeroHintGuardrail regexes
├── runner/              Web Worker code execution
└── whiteboard/scene.ts  summarizeWhiteboard() → JSON text of every shape
```

### 3.1 Verified SDK facts

These were read from `web/node_modules/@openai/agents-realtime/dist/`. They are correct for the installed version. Do not substitute other names.

**Transcription config** (`clientMessages.d.ts:71`) — `RealtimeAudioInputConfig`:
```ts
{ format?, noiseReduction?, transcription?, turnDetection? }
```

**Transcription options** (`clientMessages.d.ts:40`):
```ts
{ delay?: 'minimal'|'low'|'medium'|'high'|'xhigh'; keywords?; language?; languages?;
  model?: 'gpt-transcribe'|'gpt-live-transcribe'|'gpt-4o-transcribe'|'gpt-4o-mini-transcribe'|...;
  prompt? }
```

**Session events** (`realtimeSessionEvents.d.ts`):
```ts
transport_event:  [event: TransportEvent]
history_updated:  [history: RealtimeItem[]]
```

**Candidate transcript event** (`transportLayerEvents.d.ts:36`):
```ts
{ type: 'conversation.item.input_audio_transcription.completed'; item_id: string; transcript: string }
```

---

## 4. Target flow

```
BEFORE                                    AFTER
──────                                    ─────
signal                                    t-10s  precompute starts quietly
  └─ observe        (model call)                   └─ analyse()   (ONE model call)
      └─ decide     (model call)                       └─ result parked
          └─ export PNG  (blocks)
              └─ sendMessage                  signal
                  └─ model calls tool           └─ parked result is fresh?
                      └─ model speaks               └─ sendMessage with the
                                                        question inline
~6–14s                                                    └─ model speaks
                                          ~4–5s
```

---

## 5. Locked decisions

| Decision | Value |
|---|---|
| Observer + orchestrator | **Merged into one `analyse()` call** |
| Test results | Stay a pure function. **Never** send them to a model |
| `get_next_question` tool | **Deleted.** The question goes inline in `sendMessage` |
| Precompute lead time | 10 seconds before the 45s gate opens |
| Stale precompute rule | Discard if code revision drifted > 8, or older than 90s |
| Candidate transcript source | The `transport_event` listener. **Not** `session.history` |
| Evaluation inputs | **Unchanged, plus the transcript.** Keep `detail: "high"` on the whiteboard image |
| Video / webcam analysis | Still not built. `HLD.md` §3 forbids it |

**Why not `session.history` for the transcript:** there are open SDK bugs where history returns empty or gets corrupted when the user speaks several times in a row. The raw transport event is reliable.

**Why the evaluation inputs do not change:** the evaluation is one call at the end. Its latency does not affect the interview. Trimming its inputs would trade report quality for a saving nobody feels.

---

## 6. Step 1 — Capture the transcript

### 6.1 Add the type

In `web/src/orchestrator/types.ts`, append:

```ts
export type TranscriptTurn = {
  role: "candidate" | "interviewer";
  text: string;
  at: number;
};
```

### 6.2 Enable transcription

In `web/src/useInterviewAgent.ts`, find the `RealtimeSession` constructor (around line 281). Replace the `audio` line inside `config`:

```ts
        audio: { input: { turnDetection: { type: "semantic_vad" } } }
```

with:

```ts
        audio: {
          input: {
            transcription: { model: "gpt-4o-mini-transcribe", delay: "low" },
            turnDetection: { type: "semantic_vad" }
          }
        }
```

### 6.3 Collect turns

Add a ref alongside the others (near line 50):

```ts
  const transcriptRef = useRef<TranscriptTurn[]>([]);
  const seenTranscriptItemsRef = useRef<Set<string>>(new Set());
```

Add these listeners next to the other `session.on(...)` calls (after line 314):

```ts
    session.on("transport_event", (event: any) => {
      if (event?.type !== "conversation.item.input_audio_transcription.completed") return;
      if (!event.transcript || seenTranscriptItemsRef.current.has(event.item_id)) return;
      seenTranscriptItemsRef.current.add(event.item_id);
      transcriptRef.current = [
        ...transcriptRef.current,
        { role: "candidate", text: String(event.transcript).trim(), at: Date.now() }
      ];
    });

    session.on("history_updated", (history: any[]) => {
      for (const item of history) {
        if (item?.type !== "message" || item?.role !== "assistant") continue;
        const itemId = String(item.itemId ?? item.id ?? "");
        if (!itemId || seenTranscriptItemsRef.current.has(itemId)) continue;
        const text = (item.content ?? [])
          .map((part: any) => part?.transcript ?? part?.text ?? "")
          .join(" ")
          .trim();
        if (!text) continue;
        seenTranscriptItemsRef.current.add(itemId);
        transcriptRef.current = [...transcriptRef.current, { role: "interviewer", text, at: Date.now() }];
      }
    });
```

Reset both refs where `observationsRef.current = []` is reset (around line 318):

```ts
    transcriptRef.current = [];
    seenTranscriptItemsRef.current = new Set();
```

### 6.4 Expose it

Add to `InterviewAgentConfig`:

```ts
  onTranscriptTurn?: (turn: TranscriptTurn) => void;
```

Add to the hook's return object at the bottom of the file:

```ts
    getTranscript: () => transcriptRef.current,
```

---

## 7. Step 2 — Merge observer and orchestrator into one call

Create `web/src/orchestrator/analyse.ts`:

```ts
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { getModelConfig } from "./client";
import type { RunResult } from "../runner/types";
import type { InterviewPlan, Observation, QueuedQuestion, Signal, TranscriptTurn } from "./types";

const AnalysisSchema = z.object({
  observations: z.array(
    z.object({
      source: z.enum(["code", "whiteboard", "speech"]),
      areaId: z.string(),
      finding: z.string(),
      confidence: z.number()
    })
  ),
  shouldAsk: z.boolean(),
  areaId: z.string(),
  question: z.string(),
  basis: z.string()
});

const ANALYSE_INSTRUCTIONS = `You watch a candidate during a technical coding interview, and you decide what the voice interviewer asks next. You never speak yourself.

You do TWO things in one response.

FIRST — observations. Record what changed and what it reveals.
- Return an empty array when nothing is noteworthy. Most of the time nothing is. That is the correct answer.
- Return at most three observations.
- source must be code, whiteboard, or speech.
- areaId must be one of the rubric area ids given in the input.
- finding must describe something concrete and observable. Never speculate about personality, confidence, or intent.
- Treat a diagram as evidence of REASONING, never as proof the code works.
- If a diagram's labels or connections are ambiguous, say so and lower the confidence.

SECOND — the next question.
- Prefer the rubric area with the LEAST evidence and the HIGHEST weight.
- In the final quarter of the interview, prefer complexity and trade-offs.
- The question must anchor to something concrete: their code, a test result, their diagram, or something they said. Put that anchor in basis.

Hard rules for the question text:
- Under 12 words. One question. No preamble.
- Never reveal an algorithm name, a data structure recommendation, pseudocode, or any part of the solution.
- Never state or imply the expected output of a test.
- Never praise, reassure, or say whether they are correct.
- Never repeat a question already asked. The asked list is in the input.

Set shouldAsk to false when there is nothing worth asking. Silence is valid and expected. Choose it when the candidate is mid-thought, when observations are thin, or when every area already has solid evidence. When shouldAsk is false, put empty strings in areaId, question, and basis.`;

export type AnalysisResult = {
  observations: Observation[];
  question: QueuedQuestion | null;
};

export async function analyse(input: {
  previousCode: string;
  currentCode: string;
  previousWhiteboard: string;
  currentWhiteboard: string;
  transcriptTail: TranscriptTurn[];
  testFact: string | null;
  question: string;
  plan: InterviewPlan | null;
  rubric: string;
  observations: Observation[];
  askedQuestions: string[];
  signal: Signal;
}): Promise<AnalysisResult> {
  const agent = new Agent<any, any>({
    name: "Interview Analyst",
    instructions: ANALYSE_INSTRUCTIONS,
    model: getModelConfig().observerModel,
    outputType: AnalysisSchema as never
  });

  const coverage = input.plan
    ? input.plan.areas
        .map((area) => `- ${area.id} (${area.label}, weight ${area.weight}%): ${area.evidenceCount} observations. Target: ${area.targetEvidence}`)
        .join("\n")
    : `No plan available. Use this rubric directly:\n${input.rubric}`;

  const transcript = input.transcriptTail
    .map((turn) => `${turn.role === "candidate" ? "Candidate" : "Interviewer"}: ${turn.text}`)
    .join("\n");

  const priorFindings = input.observations
    .slice(-10)
    .map((observation) => `- [${observation.observer} → ${observation.areaId}] ${observation.finding}`)
    .join("\n");

  const result = await run(
    agent,
    `Problem:
${input.question}

Rubric areas and coverage:
${coverage}

Recent conversation:
${transcript || "(nothing spoken yet)"}

Previous code:
${input.previousCode || "(empty)"}

Current code:
${input.currentCode || "(empty)"}

Previous whiteboard:
${input.previousWhiteboard}

Current whiteboard:
${input.currentWhiteboard}

Latest test run:
${input.testFact ?? "(the candidate has not run their code)"}

Earlier findings:
${priorFindings || "(none yet)"}

Questions already asked:
${input.askedQuestions.map((question) => `- ${question}`).join("\n") || "(none yet)"}

Timing: ${input.signal.elapsedSeconds}s elapsed, ${input.signal.remainingSeconds}s remaining.
Triggering signal: ${input.signal.kind}`
  );

  const output = result.finalOutput as z.infer<typeof AnalysisSchema> | undefined;
  if (!output) return { observations: [], question: null };

  const observations: Observation[] = output.observations.map((entry) => ({
    observer: entry.source,
    areaId: entry.areaId,
    finding: entry.finding,
    confidence: entry.confidence,
    at: Date.now()
  }));

  const question =
    output.shouldAsk && output.question.trim()
      ? { question: output.question.trim(), areaId: output.areaId, basis: output.basis }
      : null;

  return { observations, question };
}
```

**Delete** `web/src/orchestrator/orchestrator.ts`.

In `web/src/orchestrator/observers.ts`, **delete** `observeCode` and `observeWhiteboard`. **Keep** `observeTestRun` exactly as it is — it makes no model call and must stay that way.

---

## 8. Step 3 — Rewrite the signal bus with precompute

Replace the entire contents of `web/src/orchestrator/signalBus.ts`:

```ts
import type { RunResult } from "../runner/types";
import type { ActivityRow, InterviewPlan, Observation, QueuedQuestion, Signal, TranscriptTurn } from "./types";
import { observeTestRun } from "./observers";
import { analyse } from "./analyse";

export const MIN_SECONDS_BETWEEN_QUESTIONS = 45;
const PRECOMPUTE_LEAD_SECONDS = 10;
const TYPING_QUIET_MS = 3000;
const WHITEBOARD_QUIET_MS = 2000;
const SILENCE_TRIGGER_MS = 20000;
const TICK_MS = 1000;
const ENDGAME_SECONDS = 20;
const STALE_REVISION_DRIFT = 8;
const STALE_AGE_MS = 90000;
const TRANSCRIPT_TAIL_TURNS = 8;

type Precomputed = {
  question: QueuedQuestion;
  atCodeRevision: number;
  at: number;
};

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
  getTranscript: () => TranscriptTurn[];
  getAskedQuestions: () => string[];
  getObservations: () => Observation[];
  onObservation: (observation: Observation) => void;
  onQuestionQueued: (question: QueuedQuestion) => void;
  onActivity: (row: ActivityRow) => void;
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
  let precomputed: Precomputed | null = null;
  let pendingSignal: Signal["kind"] | null = null;

  const timer = window.setInterval(() => {
    void tick();
  }, TICK_MS);

  /** Runs the single merged model call and records any observations it produced. */
  async function runAnalysis(signal: Signal): Promise<QueuedQuestion | null> {
    const currentCode = deps.getCode();
    const currentWhiteboard = deps.getWhiteboardSummary();
    const testFact = observeTestRun(deps.getLastRun());

    const result = await analyse({
      previousCode,
      currentCode,
      previousWhiteboard,
      currentWhiteboard,
      transcriptTail: deps.getTranscript().slice(-TRANSCRIPT_TAIL_TURNS),
      testFact: testFact?.finding ?? null,
      question: deps.getQuestion(),
      plan: deps.getPlan(),
      rubric: deps.getRubric(),
      observations: deps.getObservations(),
      askedQuestions: deps.getAskedQuestions(),
      signal
    });

    previousCode = currentCode;
    previousWhiteboard = currentWhiteboard;

    for (const observation of result.observations) {
      deps.onObservation(observation);
      deps.onActivity({ type: "observer", text: `${observation.observer} → ${observation.areaId}`, at: Date.now() });
    }
    return result.question;
  }

  /**
   * Records a test run as evidence immediately. This is a machine fact, so it
   * must never wait on a model call or on the question gates.
   */
  function recordTestFact(run: RunResult) {
    const fact = observeTestRun(run);
    if (!fact) return;
    deps.onObservation(fact);
    deps.onActivity({ type: "observer", text: `tests → ${fact.areaId}`, at: Date.now() });
  }

  async function tick() {
    const now = Date.now();
    const codeRevision = deps.getCodeRevision();
    const whiteboardRevision = deps.getWhiteboardRevision();
    const lastRun = deps.getLastRun();
    const sinceQuestion = (now - lastQuestionAt) / 1000;

    // A finished test run is a fact. Record it right away, outside every gate.
    if (lastRun && lastRun.ranAt > lastRunAt) {
      lastRunAt = lastRun.ranAt;
      recordTestFact(lastRun);
      pendingSignal = "tests_run";
    }

    if (busy) return;

    // ---- Work out which signal fired, and remember it if gates block. ----
    if (!pendingSignal) {
      if (codeRevision !== lastCodeRevision && now - deps.getCodeChangedAt() >= TYPING_QUIET_MS) {
        pendingSignal = "code_changed";
        lastCodeRevision = codeRevision;
      } else if (whiteboardRevision !== lastWhiteboardRevision && now - deps.getWhiteboardChangedAt() >= WHITEBOARD_QUIET_MS) {
        pendingSignal = "whiteboard_changed";
        lastWhiteboardRevision = whiteboardRevision;
      } else if (now - lastActivityAt >= SILENCE_TRIGGER_MS) {
        pendingSignal = "silence";
      }
    }

    const buildSignal = (kind: Signal["kind"]): Signal => ({
      kind,
      codeRevision,
      whiteboardRevision,
      elapsedSeconds: deps.getElapsedSeconds(),
      remainingSeconds: deps.getRemainingSeconds()
    });

    // ---- Precompute: think ahead while the gate is still closed. ----
    const gateOpensIn = MIN_SECONDS_BETWEEN_QUESTIONS - sinceQuestion;
    if (
      !precomputed &&
      gateOpensIn <= PRECOMPUTE_LEAD_SECONDS &&
      gateOpensIn > 0 &&
      deps.getRemainingSeconds() > ENDGAME_SECONDS
    ) {
      busy = true;
      deps.onActivity({ type: "orchestrator", text: "thinking ahead", at: now });
      try {
        const question = await runAnalysis(buildSignal(pendingSignal ?? "silence"));
        if (question) {
          precomputed = { question, atCodeRevision: deps.getCodeRevision(), at: Date.now() };
          deps.onActivity({ type: "orchestrator", text: `ready: ${question.areaId}`, at: Date.now() });
        }
      } catch (error) {
        deps.onActivity({ type: "orchestrator", text: `precompute failed: ${message(error)}`, at: Date.now() });
      } finally {
        busy = false;
      }
      return;
    }

    if (!pendingSignal) return;

    // ---- Gates. No question leaves before all of these pass. ----
    if (deps.getAgentStatus() !== "listening") return;      // deferred, not dropped
    if (deps.getRemainingSeconds() <= ENDGAME_SECONDS) return;
    if (sinceQuestion < MIN_SECONDS_BETWEEN_QUESTIONS) return;

    const kind = pendingSignal;
    pendingSignal = null;
    busy = true;
    lastActivityAt = now;
    deps.onActivity({ type: "signal", text: `${kind} · code r${codeRevision} · board r${whiteboardRevision}`, at: now });

    try {
      let question: QueuedQuestion | null = null;

      const fresh =
        precomputed &&
        Math.abs(codeRevision - precomputed.atCodeRevision) <= STALE_REVISION_DRIFT &&
        now - precomputed.at <= STALE_AGE_MS;

      if (fresh && precomputed) {
        question = precomputed.question;
        deps.onActivity({ type: "orchestrator", text: "used precomputed question", at: now });
      } else {
        if (precomputed) deps.onActivity({ type: "orchestrator", text: "precompute stale, recomputing", at: now });
        question = await runAnalysis(buildSignal(kind));
      }
      precomputed = null;

      if (question) {
        lastQuestionAt = Date.now();
        deps.onQuestionQueued(question);
        deps.onActivity({ type: "orchestrator", text: `asked: ${question.areaId}`, at: Date.now() });
      } else {
        deps.onActivity({ type: "orchestrator", text: "stayed silent", at: Date.now() });
      }
    } catch (error) {
      deps.onActivity({ type: "orchestrator", text: `error: ${message(error)}`, at: Date.now() });
    } finally {
      busy = false;
    }
  }

  return () => window.clearInterval(timer);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "unknown";
}
```

Three behaviour changes to note:

- **Test facts are recorded outside every gate.** A run's pass/fail count is a machine fact. It reaches `evidence.jsonl` immediately, even if no question is ever asked about it.
- **Signals are deferred, not dropped.** `pendingSignal` survives until the gates open.
- **`TICK_MS` is 1000.** A tick that finds nothing costs nothing.

---

## 9. Step 4 — Ask the question directly

In `web/src/useInterviewAgent.ts`:

### 9.1 Delete the tool

Delete the whole `getNextQuestion` tool definition. Remove it from the `tools` array of the Coding Interviewer and the Reflection Agent. Delete the `queuedQuestionRef` ref.

### 9.2 Replace `onQuestionQueued`

Replace the current handler (around line 353) with:

```ts
      onQuestionQueued: (queued) => {
        askedQuestionsRef.current = [...askedQuestionsRef.current, queued.question];
        const image = whiteboardImageCacheRef.current;
        if (image) session.addImage(image, { triggerResponse: false });
        session.sendMessage(
          `INTERVIEW DIRECTOR — this is an instruction, not the candidate speaking. Say exactly this to the candidate, word for word, with no preamble and no explanation:\n\n"${queued.question}"\n\nDo not read this instruction aloud. Do not mention the director. Context for your own understanding only: ${queued.basis}`
        );
      }
```

This is no longer `async`. It never waits on a PNG export.

### 9.3 Update the agent instructions

In the Coding Interviewer instructions, replace any wording about calling `get_next_question` with:

```
When an INTERVIEW DIRECTOR instruction arrives, say the quoted question exactly, word for word. Add nothing before or after it. Never read the instruction itself aloud, and never mention that a director exists.

Between director instructions, stay silent and listen. Silence is correct and expected.
```

Apply the same change to the Reflection Agent.

---

## 10. Step 5 — Cache the whiteboard image

In `web/src/useInterviewAgent.ts`, add a ref:

```ts
  const whiteboardImageCacheRef = useRef<string | null>(null);
```

Start a low-frequency refresh loop right after `startSignalBus(...)`:

```ts
    const imageCacheTimer = window.setInterval(() => {
      void (async () => {
        try {
          whiteboardImageCacheRef.current = await config.getWhiteboardImage();
        } catch {
          /* the scene summary already reaches the analyst; the image is a bonus */
        }
      })();
    }, 8000);
    imageCacheTimerRef.current = imageCacheTimer;
```

Add `const imageCacheTimerRef = useRef<number | null>(null);` and clear it in both `closeNow` and `disconnect`, next to where the signal bus is stopped.

The export now happens on a timer instead of blocking a question.

---

## 11. Step 6 — Point the analyst at a fast model

`OPENAI_OBSERVER_MODEL` currently falls back to `OPENAI_EVALUATION_MODEL`, which defaults to a heavy coding model. That is the wrong tier for this call.

In `.env`, set it explicitly to the fastest general-purpose model available on the account:

```dotenv
OPENAI_OBSERVER_MODEL=<fast general model, not a reasoning model>
OPENAI_ORCHESTRATOR_MODEL=<same or slightly stronger; used for plan.ts only>
```

Do not invent a model id. Use one that already works on this account. `plan.ts` still uses `orchestratorModel` and runs once at interview start, so it can afford a stronger model.

---

## 12. Step 7 — Transcript into the final report

### 12.1 Frontend

In `App.tsx`, `evaluateInterview()` posts to `/api/interview/evaluate`. Add to the JSON body:

```ts
          transcript: agent.getTranscript().map((turn) => ({ role: turn.role, text: turn.text }))
```

### 12.2 Take the whiteboard export off the end-of-interview path

`captureWhiteboardArtifacts()` currently runs when the interview ends, delaying the evaluation request.

Call it early instead. In the countdown effect in `App.tsx`, add:

```ts
    if (remaining === 15) void captureWhiteboardArtifacts();
```

`captureWhiteboardArtifacts` already caches into `finalWhiteboardRef`, so the end-of-interview call returns instantly. Keep that call — it is the fallback when an interview ends manually before the 15s mark.

### 12.3 Backend

In `cmd/server/main.go`, add to `evaluationRequest`:

```go
	Transcript []struct {
		Role string `json:"role"`
		Text string `json:"text"`
	} `json:"transcript"`
```

In `evaluationHandler`, build a transcript block and insert it into the prompt before the evidence section:

```go
	var transcript strings.Builder
	for _, turn := range input.Transcript {
		speaker := "Candidate"
		if turn.Role == "interviewer" {
			speaker = "Interviewer"
		}
		if text := strings.TrimSpace(turn.Text); text != "" {
			transcript.WriteString(speaker + ": " + text + "\n")
		}
	}
	transcriptSection := strings.TrimSpace(transcript.String())
	if transcriptSection == "" {
		transcriptSection = "(no transcript was captured)"
	}
```

Add to the prompt text:

```
Interview transcript:
%s
```

Add this sentence to the prompt's instruction paragraph:

```
Use the transcript as the primary evidence for communication and problem understanding. Quote the candidate's own words when citing communication evidence. If the transcript is empty, record that as an evidence gap rather than scoring communication from code alone.
```

**Do not change anything else in this handler.** Keep `detail: "high"` on the whiteboard image. Keep the schema. Keep the timeouts.

### 12.4 Evaluation screen

While the report is loading, render one skeleton row per `plan.areas` entry with the area label and a "scoring…" state, instead of a single spinner. This is cosmetic. It does not change the request.

---

## 13. Acceptance criteria

1. `make check` passes.
2. `grep -rn "get_next_question" web/src/` returns nothing.
3. `grep -rn "decideNextQuestion\|observeCode\|observeWhiteboard" web/src/` returns nothing.
4. `web/src/orchestrator/orchestrator.ts` no longer exists.
5. Speak during an interview. `transcriptRef` fills with `role: "candidate"` turns. Check via a temporary console log.
6. Open the Network tab. A proactive question produces **one** `/api/openai/v1/responses` call, not two.
7. About 35 seconds after a question, an `orchestrator · thinking ahead` row appears, followed by `ready: <area>`.
8. The next question shows `used precomputed question` and arrives within ~5 seconds of the trigger.
9. Edit the code heavily during the precompute window. The next question shows `precompute stale, recomputing`.
10. Run the tests. An `observer · tests → correctness` row appears immediately, before any gate, with no model call.
11. Type continuously for 30 seconds. Zero questions.
12. No two questions are less than 45 seconds apart.
13. Let the agent speak while a signal fires. The signal is not lost — the question arrives once the agent finishes.
14. The agent never reads the words "INTERVIEW DIRECTOR" or the basis text aloud.
15. The final report cites the candidate's spoken words in the communication category.
16. `runtime/evidence.jsonl` contains entries with `observer` values of `code`, `whiteboard`, `speech`, and `tests`.

---

## 14. Troubleshooting

**`transport_event` never fires with a transcription event.** Transcription is not enabled. Confirm the `transcription` key sits inside `audio.input`, next to `turnDetection`, not beside `audio`.

**Transcription events fire but transcripts are empty strings.** Try a different transcription model from the list in Section 3.1. `gpt-4o-mini-transcribe` is the fastest; `gpt-4o-transcribe` is more accurate.

**`history_updated` returns an empty array.** This is a known SDK bug. Candidate speech still arrives through `transport_event`, which is the important half. Interviewer turns will be missing from the transcript; accept that rather than working around it.

**The agent reads the director instruction aloud.** Strengthen the agent instructions in Step 9.3. As a fallback, add `INTERVIEW DIRECTOR` and `Context for your own understanding` as patterns in `guardrails.ts`.

**`outputType` gives a TypeScript error.** The existing code already works around a known Zod incompatibility with `as never` and `Agent<any, any>`. Follow the same pattern in `analyse.ts`.

**Precompute never fires.** It only runs in the 10-second window before the gate opens. With a 5-minute interview and a 45-second gate you get at most a handful of chances. Lower `MIN_SECONDS_BETWEEN_QUESTIONS` to test it faster, then set it back.

**Questions still feel slow.** Three seconds of the delay is `TYPING_QUIET_MS` and is deliberate — it stops the agent interrupting mid-thought. Do not remove it. Optionally reduce it to 2000.

---

## 15. Out of scope

- Webcam or video-frame analysis. `HLD.md` §3 forbids it.
- Streaming the final evaluation response.
- Changing what the evaluator reads, beyond adding the transcript.
- Auth, databases, webhooks, recruiter dashboards.
- Extracting a reusable SDK package.
- The dead files `web/src/useLocalVoice.ts` and `web/src/useRealtimeVoice.ts`, and the `/api/local-voice/chat` and `/api/realtime/session` handlers.
