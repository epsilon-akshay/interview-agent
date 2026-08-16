# Signal Interview

Signal Interview is a local technical interview application. It uses Go, React, Monaco, tldraw, the OpenAI Agents SDK, and OpenAI Realtime.

The server owns each saved setup, prepared question, rubric, final artifact, and score. The browser owns the live editor, whiteboard, media, transcript, and interview timing.

## Runtime modes

The developer test bar appears only when `INTERVIEW_DEVELOPER_MODE=true`.

| Mode | AI use | Media | Result |
|---|---|---|---|
| AI checks | Preparation, text planner, and evaluation | None | Shows planner questions as text and creates a final report. |
| AI voice | Preparation, planner, Realtime, and evaluation | Camera, microphone, and local recording | Runs the complete spoken interview and creates a final report. |

Monaco, its workers, tldraw, fonts, and icons ship in the production frontend.

## Lifecycle

```mermaid
flowchart LR
    A["Upload private inputs"] --> B["Save setup snapshot"]
    B --> C["Prepare guide once"]
    C --> D["Start selected runtime"]
    D --> E["Save final artifacts"]
    E --> F["Record completion"]
    F --> G["Evaluate interview"]
```

Setup IDs are allocated before the first upload. A retry reuses the same ID and completed setup phases.

AI voice acquires media, gets configuration and a short-lived Realtime token, then connects while candidate input stays muted. Bootstrap forces these tools in order:

1. `get_interview_context`
2. `fetch_interview_question`
3. `read_interview_rubric`

Each tool-choice update waits for a matching `session.updated` acknowledgement. The Introduction Agent remains active until the approved primary question finishes playback. The app then switches to the Interview Conductor with automatic tool choice, unmutes candidate input, and starts the 45-second planner clock.

Manual and timer endings share one retry-safe path. The browser captures the latest code and a revision-stable whiteboard. It stores those artifacts before completion. Every interview evaluates only after completion succeeds. Ending during voice bootstrap closes without waiting for a time-up audio fallback.

## Run locally

Requirements:

- Go 1.19 or newer
- Node.js 22.12.0 or newer
- npm 9 or newer
- A modern browser
- An OpenAI Platform API key

Copy `.env.example` to `.env` and add a Platform API key.

```dotenv
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
OPENAI_EVALUATION_MODEL=gpt-5.6-terra
# Blank values fall back to OPENAI_EVALUATION_MODEL.
OPENAI_OBSERVER_MODEL=
OPENAI_ORCHESTRATOR_MODEL=
INTERVIEW_DEVELOPER_MODE=false
VITE_TLDRAW_LICENSE_KEY=your_tldraw_license_key_here
APP_ADDR=127.0.0.1:8080
INTERVIEW_ALLOW_UNSAFE_NETWORK_BIND=false
```

Install and run:

```bash
make install
make run
```

Open <http://127.0.0.1:8080>. Voice mode asks for camera and microphone access. A recording stays in browser memory until it is downloaded or discarded.

`APP_ADDR` defaults to `127.0.0.1:8080`. The `-addr` command flag overrides it. A key-bearing server refuses a non-loopback bind unless `INTERVIEW_ALLOW_UNSAFE_NETWORK_BIND=true`. This opt-in is unsafe because the app has no user authentication.

Browser mutation requests must have the same origin as the server. Paid endpoints also limit concurrent requests and request starts. These controls reduce local misuse. They do not make the app safe for a public network.

Use an OpenAI Platform API key. ChatGPT subscriptions and Codex CLI login tokens do not fund API calls.

## tldraw license

The local HTTP app does not need a tldraw production license key. A hosted HTTPS deployment needs a valid `VITE_TLDRAW_LICENSE_KEY`. The value is part of the browser build, so it is not a secret.

## Development

Run the server and Vite in separate terminals:

```bash
go run ./cmd/server -dev-dir web
```

```bash
cd web
npm run dev
```

Open <http://127.0.0.1:5173>. Vite sends `/api` requests to `127.0.0.1:8080`.

Agents SDK tracing is disabled. The application does not export browser agent traces.

## Checks and release build

```bash
make check
make doctor
make build
make check-web-freshness
make release-check
```

- `make check` runs frontend unit tests, frontend type checking, and Go tests.
- `make doctor` checks Node.js 22.12.0+, local tools, installed dependencies, bind safety, runtime permissions, hidden key presence, model names, and embedded assets. It makes no provider call and never prints the key.
- `make doctor-test` verifies the Node.js version gate with fixed version values. It does not use the machine Node version.
- `make build` is the canonical production build. It writes the frontend to `cmd/server/webdist` and the server binary to `bin/interviewer`.
- `make check-web-freshness` compares embedded files with a fresh isolated production build. It fails when frontend source changed without a canonical rebuild.
- `make scan-web-assets` rejects jsDelivr, unpkg, and cdnjs paths in emitted assets. The tldraw package retains one unused default CDN literal; `WhiteboardPanel` overrides it with `getAssetUrlsByImport()` local files, and browser coverage blocks every non-loopback request while rendering the editor.
- `make release-check` adds browser tests, Go race tests, Go vet, a canonical build, and embedded-file freshness checks.

Build cleanup removes only generated binaries and caches:

```bash
make clean-build
```

Runtime cleanup permanently deletes private interview data. It is separate and requires an exact confirmation:

```bash
CONFIRM_PURGE_RUNTIME=DELETE_RUNTIME make purge-runtime
```

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Check server health |
| `GET` | `/api/config` | Read planner model names and developer-mode state |
| `POST` | `/api/interview/uploads` | Store a private setup file |
| `POST` | `/api/interview/setups` | Validate and save a setup snapshot |
| `GET` | `/api/interview/setups/{id}` | Read a saved setup snapshot |
| `POST` | `/api/interview/setups/{id}/prepare` | Create or read a prepared guide |
| `POST` | `/api/realtime/token` | Mint a short-lived Realtime client secret |
| `POST` | `/api/openai/v1/responses` | Proxy allowed planner Responses calls |
| `POST` | `/api/interview/evidence` | Store an idempotent evidence event |
| `POST` | `/api/interview/artifacts` | Store immutable final code and whiteboard artifacts without AI |
| `POST` | `/api/interview/complete` | Record the terminal event |
| `POST` | `/api/interview/evaluate` | Create or return the final server-owned report |

There is no local chat endpoint, local question endpoint, or `/api/realtime/session` route. Unknown API paths return `404`.

A prepared guide is the only candidate-facing question source. Verified solutions and buggy fixtures stay server-private.

## Persistence and evaluation

Private files live under `runtime/`:

- setup snapshots, uploads, and prepared guides: `runtime/setups/{setupId}/`
- evidence: `runtime/evidence.jsonl`
- final artifacts: `runtime/artifacts/{sessionId}/`
- completions: `runtime/completions.jsonl`
- evaluations: `runtime/evaluations.jsonl`

Every evidence request includes `sessionId`, a stable 32-character lowercase-hex `eventId`, `category`, `observation`, `confidence`, `codeRevision`, and `whiteboardRevision`. A retry reuses the exact payload.

Final artifacts are immutable. The first payload returns `201`. An identical retry returns `200`. A different payload returns `409`.

Evaluation accepts only:

```json
{
  "sessionId": "0123456789abcdef0123456789abcdef",
  "transcript": []
}
```

The server loads the saved setup, prepared rubric, evidence, completion, and immutable final artifacts. The model returns criterion judgments only. The server restores names and weights, validates every prepared criterion, and computes the weighted score. An identical evaluation retry returns the stored report. A retry with a different transcript returns `409`.

Preparation is fixed per setup ID. The first successful request returns the saved guide on later retries.

## Limits

- The browser code worker is suitable for a local demo. It is not a production sandbox for untrusted code.
- JSONL and local files support one local server. They do not support a multi-instance deployment.
- The app does not provide authentication, remote access control, retention policy, or recording consent management.
- Runtime files contain private interview data. Do not commit or share them.

See [HLD.md](HLD.md), [PRODUCT_SPEC.md](PRODUCT_SPEC.md), and [docs/plans](docs/plans) for more detail.
