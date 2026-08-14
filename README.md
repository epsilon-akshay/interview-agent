# Signal Interview

Signal Interview is a local, automated coding-interview application built with Go, React, Monaco, the OpenAI Agents SDK, Realtime speech-to-speech, and a separate Codex evaluation manager.

The interviewer presents a server-controlled problem, listens to the candidate, observes editor revisions, asks short rubric-driven questions, records evidence, and ends at a configurable time limit. Afterward, an evaluation manager generates a structured rubric report. Candidate code is reviewed statically and is never executed.

## Features

- Browser camera, microphone, video recording, and Monaco code editor
- Low-latency Realtime speech-to-speech interview
- Tool-driven question, rubric, editor, and evidence access
- Introduction, coding, and reflection agents with handoffs
- Five-second code-revision monitor that prompts a review only after code changes
- Strict interviewer: one short question, no hints, praise, coaching, or answers
- Fair challenge through assumptions, counterexamples, invariants, and edge cases
- Configurable interview duration, five minutes by default
- Graceful time-limit announcement and session shutdown
- Final category scores, supporting evidence, gaps, risks, limitations, and recommendation

## Architecture

```text
Browser
├── React setup, timer, report UI, and recording
├── Monaco editor
└── Agents SDK RealtimeSession
    ├── Introduction Agent
    ├── Coding Interviewer
    └── Reflection Agent
          │ WebRTC audio + API tool calls
          ▼
Go server
├── Mints short-lived Realtime client secrets
├── Serves the question bank
├── Persists evidence and completion events
├── Calls the Responses API for final structured evaluation
└── Serves the production frontend
```

See [HLD.md](HLD.md) for the system design and [PRODUCT_SPEC.md](PRODUCT_SPEC.md) for product behavior and acceptance criteria.

## Agent flow

1. The Introduction Agent calls `get_interview_context`, `fetch_coding_question`, and `read_interview_rubric` in order.
2. It briefly presents the problem and hands off to the Coding Interviewer.
3. The interviewer uses `get_current_code` and `record_interview_evidence` to test rubric criteria.
4. Every five seconds, the browser checks whether the editor revision changed. If it did and the agent is idle, it requests a code scan. The agent asks only when the new code creates a useful assessment probe.
5. The Reflection Agent can test complexity, invariants, edge cases, and tradeoffs.
6. At the time limit, the browser mutes input, records completion, asks the active agent to announce that time is up, and closes after final audio.
7. The Evaluation Manager reads the final question, rubric, code, and recorded evidence and returns a schema-validated report.

## Run locally

Requirements: Go 1.19+, Node.js 20+, a modern browser, and an OpenAI Platform API key with access to the configured models.

Create `.env`:

```dotenv
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
OPENAI_EVALUATION_MODEL=gpt-5.2-codex
```

Then run:

```bash
make install
make run
```

Open <http://localhost:8080> and allow camera and microphone access. The recording remains in browser memory; save it before refreshing.

Do not use a ChatGPT Plus subscription token or Codex CLI login token in `.env`. API usage requires a Platform API key and is billed separately.

## Development

Run the backend and Vite frontend separately:

```bash
go run ./cmd/server -dev-dir web
```

```bash
cd web
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` requests to Go on port 8080.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Server health |
| `POST` | `/api/realtime/token` | Mint an ephemeral Realtime client secret |
| `GET` | `/api/interview/question` | Load the coding problem text file |
| `POST` | `/api/interview/evidence` | Append a rubric evidence event |
| `POST` | `/api/interview/complete` | Record the terminal event |
| `POST` | `/api/interview/evaluate` | Generate the final structured report |

Runtime artifacts are written to `runtime/*.jsonl` and should be treated as private interview data.

## Important limitations

- Code is not compiled or executed; correctness is a model-assisted static estimate.
- The five-second monitor scans code changes, not camera frames.
- Prompt rules reduce hints and verbosity but production systems should add automated conversation-policy evaluations.
- JSONL storage is suitable for a local demo, not multi-instance production deployment.
