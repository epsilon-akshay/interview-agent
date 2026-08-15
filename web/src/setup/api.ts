import type { InterviewSetupDraft } from "./types";

type UploadKind = "brief" | "rubric" | "candidate";

type UploadedFile = {
  id: string;
};

function newSetupId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function uploadFile(setupId: string, kind: UploadKind, file: File): Promise<UploadedFile> {
  const body = new FormData();
  body.set("setupId", setupId);
  body.set("kind", kind);
  if (kind === "candidate") body.set("candidateSourceType", "resume");
  body.set("file", file);
  const response = await fetch("/api/interview/uploads", { method: "POST", body });
  if (!response.ok) throw new Error((await response.text()).trim() || `Could not upload ${file.name}.`);
  return await response.json() as UploadedFile;
}

function optionalHttpsSource(type: "linkedin" | "github" | "website", reference: string) {
  const value = reference.trim();
  return value ? { type, reference: value } : null;
}

export async function saveInterviewSetup(draft: InterviewSetupDraft) {
  const setupId = newSetupId();
  const [briefUpload, rubricUpload, resumeUpload] = await Promise.all([
    draft.briefFile ? uploadFile(setupId, "brief", draft.briefFile) : Promise.resolve(null),
    draft.rubricFile ? uploadFile(setupId, "rubric", draft.rubricFile) : Promise.resolve(null),
    draft.resumeFile ? uploadFile(setupId, "candidate", draft.resumeFile) : Promise.resolve(null)
  ]);

  const sources = [
    resumeUpload ? { type: "resume", reference: `upload:${resumeUpload.id}` } : null,
    optionalHttpsSource("linkedin", draft.linkedInUrl),
    optionalHttpsSource("github", draft.githubUrl),
    optionalHttpsSource("website", draft.websiteUrl)
  ].filter((source): source is { type: string; reference: string } => source !== null);

  const response = await fetch("/api/interview/setups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      setupId,
      version: 1,
      candidateContextPolicy: "job_related_question_tailoring_only",
      candidate: {
        name: draft.candidateName.trim(),
        sources,
        reviewedFacts: draft.reviewedFacts
          .split("\n")
          .map((fact) => fact.trim())
          .filter(Boolean)
      },
      role: { title: draft.roleTitle.trim(), level: draft.roleLevel.trim() },
      interview: {
        type: draft.interviewType,
        durationSeconds: Math.round(draft.durationMinutes * 60),
        codingLanguage: draft.codingLanguage.trim(),
        questionTypes: draft.questionTypes,
        workspaces: draft.workspaces,
        tools: draft.tools,
        channels: draft.channels
      },
      brief: {
        text: draft.briefText.trim(),
        attachmentIds: briefUpload ? [briefUpload.id] : []
      },
      rubric: {
        sourceText: draft.rubricSourceText.trim(),
        attachmentIds: rubricUpload ? [rubricUpload.id] : [],
        criteria: draft.rubricCriteria.map((criterion) => ({
          id: criterion.id.trim(),
          name: criterion.name.trim(),
          weight: criterion.weight,
          expectedEvidence: criterion.expectedEvidence.trim()
        }))
      }
    })
  });
  if (!response.ok) throw new Error((await response.text()).trim() || "Could not save interview setup.");
  return { setupId };
}
