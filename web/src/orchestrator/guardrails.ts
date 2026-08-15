import type { RealtimeOutputGuardrail } from "@openai/agents/realtime";

const BANNED_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "director instruction leak", pattern: /INTERVIEW DIRECTOR|Context for your own understanding/i },
  { label: "algorithm suggestion", pattern: /\b(use|try|consider|maybe)\b[^.?!]{0,40}\b(hash ?map|hash ?set|dictionary|two pointers?|sliding window|binary search|memoi[sz]|dynamic programming|frequency (map|counter|array))\b/i },
  { label: "correctness verdict", pattern: /\b(that('s| is) (correct|right|wrong)|you got it|exactly right|that works|incorrect)\b/i },
  { label: "praise", pattern: /\b(great|good) (job|work|answer|approach)\b|\b(nice|excellent|perfect|well done|awesome)\b/i },
  { label: "code leak", pattern: /(for\s*\(|while\s*\(|function\s+\w+\s*\(|=>\s*\{|\.set\(|\.get\()/ }
];

export const zeroHintGuardrail: RealtimeOutputGuardrail = {
  name: "zero_hint",
  async execute({ agentOutput }) {
    for (const entry of BANNED_PATTERNS) {
      if (entry.pattern.test(agentOutput)) {
        return { tripwireTriggered: true, outputInfo: { reason: entry.label } };
      }
    }
    return { tripwireTriggered: false, outputInfo: {} };
  }
};
