import type { RunResult } from "../runner/types";
import type { AnalysisResult } from "./analyse";
import { analyse } from "./analyse";
import { canDispatchQuestion, canPrecomputeQuestion, isLiveAnalysis, plannerFingerprint } from "./lifecycle";
import { observeTestRun } from "./observers";
import type { ActivityRow, InterviewPlan, Observation, QueuedQuestion, Signal, TranscriptTurn } from "./types";

export const MIN_SECONDS_BETWEEN_QUESTIONS = 45;
const SILENCE_TRIGGER_MS = 20000;
const TICK_MS = 1000;
const TRANSCRIPT_TAIL_TURNS = 8;

type AnalysisCandidate = {
  result: AnalysisResult;
  signal: Signal;
  fingerprint: string;
  previousCode: string;
  code: string;
  previousWhiteboard: string;
  whiteboard: string;
  generation: number;
};

type Precomputed = { candidate: AnalysisCandidate; at: number };

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
  onObservation: (observation: Observation) => Promise<void>;
  onObservationCommitted: (observation: Observation) => void;
  onQuestionQueued: (question: QueuedQuestion) => void;
  onActivity: (row: ActivityRow) => void;
  runtime?: {
    now?: () => number;
    setInterval?: (callback: () => void, intervalMs: number) => number;
    clearInterval?: (timer: number) => void;
    analyse?: typeof analyse;
  };
};

export type SignalBus = { stop: () => void; notifyQuestionDelivered: (at?: number) => void; poll: () => Promise<void> };

export function analysisFingerprint(
  signal: Signal,
  lastRun: RunResult | null,
  transcript: TranscriptTurn[],
  plan: InterviewPlan | null,
  askedQuestions: string[],
  lastQuestionAt: number
) {
  const transcriptValue = transcript.slice(-TRANSCRIPT_TAIL_TURNS).map((turn) => `${turn.role}:${turn.at}:${turn.text}`).join("|");
  const total = signal.elapsedSeconds + signal.remainingSeconds;
  const stageCount = plan?.stages.length ?? 0;
  const stage = total > 0 && stageCount > 0 ? Math.min(stageCount - 1, Math.floor((signal.elapsedSeconds / total) * stageCount)) : -1;
  const timingState = `${lastQuestionAt}:${stage}:${signal.remainingSeconds > 20 ? "open" : "end"}`;
  const planState = JSON.stringify({
    areas: (plan?.areas ?? []).map((area) => [area.id, area.weight, area.evidenceCount]),
    stage: stage >= 0 ? plan?.stages[stage] : null
  });
  return plannerFingerprint({
    kind: signal.kind,
    codeRevision: signal.codeRevision,
    whiteboardRevision: signal.whiteboardRevision,
    lastRunAt: lastRun?.ranAt ?? 0,
    lastRunRevision: lastRun?.codeRevision ?? 0,
    transcript: transcriptValue,
    timingState,
    planState,
    askedState: askedQuestions.join("|")
  });
}

export const dispatchGates = canDispatchQuestion;

export function startSignalBus(deps: SignalBusDeps): SignalBus {
  const now = deps.runtime?.now ?? Date.now;
  const analyseSignal = deps.runtime?.analyse ?? analyse;
  const schedule = deps.runtime?.setInterval ?? ((callback, intervalMs) => window.setInterval(callback, intervalMs));
  const unschedule = deps.runtime?.clearInterval ?? ((timer) => window.clearInterval(timer));
  let lastQuestionAt = 0;
  let lastCodeRevision = deps.getCodeRevision();
  let lastWhiteboardRevision = deps.getWhiteboardRevision();
  let lastRunAt = deps.getLastRun()?.ranAt ?? 0;
  let lastTranscriptState = transcriptState(deps.getTranscript());
  let lastActivityAt = now();
  let previousCode = deps.getCode();
  let previousWhiteboard = deps.getWhiteboardSummary();
  let busy = false;
  let stopped = false;
  let generation = 0;
  let precomputed: Precomputed | null = null;
  let attemptedFingerprint: string | null = null;
  let pendingSignal: Signal["kind"] | null = null;

  const timer = schedule(() => { void tick(); }, TICK_MS);

  function activity(type: ActivityRow["type"], text: string, at = now()) {
    if (!stopped) deps.onActivity({ type, text, at });
  }

  function buildSignal(kind: Signal["kind"]): Signal {
    return {
      kind,
      codeRevision: deps.getCodeRevision(),
      whiteboardRevision: deps.getWhiteboardRevision(),
      elapsedSeconds: deps.getElapsedSeconds(),
      remainingSeconds: deps.getRemainingSeconds()
    };
  }

  function currentFingerprint(signal: Signal) {
    return analysisFingerprint(signal, deps.getLastRun(), deps.getTranscript(), deps.getPlan(), deps.getAskedQuestions(), lastQuestionAt);
  }

  function gatesPass(at = now()) {
    return dispatchGates({
      now: at,
      lastQuestionAt,
      codeChangedAt: deps.getCodeChangedAt(),
      whiteboardChangedAt: deps.getWhiteboardChangedAt(),
      status: deps.getAgentStatus(),
      remainingSeconds: deps.getRemainingSeconds()
    });
  }

  async function runAnalysis(signal: Signal, token: number): Promise<AnalysisCandidate | null> {
    const priorCode = previousCode;
    const code = deps.getCode();
    const priorWhiteboard = previousWhiteboard;
    const whiteboard = deps.getWhiteboardSummary();
    const fingerprint = currentFingerprint(signal);
    const result = await analyseSignal({
      previousCode: priorCode,
      currentCode: code,
      previousWhiteboard: priorWhiteboard,
      currentWhiteboard: whiteboard,
      transcriptTail: deps.getTranscript().slice(-TRANSCRIPT_TAIL_TURNS),
      testFact: signal.kind === "tests_run" ? observeTestRun(deps.getLastRun(), testEvidenceArea())?.finding ?? null : null,
      question: deps.getQuestion(),
      plan: deps.getPlan(),
      rubric: deps.getRubric(),
      observations: deps.getObservations(),
      askedQuestions: deps.getAskedQuestions(),
      signal
    });
    if (!isLiveAnalysis(token, generation, stopped)) return null;
    return {
      result,
      signal,
      fingerprint,
      previousCode: priorCode,
      code,
      previousWhiteboard: priorWhiteboard,
      whiteboard,
      generation: token
    };
  }

  function candidateIsCurrent(candidate: AnalysisCandidate) {
    if (!isLiveAnalysis(candidate.generation, generation, stopped)) return false;
    const currentSignal = buildSignal(candidate.signal.kind);
    return currentFingerprint(currentSignal) === candidate.fingerprint && gatesPass();
  }

  function plannerInputFingerprint(kind: Signal["kind"], priorCode: string, priorWhiteboard: string) {
    const signal = buildSignal(kind);
    const lastRun = deps.getLastRun();
    const plan = deps.getPlan();
    const total = signal.elapsedSeconds + signal.remainingSeconds;
    const stageCount = plan?.stages.length ?? 0;
    const stageIndex = total > 0 && stageCount > 0
      ? Math.min(stageCount - 1, Math.floor((signal.elapsedSeconds / total) * stageCount))
      : -1;
    return JSON.stringify({
      kind,
      code: {
        previous: priorCode,
        current: deps.getCode(),
        revision: signal.codeRevision,
        changedAt: deps.getCodeChangedAt()
      },
      whiteboard: {
        previous: priorWhiteboard,
        current: deps.getWhiteboardSummary(),
        revision: signal.whiteboardRevision,
        changedAt: deps.getWhiteboardChangedAt()
      },
      run: lastRun ? {
        ranAt: lastRun.ranAt,
        codeRevision: lastRun.codeRevision,
        status: lastRun.status,
        message: lastRun.message,
        warnings: lastRun.warnings,
        consoleOutput: lastRun.consoleOutput,
        tests: lastRun.tests,
        passedCount: lastRun.passedCount,
        totalCount: lastRun.totalCount
      } : null,
      transcript: deps.getTranscript().slice(-TRANSCRIPT_TAIL_TURNS),
      timing: {
        lastQuestionAt,
        elapsedSeconds: signal.elapsedSeconds,
        remainingSeconds: signal.remainingSeconds
      },
      question: deps.getQuestion(),
      rubric: deps.getRubric(),
      plan,
      observations: deps.getObservations(),
      askedQuestions: deps.getAskedQuestions(),
      stage: stageIndex < 0 ? null : plan?.stages[stageIndex],
      status: deps.getAgentStatus()
    });
  }

  async function acceptCandidate(candidate: AnalysisCandidate) {
    // Model calls can outlive any input. Rebuild the complete fingerprint and
    // rerun every dispatch gate before producing evidence or a question.
    if (!candidateIsCurrent(candidate)) return { accepted: false, question: null as QueuedQuestion | null };
    previousCode = candidate.code;
    previousWhiteboard = candidate.whiteboard;
    for (const error of candidate.result.validationErrors) activity("orchestrator", `planner validation: ${error}`);
    if (candidate.signal.kind !== "tests_run") {
      for (const observation of candidate.result.observations) {
        if (!isLiveAnalysis(candidate.generation, generation, stopped) || !gatesPass()) return { accepted: false, question: null as QueuedQuestion | null };
        const beforePersistence = plannerInputFingerprint(candidate.signal.kind, candidate.previousCode, candidate.previousWhiteboard);
        await deps.onObservation(observation);
        const afterPersistence = plannerInputFingerprint(candidate.signal.kind, candidate.previousCode, candidate.previousWhiteboard);
        if (!isLiveAnalysis(candidate.generation, generation, stopped) || beforePersistence !== afterPersistence || !gatesPass()) {
          activity("orchestrator", "discarded stale planner result after evidence save");
          return { accepted: false, question: null as QueuedQuestion | null };
        }
        deps.onObservationCommitted(observation);
        activity("observer", `${observation.observer} → ${observation.areaId}`);
      }
    }
    // Coverage can change as the acknowledged observations land. Material
    // candidate input and all five timing gates must still be current.
    if (!isLiveAnalysis(candidate.generation, generation, stopped) || !gatesPass()) return { accepted: false, question: null as QueuedQuestion | null };
    return { accepted: true, question: candidate.result.question };
  }

  function testEvidenceArea() {
    const areas = deps.getPlan()?.areas ?? [];
    return areas.find((area) => area.id === "correctness")?.id
      ?? areas.find((area) => /correct|test|implement|code/i.test(`${area.id} ${area.label}`))?.id
      ?? areas[0]?.id
      ?? "correctness";
  }

  function noteMaterialChange(kind: Signal["kind"], text: string, now: number) {
    generation += 1;
    pendingSignal = kind;
    precomputed = null;
    attemptedFingerprint = null;
    lastActivityAt = now;
    activity("signal", text, now);
  }

  async function tick() {
    if (stopped) return;
    const tickAt = now();
    const codeRevision = deps.getCodeRevision();
    const whiteboardRevision = deps.getWhiteboardRevision();
    const lastRun = deps.getLastRun();
    const transcript = deps.getTranscript();
    const currentTranscriptState = transcriptState(transcript);

    if (codeRevision !== lastCodeRevision) { lastCodeRevision = codeRevision; noteMaterialChange("code_changed", `code changed · r${codeRevision}`, tickAt); }
    if (whiteboardRevision !== lastWhiteboardRevision) { lastWhiteboardRevision = whiteboardRevision; noteMaterialChange("whiteboard_changed", `whiteboard changed · r${whiteboardRevision}`, tickAt); }
    if (lastRun && lastRun.ranAt > lastRunAt) { lastRunAt = lastRun.ranAt; noteMaterialChange("tests_run", `tests run · code r${lastRun.codeRevision}`, tickAt); }
    if (currentTranscriptState !== lastTranscriptState) {
      generation += 1;
      lastTranscriptState = currentTranscriptState;
      lastActivityAt = tickAt;
      precomputed = null;
      attemptedFingerprint = null;
      activity("signal", "transcript changed", tickAt);
    }
    if (!pendingSignal && tickAt - lastActivityAt >= SILENCE_TRIGGER_MS) pendingSignal = "silence";
    if (busy || !pendingSignal || lastQuestionAt === 0) return;

    const signal = buildSignal(pendingSignal);
    const fingerprint = currentFingerprint(signal);
    const gates = gatesPass(tickAt);
    const canPrecompute = !gates && canPrecomputeQuestion({
      now: tickAt,
      lastQuestionAt,
      codeChangedAt: deps.getCodeChangedAt(),
      whiteboardChangedAt: deps.getWhiteboardChangedAt(),
      status: deps.getAgentStatus(),
      remainingSeconds: deps.getRemainingSeconds()
    });

    if (canPrecompute && attemptedFingerprint !== fingerprint) {
      busy = true;
      attemptedFingerprint = fingerprint;
      const token = generation;
      activity("orchestrator", "thinking ahead", tickAt);
      try {
        const candidate = await runAnalysis(signal, token);
        if (candidate && isLiveAnalysis(token, generation, stopped) && currentFingerprint(buildSignal(signal.kind)) === candidate.fingerprint) {
          precomputed = { candidate, at: now() };
          activity("orchestrator", candidate.result.question ? `ready: ${candidate.result.question.areaId}` : "precompute found no question");
        }
      } catch (error) { activity("orchestrator", `precompute failed: ${message(error)}`); } finally { busy = false; }
      return;
    }
    if (!gates) return;
    busy = true;
    const token = generation;
    const kind = pendingSignal;
    activity("signal", `${kind} · code r${signal.codeRevision} · board r${signal.whiteboardRevision}`, tickAt);
    try {
      const candidate = precomputed?.candidate.fingerprint === fingerprint ? precomputed.candidate : await runAnalysis(signal, token);
      if (!candidate) return;
      const accepted = await acceptCandidate(candidate);
      if (!accepted.accepted) return;
      if (accepted.question) {
        pendingSignal = null;
        precomputed = null;
        attemptedFingerprint = null;
        deps.onQuestionQueued(accepted.question);
        activity("orchestrator", `queued: ${accepted.question.areaId}`);
      } else {
        pendingSignal = null;
        precomputed = null;
        attemptedFingerprint = null;
        lastActivityAt = now();
        activity("orchestrator", "stayed silent");
      }
    } catch (error) { activity("orchestrator", `error: ${message(error)}`); } finally { busy = false; }
  }

  return {
    stop() { stopped = true; generation += 1; unschedule(timer); },
    notifyQuestionDelivered(at = now()) {
      if (stopped) return;
      generation += 1;
      lastQuestionAt = at;
      lastActivityAt = at;
      pendingSignal = null;
      precomputed = null;
      attemptedFingerprint = null;
      activity("orchestrator", "question delivered", at);
    },
    poll: tick
  };
}

function transcriptState(turns: TranscriptTurn[]) { return turns.slice(-TRANSCRIPT_TAIL_TURNS).map((turn) => `${turn.role}:${turn.at}:${turn.text}`).join("|"); }
function message(error: unknown) { return error instanceof Error ? error.message : "unknown"; }
