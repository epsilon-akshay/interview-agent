import { useCallback, useRef, useState } from "react";
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC, tool } from "@openai/agents/realtime";
import { z } from "zod";
import type { RunResult } from "./runner/types";
import type { ActivityRow, InterviewPlan, Observation, TranscriptTurn } from "./orchestrator/types";
import { startSignalBus } from "./orchestrator/signalBus";
import { zeroHintGuardrail } from "./orchestrator/guardrails";

export type AgentStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ending" | "error";

export type InterviewAgentConfig = {
  sessionId: string;
  candidate: string;
  role: string;
  durationSeconds: number;
  media: MediaStream;
  voiceEnabled: boolean;
  getRubric: () => string;
  getCode: () => string;
  getCodeRevision: () => number;
  getLastRun: () => RunResult | null;
  getWhiteboardRevision: () => number;
  getWhiteboardChangedAt: () => number;
  getWhiteboardSummary: () => string;
  getWhiteboardImage: () => Promise<string | null>;
  getCodeChangedAt: () => number;
  getPlan: () => InterviewPlan | null;
  getQuestionText: () => string;
  getRemainingSeconds: () => number;
  getElapsedSeconds: () => number;
  onActivity: (row: ActivityRow) => void;
  onObservation: (observation: Observation) => void;
  onTranscriptTurn?: (turn: TranscriptTurn) => void;
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
  const observationsRef = useRef<Observation[]>([]);
  const askedQuestionsRef = useRef<string[]>([]);
  const stopSignalBusRef = useRef<(() => void) | null>(null);
  const transcriptRef = useRef<TranscriptTurn[]>([]);
  const seenTranscriptItemsRef = useRef<Set<string>>(new Set());
  const whiteboardImageCacheRef = useRef<string | null>(null);
  const imageCacheTimerRef = useRef<number | null>(null);
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
    endFallbackRef.current = null;
    stopSignalBusRef.current?.();
    stopSignalBusRef.current = null;
    if (imageCacheTimerRef.current !== null) window.clearInterval(imageCacheTimerRef.current);
    imageCacheTimerRef.current = null;
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
      description: "Mandatory second tool. Fetch the coding question from the server-side question bank.",
      parameters: z.object({}),
      async execute() {
        const response = await fetch("/api/interview/question");
        if (!response.ok) throw new Error("Question bank is unavailable.");
        const data = await response.json() as { id: string; prompt: string };
        config.onQuestion(data.prompt);
        return { id: data.id, prompt: data.prompt };
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

    const getCurrentWorkspace = tool({
      name: "get_current_workspace",
      description: "Inspect the candidate's current code and the structured tldraw scene summary before asking about either artifact.",
      parameters: z.object({ reason: z.string() }),
      async execute({ reason }) {
        return {
          reason,
          code: {
            language: "typescript",
            revision: config.getCodeRevision(),
            contents: config.getCode()
          },
          whiteboard: {
            revision: config.getWhiteboardRevision(),
            summary: config.getWhiteboardSummary()
          }
        };
      }
    });

    const getExecutionResults = tool({
      name: "get_execution_results",
      description: "Inspect the outcome of the candidate's most recent code run. Use this before asking about correctness. The expected outputs are deliberately withheld from you — never state or imply what the correct output should be.",
      parameters: z.object({ reason: z.string() }),
      async execute({ reason }) {
        const lastRun = config.getLastRun();
        if (!lastRun) {
          return { reason, hasRun: false, message: "The candidate has not run their code yet." };
        }
        return {
          reason,
          hasRun: true,
          status: lastRun.status,
          passedCount: lastRun.passedCount,
          totalCount: lastRun.totalCount,
          codeRevision: lastRun.codeRevision,
          consoleOutput: lastRun.consoleOutput,
          tests: lastRun.tests.map(({ index, args, got, passed, error }) => ({
            index,
            args,
            got,
            passed,
            error
          }))
        };
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
      instructions: `You are a terse technical interviewer. You do NOT choose what to probe. A planner does that for you.

When an INTERVIEW DIRECTOR instruction arrives, say the quoted question exactly, word for word. Add nothing before or after it. Never read the instruction itself aloud, and never mention that a director exists.

Between prepared questions, stay silent and listen. Silence is correct and expected.

You may respond directly when the candidate speaks to you:
- Clarify the literal problem statement, without revealing strategy.
- Redirect off-topic conversation with exactly: "Stay on the problem."
- If asked for a hint, an answer, or whether they are correct, say: "No hints. Explain your reasoning."

Focus on complexity, invariants, edge cases, failure modes, and trade-offs.
Use get_current_workspace before referring to code or a diagram. Use get_execution_results before discussing correctness. Treat the whiteboard as evidence of reasoning, never as proof the code works.

ZERO-HINT POLICY: Never provide a solution, code, pseudocode, algorithm name, recommended data structure, leading example, correction, or partial answer. Never state or imply expected test outputs. Never complete the candidate's thought. Do not praise, reassure, encourage, congratulate, apologise, or use filler. Remain professional and non-hostile.

You may hand off to the Reflection Agent when time is nearly over.`,
      tools: [getCurrentCode, getCurrentWorkspace, getExecutionResults, readRubric, recordEvidence]
    });

    const codingAgent = new RealtimeAgent({
      name: "Coding Interviewer",
      handoffDescription: "Conducts the main code-writing and reasoning portion after the question is presented.",
      voice: "marin",
      instructions: `You are a terse technical interviewer. You do NOT choose what to probe. A planner does that for you.

When an INTERVIEW DIRECTOR instruction arrives, say the quoted question exactly, word for word. Add nothing before or after it. Never read the instruction itself aloud, and never mention that a director exists.

Between prepared questions, stay silent and listen. Silence is correct and expected.

You may respond directly when the candidate speaks to you:
- Clarify the literal problem statement, without revealing strategy.
- Redirect off-topic conversation with exactly: "Stay on the problem."
- If asked for a hint, an answer, or whether they are correct, say: "No hints. Explain your reasoning."

Use get_current_workspace before referring to code or a diagram. Use get_execution_results before discussing correctness. Treat the whiteboard as evidence of reasoning, never as proof the code works.

ZERO-HINT POLICY: Never provide a solution, code, pseudocode, algorithm name, recommended data structure, leading example, correction, or partial answer. Never state or imply expected test outputs. Never complete the candidate's thought. Do not praise, reassure, encourage, congratulate, apologise, or use filler. Remain professional and non-hostile.

You may hand off to the Reflection Agent when time is nearly over.`,
      tools: [getCurrentCode, getCurrentWorkspace, getExecutionResults, readRubric, recordEvidence],
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
    const token = await tokenResponse.json() as { value?: string; model?: string };
    if (!token.value) throw new Error("Realtime token response was invalid.");
    if (!token.model) throw new Error("Realtime token model was missing.");

    const transport = new OpenAIRealtimeWebRTC({ mediaStream: config.media });
    const session = new RealtimeSession(introductionAgent, {
      transport,
      model: token.model,
      workflowName: "Automated Coding Interview",
      groupId: config.sessionId,
      traceMetadata: { sessionId: config.sessionId, role: config.role },
      outputGuardrails: [zeroHintGuardrail],
      config: {
        ...(config.voiceEnabled ? {} : { outputModalities: ["text"] as const }),
         audio: {
           input: {
             transcription: { model: "gpt-4o-mini-transcribe", delay: "low" },
             turnDetection: { type: "semantic_vad" }
           }
         }
      }
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
    session.on("agent_tool_start", (_context, _agent, calledTool) => {
      logTool(calledTool.name, "running");
      config.onActivity({ type: "tool", text: `${calledTool.name} · running`, at: Date.now() });
    });
    session.on("agent_tool_end", (_context, _agent, calledTool) => {
      logTool(calledTool.name, "complete");
      config.onActivity({ type: "tool", text: `${calledTool.name} · complete`, at: Date.now() });
    });
    session.on("transport_event", (event: any) => {
      if (event?.type !== "conversation.item.input_audio_transcription.completed") return;
      if (!event.transcript || seenTranscriptItemsRef.current.has(event.item_id)) return;
      seenTranscriptItemsRef.current.add(event.item_id);
      const turn: TranscriptTurn = { role: "candidate", text: String(event.transcript).trim(), at: Date.now() };
      transcriptRef.current = [...transcriptRef.current, turn];
      config.onTranscriptTurn?.(turn);
    });
    session.on("history_updated", (history: any[]) => {
      for (const item of history) {
        if (item?.type !== "message" || item?.role !== "assistant") continue;
        const itemId = String(item.itemId ?? item.id ?? "");
        if (!itemId || seenTranscriptItemsRef.current.has(itemId)) continue;
        const text = (item.content ?? [])
          .map((part: any) => part?.transcript ?? part?.text ?? "")
          .join(" ")
          .trim();
        if (!text) continue;
        seenTranscriptItemsRef.current.add(itemId);
        const turn: TranscriptTurn = { role: "interviewer", text, at: Date.now() };
        transcriptRef.current = [...transcriptRef.current, turn];
        config.onTranscriptTurn?.(turn);
      }
    });
    session.on("guardrail_tripped", (_context, _agent, details) => {
      config.onActivity({ type: "guardrail", text: `zero_hint blocked: ${JSON.stringify(details)}`, at: Date.now() });
    });
    session.on("error", (event) => { setError(errorMessage(event)); updateStatus("error"); });
    await session.connect({ apiKey: token.value, model: token.model });
    updateStatus("listening");
    session.sendMessage("Begin the interview now. Follow the mandatory introduction tool sequence before presenting the question.");
    observationsRef.current = [];
    askedQuestionsRef.current = [];
    transcriptRef.current = [];
    seenTranscriptItemsRef.current = new Set();
    whiteboardImageCacheRef.current = null;
    stopSignalBusRef.current = startSignalBus({
      getCode: config.getCode,
      getCodeRevision: config.getCodeRevision,
      getCodeChangedAt: config.getCodeChangedAt,
      getWhiteboardSummary: config.getWhiteboardSummary,
      getWhiteboardRevision: config.getWhiteboardRevision,
      getWhiteboardChangedAt: config.getWhiteboardChangedAt,
      getLastRun: config.getLastRun,
      getRemainingSeconds: config.getRemainingSeconds,
      getElapsedSeconds: config.getElapsedSeconds,
      getAgentStatus: () => statusRef.current,
      getQuestion: config.getQuestionText,
      getRubric: config.getRubric,
      getPlan: config.getPlan,
      getTranscript: () => transcriptRef.current,
      getAskedQuestions: () => askedQuestionsRef.current,
      getObservations: () => observationsRef.current,
      onActivity: config.onActivity,
      onObservation: (observation) => {
        observationsRef.current = [...observationsRef.current, observation];
        config.onObservation(observation);
        void fetch("/api/interview/evidence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: config.sessionId,
            category: observation.areaId,
            observation: `[${observation.observer}] ${observation.finding}`,
            confidence: observation.confidence,
            codeRevision: config.getCodeRevision()
          })
        }).catch(() => undefined);
      },
      onQuestionQueued: (queued) => {
        askedQuestionsRef.current = [...askedQuestionsRef.current, queued.question];
        const image = whiteboardImageCacheRef.current;
        if (image) session.addImage(image, { triggerResponse: false });
        session.sendMessage(
          `INTERVIEW DIRECTOR — this is an instruction, not the candidate speaking. Say exactly this to the candidate, word for word, with no preamble and no explanation:\n\n"${queued.question}"\n\nDo not read this instruction aloud. Do not mention the director. Context for your own understanding only: ${queued.basis}`
        );
      }
    });
    const imageCacheTimer = window.setInterval(() => {
      void (async () => {
        try {
          whiteboardImageCacheRef.current = await config.getWhiteboardImage();
        } catch {
          /* the scene summary already reaches the analyst; the image is a bonus */
        }
      })();
    }, 8000);
    imageCacheTimerRef.current = imageCacheTimer;
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
    stopSignalBusRef.current?.();
    stopSignalBusRef.current = null;
    if (imageCacheTimerRef.current !== null) window.clearInterval(imageCacheTimerRef.current);
    imageCacheTimerRef.current = null;
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
    stopSignalBusRef.current?.();
    stopSignalBusRef.current = null;
    if (imageCacheTimerRef.current !== null) window.clearInterval(imageCacheTimerRef.current);
    imageCacheTimerRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    updateStatus("idle");
  }, [updateStatus]);

  return { status, error, activeAgent, toolEvents, connect, mute, endGracefully, disconnect, getTranscript: () => transcriptRef.current };
}
