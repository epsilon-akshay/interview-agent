export type RubricArea = {
  id: string;
  label: string;
  weight: number;
  targetEvidence: string;
  evidenceCount: number;
};

export type InterviewPlan = {
  areas: RubricArea[];
};

export type SignalKind = "code_changed" | "whiteboard_changed" | "tests_run" | "silence";

export type Signal = {
  kind: SignalKind;
  codeRevision: number;
  whiteboardRevision: number;
  elapsedSeconds: number;
  remainingSeconds: number;
};

export type Observation = {
  observer: string;
  areaId: string;
  finding: string;
  confidence: number;
  at: number;
};

export type QueuedQuestion = {
  question: string;
  areaId: string;
  basis: string;
};

export type ActivityRow = {
  type: "signal" | "observer" | "orchestrator" | "tool" | "guardrail";
  text: string;
  at: number;
};

export type TranscriptTurn = {
  role: "candidate" | "interviewer";
  text: string;
  at: number;
};
