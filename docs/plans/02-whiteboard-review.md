# Plan 02 — Whiteboard and multimodal review

Status: implemented.

## Purpose

An enabled tldraw workspace lets a candidate explain technical reasoning with text, shapes, arrows, and freehand drawing. Code and Whiteboard tabs keep their state when the candidate switches between them.

A disabled whiteboard removes its UI, agent tools, planner input, and final scene data.

## Local assets

The production frontend bundles tldraw code, fonts, icons, and related assets.

Local HTTP use needs no tldraw production license key. Hosted HTTPS use needs a valid `VITE_TLDRAW_LICENSE_KEY`.

## Live observation

The browser tracks:

- `whiteboardRevision`
- the latest change time
- element count
- a compact scene summary
- a revision-keyed PNG cache

The planner waits for two seconds of whiteboard quiet. It reads a scene summary. Voice can receive a PNG only when the board is non-empty and the cached image matches the current revision.

The whiteboard is evidence of visible technical reasoning. It is not proof that code works. An empty board creates no penalty unless the prepared rubric requires a diagram.

## Final capture

Completion captures a current, stable scene before it records the terminal event.

1. Read the current revision.
2. Export the scene and PNG.
3. Read the revision again.
4. Accept the result only when both revisions match.
5. Retry a bounded number of times after a concurrent edit.
6. Keep the newest revision. Never overwrite it with an older capture.

A preview cache can be reused only at the same revision.

## Artifact contract

`POST /api/interview/artifacts` accepts:

```json
{
  "sessionId": "0123456789abcdef0123456789abcdef",
  "codeRevision": 17,
  "code": "export function solve() {}",
  "whiteboardRevision": 4,
  "whiteboardSummary": "One client points to one service.",
  "whiteboardScene": "{...}",
  "whiteboardImage": "data:image/png;base64,..."
}
```

Scene and image may be empty. Storage makes no AI call. The first payload returns `201`, an identical retry returns `200`, and a different payload returns `409`.

Evaluation does not accept these artifacts from the browser. It accepts only session ID and transcript. The server loads the immutable artifact set.

## Privacy

The app sends the whiteboard only through explicit workspace, artifact, and evaluation boundaries. It never captures the full screen, browser chrome, or camera frame as a whiteboard input.

## Failure behavior

- A live PNG export failure leaves the text scene summary available.
- A final capture failure blocks completion and shows a retry action.
- A final artifact write failure does not produce a saved-success claim.

## Verification

```bash
make check
make browser-test
```
