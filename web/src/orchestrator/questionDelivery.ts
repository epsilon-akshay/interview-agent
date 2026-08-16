import { normalizeSpokenText } from "./outputSafety";

type PendingDelivery = {
  question: string;
  responseId: string | null;
  itemIds: Set<string>;
  responseCompleted: boolean;
};

export type QuestionDeliveryTracker = {
  queue: (question: string) => boolean;
  associateResponse: (responseId: string) => void;
  associateItem: (responseId: string, itemId: string) => void;
  completeResponse: (responseId: string, output: string) => boolean;
  rejectItem: (itemId: string) => boolean;
  confirmCompleted: (responseId: string, at?: number) => boolean;
  hasPending: () => boolean;
  isPendingQuestion: (question: string) => boolean;
  reset: () => void;
};

export function createQuestionDeliveryTracker(onDelivered: (question: string, at: number) => void): QuestionDeliveryTracker {
  let pending: PendingDelivery | null = null;

  return {
    queue(question) {
      const trimmed = question.trim();
      if (!trimmed || pending) return false;
      pending = { question: trimmed, responseId: null, itemIds: new Set(), responseCompleted: false };
      return true;
    },
    associateResponse(responseId) {
      if (pending && !pending.responseId && responseId) pending.responseId = responseId;
    },
    associateItem(responseId, itemId) {
      if (!pending || !responseId || pending.responseId !== responseId || !itemId) return;
      pending.itemIds.add(itemId);
    },
    completeResponse(responseId, output) {
      if (!pending || !responseId || pending.responseId !== responseId) return false;
      const question = normalizeSpokenText(pending.question);
      const spoken = normalizeSpokenText(output);
      if (!question || !spoken.includes(question)) {
        pending.responseId = null;
        pending.itemIds.clear();
        pending.responseCompleted = false;
        return false;
      }
      pending.responseCompleted = true;
      return true;
    },
    rejectItem(itemId) {
      if (!pending || !itemId || !pending.itemIds.has(itemId)) return false;
      pending.responseId = null;
      pending.itemIds.clear();
      pending.responseCompleted = false;
      return true;
    },
    confirmCompleted(responseId, at = Date.now()) {
      if (!pending?.responseCompleted || !responseId || pending.responseId !== responseId) return false;
      const question = pending.question;
      pending = null;
      onDelivered(question, at);
      return true;
    },
    hasPending() { return pending !== null; },
    isPendingQuestion(question) { return pending?.question === question.trim(); },
    reset() { pending = null; }
  };
}

export function realtimeResponseText(event: unknown) {
  if (!event || typeof event !== "object") return "";
  const response = (event as { response?: { output?: unknown[] } }).response;
  if (!Array.isArray(response?.output)) return "";
  const parts: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") return;
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.transcript === "string") parts.push(record.transcript);
    else if (typeof record.text === "string") parts.push(record.text);
    for (const child of [record.content, record.output]) if (Array.isArray(child)) child.forEach(visit);
  };
  response.output.forEach(visit);
  return parts.join(" ").trim();
}
