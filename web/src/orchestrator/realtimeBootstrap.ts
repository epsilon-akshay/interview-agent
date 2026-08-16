import type { TranscriptTurn } from "./types";
import { normalizeSpokenText } from "./outputSafety";

export const REALTIME_BOOTSTRAP_TOOLS = [
  "get_interview_context",
  "fetch_interview_question",
  "read_interview_rubric"
] as const;

export type RealtimeBootstrapTool = typeof REALTIME_BOOTSTRAP_TOOLS[number];
export type RealtimeToolChoice = RealtimeBootstrapTool | "auto";
export type RealtimeProviderToolChoice = "auto" | { type: "function"; name: RealtimeBootstrapTool };

export function realtimeToolChoiceOverride(choice: RealtimeToolChoice) {
  const providerChoice: RealtimeProviderToolChoice = choice === "auto"
    ? "auto"
    : { type: "function", name: choice };
  return {
    // The Agents SDK uses a string abstraction. providerData is its public escape
    // hatch for the exact Realtime API shape and wins during payload serialization.
    toolChoice: "auto" as const,
    providerData: { tool_choice: providerChoice }
  };
}

export function realtimePlaybackStoppedResponse(event: unknown) {
  if (!event || typeof event !== "object") return null;
  const candidate = event as { type?: unknown; response_id?: unknown };
  if (candidate.type !== "output_audio_buffer.stopped" || typeof candidate.response_id !== "string") return null;
  return candidate.response_id || null;
}

type RealtimeTransportEvent = {
  type?: string;
  session?: { tool_choice?: unknown; toolChoice?: unknown };
};

export type RealtimeSessionPort<TAgent> = {
  updateToolChoice: (choice: RealtimeToolChoice) => Promise<void> | void;
  onTransportEvent: (listener: (event: unknown) => void) => () => void;
  requestResponse: () => void;
  updateAgent: (agent: TAgent) => Promise<unknown>;
  removeHistoryItem: (itemId: string) => void;
  close: () => void;
};

export type RealtimeBootstrapAdapter<TAgent> = {
  setToolChoice: (choice: RealtimeToolChoice, signal: AbortSignal) => Promise<void>;
  requestResponse: () => void;
  handoff: (agent: TAgent, signal: AbortSignal) => Promise<void>;
  removeHistoryItem: (itemId: string) => void;
  closeOnce: () => void;
  isClosed: () => boolean;
};

function acknowledgedChoice(event: unknown) {
  if (!event || typeof event !== "object") return null;
  const candidate = event as RealtimeTransportEvent;
  if (candidate.type !== "session.updated") return null;
  const choice = candidate.session?.tool_choice ?? candidate.session?.toolChoice;
  if (typeof choice === "string") return choice;
  if (choice && typeof choice === "object" && "name" in choice) {
    const name = (choice as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

export function createRealtimeBootstrapAdapter<TAgent>(port: RealtimeSessionPort<TAgent>): RealtimeBootstrapAdapter<TAgent> {
  let closed = false;
  const waitForChoice = (
    choice: RealtimeToolChoice,
    signal: AbortSignal,
    update: () => Promise<unknown> | unknown
  ) => {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Realtime bootstrap stopped."));
    return new Promise<void>((resolve, reject) => {
      let removeListener: () => void = () => undefined;
      let settled = false;
      let updateSent = false;
      const cleanUp = () => {
        removeListener();
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanUp();
        reject(signal.reason ?? new Error("Realtime bootstrap stopped."));
      };
      const onEvent = (event: unknown) => {
        if (!updateSent) return;
        const acknowledged = acknowledgedChoice(event);
        if (acknowledged === null || acknowledged !== choice || settled) return;
        settled = true;
        cleanUp();
        resolve();
      };
      removeListener = port.onTransportEvent(onEvent);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = update();
        if (result && typeof result === "object" && "then" in result) {
          void Promise.resolve(result).then(() => {
            updateSent = true;
          }, (error) => {
            if (settled) return;
            settled = true;
            cleanUp();
            reject(error);
          });
        } else {
          updateSent = true;
        }
      } catch (error) {
        settled = true;
        cleanUp();
        reject(error);
      }
    });
  };
  return {
    setToolChoice(choice, signal) {
      return waitForChoice(choice, signal, () => port.updateToolChoice(choice));
    },
    requestResponse: port.requestResponse,
    handoff(agent, signal) {
      return waitForChoice("auto", signal, () => port.updateAgent(agent));
    },
    removeHistoryItem: port.removeHistoryItem,
    closeOnce() {
      if (closed) return;
      closed = true;
      port.close();
    },
    isClosed: () => closed
  };
}

type BootstrapRuntime = {
  setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};

export type RealtimeBootstrapLifecycle<TAgent> = {
  begin: () => Promise<boolean>;
  runTool: <T>(name: RealtimeBootstrapTool, execute: () => Promise<T> | T) => Promise<T>;
  confirmPrimaryDelivery: (question: string, deliveredAt: number) => Promise<boolean>;
  cancelForCompletion: () => boolean;
  stop: () => void;
  close: () => void;
  phase: () => number;
  isDelivered: () => boolean;
};

export function createRealtimeBootstrapLifecycle<TAgent>(options: {
  adapter: RealtimeBootstrapAdapter<TAgent>;
  approvedQuestion: string;
  conductor: TAgent;
  onDelivered: (question: string, at: number) => void;
  onHandoff?: () => void;
  timeoutMs?: number;
  runtime?: BootstrapRuntime;
}): RealtimeBootstrapLifecycle<TAgent> {
  const runtime = options.runtime ?? {
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => clearTimeout(handle)
  };
  const abortController = new AbortController();
  let phase = 0;
  let started = false;
  let delivered = false;
  let stopped = false;
  let completionCancelled = false;
  let transitioning = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let terminalError: Error | null = null;
  let resolveDelivery: (delivered: boolean) => void = () => undefined;
  let rejectDelivery: (error: Error) => void = () => undefined;
  const delivery = new Promise<boolean>((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  // A timeout can occur while begin() is awaiting an acknowledgement. Attach a
  // handler immediately so the later begin() await remains the only visible error.
  void delivery.catch(() => undefined);

  const clearBootstrapTimeout = () => {
    if (timeoutHandle === null) return;
    runtime.clearTimeout(timeoutHandle);
    timeoutHandle = null;
  };
  const fail = (error: Error) => {
    if (terminalError || delivered || completionCancelled) return;
    terminalError = error;
    stopped = true;
    clearBootstrapTimeout();
    abortController.abort(error);
    options.adapter.closeOnce();
    rejectDelivery(error);
  };
  const ensureRunning = () => {
    if (terminalError) throw terminalError;
    if (stopped) throw new Error("Realtime bootstrap stopped.");
  };

  const lifecycle: RealtimeBootstrapLifecycle<TAgent> = {
    async begin() {
      if (!started) {
        started = true;
        timeoutHandle = runtime.setTimeout(() => {
          fail(new Error("The voice interview did not start in time. Retry the interview."));
        }, options.timeoutMs ?? 20_000);
        try {
          await options.adapter.setToolChoice(REALTIME_BOOTSTRAP_TOOLS[0], abortController.signal);
          ensureRunning();
          options.adapter.requestResponse();
        } catch (error) {
          if (completionCancelled) return false;
          fail(error instanceof Error ? error : new Error("The voice interview could not start."));
        }
      }
      return delivery;
    },
    async runTool(name, execute) {
      ensureRunning();
      if (phase === REALTIME_BOOTSTRAP_TOOLS.length) {
        if (name !== "read_interview_rubric") {
          throw new Error("The introduction tool sequence is already complete.");
        }
        return execute();
      }
      const expected = REALTIME_BOOTSTRAP_TOOLS[phase];
      if (name !== expected) {
        throw new Error(`Expected ${expected} before ${name}.`);
      }
      if (transitioning) throw new Error(`The ${expected} step is already running.`);
      transitioning = true;
      try {
        const result = await execute();
        ensureRunning();
        phase += 1;
        const nextChoice = phase < REALTIME_BOOTSTRAP_TOOLS.length
          ? REALTIME_BOOTSTRAP_TOOLS[phase]
          : "auto";
        await options.adapter.setToolChoice(nextChoice, abortController.signal);
        ensureRunning();
        return result;
      } finally {
        transitioning = false;
      }
    },
    async confirmPrimaryDelivery(question, deliveredAt) {
      if (delivered || stopped || phase !== REALTIME_BOOTSTRAP_TOOLS.length) return false;
      if (normalizeSpokenText(question) !== normalizeSpokenText(options.approvedQuestion)) return false;
      try {
        await options.adapter.handoff(options.conductor, abortController.signal);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("The interview conductor could not start."));
        return false;
      }
      if (stopped) return false;
      delivered = true;
      clearBootstrapTimeout();
      options.onHandoff?.();
      options.onDelivered(options.approvedQuestion, deliveredAt);
      resolveDelivery(true);
      return true;
    },
    cancelForCompletion() {
      if (delivered) return false;
      completionCancelled = true;
      stopped = true;
      clearBootstrapTimeout();
      abortController.abort(new Error("Interview completion started."));
      resolveDelivery(false);
      return true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearBootstrapTimeout();
      abortController.abort(new Error("Realtime bootstrap stopped."));
      if (!delivered) resolveDelivery(false);
    },
    close: options.adapter.closeOnce,
    phase: () => phase,
    isDelivered: () => delivered
  };
  return lifecycle;
}

type TrackedTurn = TranscriptTurn & { itemId: string };

export type RealtimeTranscriptStore = {
  addCandidate: (itemId: string, text: string, at?: number) => TranscriptTurn | null;
  syncAssistantHistory: (history: unknown[], at?: number) => TranscriptTurn[];
  commitAssistantHistory: () => TranscriptTurn[];
  rejectAssistantItem: (itemId: string) => void;
  turns: () => TranscriptTurn[];
  hasRejected: (itemId: string) => boolean;
};

export function createRealtimeTranscriptStore(onCandidateTurn?: (turn: TranscriptTurn) => void): RealtimeTranscriptStore {
  let turns: TrackedTurn[] = [];
  let pendingAssistantTurns: TrackedTurn[] = [];
  const seen = new Set<string>();
  const rejected = new Set<string>();
  const publicTurn = ({ role, text, at }: TrackedTurn): TranscriptTurn => ({ role, text, at });
  return {
    addCandidate(itemId, text, at = Date.now()) {
      const trimmed = text.trim();
      if (!itemId || !trimmed || seen.has(itemId)) return null;
      seen.add(itemId);
      const tracked: TrackedTurn = { itemId, role: "candidate", text: trimmed, at };
      turns = [...turns, tracked];
      const turn = publicTurn(tracked);
      onCandidateTurn?.(turn);
      return turn;
    },
    syncAssistantHistory(history, at = Date.now()) {
      const added: TranscriptTurn[] = [];
      for (const value of history) {
        if (!value || typeof value !== "object") continue;
        const item = value as { type?: unknown; role?: unknown; itemId?: unknown; id?: unknown; content?: unknown };
        if (item.type !== "message" || item.role !== "assistant") continue;
        const itemId = String(item.itemId ?? item.id ?? "");
        if (!itemId || seen.has(itemId) || rejected.has(itemId)) continue;
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content.map((part) => {
          if (!part || typeof part !== "object") return "";
          const record = part as { transcript?: unknown; text?: unknown };
          return typeof record.transcript === "string" ? record.transcript : typeof record.text === "string" ? record.text : "";
        }).join(" ").trim();
        if (!text) continue;
        seen.add(itemId);
        const tracked: TrackedTurn = { itemId, role: "interviewer", text, at };
        pendingAssistantTurns = [...pendingAssistantTurns, tracked];
        added.push(publicTurn(tracked));
      }
      return added;
    },
    commitAssistantHistory() {
      if (pendingAssistantTurns.length === 0) return [];
      const committed = pendingAssistantTurns.map(publicTurn);
      turns = [...turns, ...pendingAssistantTurns];
      pendingAssistantTurns = [];
      return committed;
    },
    rejectAssistantItem(itemId) {
      if (!itemId) return;
      rejected.add(itemId);
      seen.add(itemId);
      turns = turns.filter((turn) => turn.itemId !== itemId);
      pendingAssistantTurns = pendingAssistantTurns.filter((turn) => turn.itemId !== itemId);
    },
    turns: () => turns.map(publicTurn),
    hasRejected: (itemId) => rejected.has(itemId)
  };
}

export function realtimeGuardrailIdentity(error: unknown, details: unknown) {
  const guardrailName = error && typeof error === "object"
    ? (error as { result?: { guardrail?: { name?: unknown } } }).result?.guardrail?.name
    : undefined;
  const itemId = details && typeof details === "object"
    ? (details as { itemId?: unknown }).itemId
    : undefined;
  return {
    name: typeof guardrailName === "string" && guardrailName ? guardrailName : "output_guardrail",
    itemId: typeof itemId === "string" ? itemId : ""
  };
}
