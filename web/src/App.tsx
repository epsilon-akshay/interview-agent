import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { RunPanel } from "./RunPanel";
import { buildEvidenceObservation, runCode } from "./runner/runCode";
import type { QuestionConfig, RunResult } from "./runner/types";
import { useInterviewAgent } from "./useInterviewAgent";
import { EMPTY_WHITEBOARD_SNAPSHOT, type WhiteboardPanelHandle, type WhiteboardSnapshot } from "./whiteboard/types";
import { initialiseAgentClient } from "./orchestrator/client";
import { startSignalBus, type SignalBus } from "./orchestrator/signalBus";
import type { ActivityRow, InterviewPlan } from "./orchestrator/types";
import { SetupWizard } from "./SetupWizard";
import { createSetupSaveProgress, saveInterviewSetup, type SetupSaveProgress } from "./setup/api";
import { buildPreparedPlan, formatPreparedRubric, prepareInterview, type PreparedInterview } from "./setup/prepared";
import { DEFAULT_SETUP_DRAFT, validateSetupDraft, type InterviewSetupDraft } from "./setup/types";
import {
  buildEvidenceRequest,
  buildArtifactRequest,
  buildEvaluationRequest,
  captureStableWhiteboard,
  ensureStartupCache,
  createCompletionLifecycle,
  newEventId,
  postArtifactRequest,
  postCompletionRequest,
  retainNewestWhiteboard,
  serializeEvidenceRequest,
  type CompletionRequest,
  type ArtifactRequest,
  type StartupCache,
  type WhiteboardArtifacts
} from "./runtimeContracts";

type Screen = "lobby" | "interview" | "finished";
type RuntimeMode = "checks" | "voice";
type Evaluation = {
  overallScore: number;
  recommendation: string;
  summary: string;
  categories: { name: string; score: number; weight: number; evidence: string[]; gaps: string[] }[];
  strengths: string[];
  risks: string[];
  limitations: string[];
};

const RUNTIME_MODE_STORAGE_KEY = "signal-interview-runtime-mode";
const WhiteboardPanel = lazy(() => import("./WhiteboardPanel").then((module) => ({ default: module.WhiteboardPanel })));

const TEST_MODE_OPTIONS: { value: RuntimeMode; label: string }[] = [
  { value: "checks", label: "AI checks" },
  { value: "voice", label: "AI voice" }
];

const FALLBACK_STARTER = `function firstNonRepeatingCharacter(input: string): number {
  // Explain your approach while you work.

  return -1;
}`;

function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function Icon({ name }: { name: "mic" | "camera" | "stop" }) {
  return <span aria-hidden="true">{name === "mic" ? "●" : name === "camera" ? "◆" : "■"}</span>;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("lobby");
  const [setupDraft, setSetupDraft] = useState<InterviewSetupDraft>(DEFAULT_SETUP_DRAFT);
  const [starting, setStarting] = useState(false);
  const [question, setQuestion] = useState("The Introduction Agent will present the prepared interview question.");
  const [questionConfig, setQuestionConfig] = useState<QuestionConfig | null>(null);
  const [preparedInterview, setPreparedInterview] = useState<PreparedInterview | null>(null);
  const [code, setCode] = useState(FALLBACK_STARTER);
  const [revision, setRevision] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [remaining, setRemaining] = useState(300);
  const [recording, setRecording] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [finishReason, setFinishReason] = useState("Interview completed");
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [evaluationError, setEvaluationError] = useState("");
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState("");
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runCollapsed, setRunCollapsed] = useState(false);
  const [runTab, setRunTab] = useState<"tests" | "output">("tests");
  const [workspaceTab, setWorkspaceTab] = useState<"code" | "whiteboard">("code");
  const [whiteboardSnapshot, setWhiteboardSnapshot] = useState<WhiteboardSnapshot>(EMPTY_WHITEBOARD_SNAPSHOT);
  const [plan, setPlan] = useState<InterviewPlan | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("voice");
  const [developerMode, setDeveloperMode] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");
  const [completionError, setCompletionError] = useState("");
  const [ending, setEnding] = useState(false);
  const candidate = setupDraft.candidateName;
  const durationMinutes = setupDraft.durationMinutes;
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const codeRef = useRef(code);
  const rubricRef = useRef("");
  const roleRef = useRef("");
  const revisionRef = useRef(revision);
  const sessionIdRef = useRef("");
  const startupRef = useRef<StartupCache<SetupSaveProgress, { setupId: string }, PreparedInterview> | null>(null);
  const timerTriggeredRef = useRef(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const lastRunRef = useRef<RunResult | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const codeChangedAtRef = useRef(0);
  const remainingRef = useRef(remaining);
  const questionRef = useRef(question);
  const planRef = useRef<InterviewPlan | null>(null);
  const whiteboardRef = useRef<WhiteboardPanelHandle | null>(null);
  const whiteboardSnapshotRef = useRef<WhiteboardSnapshot>(EMPTY_WHITEBOARD_SNAPSHOT);
  const finalWhiteboardRef = useRef<WhiteboardArtifacts | null>(null);
  const workspaceTabRefs = useRef<Record<"code" | "whiteboard", HTMLButtonElement | null>>({ code: null, whiteboard: null });
  const endingRef = useRef(false);
  const evidenceRetryRef = useRef<(() => Promise<void>) | null>(null);
  const runEvidenceIdsRef = useRef(new WeakMap<RunResult, string>());
  const textSignalBusRef = useRef<SignalBus | null>(null);
  const textAskedQuestionsRef = useRef<string[]>([]);
  const textObservationsRef = useRef<import("./orchestrator/types").Observation[]>([]);
  const pendingArtifactsRef = useRef<ArtifactRequest | null>(null);
  const completionLifecycleRef = useRef<ReturnType<typeof createCompletionLifecycle> | null>(null);
  if (!completionLifecycleRef.current) {
    completionLifecycleRef.current = createCompletionLifecycle((next) => {
      endingRef.current = next;
      setEnding(next);
    });
  }
  const agent = useInterviewAgent();

  codeRef.current = code;
  revisionRef.current = revision;
  lastRunRef.current = runResult;
  mediaRef.current = stream;
  whiteboardSnapshotRef.current = whiteboardSnapshot;
  remainingRef.current = remaining;
  questionRef.current = question;

  useEffect(() => {
    localStorage.setItem(RUNTIME_MODE_STORAGE_KEY, runtimeMode);
  }, [runtimeMode]);

  useEffect(() => {
    void fetch("/api/config").then(async (response) => response.ok ? response.json() as Promise<{ developerMode?: boolean }> : null)
      .then((config) => {
        const enabled = config?.developerMode === true;
        setDeveloperMode(enabled);
        if (!enabled) { setRuntimeMode("voice"); return; }
        const saved = localStorage.getItem(RUNTIME_MODE_STORAGE_KEY);
        setRuntimeMode(saved === "checks" ? "checks" : "voice");
      }).catch(() => { setDeveloperMode(false); setRuntimeMode("voice"); });
  }, []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, screen]);

  useEffect(() => {
    if (screen !== "interview" || ending) return;
    const timer = window.setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [screen, ending]);

  useEffect(() => {
    if (screen === "interview" && remaining === 15) void captureWhiteboardArtifacts();
  }, [remaining, screen]);

  useEffect(() => {
    if (screen !== "interview" || remaining !== 0 || timerTriggeredRef.current) return;
    timerTriggeredRef.current = true;
    void requestEnd("time_limit");
  }, [remaining, screen, durationMinutes, agent, runtimeMode]);

  useEffect(() => () => {
    stream?.getTracks().forEach((track) => track.stop());
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    agent.disconnect();
  }, []); // teardown only

  function startRecording(media: MediaStream) {
    if (!window.MediaRecorder) return;
    const preferred = "video/webm;codecs=vp9,opus";
    const recorder = new MediaRecorder(media, MediaRecorder.isTypeSupported(preferred) ? { mimeType: preferred } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" });
      setRecordingUrl(URL.createObjectURL(blob));
      setRecording(false);
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    setRecording(true);
  }

  function discardRecording() {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    recorderRef.current = null;
    chunksRef.current = [];
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(null);
    setRecording(false);
  }

  async function captureWhiteboardArtifacts() {
    const current = whiteboardRef.current?.getSnapshot() ?? whiteboardSnapshotRef.current;
    if (finalWhiteboardRef.current?.revision === current.revision) return finalWhiteboardRef.current;
    const source = whiteboardRef.current;
    const artifacts = source
      ? await captureStableWhiteboard(source, 3)
      : { revision: current.revision, snapshot: current, image: null, scene: null };
    const retained = retainNewestWhiteboard(finalWhiteboardRef.current, artifacts);
    if (retained !== artifacts) return retained;
    if (whiteboardSnapshotRef.current.revision > artifacts.revision) return captureWhiteboardArtifacts();
    finalWhiteboardRef.current = artifacts;
    whiteboardSnapshotRef.current = artifacts.snapshot;
    setWhiteboardSnapshot(artifacts.snapshot);
    return artifacts;
  }

  async function evaluateInterview() {
    setEvaluating(true);
    setEvaluationError("");
    try {
      const response = await fetch("/api/interview/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildEvaluationRequest({
          sessionId: sessionIdRef.current,
          transcript: agent.getTranscript().map((turn) => ({ role: turn.role, text: turn.text })),
        }))
      });
      if (!response.ok) throw new Error((await response.text()).trim() || "Evaluation failed.");
      setEvaluation(await response.json() as Evaluation);
    } catch (reason) {
      setEvaluationError(reason instanceof Error ? reason.message : "Evaluation failed.");
    } finally {
      setEvaluating(false);
    }
  }

  async function finalizeInterview(media: MediaStream | null, reason: string) {
    textSignalBusRef.current?.stop();
    textSignalBusRef.current = null;
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
    recorderRef.current = null;
    media?.getTracks().forEach((track) => track.stop());
    setStream(null);
    await captureWhiteboardArtifacts();
    setFinishReason(reason === "time_limit" ? "Time is up" : "Interview ended");
    setScreen("finished");
    void evaluateInterview();
  }

  function recordCoverage(areaId: string) {
    const current = planRef.current;
    if (!current) return;
    const next = {
      areas: current.areas.map((area) =>
        area.id === areaId ? { ...area, evidenceCount: area.evidenceCount + 1 } : area
      ),
      stages: current.stages
    };
    planRef.current = next;
    setPlan(next);
  }

  function evidenceAreaForTests() {
    const areas = planRef.current?.areas ?? [];
    return areas.find((area) => area.id === "correctness")?.id
      ?? areas.find((area) => /correct|test|implement|code/i.test(`${area.id} ${area.label}`))?.id
      ?? areas[0]?.id;
  }

  function showEvidenceError(message: string, retry: () => Promise<void>) {
    evidenceRetryRef.current = async () => {
      setEvidenceError("");
      try { await retry(); } catch (error) { setEvidenceError(error instanceof Error ? error.message : "Evidence could not be saved."); }
    };
    setEvidenceError(message);
  }

  async function endInterviewWithoutVoice(payload: CompletionRequest) {
    try {
      await postCompletionRequest(payload);
      await finalizeInterview(mediaRef.current, payload.reason);
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : "Completion could not be recorded.");
    }
  }

  async function persistFinalArtifacts() {
    if (!pendingArtifactsRef.current) {
      const whiteboard = await captureWhiteboardArtifacts();
      pendingArtifactsRef.current = buildArtifactRequest({
        sessionId: sessionIdRef.current,
        codeRevision: revisionRef.current,
        code: codeRef.current,
        whiteboardRevision: whiteboard.revision,
        whiteboardSummary: whiteboard.snapshot.summary,
        whiteboardScene: whiteboard.scene,
        whiteboardImage: whiteboard.image
      });
    }
    await postArtifactRequest(pendingArtifactsRef.current);
  }

  async function attemptCompletion(payload: CompletionRequest) {
    const retained = completionLifecycleRef.current?.startAttempt();
    if (!retained || retained !== payload) return;
    setCompletionError("");
    try {
      await persistFinalArtifacts();
      if (runtimeMode === "voice") await agent.endGracefully(payload);
      else await endInterviewWithoutVoice(payload);
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : "Final interview artifacts could not be saved.");
    } finally {
      completionLifecycleRef.current?.finishAttempt();
    }
  }

  async function requestEnd(reason: "time_limit" | "manual") {
    const payload = completionLifecycleRef.current?.begin({
      sessionId: sessionIdRef.current,
      reason,
      elapsedSeconds: Math.max(0, Math.round(durationMinutes * 60) - remaining)
    });
    if (!payload) return;
    textSignalBusRef.current?.stop();
    textSignalBusRef.current = null;
    setCompletionError("");
    await attemptCompletion(payload);
  }

  async function retryCompletion() {
    const payload = completionLifecycleRef.current?.pending();
    if (!payload) return;
    await attemptCompletion(payload);
  }

  async function startInterview() {
    setError("");
    const setupError = validateSetupDraft(setupDraft);
    if (setupError) { setError(setupError); return; }
    setStarting(true);
    let media: MediaStream | null = null;
    try {
      const startup = ensureStartupCache(startupRef.current, () => {
        const setupProgress = createSetupSaveProgress();
        return { setupId: setupProgress.setupId, setupProgress, saved: null, prepared: null };
      });
      startupRef.current = startup;
      const savedSetup = startup.saved ?? await saveInterviewSetup(setupDraft, startup.setupProgress);
      startup.saved = savedSetup;
      const prepared = startup.prepared ?? await prepareInterview(savedSetup.setupId);
      startup.prepared = prepared;
      const config = prepared.question;
      if (runtimeMode === "voice") {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera and microphone access require a modern browser on localhost.");
        media = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: { echoCancellation: true, noiseSuppression: true }
        });
      }
      if (runtimeMode === "checks") await initialiseAgentClient();
      const interviewMedia = media;
      const durationSeconds = prepared.interview.durationSeconds;
      const sessionId = savedSetup.setupId;
      const resolvedRole = `${prepared.role.level} ${prepared.role.title}`.trim();
      sessionIdRef.current = sessionId;
      roleRef.current = resolvedRole;
      rubricRef.current = formatPreparedRubric(prepared);
      timerTriggeredRef.current = false;
      completionLifecycleRef.current?.reset();
      pendingArtifactsRef.current = null;
      setCompletionError("");
      setEvidenceError("");
      runEvidenceIdsRef.current = new WeakMap();
      textAskedQuestionsRef.current = [];
      textObservationsRef.current = [];
      setPreparedInterview(prepared);
      setQuestionConfig(config);
      setCode(config.starterCode || "// This interview does not require executable code.");
      setRevision(0);
      setRunResult(null);
      setRunning(false);
      setRunTab("tests");
      setWorkspaceTab(prepared.interview.workspaces.includes("code_editor") ? "code" : "whiteboard");
      const nextPlan = buildPreparedPlan(prepared);
      setPlan(nextPlan);
      planRef.current = nextPlan;
      setActivity([]);
      finalWhiteboardRef.current = null;
      whiteboardRef.current?.reset();
      setWhiteboardSnapshot(EMPTY_WHITEBOARD_SNAPSHOT);
      setStream(interviewMedia);
      setRemaining(durationSeconds);
      setMicOn(true);
      setCameraOn(true);
      remainingRef.current = durationSeconds;
      questionRef.current = config.prompt;
      setQuestion(runtimeMode === "voice" ? "The Introduction Agent is fetching the question…" : config.prompt);
      setEvaluation(null);
      setEvaluationError("");
      if (runtimeMode === "checks") {
        setActivity([{ type: "orchestrator", text: "Prepared guide loaded. Questions appear as text.", at: Date.now() }]);
      }
      if (runtimeMode === "voice") {
        await initialiseAgentClient();
        await agent.connect({
        sessionId,
        candidate: candidate.trim(),
        role: resolvedRole,
        durationSeconds,
        guide: prepared,
        media: interviewMedia!,
        voiceEnabled: true,
        getRubric: () => rubricRef.current,
        getCode: () => codeRef.current,
        getCodeRevision: () => revisionRef.current,
        getLastRun: () => lastRunRef.current,
        getWhiteboardRevision: () => whiteboardSnapshotRef.current.revision,
        getWhiteboardChangedAt: () => whiteboardSnapshotRef.current.changedAt,
        getWhiteboardSummary: () => whiteboardSnapshotRef.current.summary,
        getWhiteboardImage: () => whiteboardRef.current?.exportPng() ?? Promise.resolve(null),
        getCodeChangedAt: () => codeChangedAtRef.current,
        getPlan: () => planRef.current,
        getQuestionText: () => questionRef.current,
        getRemainingSeconds: () => remainingRef.current,
        getElapsedSeconds: () => durationSeconds - remainingRef.current,
        onActivity: (row) => setActivity((rows) => [...rows.slice(-11), row]),
        onObservation: (observation) => { recordCoverage(observation.areaId); },
        onEvidenceError: showEvidenceError,
        onQuestion: (nextQuestion) => {
          questionRef.current = nextQuestion;
          setQuestion(nextQuestion);
        },
        onQuestionDelivered: () => undefined,
        onCompletionError: (message) => { setCompletionError(message); },
        onFinished: (reason) => { void finalizeInterview(interviewMedia, reason); }
        });
      }
      // Commit only after preparation, required media, and transport are ready.
      setScreen("interview");
      if (interviewMedia) startRecording(interviewMedia);
      if (runtimeMode === "voice") await agent.begin();
      if (runtimeMode === "checks") {
        const primaryDeliveredAt = Date.now();
        const commitCheckObservation = (observation: import("./orchestrator/types").Observation) => {
          if (textObservationsRef.current.includes(observation)) return;
          textObservationsRef.current = [...textObservationsRef.current, observation];
          recordCoverage(observation.areaId);
        };
        const persistCheckObservation = async (observation: import("./orchestrator/types").Observation) => {
          const payload = buildEvidenceRequest({
            sessionId,
            category: observation.areaId,
            observation: `[${observation.observer}] ${observation.finding}`,
            confidence: observation.confidence,
            codeRevision: observation.codeRevision,
            whiteboardRevision: observation.whiteboardRevision
          });
          const persist = async () => {
            const response = await fetch("/api/interview/evidence", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: serializeEvidenceRequest(payload)
            });
            if (!response.ok) throw new Error((await response.text()).trim() || "Evidence could not be saved.");
          };
          try {
            await persist();
          } catch (error) {
            showEvidenceError(error instanceof Error ? error.message : "Evidence could not be saved.", async () => {
              await persist();
              commitCheckObservation(observation);
            });
            throw error;
          }
        };
        const bus = startSignalBus({
          getCode: () => codeRef.current,
          getCodeRevision: () => revisionRef.current,
          getCodeChangedAt: () => codeChangedAtRef.current,
          getWhiteboardSummary: () => whiteboardSnapshotRef.current.summary,
          getWhiteboardRevision: () => whiteboardSnapshotRef.current.revision,
          getWhiteboardChangedAt: () => whiteboardSnapshotRef.current.changedAt,
          getLastRun: () => lastRunRef.current,
          getRemainingSeconds: () => remainingRef.current,
          getElapsedSeconds: () => durationSeconds - remainingRef.current,
          getAgentStatus: () => endingRef.current ? "ending" : "listening",
          getQuestion: () => questionRef.current,
          getRubric: () => rubricRef.current,
          getPlan: () => planRef.current,
          getTranscript: () => [],
          getAskedQuestions: () => textAskedQuestionsRef.current,
          getObservations: () => textObservationsRef.current,
          onActivity: (row) => setActivity((rows) => [...rows.slice(-11), row]),
          onObservation: persistCheckObservation,
          onObservationCommitted: commitCheckObservation,
          onQuestionQueued: (queued) => {
            textAskedQuestionsRef.current = [...textAskedQuestionsRef.current, queued.question];
            questionRef.current = queued.question;
            setQuestion(queued.question);
            bus.notifyQuestionDelivered();
          }
        });
        textSignalBusRef.current = bus;
        bus.notifyQuestionDelivered(primaryDeliveredAt);
      }
    } catch (reason) {
      agent.disconnect(true);
      textSignalBusRef.current?.stop();
      textSignalBusRef.current = null;
      discardRecording();
      media?.getTracks().forEach((track) => track.stop());
      setStream(null);
      setPreparedInterview(null);
      setQuestionConfig(null);
      setRecording(false);
      setScreen("lobby");
      setError(reason instanceof Error ? reason.message : "Could not start the interview.");
    } finally {
      setStarting(false);
    }
  }

  function toggleMic() {
    const nextMuted = micOn;
    try { agent.mute(nextMuted); } catch { /* connection may still be starting */ }
    setMicOn(!nextMuted);
  }

  function toggleCamera() {
    stream?.getVideoTracks().forEach((track) => { track.enabled = !cameraOn; });
    setCameraOn((value) => !value);
  }

  function endInterview() {
    void requestEnd("manual");
  }

  function moveWorkspaceTab(event: ReactKeyboardEvent<HTMLButtonElement>, current: "code" | "whiteboard") {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const tabs = (["code", "whiteboard"] as const).filter((tab) => tab === "code" ? codeWorkspaceEnabled : whiteboardWorkspaceEnabled);
    const index = tabs.indexOf(current);
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    if (!next) return;
    setWorkspaceTab(next);
    workspaceTabRefs.current[next]?.focus();
  }

  function reset() {
    agent.disconnect();
    textSignalBusRef.current?.stop();
    textSignalBusRef.current = null;
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(null);
    setQuestionConfig(null);
    startupRef.current = null;
    completionLifecycleRef.current?.reset();
    pendingArtifactsRef.current = null;
    setPreparedInterview(null);
    roleRef.current = "";
    rubricRef.current = "";
    setCode(FALLBACK_STARTER);
    setRevision(0);
    setRunResult(null);
    setPlan(null);
    planRef.current = null;
    setActivity([]);
    setWorkspaceTab("code");
    finalWhiteboardRef.current = null;
    whiteboardRef.current?.reset();
    setWhiteboardSnapshot(EMPTY_WHITEBOARD_SNAPSHOT);
    setScreen("lobby");
  }

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
  };

  async function postRunEvidence(result: RunResult) {
    const eventId = runEvidenceIdsRef.current.get(result) ?? newEventId();
    runEvidenceIdsRef.current.set(result, eventId);
    const payload = buildEvidenceRequest({
      sessionId: sessionIdRef.current,
      category: "code_execution",
      observation: buildEvidenceObservation(result),
      confidence: 1,
      codeRevision: result.codeRevision,
      whiteboardRevision: whiteboardSnapshotRef.current.revision
    }, eventId);
    const persist = async () => {
      const response = await fetch("/api/interview/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeEvidenceRequest(payload)
      });
      if (!response.ok) throw new Error((await response.text()).trim() || "Test evidence could not be saved.");
      const areaId = evidenceAreaForTests();
      if (areaId) recordCoverage(areaId);
    };
    try { await persist(); } catch (error) { showEvidenceError(error instanceof Error ? error.message : "Test evidence could not be saved.", persist); }
  }

  async function handleRun() {
    if (running || !questionConfig) return;
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) {
      const result: RunResult = {
        status: "fatal_error",
        message: "Editor is not ready yet.",
        warnings: [],
        consoleOutput: [],
        tests: [],
        passedCount: 0,
        totalCount: questionConfig.tests.length,
        ranAt: Date.now(),
        codeRevision: revisionRef.current
      };
      setRunResult(result);
      await postRunEvidence(result);
      return;
    }

    setRunning(true);
    setRunTab("tests");
    try {
      const result = await runCode({
        model,
        entryFunction: questionConfig.entryFunction,
        tests: questionConfig.tests,
        codeRevision: revisionRef.current
      });
      setRunResult(result);
      await postRunEvidence(result);
    } catch (reason) {
      const result: RunResult = {
        status: "fatal_error",
        message: reason instanceof Error ? reason.message : "Run failed.",
        warnings: [],
        consoleOutput: [],
        tests: [],
        passedCount: 0,
        totalCount: questionConfig.tests.length,
        ranAt: Date.now(),
        codeRevision: revisionRef.current
      };
      setRunResult(result);
      await postRunEvidence(result);
    } finally {
      setRunning(false);
    }
  }

  const codeWorkspaceEnabled = preparedInterview?.interview.workspaces.includes("code_editor") ?? true;
  const whiteboardWorkspaceEnabled = preparedInterview?.interview.workspaces.includes("whiteboard") ?? true;
  const hasCandidateWorkspace = codeWorkspaceEnabled || whiteboardWorkspaceEnabled;

  return (
    <main className="app-shell">
      {developerMode && <div className="test-bar">
        <span className="test-bar-label">TEST MODE</span>
        <div className="test-mode-toggle" role="group" aria-label="Test mode">
          {TEST_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={runtimeMode === option.value ? "active" : ""}
              aria-pressed={runtimeMode === option.value}
              disabled={screen === "interview"}
              onClick={() => { startupRef.current = null; setRuntimeMode(option.value); }}
            >
              {option.label}
            </button>
          ))}
        </div>
        {screen === "interview" && <span className="test-bar-note">Applies on the next interview</span>}
      </div>}
      <header className="brand"><span className="brand-mark">S</span><span>Signal Interview</span><span className="local-pill">AGENTS SDK</span></header>

      {screen === "lobby" && (
        <section className="lobby agent-lobby">
          <div className="lobby-copy">
            <h1>Configure once.<br /><em>Interview naturally.</em></h1>
            <p className="lead">Set the interview, rubric, candidate context, and workspace in one reviewed setup.</p>
            <div className="setup-contract-note">
              <strong>One setup snapshot</strong>
              <p>The server validates every input before the interview starts.</p>
            </div>
          </div>
          <SetupWizard value={setupDraft} onChange={(next) => { startupRef.current = null; setSetupDraft(next); }} onStart={() => void startInterview()} busy={starting} error={error} />
        </section>
      )}

      {screen === "interview" && (
        <section className={`interview-workspace ${ending ? "ending" : ""}`}>
          <div className="room-topline">
            <div><span className="live-dot" /> {agent.activeAgent}</div>
            <div className={`timer countdown ${remaining <= 30 ? "urgent" : ""}`} role="status" aria-live="polite" aria-atomic="true">{formatTime(remaining)} remaining</div>
          </div>
          <div className="workspace-grid">
            <section className="coding-column">
              <div className="question-card"><span>INTERVIEW QUESTION</span><p>{question}</p></div>
              {hasCandidateWorkspace ? (
                <div className="workspace-tabs" role="tablist" aria-label="Candidate workspace">
                  {codeWorkspaceEnabled ? <button ref={(node) => { workspaceTabRefs.current.code = node; }} id="workspace-tab-code" type="button" role="tab" aria-selected={workspaceTab === "code"} aria-controls="workspace-panel-code" tabIndex={workspaceTab === "code" ? 0 : -1} className={workspaceTab === "code" ? "active" : ""} onKeyDown={(event) => moveWorkspaceTab(event, "code")} onClick={() => setWorkspaceTab("code")}>Code</button> : null}
                  {whiteboardWorkspaceEnabled ? <button ref={(node) => { workspaceTabRefs.current.whiteboard = node; }} id="workspace-tab-whiteboard" type="button" role="tab" aria-selected={workspaceTab === "whiteboard"} aria-controls="workspace-panel-whiteboard" tabIndex={workspaceTab === "whiteboard" ? 0 : -1} className={workspaceTab === "whiteboard" ? "active" : ""} onKeyDown={(event) => moveWorkspaceTab(event, "whiteboard")} onClick={() => setWorkspaceTab("whiteboard")}>Whiteboard <small>{whiteboardSnapshot.elementCount}</small></button> : null}
                </div>
              ) : null}
              {codeWorkspaceEnabled ? <div id="workspace-panel-code" aria-labelledby="workspace-tab-code" hidden={workspaceTab !== "code"} className={`code-workspace-pane ${workspaceTab === "code" ? "active" : ""}`} role="tabpanel">
                <div className="editor-shell">
                  <div className="editor-bar"><span>candidate.ts</span><span>revision {revision}</span></div>
                  <Editor
                    height="100%"
                    language="typescript"
                    theme="vs-dark"
                    value={code}
                    options={{ minimap: { enabled: false }, fontSize: 14, lineHeight: 22, padding: { top: 18 }, automaticLayout: true, readOnly: ending }}
                    onMount={handleEditorMount}
                    onChange={(value) => { codeChangedAtRef.current = Date.now(); setCode(value || ""); setRevision((current) => current + 1); }}
                  />
                </div>
                {questionConfig && questionConfig.tests.length > 0 ? <RunPanel
                  running={running}
                  result={runResult}
                  totalTests={questionConfig.tests.length}
                  collapsed={runCollapsed}
                  activeTab={runTab}
                  onRun={() => void handleRun()}
                  onToggleCollapsed={() => setRunCollapsed((value) => !value)}
                  onTabChange={setRunTab}
                /> : null}
              </div> : null}
              {whiteboardWorkspaceEnabled ? <div id="workspace-panel-whiteboard" aria-labelledby="workspace-tab-whiteboard" hidden={workspaceTab !== "whiteboard"} className={`whiteboard-workspace-pane ${workspaceTab === "whiteboard" ? "active" : ""}`} role="tabpanel">
                <div className="whiteboard-bar">
                  <span>Explain your approach with shapes, arrows, and labels.</span>
                  <small>revision {whiteboardSnapshot.revision}</small>
                </div>
                <Suspense fallback={<div className="whiteboard-loading">Loading whiteboard…</div>}>
                  <WhiteboardPanel ref={whiteboardRef} readOnly={ending} onSnapshotChange={setWhiteboardSnapshot} />
                </Suspense>
              </div> : null}
              {!hasCandidateWorkspace ? <div className="workspace-empty">This interview does not use a candidate workspace.</div> : null}
            </section>
            <aside className="interview-sidebar">
              {runtimeMode === "voice" && <div className="mini-video">
                <video ref={videoRef} aria-labelledby="candidate-video-label" autoPlay muted playsInline />
                {!cameraOn && <div className="camera-off"><div>{candidate.slice(0, 1).toUpperCase()}</div><p>Camera off</p></div>}
                <div className="video-label" id="candidate-video-label"><span className="status-dot" /> Camera preview for {candidate}</div>
                {recording && <div className="recording-badge"><span /> REC</div>}
              </div>}
              <div className="agent-status-card" role="status" aria-live="polite" aria-atomic="true">
                <div className={`voice-orb ${ending ? "ending" : runtimeMode === "checks" ? "listening" : agent.status}`}><span /><span /><span /></div>
                <div>
                  {ending ? (
                    <><strong>Closing interview</strong><p>Saving final artifacts and completion</p></>
                  ) : runtimeMode === "checks" ? (
                    <><strong>AI checks</strong><p>Text-only interview guidance</p></>
                  ) : (
                    <>
                      <strong>{agent.status === "speaking" ? "Interviewer speaking" : agent.status === "thinking" ? "Agent thinking" : agent.status === "ending" ? "Closing interview" : agent.status === "listening" ? "Listening" : agent.status}</strong>
                      <p>{agent.activeAgent}</p>
                    </>
                  )}
                </div>
              </div>
              {agent.error && runtimeMode === "voice" && <div className="error voice-error">{agent.error}</div>}
              {evidenceError && <div className="error voice-error" role="alert">Evidence was not saved: {evidenceError} <button className="text-button" type="button" onClick={() => void evidenceRetryRef.current?.()}>Retry</button></div>}
              {completionError && <div className="error voice-error" role="alert">Interview completion was not saved: {completionError} <button className="text-button" type="button" onClick={() => void retryCompletion()}>Retry</button></div>}
              {plan && (
                <div className="coverage-panel">
                  <div className="panel-title">RUBRIC COVERAGE</div>
                  {plan.areas.map((area) => (
                    <div className="coverage-row" key={area.id}>
                      <div className="coverage-label"><span>{area.label}</span><small>{area.evidenceCount}</small></div>
                      <div className="coverage-track"><span style={{ width: `${Math.min(100, (area.evidenceCount / 3) * 100)}%` }} /></div>
                    </div>
                  ))}
                </div>
              )}
              <div className="tool-panel activity-panel">
                <div className="panel-title">AGENT ACTIVITY</div>
                {activity.length === 0 && <p className="empty-tools">Waiting for planning activity…</p>}
                {activity.map((row, index) => <div className={`activity-row activity-${row.type}`} key={`${row.at}-${index}`}><span /> <code>{row.text}</code></div>)}
              </div>
              <div className="controls compact" aria-label="Interview controls">
                {runtimeMode === "voice" && <><button className={!micOn ? "control off" : "control"} onClick={toggleMic}><Icon name="mic" /><span>{micOn ? "Mute" : "Unmute"}</span></button>
                <button className={!cameraOn ? "control off" : "control"} onClick={toggleCamera}><Icon name="camera" /><span>Camera</span></button></>}
                <button className="control end" aria-label="End interview" disabled={ending} onClick={endInterview}><Icon name="stop" /><span>End</span></button>
              </div>
            </aside>
          </div>
        </section>
      )}

      {screen === "finished" && (
        <section className="finished">
          <div className="finish-icon">✓</div><div className="eyebrow">SESSION COMPLETE</div>
          <h1>{finishReason}.</h1>
          <p>
            {runtimeMode === "checks" ? "Interview completion was recorded. The AI evaluation uses the saved artifacts for session " : "The interview completion was recorded for session "}
            <code>{sessionIdRef.current.slice(0, 8)}</code>.
          </p>
          {evaluating && (
            <div className="evaluation-loading">
              {plan
                ? plan.areas.map((area) => <div className="evaluation-skeleton" key={area.id}><span>{area.label}</span><small>scoring…</small></div>)
                : "Evaluation Manager is scoring the rubric…"}
            </div>
          )}
          {evaluationError && <div className="error" role="alert">{evaluationError} <button className="text-button" onClick={() => void evaluateInterview()}>Retry</button></div>}
          {evaluation && (
            <section className="evaluation-report">
              <div className="score-summary">
                <div className="overall-score"><strong>{evaluation.overallScore}</strong><span>/100</span></div>
                <div><div className="recommendation">{evaluation.recommendation.replaceAll("_", " ")}</div><p>{evaluation.summary}</p></div>
              </div>
              <div className="category-grid">
                {evaluation.categories.map((category) => (
                  <article className="category-score" key={category.name}>
                    <header><strong>{category.name}</strong><span>{category.score}/100 · {category.weight}%</span></header>
                    <div className="score-track"><span style={{ width: `${category.score}%` }} /></div>
                    <h4>Evidence</h4><ul>{category.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
                    {category.gaps.length > 0 && <><h4>Gaps</h4><ul>{category.gaps.map((item) => <li key={item}>{item}</li>)}</ul></>}
                  </article>
                ))}
              </div>
              <div className="report-columns">
                <div><h3>Strengths</h3><ul>{evaluation.strengths.map((item) => <li key={item}>{item}</li>)}</ul></div>
                <div><h3>Risks</h3><ul>{evaluation.risks.map((item) => <li key={item}>{item}</li>)}</ul></div>
                <div><h3>Limitations</h3><ul>{evaluation.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>
              </div>
            </section>
          )}
          <div className="finish-actions">
            {recordingUrl && <a className="primary link-button" href={recordingUrl} download={`interview-${Date.now()}.webm`}>Save recording</a>}
            <button className="secondary" onClick={reset}>Start another interview</button>
          </div>
        </section>
      )}
    </main>
  );
}
