import { expect, test, type Page } from "@playwright/test";

const sessionId = "0123456789abcdef0123456789abcdef";

function prepared() {
  return {
    setupId: sessionId,
    version: 1,
    createdAt: "2026-08-16T00:00:00Z",
    generatedFields: [],
    role: { title: "Engineer", level: "Senior" },
    roleMission: "Assess implementation evidence.",
    interview: { type: "coding", durationSeconds: 300, codingLanguage: "TypeScript", questionTypes: ["problem_solving"], workspaces: ["code_editor", "whiteboard"], tools: [], channels: ["voice"] },
    brief: "Assess the saved interview.",
    candidateFocus: [],
    rubric: { criteria: [{ id: "correctness", name: "Correctness", weight: 100, expectedEvidence: "Runs focused tests." }], sourceText: "", attachmentIds: [] },
    pattern: [{ name: "Implement", goal: "Build and test a solution.", questionTypes: ["problem_solving"] }],
    question: {
      id: "fixture",
      language: "typescript",
      entryFunction: "fixture",
      prompt: "Implement fixture.",
      starterCode: "function fixture(): number {\n  return 0;\n}",
      tests: [{ args: [], expected: 0 }, { args: [], expected: 0 }],
      demo: { solution: "", buggy: "" }
    }
  };
}

type RuntimeOptions = {
  prepareFailure?: { status: number; message: string };
  tokenFailure?: { status: number; message: string };
  token?: { value: string; model: string };
};

async function mockRuntime(page: Page, calls: { path: string; body: unknown }[], blockedExternal: string[] = [], options: RuntimeOptions = {}) {
  await page.addInitScript(() => {
    const originalNow = Date.now;
    let offset = 0;
    Date.now = () => originalNow() + offset;
    Object.assign(window, { __advanceInterviewClock: (milliseconds: number) => { offset += milliseconds; } });
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      blockedExternal.push(request.url());
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    let body: unknown = null;
    try { body = request.postDataJSON(); } catch { /* GET requests have no JSON body */ }
    calls.push({ path: `${url.pathname}${url.search}`, body });
    if (url.pathname === "/api/config") return route.fulfill({ json: { developerMode: true, observerModel: "test", orchestratorModel: "test", realtimeModel: "test" } });
    if (url.pathname === "/api/interview/setups") return route.fulfill({ status: 201, json: { setupId: sessionId } });
    if (url.pathname.endsWith("/prepare")) {
      if (options.prepareFailure) return route.fulfill({ status: options.prepareFailure.status, json: { message: options.prepareFailure.message } });
      return route.fulfill({ json: prepared() });
    }
    if (url.pathname === "/api/realtime/token") {
      if (options.tokenFailure) return route.fulfill({ status: options.tokenFailure.status, body: options.tokenFailure.message });
      return route.fulfill({ json: options.token ?? { value: "ek_test_token", model: "gpt-realtime-test" } });
    }
    if (url.pathname === "/api/interview/evidence" || url.pathname === "/api/interview/artifacts" || url.pathname === "/api/interview/complete") return route.fulfill({ json: { ok: true } });
    if (url.pathname === "/api/interview/evaluate") return route.fulfill({ json: { overallScore: 70, recommendation: "review", summary: "Mocked evaluation", categories: [], strengths: [], risks: [], limitations: [] } });
    if (url.pathname === "/api/openai/v1/responses") {
      return route.fulfill({ json: {
        id: "resp_test", object: "response", created_at: 1, status: "completed", error: null,
        output: [{ type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ observations: [], shouldAsk: true, areaId: "correctness", question: "What does this result show?", basis: "A test run completed." }) }] }]
      } });
    }
    return route.fulfill({ status: 404, body: "Unexpected API request" });
  });
}

async function startInterview(page: Page) {
  await page.goto("/");
  await page.getByLabel("Candidate name").fill("Alex Morgan");
  await page.getByRole("button", { name: "AI checks" }).click();
  for (let step = 0; step < 4; step += 1) await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start 5-minute interview/ }).click();
  await expect(page.getByText("Implement fixture.")).toBeVisible();
}

async function mockVoiceMedia(page: Page, rejectConnection = false) {
  await page.addInitScript(({ rejectConnection }) => {
    const tracks = ["audio", "video"].map((kind) => ({
      kind,
      enabled: true,
      stopped: false,
      stop() { this.stopped = true; }
    }));
    const stream = {
      getTracks: () => tracks,
      getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
      getVideoTracks: () => tracks.filter((track) => track.kind === "video")
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream }
    });
    Object.assign(window, {
      __voiceTestState: { mediaRequests: 0, tracks, peerConnections: 0, peerCloses: 0 }
    });
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async (...args) => {
      (window as any).__voiceTestState.mediaRequests += 1;
      return originalGetUserMedia(...args);
    };
    if (rejectConnection) {
      class RejectingPeerConnection {
        onconnectionstatechange: (() => void) | null = null;
        ontrack: ((event: Event) => void) | null = null;
        constructor() { (window as any).__voiceTestState.peerConnections += 1; }
        createDataChannel() { return { readyState: "connecting", addEventListener: () => undefined, removeEventListener: () => undefined, send: () => undefined, close: () => undefined }; }
        addTrack() { return undefined; }
        async createOffer() { throw new Error("Connection rejected by test transport."); }
        async setLocalDescription() { return undefined; }
        close() { (window as any).__voiceTestState.peerCloses += 1; }
      }
      Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: RejectingPeerConnection });
    }
  }, { rejectConnection });
}

async function startVoiceInterview(page: Page) {
  await page.goto("/");
  await page.getByLabel("Candidate name").fill("Alex Morgan");
  await page.getByRole("button", { name: "AI voice" }).click();
  for (let step = 0; step < 4; step += 1) await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Start 5-minute interview/ }).click();
}

async function expectVoiceRollback(page: Page, message: RegExp, peerConnections: number) {
  await expect(page.getByText(message)).toBeVisible();
  await expect(page.getByRole("region", { name: "Interview setup" })).toBeVisible();
  await expect(page.getByText(/remaining/)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const state = (window as any).__voiceTestState;
    return { stopped: state.tracks.every((track: { stopped: boolean }) => track.stopped), peerCloses: state.peerCloses };
  })).toEqual({ stopped: true, peerCloses: peerConnections });
}

test("developer controls expose AI checks and AI voice only", async ({ page }) => {
  const calls: { path: string; body: unknown }[] = [];
  await mockRuntime(page, calls);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "AI checks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "AI voice" })).toBeVisible();
  await expect(page.getByRole("button", { name: /No AI/i })).toHaveCount(0);
});

test("AI checks uses text planning and evaluates only the saved session artifacts", async ({ page }) => {
  const calls: { path: string; body: unknown }[] = [];
  await mockRuntime(page, calls);
  await startInterview(page);
  await page.locator(".monaco-editor .view-lines").click({ position: { x: 80, y: 18 } });
  await page.keyboard.press("End");
  await page.keyboard.insertText(" ");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.evaluate(() => (window as Window & { __advanceInterviewClock: (milliseconds: number) => void }).__advanceInterviewClock(60_000));
  await expect(page.getByText("What does this result show?")).toBeVisible({ timeout: 12_000 });
  await page.getByRole("button", { name: "End interview" }).click();
  await expect(page.getByText("Mocked evaluation")).toBeVisible();
  const artifacts = calls.find((call) => call.path === "/api/interview/artifacts");
  const evaluate = calls.find((call) => call.path === "/api/interview/evaluate");
  expect(evaluate?.body).toEqual({ sessionId: (artifacts?.body as { sessionId: string }).sessionId, transcript: [] });
  expect(calls.some((call) => /realtime|token/.test(call.path))).toBeFalsy();
  expect(calls.filter((call) => call.path.endsWith("/prepare")).every((call) => !call.path.includes("?mode="))).toBeTruthy();
});

test("AI voice prepare quota failure returns to the lobby before media or timer start", async ({ page }) => {
  const calls: { path: string; body: unknown }[] = [];
  await mockRuntime(page, calls, [], { prepareFailure: { status: 429, message: "AI preparation is unavailable because the provider quota is exhausted." } });
  await startVoiceInterview(page);
  await expect(page.getByText(/provider quota is exhausted/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Interview setup" })).toBeVisible();
  await expect(page.getByText(/remaining/)).toHaveCount(0);
  expect(calls.some((call) => call.path === "/api/realtime/token")).toBeFalsy();
});

test("AI voice token failure stops media and leaves no peer connection", async ({ page }) => {
  const calls: { path: string; body: unknown }[] = [];
  await mockVoiceMedia(page);
  await mockRuntime(page, calls, [], { tokenFailure: { status: 503, message: "Realtime token service is unavailable." } });
  await startVoiceInterview(page);
  await expectVoiceRollback(page, /token service is unavailable/, 0);
  expect(calls.filter((call) => call.path === "/api/realtime/token")).toHaveLength(1);
});

test("AI voice connection rejection stops media and closes the peer connection", async ({ page }) => {
  const calls: { path: string; body: unknown }[] = [];
  await mockVoiceMedia(page, true);
  await mockRuntime(page, calls);
  await startVoiceInterview(page);
  await expectVoiceRollback(page, /Connection rejected by test transport/, 1);
  expect(calls.filter((call) => call.path === "/api/realtime/token")).toHaveLength(1);
});
