# Signal Interview — High-Level Design

## 1. Purpose

Signal Interview is an automated technical interview application that conducts a timed, voice-based coding interview. A candidate speaks with an OpenAI Realtime agent while writing code in a browser-based Monaco editor. The interviewer loads a server-controlled question and recruiter-defined rubric through tool calls, observes the candidate's current code, records assessment evidence, and ends the interview gracefully when the configured time expires.

The current system runs candidate code against browser-isolated checks. Test outcomes are verified artifacts. The model judges reasoning and any correctness claims outside those checks.

## 2. Goals

- Conduct a natural, low-latency spoken interview.
- Enforce a strict, assessment-only interview policy.
- Load the question from a server-side text question bank.
- Load the recruiter rubric from the configured UI textbox.
- Observe the latest candidate code and whiteboard through explicit agent tools.
- Record evidence connected to rubric categories.
- Support specialist interview phases using agent handoffs.
- Provide a configurable interview duration, defaulting to five minutes.
- Announce that time is up before closing voice and media resources.
- Keep the permanent OpenAI API key on the backend.
- Provide observable agent and tool activity for the hackathon demonstration.

## 3. Non-goals

- Production-grade isolation for untrusted code execution.
- Guaranteeing code correctness.
- Supporting multiple programming languages in the initial version.
- Detecting emotion, personality, confidence, gaze, or deception.
- Scoring accent, appearance, speaking style, or background environment.
- Providing hints, solutions, pseudocode, or coaching during the assessment.
- Production-scale authentication, tenancy, or remote interviewer participation.

## 4. System context

```text
┌──────────────────────────────── Candidate browser ────────────────────────────────┐
│                                                                                   │
│  Camera/microphone   Monaco editor   tldraw board       Rubric/timer UI            │
│          │                 │                │                  │                   │
│          └─────────────────┴────────────────┴──────────────────┘                   │
│                                      │                                            │
│                         OpenAI Agents SDK (TypeScript)                             │
│                    RealtimeSession + specialist RealtimeAgents                    │
│                         │                         │                                │
└─────────────────────────┼─────────────────────────┼────────────────────────────────┘
                          │ WebRTC audio            │ HTTPS tools
                          ▼                         ▼
                OpenAI Realtime API          Go application server
                                             ├── Static frontend
                                             ├── Client-secret minting
                                             ├── Question bank
                                             ├── Evidence persistence
                                             └── Completion persistence
```

## 5. Technology choices

| Layer | Technology | Responsibility |
|---|---|---|
| Frontend | React and TypeScript | Interview configuration and live interview experience |
| Editor | Monaco Editor | Candidate code editing and revision tracking |
| Whiteboard | tldraw | Candidate diagrams, labels, and visual reasoning |
| Code runner | Web Worker | Browser-isolated checks and console capture |
| Voice/agents | OpenAI Agents SDK | Realtime session, agents, tools, handoffs and tracing |
| Media | Browser Media APIs | Camera preview, microphone access and local WebM recording |
| Voice transport | WebRTC | Low-latency audio between browser and OpenAI Realtime |
| Backend | Go standard library | Secure API boundary, static assets and local persistence |
| Question bank | JSON | Server-controlled prompt, starter code, checks, and demo fixtures |
| Persistence | JSON Lines | Hackathon-stage evidence and completion event storage |

## 6. Logical components

### 6.1 Interview lobby

Collects:

- Candidate name
- Target role
- Time limit in minutes
- Recruiter-defined rubric

The default duration is five minutes. The lobby obtains camera and microphone consent before starting the session.

### 6.2 Interview workspace

Contains:

- Remaining-time countdown
- Current agent name
- Server-fetched problem statement
- Monaco TypeScript editor
- tldraw whiteboard with persistent tab state
- Code checks and console output
- Candidate camera preview
- Agent speaking/listening status
- Agent tool-call activity
- Mute, camera and end controls

### 6.3 Agents SDK orchestration

The browser owns the `RealtimeSession`. Function tools therefore run in the browser and call Go when privileged or durable work is required.

```text
Introduction Agent
   │
   │ mandatory ordered tools
   ├── 1. get_interview_context
   ├── 2. fetch_coding_question
   └── 3. read_interview_rubric
   │
   ▼ handoff
Coding Interviewer
   ├── get_current_code
   ├── get_current_workspace
   ├── get_execution_results
   ├── read_interview_rubric
   ├── record_interview_evidence
   │
   ▼ optional handoff
Reflection Agent
   ├── get_current_code
   ├── get_current_workspace
   ├── get_execution_results
   ├── read_interview_rubric
   └── record_interview_evidence
```

#### Introduction Agent

- Calls the mandatory setup tools in order.
- Addresses the candidate by name.
- States the time limit.
- Presents the question without adding solution guidance.
- Asks the candidate to explain their understanding.
- Hands control to the Coding Interviewer.

#### Coding Interviewer

- Conducts the main assessment.
- Probes requirements, assumptions, approach, invariants, edge cases, complexity and testing strategy.
- Reads current Monaco content before discussing implementation details.
- Records evidence grounded in candidate speech or code.
- Does not provide or validate solutions.

#### Reflection Agent

- Handles final complexity, tradeoff and edge-case discussion.
- Challenges unsupported correctness or complexity claims.
- Records final evidence.
- Separates browser test results from model judgment.

### 6.4 Go application server

Responsibilities:

- Serve the embedded production frontend.
- Load private configuration from `.env`.
- Use `OPENAI_API_KEY` to mint short-lived Realtime client secrets.
- Read questions and checks from the local JSON question bank.
- Store final tldraw scenes, summaries, and PNGs as private runtime artifacts.
- Validate and append evidence events.
- Validate and append interview-completion events.
- Keep privileged credentials out of browser bundles.

The earlier manual WebRTC and local Codex CLI paths remain available as development fallbacks but are not the primary interview path.

## 7. Tool contracts

### 7.1 `get_interview_context`

Purpose: mandatory first setup tool.

Returns:

```json
{
  "candidate": "Alex Morgan",
  "role": "Software Engineer",
  "durationMinutes": 5,
  "instruction": "Introduce the timed coding interview."
}
```

### 7.2 `fetch_coding_question`

Purpose: mandatory second setup tool.

Flow:

```text
Agent tool → GET /api/interview/question → questions/default.json
```

Returns the question identifier and statement. The result also updates the visible question panel.

### 7.3 `read_interview_rubric`

Purpose: mandatory third setup tool and reusable assessment tool.

Returns the current recruiter rubric from React state. The agent must not invent criteria that are absent from the configured rubric or system safety policy.

### 7.4 `get_current_code`

Purpose: give the active agent an exact code snapshot.

Returns:

```json
{
  "language": "typescript",
  "revision": 17,
  "reason": "Inspect the loop invariant",
  "code": "function firstNonRepeatingCharacter(...) { ... }"
}
```

### 7.5 `get_current_workspace`

Purpose: give the active agent one synchronized view of the candidate's code and visual reasoning.

Returns exact code, code revision, whiteboard revision, and a compact tldraw scene summary. The browser separately attaches a whiteboard PNG to the Realtime turn when the board is non-empty.

### 7.6 `get_execution_results`

Purpose: return visible pass counts, failures, console output, and the code revision from the latest browser run.

### 7.7 `record_interview_evidence`

Purpose: persist a concrete rubric-relevant observation.

Accepted categories:

- `problem_understanding`
- `approach`
- `communication`
- `correctness`
- `complexity`
- `debugging`

Each event includes observation text, confidence, session ID and the current code revision.

## 8. Primary interview sequence

```text
Candidate configures interview
          │
          ▼
Browser requests camera/microphone
          │
          ▼
POST /api/realtime/token
          │
          ▼
Go mints short-lived client secret
          │
          ▼
Agents SDK opens RealtimeSession over WebRTC
          │
          ▼
Introduction Agent executes setup tools
          │
          ▼
Question appears and is spoken
          │
          ▼
Handoff to Coding Interviewer
          │
          ├── candidate speaks
          ├── candidate edits Monaco
          ├── agent inspects code
          └── agent records evidence
          │
          ▼
Optional Reflection Agent handoff
          │
          ▼
Timer or candidate ends interview
          │
          ▼
Graceful completion sequence
```

## 9. Timer and graceful shutdown

### 9.1 Countdown

The frontend initializes `remaining` from the configured duration and decrements it once per second. The default is 300 seconds.

### 9.2 Expiration guard

When `remaining` reaches zero, a ref-based guard ensures the shutdown path runs only once.

### 9.3 Shutdown sequence

```text
remaining reaches zero
        │
        ▼
endGracefully("time_limit")
        │
        ├── mark session as ending
        ├── mute microphone input
        ├── interrupt current response
        ├── POST /api/interview/complete
        └── send final system message to active agent
                    │
                    ▼
         agent says time is up
                    │
                    ▼
          audio_stopped event
                    │
                    ▼
          RealtimeSession.close()
                    │
                    ├── stop camera/microphone
                    ├── stop MediaRecorder
                    └── show completion screen
```

A ten-second fallback closes the session if final audio does not start or finish. Manual termination follows the same flow with reason `manual`.

## 10. Backend API surface

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Backend health check |
| `POST` | `/api/realtime/token` | Mint a short-lived Realtime client secret |
| `GET` | `/api/interview/question` | Load the active question text file |
| `POST` | `/api/interview/evidence` | Persist a rubric evidence event |
| `POST` | `/api/interview/complete` | Persist interview completion |
| `POST` | `/api/realtime/session` | Legacy/manual WebRTC SDP setup |
| `POST` | `/api/local-voice/chat` | Local Codex CLI voice fallback |

## 11. Data model

### 11.1 Evidence event

```json
{
  "sessionId": "uuid",
  "category": "complexity",
  "observation": "Candidate derived linear time from one full traversal.",
  "confidence": 0.9,
  "codeRevision": 17,
  "createdAt": "RFC3339 timestamp"
}
```

Stored in `runtime/evidence.jsonl`.

### 11.2 Completion event

```json
{
  "sessionId": "uuid",
  "reason": "time_limit",
  "elapsedSeconds": 300,
  "createdAt": "RFC3339 timestamp"
}
```

Stored in `runtime/completions.jsonl`.

## 12. Interview policy and guardrails

The agent is configured as a neutral assessor rather than a coach.

It must not:

- Supply code, pseudocode or a completed solution.
- Name the intended algorithm or recommend a data structure.
- Provide leading examples, correction steps or partial answers.
- Validate an approach when asked whether it is correct.
- Answer unrelated questions.
- Praise, reassure, encourage or coach the candidate.
- Score appearance, accent, emotion, confidence or personality.

It may:

- Clarify the literal problem statement without revealing strategy.
- Ask neutral diagnostic questions.
- Challenge unsupported claims.
- Ask the candidate to test or explain their own reasoning.
- Record evidence based on speech and code.

The policy is prompt-enforced in the current version. A production version should add explicit input/output guardrails and automated policy evaluations.

## 13. Security and privacy

- The permanent OpenAI API key exists only in `.env` on the Go server.
- The browser receives only a short-lived Realtime client secret.
- `.env` is excluded from source control.
- API responses are marked `no-store`.
- Evidence and completion payloads have request-size limits and strict JSON decoding.
- Evidence files are created with owner-only permissions.
- Camera and microphone access require explicit browser permission.
- The recording remains in browser memory until the candidate downloads it.
- Tool descriptions explicitly prohibit sensitive or appearance-based assessment.

## 14. Failure handling

| Failure | Current behavior |
|---|---|
| Camera or microphone denied | Show lobby/interview error and do not establish media |
| Realtime token rejected | Show secure generic error; detailed provider error remains server-side |
| Question file unavailable | Question tool fails and reports that the bank is unavailable |
| Evidence write fails | Tool returns an error to the agent |
| Realtime session error | Display agent error state |
| Final audio never completes | Force-close after ten seconds |
| Page closes unexpectedly | Browser teardown closes agent and media resources |

## 15. Observability

- The UI displays the active specialist agent.
- Tool start and completion events are visible in the tool activity panel.
- Agents SDK tracing uses workflow name `Automated Coding Interview`.
- The interview session ID is used as the trace group ID.
- Agent handoffs, tool calls and model generations are available through Agents SDK traces.
- Go logs backend/provider errors without sending sensitive details to the browser.

## 16. Scalability evolution

The current JSONL persistence and local JSON question bank are appropriate for a single-machine hackathon demo. A production evolution would introduce:

```text
Go instances
    │
    ├── PostgreSQL: interviews, rubrics, evidence and reports
    ├── Object storage: recordings and whiteboard artifacts
    ├── Redis: active session state and idempotency
    ├── Queue: asynchronous final evaluation
    └── Secret manager: OpenAI credentials
```

Additional production work:

- User and recruiter authentication
- Tenant isolation
- Signed recording uploads
- Database-backed question versioning
- Idempotent evidence and completion writes
- Server-side authorization for each interview session
- Rate limiting and abuse prevention
- Retention and deletion controls
- Consent and jurisdiction-specific recording notices
- Automated prompt and rubric evaluations
- Structured final-report generation

## 17. Key design decisions

1. **Agents SDK in the browser:** enables direct Realtime media, local editor tools and visible agent lifecycle events.
2. **Go as secure control plane:** protects the API key and owns durable server-side resources.
3. **Explicit tool access:** the model reads question, rubric, code, execution results, and scene summaries through auditable calls.
4. **Specialist handoffs:** separates introduction, coding assessment and reflection behavior while retaining one voice session.
5. **Browser code runner:** gives visible test evidence while keeping the prototype self-contained.
6. **Audio-event-driven shutdown:** prevents cutting off the final time-up announcement.
7. **JSONL persistence:** provides a transparent, inspectable event trail for the prototype.

## 18. Proactive workspace review

The browser runs a 15-second workspace monitor after the Realtime session connects. It compares code and whiteboard revisions with the last reviewed pair. It triggers a review only when:

- Code or whiteboard content changed.
- Drawing stopped for at least two seconds.
- The interview is not ending.
- The active agent is listening rather than speaking or thinking.
- No review is already active.

The browser attaches a bounded tldraw PNG when the board is non-empty. The trigger instructs the active agent to call `get_current_workspace` for exact code and a structured scene summary. The agent asks one terse question only when the change exposes a likely defect, contradiction, unexplained decision, or missing rubric signal. Unchanged work does not create model calls.

The interviewer may challenge assumptions, request counterexamples and test edge cases indirectly. It must not deceive the candidate, invent constraints or contradict the supplied problem.

## 19. Evaluation Manager

The implemented Evaluation Manager is a bounded backend workflow rather than another voice agent:

```text
Finished React screen
        │ POST question, rubric, final code, whiteboard, session metadata
        ▼
POST /api/interview/evaluate
        ├── Load session evidence from runtime/evidence.jsonl
        ├── Store final whiteboard artifacts in runtime/whiteboards/
        ├── Build strict assessment prompt
        ├── Call Codex through POST /v1/responses
        ├── Validate output against JSON Schema
        ├── Persist runtime/evaluations.jsonl
        └── Return structured report to React
```

The report includes overall score, recommendation, summary, per-category score and weight, concrete evidence, evidence gaps, strengths, risks and limitations. Browser test outcomes are verified artifacts. Other correctness claims remain model judgments. Failed evaluations do not discard the completed interview and can be retried from the finished screen.

The evaluation model is configured by `OPENAI_EVALUATION_MODEL` and defaults to `gpt-5.2-codex`.

## 20. Future evaluation improvements

- Capture a consented transcript and link evidence to exact utterances.
- Store stable evidence IDs and question/rubric versions.
- Calibrate scores against human-reviewed benchmark interviews.
- Add automated checks for verbosity, hint leakage and unsupported claims.
- Move JSONL artifacts to a transactional database with access controls.
