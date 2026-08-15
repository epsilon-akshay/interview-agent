# Signal Interview — Product Specification

## 1. Product summary

Signal Interview is an automated, timed coding interviewer. It combines a live voice interviewer, browser code editor, whiteboard, rubric-driven evidence collection, proactive workspace observation, and a structured post-interview evaluation.

The product is intended for screening and hackathon demonstration. It supports human hiring decisions; it does not make an autonomous employment decision.

## 2. Problem

Technical screens require an interviewer to present a consistent problem, watch implementation progress, test conceptual understanding, avoid giving accidental hints, and write an evidence-based rubric afterward. This is time-consuming and varies by interviewer.

Signal Interview standardizes this workflow while preserving an interactive conversation.

## 3. Users

- Candidate: solves the problem, writes code, and explains decisions.
- Interview owner: configures the role, duration, and rubric.
- Reviewer: reads the final evidence-backed evaluation and recording.

## 4. Goals

- Conduct a complete local video and voice coding interview.
- Ask only problem- and rubric-relevant questions.
- Proactively inspect meaningful code and whiteboard changes without waiting for the candidate.
- Keep interviewer speech terse, demanding, and non-coaching.
- Produce a readable, evidence-backed final rubric report.
- Separate verified browser test results from model judgment.

## 5. Non-goals

- Production-grade sandboxing of untrusted candidate code.
- Automated hiring or rejection without human review.
- Judging appearance, accent, personality, emotion, or protected traits.
- Providing tutoring, hints, solutions, or model answers.
- Misleading the candidate or inventing problem constraints.

## 6. Core experience

### 6.1 Setup

The interview owner provides candidate name, role, time limit, and rubric. The default duration is five minutes. Start is blocked if candidate name or rubric is empty or media permissions fail.

### 6.2 Introduction

Before substantive speech, the Introduction Agent must retrieve interview context, fetch the problem from the server question bank, and read the configured rubric. It states the candidate name and time limit, presents the problem, asks for the candidate's understanding, and hands off.

### 6.3 Interview

The Coding Interviewer asks one short question at a time, normally under 12 words. It does not explain its question, repeat the candidate's response, use filler, praise, reassure, coach, or answer unrelated questions.

Questions must derive from the problem, current code, or rubric. Valid challenge techniques include asking for proof, requesting a counterexample, questioning an assumption, testing an invariant, or introducing a valid edge case. The interviewer must not state false facts, invent requirements, or deliberately deceive the candidate.

### 6.4 Candidate workspace and proactive review

The candidate can switch between a Monaco editor and a tldraw whiteboard without losing either artifact. The whiteboard supports text, shapes, arrows, and freehand drawing. Code can run against visible browser-isolated checks.

Every 15 seconds, the browser checks code and whiteboard revisions. When either changed and the agent is listening, it sends exact code, a compact scene summary, and a bounded whiteboard PNG. The interviewer asks one question only when the change exposes an unexplained choice, contradiction, likely defect, or missing rubric signal. Unchanged revisions, active drawing, and busy agent turns are skipped.

This mechanism observes only Monaco and tldraw artifacts. It does not capture video, browser chrome, or unrelated screen content.

### 6.5 Completion

At zero seconds, the frontend prevents duplicate timer handling, marks the session as ending, mutes candidate audio, interrupts current output, records completion on the backend, and asks the active agent to say only that time is up. It closes after final audio or a ten-second fallback timeout. Manual ending follows the same flow.

### 6.6 Evaluation Manager

After the voice session closes, the frontend sends candidate metadata, problem, rubric, final code, final whiteboard scene, scene summary, and PNG to the backend. The backend loads session evidence and calls a Codex model through the Responses API with a strict JSON schema.

The report contains:

- Overall score from 0–100
- Recommendation: strong hire, hire, mixed, no hire, or insufficient evidence
- Concise summary
- Per-category score, weight, supporting evidence, and evidence gaps
- Strengths, risks, and assessment limitations

Missing evidence lowers confidence and may result in `insufficient_evidence`. The report treats browser test outcomes as verified when present. It treats other correctness claims as model judgment. An empty whiteboard causes no penalty unless the rubric requires diagramming.

## 7. Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | Capture camera and microphone with browser permission. |
| FR-2 | Display candidate video and record the local media stream. |
| FR-3 | Provide a Monaco TypeScript editor with revision tracking and browser-isolated checks. |
| FR-4 | Establish a Realtime speech-to-speech session using an ephemeral token. |
| FR-5 | Load the question from `questions/default.json` through a tool call. |
| FR-6 | Read the UI rubric through a tool call before substantive interviewing. |
| FR-7 | Inspect current editor text, execution results, and whiteboard summary through explicit tools. |
| FR-8 | Persist rubric evidence with category, observation, confidence, and revision. |
| FR-9 | Review changed code or whiteboard content every 15 seconds and avoid overlapping agent turns. |
| FR-10 | Enforce a configurable timer and graceful terminal sequence. |
| FR-11 | Generate and render a schema-validated final evaluation. |
| FR-12 | Allow evaluation retry without repeating the interview. |
| FR-13 | Preserve Code and Whiteboard tab content throughout an interview. |
| FR-14 | Send a whiteboard PNG to live and final multimodal evaluation only when the board is non-empty. |

## 8. Interview policy

The interviewer must:

- Stay within the supplied problem, code, and rubric.
- Ask one terse, precise question at a time.
- Prefer evidence-seeking questions over explanations.
- Record only observable technical evidence.
- Distinguish browser test evidence from model judgment.

The interviewer must not:

- Reveal an algorithm, data structure, code, pseudocode, partial solution, or leading hint.
- Validate whether the candidate is correct.
- Praise, reassure, apologize, or provide coaching.
- Assess appearance, accent, personality, confidence, or emotion.
- Manufacture ambiguity or lie to confuse the candidate.

## 9. Evaluation categories

The default rubric weights are:

- Problem understanding and clarifying questions: 20%
- Choice and explanation of approach: 25%
- Code quality and likely correctness: 25%
- Time and space complexity analysis: 15%
- Communication and response to feedback: 15%

Custom rubric text is supported. The Evaluation Manager must reflect configured criteria and must not invent new scored dimensions.

## 10. Success metrics

- 100% of substantive questions are traceable to the problem, code, or rubric in review samples.
- Median interviewer utterance is one sentence and under 12 spoken words after introduction.
- No overlapping workspace review starts while the agent is speaking or thinking.
- Every completed session returns a report or a visible retryable error.
- Every category score includes evidence or an explicit evidence gap.
- Zero hints, solutions, or unsupported runtime-correctness claims in policy evaluations.

## 11. Failure behavior

- Realtime token failure: remain on setup or show an interview error without exposing the API key.
- Question-bank failure: stop introduction and show the tool error.
- Evidence write failure: expose the tool failure; do not silently claim persistence.
- Evaluation failure: keep the completed interview and show a retry action.
- Final audio failure: force-close after ten seconds.
- Missing evidence: return a low-confidence or insufficient-evidence report, never fabricate observations.

## 12. Privacy and safety

- The Platform API key remains on the Go server; only an ephemeral Realtime secret reaches the browser.
- Local recordings remain in browser memory until saved or discarded.
- Runtime JSONL files and whiteboard artifacts contain private assessment data. They must not be committed or publicly shared.
- Camera frames and unrelated screen content are excluded from model inputs.
- Production deployment requires consent, retention controls, authentication, authorization, encryption, auditability, and applicable employment-law review.

## 13. Acceptance criteria

1. Starting an interview presents the server-controlled problem after all mandatory setup tools complete.
2. Code and Whiteboard tabs preserve their content.
3. Editing code or drawing causes a `get_current_workspace` review on the next eligible 15-second cycle.
4. Unchanged workspace content does not cause repeated review prompts.
5. Interviewer answers remain terse and never provide a hint or solution.
6. Timer expiry produces one time-up announcement and one completion record.
7. The finished screen renders overall and category scores with evidence and gaps.
8. Evaluation failure presents a retry button and does not lose the recording link.
9. Final evaluation receives the code, test evidence, whiteboard summary, and whiteboard PNG.
10. An empty whiteboard causes no default penalty.

## 14. Future scope

- Transcript capture and evidence links to exact utterances
- Recruiter-managed question and rubric banks
- Shared or collaborative whiteboards
- Persistent database storage and authenticated reviewer portal
- Prompt-policy regression tests and calibrated evaluator benchmarks
- Human score overrides and reviewer notes
