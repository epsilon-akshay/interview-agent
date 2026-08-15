import { useState } from "react";
import type {
  ChannelOption,
  InterviewSetupDraft,
  InterviewType,
  RubricCriterionDraft,
  ToolOption,
  WorkspaceOption
} from "./setup/types";
import { setupStepError } from "./setup/types";

type Props = {
  value: InterviewSetupDraft;
  onChange: (value: InterviewSetupDraft) => void;
  onStart: () => void;
  busy: boolean;
  error: string;
};

const STEPS = ["Basics", "Format", "Context", "Rubric", "Access"];
const INTERVIEW_TYPES: { value: InterviewType; label: string }[] = [
  { value: "coding", label: "Coding" },
  { value: "system_design", label: "System design" },
  { value: "behavioral", label: "Behavioral" },
  { value: "mixed", label: "Mixed" }
];
const QUESTION_TYPES = [
  { value: "problem_solving", label: "Problem solving" },
  { value: "debugging", label: "Debugging" },
  { value: "complexity", label: "Complexity" },
  { value: "system_design", label: "System design" },
  { value: "behavioral", label: "Behavioral" }
];
const ACCEPTED_FILES = ".pdf,.txt,.md,.json,.docx";

function toggleValue<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function FileField({
  label,
  hint,
  file,
  onChange
}: {
  label: string;
  hint: string;
  file: File | null;
  onChange: (file: File | null) => void;
}) {
  return (
    <label className="setup-file-field">
      <span>{label}</span>
      <input
        type="file"
        accept={ACCEPTED_FILES}
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
      <small>{file ? file.name : hint}</small>
    </label>
  );
}

function Choice({
  checked,
  label,
  description,
  onChange
}: {
  checked: boolean;
  label: string;
  description?: string;
  onChange: () => void;
}) {
  return (
    <label className={`setup-choice ${checked ? "selected" : ""}`}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
}

function RubricRow({
  criterion,
  index,
  canRemove,
  onChange,
  onRemove
}: {
  criterion: RubricCriterionDraft;
  index: number;
  canRemove: boolean;
  onChange: (criterion: RubricCriterionDraft) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rubric-row">
      <div className="rubric-row-heading">
        <strong>{criterion.name.trim() || `Criterion ${index + 1}`}</strong>
        {canRemove ? <button type="button" className="setup-link-button" onClick={onRemove}>Remove</button> : null}
      </div>
      <div className="setup-row rubric-fields">
        <label>
          Criterion name
          <input value={criterion.name} onChange={(event) => onChange({ ...criterion, name: event.target.value })} />
        </label>
        <label>
          Weight
          <input
            type="number"
            min="1"
            max="100"
            value={criterion.weight}
            onChange={(event) => onChange({ ...criterion, weight: Number(event.target.value) || 0 })}
          />
        </label>
      </div>
      <label>
        Evidence expected
        <textarea
          rows={2}
          value={criterion.expectedEvidence}
          onChange={(event) => onChange({ ...criterion, expectedEvidence: event.target.value })}
        />
      </label>
      <label className="criterion-id-field">
        Criterion ID
        <input value={criterion.id} onChange={(event) => onChange({ ...criterion, id: event.target.value })} />
      </label>
    </div>
  );
}

export function SetupWizard({ value, onChange, onStart, busy, error }: Props) {
  const [step, setStep] = useState(0);
  const [localError, setLocalError] = useState("");
  const rubricTotal = value.rubricCriteria.reduce((sum, criterion) => sum + criterion.weight, 0);

  function update(patch: Partial<InterviewSetupDraft>) {
    onChange({ ...value, ...patch });
    setLocalError("");
  }

  function continueForward() {
    const nextError = setupStepError(value, step);
    if (nextError) {
      setLocalError(nextError);
      return;
    }
    setLocalError("");
    setStep((current) => Math.min(STEPS.length - 1, current + 1));
  }

  function updateCriterion(index: number, criterion: RubricCriterionDraft) {
    update({
      rubricCriteria: value.rubricCriteria.map((current, currentIndex) => currentIndex === index ? criterion : current)
    });
  }

  function addCriterion() {
    const index = value.rubricCriteria.length + 1;
    update({
      rubricCriteria: [
        ...value.rubricCriteria,
        { id: `criterion_${index}`, name: "", weight: 0, expectedEvidence: "" }
      ]
    });
  }

  return (
    <section className="setup-wizard" aria-label="Interview setup">
      <nav className="setup-progress" aria-label="Setup progress">
        {STEPS.map((label, index) => (
          <div key={label} className={index === step ? "active" : index < step ? "complete" : ""} aria-current={index === step ? "step" : undefined}>
            <span>{index + 1}</span>
            <small>{label}</small>
          </div>
        ))}
      </nav>

      <div className="setup-step" key={step}>
        {step === 0 ? (
          <>
            <div className="setup-step-heading">
              <h2>Who is this interview for?</h2>
              <p>Set the candidate and the role being assessed.</p>
            </div>
            <div className="setup-row">
              <label>
                Candidate name
                <input autoFocus value={value.candidateName} onChange={(event) => update({ candidateName: event.target.value })} placeholder="Alex Morgan" />
              </label>
              <label>
                Target role
                <input value={value.roleTitle} onChange={(event) => update({ roleTitle: event.target.value })} placeholder="Software Engineer" />
              </label>
            </div>
            <label>
              Seniority level
              <select value={value.roleLevel} onChange={(event) => update({ roleLevel: event.target.value })}>
                <option>Entry-level</option>
                <option>Mid-level</option>
                <option>Senior</option>
                <option>Staff</option>
                <option>Principal</option>
              </select>
            </label>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="setup-step-heading">
              <h2>Shape the interview</h2>
              <p>Set the format, time, language, and question mix.</p>
            </div>
            <div className="setup-row">
              <label>
                Interview type
                <select value={value.interviewType} onChange={(event) => update({ interviewType: event.target.value as InterviewType })}>
                  {INTERVIEW_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label>
                Duration in minutes
                <input
                  type="number"
                  min="1"
                  max="120"
                  value={value.durationMinutes}
                  onChange={(event) => update({ durationMinutes: Number(event.target.value) || 1 })}
                />
              </label>
            </div>
            <label>
              Coding language
              <input
                value={value.codingLanguage}
                onChange={(event) => update({ codingLanguage: event.target.value })}
                placeholder="TypeScript"
                disabled={value.interviewType === "behavioral"}
              />
            </label>
            <fieldset>
              <legend>Question types</legend>
              <div className="setup-choice-grid compact">
                {QUESTION_TYPES.map((option) => (
                  <Choice
                    key={option.value}
                    checked={value.questionTypes.includes(option.value)}
                    label={option.label}
                    onChange={() => update({ questionTypes: toggleValue(value.questionTypes, option.value) })}
                  />
                ))}
              </div>
            </fieldset>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <div className="setup-step-heading">
              <h2>Add relevant context</h2>
              <p>Provide an interview brief and reviewed candidate information.</p>
            </div>
            <label>
              Interview brief
              <textarea rows={4} value={value.briefText} onChange={(event) => update({ briefText: event.target.value })} />
            </label>
            <FileField
              label="Brief file"
              hint="PDF, DOCX, TXT, Markdown, or JSON. Maximum 10 MB."
              file={value.briefFile}
              onChange={(briefFile) => update({ briefFile })}
            />
            <div className="setup-divider" />
            <div className="setup-row">
              <FileField
                label="Candidate résumé"
                hint="Optional. The file will not become scoring evidence."
                file={value.resumeFile}
                onChange={(resumeFile) => update({ resumeFile })}
              />
              <label>
                LinkedIn URL
                <input type="url" value={value.linkedInUrl} onChange={(event) => update({ linkedInUrl: event.target.value })} placeholder="https://linkedin.com/in/..." />
              </label>
            </div>
            <div className="setup-row">
              <label>
                GitHub URL
                <input type="url" value={value.githubUrl} onChange={(event) => update({ githubUrl: event.target.value })} placeholder="https://github.com/..." />
              </label>
              <label>
                Portfolio URL
                <input type="url" value={value.websiteUrl} onChange={(event) => update({ websiteUrl: event.target.value })} placeholder="https://..." />
              </label>
            </div>
            <label>
              Reviewed candidate facts
              <textarea
                rows={3}
                value={value.reviewedFacts}
                onChange={(event) => update({ reviewedFacts: event.target.value })}
                placeholder="One reviewed, job-related fact per line"
              />
              <small>These facts can tailor questions. They cannot affect scoring.</small>
            </label>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <div className="setup-step-heading rubric-heading">
              <div>
                <h2>Define the scoring rubric</h2>
                <p>Every criterion needs a weight and observable evidence.</p>
              </div>
              <span className={rubricTotal === 100 ? "valid" : "invalid"}>{rubricTotal}% total</span>
            </div>
            <div className="rubric-list">
              {value.rubricCriteria.map((criterion, index) => (
                <RubricRow
                  key={index}
                  criterion={criterion}
                  index={index}
                  canRemove={value.rubricCriteria.length > 1}
                  onChange={(next) => updateCriterion(index, next)}
                  onRemove={() => update({ rubricCriteria: value.rubricCriteria.filter((_, currentIndex) => currentIndex !== index) })}
                />
              ))}
            </div>
            <button type="button" className="setup-add-button" onClick={addCriterion}>Add criterion</button>
            <label>
              Additional rubric guidance
              <textarea rows={3} value={value.rubricSourceText} onChange={(event) => update({ rubricSourceText: event.target.value })} placeholder="Optional scoring guidance" />
            </label>
            <FileField
              label="Rubric file"
              hint="Optional source file. Structured criteria remain authoritative."
              file={value.rubricFile}
              onChange={(rubricFile) => update({ rubricFile })}
            />
          </>
        ) : null}

        {step === 4 ? (
          <>
            <div className="setup-step-heading">
              <h2>Choose access and review</h2>
              <p>Set the candidate's workspaces, tools, and interview channel.</p>
            </div>
            <fieldset>
              <legend>Candidate workspaces</legend>
              <div className="setup-choice-grid">
                <Choice
                  checked={value.workspaces.includes("code_editor")}
                  label="Code editor"
                  description="Write and run code in the browser."
                  onChange={() => update({ workspaces: toggleValue<WorkspaceOption>(value.workspaces, "code_editor") })}
                />
                <Choice
                  checked={value.workspaces.includes("whiteboard")}
                  label="Whiteboard"
                  description="Explain systems with shapes and labels."
                  onChange={() => update({ workspaces: toggleValue<WorkspaceOption>(value.workspaces, "whiteboard") })}
                />
              </div>
            </fieldset>
            <fieldset>
              <legend>Candidate tools</legend>
              <div className="setup-choice-grid">
                <Choice
                  checked={value.tools.includes("ai_chat")}
                  label="AI chat"
                  description="Use AI help while implementing code in the editor."
                  onChange={() => update({ tools: toggleValue<ToolOption>(value.tools, "ai_chat") })}
                />
              </div>
            </fieldset>
            <fieldset>
              <legend>Interview channel</legend>
              <div className="setup-choice-grid">
                <Choice
                  checked={value.channels.includes("voice")}
                  label="Voice"
                  description="Run a spoken Realtime interview."
                  onChange={() => update({ channels: toggleValue<ChannelOption>(value.channels, "voice") })}
                />
              </div>
            </fieldset>
            <dl className="setup-review">
              <div><dt>Candidate</dt><dd>{value.candidateName}</dd></div>
              <div><dt>Role</dt><dd>{value.roleLevel} {value.roleTitle}</dd></div>
              <div><dt>Interview</dt><dd>{value.interviewType.replaceAll("_", " ")} · {value.durationMinutes} minutes</dd></div>
              <div><dt>Rubric</dt><dd>{value.rubricCriteria.length} criteria · {rubricTotal}% total</dd></div>
            </dl>
            <p className="setup-policy-note">Candidate information can tailor job-related questions. It cannot change rubric weights or count as interview evidence.</p>
          </>
        ) : null}
      </div>

      {(localError || error) ? <div className="setup-error" role="alert">{localError || error}</div> : null}

      <footer className="setup-actions">
        <button type="button" className="setup-back" disabled={step === 0 || busy} onClick={() => { setLocalError(""); setStep((current) => Math.max(0, current - 1)); }}>
          Back
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" className="setup-continue" onClick={continueForward}>Continue</button>
        ) : (
          <button type="button" className="setup-continue" disabled={busy} onClick={() => {
            const nextError = setupStepError(value, step);
            if (nextError) setLocalError(nextError);
            else onStart();
          }}>
            {busy ? "Preparing interview…" : `Start ${value.durationMinutes}-minute interview`}
          </button>
        )}
      </footer>
    </section>
  );
}
