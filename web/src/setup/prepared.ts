import type { InterviewPlan } from "../orchestrator/types";
import type { QuestionConfig } from "../runner/types";
import type { ChannelOption, InterviewType, WorkspaceOption } from "./types";

export type PreparedRubricCriterion = {
  id: string;
  name: string;
  weight: number;
  expectedEvidence: string;
};

export type InterviewStage = {
  name: string;
  goal: string;
  questionTypes: string[];
};

export type PreparedInterview = {
  setupId: string;
  version: number;
  createdAt: string;
  generatedFields: string[];
  role: { title: string; level: string };
  roleMission: string;
  interview: {
    type: InterviewType;
    durationSeconds: number;
    codingLanguage: string;
    questionTypes: string[];
    workspaces: WorkspaceOption[];
    tools: [];
    channels: ChannelOption[];
  };
  brief: string;
  candidateFocus: string[];
  rubric: {
    criteria: PreparedRubricCriterion[];
    sourceText: string;
    attachmentIds: string[];
  };
  pattern: InterviewStage[];
  question: QuestionConfig;
};

type PreparationErrorBody = { code?: string; message?: string };

const preparationMessages: Record<string, string> = {
  provider_auth: "The AI provider rejected the server credentials. Update the server key and retry.",
  provider_quota: "The AI provider account cannot prepare an interview right now. Check the provider account and retry.",
  provider_rate_limit: "The AI provider is busy. Please retry shortly.",
  provider_timeout: "AI preparation took too long. Please retry.",
  provider_unavailable: "AI preparation is temporarily unavailable. Please retry."
};

export async function prepareInterview(setupId: string): Promise<PreparedInterview> {
  const response = await fetch(`/api/interview/setups/${setupId}/prepare`, { method: "POST" });
  if (!response.ok) {
    let body: PreparationErrorBody | null = null;
    try { body = await response.json() as PreparationErrorBody; } catch { /* a legacy server can return plain text */ }
    throw new Error(body?.message || (body?.code ? preparationMessages[body.code] : undefined) || "AI preparation is temporarily unavailable. Please retry.");
  }
  return parsePreparedInterview(await response.json());
}

function isString(value: unknown): value is string { return typeof value === "string"; }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isString); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
const interviewTypes = new Set(["coding", "system_design", "behavioral", "mixed"]);

export function parsePreparedInterview(value: unknown): PreparedInterview {
  if (!isRecord(value) || !isString(value.setupId) || value.version !== 1 || !isString(value.createdAt) ||
    !isRecord(value.role) || !isString(value.role.title) || !value.role.title.trim() || !isString(value.role.level) || !value.role.level.trim() || !isString(value.roleMission) || !value.roleMission.trim() || !isRecord(value.interview) ||
    !isString(value.interview.type) || !Number.isInteger(value.interview.durationSeconds) || Number(value.interview.durationSeconds) < 60 ||
    !isStringArray(value.interview.questionTypes) || value.interview.questionTypes.length === 0 || !isStringArray(value.interview.workspaces) ||
    !isStringArray(value.interview.tools) || !isStringArray(value.interview.channels) || !isString(value.interview.codingLanguage) ||
    !isString(value.brief) || !value.brief.trim() || !isStringArray(value.generatedFields) || !isStringArray(value.candidateFocus) || !isRecord(value.rubric) ||
    !Array.isArray(value.rubric.criteria) || value.rubric.criteria.length === 0 || !isString(value.rubric.sourceText) ||
    !isStringArray(value.rubric.attachmentIds) || !Array.isArray(value.pattern) || value.pattern.length === 0 || !isRecord(value.question)) {
    throw new Error("The server returned an invalid interview guide. Nothing has started.");
  }
  const interview = value.interview;
  const question = value.question;
  const hasEditor = (interview.workspaces as string[]).includes("code_editor");
  const criteria = value.rubric.criteria;
  if (!interviewTypes.has(interview.type as string) || !(interview.workspaces as string[]).every((item) => item === "code_editor" || item === "whiteboard") ||
    (interview.tools as string[]).length !== 0 || !(interview.channels as string[]).every((item) => item === "voice") ||
    !isString(question.id) || !question.id.trim() || !isString(question.prompt) || !question.prompt.trim() || !isString(question.language) || !isString(question.entryFunction) ||
    !isString(question.starterCode) || !Array.isArray(question.tests) ||
    criteria.some((criterion) => !isRecord(criterion) || !isString(criterion.id) || !criterion.id.trim() || !isString(criterion.name) || !criterion.name.trim() || !Number.isInteger(criterion.weight) || !isString(criterion.expectedEvidence) || !criterion.expectedEvidence.trim()) ||
    value.pattern.some((stage) => !isRecord(stage) || !isString(stage.name) || !isString(stage.goal) || !isStringArray(stage.questionTypes)) ||
    question.tests.some((test) => !isRecord(test) || !Array.isArray(test.args) || !("expected" in test)) ||
    criteria.reduce((total, criterion) => total + Number((criterion as Record<string, unknown>).weight), 0) !== 100 ||
    (hasEditor && (question.language.toLowerCase() !== "typescript" || !question.entryFunction || !question.starterCode || question.tests.length < 2))) {
    throw new Error("The server returned an invalid interview guide. Nothing has started.");
  }
  return value as unknown as PreparedInterview;
}

export function formatPreparedRubric(prepared: PreparedInterview) {
  const criteria = prepared.rubric.criteria
    .map((criterion) => `- ${criterion.name} (${criterion.weight}%): ${criterion.expectedEvidence}`)
    .join("\n");
  const source = prepared.rubric.sourceText.trim();
  return `Assess the candidate on:\n${criteria}\n\nCandidate information may tailor job-related questions. It must not count as scoring evidence or change these weights.${source ? `\n\nAdditional rubric guidance:\n${source}` : ""}`;
}

export function buildPreparedPlan(prepared: PreparedInterview): InterviewPlan {
  return {
    areas: prepared.rubric.criteria.map((criterion) => ({
      id: criterion.id,
      label: criterion.name,
      weight: criterion.weight,
      targetEvidence: criterion.expectedEvidence,
      evidenceCount: 0
    })),
    stages: prepared.pattern.map((stage) => ({ ...stage }))
  };
}
