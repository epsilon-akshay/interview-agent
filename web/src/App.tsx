import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { useInterviewAgent } from "./useInterviewAgent";

type Screen = "lobby" | "interview" | "finished";
type Evaluation = {
  overallScore: number;
  recommendation: string;
  summary: string;
  categories: { name: string; score: number; weight: number; evidence: string[]; gaps: string[] }[];
  strengths: string[];
  risks: string[];
  limitations: string[];
};

const DEFAULT_RUBRIC = `Assess the candidate on:
- Problem understanding and clarifying questions (20%)
- Choice and explanation of approach (25%)
- Code quality and likely correctness (25%)
- Time and space complexity analysis (15%)
- Communication and response to feedback (15%)

Do not score appearance, accent, personality, or confidence. Code correctness is a static-analysis estimate because code is not executed.`;

const STARTER_CODE = `function firstNonRepeatingCharacter(input: string): number {
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
  const [code, setCode] = useState(STARTER_CODE);
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const codeRef = useRef(code);
  const rubricRef = useRef(rubric);
  const revisionRef = useRef(revision);
  const sessionIdRef = useRef("");
  const timerTriggeredRef = useRef(false);
  const agent = useInterviewAgent();

  codeRef.current = code;
  rubricRef.current = rubric;
  revisionRef.current = revision;

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
    void agent.endGracefully("time_limit", durationMinutes * 60);
  }, [remaining, screen, durationMinutes, agent]);

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

  async function evaluateInterview() {
    setEvaluating(true);
    setEvaluationError("");
    try {
      const response = await fetch("/api/interview/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          candidate: candidate.trim(), role: role.trim(), question,
          rubric: rubricRef.current, code: codeRef.current
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

  function finalizeInterview(media: MediaStream, reason: string) {
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
    media.getTracks().forEach((track) => track.stop());
    setStream(null);
    setFinishReason(reason === "time_limit" ? "Time is up" : "Interview ended");
    setScreen("finished");
    void evaluateInterview();
  }

  async function startInterview() {
    setError("");
    if (!candidate.trim()) { setError("Enter your name to start the interview."); return; }
    if (!rubric.trim()) { setError("Add an interview rubric."); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setError("Camera access requires a modern browser on localhost."); return; }
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      const durationSeconds = Math.max(60, Math.round(durationMinutes * 60));
      const sessionId = crypto.randomUUID();
      sessionIdRef.current = sessionId;
      timerTriggeredRef.current = false;
      setStream(media);
      setRemaining(durationSeconds);
      setMicOn(true);
      setCameraOn(true);
      setQuestion("The Introduction Agent is fetching the question…");
      setEvaluation(null);
      setEvaluationError("");
      setScreen("interview");
      startRecording(media);
      await agent.connect({
        sessionId,
        candidate: candidate.trim(),
        role: role.trim(),
        durationSeconds,
        media,
        getRubric: () => rubricRef.current,
        getCode: () => codeRef.current,
        getCodeRevision: () => revisionRef.current,
        onQuestion: setQuestion,
        onFinished: (reason) => finalizeInterview(media, reason)
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
    void agent.endGracefully("manual", elapsed);
  }

  function reset() {
    agent.disconnect();
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(null);
    setCode(STARTER_CODE);
    setRevision(0);
    setScreen("lobby");
  }

  return (
    <main className="app-shell">
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
              <div className="editor-shell">
                <div className="editor-bar"><span>solution.ts</span><span>revision {revision}</span></div>
                <Editor
                  height="100%"
                  language="typescript"
                  theme="vs-dark"
                  value={code}
                  onChange={(value) => { setCode(value || ""); setRevision((current) => current + 1); }}
                  options={{ minimap: { enabled: false }, fontSize: 14, lineHeight: 22, padding: { top: 18 }, automaticLayout: true }}
                />
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
                <div className={`voice-orb ${agent.status}`}><span /><span /><span /></div>
                <div><strong>{agent.status === "speaking" ? "Interviewer speaking" : agent.status === "thinking" ? "Agent thinking" : agent.status === "ending" ? "Closing interview" : agent.status === "listening" ? "Listening" : agent.status}</strong><p>{agent.activeAgent}</p></div>
              </div>
              {agent.error && <div className="error voice-error">{agent.error}</div>}
              <div className="tool-panel">
                <div className="panel-title">AGENT TOOL CALLS</div>
                {agent.toolEvents.length === 0 && <p className="empty-tools">Waiting for introduction tools…</p>}
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
          <p>The agent closed the voice session gracefully and the backend recorded completion for session <code>{sessionIdRef.current.slice(0, 8)}</code>.</p>
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
