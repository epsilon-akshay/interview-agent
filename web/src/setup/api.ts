import type { InterviewSetupDraft } from "./types";

type UploadKind = "brief" | "rubric" | "candidate";

type UploadedFile = {
  id: string;
};

export type SetupSaveProgress = {
  setupId: string;
  uploads: Partial<Record<"brief" | "rubric" | "resume", UploadedFile | null>>;
  uploadPromises: Partial<Record<"brief" | "rubric" | "resume", Promise<UploadedFile | null>>>;
  setupSaved: boolean;
};

export function newSetupId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function createSetupSaveProgress(setupId = newSetupId()): SetupSaveProgress {
  return { setupId, uploads: {}, uploadPromises: {}, setupSaved: false };
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

export async function saveInterviewSetup(draft: InterviewSetupDraft, progress = createSetupSaveProgress()) {
  const setupId = progress.setupId;
  async function retainedUpload(key: "brief" | "rubric" | "resume", kind: UploadKind, file: File | null) {
    if (key in progress.uploads) return progress.uploads[key] ?? null;
    if (progress.uploadPromises[key]) return progress.uploadPromises[key];
    if (!file) { progress.uploads[key] = null; return null; }
    const promise = uploadFile(setupId, kind, file).then((uploaded) => {
      progress.uploads[key] = uploaded;
      return uploaded;
    }).finally(() => { delete progress.uploadPromises[key]; });
    progress.uploadPromises[key] = promise;
    return promise;
  }
  const [briefUpload, rubricUpload, resumeUpload] = await Promise.all([
    retainedUpload("brief", "brief", draft.briefFile),
    retainedUpload("rubric", "rubric", draft.rubricFile),
    retainedUpload("resume", "candidate", draft.resumeFile)
  ]);

  const sources = [
    resumeUpload ? { type: "resume", reference: `upload:${resumeUpload.id}` } : null,
    optionalHttpsSource("linkedin", draft.linkedInUrl),
    optionalHttpsSource("github", draft.githubUrl),
    optionalHttpsSource("website", draft.websiteUrl)
  ].filter((source): source is { type: string; reference: string } => source !== null);

  if (progress.setupSaved) return { setupId };
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
        tools: [],
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
  if (response.status === 409) {
    const existing = await fetch(`/api/interview/setups/${setupId}`);
    if (existing.ok) { progress.setupSaved = true; return { setupId }; }
  }
  if (!response.ok) throw new Error((await response.text()).trim() || "Could not save interview setup.");
  progress.setupSaved = true;
  return { setupId };
}
