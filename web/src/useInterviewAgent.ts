import { useCallback, useRef, useState } from "react";
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC, tool } from "@openai/agents/realtime";
import { z } from "zod";
import type { RunResult } from "./runner/types";
import type { ActivityRow, InterviewPlan, Observation, TranscriptTurn } from "./orchestrator/types";
import { startSignalBus, type SignalBus } from "./orchestrator/signalBus";
import { zeroHintGuardrailWithApprovedQuestion } from "./orchestrator/guardrails";
import type { PreparedInterview } from "./setup/prepared";
import { createQuestionDeliveryTracker, realtimeResponseText, type QuestionDeliveryTracker } from "./orchestrator/questionDelivery";
import {
  createRealtimeBootstrapAdapter,
  createRealtimeBootstrapLifecycle,
  createRealtimeTranscriptStore,
  realtimeGuardrailIdentity,
  realtimePlaybackStoppedResponse,
  realtimeToolChoiceOverride,
  type RealtimeBootstrapLifecycle,
  type RealtimeTranscriptStore
} from "./orchestrator/realtimeBootstrap";
import {
  buildEvidenceRequest,
  postCompletionRequest,
  serializeEvidenceRequest,
  type CompletionRequest
} from "./runtimeContracts";

export type AgentStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ending" | "error";

export type InterviewAgentConfig = {
  sessionId: string;
  candidate: string;
  role: string;
  durationSeconds: number;
  guide: PreparedInterview;
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
  onEvidenceError: (message: string, retry: () => Promise<void>) => void;
  onTranscriptTurn?: (turn: TranscriptTurn) => void;
  onQuestion: (question: string) => void;
  onQuestionDelivered: (question: string, at: number) => void;
  onCompletionError: (message: string) => void;
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
  const signalBusRef = useRef<SignalBus | null>(null);
  const transcriptStoreRef = useRef<RealtimeTranscriptStore | null>(null);
  const whiteboardImageCacheRef = useRef<{ revision: number; image: string } | null>(null);
  const imageCacheTimerRef = useRef<number | null>(null);
  const statusRef = useRef<AgentStatus>("idle");
  const bootstrapRef = useRef<RealtimeBootstrapLifecycle<RealtimeAgent> | null>(null);
  const deliveryTrackerRef = useRef<QuestionDeliveryTracker | null>(null);
  const tokenCacheRef = useRef<{ sessionId: string; value: string; model: string } | null>(null);
  const closedInterviewRef = useRef(false);
  const requestedMutedRef = useRef(false);

  const updateStatus = useCallback((next: AgentStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const logTool = useCallback((name: string, state: ToolEvent["state"]) => {
    setToolEvents((events) => [...events.slice(-7), { name, state, at: Date.now() }]);
  }, []);

  const closeNow = useCallback((reason: string) => {
    if (closedInterviewRef.current) return;
    closedInterviewRef.current = true;
    if (endFallbackRef.current !== null) window.clearTimeout(endFallbackRef.current);
    endFallbackRef.current = null;
    signalBusRef.current?.stop();
    signalBusRef.current = null;
    if (imageCacheTimerRef.current !== null) window.clearInterval(imageCacheTimerRef.current);
    imageCacheTimerRef.current = null;
    const bootstrap = bootstrapRef.current;
    bootstrap?.stop();
    if (bootstrap) bootstrap.close();
    else sessionRef.current?.close();
    bootstrapRef.current = null;
    sessionRef.current = null;
    tokenCacheRef.current = null;
    deliveryTrackerRef.current?.reset();
    deliveryTrackerRef.current = null;
    updateStatus("idle");
    const config = configRef.current;
    configRef.current = null;
    config?.onFinished(reason);
  }, [updateStatus]);

  const connect = useCallback(async (config: InterviewAgentConfig) => {
    const previousBootstrap = bootstrapRef.current;
    previousBootstrap?.stop();
    if (previousBootstrap) previousBootstrap.close();
    else sessionRef.current?.close();
    bootstrapRef.current = null;
    configRef.current = config;
    closedInterviewRef.current = false;
    endingRef.current = false;
    requestedMutedRef.current = false;
    closingAudioRef.current = false;
    setActiveAgent("Introduction Agent");
    updateStatus("connecting");
    setError("");
    setToolEvents([]);
    transcriptStoreRef.current = createRealtimeTranscriptStore(config.onTranscriptTurn);
    config.media.getAudioTracks().forEach((track) => { track.enabled = false; });
    const deliveryTracker = createQuestionDeliveryTracker((question, at) => {
      void bootstrapRef.current?.confirmPrimaryDelivery(question, at);
    });
    deliveryTracker.queue(config.guide.question.prompt);
    deliveryTrackerRef.current = deliveryTracker;

    const getInterviewContext = tool({
      name: "get_interview_context",
      description: "Mandatory first tool. Retrieve the prepared interview guide before introducing the interview.",
      parameters: z.object({}),
      async execute() {
        const bootstrap = bootstrapRef.current;
        if (!bootstrap) throw new Error("The introduction sequence is unavailable.");
        return bootstrap.runTool("get_interview_context", () => ({
          candidate: config.candidate,
          role: config.guide.role,
          roleMission: config.guide.roleMission,
          interviewType: config.guide.interview.type,
          codingLanguage: config.guide.interview.codingLanguage,
          durationMinutes: Math.round(config.durationSeconds / 60),
          brief: config.guide.brief,
          questionTypes: config.guide.interview.questionTypes,
          pattern: config.guide.pattern,
          candidateFocus: config.guide.candidateFocus,
          candidateAccess: {
            workspaces: config.guide.interview.workspaces,
            tools: config.guide.interview.tools,
            channels: config.guide.interview.channels
          },
          evidenceRule: "Candidate context can tailor questions. Treat only evidence observed during this interview as scoring evidence."
        }));
      }
    });

    const fetchInterviewQuestion = tool({
      name: "fetch_interview_question",
      description: "Mandatory second tool. Read the primary question from the prepared interview guide.",
      parameters: z.object({}),
      async execute() {
        const bootstrap = bootstrapRef.current;
        if (!bootstrap) throw new Error("The introduction sequence is unavailable.");
        return bootstrap.runTool("fetch_interview_question", () => {
          config.onQuestion(config.guide.question.prompt);
          return {
            id: config.guide.question.id,
            prompt: config.guide.question.prompt,
            language: config.guide.question.language
          };
        });
      }
    });

    const readRubric = tool({
      name: "read_interview_rubric",
      description: "Mandatory third tool. Read the recruiter-provided rubric textbox before asking substantive questions.",
      parameters: z.object({ reason: z.string().describe("Why the rubric is needed at this point") }),
      async execute({ reason }) {
        const bootstrap = bootstrapRef.current;
        if (!bootstrap) throw new Error("The introduction sequence is unavailable.");
        return bootstrap.runTool("read_interview_rubric", () => ({
          reason,
          criteria: config.guide.rubric.criteria.map((criterion) => ({
            id: criterion.id,
            name: criterion.name,
            weight: criterion.weight,
            expectedEvidence: criterion.expectedEvidence
          }))
        }));
      }
    });

    const getCurrentCode = tool({
      name: "get_current_code",
      description: "Inspect the exact current Monaco editor contents before discussing or judging the implementation.",
      parameters: z.object({ reason: z.string() }),
      async execute({ reason }) {
        return { reason, language: config.guide.question.language, revision: config.getCodeRevision(), code: config.getCode() };
      }
    });

    const getCurrentWorkspace = tool({
      name: "get_current_workspace",
      description: "Inspect the candidate's current code and the structured tldraw scene summary before asking about either artifact.",
      parameters: z.object({ reason: z.string() }),
      async execute({ reason }) {
        return {
          reason,
          ...(config.guide.interview.workspaces.includes("code_editor") ? { code: {
            language: config.guide.question.language,
            revision: config.getCodeRevision(),
            contents: config.getCode()
          } } : {}),
          ...(config.guide.interview.workspaces.includes("whiteboard") ? { whiteboard: {
            revision: config.getWhiteboardRevision(),
            summary: config.getWhiteboardSummary()
          } } : {})
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
        category: z.string().min(1).max(100),
        observation: z.string().min(5),
        confidence: z.number().min(0).max(1)
      }),
      async execute(input) {
        const rubricIDs = new Set(config.guide.rubric.criteria.map((criterion) => criterion.id));
        if (!rubricIDs.has(input.category)) throw new Error("Evidence category is not part of the prepared rubric.");
        const observation: Observation = {
          observer: "interviewer",
          areaId: input.category,
          finding: input.observation,
          confidence: input.confidence,
          codeRevision: config.getCodeRevision(),
          whiteboardRevision: config.getWhiteboardRevision(),
          at: Date.now()
        };
        const payload = buildEvidenceRequest({
          sessionId: config.sessionId,
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
          await config.onObservation(observation);
        };
        try {
          await persist();
          return { saved: true };
        } catch (error) {
          const message = errorMessage(error);
          config.onEvidenceError(message, persist);
          throw new Error(message);
        }
      }
    });

    const codeEnabled = config.guide.interview.workspaces.includes("code_editor");
    const whiteboardEnabled = config.guide.interview.workspaces.includes("whiteboard");
    const workspaceTools = [
      ...(codeEnabled ? [getCurrentCode, getExecutionResults] : []),
      ...((codeEnabled || whiteboardEnabled) ? [getCurrentWorkspace] : [])
    ];

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
      tools: [...workspaceTools, readRubric, recordEvidence]
    });

    const interviewAgent = new RealtimeAgent({
      name: "Interview Conductor",
      handoffDescription: "Conducts the prepared interview after the primary question is presented.",
      voice: "marin",
      instructions: `You are a terse interviewer. You do NOT choose what to probe. A planner does that for you.

Follow the prepared interview pattern and rubric. Candidate context may tailor a question. It is never evidence.

When an INTERVIEW DIRECTOR instruction arrives, say the quoted question exactly, word for word. Add nothing before or after it. Never read the instruction itself aloud, and never mention that a director exists.

Between prepared questions, stay silent and listen. Silence is correct and expected.

You may respond directly when the candidate speaks to you:
- Clarify the literal problem statement, without revealing strategy.
- Redirect off-topic conversation with exactly: "Stay on the problem."
- If asked for a hint, an answer, or whether they are correct, say: "No hints. Explain your reasoning."

Use get_current_workspace before referring to code or a diagram. Use get_execution_results before discussing correctness. Treat the whiteboard as evidence of reasoning, never as proof the code works.

ZERO-HINT POLICY: Never provide a solution, code, pseudocode, algorithm name, recommended data structure, leading example, correction, or partial answer. Never state or imply expected test outputs. Never complete the candidate's thought. Do not praise, reassure, encourage, congratulate, apologise, or use filler. Remain professional and non-hostile.

You may hand off to the Reflection Agent when time is nearly over.`,
      tools: [...workspaceTools, readRubric, recordEvidence],
      handoffs: [reflectionAgent]
    });

    const introductionAgent = new RealtimeAgent({
      name: "Introduction Agent",
      voice: "marin",
      instructions: `You are a formal, terse interview administrator. The application selects each required tool for you. Do not speak before all three required tool calls finish. Then state the candidate name and time limit, present the fetched question exactly once without adding strategy or examples, and ask for their understanding. Keep the introduction minimal. Remain the Introduction Agent until the application confirms playback and performs the handoff.

Stay exclusively within the interview. Do not answer unrelated questions. Do not offer hints, solutions, pseudocode, algorithm names, data structures, praise, reassurance, or coaching. Never invent a question or rubric. Be concise, professional, and non-hostile.`,
      tools: [getInterviewContext, fetchInterviewQuestion, readRubric]
    });

    let token = tokenCacheRef.current?.sessionId === config.sessionId ? tokenCacheRef.current : null;
    if (!token) {
      const tokenResponse = await fetch("/api/realtime/token", { method: "POST" });
      if (!tokenResponse.ok) throw new Error((await tokenResponse.text()).trim() || "Could not create a Realtime token.");
      const body = await tokenResponse.json() as { value?: string; model?: string };
      if (!body.value) throw new Error("Realtime token response was invalid.");
      if (!body.model) throw new Error("Realtime token model was missing.");
      token = { sessionId: config.sessionId, value: body.value, model: body.model };
      tokenCacheRef.current = token;
    }

    const transport = new OpenAIRealtimeWebRTC({ mediaStream: config.media });
    const session = new RealtimeSession(introductionAgent, {
      transport,
      model: token.model,
      workflowName: "Automated Interview",
      groupId: config.sessionId,
      traceMetadata: { sessionId: config.sessionId, role: config.role },
      outputGuardrails: [
        zeroHintGuardrailWithApprovedQuestion(
          config.guide.question.prompt,
          () => deliveryTrackerRef.current?.isPendingQuestion(config.guide.question.prompt) === true
        )
      ],
      config: {
        // Connection is speech-safe and unforced. begin() applies the first exact
        // tool choice and waits for its server acknowledgement before responding.
        toolChoice: "auto",
        parallelToolCalls: false,
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
    const bootstrapAdapter = createRealtimeBootstrapAdapter<RealtimeAgent>({
      updateToolChoice: async (choice) => {
        // Rebuild the complete config so a phase change cannot reset audio,
        // instructions, tools, or parallel-call settings to transport defaults.
        const nextConfig = await session.getInitialSessionConfig(realtimeToolChoiceOverride(choice));
        session.transport.updateSessionConfig(nextConfig);
      },
      onTransportEvent: (listener) => {
        const onEvent = (event: unknown) => listener(event);
        session.on("transport_event", onEvent);
        return () => session.off("transport_event", onEvent);
      },
      requestResponse: () => {
        if (session.transport.requestResponse) session.transport.requestResponse();
        else session.transport.sendEvent({ type: "response.create" });
      },
      updateAgent: (agent) => session.updateAgent(agent),
      removeHistoryItem: (itemId) => session.updateHistory((history) => history.filter((item) => item.itemId !== itemId)),
      close: () => session.close()
    });
    bootstrapRef.current = createRealtimeBootstrapLifecycle({
      adapter: bootstrapAdapter,
      approvedQuestion: config.guide.question.prompt,
      conductor: interviewAgent,
      timeoutMs: 20_000,
      onHandoff: () => setActiveAgent(interviewAgent.name),
      onDelivered: (question, at) => {
        session.mute(requestedMutedRef.current);
        askedQuestionsRef.current = [...askedQuestionsRef.current, question];
        signalBusRef.current?.notifyQuestionDelivered(at);
        config.onQuestionDelivered(question, at);
      }
    });
    session.on("agent_start", () => updateStatus("thinking"));
    session.on("agent_end", () => { if (!endingRef.current) updateStatus("listening"); });
    session.on("audio_start", () => { if (endingRef.current) closingAudioRef.current = true; updateStatus(endingRef.current ? "ending" : "speaking"); });
    // SDK audio_stopped marks response audio generation, not WebRTC playback.
    // Delivery and closing wait for raw output_audio_buffer.stopped below.
    session.on("audio_stopped", () => undefined);
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
      const responseId = String(event?.response_id ?? event?.response?.id ?? "");
      const itemId = String(event?.item_id ?? "");
      if (responseId && itemId) deliveryTrackerRef.current?.associateItem(responseId, itemId);
      const playbackResponseId = realtimePlaybackStoppedResponse(event);
      if (playbackResponseId) {
        transcriptStoreRef.current?.commitAssistantHistory();
        deliveryTrackerRef.current?.confirmCompleted(playbackResponseId, Date.now());
        if (endingRef.current && closingAudioRef.current) closeNow(endingReasonRef.current);
        else if (!endingRef.current) updateStatus("listening");
        return;
      }
      if (event?.type === "response.created") {
        deliveryTrackerRef.current?.associateResponse(String(event.response?.id ?? ""));
        return;
      }
      if (event?.type === "response.done") {
        const completedResponseId = String(event.response?.id ?? "");
        for (const output of Array.isArray(event.response?.output) ? event.response.output : []) {
          const outputId = String(output?.id ?? "");
          if (outputId) deliveryTrackerRef.current?.associateItem(completedResponseId, outputId);
        }
        const containsPrimaryQuestion = deliveryTrackerRef.current?.completeResponse(completedResponseId, realtimeResponseText(event)) === true;
        if (containsPrimaryQuestion && !config.voiceEnabled) {
          transcriptStoreRef.current?.commitAssistantHistory();
          deliveryTrackerRef.current?.confirmCompleted(completedResponseId, Date.now());
        }
        return;
      }
      if (event?.type !== "conversation.item.input_audio_transcription.completed") return;
      transcriptStoreRef.current?.addCandidate(String(event.item_id ?? ""), String(event.transcript ?? ""), Date.now());
    });
    session.on("history_updated", (history: any[]) => {
      transcriptStoreRef.current?.syncAssistantHistory(history, Date.now());
    });
    session.on("guardrail_tripped", (_context, _agent, guardrailError, details) => {
      const blocked = realtimeGuardrailIdentity(guardrailError, details);
      transcriptStoreRef.current?.rejectAssistantItem(blocked.itemId);
      deliveryTrackerRef.current?.rejectItem(blocked.itemId);
      if (blocked.itemId) bootstrapAdapter.removeHistoryItem(blocked.itemId);
      config.onActivity({ type: "guardrail", text: `${blocked.name} blocked item ${blocked.itemId || "unknown"}`, at: Date.now() });
    });
    session.on("error", (event) => { setError(errorMessage(event)); updateStatus("error"); });
    await session.connect({ apiKey: token.value, model: token.model });
    session.mute(true);
    updateStatus("listening");
    observationsRef.current = [];
    askedQuestionsRef.current = [];
    whiteboardImageCacheRef.current = null;
    const commitPlannerObservation = (observation: Observation) => {
      if (observationsRef.current.includes(observation)) return;
      observationsRef.current = [...observationsRef.current, observation];
      config.onObservation(observation);
    };
    signalBusRef.current = startSignalBus({
      getCode: config.getCode,
      getCodeRevision: config.getCodeRevision,
      getCodeChangedAt: config.getCodeChangedAt,
      getWhiteboardSummary: config.getWhiteboardSummary,
      getWhiteboardRevision: config.getWhiteboardRevision,
      getWhiteboardChangedAt: config.getWhiteboardChangedAt,
      getLastRun: config.getLastRun,
      getRemainingSeconds: config.getRemainingSeconds,
      getElapsedSeconds: config.getElapsedSeconds,
      getAgentStatus: () => deliveryTrackerRef.current?.hasPending() ? "thinking" : statusRef.current,
      getQuestion: config.getQuestionText,
      getRubric: config.getRubric,
      getPlan: config.getPlan,
      getTranscript: () => transcriptStoreRef.current?.turns() ?? [],
      getAskedQuestions: () => askedQuestionsRef.current,
      getObservations: () => observationsRef.current,
      onActivity: config.onActivity,
      onObservation: (observation) => {
        const payload = buildEvidenceRequest({
          sessionId: config.sessionId,
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
        return persist().catch((error) => {
          const message = errorMessage(error);
          config.onEvidenceError(message, async () => {
            await persist();
            commitPlannerObservation(observation);
          });
          throw error;
        });
      },
      onObservationCommitted: commitPlannerObservation,
      onQuestionQueued: (queued) => {
        if (!deliveryTrackerRef.current?.queue(queued.question)) return;
        const cached = whiteboardImageCacheRef.current;
        if (cached?.revision === config.getWhiteboardRevision()) session.addImage(cached.image, { triggerResponse: false });
        session.sendMessage(
          `INTERVIEW DIRECTOR — this is an instruction, not the candidate speaking. Say exactly this to the candidate, word for word, with no preamble and no explanation:\n\n"${queued.question}"\n\nDo not read this instruction aloud. Do not mention the director. Context for your own understanding only: ${queued.basis}`
        );
      }
    });
    const imageCacheTimer = window.setInterval(() => {
      void (async () => {
        try {
          const beforeRevision = config.getWhiteboardRevision();
          const image = await config.getWhiteboardImage();
          const afterRevision = config.getWhiteboardRevision();
          if (image && beforeRevision === afterRevision) whiteboardImageCacheRef.current = { revision: afterRevision, image };
        } catch {
          /* the scene summary already reaches the analyst; the image is a bonus */
        }
      })();
    }, 8000);
    imageCacheTimerRef.current = imageCacheTimer;
  }, [closeNow, logTool, updateStatus]);

  const begin = useCallback(async () => {
    const bootstrap = bootstrapRef.current;
    if (!bootstrap || !sessionRef.current) throw new Error("The voice interview session is not connected.");
    await bootstrap.begin();
  }, []);

  const mute = useCallback((muted: boolean) => {
    requestedMutedRef.current = muted;
    if (bootstrapRef.current?.isDelivered()) sessionRef.current?.mute(muted);
    else sessionRef.current?.mute(true);
  }, []);

  const endGracefully = useCallback(async (payload: CompletionRequest) => {
    const config = configRef.current;
    const session = sessionRef.current;
    if (!config || !session || endingRef.current) return;
    endingRef.current = true;
    endingReasonRef.current = payload.reason;
    closingAudioRef.current = false;
    const completingBootstrap = bootstrapRef.current?.cancelForCompletion() === true;
    updateStatus("ending");
    signalBusRef.current?.stop();
    signalBusRef.current = null;
    if (imageCacheTimerRef.current !== null) window.clearInterval(imageCacheTimerRef.current);
    imageCacheTimerRef.current = null;
    try { session.mute(true); } catch { /* transport may already be closing */ }
    session.interrupt();
    try {
      await postCompletionRequest(payload);
    } catch (error) {
      endingRef.current = false;
      updateStatus("listening");
      config.onCompletionError(errorMessage(error));
      return;
    }
    if (completingBootstrap || bootstrapRef.current?.isDelivered() !== true) {
      closeNow(payload.reason);
      return;
    }
    session.sendMessage(payload.reason === "time_limit"
      ? "The interview time limit has been reached. State only that time is up and the interview is complete. Do not summarize performance, praise the candidate, provide answers, or ask another question."
      : "The candidate has ended the interview. State only that the interview is complete. Do not summarize performance, praise the candidate, provide answers, or ask another question.");
    endFallbackRef.current = window.setTimeout(() => closeNow(payload.reason), 10000);
  }, [closeNow, updateStatus]);

  const disconnect = useCallback((preserveStartup = false) => {
    closedInterviewRef.current = true;
    endingRef.current = false;
    if (endFallbackRef.current !== null) window.clearTimeout(endFallbackRef.current);
    endFallbackRef.current = null;
    signalBusRef.current?.stop();
    signalBusRef.current = null;
    if (imageCacheTimerRef.current !== null) window.clearInterval(imageCacheTimerRef.current);
    imageCacheTimerRef.current = null;
    const bootstrap = bootstrapRef.current;
    bootstrap?.stop();
    if (bootstrap) bootstrap.close();
    else sessionRef.current?.close();
    bootstrapRef.current = null;
    sessionRef.current = null;
    if (!preserveStartup) tokenCacheRef.current = null;
    configRef.current = null;
    transcriptStoreRef.current = null;
    deliveryTrackerRef.current?.reset();
    deliveryTrackerRef.current = null;
    updateStatus("idle");
  }, [updateStatus]);

  return { status, error, activeAgent, toolEvents, connect, begin, mute, endGracefully, disconnect, getTranscript: () => transcriptStoreRef.current?.turns() ?? [] };
}
