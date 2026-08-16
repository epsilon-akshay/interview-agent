# Plan 04 — Latency and input capture

Status: implemented.

## Goal

The planner prepares a short question before its dispatch gate opens. It also captures every approved technical input needed for live review and final evaluation.

## Input sources

| Source | Live planner | Durable record | Final evaluation |
|---|---|---|---|
| Candidate code | Exact text and revision | Final immutable artifact | Loaded by the server |
| Browser checks | Latest run identity and output | One `code_execution` event per run | Loaded by the server |
| Whiteboard | Revision and scene summary; revision-matched PNG for voice | Final immutable scene, summary, and PNG | Loaded by the server |
| Candidate speech | Deduplicated transcript turn | Sent only in evaluation request | Included by the server |
| Interviewer speech | Accepted assistant transcript turn | Sent only in evaluation request | Included by the server |

Camera frames, browser chrome, and unrelated screen content are not planner or evaluation inputs.

## Transcript capture

Candidate speech comes from `conversation.item.input_audio_transcription.completed` and is deduplicated by item ID. Accepted assistant text comes from session history and commits after its response completes.

A guardrail-rejected assistant item is removed from history and marked rejected. It never reaches the transcript, planner, or evaluation.

No transcript is invented for AI checks. A missing transcript becomes an evidence gap.

## Latency path

The signal bus ticks once per second. During the last ten seconds before the 45-second question gate, it can precompute one analyst result. The result can be a valid question or null. Either result consumes the one attempt for that fingerprint and gate window.

A finished question enters the text UI directly in AI checks. In voice mode, the browser sends one director instruction containing the exact validated question. No extra question-fetch tool turn sits on the delivery path.

The queue accepts no second question while one delivery remains unconfirmed.

## Freshness around asynchronous work

The planner snapshots its complete external-input fingerprint before analysis and every awaited evidence persistence. It rebuilds the fingerprint afterward. It also reruns all timing and activity gates.

Any code, whiteboard, run, transcript, timing, rubric coverage, observation, asked-question, stage, or status change discards the result. Late results after stop create no evidence, activity, or question.

## Whiteboard image cache

Live PNG export runs outside the question path. A cache entry includes its whiteboard revision. It can be used only when that revision still matches.

Final capture does not trust an older preview. It snapshots the revision before scene and PNG export, checks the revision after both exports, retries a bounded number of times, and keeps the newest result.

## Evaluation boundary

The browser sends only:

```json
{
  "sessionId": "0123456789abcdef0123456789abcdef",
  "transcript": []
}
```

The server loads code, whiteboard, test evidence, prepared question, rubric, identity, and source version. It owns names, weights, and score arithmetic.

## Models

- Realtime defaults to `gpt-realtime-2.1-mini`.
- Evaluation defaults to `gpt-5.6-terra`.
- Observer and orchestrator values fall back to the evaluation model when blank.

## Verification

```bash
make check
make browser-test
```

Tests cover deferred-promise invalidation, active typing and drawing, delivery confirmation, transcript rejection, ending during slow completion, evidence payload shape, and final artifact persistence.
