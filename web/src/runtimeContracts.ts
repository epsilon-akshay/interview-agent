export type EvidenceRequest = {
  eventId: string;
  sessionId: string;
  category: string;
  observation: string;
  confidence: number;
  codeRevision: number;
  whiteboardRevision: number;
};

export type CompletionRequest = {
  sessionId: string;
  reason: "time_limit" | "manual";
  elapsedSeconds: number;
};

export type ArtifactRequest = {
  sessionId: string;
  codeRevision: number;
  code: string;
  whiteboardRevision: number;
  whiteboardSummary: string;
  whiteboardScene: string | null;
  whiteboardImage: string | null;
};

export type EvaluationRequest = {
  sessionId: string;
  transcript: { role: "candidate" | "interviewer"; text: string }[];
};

export type RevisionSnapshot = {
  revision: number;
  changedAt: number;
  elementCount: number;
  summary: string;
};

export type WhiteboardArtifacts = {
  revision: number;
  snapshot: RevisionSnapshot;
  image: string | null;
  scene: string | null;
};

export type StartupCache<TSetupProgress, TSaved, TPrepared> = {
  setupId: string;
  setupProgress: TSetupProgress;
  saved: TSaved | null;
  prepared: TPrepared | null;
};

const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/;

export function newEventId(uuid = crypto.randomUUID()) {
  const eventId = uuid.replaceAll("-", "").toLowerCase();
  if (!EVENT_ID_PATTERN.test(eventId)) throw new Error("Could not create a valid evidence event ID.");
  return eventId;
}

export function buildEvidenceRequest(input: Omit<EvidenceRequest, "eventId">, eventId = newEventId()): EvidenceRequest {
  if (!EVENT_ID_PATTERN.test(eventId)) throw new Error("Evidence event ID must be 32 lowercase hexadecimal characters.");
  return Object.freeze({ eventId, ...input });
}

export function serializeEvidenceRequest(payload: EvidenceRequest) {
  return JSON.stringify(payload);
}

export function retainCompletionRequest(current: CompletionRequest | null, next: CompletionRequest) {
  return current ?? Object.freeze({ ...next });
}

export type CompletionLifecycle = {
  begin: (payload: CompletionRequest) => CompletionRequest | null;
  pending: () => CompletionRequest | null;
  startAttempt: () => CompletionRequest | null;
  finishAttempt: () => void;
  isEnding: () => boolean;
  isAttempting: () => boolean;
  reset: () => void;
};

export function createCompletionLifecycle(onEndingChange: (ending: boolean) => void = () => undefined): CompletionLifecycle {
  let ending = false;
  let attempting = false;
  let payload: CompletionRequest | null = null;
  return {
    begin(next) {
      if (ending) return null;
      payload = retainCompletionRequest(payload, next);
      ending = true;
      onEndingChange(true);
      return payload;
    },
    pending() { return payload; },
    startAttempt() {
      if (!ending || attempting || !payload) return null;
      attempting = true;
      return payload;
    },
    finishAttempt() { attempting = false; },
    isEnding() { return ending; },
    isAttempting() { return attempting; },
    reset() {
      ending = false;
      attempting = false;
      payload = null;
      onEndingChange(false);
    }
  };
}

export function completionResponseAccepted(status: number) {
  return status >= 200 && status < 300;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<{ status: number; text: () => Promise<string> }>;

export async function postCompletionRequest(payload: CompletionRequest, fetcher: FetchLike = fetch) {
  const response = await fetcher("/api/interview/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!completionResponseAccepted(response.status)) {
    throw new Error((await response.text()).trim() || "Completion could not be recorded.");
  }
}

export function buildArtifactRequest(input: ArtifactRequest) {
  if (!Number.isInteger(input.codeRevision) || input.codeRevision < 0) throw new Error("Code revision must be a nonnegative integer.");
  if (!Number.isInteger(input.whiteboardRevision) || input.whiteboardRevision < 0) throw new Error("Whiteboard revision must be a nonnegative integer.");
  return Object.freeze({ ...input });
}

export function buildEvaluationRequest(input: EvaluationRequest): EvaluationRequest {
  if (!EVENT_ID_PATTERN.test(input.sessionId)) throw new Error("Evaluation requires a valid session ID.");
  if (!Array.isArray(input.transcript) || input.transcript.some((turn) => (turn.role !== "candidate" && turn.role !== "interviewer") || !turn.text.trim())) {
    throw new Error("Evaluation transcript is invalid.");
  }
  return Object.freeze({ sessionId: input.sessionId, transcript: input.transcript.map((turn) => ({ role: turn.role, text: turn.text })) });
}

export async function postArtifactRequest(payload: ArtifactRequest, fetcher: FetchLike = fetch) {
  const response = await fetcher("/api/interview/artifacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error((await response.text()).trim() || "Final interview artifacts could not be saved.");
  }
}

export function ensureStartupCache<TSetupProgress, TSaved, TPrepared>(
  current: StartupCache<TSetupProgress, TSaved, TPrepared> | null,
  create: () => StartupCache<TSetupProgress, TSaved, TPrepared>
) {
  return current ?? create();
}

export async function captureStableWhiteboard(
  source: {
    getSnapshot: () => RevisionSnapshot;
    exportPng: () => Promise<string | null>;
    exportSceneJson: () => Promise<string | null>;
  },
  maxAttempts = 3
): Promise<WhiteboardArtifacts> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = source.getSnapshot();
    const image = await source.exportPng();
    const scene = await source.exportSceneJson();
    const after = source.getSnapshot();
    if (before.revision === after.revision) return { revision: after.revision, snapshot: after, image, scene };
  }
  throw new Error("The whiteboard changed while final artifacts were captured. Try again.");
}

export function retainNewestWhiteboard(current: WhiteboardArtifacts | null, candidate: WhiteboardArtifacts) {
  return current && current.revision > candidate.revision ? current : candidate;
}
