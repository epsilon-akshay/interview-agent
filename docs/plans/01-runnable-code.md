# Plan 01 — Runnable candidate code

Status: implemented.

## Purpose

Signal Interview lets a candidate run prepared TypeScript code against visible browser checks. The result is a machine fact. It remains separate from model judgment.

## Boundary

- Code runs in a browser Web Worker.
- The app supports TypeScript only.
- A run starts only when the candidate selects **Run code**.
- A run times out after three seconds.
- Candidate results use numbered checks. They do not reveal private test names.
- The prepared guide supplies the prompt, starter code, entry function, and candidate-safe checks.
- Verified solution and buggy fixtures stay inside the server's private catalog.
- Candidate responses and candidate UI never expose fixture code or fixture-loading controls.

## Run lifecycle

1. The editor records the current code revision.
2. A worker compiles the candidate module and isolated harness.
3. The worker captures console output and runs prepared checks.
4. The UI shows pass, fail, compile, runtime, or timeout state.
5. The browser creates one durable `code_execution` evidence event.

One run maps to one evidence payload. A retry reuses the same event ID and payload.

```json
{
  "sessionId": "0123456789abcdef0123456789abcdef",
  "eventId": "89abcdef0123456789abcdef01234567",
  "category": "code_execution",
  "observation": "3 of 4 browser checks passed.",
  "confidence": 1,
  "codeRevision": 17,
  "whiteboardRevision": 4
}
```

The planner can update in-memory rubric coverage after the server acknowledges the event. It does not persist the same run again.

## Safety

The worker has no server credential. It does not run code on the Go process. This boundary is fit for a local demonstration. It is not a production sandbox for hostile code.

The server validates prepared executable tasks against its verified catalog. AI-generated executable code, tests, solutions, and buggy fixtures cannot control the runner.

## Failure behavior

- A compile error produces a visible result and one evidence event.
- A runtime error produces a visible result and one evidence event.
- A timeout terminates the worker and produces one evidence event.
- A persistence error shows a retry action. Rubric coverage stays unchanged until acknowledgement.

## Verification

```bash
make check
make browser-test
```

Browser coverage proves AI checks can load the editor, run checks, save evidence, finish, and evaluate from the saved artifacts.
