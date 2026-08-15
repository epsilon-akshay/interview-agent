# Plan 02 — Orchestrator architecture

## 1. Context

You are working on **Signal Interview**, a browser-based automated coding interview app.

A candidate joins a session. An AI voice agent (OpenAI Realtime) runs a timed coding interview. The candidate writes code in a Monaco editor. The agent listens, inspects code through tool calls, and asks questions. A backend workflow scores the interview afterwards.

**The problem today:** the voice agent decides everything by itself, in the moment. A browser timer nudges it every 5 seconds whenever the code changed. It then decides whether to speak. The result is an interviewer that talks too much, asks shallow questions, and does not track which parts of the rubric it has actually tested.

**Your job:** put a planning layer above the voice agent. Cheap deterministic triggers decide *when* to think. Specialist observers interpret *what happened*. An orchestrator tracks rubric coverage and keeps the next question queued. The voice agent becomes the mouth — it speaks what the orchestrator queued, and stays silent otherwise.

This is a hackathon demo. Optimise for a working, visibly sophisticated result. No auth, no database, no multi-tenancy.

## 2. Prerequisite

**Plan 01 (`docs/plans/01-runnable-code.md`) must be merged before you start.** This plan consumes test-run results as a trigger source and assumes `questions/default.json` exists.

## 3. Repo map

```
interview-agent/
├── cmd/server/main.go          Go backend. All HTTP handlers in one file.
├── questions/default.json      Problem, starter code, tests, demo presets
├── runtime/*.jsonl             Evidence and completion logs (gitignored)
└── web/src/
    ├── App.tsx                 Whole UI
    ├── useInterviewAgent.ts    Realtime agents, tools, handoffs
    ├── runner/                 Code execution (from Plan 01)
    └── styles.css
```

Run it: `make install` then `make run` → `http://localhost:8080`.
Dev: `go run ./cmd/server -dev-dir web` plus `cd web && npm run dev` (port 5173).

## 4. Architecture

```
┌─ BROWSER ─────────────────────────────────────────────────────────┐
│                                                                   │
│  SIGNAL BUS  (deterministic, no model calls)                      │
│  ├── code revision changed                                        │
│  ├── test run finished                                            │
│  ├── candidate silent for N seconds                               │
│  └── candidate finished speaking                                  │
│         │                                                         │
│         │  gates: min 45s since last question,                    │
│         │         not while actively typing,                      │
│         │         agent not currently speaking                    │
│         ▼                                                         │
│  POST /api/interview/signal ─────────────────────┐                │
│                                                  │                │
│  REALTIME AGENT (the mouth)                      │                │
│  ├── owns mic, speaker, turn-taking              │                │
│  ├── tool: get_next_question ──> local cache     │                │
│  └── outputGuardrails (SDK, cuts hints mid-speech)              │ │
└──────────────────────────────────────────────────┼────────────────┘
                                                   │
┌─ GO SERVER ───────────────────────────────────────▼───────────────┐
│                                                                   │
│  OBSERVERS (one model call per signal, structured output)         │
│  ├── code observer    → reads code + diff                         │
│  └── test observer    → reads run results (no model, facts only)  │
│         │                                                         │
│         ▼  appends Observation                                    │
│  SESSION STATE (in-memory map, keyed by sessionId)                │
│  ├── interview plan (rubric areas + coverage)                     │
│  ├── observations                                                 │
│  └── queued next question                                         │
│         │                                                         │
│         ▼                                                         │
│  ORCHESTRATOR (one model call, structured output)                 │
│  └── picks the least-covered rubric area, writes next question    │
└───────────────────────────────────────────────────────────────────┘
```

**The key idea:** the orchestrator is a **coverage tracker**. It knows which rubric areas still lack evidence and steers questions there. It works ahead and keeps one question ready, so the voice agent never waits on a model call.

## 5. Locked decisions — do not change these

| Decision | Value | Why |
|---|---|---|
| Observers + orchestrator run on | **Go server**, raw Responses API with JSON schema | Keeps the API key server-side. Matches the existing `evaluationHandler` pattern. The core Agents SDK loses tracing when bundled for browser. |
| Realtime voice stays on | `@openai/agents/realtime` in the browser | Handoffs, tools, and guardrails all work there. Do not move it. |
| Session state | In-memory Go map, `sync.RWMutex` | Hackathon scope. Do not add a database. |
| Default agent behaviour | **Silence** | The agent speaks only when the orchestrator queued something, or the candidate asked it something directly. |
| Video / webcam frame analysis | **Not built** | `HLD.md` §3 lists gaze detection as a non-goal. Do not add it. |
| Whiteboard observer | **Interface only, no implementation** | Scope not yet decided. Build the registry so it slots in later. |
| Model IDs | Read from env vars only | Do not invent or hardcode model names. |

## 6. Task 1 — Interview plan generation

When an interview starts, build a plan once.

**New endpoint:** `POST /api/interview/plan`

Request:
```json
{ "sessionId": "uuid", "role": "Software Engineer", "rubric": "<rubric text>", "question": "<problem prompt>", "durationSeconds": 300 }
```

Call the Responses API with model from `OPENAI_ORCHESTRATOR_MODEL` (fall back to `OPENAI_EVALUATION_MODEL`, then the same default that handler already uses). Strict JSON schema:

```json
{
  "areas": [
    {
      "id": "approach",
      "label": "Choice and explanation of approach",
      "weight": 25,
      "targetEvidence": "Candidate names a data structure and justifies the trade-off",
      "probeSeeds": ["Why that structure?", "What is the cost of that choice?"]
    }
  ]
}
```

Rules for the prompt:
- Derive areas **only** from the supplied rubric. Do not invent scored dimensions.
- Order areas by when they naturally arise: understanding first, complexity and trade-offs last.
- Budget: roughly one area per `durationSeconds / 60` minutes. A 5-minute interview gets 4–5 areas maximum.
- `probeSeeds` are starting points, not scripts. The orchestrator will write the actual question later.

Store in session state as `plan`, each area starting with `covered: false` and `evidenceCount: 0`.

`App.tsx` calls this once during `startInterview`, in parallel with the Realtime connection. If it fails, log it and continue — the interview must still run without a plan (orchestrator then falls back to rubric text directly).

## 7. Task 2 — Signal bus (browser)

Create `web/src/orchestrator/signals.ts`.

Signal kinds:

| Kind | Fires when |
|---|---|
| `code_changed` | Editor revision changed, and 3 seconds have passed with no further change (debounced — do not fire mid-typing) |
| `tests_run` | A run completed (from Plan 01) |
| `silence` | No candidate speech and no editor change for 20 seconds |
| `candidate_spoke` | Realtime session emitted an end-of-speech event |

**Gates. Check all of these before sending a signal.** These are plain boolean checks with no model calls. They are the main defence against an over-talkative interviewer.

1. At least **45 seconds** since the orchestrator last queued a question.
2. The candidate has not typed in the last **3 seconds**.
3. The realtime agent status is `listening` (not `speaking`, `thinking`, or `ending`).
4. The interview is not in its final 20 seconds.

If any gate fails, drop the signal silently. Do not queue it for later.

Replace the existing 5-second `setInterval` in `useInterviewAgent.ts` entirely. Delete it.

Send: `POST /api/interview/signal`
```json
{
  "sessionId": "uuid",
  "kind": "code_changed",
  "codeRevision": 42,
  "code": "<current editor contents>",
  "lastRun": { /* RunResult from Plan 01, or null */ },
  "elapsedSeconds": 130
}
```

## 8. Task 3 — Observers (Go)

Create `cmd/server/observers.go`.

Define an interface so new observers slot in without touching the handler:

```go
type Observer interface {
    Name() string
    Handles(signal Signal) bool
    Observe(ctx context.Context, signal Signal, state *SessionState) (*Observation, error)
}
```

```go
type Observation struct {
    Observer   string  `json:"observer"`
    AreaID     string  `json:"areaId"`
    Finding    string  `json:"finding"`
    Confidence float64 `json:"confidence"`
    Revision   int     `json:"revision"`
    CreatedAt  string  `json:"createdAt"`
}
```

### 8.1 Code observer (model call)

Handles `code_changed` and `silence`.

Prompt it with: the problem, the rubric areas and their current coverage, the previous code snapshot, and the current code. Strict JSON schema returning `areaId`, `finding`, `confidence`, and `isNoteworthy` (boolean).

**If `isNoteworthy` is false, return no observation.** Most code changes are not interesting. The observer must be willing to say nothing.

Store the previous code snapshot in session state so the observer sees a diff, not just the current state.

### 8.2 Test observer (no model call)

Handles `tests_run`. Pure Go, zero model calls. Converts run results into an observation directly:

- All tests pass → `areaId: "correctness"`, finding describes the pass, confidence 1.0
- Some fail → finding names the failing test indices and what the code returned, confidence 1.0
- Compile error or timeout → finding names the failure

This is a fact, not a judgement. Never send it to a model.

### 8.3 Whiteboard observer (interface only)

Create the file `cmd/server/observer_whiteboard.go` with the struct and a `Handles` that returns `false`, plus a `// TODO: scope not yet decided` comment. Do not implement it. Do not register it.

### 8.4 Registry

A slice of observers checked in order. Each signal goes to every observer whose `Handles` returns true. Run them concurrently with `errgroup` if more than one matches.

Every observation is also appended to `runtime/evidence.jsonl` using the existing `appendJSONLine`, with `category` set to the `areaId`. This keeps one evidence trail for the final report.

## 9. Task 4 — Orchestrator (Go)

Create `cmd/server/orchestrator.go`.

Runs after observers finish, inside the same `/api/interview/signal` request.

Inputs: the plan with current coverage, all observations so far, elapsed time, remaining time, and how many questions have been asked.

One Responses API call, strict JSON schema:

```json
{
  "shouldAsk": true,
  "areaId": "approach",
  "question": "Why a map instead of two passes?",
  "basis": "Candidate switched to a Map at revision 31 without explaining it",
  "reasoning": "approach has no evidence yet and 60% of time remains"
}
```

Prompt rules — write these explicitly into the system prompt:

- Prefer the rubric area with the **least evidence** and the **highest weight**.
- The question must be under 12 words.
- The question must reference something concrete: the code, a test result, or something the candidate said.
- Never reveal an algorithm name, data structure, or any part of the solution.
- Set `shouldAsk: false` when there is nothing worth asking. Silence is a valid, expected output.
- Never repeat a question already asked. The prompt receives the list of asked questions.
- In the final 25% of the interview, prefer complexity and trade-off areas.

If `shouldAsk` is true, store the question in `state.nextQuestion` and stamp `lastQueuedAt`. Mark nothing as covered yet — coverage updates when evidence arrives, not when a question is asked.

Response to the browser:
```json
{ "hasQuestion": true, "question": "Why a map instead of two passes?", "areaId": "approach" }
```

The browser caches this. The realtime tool reads the cache, so the voice agent never waits on a network call.

## 10. Task 5 — Rewire the realtime agent

In `useInterviewAgent.ts`:

### 10.1 New tool `get_next_question`

Give it to the Coding Interviewer and the Reflection Agent.

```ts
tool({
  name: "get_next_question",
  description: "Retrieve the question the interview planner has prepared. Call this when prompted to check for a question. If it returns hasQuestion false, say nothing at all and keep listening.",
  parameters: z.object({}),
  async execute() { /* read local cache, clear it after reading */ }
})
```

Returns `{ hasQuestion: true, question, areaId, basis }` or `{ hasQuestion: false }`.

Reading clears the cache so the same question is never asked twice.

### 10.2 Push, do not poll

When `/api/interview/signal` responds with `hasQuestion: true`, the browser calls `session.sendMessage("A prepared question is available. Call get_next_question and ask it verbatim. Do not add preamble.")`.

When it responds `hasQuestion: false`, the browser sends **nothing**. The agent stays silent.

### 10.3 Prompt changes

Rewrite the Coding Interviewer instructions:

- It no longer decides what to probe on its own. The planner does.
- It asks the prepared question **verbatim**. It may not rephrase, expand, or add a preamble.
- It still handles the candidate's direct questions naturally — clarifying the problem statement, or redirecting off-topic questions with "Stay on the problem."
- It still follows the zero-hint policy already in the prompt.
- Remove the instructions about periodic code review messages. Those no longer exist.

Keep the Introduction Agent as-is. Keep the Reflection Agent, but give it `get_next_question` too.

## 11. Task 6 — Output guardrails

Add `outputGuardrails` to the `RealtimeSession` constructor.

One guardrail, named `zero_hint`. It runs on the agent's output text every ~100 characters, in parallel with speech, and can cut output off before the candidate hears it.

Trip the tripwire when the output contains any of:
- A named algorithm or data structure offered as a suggestion (`hash map`, `two pointers`, `sliding window`, `memoize`, and similar) — when the agent is proposing it rather than repeating the candidate
- A code block, or more than three consecutive tokens that look like code
- A direct correctness verdict (`that is correct`, `that works`, `you got it`, `wrong`)
- Praise (`great`, `nice`, `well done`, `good job`)

Implement it as a fast local regex/keyword check first. Do not make a model call on every 100 characters — that is too slow and too expensive.

Set `outputGuardrailSettings` with the default debounce. When a tripwire fires, log it and let the SDK interrupt.

Surface trips in the existing tool-call panel in `App.tsx` as a distinct red row, e.g. `guardrail: zero_hint blocked`. This is a demo asset — a judge should see the guardrail catch something.

## 12. Task 7 — Make it visible

The whole point is that a viewer can see the system thinking. Extend the existing `AGENT TOOL CALLS` sidebar panel in `App.tsx` into an `AGENT ACTIVITY` panel with typed rows:

| Row type | Example |
|---|---|
| `signal` | `code_changed · rev 42` |
| `observer` | `code observer → approach` |
| `orchestrator` | `queued: approach (25% weight, 0 evidence)` |
| `orchestrator` | `stayed silent` |
| `tool` | `get_next_question` |
| `guardrail` | `zero_hint blocked` |

Colour-code by type. Keep the last 12 rows. This replaces the current `toolEvents` list.

Add a small coverage strip above it: one bar per rubric area, filling as evidence accumulates. A judge should see the interview systematically covering the rubric.

## 13. Acceptance criteria

Verify by running the app.

1. `make check` passes.
2. The old 5-second `setInterval` is gone from `useInterviewAgent.ts`.
3. Typing continuously for 30 seconds produces **zero** questions. The 3-second debounce and the 45-second gate both hold.
4. After a pause in typing, a signal fires and appears in the activity panel.
5. The orchestrator sometimes returns `shouldAsk: false`. The agent then says nothing. Verify this happens at least once in a 5-minute run.
6. When a question is queued, the agent asks it verbatim, with no preamble.
7. Two questions are never less than 45 seconds apart.
8. Running the buggy preset from Plan 01 produces a test observation with confidence 1.0 and no model call.
9. The coverage strip fills as the interview progresses.
10. Forcing the agent to say "great job, that's correct" trips the `zero_hint` guardrail and shows a red row.
11. Killing the `/api/interview/plan` call still lets the interview run end to end.
12. Every observation lands in `runtime/evidence.jsonl` and appears in the final report.

## 14. Out of scope — do not build

- Webcam or video-frame analysis of any kind. Gaze, attention, emotion, and presence detection are all excluded. `HLD.md` §3 forbids them.
- Whiteboard capture, canvas UI, or PNG handling. Interface stub only.
- Auth, login, databases, webhooks, recruiter dashboards.
- Extracting a reusable SDK package. A separate plan covers that.
- Multi-session support. One in-memory session at a time is fine.
- The dead files `useLocalVoice.ts` and `useRealtimeVoice.ts`, and the `/api/local-voice/chat` and `/api/realtime/session` handlers.
