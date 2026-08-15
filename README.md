Link to the video: https://www.loom.com/share/2cf22b705d72432eb778935e2026f100

# Signal Interview

Signal is an AI interview agent that adapts each interview to a candidate’s profile and the role.

It supports four ways of input and interaction:
- Voice,
- AI Chat (for implementation only, no planning)
- Code editor
- Whiteboard.

The AI follows the candidate’s work across these modes, asks relevant follow-up questions, and evaluates both the answer and the reasoning behind it. Unlike AI interviewers built around a fixed voice conversation, Signal supports different ways of thinking and solving problems within one interview.

## Features

- Browser camera, microphone, video recording, Monaco code editor, and tldraw whiteboard
- Browser-isolated code runner with visible checks and console output
- Low-latency Realtime speech-to-speech interview
- Tool-driven question, rubric, editor, and evidence access
- Introduction, coding, and reflection agents with handoffs
- Planning layer that decides what to ask, so the voice agent stays silent by default
- Deterministic gates that never interrupt active typing
- Precomputed questions, so a proactive probe lands in about four seconds
- Candidate speech transcription feeding both live analysis and the final report
- Zero-hint output guardrail that cuts leakage before the candidate hears it
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
├── Planning layer (Agents SDK)
│   ├── Signal bus, no model calls
│   ├── Interview planner, builds rubric coverage
│   └── Analyst, observes and writes the next question
└── Agents SDK RealtimeSession
    ├── Introduction Agent
    ├── Coding Interviewer
    └── Reflection Agent
          │ WebRTC audio + API tool calls + proxied model calls
          ▼
Go server
├── Mints short-lived Realtime client secrets
├── Proxies planning-layer model calls, holding the API key
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
4. A one-second signal bus watches the editor, whiteboard, and test runs without calling any model. Gates block a question until typing stops, 45 seconds have passed, and the agent is idle.
5. An analyst call records what changed and writes the next question. It runs ahead of the gate, so the question is usually ready before it is needed. The voice agent receives the finished text and speaks it verbatim.
6. The Reflection Agent can test complexity, invariants, edge cases, and tradeoffs.
7. At the time limit, the browser mutes input, records completion, asks the active agent to announce that time is up, and closes after final audio.
8. The Evaluation Manager reads the final question, rubric, code, test evidence, whiteboard summary, whiteboard PNG, transcript, and recorded evidence. It returns a schema-validated report.

## Run locally

Requirements: Go 1.19+, Node.js 20+, a modern browser, and an OpenAI Platform API key with access to the configured models.

Create `.env`:

```dotenv
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
OPENAI_EVALUATION_MODEL=gpt-5.2-codex
# Planning layer. Leave blank to fall back to OPENAI_EVALUATION_MODEL.
# Set OPENAI_OBSERVER_MODEL to a fast general model; it runs during the interview.
OPENAI_OBSERVER_MODEL=
OPENAI_ORCHESTRATOR_MODEL=
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
| `GET` | `/api/interview/question` | Load the coding problem, starter code, and tests |
| `POST` | `/api/interview/evidence` | Append a rubric evidence event |
| `POST` | `/api/interview/complete` | Record the terminal event |
| `POST` | `/api/interview/evaluate` | Generate the final structured report |
| `GET` | `/api/config` | Return planning-layer model names |
| `POST` | `/api/openai/v1/*` | Proxy planning-layer model calls, injecting the API key |

Runtime events are written to `runtime/*.jsonl`. Final whiteboard scenes and PNGs are written to `runtime/whiteboards/`. Treat both as private interview data.

## Important limitations

- Code runs in a browser worker. This is suitable for the demo, not for untrusted production execution.
- The workspace monitor reads Monaco text and tldraw content. It never sends camera frames or unrelated screen content.
- Prompt rules reduce hints and verbosity but production systems should add automated conversation-policy evaluations.
- JSONL storage is suitable for a local demo, not multi-instance production deployment.
