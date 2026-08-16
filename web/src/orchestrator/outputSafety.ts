export type OutputSafetyContext = {
  approvedPrompt?: string;
};

const DIRECT_SOLUTION_TERMS = [
  "dynamic programming",
  "breadth first search",
  "depth first search",
  "priority queue",
  "sliding window",
  "binary search",
  "two pointers",
  "linked list",
  "hash map",
  "hash set",
  "memoization",
  "dictionary",
  "hashmap",
  "graph",
  "stack",
  "queue",
  "heap",
  "trie",
  "map",
  "set",
  "bfs",
  "dfs"
];

const UNSAFE_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "director instruction leak", pattern: /INTERVIEW DIRECTOR|Context for your own understanding/i },
  { label: "prescriptive advice", pattern: /\b(you (should|could|must|need to|ought to)|try|consider|have you tried|here'?s a hint|a hint is|i recommend|i suggest)\b/i },
  { label: "praise or reassurance", pattern: /\b(great|nice|excellent|perfect|awesome|impressive|well done)\b|\bgood (job|work|answer|approach)\b|\byou'?re doing (well|great|fine)\b/i },
  { label: "unsupported correctness claim", pattern: /\b(that('s| is) (correct|right|wrong)|you got it|exactly right|that works|that won'?t work|incorrect|bug[- ]?free|your (answer|code|approach) is (correct|right|wrong))\b/i },
  {
    label: "personality or emotion judgment",
    pattern: /\b(personality|demeanou?r|attitude|temperament)\b|\b(?:you|the candidate|candidate|they|he|she)\b(?:['’]s|[^.?!]{0,24}\b(?:am|are|is|was|were|become|became|feel|feels|felt|seem|seems|seemed|appear|appears|appeared|look|looks|looked|sound|sounds|sounded|lack|lacks|lacked|lacking|show|shows|showed|display|displays|displayed|demonstrate|demonstrates|demonstrated|express|expresses|expressed|have|has|had|grew|remain|remains|remained)\b)[^.?!]{0,24}\b(?:confident|unconfident|confidence(?!\s+(?:interval|level|score|bound))|hesitant|hesitation|uncertain|uncertainty(?!\s+(?:interval|estimate|bound|propagation))|hostile|hostility|friendly|friendliness|unfriendly|nervous|nervousness|anxious|anxiety|calm|emotional|frustrated|frustration|upset|excited|excitement|enthusiastic|enthusiasm|shy|shyness|arrogant|arrogance|pleasant)\b|\b(?:their|his|her)\s+(?:confidence|hesitation|uncertainty|hostility|friendliness|nervousness|anxiety|frustration|excitement|enthusiasm|shyness|arrogance)\b/i
  },
  { label: "appearance or accent judgment", pattern: /\b(accent|appearance|attractive|unattractive|well[- ]?dressed|clothing|looks? (young|old|tired|professional))\b/i },
  { label: "code or pseudocode", pattern: /(for\s*\(|while\s*\(|function\s+\w+\s*\(|=>\s*\{|\.(set|get)\s*\(|\b(return|initialize|declare)\s+[a-z_$][\w$]*\s*[=;])/i }
];

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function containsTerm(value: string, term: string) {
  return ` ${normalized(value)} `.includes(` ${normalized(term)} `);
}

export function outputSafetyViolation(output: string, context: OutputSafetyContext = {}) {
  const text = output.trim();
  if (!text) return null;
  for (const entry of UNSAFE_PATTERNS) {
    if (entry.pattern.test(text)) return entry.label;
  }
  const approvedPrompt = context.approvedPrompt ?? "";
  for (const term of DIRECT_SOLUTION_TERMS) {
    if (containsTerm(text, term) && !containsTerm(approvedPrompt, term)) {
      return `introduces solution term ${term}`;
    }
  }
  return null;
}

export function normalizeSpokenText(value: string) {
  return normalized(value.replace(/[*_`~>#\[\](){}]/g, " "));
}
