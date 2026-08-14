import { useCallback, useRef, useState } from "react";
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC, tool } from "@openai/agents/realtime";
import { z } from "zod";

export type AgentStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ending" | "error";

export type InterviewAgentConfig = {
  sessionId: string;
  candidate: string;
  role: string;
  durationSeconds: number;
  media: MediaStream;
  getRubric: () => string;
  getCode: () => string;
  getCodeRevision: () => number;
  onQuestion: (question: string) => void;
  onFinished: (reason: string) => void;
};

type ToolEvent = { name: string; state: "running" | "complete"; at: number };

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "error" in error) return errorMessage((error as { error: unknown }).error);
  return "The interview agent encountered an error.";
}

export function useInterviewAgent() {
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState("");
  const [activeAgent, setActiveAgent] = useState("Introduction Agent");
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const configRef = useRef<InterviewAgentConfig | null>(null);
  const endingRef = useRef(false);
  const endingReasonRef = useRef<"time_limit" | "manual">("time_limit");
  const closingAudioRef = useRef(false);
  const endFallbackRef = useRef<number | null>(null);
  const codeScanRef = useRef<number | null>(null);
  const lastScannedRevisionRef = useRef(-1);
  const statusRef = useRef<AgentStatus>("idle");

  const updateStatus = useCallback((next: AgentStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const logTool = useCallback((name: string, state: ToolEvent["state"]) => {
    setToolEvents((events) => [...events.slice(-7), { name, state, at: Date.now() }]);
  }, []);

  const closeNow = useCallback((reason: string) => {
    if (endFallbackRef.current !== null) window.clearTimeout(endFallbackRef.current);
    if (codeScanRef.current !== null) window.clearInterval(codeScanRef.current);
    endFallbackRef.current = null;
    codeScanRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    updateStatus("idle");
    configRef.current?.onFinished(reason);
  }, [updateStatus]);

  const connect = useCallback(async (config: InterviewAgentConfig) => {
    sessionRef.current?.close();
    configRef.current = config;
    endingRef.current = false;
    closingAudioRef.current = false;
    updateStatus("connecting");
    setError("");
    setToolEvents([]);

    const getInterviewContext = tool({
      name: "get_interview_context",
      description: "Mandatory first tool. Retrieve candidate identity, role and time limit before introducing the interview.",
      parameters: z.object({}),
      async execute() {
        return {
          candidate: config.candidate,
          role: config.role,
          durationMinutes: Math.round(config.durationSeconds / 60),
          instruction: "Introduce yourself briefly and explain that this is a timed coding interview."
        };
      }
    });

    const fetchCodingQuestion = tool({
      name: "fetch_coding_question",
      description: "Mandatory second tool. Fetch the coding question from the server-side text question bank.",
      parameters: z.object({}),
      async execute() {
        const response = await fetch("/api/interview/question");
        if (!response.ok) throw new Error("Question bank is unavailable.");
        const data = await response.json() as { id: string; question: string };
        config.onQuestion(data.question);
        return data;
      }
    });

    const readRubric = tool({
      name: "read_interview_rubric",
      description: "Mandatory third tool. Read the recruiter-provided rubric textbox before asking substantive questions.",
      parameters: z.object({ reason: z.string().describe("Why the rubric is needed at this point") }),
      async execute({ reason }) {
        return { reason, rubric: config.getRubric() };
      }
    });

    const getCurrentCode = tool({
      name: "get_current_code",
      description: "Inspect the exact current Monaco editor contents before discussing or judging the implementation.",
      parameters: z.object({ reason: z.string() }),
      async execute({ reason }) {
        return { reason, language: "typescript", revision: config.getCodeRevision(), code: config.getCode() };
      }
    });

    const recordEvidence = tool({
      name: "record_interview_evidence",
      description: "Persist a concrete rubric-relevant observation. Never record personality, accent, emotion or appearance judgments.",
      parameters: z.object({
        category: z.enum(["problem_understanding", "approach", "communication", "correctness", "complexity", "debugging"]),
        observation: z.string().min(5),
        confidence: z.number().min(0).max(1)
      }),
      async execute(input) {
        const response = await fetch("/api/interview/evidence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, sessionId: config.sessionId, codeRevision: config.getCodeRevision() })
        });
        if (!response.ok) throw new Error("Evidence could not be saved.");
        return { saved: true };
      }
    });

    const reflectionAgent = new RealtimeAgent({
      name: "Reflection Agent",
      handoffDescription: "Handles final complexity, edge-case and reflection questions near the end of the interview.",
      voice: "marin",
      instructions: `You are a terse, demanding technical assessor, not a coach. Stay exclusively within the supplied coding problem, the candidate's implementation, and the evaluation rubric. Do not answer unrelated questions.

Probe whether the candidate genuinely understands time and space complexity, invariants, edge cases, failure modes, and tradeoffs. Ask one precise question at a time and require the candidate to explain reasoning in their own words. Use get_current_code before referring to implementation details and record concrete evidence.

Use at most one short sentence per turn. Prefer probes like "Why?", "What breaks that?", or "Prove it." Do not explain your question.

Never supply an answer, finished code, pseudocode, algorithm name, data structure recommendation, leading hint, or step-by-step path to the solution. If the candidate asks for help, say "No hints. Explain your reasoning." Do not praise, reassure, encourage, or soften weak answers. Remain professional and non-hostile. Do not claim executed correctness; code is reviewed statically.`,
      tools: [getCurrentCode, readRubric, recordEvidence]
    });

    const codingAgent = new RealtimeAgent({
      name: "Coding Interviewer",
      handoffDescription: "Conducts the main code-writing and reasoning portion after the question is presented.",
      voice: "marin",
      instructions: `You are a terse, demanding technical interviewer evaluating knowledge, not teaching or helping. Stay exclusively within the fetched coding question, the candidate's code, and the recruiter rubric. Redirect unrelated conversation with: "Stay on the problem."

Ask one precise question at a time and allow silence. Every spoken turn must be one short sentence, normally under 12 words. Never explain why you asked. Systematically test requirements, assumptions, approach, invariants, correctness, edge cases, complexity, testing, and code revisions. Challenge claims with "Why?", "Prove it.", "What breaks that?", or a counterexample request. Inspect code before discussing it. Use the rubric to target missing evidence and record only observable evidence.

Challenge without deception: question assumptions, introduce valid edge cases, and ask indirect follow-ups, but never invent requirements, contradict the problem, or deliberately provide false facts. When a periodic code-review message arrives, call get_current_code. Ask a question only when the new code exposes a meaningful rubric gap, unexplained choice, or likely defect; otherwise remain silent.

ZERO-HINT POLICY: Never provide the solution, code, pseudocode, algorithm name, recommended data structure, leading example, correction, partial answer, or sequence of steps. Do not complete the candidate's thought. If asked for a hint, answer, validation, or "am I right?", say only that you cannot provide assistance during the assessment, then ask the candidate to explain or test their own reasoning. You may clarify the literal problem statement, but the clarification must not reveal strategy.

Do not praise, reassure, encourage, congratulate, apologize, use filler, or summarize the candidate's answer. Remain professional and non-hostile. You may hand off to the Reflection Agent once the implementation discussion is mature or time is nearly over.`,
      tools: [getCurrentCode, readRubric, recordEvidence],
      handoffs: [reflectionAgent]
    });

    const introductionAgent = new RealtimeAgent({
      name: "Introduction Agent",
      voice: "marin",
      instructions: `You are a formal, terse interview administrator. You MUST call tools in this exact order before speaking substantively: (1) get_interview_context, (2) fetch_coding_question, (3) read_interview_rubric. Then state the candidate name and time limit, present the fetched question exactly without adding strategy or examples, and ask for their understanding. Keep the introduction minimal. Immediately hand off to the Coding Interviewer.

Stay exclusively within the interview. Do not answer unrelated questions. Do not offer hints, solutions, pseudocode, algorithm names, data structures, praise, reassurance, or coaching. Never invent a question or rubric. Be concise, professional, and non-hostile.`,
      tools: [getInterviewContext, fetchCodingQuestion, readRubric],
      handoffs: [codingAgent]
    });

    const tokenResponse = await fetch("/api/realtime/token", { method: "POST" });
    if (!tokenResponse.ok) throw new Error((await tokenResponse.text()).trim() || "Could not create a Realtime token.");
    const token = await tokenResponse.json() as { value?: string };
    if (!token.value) throw new Error("Realtime token response was invalid.");

    const transport = new OpenAIRealtimeWebRTC({ mediaStream: config.media });
    const session = new RealtimeSession(introductionAgent, {
      transport,
      model: "gpt-realtime-2.1-mini",
      workflowName: "Automated Coding Interview",
      groupId: config.sessionId,
      traceMetadata: { sessionId: config.sessionId, role: config.role },
      config: { audio: { input: { turnDetection: { type: "semantic_vad" } } } }
    });
    sessionRef.current = session;
    session.on("agent_start", () => updateStatus("thinking"));
    session.on("agent_end", () => { if (!endingRef.current) updateStatus("listening"); });
    session.on("audio_start", () => { if (endingRef.current) closingAudioRef.current = true; updateStatus(endingRef.current ? "ending" : "speaking"); });
    session.on("audio_stopped", () => {
      if (endingRef.current && closingAudioRef.current) closeNow(endingReasonRef.current);
      else if (!endingRef.current) updateStatus("listening");
    });
    session.on("audio_interrupted", () => { if (!endingRef.current) updateStatus("listening"); });
    session.on("agent_handoff", (_context, _from, to) => setActiveAgent(to.name));
    session.on("agent_tool_start", (_context, _agent, calledTool) => logTool(calledTool.name, "running"));
    session.on("agent_tool_end", (_context, _agent, calledTool) => logTool(calledTool.name, "complete"));
    session.on("error", (event) => { setError(errorMessage(event)); updateStatus("error"); });
    await session.connect({ apiKey: token.value, model: "gpt-realtime-2.1-mini" });
    updateStatus("listening");
    session.sendMessage("Begin the interview now. Follow the mandatory introduction tool sequence before presenting the question.");
    lastScannedRevisionRef.current = config.getCodeRevision();
    codeScanRef.current = window.setInterval(() => {
      const revision = config.getCodeRevision();
      if (endingRef.current || statusRef.current !== "listening" || revision === lastScannedRevisionRef.current) return;
      lastScannedRevisionRef.current = revision;
      session.sendMessage(`Periodic code review. Revision ${revision} changed. Inspect it now with get_current_code. Ask one terse question only if it fills a rubric evidence gap or tests a meaningful code decision; otherwise do not speak.`);
    }, 5000);
  }, [closeNow, logTool, updateStatus]);

  const mute = useCallback((muted: boolean) => sessionRef.current?.mute(muted), []);

  const endGracefully = useCallback(async (reason: "time_limit" | "manual", elapsedSeconds: number) => {
    const config = configRef.current;
    const session = sessionRef.current;
    if (!config || !session || endingRef.current) return;
    endingRef.current = true;
    endingReasonRef.current = reason;
    closingAudioRef.current = false;
    updateStatus("ending");
    if (codeScanRef.current !== null) window.clearInterval(codeScanRef.current);
    codeScanRef.current = null;
    try { session.mute(true); } catch { /* transport may already be closing */ }
    session.interrupt();
    await fetch("/api/interview/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: config.sessionId, reason, elapsedSeconds })
    }).catch(() => undefined);
    session.sendMessage(reason === "time_limit"
      ? "The interview time limit has been reached. State only that time is up and the interview is complete. Do not summarize performance, praise the candidate, provide answers, or ask another question."
      : "The candidate has ended the interview. State only that the interview is complete. Do not summarize performance, praise the candidate, provide answers, or ask another question.");
    endFallbackRef.current = window.setTimeout(() => closeNow(reason), 10000);
  }, [closeNow, updateStatus]);

  const disconnect = useCallback(() => {
    endingRef.current = false;
    if (codeScanRef.current !== null) window.clearInterval(codeScanRef.current);
    codeScanRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    updateStatus("idle");
  }, [updateStatus]);

  return { status, error, activeAgent, toolEvents, connect, mute, endGracefully, disconnect };
}
