# Plan 01 — Make candidate code runnable

## 1. Context

You are working on **Signal Interview**, a browser-based automated coding interview app.

A candidate joins a session. An AI voice agent (OpenAI Realtime) introduces a coding problem. The candidate writes code in a Monaco editor while the agent listens, inspects the code through tool calls, and asks questions. At the end, a backend workflow scores the interview and renders a report.

**Today the code never runs.** Monaco is a plain text box. The final report explicitly states that correctness was never verified.

**Your job:** let the candidate run their code against test cases and see results in a terminal panel below the editor. Also expose those results to the AI agent, and add two demo-only preset buttons.

This is a hackathon demo. Optimise for a working, visually clear result. Do not add auth, databases, or multi-tenancy.

## 2. Repo map

```
interview-agent/
├── cmd/server/main.go          Go backend. All HTTP handlers in one file.
├── questions/default.txt       The coding problem, plain text.
├── web/
│   ├── package.json            React 18, Vite 5, TS 5.7, @monaco-editor/react, @openai/agents, zod
│   ├── vite.config.ts          Proxies /api to :8080. Builds to ../cmd/server/webdist
│   └── src/
│       ├── App.tsx             Whole UI. Lobby / interview / finished screens.
│       ├── useInterviewAgent.ts  Realtime agents, tools, handoffs
│       ├── styles.css          All styles
│       ├── useLocalVoice.ts    DEAD CODE, unused
│       └── useRealtimeVoice.ts DEAD CODE, unused
└── Makefile                    make install / build / run / check
```

Run it: `make install` then `make run`, opens on `http://localhost:8080`.
Dev mode: `go run ./cmd/server -dev-dir web` plus `cd web && npm run dev` (port 5173).

## 3. Current state of the files you will touch

**`questions/default.txt`** — plain text describing a `firstNonRepeatingCharacter` problem.

**`cmd/server/main.go:168` `questionHandler`** — reads that text file, returns `{"id": "first-non-repeating-character", "question": "<text>"}`.

**`cmd/server/main.go:228` `evaluationHandler`** — builds a prompt for the final report. The prompt currently contains this line, which must change:
> `Code was not executed, so correctness is only a static estimate.`

**`web/src/App.tsx`** — holds `STARTER_CODE` as a hardcoded const (line ~25). The interview screen has a `coding-column` (question card + editor) and an `interview-sidebar` (video, agent status, tool call panel, controls).

**`web/src/useInterviewAgent.ts`** — defines agent tools including `fetch_coding_question` (line ~86) and `get_current_code` (line ~108). Tools are `tool()` from `@openai/agents/realtime` with zod schemas.

## 4. Locked decisions — do not change these

| Decision | Value |
|---|---|
| Where code runs | Browser Web Worker. **Not** the Go server. No Docker, no third-party API. |
| Languages | TypeScript only. Do not add Python or Pyodide. |
| Run trigger | Button press only. **No** auto-run, no timer, no run-on-type. |
| Test names | Candidate never sees test names. Tests are numbered only. |
| Buggy preset | Must **fail test assertions**. Must **not** crash or throw. |
| Execution timeout | 3 seconds, then kill the worker. |

## 5. Task 1 — Convert the question to JSON

Delete `questions/default.txt`. Create `questions/default.json`:

```json
{
  "id": "first-non-repeating-character",
  "language": "typescript",
  "entryFunction": "firstNonRepeatingCharacter",
  "prompt": "Implement a function `firstNonRepeatingCharacter` that receives a string and returns the index of the first character that appears exactly once. Return `-1` when every character repeats.\n\nExamples:\n- `\"leetcode\"` returns `0`\n- `\"loveleetcode\"` returns `2`\n- `\"aabb\"` returns `-1`\n\nAsk clarifying questions when requirements are ambiguous. Discuss the expected time and space complexity before finishing.",
  "starterCode": "function firstNonRepeatingCharacter(input: string): number {\n  // Explain your approach while you work.\n\n  return -1;\n}",
  "tests": [
    { "args": ["leetcode"],     "expected": 0  },
    { "args": ["loveleetcode"], "expected": 2  },
    { "args": ["aabb"],         "expected": -1 },
    { "args": ["abcabd"],       "expected": 2  }
  ],
  "demo": {
    "solution": "function firstNonRepeatingCharacter(input: string): number {\n  const counts = new Map<string, number>();\n  for (const character of input) {\n    counts.set(character, (counts.get(character) ?? 0) + 1);\n  }\n  for (let index = 0; index < input.length; index += 1) {\n    if (counts.get(input[index]) === 1) return index;\n  }\n  return -1;\n}",
    "buggy": "function firstNonRepeatingCharacter(input: string): number {\n  for (let index = 0; index < input.length; index += 1) {\n    if (input[index] !== input[index + 1] && input[index] !== input[index - 1]) {\n      return index;\n    }\n  }\n  return -1;\n}"
  }
}
```

The buggy preset only compares neighbouring characters. Verified behaviour: passes tests 1 and 3, fails tests 2 and 4 (returns `0` for both, expected `2`). It never throws. **Do not substitute your own buggy code without verifying the same 2-pass / 2-fail split.**

**`cmd/server/main.go` `questionHandler`:** read `questions/default.json`, verify it parses as JSON, return the whole object unchanged with `Content-Type: application/json`. Return HTTP 500 with `"question bank is unavailable"` if the file is missing or malformed.

## 6. Task 2 — The runner

Create `web/src/runner/`.

### 6.1 Compile step (main thread)

Monaco already bundles a TypeScript worker. Use it. Do **not** add a new compiler dependency.

```ts
const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
const client = await getWorker(model.uri);
const emit = await client.getEmitOutput(model.uri.toString());
const javascript = emit.outputFiles[0].text;
```

Get the `monaco` namespace and the editor `model` from the `onMount(editor, monaco)` callback of `@monaco-editor/react`. Store them in a ref in `App.tsx`.

Before emitting, call `client.getSyntacticDiagnostics(uri)`.
- **Syntactic errors → stop.** Report a compile error. Do not run.
- **Semantic (type) errors → do not block.** Collect them, show them as warnings in the Output tab, and run anyway. TypeScript type errors do not prevent JavaScript from executing.

Map diagnostic `start` offsets to line numbers using `model.getPositionAt(start)`.

### 6.2 Worker (`web/src/runner/execute.worker.ts`)

Create with Vite's native syntax:

```ts
new Worker(new URL("./execute.worker.ts", import.meta.url), { type: "module" })
```

**Message in:**
```ts
{ javascript: string; entryFunction: string; tests: { args: unknown[]; expected: unknown }[] }
```

**Message out:**
```ts
{
  consoleOutput: string[];
  results: { index: number; passed: boolean; got: unknown; error: string | null }[];
  fatalError: string | null;
}
```

Worker behaviour:

1. Override `self.console.log`, `.warn`, `.error`. Push stringified args into a `consoleOutput` array. Cap at 100 entries.
2. Resolve the entry function: `new Function(javascript + "\n; return typeof " + entryFunction + " === 'function' ? " + entryFunction + " : null;")()`.
3. If it returns `null`, send back `fatalError: "Could not find a function named '<entryFunction>'. Do not rename it."` and stop.
4. Run each test in its own `try/catch`. On throw, record `passed: false` and the error message in that test's `error` field. Keep going to the next test.
5. Compare with a `deepEqual` helper that handles primitives, arrays, and plain objects. Do not use `JSON.stringify` comparison alone.

### 6.3 Timeout (main thread)

Start a 3-second `setTimeout` when you post to the worker. If the worker has not replied, call `worker.terminate()` and report status `timeout`. Create a fresh worker for the next run — a terminated worker cannot be reused.

### 6.4 Result shape returned to `App.tsx`

```ts
type RunResult = {
  status: "compile_error" | "fatal_error" | "timeout" | "completed";
  message: string | null;          // for compile_error / fatal_error / timeout
  warnings: string[];              // type errors, non-blocking
  consoleOutput: string[];
  tests: {
    index: number;                 // 1-based, for display
    args: unknown[];
    expected: unknown;
    got: unknown;
    passed: boolean;
    error: string | null;
  }[];
  passedCount: number;
  totalCount: number;
  ranAt: number;                   // Date.now()
  codeRevision: number;
};
```

## 7. Task 3 — The run panel UI

Create `web/src/RunPanel.tsx`. Mount it inside the existing `coding-column`, below the editor shell. Make `coding-column` a flex column so the editor shrinks and the panel keeps a fixed height (~220px). The panel must be collapsible via a chevron in its header.

```
┌──────────────────────────────────────────────────┐
│  QUESTION                                        │
├──────────────────────────────────────────────────┤
│  ⚙ DEMO   [Load solution]  [Load buggy]          │
├──────────────────────────────────────────────────┤
│                                                  │
│  Monaco editor                                   │
│                                                  │
├──────────────────────────────────────────────────┤
│  [▶ Run]         Tests 2/4 │ Output          ⌄   │
├──────────────────────────────────────────────────┤
│  ✓  Test 1   "leetcode"       → 0                │
│  ✗  Test 2   "loveleetcode"   expected 2, got 0  │
│  ✓  Test 3   "aabb"           → -1               │
│  ✗  Test 4   "abcabd"         expected 2, got 0  │
└──────────────────────────────────────────────────┘
```

**Tests are numbered, never named.** The JSON has no `name` field on purpose. Do not add one. Descriptive names like "empty string edge case" would hint at the solution.

Two tabs: **Tests** and **Output**. Tests is the default. Output shows `consoleOutput` lines plus any type-error `warnings`.

Five display states:

| Status | Tests tab shows |
|---|---|
| Never run | `Test 1..4` greyed out. Caption: "Run your code to check it against the test cases." |
| Running | Spinner on the Run button. Button disabled. |
| `compile_error` | Red block with `message`, including the line number. No test rows. |
| `fatal_error` / `timeout` | Red block with `message`. No test rows. |
| `completed` | One row per test. Green check or red cross. |

Row detail on `completed`:
- Passed: `Test N` · the input args · `→ <got>`
- Failed: `Test N` · the input args · `expected <expected>, got <got>`
- Threw: `Test N` · the input args · the error message

Header badge shows `Tests 2/4`. Green when all pass, red otherwise.

Serialise `args`, `expected`, and `got` with `JSON.stringify` for display so strings render with quotes.

## 8. Task 4 — Demo control strip

A thin bar between the question card and the editor. Label it `⚙ DEMO`. Style it visibly differently from the candidate UI — muted, dashed border, small text. It must read as an operator control, not part of the interview.

Two buttons:
- **Load solution** → replace editor contents with `demo.solution`
- **Load buggy** → replace editor contents with `demo.buggy`

Both only set the editor value. Neither triggers a run. The operator presses Run themselves.

Gate the whole strip behind a constant `const SHOW_DEMO_CONTROLS = true;` at the top of `App.tsx`. Flipping it to `false` removes the strip entirely.

## 9. Task 5 — Give the agent the results

### 9.1 Stop leaking the answer to the agent

`fetch_coding_question` in `useInterviewAgent.ts` currently returns the whole API response to the model. After Task 1 that payload includes `starterCode`, `tests`, and `demo.solution`.

**The tool must return only `{ id, prompt }` to the model.** Strip everything else. Call `config.onQuestion(data.prompt)` for the UI as it does today.

`App.tsx` fetches the full config separately for its own use (starter code, tests, demo presets).

### 9.2 New tool `get_execution_results`

Add to `useInterviewAgent.ts`. Give it to the **Coding Interviewer** and **Reflection Agent**, not the Introduction Agent.

Config gains a getter: `getLastRun: () => RunResult | null`.

```ts
tool({
  name: "get_execution_results",
  description: "Inspect the outcome of the candidate's most recent code run. Use this before asking about correctness. The expected outputs are deliberately withheld from you — never state or imply what the correct output should be.",
  parameters: z.object({ reason: z.string() }),
  async execute({ reason }) { /* ... */ }
})
```

Returns when a run exists:
```ts
{
  reason,
  hasRun: true,
  status,
  passedCount,
  totalCount,
  codeRevision,
  consoleOutput,
  tests: [{ index, args, got, passed, error }]   // NOTE: no `expected` field
}
```

**Omit `expected` from the agent's view.** The candidate's panel shows it, the agent does not. This lets the agent ask "Test 2 with input 'loveleetcode' returns 0. Walk me through why." without handing over the answer.

Returns when no run exists: `{ reason, hasRun: false, message: "The candidate has not run their code yet." }`

### 9.3 Auto-record every run as evidence

After each run completes, `App.tsx` posts directly to `POST /api/interview/evidence`. Do not route this through the agent — it is a machine fact, not a model observation.

```json
{
  "sessionId": "<current session id>",
  "category": "code_execution",
  "observation": "Code run at revision 42: 2 of 4 tests passed. Test 2 (input: [\"loveleetcode\"]) returned 0. Test 4 (input: [\"abcabd\"]) returned 0.",
  "confidence": 1,
  "codeRevision": 42
}
```

For non-`completed` statuses, write the failure instead: `"Code run at revision 42 failed to compile: <message>"`.

Fire and forget. A failed post must not break the run panel.

The Go handler needs no change — `Category` is an unvalidated string.

## 10. Task 6 — Fix the final report

In `cmd/server/main.go` `evaluationHandler`:

1. **Delete** the sentence `Code was not executed, so correctness is only a static estimate.`
2. **Replace** with: `Test execution results are included in the evidence below. Where tests were run, treat pass and fail counts as verified fact. Where the candidate never ran their code, note that as a gap.`
3. The recorded `code_execution` evidence already flows in through `evidenceForSession`. No new plumbing needed.

Also update the report's `limitations` guidance so it no longer claims code was never executed when it was.

## 11. Acceptance criteria

Verify each one by running the app.

1. `make check` passes (`npm run typecheck` and `go test ./...`).
2. Starting an interview loads starter code from `questions/default.json`, not a hardcoded const.
3. Pressing **Load solution** then **Run** shows 4 of 4 green.
4. Pressing **Load buggy** then **Run** shows 2 of 4, with tests 2 and 4 red showing `expected 2, got 0`.
5. No test row anywhere displays a test name. Only `Test 1`, `Test 2`, and so on.
6. Deleting a closing brace and pressing Run shows a compile error with a line number, and runs no tests.
7. Typing `while(true){}` inside the function and pressing Run shows a timeout after ~3s. The page stays responsive.
8. Renaming the function shows the "Could not find a function named" message.
9. `console.log("hi")` inside the function appears in the Output tab.
10. Code never runs on its own. Only the Run button starts it.
11. Every run appends a `code_execution` line to `runtime/evidence.jsonl`.
12. The final report references test results and does not claim code was never executed.
13. Setting `SHOW_DEMO_CONTROLS = false` removes the demo strip with no other visual change.

## 12. Out of scope — do not touch

- Voice agent turn-taking, prompt wording, or the 5-second code-scan interval in `useInterviewAgent.ts`. A separate plan covers interview etiquette.
- Auth, login, databases, webhooks, recruiter dashboards.
- Extracting a reusable SDK or config package. A separate plan covers that.
- The dead files `useLocalVoice.ts` and `useRealtimeVoice.ts`, and the `/api/local-voice/chat` and `/api/realtime/session` handlers. Leave them alone for now.
- Adding languages beyond TypeScript.
