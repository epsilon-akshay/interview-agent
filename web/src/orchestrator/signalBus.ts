import type { RunResult } from "../runner/types";
import type { ActivityRow, InterviewPlan, Observation, QueuedQuestion, Signal, TranscriptTurn } from "./types";
import { observeTestRun } from "./observers";
import { analyse } from "./analyse";

export const MIN_SECONDS_BETWEEN_QUESTIONS = 45;
const PRECOMPUTE_LEAD_SECONDS = 10;
const TYPING_QUIET_MS = 3000;
const WHITEBOARD_QUIET_MS = 2000;
const SILENCE_TRIGGER_MS = 20000;
const TICK_MS = 1000;
const ENDGAME_SECONDS = 20;
const STALE_REVISION_DRIFT = 8;
const STALE_AGE_MS = 90000;
const TRANSCRIPT_TAIL_TURNS = 8;

type Precomputed = {
  question: QueuedQuestion;
  atCodeRevision: number;
  at: number;
};

export type SignalBusDeps = {
  getCode: () => string;
  getCodeRevision: () => number;
  getCodeChangedAt: () => number;
  getWhiteboardSummary: () => string;
  getWhiteboardRevision: () => number;
  getWhiteboardChangedAt: () => number;
  getLastRun: () => RunResult | null;
  getRemainingSeconds: () => number;
  getElapsedSeconds: () => number;
  getAgentStatus: () => string;
  getQuestion: () => string;
  getRubric: () => string;
  getPlan: () => InterviewPlan | null;
  getTranscript: () => TranscriptTurn[];
  getAskedQuestions: () => string[];
  getObservations: () => Observation[];
  onObservation: (observation: Observation) => void;
  onQuestionQueued: (question: QueuedQuestion) => void;
  onActivity: (row: ActivityRow) => void;
};

export function startSignalBus(deps: SignalBusDeps) {
  let lastQuestionAt = Date.now();
  let lastCodeRevision = deps.getCodeRevision();
  let lastWhiteboardRevision = deps.getWhiteboardRevision();
  let lastRunAt = deps.getLastRun()?.ranAt ?? 0;
  let lastActivityAt = Date.now();
  let previousCode = deps.getCode();
  let previousWhiteboard = deps.getWhiteboardSummary();
  let busy = false;
  let precomputed: Precomputed | null = null;
  let pendingSignal: Signal["kind"] | null = null;

  const timer = window.setInterval(() => {
    void tick();
  }, TICK_MS);

  /** Runs the single merged model call and records any observations it produced. */
  async function runAnalysis(signal: Signal): Promise<QueuedQuestion | null> {
    const currentCode = deps.getCode();
    const currentWhiteboard = deps.getWhiteboardSummary();
    const testFact = observeTestRun(deps.getLastRun());

    const result = await analyse({
      previousCode,
      currentCode,
      previousWhiteboard,
      currentWhiteboard,
      transcriptTail: deps.getTranscript().slice(-TRANSCRIPT_TAIL_TURNS),
      testFact: testFact?.finding ?? null,
      question: deps.getQuestion(),
      plan: deps.getPlan(),
      rubric: deps.getRubric(),
      observations: deps.getObservations(),
      askedQuestions: deps.getAskedQuestions(),
      signal
    });

    previousCode = currentCode;
    previousWhiteboard = currentWhiteboard;

    for (const observation of result.observations) {
      deps.onObservation(observation);
      deps.onActivity({ type: "observer", text: `${observation.observer} → ${observation.areaId}`, at: Date.now() });
    }
    return result.question;
  }

  /**
   * Records a test run as evidence immediately. This is a machine fact, so it
   * must never wait on a model call or on the question gates.
   */
  function recordTestFact(run: RunResult) {
    const fact = observeTestRun(run);
    if (!fact) return;
    deps.onObservation(fact);
    deps.onActivity({ type: "observer", text: `tests → ${fact.areaId}`, at: Date.now() });
  }

  async function tick() {
    const now = Date.now();
    const codeRevision = deps.getCodeRevision();
    const whiteboardRevision = deps.getWhiteboardRevision();
    const lastRun = deps.getLastRun();
    const sinceQuestion = (now - lastQuestionAt) / 1000;

    // A finished test run is a fact. Record it right away, outside every gate.
    if (lastRun && lastRun.ranAt > lastRunAt) {
      lastRunAt = lastRun.ranAt;
      recordTestFact(lastRun);
      pendingSignal = "tests_run";
    }

    if (busy) return;

    // ---- Work out which signal fired, and remember it if gates block. ----
    if (!pendingSignal) {
      if (codeRevision !== lastCodeRevision && now - deps.getCodeChangedAt() >= TYPING_QUIET_MS) {
        pendingSignal = "code_changed";
        lastCodeRevision = codeRevision;
      } else if (whiteboardRevision !== lastWhiteboardRevision && now - deps.getWhiteboardChangedAt() >= WHITEBOARD_QUIET_MS) {
        pendingSignal = "whiteboard_changed";
        lastWhiteboardRevision = whiteboardRevision;
      } else if (now - lastActivityAt >= SILENCE_TRIGGER_MS) {
        pendingSignal = "silence";
      }
    }

    const buildSignal = (kind: Signal["kind"]): Signal => ({
      kind,
      codeRevision,
      whiteboardRevision,
      elapsedSeconds: deps.getElapsedSeconds(),
      remainingSeconds: deps.getRemainingSeconds()
    });

    // ---- Precompute: think ahead while the gate is still closed. ----
    const gateOpensIn = MIN_SECONDS_BETWEEN_QUESTIONS - sinceQuestion;
    if (
      !precomputed &&
      gateOpensIn <= PRECOMPUTE_LEAD_SECONDS &&
      gateOpensIn > 0 &&
      deps.getRemainingSeconds() > ENDGAME_SECONDS
    ) {
      busy = true;
      deps.onActivity({ type: "orchestrator", text: "thinking ahead", at: now });
      try {
        const question = await runAnalysis(buildSignal(pendingSignal ?? "silence"));
        if (question) {
          precomputed = { question, atCodeRevision: deps.getCodeRevision(), at: Date.now() };
          deps.onActivity({ type: "orchestrator", text: `ready: ${question.areaId}`, at: Date.now() });
        }
      } catch (error) {
        deps.onActivity({ type: "orchestrator", text: `precompute failed: ${message(error)}`, at: Date.now() });
      } finally {
        busy = false;
      }
      return;
    }

    if (!pendingSignal) return;

    // ---- Gates. No question leaves before all of these pass. ----
    if (deps.getAgentStatus() !== "listening") return;      // deferred, not dropped
    if (deps.getRemainingSeconds() <= ENDGAME_SECONDS) return;
    if (sinceQuestion < MIN_SECONDS_BETWEEN_QUESTIONS) return;

    const kind = pendingSignal;
    pendingSignal = null;
    busy = true;
    lastActivityAt = now;
    deps.onActivity({ type: "signal", text: `${kind} · code r${codeRevision} · board r${whiteboardRevision}`, at: now });

    try {
      let question: QueuedQuestion | null = null;

      const fresh =
        precomputed &&
        Math.abs(codeRevision - precomputed.atCodeRevision) <= STALE_REVISION_DRIFT &&
        now - precomputed.at <= STALE_AGE_MS;

      if (fresh && precomputed) {
        question = precomputed.question;
        deps.onActivity({ type: "orchestrator", text: "used precomputed question", at: now });
      } else {
        if (precomputed) deps.onActivity({ type: "orchestrator", text: "precompute stale, recomputing", at: now });
        question = await runAnalysis(buildSignal(kind));
      }
      precomputed = null;

      if (question) {
        lastQuestionAt = Date.now();
        deps.onQuestionQueued(question);
        deps.onActivity({ type: "orchestrator", text: `asked: ${question.areaId}`, at: Date.now() });
      } else {
        deps.onActivity({ type: "orchestrator", text: "stayed silent", at: Date.now() });
      }
    } catch (error) {
      deps.onActivity({ type: "orchestrator", text: `error: ${message(error)}`, at: Date.now() });
    } finally {
      busy = false;
    }
  }

  return () => window.clearInterval(timer);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "unknown";
}
