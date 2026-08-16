import type { RunResult } from "../runner/types";
import type { Observation } from "./types";

/**
 * Turns a code run into an observation. This is a FACT, not a judgement.
 * It makes no model call. Do not add one.
 */
export function observeTestRun(lastRun: RunResult | null, areaId = "correctness"): Observation | null {
  if (!lastRun) return null;

  let finding: string;
  if (lastRun.status === "compile_error") {
    finding = `Code did not compile at revision ${lastRun.codeRevision}: ${lastRun.message ?? "unknown error"}`;
  } else if (lastRun.status === "timeout") {
    finding = `Code timed out at revision ${lastRun.codeRevision}.`;
  } else if (lastRun.status === "fatal_error") {
    finding = `Code failed to run at revision ${lastRun.codeRevision}: ${lastRun.message ?? "unknown error"}`;
  } else {
    const failures = lastRun.tests
      .filter((test) => !test.passed)
      .map((test) => `test ${test.index} (input ${JSON.stringify(test.args)}) returned ${JSON.stringify(test.got)}`)
      .join("; ");
    finding = `Ran tests at revision ${lastRun.codeRevision}: ${lastRun.passedCount} of ${lastRun.totalCount} passed.`;
    if (failures) finding += ` Failures: ${failures}.`;
  }

  return { observer: "tests", areaId, finding, confidence: 1, codeRevision: lastRun.codeRevision, whiteboardRevision: 0, at: Date.now() };
}
