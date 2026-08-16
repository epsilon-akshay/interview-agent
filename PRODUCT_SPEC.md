# Signal Interview — Product Specification

## 1. Product summary

Signal Interview is a timed technical interviewer. It combines a prepared interview guide, a code editor, browser checks, a whiteboard, optional voice, technical evidence, and an optional final rubric report.

The product supports human hiring decisions. It does not make an autonomous employment decision.

## 2. Users

- A candidate solves the problem and explains decisions.
- An interview owner configures the role, interview, workspaces, and rubric.
- A reviewer reads saved artifacts, evidence, recording, and any final report.

## 3. Goals

- Run a consistent interview from one reviewed setup.
- Ask only problem, workspace, transcript, and rubric-based questions.
- Avoid hints, solutions, praise, coaching, and unsupported verdicts.
- Preserve verified browser test facts separately from model judgment.
- Save final candidate work before recording completion.
- Let a reviewer retry failed evidence, completion, or evaluation writes.

## 4. Non-goals

- Production isolation for untrusted code.
- Automated hiring or rejection.
- Judging appearance, accent, personality, emotion, confidence, or protected traits.
- Tutoring, model answers, or misleading constraints.
- Public or multi-tenant deployment without more security controls.

## 5. Runtime modes

The developer test bar appears only when `INTERVIEW_DEVELOPER_MODE=true`.

| Mode | Candidate experience | AI and network behavior | Result |
|---|---|---|---|
| AI checks | Editor, whiteboard, and text planner questions | Uses preparation, planner, and evaluation models. No Realtime or media. | Saved facts and an evaluation report. |
| AI voice | Full spoken interview, editor, whiteboard, and local recording | Uses preparation, planner, Realtime, and evaluation. | Saved facts, recording download, and an evaluation report. |

The production frontend includes Monaco, Monaco workers, tldraw, fonts, and icons.

## 6. Core experience

### 6.1 Setup

The owner reviews a candidate name, role, interview type, five-minute default duration, question types, TypeScript workspace, channels, brief, and rubric. Behavioral interviews do not keep coding defaults. Later explicit owner edits remain where they are compatible.

The browser allocates a setup ID before its first upload. It uploads private files, then saves one immutable `InterviewSetup` v1 snapshot. A retry reuses the same ID and any successful phase.

The server creates one AI-prepared guide. It can fill missing job content. It cannot change identity, duration, interview type, workspace access, or explicit rubric weights.

An identical preparation retry returns the saved guide. A malformed saved guide returns `422`.

### 6.2 Startup

AI checks initializes its text planner. AI voice then gets media, reads model configuration, mints a short-lived token, and connects a muted Realtime session.

The interview screen and timer start only after the selected runtime is ready. Voice recording starts only after media and Realtime connection succeed. A startup failure closes the session, stops media, discards the recorder and recording URL, and keeps the setup screen visible.

### 6.3 Voice introduction

Application code forces these tools in order:

1. interview context
2. prepared question
3. prepared rubric

Every tool-choice change waits for a Realtime session acknowledgement. The Introduction Agent cannot begin substantive speech until all three tools succeed.

The Introduction Agent remains active until the approved primary question finishes playback. The app then switches to the Interview Conductor, waits for automatic tool choice with conductor tools, unmutes candidate input, and starts the 45-second planner clock.

Out-of-order calls do not advance startup. A bounded timeout closes the session once and shows a retryable error.

### 6.4 Interview policy

The interviewer asks one short question at a time. Planner questions contain one question mark at most and no more than 12 words.

Questions can ask for a proof, counterexample, assumption, invariant, edge case, test, or tradeoff. They must derive from the approved prompt, current workspace, transcript, or rubric.

The interviewer must not:

- reveal code, pseudocode, a solution, or a leading hint
- name a solution algorithm or data structure absent from the approved prompt
- praise, reassure, coach, prescribe, or apologize
- claim that an unverified approach is correct or incorrect
- judge personality, appearance, accent, emotion, confidence, hesitation, uncertainty, friendliness, or hostility
- invent a requirement or deceive the candidate

One shared local validator applies these rules to planner questions, planner findings, and Realtime output. Rejected assistant output stays out of the transcript, planner, and evaluation.

### 6.5 Workspace and planner

The candidate can switch between enabled Code and Whiteboard tabs without losing content. Disabled workspaces expose no candidate UI, agent tool, or planner input for that workspace. Server-private solution and buggy fixtures never appear in the candidate UI or prepared response.

A one-second signal bus watches code, whiteboard, tests, transcript, timing, rubric coverage, asked questions, stage, and agent status. A question can dispatch only when:

- 45 seconds passed since the most recently confirmed question delivery
- code was quiet for three seconds
- the whiteboard was quiet for two seconds
- the agent is listening
- more than 20 seconds remain

A blocked signal remains pending. Analysis does not run during speech, thought, typing, or drawing.

The planner invalidates work after any material input change. It checks a complete input fingerprint and all five gates after every awaited model or evidence operation. A stale result creates no question, evidence, or activity. A null precompute still counts as the one attempt for that gate window.

### 6.6 Evidence

One browser test run creates one durable `code_execution` event. Planner evidence uses an exact prepared rubric criterion ID. Every evidence request contains:

- `sessionId`
- a stable 32-character lowercase-hex `eventId`
- `category`
- a nonempty `observation`
- `confidence` from zero to one
- analyzed `codeRevision`
- analyzed `whiteboardRevision`

A retry sends the exact ID and payload. Rubric coverage increases only after the server acknowledges persistence. A failed write shows a retry action.

### 6.7 Completion

Manual and timer endings use one shared guard. The first request fixes reason and elapsed time. A retry sends that exact payload.

The browser first captures the latest code and a revision-stable whiteboard. It stores immutable final artifacts. It then records completion. A success claim appears only after both writes succeed.

Whiteboard capture compares its revision before and after scene and PNG export. It retries a bounded number of times and never replaces newer data with an older capture.

Voice mode then plays one closing line when bootstrap already finished. Ending during bootstrap closes at once. AI checks does not wait for audio.

### 6.8 Evaluation

AI checks and AI voice evaluate after artifacts and completion exist.

The browser sends only `sessionId` and transcript. The server loads candidate identity, the prepared question and rubric, evidence, completion, and immutable final code and whiteboard. The browser cannot replace those inputs.

The model returns judgment fields for each prepared criterion. The server restores names and weights, rejects missing or invented criteria, and calculates the weighted score. Browser test outcomes remain verified facts. Other correctness claims remain model judgments.

An identical retry returns the stored report without another model call. A retry with a different transcript returns `409`.

## 7. Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | Save one versioned setup and prepared guide before an interview starts. |
| FR-2 | Keep uploads, verified fixtures, prepared guides, artifacts, and reports private on the server. |
| FR-3 | Support AI checks and AI voice with the boundaries in this specification. |
| FR-4 | Provide enabled Monaco and tldraw workspaces with revision tracking. |
| FR-5 | Run TypeScript checks in a browser worker and persist one fact per run. |
| FR-6 | Enforce the ordered Realtime bootstrap and confirmed playback handoff. |
| FR-7 | Gate proactive questions behind all timing, activity, and agent-state checks. |
| FR-8 | Validate every planner and Realtime output through one safety policy. |
| FR-9 | Persist retry-safe evidence with code and whiteboard revisions. |
| FR-10 | Persist current final artifacts before completion. |
| FR-11 | Keep one exact completion payload across retries. |
| FR-12 | Accept only session ID and transcript from the browser for evaluation. |
| FR-13 | Assemble rubric metadata and the weighted score on the server. |
| FR-14 | Return a stored evaluation for an identical retry. |

## 8. Security and privacy

- The server defaults to `127.0.0.1:8080`.
- A key-bearing server needs `INTERVIEW_ALLOW_UNSAFE_NETWORK_BIND=true` for a non-loopback bind.
- Browser mutation requests must have the same origin.
- Paid endpoints have concurrency and rate protection.
- The permanent Platform API key stays on the server.
- Runtime directories and files use owner-only permissions before writes.
- Agents SDK tracing is disabled.
- Local recordings remain in browser memory until downloaded or discarded.
- Runtime data must not be committed or shared.

The app has no user authentication. The unsafe network flag is not a production deployment mode.

Local HTTP use needs no tldraw production license key. Hosted HTTPS use needs a valid `VITE_TLDRAW_LICENSE_KEY`.

## 9. Failure behavior

- Setup or preparation failure keeps the setup screen and retained startup progress.
- Media, config, token, or connection failure rolls back all partial voice state.
- Bootstrap timeout closes once and shows a retryable startup error.
- Evidence failure leaves coverage unchanged and shows a retry action.
- Artifact or completion failure keeps the exact pending payload and shows a retry action.
- Evaluation failure keeps the completed interview and shows a retry action.
- Missing evidence creates an explicit gap. It does not create an invented observation.

## 10. Success measures

- Every substantive question traces to approved interview input.
- No planner or voice output leaks a hint, solution, coaching, unsupported verdict, or personal judgment in policy tests.
- Active typing or drawing prevents a proactive question.
- One test run produces one durable fact.
- A finished claim always follows acknowledged artifact and completion writes.
- Every scored criterion contains concrete evidence or an explicit gap.

## 11. Acceptance criteria

1. Startup retries reuse one setup ID and successful phases.
2. Voice bootstrap forces context, question, and rubric in order.
3. Candidate input stays muted until the primary question completes and conductor configuration is acknowledged.
4. Code and whiteboard content survive tab changes.
5. Disabled workspaces remove their UI, tools, and planner data.
6. A question dispatches only after all five gates pass.
7. Material changes discard stale analysis before evidence or question creation.
8. Unsafe analyst or Realtime output never enters the transcript or evaluation.
9. One run creates one retry-safe evidence event.
10. Ending stores the latest code and whiteboard before completion.
11. Completion races create one terminal record and one truthful finished state.
12. Evaluation rejects browser-supplied artifacts or rubric fields.
13. An identical evaluation retry makes no second provider call.
14. Removed chat, local question, and manual Realtime session routes return `404`.

## 12. Future scope

- Authentication and per-session authorization
- Tenant isolation
- Database and object storage
- Recording consent, retention, export, and deletion controls
- Production sandboxing for untrusted code
- Human score overrides and reviewer notes
- Automated policy and score calibration against human review
