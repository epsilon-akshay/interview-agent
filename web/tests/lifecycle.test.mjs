import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIRealtimeWebSocket, RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";
import {
  canDispatchQuestion,
  canPrecomputeQuestion,
  isLiveAnalysis,
  plannerFingerprint,
  validatePlannerOutput,
  stripApprovedPrompt,
  zeroHintGuardrailWithApprovedQuestion,
  zeroHintViolation,
  startSignalBus,
  createQuestionDeliveryTracker,
  createRealtimeBootstrapAdapter,
  createRealtimeBootstrapLifecycle,
  createRealtimeTranscriptStore,
  realtimeGuardrailIdentity,
  realtimePlaybackStoppedResponse,
  realtimeToolChoiceOverride,
  buildArtifactRequest,
  buildEvaluationRequest,
  buildEvidenceRequest,
  captureStableWhiteboard,
  compatibleInterviewDefaults,
  compatibleQuestionTypes,
  completionResponseAccepted,
  createCompletionLifecycle,
  ensureStartupCache,
  postArtifactRequest,
  postCompletionRequest,
  retainCompletionRequest,
  retainNewestWhiteboard,
  serializeEvidenceRequest
} from "./.compiled/test-modules.mjs";

const deliveredAt = 1_000_000;
const ready = (patch = {}) => ({
  now: deliveredAt + 45_000,
  lastQuestionAt: deliveredAt,
  codeChangedAt: deliveredAt - 3_000,
  whiteboardChangedAt: deliveredAt - 2_000,
  status: "listening",
  remainingSeconds: 21,
  ...patch
});

test("questions wait for delivery, quiet work, listening status, and remaining time", () => {
  assert.equal(canDispatchQuestion(ready()), true);
  assert.equal(canDispatchQuestion(ready({ now: deliveredAt + 44_999 })), false);
  assert.equal(canDispatchQuestion(ready({ codeChangedAt: deliveredAt + 42_001 })), false);
  assert.equal(canDispatchQuestion(ready({ whiteboardChangedAt: deliveredAt + 43_001 })), false);
  assert.equal(canDispatchQuestion(ready({ status: "speaking" })), false);
  assert.equal(canDispatchQuestion(ready({ remainingSeconds: 20 })), false);
});

test("planner fingerprint invalidates a precompute for every material input", () => {
  const base = {
    kind: "code_changed",
    codeRevision: 3,
    whiteboardRevision: 4,
    lastRunAt: 5,
    lastRunRevision: 3,
    transcript: "candidate:6:hello",
    timingState: "1000:0:open",
    planState: "area:0",
    askedState: ""
  };
  const key = plannerFingerprint(base);
  assert.notEqual(plannerFingerprint({ ...base, kind: "tests_run" }), key);
  assert.notEqual(plannerFingerprint({ ...base, codeRevision: 4 }), key);
  assert.notEqual(plannerFingerprint({ ...base, whiteboardRevision: 5 }), key);
  assert.notEqual(plannerFingerprint({ ...base, lastRunAt: 6 }), key);
  assert.notEqual(plannerFingerprint({ ...base, transcript: "candidate:7:changed" }), key);
  assert.notEqual(plannerFingerprint({ ...base, timingState: "1000:1:open" }), key);
  assert.notEqual(plannerFingerprint({ ...base, planState: "area:1" }), key);
  assert.notEqual(plannerFingerprint({ ...base, askedState: "What changed?" }), key);
});

test("precompute only starts in its one quiet lead window and cancelled work becomes inert", () => {
  const precompute = { ...ready(), now: deliveredAt + 35_000 };
  assert.equal(canPrecomputeQuestion(precompute), true);
  assert.equal(canPrecomputeQuestion({ ...precompute, status: "thinking" }), false);
  assert.equal(canPrecomputeQuestion({ ...precompute, codeChangedAt: precompute.now - 2_999 }), false);
  assert.equal(isLiveAnalysis(4, 4, false), true);
  assert.equal(isLiveAnalysis(4, 5, false), false);
  assert.equal(isLiveAnalysis(4, 4, true), false);
});

test("planner business validation suppresses unsafe output", () => {
  const output = {
    observations: [
      { source: "code", areaId: "known", finding: "uses a loop", confidence: 0.8 },
      { source: "code", areaId: "invented", finding: "bad", confidence: 0.5 },
      { source: "speech", areaId: "known", finding: "", confidence: 1.2 }
    ],
    shouldAsk: true,
    areaId: "invented",
    question: "What happens next? And why?",
    basis: ""
  };
  const result = validatePlannerOutput(output, ["known"]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.question, null);
  assert.ok(result.validationErrors.length >= 4);
});

test("planner validation blocks leakage and repetition but permits terse probes", () => {
  const base = { observations: [], shouldAsk: true, areaId: "known", basis: "candidate code changed" };
  const rejected = [
    "Try using a hash map?",
    "Great job, what now?",
    "That is correct, why?",
    "Write function solve(x)?"
  ];
  for (const question of rejected) {
    const result = validatePlannerOutput({ ...base, question }, ["known"], { approvedPrompt: "Explain your loop.", askedQuestions: [] });
    assert.equal(result.question, null, question);
  }
  const repeated = validatePlannerOutput({ ...base, question: "Which invariant does your loop maintain?" }, ["known"], {
    approvedPrompt: "Explain your loop.",
    askedQuestions: ["Which invariant does your loop maintain?"]
  });
  assert.equal(repeated.question, null);
  const valid = validatePlannerOutput({ ...base, question: "Which invariant does your loop maintain?" }, ["known"], {
    approvedPrompt: "Explain your loop.",
    askedQuestions: []
  });
  assert.equal(valid.question?.areaId, "known");
  const approvedTerm = validatePlannerOutput({ ...base, question: "Why does the hash map stay bounded?" }, ["known"], {
    approvedPrompt: "Use the supplied hash map implementation.",
    askedQuestions: []
  });
  assert.ok(approvedTerm.question);
});

test("one safety policy blocks solution advice in findings and questions", () => {
  const unsafeFinding = validatePlannerOutput({
    observations: [{ source: "speech", areaId: "known", finding: "Great job. Use a Map; that is correct.", confidence: 0.8 }],
    shouldAsk: false,
    areaId: "",
    question: "",
    basis: ""
  }, ["known"], { approvedPrompt: "Explain your loop." });
  assert.equal(unsafeFinding.observations.length, 0);
  assert.match(unsafeFinding.validationErrors.join(" "), /praise|solution term|correctness/i);

  const unsafeQuestion = validatePlannerOutput({
    observations: [],
    shouldAsk: true,
    areaId: "known",
    question: "Would a Map solve this?",
    basis: "candidate described a lookup"
  }, ["known"], { approvedPrompt: "Explain your loop." });
  assert.equal(unsafeQuestion.question, null);
  assert.equal(zeroHintViolation("Would a Map solve this?", "Explain your loop."), "introduces solution term map");
  assert.equal(zeroHintViolation("Would a Map solve this?", "Explain this Map lookup."), null);
});

test("shared safety rejects confidence, hesitation, uncertainty, and hostility judgments", async () => {
  const judgments = [
    "The candidate lacked confidence.",
    "The candidate seemed hesitant.",
    "The candidate was uncertain.",
    "They displayed hostility.",
    "She appeared friendly.",
    "Their hesitation was obvious."
  ];
  for (const finding of judgments) {
    const result = validatePlannerOutput({
      observations: [{ source: "speech", areaId: "known", finding, confidence: 0.8 }],
      shouldAsk: false,
      areaId: "",
      question: "",
      basis: ""
    }, ["known"], { approvedPrompt: "Explain the API behavior." });
    assert.equal(result.observations.length, 0, finding);
    assert.match(result.validationErrors.join(" "), /personality or emotion judgment/, finding);
    assert.equal(zeroHintViolation(finding, "Explain the API behavior."), "personality or emotion judgment", finding);
    const realtimeResult = await zeroHintGuardrailWithApprovedQuestion("Explain the API behavior.").execute({ agentOutput: finding });
    assert.equal(realtimeResult.tripwireTriggered, true, finding);
  }
  assert.equal(zeroHintViolation("The candidate calculated a confidence interval.", "Explain the API behavior."), null);
  assert.equal(zeroHintViolation("The candidate tested hostile input.", "Explain the API behavior."), null);
});

test("behavioral defaults remove coding-only settings after owner edits", () => {
  assert.deepEqual(compatibleInterviewDefaults("behavioral"), {
    codingLanguage: "",
    questionTypes: ["behavioral"],
    workspaces: []
  });
  assert.deepEqual(
    compatibleQuestionTypes("behavioral", ["debugging", "complexity", "behavioral"]),
    ["behavioral"]
  );
});

test("evidence payload serializes the complete stable contract", () => {
  const eventId = "0123456789abcdef0123456789abcdef";
  const payload = buildEvidenceRequest({
    sessionId: "abcdef0123456789abcdef0123456789",
    category: "reasoning",
    observation: "Explained the invariant.",
    confidence: 0.8,
    codeRevision: 7,
    whiteboardRevision: 4
  }, eventId);
  assert.deepEqual(Object.keys(payload), ["eventId", "sessionId", "category", "observation", "confidence", "codeRevision", "whiteboardRevision"]);
  assert.match(payload.eventId, /^[0-9a-f]{32}$/);
  const first = serializeEvidenceRequest(payload);
  const retry = serializeEvidenceRequest(payload);
  assert.equal(retry, first);
  assert.deepEqual(JSON.parse(first), payload);
  assert.throws(() => buildEvidenceRequest({ ...payload }, "not-an-event-id"));
});

test("completion retains the first exact payload and rejects conflict as success", () => {
  const first = { sessionId: "session", reason: "time_limit", elapsedSeconds: 300 };
  const retained = retainCompletionRequest(null, first);
  const retry = retainCompletionRequest(retained, { sessionId: "session", reason: "manual", elapsedSeconds: 301 });
  assert.strictEqual(retry, retained);
  assert.deepEqual(retry, first);
  assert.equal(completionResponseAccepted(200), true);
  assert.equal(completionResponseAccepted(204), true);
  assert.equal(completionResponseAccepted(409), false);
});

test("completion stays ending during a slow failure and retries the same payload", async () => {
  const endingChanges = [];
  const lifecycle = createCompletionLifecycle((value) => endingChanges.push(value));
  const original = lifecycle.begin({ sessionId: "session", reason: "manual", elapsedSeconds: 42 });
  assert.equal(lifecycle.isEnding(), true);
  assert.deepEqual(endingChanges, [true]);
  assert.strictEqual(lifecycle.startAttempt(), original);

  let release;
  const slowResponse = new Promise((resolve) => { release = resolve; });
  const request = postCompletionRequest(original, async () => slowResponse);
  assert.equal(lifecycle.isEnding(), true);
  assert.equal(lifecycle.isAttempting(), true);
  release({ status: 503, text: async () => "storage unavailable" });
  await assert.rejects(request, /storage unavailable/);
  lifecycle.finishAttempt();
  assert.equal(lifecycle.isEnding(), true);
  assert.strictEqual(lifecycle.pending(), original);
  assert.strictEqual(lifecycle.startAttempt(), original);
});

test("whiteboard capture retries revision races and never replaces newer artifacts", async () => {
  const snapshots = [
    { revision: 1, changedAt: 1, elementCount: 1, summary: "one" },
    { revision: 2, changedAt: 2, elementCount: 2, summary: "two" },
    { revision: 2, changedAt: 2, elementCount: 2, summary: "two" },
    { revision: 2, changedAt: 2, elementCount: 2, summary: "two" }
  ];
  let snapshotIndex = 0;
  let exportAttempt = 0;
  const result = await captureStableWhiteboard({
    getSnapshot: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    exportPng: async () => `png-${++exportAttempt}`,
    exportSceneJson: async () => `scene-${exportAttempt}`
  }, 3);
  assert.equal(result.revision, 2);
  assert.equal(result.image, "png-2");
  const newer = { ...result, revision: 3, snapshot: { ...result.snapshot, revision: 3 } };
  assert.strictEqual(retainNewestWhiteboard(newer, result), newer);
});

test("bootstrap guard permits cumulative approved prompt chunks only while pending", () => {
  const prompt = "Write a function sum(values) and explain complexity.";
  const chunk = "Alex, your question is: Write a function sum(";
  assert.equal(zeroHintViolation(chunk, prompt, true), null);
  assert.equal(stripApprovedPrompt(chunk, prompt, true), "Alex, your question is: ");
  assert.equal(zeroHintViolation(chunk, prompt, false), "code or pseudocode");
  assert.equal(zeroHintViolation(`${prompt} function answer() {`, prompt, true), "code or pseudocode");
});

test("question delivery binds one normalized response and confirms at playback completion", () => {
  const delivered = [];
  const tracker = createQuestionDeliveryTracker((question, at) => delivered.push({ question, at }));
  assert.equal(tracker.queue("Which invariant does your loop maintain?"), true);
  assert.equal(tracker.queue("A second pending question?"), false);
  tracker.associateResponse("response-1");
  assert.equal(tracker.completeResponse("response-other", "Which invariant does your loop maintain?"), false);
  assert.equal(tracker.completeResponse("response-1", "**Which invariant** does your loop\nmaintain?"), true);
  assert.equal(delivered.length, 0);
  assert.equal(tracker.confirmCompleted("response-1", 1_234_567), true);
  assert.deepEqual(delivered, [{ question: "Which invariant does your loop maintain?", at: 1_234_567 }]);
  assert.equal(tracker.hasPending(), false);
});

function realtimeSessionHarness() {
  const listeners = new Set();
  const state = {
    choices: [],
    requests: 0,
    handoffs: [],
    removed: [],
    closes: 0
  };
  const port = {
    updateToolChoice: (choice) => state.choices.push(choice),
    onTransportEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestResponse: () => { state.requests += 1; },
    updateAgent: async (agent) => { state.handoffs.push(agent); },
    removeHistoryItem: (itemId) => state.removed.push(itemId),
    close: () => { state.closes += 1; }
  };
  return {
    state,
    adapter: createRealtimeBootstrapAdapter(port),
    acknowledge(choice) {
      const toolChoice = choice === "auto" ? "auto" : { type: "function", name: choice };
      for (const listener of [...listeners]) listener({ type: "session.updated", session: { tool_choice: toolChoice } });
    }
  };
}

test("installed SDK serializes exact forced function choices through provider data", () => {
  const transport = new OpenAIRealtimeWebSocket();
  const outbound = [];
  transport.sendEvent = (event) => outbound.push(event);
  transport.updateSessionConfig(realtimeToolChoiceOverride("get_interview_context"));
  transport.updateSessionConfig(realtimeToolChoiceOverride("fetch_interview_question"));
  transport.updateSessionConfig(realtimeToolChoiceOverride("read_interview_rubric"));
  transport.updateSessionConfig(realtimeToolChoiceOverride("auto"));
  assert.deepEqual(outbound.map((event) => event.session.tool_choice), [
    { type: "function", name: "get_interview_context" },
    { type: "function", name: "fetch_interview_question" },
    { type: "function", name: "read_interview_rubric" },
    "auto"
  ]);
});

test("installed SDK conductor update serializes auto with only conductor tools", async () => {
  const introductionTool = tool({
    name: "get_interview_context",
    description: "Introduction only",
    parameters: z.object({}),
    execute: async () => ({})
  });
  const conductorWorkspace = tool({
    name: "get_current_workspace",
    description: "Conductor workspace",
    parameters: z.object({}),
    execute: async () => ({})
  });
  const conductorRubric = tool({
    name: "read_interview_rubric",
    description: "Reusable conductor rubric",
    parameters: z.object({}),
    execute: async () => ({})
  });
  const introduction = new RealtimeAgent({
    name: "Introduction Agent",
    instructions: "Introduce the interview.",
    tools: [introductionTool]
  });
  const conductor = new RealtimeAgent({
    name: "Interview Conductor",
    instructions: "Conduct the interview.",
    tools: [conductorWorkspace, conductorRubric]
  });
  const transport = new OpenAIRealtimeWebSocket();
  const outbound = [];
  transport.updateSessionConfig = (config) => {
    outbound.push(transport.buildSessionPayload(config));
  };
  const session = new RealtimeSession(introduction, {
    transport,
    config: { toolChoice: "auto", parallelToolCalls: false }
  });
  try {
    const initial = await session.getInitialSessionConfig();
    assert.equal(initial.toolChoice, "auto");
    assert.equal(initial.providerData, undefined);
    // This matches the phase-three transition that restores auto before handoff.
    await session.getInitialSessionConfig(realtimeToolChoiceOverride("auto"));
    await session.updateAgent(conductor);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].tool_choice, "auto");
    assert.equal(outbound[0].parallel_tool_calls, false);
    assert.deepEqual(outbound[0].tools.map((entry) => entry.name), [
      "get_current_workspace",
      "read_interview_rubric"
    ]);
  } finally {
    session.close();
  }
});

test("realtime lifecycle forces acknowledged tool order and hands off only after confirmed playback", async () => {
  const session = realtimeSessionHarness();
  const delivered = [];
  const lifecycle = createRealtimeBootstrapLifecycle({
    adapter: session.adapter,
    approvedQuestion: "Which invariant does your loop maintain?",
    conductor: "Interview Conductor",
    onDelivered: (question, at) => delivered.push({ question, at }),
    timeoutMs: 60_000
  });
  const begin = lifecycle.begin();
  assert.deepEqual(session.state.choices, ["get_interview_context"]);
  assert.equal(session.state.requests, 0);
  session.acknowledge("auto");
  await Promise.resolve();
  assert.equal(session.state.requests, 0);
  session.acknowledge("get_interview_context");
  await Promise.resolve();
  assert.equal(session.state.requests, 1);

  await assert.rejects(
    lifecycle.runTool("fetch_interview_question", () => "out of order"),
    /Expected get_interview_context/
  );
  assert.equal(lifecycle.phase(), 0);

  const context = lifecycle.runTool("get_interview_context", () => "context");
  await Promise.resolve();
  assert.deepEqual(session.state.choices, ["get_interview_context", "fetch_interview_question"]);
  let contextReturned = false;
  void context.then(() => { contextReturned = true; });
  await Promise.resolve();
  assert.equal(contextReturned, false);
  session.acknowledge("fetch_interview_question");
  assert.equal(await context, "context");

  const question = lifecycle.runTool("fetch_interview_question", () => "question");
  await Promise.resolve();
  session.acknowledge("read_interview_rubric");
  assert.equal(await question, "question");
  const rubric = lifecycle.runTool("read_interview_rubric", () => "rubric");
  await Promise.resolve();
  assert.equal(session.state.choices.at(-1), "auto");
  session.acknowledge("auto");
  assert.equal(await rubric, "rubric");
  assert.deepEqual(session.state.choices, [
    "get_interview_context",
    "fetch_interview_question",
    "read_interview_rubric",
    "auto"
  ]);
  assert.equal(await lifecycle.runTool("read_interview_rubric", () => "rubric again"), "rubric again");
  assert.equal(session.state.choices.length, 4);

  const tracker = createQuestionDeliveryTracker((spoken, at) => {
    void lifecycle.confirmPrimaryDelivery(spoken, at);
  });
  assert.equal(tracker.queue("Which invariant does your loop maintain?"), true);
  assert.equal(tracker.queue("A duplicate primary question?"), false);
  tracker.associateResponse("response-primary");
  tracker.associateItem("response-primary", "item-primary");
  assert.equal(tracker.completeResponse("response-primary", "**Which invariant** does your loop maintain?"), true);
  assert.deepEqual(session.state.handoffs, []);
  assert.equal(realtimePlaybackStoppedResponse({ type: "response.output_audio.done", response_id: "response-primary" }), null);
  assert.deepEqual(session.state.handoffs, []);
  const playbackResponseId = realtimePlaybackStoppedResponse({
    type: "output_audio_buffer.stopped",
    event_id: "playback-1",
    response_id: "response-primary"
  });
  assert.equal(playbackResponseId, "response-primary");
  assert.equal(tracker.confirmCompleted(playbackResponseId, 1_234_567), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(session.state.handoffs, ["Interview Conductor"]);
  assert.deepEqual(delivered, []);
  session.acknowledge("get_interview_context");
  await Promise.resolve();
  assert.deepEqual(delivered, []);
  session.acknowledge("auto");
  assert.equal(await begin, true);
  assert.deepEqual(session.state.handoffs, ["Interview Conductor"]);
  assert.deepEqual(delivered, [{ question: "Which invariant does your loop maintain?", at: 1_234_567 }]);
});

test("realtime bootstrap timeout and completion cancel close at most once", async () => {
  const timeoutSession = realtimeSessionHarness();
  let timeoutCallback = null;
  let cleared = 0;
  const timed = createRealtimeBootstrapLifecycle({
    adapter: timeoutSession.adapter,
    approvedQuestion: "Question?",
    conductor: "Conductor",
    onDelivered: () => undefined,
    timeoutMs: 50,
    runtime: {
      setTimeout: (callback) => { timeoutCallback = callback; return 1; },
      clearTimeout: () => { cleared += 1; }
    }
  });
  const timedBegin = timed.begin();
  timeoutCallback();
  await assert.rejects(timedBegin, /did not start in time/);
  assert.equal(timeoutSession.state.closes, 1);
  timeoutSession.acknowledge("get_interview_context");
  await Promise.resolve();
  assert.equal(timeoutSession.state.requests, 0);
  timed.close();
  assert.equal(timeoutSession.state.closes, 1);
  assert.equal(cleared, 1);

  const completionSession = realtimeSessionHarness();
  let completionTimerCleared = 0;
  const completing = createRealtimeBootstrapLifecycle({
    adapter: completionSession.adapter,
    approvedQuestion: "Question?",
    conductor: "Conductor",
    onDelivered: () => undefined,
    runtime: {
      setTimeout: () => 2,
      clearTimeout: () => { completionTimerCleared += 1; }
    }
  });
  const completingBegin = completing.begin();
  assert.equal(completing.cancelForCompletion(), true);
  assert.equal(await completingBegin, false);
  assert.equal(completionSession.state.requests, 0);
  completionSession.acknowledge("get_interview_context");
  await Promise.resolve();
  assert.equal(completionSession.state.requests, 0);
  assert.equal(completionTimerCleared, 1);
  completing.close();
  completing.close();
  assert.equal(completionSession.state.closes, 1);
});

test("realtime guardrail identity removes rejected assistant output from every transcript read", () => {
  const store = createRealtimeTranscriptStore();
  store.addCandidate("candidate-1", "I will explain the loop.", 1);
  store.syncAssistantHistory([
    { type: "message", role: "assistant", itemId: "unsafe-1", content: [{ transcript: "Would a Map solve this?" }] },
    { type: "message", role: "assistant", itemId: "safe-1", content: [{ transcript: "Which invariant does this maintain?" }] }
  ], 2);
  assert.equal(store.turns().some((turn) => /Map/.test(turn.text)), false);
  const identity = realtimeGuardrailIdentity(
    { result: { guardrail: { name: "zero_hint" } } },
    { itemId: "unsafe-1" }
  );
  assert.deepEqual(identity, { name: "zero_hint", itemId: "unsafe-1" });
  store.rejectAssistantItem(identity.itemId);
  store.commitAssistantHistory();
  assert.equal(store.hasRejected("unsafe-1"), true);
  assert.deepEqual(store.turns(), [
    { role: "candidate", text: "I will explain the loop.", at: 1 },
    { role: "interviewer", text: "Which invariant does this maintain?", at: 2 }
  ]);
  store.syncAssistantHistory([
    { type: "message", role: "assistant", itemId: "unsafe-1", content: [{ transcript: "Would a Map solve this?" }] }
  ], 3);
  assert.equal(store.turns().some((turn) => /Map/.test(turn.text)), false);
});

function signalHarness({ analyse, onObservation, onObservationCommitted } = {}) {
  const state = {
    now: 1_000_000,
    code: "",
    codeRevision: 0,
    codeChangedAt: 0,
    whiteboard: "empty",
    whiteboardRevision: 0,
    whiteboardChangedAt: 0,
    lastRun: null,
    remaining: 120,
    elapsed: 180,
    status: "listening",
    transcript: [],
    asked: [],
    observations: [],
    plan: {
      areas: [{ id: "reasoning", label: "Reasoning", weight: 100, targetEvidence: "invariant", evidenceCount: 0 }],
      stages: [{ name: "work", goal: "probe", questionTypes: ["reasoning"] }]
    }
  };
  const queued = [];
  const activity = [];
  let analysisCalls = 0;
  const bus = startSignalBus({
    getCode: () => state.code,
    getCodeRevision: () => state.codeRevision,
    getCodeChangedAt: () => state.codeChangedAt,
    getWhiteboardSummary: () => state.whiteboard,
    getWhiteboardRevision: () => state.whiteboardRevision,
    getWhiteboardChangedAt: () => state.whiteboardChangedAt,
    getLastRun: () => state.lastRun,
    getRemainingSeconds: () => state.remaining,
    getElapsedSeconds: () => state.elapsed,
    getAgentStatus: () => state.status,
    getQuestion: () => "Explain your loop.",
    getRubric: () => "reasoning",
    getPlan: () => state.plan,
    getTranscript: () => state.transcript,
    getAskedQuestions: () => state.asked,
    getObservations: () => state.observations,
    onObservation: onObservation ?? (async () => undefined),
    onObservationCommitted: onObservationCommitted ?? ((observation) => {
      state.observations.push(observation);
      state.plan = {
        ...state.plan,
        areas: state.plan.areas.map((area) => area.id === observation.areaId ? { ...area, evidenceCount: area.evidenceCount + 1 } : area)
      };
    }),
    onQuestionQueued: (question) => queued.push(question),
    onActivity: (row) => activity.push(row),
    runtime: {
      now: () => state.now,
      setInterval: () => 1,
      clearInterval: () => undefined,
      analyse: async (input) => {
        analysisCalls += 1;
        return analyse ? analyse(input) : { observations: [], question: { areaId: "reasoning", question: "Which invariant does this maintain?", basis: "code changed" }, validationErrors: [] };
      }
    }
  });
  return { state, bus, queued, activity, analysisCalls: () => analysisCalls };
}

test("actual signal bus defers active typing and drawing until quiet gates pass", async () => {
  const typing = signalHarness();
  typing.bus.notifyQuestionDelivered(typing.state.now);
  typing.state.codeRevision = 1;
  typing.state.codeChangedAt = typing.state.now + 44_000;
  typing.state.now += 45_000;
  typing.state.elapsed += 45;
  typing.state.remaining -= 45;
  await typing.bus.poll();
  assert.equal(typing.analysisCalls(), 0);
  typing.state.now += 2_000;
  typing.state.elapsed += 2;
  typing.state.remaining -= 2;
  await typing.bus.poll();
  assert.equal(typing.analysisCalls(), 1);
  assert.equal(typing.queued.length, 1);
  typing.bus.stop();

  const drawing = signalHarness();
  drawing.bus.notifyQuestionDelivered(drawing.state.now);
  drawing.state.whiteboardRevision = 1;
  drawing.state.whiteboardChangedAt = drawing.state.now + 44_500;
  drawing.state.now += 45_000;
  drawing.state.elapsed += 45;
  drawing.state.remaining -= 45;
  await drawing.bus.poll();
  assert.equal(drawing.analysisCalls(), 0);
  drawing.state.now += 1_500;
  drawing.state.elapsed += 1.5;
  drawing.state.remaining -= 1.5;
  await drawing.bus.poll();
  assert.equal(drawing.analysisCalls(), 1);
  assert.equal(drawing.queued.length, 1);
  drawing.bus.stop();
});

test("actual signal bus discards a result when inputs change during evidence persistence", async () => {
  let releasePersistence;
  let persistenceStarted;
  const started = new Promise((resolve) => { persistenceStarted = resolve; });
  const harness = signalHarness({
    analyse: async () => ({
      observations: [{ observer: "code", areaId: "reasoning", finding: "Candidate named an invariant.", confidence: 0.8, codeRevision: 1, whiteboardRevision: 0, at: 1 }],
      question: { areaId: "reasoning", question: "Which invariant does this maintain?", basis: "code changed" },
      validationErrors: []
    }),
    onObservation: async () => {
      persistenceStarted();
      await new Promise((resolve) => { releasePersistence = resolve; });
    }
  });
  harness.bus.notifyQuestionDelivered(harness.state.now);
  harness.state.codeRevision = 1;
  harness.state.codeChangedAt = harness.state.now + 42_000;
  harness.state.now += 45_000;
  harness.state.elapsed += 45;
  harness.state.remaining -= 45;
  const poll = harness.bus.poll();
  await started;
  harness.state.transcript = [{ role: "candidate", text: "I changed my reasoning.", at: harness.state.now + 1 }];
  releasePersistence();
  await poll;
  assert.equal(harness.queued.length, 0);
  assert.match(harness.activity.map((row) => row.text).join(" "), /discarded stale planner result/);
  harness.bus.stop();
});

test("actual signal bus discards and replans when coverage changes during evidence persistence", async () => {
  let releasePersistence;
  let persistenceStarted;
  let persistenceCalls = 0;
  const started = new Promise((resolve) => { persistenceStarted = resolve; });
  const harness = signalHarness({
    analyse: async () => ({
      observations: [{ observer: "code", areaId: "reasoning", finding: "Candidate named an invariant.", confidence: 0.8, codeRevision: 1, whiteboardRevision: 0, at: 1 }],
      question: { areaId: "reasoning", question: "Which invariant does this maintain?", basis: "code changed" },
      validationErrors: []
    }),
    onObservation: async () => {
      persistenceCalls += 1;
      if (persistenceCalls !== 1) return;
      persistenceStarted();
      await new Promise((resolve) => { releasePersistence = resolve; });
    }
  });
  harness.bus.notifyQuestionDelivered(harness.state.now);
  harness.state.codeRevision = 1;
  harness.state.code = "const answer = 1;";
  harness.state.codeChangedAt = harness.state.now + 42_000;
  harness.state.now += 45_000;
  harness.state.elapsed += 45;
  harness.state.remaining -= 45;
  const firstPoll = harness.bus.poll();
  await started;
  harness.state.plan = {
    ...harness.state.plan,
    areas: harness.state.plan.areas.map((area) => ({ ...area, evidenceCount: 99 }))
  };
  releasePersistence();
  await firstPoll;
  assert.equal(harness.queued.length, 0);
  assert.equal(harness.state.observations.length, 0);
  assert.match(harness.activity.map((row) => row.text).join(" "), /discarded stale planner result/);

  await harness.bus.poll();
  assert.equal(harness.analysisCalls(), 2);
  assert.equal(harness.queued.length, 1);
  assert.equal(harness.state.observations.length, 1);
  harness.bus.stop();
});

test("actual signal bus makes a deferred analysis inert after an external input changes", async () => {
  let releaseAnalysis;
  let analysisStarted;
  const started = new Promise((resolve) => { analysisStarted = resolve; });
  const harness = signalHarness({
    analyse: async () => {
      analysisStarted();
      return new Promise((resolve) => { releaseAnalysis = resolve; });
    }
  });
  harness.bus.notifyQuestionDelivered(harness.state.now);
  harness.state.codeRevision = 1;
  harness.state.codeChangedAt = harness.state.now + 42_000;
  harness.state.now += 45_000;
  harness.state.elapsed += 45;
  harness.state.remaining -= 45;
  const poll = harness.bus.poll();
  await started;
  harness.state.whiteboardRevision = 1;
  harness.state.whiteboardChangedAt = harness.state.now;
  releaseAnalysis({ observations: [], question: { areaId: "reasoning", question: "Which invariant does this maintain?", basis: "code changed" }, validationErrors: [] });
  await poll;
  assert.equal(harness.queued.length, 0);
  harness.bus.stop();
});

test("final artifact API sends the frozen code and whiteboard payload before completion", async () => {
  const payload = buildArtifactRequest({
    sessionId: "0123456789abcdef0123456789abcdef",
    codeRevision: 9,
    code: "function solve() {}",
    whiteboardRevision: 4,
    whiteboardSummary: "two boxes",
    whiteboardScene: "{\"records\":[]}",
    whiteboardImage: null
  });
  const calls = [];
  await postArtifactRequest(payload, async (url, init) => {
    calls.push({ url, init });
    return { status: 201, text: async () => "" };
  });
  assert.equal(calls[0].url, "/api/interview/artifacts");
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
  await assert.rejects(postArtifactRequest(payload, async () => ({ status: 503, text: async () => "artifact storage failed" })), /artifact storage failed/);
});

test("evaluation sends only the saved session identity and transcript", () => {
  const payload = buildEvaluationRequest({
    sessionId: "0123456789abcdef0123456789abcdef",
    transcript: [{ role: "candidate", text: "I will run the tests." }]
  });
  assert.deepEqual(payload, { sessionId: "0123456789abcdef0123456789abcdef", transcript: [{ role: "candidate", text: "I will run the tests." }] });
  assert.deepEqual(Object.keys(payload).sort(), ["sessionId", "transcript"]);
});

test("startup retries retain setup identity and completed phase outputs", () => {
  const phases = ["upload", "setup", "prepare", "config", "token", "connect"];
  for (const failure of phases) {
    let current = null;
    current = ensureStartupCache(current, () => ({ setupId: "0123456789abcdef0123456789abcdef", setupProgress: { uploads: [] }, saved: null, prepared: null }));
    if (failure !== "upload") current.setupProgress.uploads.push("brief");
    if (!["upload", "setup"].includes(failure)) current.saved = { setupId: current.setupId };
    if (!["upload", "setup", "prepare"].includes(failure)) current.prepared = { setupId: current.setupId };
    const retry = ensureStartupCache(current, () => { throw new Error("must reuse startup cache"); });
    assert.strictEqual(retry, current);
    assert.equal(retry.setupId, "0123456789abcdef0123456789abcdef");
    if (["config", "token", "connect"].includes(failure)) {
      assert.equal(retry.saved.setupId, retry.setupId);
      assert.equal(retry.prepared.setupId, retry.setupId);
    }
  }
});
