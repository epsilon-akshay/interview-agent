# Interview Setup Backend v1

Status: implemented.

## Setup ID and retry lifecycle

1. The browser creates one 32-character lowercase-hex `setupId` before its first upload or setup request.
2. Every upload sends that ID.
3. Successful uploads stay in a frontend startup cache.
4. The browser saves one complete `InterviewSetup` v1 snapshot.
5. It prepares that saved setup.
6. It reuses the setup ID as the interview session ID.

A retry keeps the same ID and successful upload, setup, and preparation results. A rollback clears media, recorder, recording URL, and agent state. It does not discard completed setup phases.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/interview/uploads` | Store one private setup file |
| `POST` | `/api/interview/setups` | Validate and save one immutable setup snapshot |
| `GET` | `/api/interview/setups/{id}` | Read one saved snapshot |
| `POST` | `/api/interview/setups/{id}/prepare` | Create or read one prepared guide |

Browser mutation requests must use the same origin. Unknown API routes return `404`.

## Setup contract

The snapshot includes:

- `setupId` and `version: 1`
- `candidateContextPolicy: "job_related_question_tailoring_only"`
- candidate sources and reviewed facts
- role and interview settings
- brief text and attachments
- structured rubric criteria

Interview settings separate workspaces and channels. v1 candidate tools are empty. Voice uses the voice channel. Code-editor interviews use TypeScript. Behavioral interviews cannot keep coding language or code workspace defaults.

Candidate information can tailor job-related questions. It cannot change rubric weights or become interview evidence.

## Upload rules

- Uploads cap at 10 MB and cannot be empty.
- Allowed files are PDF, TXT, Markdown, JSON, and DOCX.
- File bytes must match the extension.
- Attachment IDs must belong to the same setup and allowed purpose.
- LinkedIn, GitHub, and website sources must use HTTPS. The server does not fetch them.

## Idempotency

- The first setup snapshot returns `201`.
- An identical retry returns `200`.
- A different snapshot for the same ID returns `409`.
- The first prepared guide returns `201`.
- An identical preparation retry returns `200`.
- A preparation-mode conflict returns `422`.

## Storage

```text
runtime/setups/{setupId}/
├── setup.json
├── prepared.json
└── uploads/
```

Writes use temporary files and atomic rename. Runtime directories and private files use owner-only permissions before writes.

## Deployment boundary

The app defaults to `127.0.0.1:8080`. A non-loopback key-bearing server needs the explicit unsafe bind flag. Public use still needs authentication, tenant checks, malware scanning, retention controls, and durable storage.
