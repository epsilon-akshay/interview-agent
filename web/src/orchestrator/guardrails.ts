import type { RealtimeOutputGuardrail } from "@openai/agents/realtime";
import { outputSafetyViolation } from "./outputSafety";

export function stripApprovedPrompt(output: string, approvedPrompt: string, allowBootstrapOverlap: boolean) {
  if (!allowBootstrapOverlap || !approvedPrompt) return output;
  const fullIndex = output.indexOf(approvedPrompt);
  if (fullIndex >= 0) return `${output.slice(0, fullIndex)}${output.slice(fullIndex + approvedPrompt.length)}`;
  const maximum = Math.min(output.length, approvedPrompt.length);
  for (let length = maximum; length >= 4; length -= 1) {
    if (output.endsWith(approvedPrompt.slice(0, length))) return output.slice(0, -length);
  }
  return output;
}

export function zeroHintViolation(output: string, approvedPrompt = "", allowBootstrapOverlap = false) {
  const outputToCheck = stripApprovedPrompt(output, approvedPrompt.trim(), allowBootstrapOverlap);
  return outputSafetyViolation(outputToCheck, { approvedPrompt });
}

export function zeroHintGuardrailWithApprovedQuestion(
  question: string,
  allowBootstrapOverlap: () => boolean = () => false
): RealtimeOutputGuardrail {
  const normalizedQuestion = question.trim();
  return {
  name: "zero_hint",
  async execute({ agentOutput }) {
    // The server-approved primary question is allowed during bootstrap even if it
    // contains a function signature. All invented code remains guarded.
    const violation = zeroHintViolation(agentOutput, normalizedQuestion, allowBootstrapOverlap());
    if (violation) return { tripwireTriggered: true, outputInfo: { reason: violation } };
    return { tripwireTriggered: false, outputInfo: {} };
  }
  };
}

export const zeroHintGuardrail = zeroHintGuardrailWithApprovedQuestion("");
