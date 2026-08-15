import { Agent, run } from "@openai/agents";
import { z } from "zod";
import { getModelConfig } from "./client";
import type { InterviewPlan } from "./types";

const PlanSchema = z.object({
  areas: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      weight: z.number(),
      targetEvidence: z.string()
    })
  )
});

const PLAN_INSTRUCTIONS = `You convert an interview rubric into a coverage plan.

Rules:
- Derive areas ONLY from the supplied rubric. Never invent a scored dimension.
- Use a short lowercase snake_case id for each area, for example problem_understanding.
- Order areas by when they naturally arise. Understanding first. Complexity and trade-offs last.
- Produce at most one area per minute of interview time. A five minute interview gets four or five areas maximum.
- targetEvidence states what the interviewer must observe to consider the area covered. Make it concrete and observable.
- weight is the percentage from the rubric. If the rubric gives no weights, distribute evenly so the total is 100.`;

export async function buildInterviewPlan(input: {
  role: string;
  rubric: string;
  question: string;
  durationSeconds: number;
}): Promise<InterviewPlan> {
  const agent = new Agent<any, any>({
    name: "Interview Planner",
    instructions: PLAN_INSTRUCTIONS,
    model: getModelConfig().orchestratorModel,
    outputType: PlanSchema as never
  });

  const result = await run(
    agent,
    `Role: ${input.role}
Interview length: ${Math.round(input.durationSeconds / 60)} minutes

Rubric:
${input.rubric}

Coding problem:
${input.question}`
  );

  const output = result.finalOutput as z.infer<typeof PlanSchema> | undefined;
  if (!output) throw new Error("Planner returned no plan.");

  return {
    areas: output.areas.map((area) => ({ ...area, evidenceCount: 0 }))
  };
}
