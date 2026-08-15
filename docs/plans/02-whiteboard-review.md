# Plan 02 — Whiteboard and multimodal workspace review

## 1. Goal

Add an optional tldraw whiteboard beside the existing Monaco coding workspace.

During an interview, the Realtime interviewer reviews changed code and whiteboard content every 15 seconds. A review runs only when an artifact changed, the drawing is stable, and the agent is idle. A review may remain silent when it finds no useful rubric gap.

At interview completion, the final evaluator receives the final code, final whiteboard image, a compact scene summary, the rubric, and recorded evidence.

## 2. Locked decisions

- Add **Code** and **Whiteboard** tabs inside the current coding column.
- Keep whiteboard use optional.
- Do not capture the full browser screen, camera, or browser chrome.
- Send Monaco code as exact text.
- Send tldraw as a PNG plus a compact scene summary.
- Run the review scheduler every 15 seconds.
- Skip unchanged revisions.
- Wait two seconds after the latest drawing change.
- Skip reviews while the agent is speaking, thinking, connecting, or ending.
- Ask at most one short question per review.
- Do not force a question from every review.
- Do not reduce a score for an unused whiteboard unless the rubric requires diagramming.
- Keep `gpt-realtime-2.1-mini` for live interviewing.
- Keep the configured Responses API evaluation model. The local default is `gpt-5.2-codex`.

## 3. Repository paths

### Existing files to change

- `web/package.json` and `web/package-lock.json`
- `web/src/App.tsx`
- `web/src/styles.css`
- `web/src/useInterviewAgent.ts`
- `cmd/server/main.go`
- `README.md`
- `PRODUCT_SPEC.md`
- `HLD.md`

### New files

- `web/src/WhiteboardPanel.tsx`
- `web/src/whiteboard/types.ts`
- `web/src/whiteboard/scene.ts`

## 4. Candidate workspace

1. Install `tldraw`.
2. Render tldraw inside `WhiteboardPanel.tsx`.
3. Add Code and Whiteboard tabs above the current editor area.
4. Preserve Monaco and tldraw state while switching tabs.
5. Capture document-scoped shape changes through the tldraw store.
6. Increment `whiteboardRevision` only when the scene changes.
7. Track the last scene change time.
8. Export a bounded PNG data URL from the current scene.
9. Build a compact summary containing visible text, shape types, arrows, groups, and positions.

## 5. Live workspace review

Replace the current code-only scan with one workspace scheduler.

Each 15-second tick checks:

1. The interview is active.
2. The Realtime agent is listening.
3. No review is already active.
4. Code or whiteboard revision changed.
5. The whiteboard has remained unchanged for two seconds.

When eligible:

1. Add a whiteboard image to the Realtime session when the board changed.
2. Send a review message containing revision metadata.
3. Require the active agent to call `get_current_workspace`.
4. Return exact code, code revision, whiteboard revision, and scene summary.
5. Ask one question only for a meaningful defect, unexplained decision, contradiction, or rubric gap.
6. Record concrete evidence through the existing evidence tool.
7. Mark the revision pair as reviewed.

The existing `get_current_code` tool remains available for direct code checks. The new workspace tool gives the agent a synchronized view across both artifacts.

## 6. Final evaluation

Extend the evaluation request with:

- `whiteboardRevision`
- `whiteboardSummary`
- `whiteboardImage`

Use a dedicated request-size limit for evaluation. Do not increase limits for the other endpoints.

Build the Responses API request as multimodal content:

1. One `input_text` item containing candidate metadata, question, rubric, final code, scene summary, and evidence.
2. One `input_image` item when a non-empty whiteboard image exists.

Update the evaluator instructions:

- Treat the whiteboard as supporting evidence.
- Cite only visible labels, relationships, and explanations.
- Do not infer intent from an ambiguous sketch.
- Do not penalize an empty board unless the rubric requires one.
- Note when an image is missing or unreadable.
- Resolve conflicts between code and diagrams by describing the conflict.

Keep the current strict report schema and retry behavior.

## 7. Failure behavior

- tldraw load failure: keep the Code tab usable and show a whiteboard error.
- PNG export failure: continue the interview and send the scene summary.
- Realtime image failure: continue with code and scene summary.
- Busy agent: defer review until a later tick.
- Evaluation image validation failure: return a retryable evaluation error.
- Blank whiteboard: send no image and record no penalty.

## 8. Privacy and fairness

- Explain that code and whiteboard artifacts are shared with OpenAI for interviewing and evaluation.
- Never capture the camera frame as an assessment input.
- Never capture unrelated screen content.
- Clear whiteboard memory when the session resets.
- Store runtime artifacts as private interview data.
- Use whiteboard content only for rubric-relevant technical evidence.

## 9. Verification

### Automated

- `make check`
- `cd web && npm run build`
- TypeScript tests for scene summaries and scheduler decisions when a test harness is added.
- Go tests for multimodal evaluation payload validation when backend tests are added.

### Browser

1. Start an interview and switch between Code and Whiteboard.
2. Confirm both artifacts preserve their state.
3. Change code only and confirm one review occurs.
4. Change the whiteboard only and confirm one image review occurs.
5. Leave both unchanged and confirm no review occurs.
6. Draw continuously and confirm no review occurs until drawing stops.
7. Confirm a review can remain silent.
8. End the interview and confirm evaluation completes with the final whiteboard.
9. Repeat with an empty whiteboard and confirm no score penalty.
10. Check desktop and narrow layouts for clipping and blocked controls.

## 10. Acceptance criteria

1. Code and Whiteboard tabs preserve content.
2. The whiteboard supports text, shapes, arrows, and freehand drawing.
3. A workspace review runs no more than once every 15 seconds.
4. Unchanged work causes no model call.
5. A busy agent causes no overlapping review.
6. Each review asks at most one question.
7. Full-screen and camera images never reach the models.
8. The final evaluator receives the final code, scene summary, and whiteboard PNG.
9. A blank whiteboard causes no default penalty.
10. Existing code execution, recording, timer, and evaluation retry flows still work.
11. Frontend typecheck, frontend build, and Go tests pass.

## 11. Out of scope

- Collaborative whiteboarding between multiple users.
- Remote persistence or a database.
- Screenshot analysis of the camera or full browser.
- Automatic scoring based on drawing quality or visual polish.
- Whiteboard templates or an AI that edits the candidate's drawing.
