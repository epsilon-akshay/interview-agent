import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { RunPanel } from "./RunPanel";
import { buildEvidenceObservation, runCode } from "./runner/runCode";
import type { QuestionConfig, RunResult } from "./runner/types";
import { useInterviewAgent } from "./useInterviewAgent";
import { EMPTY_WHITEBOARD_SNAPSHOT, type WhiteboardPanelHandle, type WhiteboardSnapshot } from "./whiteboard/types";

type Screen = "lobby" | "interview" | "finished";
type TestMode = "off" | "checks" | "voice";
type WhiteboardArtifacts = { image: string | null; scene: string | null };
type Evaluation = {
  overallScore: number;
  recommendation: string;
  summary: string;
  categories: { name: string; score: number; weight: number; evidence: string[]; gaps: string[] }[];
  strengths: string[];
  risks: string[];
  limitations: string[];
};

const SHOW_DEMO_CONTROLS = true;
const TEST_MODE_STORAGE_KEY = "signal-interview-test-mode";
const WhiteboardPanel = lazy(() => import("./WhiteboardPanel").then((module) => ({ default: module.WhiteboardPanel })));

const TEST_MODE_OPTIONS: { value: TestMode; label: string }[] = [
  { value: "off", label: "No AI" },
  { value: "checks", label: "AI checks" },
  { value: "voice", label: "AI voice" }
];

const DEFAULT_RUBRIC = `Assess the candidate on:
- Problem understanding and clarifying questions (20%)
- Choice and explanation of approach (25%)
- Code quality and likely correctness (25%)
- Time and space complexity analysis (15%)
- Communication and response to feedback (15%)

Do not score appearance, accent, personality, or confidence. When test execution evidence is present, treat pass and fail counts as verified fact.`;

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
  const [candidate, setCandidate] = useState("");
  const [role, setRole] = useState("Software Engineer");
  const [durationMinutes, setDurationMinutes] = useState(5);
  const [rubric, setRubric] = useState(DEFAULT_RUBRIC);
  const [question, setQuestion] = useState("The Introduction Agent will fetch the question from the server question bank.");
  const [questionConfig, setQuestionConfig] = useState<QuestionConfig | null>(null);
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
  const [testMode, setTestMode] = useState<TestMode>(() => {
    const saved = localStorage.getItem(TEST_MODE_STORAGE_KEY);
    return saved === "off" || saved === "checks" ? saved : "voice";
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const codeRef = useRef(code);
  const rubricRef = useRef(rubric);
  const revisionRef = useRef(revision);
  const sessionIdRef = useRef("");
  const timerTriggeredRef = useRef(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const lastRunRef = useRef<RunResult | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const whiteboardRef = useRef<WhiteboardPanelHandle | null>(null);
  const whiteboardSnapshotRef = useRef<WhiteboardSnapshot>(EMPTY_WHITEBOARD_SNAPSHOT);
  const finalWhiteboardRef = useRef<WhiteboardArtifacts | null>(null);
  const agent = useInterviewAgent();

  codeRef.current = code;
  rubricRef.current = rubric;
  revisionRef.current = revision;
  lastRunRef.current = runResult;
  mediaRef.current = stream;
  whiteboardSnapshotRef.current = whiteboardSnapshot;

  useEffect(() => {
    localStorage.setItem(TEST_MODE_STORAGE_KEY, testMode);
  }, [testMode]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, screen]);

  useEffect(() => {
    if (screen !== "interview" || agent.status === "ending") return;
    const timer = window.setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [screen, agent.status]);

  useEffect(() => {
    if (screen !== "interview" || remaining !== 0 || timerTriggeredRef.current) return;
    timerTriggeredRef.current = true;
    if (testMode === "off") {
      endInterviewOff("time_limit");
    } else {
      void agent.endGracefully("time_limit", durationMinutes * 60);
    }
  }, [remaining, screen, durationMinutes, agent, testMode, stream]);

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

  async function captureWhiteboardArtifacts() {
    if (finalWhiteboardRef.current) return finalWhiteboardRef.current;
    let image: string | null = null;
    let scene: string | null = null;
    try { image = await (whiteboardRef.current?.exportPng() ?? Promise.resolve(null)); } catch { /* scene summary remains available */ }
    try { scene = await (whiteboardRef.current?.exportSceneJson() ?? Promise.resolve(null)); } catch { /* image and scene summary remain available */ }
    const artifacts = { image, scene };
    finalWhiteboardRef.current = artifacts;
    return artifacts;
  }

  async function evaluateInterview() {
    setEvaluating(true);
    setEvaluationError("");
    try {
      const whiteboard = await captureWhiteboardArtifacts();
      const response = await fetch("/api/interview/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          candidate: candidate.trim(), role: role.trim(), question,
          rubric: rubricRef.current, code: codeRef.current,
          whiteboardRevision: whiteboardSnapshotRef.current.revision,
          whiteboardSummary: whiteboardSnapshotRef.current.summary,
          whiteboardImage: whiteboard.image,
          whiteboardScene: whiteboard.scene
        })
      });
      if (!response.ok) throw new Error((await response.text()).trim() || "Evaluation failed.");
      setEvaluation(await response.json() as Evaluation);
    } catch (reason) {
      setEvaluationError(reason instanceof Error ? reason.message : "Evaluation failed.");
    } finally {
      setEvaluating(false);
    }
  }

  async function finalizeInterview(media: MediaStream, reason: string) {
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
    media.getTracks().forEach((track) => track.stop());
    setStream(null);
    await captureWhiteboardArtifacts();
    setFinishReason(reason === "time_limit" ? "Time is up" : "Interview ended");
    setScreen("finished");
    void evaluateInterview();
  }

  function endInterviewOff(reason: "time_limit" | "manual") {
    const elapsed = Math.max(0, Math.round(durationMinutes * 60) - remaining);
    void fetch("/api/interview/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionIdRef.current, reason, elapsedSeconds: elapsed })
    }).catch(() => undefined);
    const media = mediaRef.current ?? stream;
    if (media) void finalizeInterview(media, reason);
  }

  async function loadQuestionConfig(): Promise<QuestionConfig> {
    const response = await fetch("/api/interview/question");
    if (!response.ok) throw new Error("Question bank is unavailable.");
    return await response.json() as QuestionConfig;
  }

  async function startInterview() {
    setError("");
    if (!candidate.trim()) { setError("Enter your name to start the interview."); return; }
    if (!rubric.trim()) { setError("Add an interview rubric."); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setError("Camera access requires a modern browser on localhost."); return; }
    try {
      const config = await loadQuestionConfig();
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      const durationSeconds = Math.max(60, Math.round(durationMinutes * 60));
      const sessionId = crypto.randomUUID();
      sessionIdRef.current = sessionId;
      timerTriggeredRef.current = false;
      setQuestionConfig(config);
      setCode(config.starterCode);
      setRevision(0);
      setRunResult(null);
      setRunning(false);
      setRunTab("tests");
      setWorkspaceTab("code");
      finalWhiteboardRef.current = null;
      whiteboardRef.current?.reset();
      setWhiteboardSnapshot(EMPTY_WHITEBOARD_SNAPSHOT);
      setStream(media);
      setRemaining(durationSeconds);
      setMicOn(true);
      setCameraOn(true);
      setQuestion(testMode === "off" ? config.prompt : "The Introduction Agent is fetching the question…");
      setEvaluation(null);
      setEvaluationError("");
      setScreen("interview");
      startRecording(media);
      if (testMode === "off") return;
      await agent.connect({
        sessionId,
        candidate: candidate.trim(),
        role: role.trim(),
        durationSeconds,
        media,
        voiceEnabled: testMode === "voice",
        getRubric: () => rubricRef.current,
        getCode: () => codeRef.current,
        getCodeRevision: () => revisionRef.current,
        getLastRun: () => lastRunRef.current,
        getWhiteboardRevision: () => whiteboardSnapshotRef.current.revision,
        getWhiteboardChangedAt: () => whiteboardSnapshotRef.current.changedAt,
        getWhiteboardSummary: () => whiteboardSnapshotRef.current.summary,
        getWhiteboardImage: () => whiteboardRef.current?.exportPng() ?? Promise.resolve(null),
        onQuestion: setQuestion,
        onFinished: (reason) => { void finalizeInterview(media, reason); }
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the interview.");
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
    const elapsed = Math.max(0, Math.round(durationMinutes * 60) - remaining);
    if (testMode === "off") {
      endInterviewOff("manual");
    } else {
      void agent.endGracefully("manual", elapsed);
    }
  }

  function reset() {
    agent.disconnect();
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(null);
    setQuestionConfig(null);
    setCode(FALLBACK_STARTER);
    setRevision(0);
    setRunResult(null);
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

  function loadDemoCode(next: string) {
    setCode(next);
    setRevision((current) => current + 1);
    editorRef.current?.setValue(next);
  }

  function postRunEvidence(result: RunResult) {
    void fetch("/api/interview/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionIdRef.current,
        category: "code_execution",
        observation: buildEvidenceObservation(result),
        confidence: 1,
        codeRevision: result.codeRevision
      })
    }).catch(() => undefined);
  }

  async function handleRun() {
    if (running || !questionConfig) return;
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) {
      setRunResult({
        status: "fatal_error",
        message: "Editor is not ready yet.",
        warnings: [],
        consoleOutput: [],
        tests: [],
        passedCount: 0,
        totalCount: questionConfig.tests.length,
        ranAt: Date.now(),
        codeRevision: revisionRef.current
      });
      return;
    }

    setRunning(true);
    setRunTab("tests");
    try {
      const result = await runCode({
        monaco,
        model,
        entryFunction: questionConfig.entryFunction,
        tests: questionConfig.tests,
        codeRevision: revisionRef.current
      });
      setRunResult(result);
      postRunEvidence(result);
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
      postRunEvidence(result);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="app-shell">
      <div className="test-bar">
        <span className="test-bar-label">TEST MODE</span>
        <div className="test-mode-toggle" role="group" aria-label="Test mode">
          {TEST_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={testMode === option.value ? "active" : ""}
              disabled={screen === "interview"}
              onClick={() => setTestMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {screen === "interview" && <span className="test-bar-note">Applies on the next interview</span>}
      </div>
      <header className="brand"><span className="brand-mark">S</span><span>Signal Interview</span><span className="local-pill">AGENTS SDK</span></header>

      {screen === "lobby" && (
        <section className="lobby agent-lobby">
          <div className="lobby-copy">
            <div className="eyebrow">AGENTIC CODING INTERVIEW</div>
            <h1>Configure once.<br /><em>Interview naturally.</em></h1>
            <p className="lead">A realtime introduction agent fetches the question and rubric through tools, then hands the conversation to specialist coding agents.</p>
          </div>
          <div className="setup-card wide-setup">
            <div className="setup-row">
              <label>Your name<input value={candidate} onChange={(event) => setCandidate(event.target.value)} placeholder="e.g. Alex Morgan" autoFocus /></label>
              <label>Interview role<input value={role} onChange={(event) => setRole(event.target.value)} /></label>
            </div>
            <label>Time limit (minutes)<input type="number" min="1" max="60" value={durationMinutes} onChange={(event) => setDurationMinutes(Math.max(1, Number(event.target.value) || 5))} /></label>
            <label>Evaluation rubric<textarea value={rubric} onChange={(event) => setRubric(event.target.value)} rows={9} /></label>
            <div className="privacy-note"><span>✓</span><p><strong>Tool-driven setup</strong><br />The agent must fetch candidate context, question text, and this rubric before starting.</p></div>
            {error && <div className="error" role="alert">{error}</div>}
            <button className="primary" onClick={startInterview}>Start {durationMinutes}-minute interview <span>→</span></button>
          </div>
        </section>
      )}

      {screen === "interview" && (
        <section className="interview-workspace">
          <div className="room-topline">
            <div><span className="live-dot" /> {agent.activeAgent}</div>
            <div className={`timer countdown ${remaining <= 30 ? "urgent" : ""}`}>{formatTime(remaining)} remaining</div>
          </div>
          <div className="workspace-grid">
            <section className="coding-column">
              <div className="question-card"><span>QUESTION BANK</span><p>{question}</p></div>
              <div className="workspace-tabs" role="tablist" aria-label="Candidate workspace">
                <button type="button" role="tab" aria-selected={workspaceTab === "code"} className={workspaceTab === "code" ? "active" : ""} onClick={() => setWorkspaceTab("code")}>Code</button>
                <button type="button" role="tab" aria-selected={workspaceTab === "whiteboard"} className={workspaceTab === "whiteboard" ? "active" : ""} onClick={() => setWorkspaceTab("whiteboard")}>Whiteboard <small>{whiteboardSnapshot.elementCount}</small></button>
              </div>
              <div className={`code-workspace-pane ${workspaceTab === "code" ? "active" : ""}`} role="tabpanel">
                {SHOW_DEMO_CONTROLS && questionConfig && (
                  <div className="demo-strip">
                    <span>⚙ DEMO</span>
                    <button type="button" onClick={() => loadDemoCode(questionConfig.demo.solution)}>Load solution</button>
                    <button type="button" onClick={() => loadDemoCode(questionConfig.demo.buggy)}>Load buggy</button>
                  </div>
                )}
                <div className="editor-shell">
                  <div className="editor-bar"><span>solution.ts</span><span>revision {revision}</span></div>
                  <Editor
                    height="100%"
                    language="typescript"
                    theme="vs-dark"
                    value={code}
                    onMount={handleEditorMount}
                    onChange={(value) => { setCode(value || ""); setRevision((current) => current + 1); }}
                    options={{ minimap: { enabled: false }, fontSize: 14, lineHeight: 22, padding: { top: 18 }, automaticLayout: true }}
                  />
                </div>
                <RunPanel
                  running={running}
                  result={runResult}
                  totalTests={questionConfig?.tests.length ?? 0}
                  collapsed={runCollapsed}
                  activeTab={runTab}
                  onRun={() => void handleRun()}
                  onToggleCollapsed={() => setRunCollapsed((value) => !value)}
                  onTabChange={setRunTab}
                />
              </div>
              <div className={`whiteboard-workspace-pane ${workspaceTab === "whiteboard" ? "active" : ""}`} role="tabpanel">
                <div className="whiteboard-bar">
                  <span>Explain your approach with shapes, arrows, and labels.</span>
                  <small>revision {whiteboardSnapshot.revision}</small>
                </div>
                <Suspense fallback={<div className="whiteboard-loading">Loading whiteboard…</div>}>
                  <WhiteboardPanel ref={whiteboardRef} onSnapshotChange={setWhiteboardSnapshot} />
                </Suspense>
              </div>
            </section>
            <aside className="interview-sidebar">
              <div className="mini-video">
                <video ref={videoRef} autoPlay muted playsInline />
                {!cameraOn && <div className="camera-off"><div>{candidate.slice(0, 1).toUpperCase()}</div><p>Camera off</p></div>}
                <div className="video-label"><span className="status-dot" /> {candidate}</div>
                {recording && <div className="recording-badge"><span /> REC</div>}
              </div>
              <div className="agent-status-card">
                <div className={`voice-orb ${testMode === "off" ? "" : agent.status}`}><span /><span /><span /></div>
                <div>
                  {testMode === "off" ? (
                    <>
                      <strong>AI disabled</strong>
                      <p>Test mode — no voice agent</p>
                    </>
                  ) : (
                    <>
                      <strong>{agent.status === "speaking" ? "Interviewer speaking" : agent.status === "thinking" ? "Agent thinking" : agent.status === "ending" ? "Closing interview" : agent.status === "listening" ? "Listening" : agent.status}</strong>
                      <p>{agent.activeAgent}</p>
                    </>
                  )}
                </div>
              </div>
              {agent.error && testMode !== "off" && <div className="error voice-error">{agent.error}</div>}
              <div className="tool-panel">
                <div className="panel-title">AGENT TOOL CALLS</div>
                {testMode === "off" && <p className="empty-tools">AI is disabled in test mode.</p>}
                {testMode !== "off" && agent.toolEvents.length === 0 && <p className="empty-tools">Waiting for introduction tools…</p>}
                {agent.toolEvents.map((event, index) => <div className="tool-row" key={`${event.name}-${event.at}-${index}`}><span className={event.state} /> <code>{event.name}</code><small>{event.state}</small></div>)}
              </div>
              <div className="controls compact" aria-label="Interview controls">
                <button className={!micOn ? "control off" : "control"} onClick={toggleMic}><Icon name="mic" /><span>{micOn ? "Mute" : "Unmute"}</span></button>
                <button className={!cameraOn ? "control off" : "control"} onClick={toggleCamera}><Icon name="camera" /><span>Camera</span></button>
                <button className="control end" disabled={agent.status === "ending"} onClick={endInterview}><Icon name="stop" /><span>End</span></button>
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
            {testMode === "off"
              ? "Interview complete in test mode. The backend recorded completion for session "
              : "The agent closed the voice session gracefully and the backend recorded completion for session "}
            <code>{sessionIdRef.current.slice(0, 8)}</code>.
          </p>
          {evaluating && <div className="evaluation-loading">Evaluation Manager is scoring the rubric…</div>}
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
