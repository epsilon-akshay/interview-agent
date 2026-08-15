# Interview Setup Backend v1

## Setup-ID lifecycle

1. The setup UI creates one 32-character lowercase hexadecimal `setupId` before uploading files.
2. Every upload sends the same `setupId` in multipart form data.
3. The UI sends the completed `InterviewSetup` snapshot with that `setupId`.
4. The server saves the snapshot once. A second write for the same ID returns `409 Conflict`.
5. The UI reuses `setupId` as the interview session ID, so a later conducting-layer integration can load the snapshot without another identifier.

The current interview-conducting layer receives the ID as its existing session ID. It does not read the setup API yet.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/interview/uploads` | Store one setup file. Requires `setupId`, `kind`, `file`, and `candidateSourceType` for candidate files. |
| `POST` | `/api/interview/setups` | Validate and save one `InterviewSetup` v1 snapshot. |
| `GET` | `/api/interview/setups/{id}` | Read one saved snapshot. |

The server stores files under `runtime/setups/{setupId}/uploads/`. It stores the snapshot at `runtime/setups/{setupId}/setup.json`.

## Contract

The snapshot includes its `setupId`, `version: 1`, and the fixed `candidateContextPolicy` value `job_related_question_tailoring_only`.

It also includes candidate sources and reviewed facts, role, interview settings, brief, and a structured rubric. Interview types are `coding`, `system_design`, `behavioral`, or `mixed`. A resume can use `upload:{uploadId}`. LinkedIn, GitHub, and website sources must use HTTPS URLs. The API does not fetch those URLs.

The brief requires text or an attachment. A rubric can include structured criteria, optional `sourceText`, and source attachments. Rubric weights total 100.

Candidate information only tailors job-related questions. It does not change rubric weights or count as interview evidence.

## Validation and storage

- JSON payloads cap at 256 KB. Uploads cap at 10 MB and cannot be empty.
- File extensions allow PDF, TXT, Markdown, JSON, and DOCX. File bytes must match the extension. The server checks PDF and DOCX signatures, valid UTF-8 text, and valid JSON. It stores a canonical content type.
- Attachment IDs must be unique, exist under the same setup ID, and match their allowed purpose.
- Setup writes use a temporary file and atomic rename.

This is local-demo storage. External use needs authenticated access, tenant checks, retention controls, malware scanning, and durable storage.

## Implementation plan

[P1] Define the boundary

- ✎ [P1.1] Write the v1 setup contract and lifecycle · record fields, validation, and current non-integration boundary · 15m · produces the contract section → feeds [P2.1]
- ✎ [P1.2] Define candidate-context policy · state allowed question tailoring and scoring exclusions · 10m · produces the policy field and rule → feeds [P2.1]

[P2] Build private persistence

- ✎ [P2.1] Add setup create and read handlers · validate the v1 snapshot and save an immutable setup file · 20m · produces setup endpoints → feeds [P3.1]
- ✎ [P2.2] Add setup-scoped upload handler · validate purpose, source type, filename, size, bytes, and metadata · 20m · produces private attachment storage → feeds [P3.1]
- ✎ [P2.3] Add atomic file writes · write temporary JSON then rename it into place · 10m · produces durable setup and metadata writes → feeds [P3.1]

[P3] Enforce references and prove behavior

- ☐ [P3.1] Validate every attachment reference · read attachment metadata and require the same setup and purpose · 15m · produces scoped-reference validation → feeds [P3.2]
- → [P3.2] Add handler regression tests · cover malformed JSON, source boundaries, file signatures, cross-setup access, and duplicate writes · 20m · produces test coverage → feeds [P4.1]

[P4] Verify and document

- ✎ [P4.1] Update API documentation · add endpoints, storage paths, and non-consumption statement · 10m · produces updated boundary docs → feeds [P4.2]
- → [P4.2] Run repository checks · run formatting, Go tests, frontend type checks, and diff validation · 15m · produces verification output → DONE

Critical path: P1.1 + P1.2 → P2.1 + P2.2 + P2.3 → P3.1 → P3.2 → P4.1 → P4.2. P2.1, P2.2, and P2.3 can run in parallel after P1.
