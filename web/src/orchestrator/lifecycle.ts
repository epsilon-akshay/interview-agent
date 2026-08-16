export type PlannerObservation = { source: string; areaId: string; finding: string; confidence: number };
export type PlannerOutput = { observations: PlannerObservation[]; shouldAsk: boolean; areaId: string; question: string; basis: string };
import { normalizeSpokenText, outputSafetyViolation } from "./outputSafety";

export function canDispatchQuestion(input: { now: number; lastQuestionAt: number; codeChangedAt: number; whiteboardChangedAt: number; status: string; remainingSeconds: number }) {
  return input.lastQuestionAt > 0 &&
    input.now - input.lastQuestionAt >= 45_000 &&
    input.now - input.codeChangedAt >= 3_000 &&
    input.now - input.whiteboardChangedAt >= 2_000 &&
    input.status === "listening" && input.remainingSeconds > 20;
}

export function plannerFingerprint(input: {
  kind: string;
  codeRevision: number;
  whiteboardRevision: number;
  lastRunAt: number;
  lastRunRevision: number;
  transcript: string;
  timingState: string;
  planState: string;
  askedState: string;
}) {
  return [input.kind, input.codeRevision, input.whiteboardRevision, input.lastRunAt, input.lastRunRevision, input.transcript, input.timingState, input.planState, input.askedState].join("/");
}

export function canPrecomputeQuestion(input: { now: number; lastQuestionAt: number; codeChangedAt: number; whiteboardChangedAt: number; status: string; remainingSeconds: number }) {
  const gateOpensIn = 45_000 - (input.now - input.lastQuestionAt);
  return input.lastQuestionAt > 0 && gateOpensIn > 0 && gateOpensIn <= 10_000 &&
    input.now - input.codeChangedAt >= 3_000 && input.now - input.whiteboardChangedAt >= 2_000 &&
    input.status === "listening" && input.remainingSeconds > 20;
}

export function isLiveAnalysis(startGeneration: number, currentGeneration: number, stopped: boolean) {
  return !stopped && startGeneration === currentGeneration;
}

function normalizedQuestion(value: string) { return normalizeSpokenText(value); }

export function validatePlannerOutput(
  output: PlannerOutput | undefined,
  areaIds: Iterable<string>,
  context: { approvedPrompt?: string; askedQuestions?: string[] } = {}
) {
  const allowed = new Set(areaIds);
  const validationErrors: string[] = [];
  if (!output) return { observations: [] as PlannerObservation[], question: null as { question: string; areaId: string; basis: string } | null, validationErrors: ["empty model output"] };
  if (output.observations.length > 3) validationErrors.push("more than three observations");
  const observations = output.observations.slice(0, 3).filter((entry) => {
    if (!allowed.has(entry.areaId)) { validationErrors.push(`unknown area ${entry.areaId}`); return false; }
    if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) { validationErrors.push(`invalid confidence for ${entry.areaId}`); return false; }
    if (!entry.finding.trim()) { validationErrors.push(`empty basis for ${entry.areaId}`); return false; }
    const safetyViolation = outputSafetyViolation(entry.finding, { approvedPrompt: context.approvedPrompt });
    if (safetyViolation) { validationErrors.push(`finding ${safetyViolation}`); return false; }
    return true;
  });
  if (!output.shouldAsk) return { observations, question: null, validationErrors };
  const question = output.question.trim();
  const words = question ? question.split(/\s+/).length : 0;
  const questionMarks = (question.match(/\?/g) ?? []).length;
  const multiplePrompts = questionMarks > 1 || /[?!]\s+[^\s]/.test(question);
  if (!allowed.has(output.areaId)) validationErrors.push(`unknown question area ${output.areaId}`);
  if (!question) validationErrors.push("empty question");
  if (words > 12) validationErrors.push("question exceeds 12 words");
  if (multiplePrompts) validationErrors.push("question contains multiple prompts");
  if (!output.basis.trim()) validationErrors.push("question has no basis");
  const safetyViolation = outputSafetyViolation(question, { approvedPrompt: context.approvedPrompt });
  if (safetyViolation) validationErrors.push(`question ${safetyViolation}`);
  const normalizedProbe = normalizedQuestion(question);
  if ((context.askedQuestions ?? []).some((asked) => normalizedQuestion(asked) === normalizedProbe)) validationErrors.push("question repeats an earlier question");
  const valid = allowed.has(output.areaId) && Boolean(question) && words <= 12 && !multiplePrompts && Boolean(output.basis.trim()) && validationErrors.length === 0;
  return { observations, question: valid ? { question, areaId: output.areaId, basis: output.basis.trim() } : null, validationErrors };
}
