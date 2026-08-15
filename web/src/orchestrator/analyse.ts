import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { getModelConfig } from "./client";
import type { RunResult } from "../runner/types";
import type { InterviewPlan, Observation, QueuedQuestion, Signal, TranscriptTurn } from "./types";

const AnalysisSchema = z.object({
  observations: z.array(
    z.object({
      source: z.enum(["code", "whiteboard", "speech"]),
      areaId: z.string(),
      finding: z.string(),
      confidence: z.number()
    })
  ),
  shouldAsk: z.boolean(),
  areaId: z.string(),
  question: z.string(),
  basis: z.string()
});

const ANALYSE_INSTRUCTIONS = `You watch a candidate during a technical coding interview, and you decide what the voice interviewer asks next. You never speak yourself.

You do TWO things in one response.

FIRST — observations. Record what changed and what it reveals.
- Return an empty array when nothing is noteworthy. Most of the time nothing is. That is the correct answer.
- Return at most three observations.
- source must be code, whiteboard, or speech.
- areaId must be one of the rubric area ids given in the input.
- finding must describe something concrete and observable. Never speculate about personality, confidence, or intent.
- Treat a diagram as evidence of REASONING, never as proof the code works.
- If a diagram's labels or connections are ambiguous, say so and lower the confidence.

SECOND — the next question.
- Prefer the rubric area with the LEAST evidence and the HIGHEST weight.
- In the final quarter of the interview, prefer complexity and trade-offs.
- The question must anchor to something concrete: their code, a test result, their diagram, or something they said. Put that anchor in basis.

Hard rules for the question text:
- Under 12 words. One question. No preamble.
- Never reveal an algorithm name, a data structure recommendation, pseudocode, or any part of the solution.
- Never state or imply the expected output of a test.
- Never praise, reassure, or say whether they are correct.
- Never repeat a question already asked. The asked list is in the input.

Set shouldAsk to false when there is nothing worth asking. Silence is valid and expected. Choose it when the candidate is mid-thought, when observations are thin, or when every area already has solid evidence. When shouldAsk is false, put empty strings in areaId, question, and basis.`;

export type AnalysisResult = {
  observations: Observation[];
  question: QueuedQuestion | null;
};

export async function analyse(input: {
  previousCode: string;
  currentCode: string;
  previousWhiteboard: string;
  currentWhiteboard: string;
  transcriptTail: TranscriptTurn[];
  testFact: string | null;
  question: string;
  plan: InterviewPlan | null;
  rubric: string;
  observations: Observation[];
  askedQuestions: string[];
  signal: Signal;
}): Promise<AnalysisResult> {
  const agent = new Agent<any, any>({
    name: "Interview Analyst",
    instructions: ANALYSE_INSTRUCTIONS,
    model: getModelConfig().observerModel,
    outputType: AnalysisSchema as never
  });

  const coverage = input.plan
    ? input.plan.areas
        .map((area) => `- ${area.id} (${area.label}, weight ${area.weight}%): ${area.evidenceCount} observations. Target: ${area.targetEvidence}`)
        .join("\n")
    : `No plan available. Use this rubric directly:\n${input.rubric}`;

  const transcript = input.transcriptTail
    .map((turn) => `${turn.role === "candidate" ? "Candidate" : "Interviewer"}: ${turn.text}`)
    .join("\n");

  const priorFindings = input.observations
    .slice(-10)
    .map((observation) => `- [${observation.observer} → ${observation.areaId}] ${observation.finding}`)
    .join("\n");

  const result = await run(
    agent,
    `Problem:
${input.question}

Rubric areas and coverage:
${coverage}

Recent conversation:
${transcript || "(nothing spoken yet)"}

Previous code:
${input.previousCode || "(empty)"}

Current code:
${input.currentCode || "(empty)"}

Previous whiteboard:
${input.previousWhiteboard}

Current whiteboard:
${input.currentWhiteboard}

Latest test run:
${input.testFact ?? "(the candidate has not run their code)"}

Earlier findings:
${priorFindings || "(none yet)"}

Questions already asked:
${input.askedQuestions.map((question) => `- ${question}`).join("\n") || "(none yet)"}

Timing: ${input.signal.elapsedSeconds}s elapsed, ${input.signal.remainingSeconds}s remaining.
Triggering signal: ${input.signal.kind}`
  );

  const output = result.finalOutput as z.infer<typeof AnalysisSchema> | undefined;
  if (!output) return { observations: [], question: null };

  const observations: Observation[] = output.observations.map((entry) => ({
    observer: entry.source,
    areaId: entry.areaId,
    finding: entry.finding,
    confidence: entry.confidence,
    at: Date.now()
  }));

  const question =
    output.shouldAsk && output.question.trim()
      ? { question: output.question.trim(), areaId: output.areaId, basis: output.basis }
      : null;

  return { observations, question };
}
