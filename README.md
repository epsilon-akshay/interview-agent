# Signal Interview

Signal Interview is a local, automated coding-interview application built with Go, React, Monaco, tldraw, the OpenAI Agents SDK, Realtime speech-to-speech, and a separate Codex evaluation manager.

The interviewer presents a server-controlled problem, listens to the candidate, reviews changed code and whiteboard work, asks short rubric-driven questions, records evidence, and ends at a configurable time limit. Candidate code can run against browser-isolated checks. Afterward, an evaluation manager generates a structured report from the code, test results, whiteboard, and recorded evidence.

## Features

- Browser camera, microphone, video recording, Monaco code editor, and tldraw whiteboard
- Browser-isolated code runner with visible checks and console output
- Low-latency Realtime speech-to-speech interview
- Tool-driven question, rubric, editor, and evidence access
- Introduction, coding, and reflection agents with handoffs
- Fifteen-second workspace monitor that reviews changed code and whiteboard content
- Strict interviewer: one short question, no hints, praise, coaching, or answers
- Fair challenge through assumptions, counterexamples, invariants, and edge cases
- Configurable interview duration, five minutes by default
- Graceful time-limit announcement and session shutdown
- Final category scores, supporting evidence, gaps, risks, limitations, and recommendation

## Architecture

```text
Browser
├── React setup, timer, report UI, and recording
├── Monaco editor and browser code runner
├── tldraw whiteboard
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
├── Stores final private whiteboard artifacts
├── Calls the Responses API for final structured evaluation
└── Serves the production frontend
```

See [HLD.md](HLD.md) for the system design and [PRODUCT_SPEC.md](PRODUCT_SPEC.md) for product behavior and acceptance criteria.

## Agent flow

1. The Introduction Agent calls `get_interview_context`, `fetch_coding_question`, and `read_interview_rubric` in order.
2. It briefly presents the problem and hands off to the Coding Interviewer.
3. The interviewer uses `get_current_workspace`, `get_execution_results`, and `record_interview_evidence` to test rubric criteria.
4. Every 15 seconds, the browser checks whether code or whiteboard content changed. When the agent is idle, it sends exact code, a scene summary, and a whiteboard PNG. The agent asks only when the change creates a useful assessment probe.
5. The Reflection Agent can test complexity, invariants, edge cases, and tradeoffs.
6. At the time limit, the browser mutes input, records completion, asks the active agent to announce that time is up, and closes after final audio.
7. The Evaluation Manager reads the final question, rubric, code, test evidence, whiteboard summary, whiteboard PNG, and recorded evidence. It returns a schema-validated report.

## Run locally

Requirements: Go 1.19+, Node.js 20+, a modern browser, and an OpenAI Platform API key with access to the configured models.

Create `.env`:

```dotenv
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
OPENAI_EVALUATION_MODEL=gpt-5.2-codex
# Required for a production deployment. The build reads this from the root .env.
VITE_TLDRAW_LICENSE_KEY=your_tldraw_license_key_here
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

Runtime events are written to `runtime/*.jsonl`. Final whiteboard scenes and PNGs are written to `runtime/whiteboards/`. Treat both as private interview data.

## Important limitations

- Code runs in a browser worker. This is suitable for the demo, not for untrusted production execution.
- The workspace monitor reads Monaco text and tldraw content. It never sends camera frames or unrelated screen content.
- Prompt rules reduce hints and verbosity but production systems should add automated conversation-policy evaluations.
- JSONL storage is suitable for a local demo, not multi-instance production deployment.
