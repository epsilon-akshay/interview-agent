export type InterviewType = "coding" | "system_design" | "behavioral" | "mixed";
export type WorkspaceOption = "code_editor" | "whiteboard";
export type ChannelOption = "voice";

export type RubricCriterionDraft = {
  id: string;
  name: string;
  weight: number;
  expectedEvidence: string;
};

export type InterviewSetupDraft = {
  candidateName: string;
  roleTitle: string;
  roleLevel: string;
  interviewType: InterviewType;
  durationMinutes: number;
  codingLanguage: string;
  questionTypes: string[];
  workspaces: WorkspaceOption[];
  channels: ChannelOption[];
  briefText: string;
  briefFile: File | null;
  rubricSourceText: string;
  rubricFile: File | null;
  rubricCriteria: RubricCriterionDraft[];
  resumeFile: File | null;
  linkedInUrl: string;
  githubUrl: string;
  websiteUrl: string;
  reviewedFacts: string;
};

export const DEFAULT_SETUP_DRAFT: InterviewSetupDraft = {
  candidateName: "",
  roleTitle: "Software Engineer",
  roleLevel: "Mid-level",
  interviewType: "coding",
  durationMinutes: 5,
  codingLanguage: "TypeScript",
  questionTypes: ["problem_solving", "debugging", "complexity"],
  workspaces: ["code_editor", "whiteboard"],
  channels: ["voice"],
  briefText: "Run a focused technical interview for the selected role.",
  briefFile: null,
  rubricSourceText: "",
  rubricFile: null,
  rubricCriteria: [
    {
      id: "problem_understanding",
      name: "Problem understanding and clarifying questions",
      weight: 20,
      expectedEvidence: "Clarifies requirements and explains the problem in their own words."
    },
    {
      id: "approach",
      name: "Choice and explanation of approach",
      weight: 25,
      expectedEvidence: "Explains an approach and supports key decisions."
    },
    {
      id: "correctness",
      name: "Code quality and likely correctness",
      weight: 25,
      expectedEvidence: "Writes clear code and checks behavior with available tests."
    },
    {
      id: "complexity",
      name: "Time and space complexity",
      weight: 15,
      expectedEvidence: "States and explains time and space costs."
    },
    {
      id: "communication",
      name: "Communication and response to feedback",
      weight: 15,
      expectedEvidence: "Explains reasoning and responds directly to questions."
    }
  ],
  resumeFile: null,
  linkedInUrl: "",
  githubUrl: "",
  websiteUrl: "",
  reviewedFacts: ""
};

export function compatibleInterviewDefaults(type: InterviewType): Pick<InterviewSetupDraft, "codingLanguage" | "questionTypes" | "workspaces"> {
  if (type === "behavioral") return { codingLanguage: "", questionTypes: ["behavioral"], workspaces: [] };
  if (type === "system_design") return { codingLanguage: "", questionTypes: ["system_design", "complexity"], workspaces: ["whiteboard"] };
  if (type === "mixed") return { codingLanguage: "TypeScript", questionTypes: ["problem_solving", "system_design", "complexity"], workspaces: ["code_editor", "whiteboard"] };
  return { codingLanguage: "TypeScript", questionTypes: ["problem_solving", "debugging", "complexity"], workspaces: ["code_editor", "whiteboard"] };
}

export function compatibleQuestionTypes(type: InterviewType, values: string[]) {
  if (type === "behavioral") return values.filter((value) => value === "behavioral");
  if (type === "system_design") return values.filter((value) => value === "system_design" || value === "complexity" || value === "behavioral");
  return values;
}

export function formatRubricForAgent(draft: InterviewSetupDraft) {
  const criteria = draft.rubricCriteria
    .map((criterion) => `- ${criterion.name} (${criterion.weight}%): ${criterion.expectedEvidence}`)
    .join("\n");
  const source = draft.rubricSourceText.trim();
  return `Assess the candidate on:\n${criteria}\n\nCandidate information may tailor job-related questions. It must not count as scoring evidence or change these weights.${source ? `\n\nAdditional rubric guidance:\n${source}` : ""}`;
}

const ALLOWED_FILE_EXTENSIONS = new Set(["pdf", "txt", "md", "json", "docx"]);

function fileError(file: File | null, label: string) {
  if (!file) return null;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_FILE_EXTENSIONS.has(extension)) return `${label} must be a PDF, DOCX, TXT, Markdown, or JSON file.`;
  if (file.size === 0) return `${label} cannot be empty.`;
  if (file.size > 10 * 1024 * 1024) return `${label} must be 10 MB or smaller.`;
  return null;
}

function isHttpsUrl(value: string) {
  if (!value.trim()) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function setupStepError(draft: InterviewSetupDraft, step: number): string | null {
  if (step === 0) {
    if (!draft.candidateName.trim()) return "Enter the candidate's name.";
  }
  if (step === 1) {
    if (draft.durationMinutes < 1 || draft.durationMinutes > 120) return "Set a duration between 1 and 120 minutes.";
  }
  if (step === 2) {
    const invalidFile = fileError(draft.briefFile, "Interview brief") || fileError(draft.resumeFile, "Résumé");
    if (invalidFile) return invalidFile;
    if (![draft.linkedInUrl, draft.githubUrl, draft.websiteUrl].every(isHttpsUrl)) {
      return "LinkedIn, GitHub, and portfolio links must use HTTPS.";
    }
  }
  if (step === 3) {
    const invalidFile = fileError(draft.rubricFile, "Rubric file");
    if (invalidFile) return invalidFile;
    if (draft.rubricCriteria.length === 0) return null;
    const incomplete = draft.rubricCriteria.some(
      (criterion) => !criterion.id.trim() || !criterion.name.trim() || !criterion.expectedEvidence.trim()
    );
    if (incomplete) return "Complete every rubric criterion.";
    const total = draft.rubricCriteria.reduce((sum, criterion) => sum + criterion.weight, 0);
    if (total !== 100) return `Rubric weights total ${total}%. They must total 100%.`;
    const ids = draft.rubricCriteria.map((criterion) => criterion.id.trim().toLowerCase());
    if (new Set(ids).size !== ids.length) return "Use a unique ID for each rubric criterion.";
  }
  if (step === 4 && draft.channels.length === 0) return "Select at least one interview channel.";
  return null;
}

export function validateSetupDraft(draft: InterviewSetupDraft): string | null {
  for (let step = 0; step < 5; step += 1) {
    const error = setupStepError(draft, step);
    if (error) return error;
  }
  return null;
}
