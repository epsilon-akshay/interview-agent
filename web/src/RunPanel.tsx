import type { RunResult } from "./runner/types";
import type { KeyboardEvent } from "react";

type Props = {
  running: boolean;
  result: RunResult | null;
  totalTests: number;
  collapsed: boolean;
  activeTab: "tests" | "output";
  onRun: () => void;
  onToggleCollapsed: () => void;
  onTabChange: (tab: "tests" | "output") => void;
};

function displayValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function RunPanel({
  running,
  result,
  totalTests,
  collapsed,
  activeTab,
  onRun,
  onToggleCollapsed,
  onTabChange
}: Props) {
  const passedCount = result?.status === "completed" ? result.passedCount : null;
  const badgeTotal = result?.totalCount ?? totalTests;
  const allPassed = result?.status === "completed" && result.passedCount === result.totalCount && result.totalCount > 0;
  const badgeClass =
    result?.status === "completed"
      ? allPassed
        ? "run-badge pass"
        : "run-badge fail"
      : "run-badge";

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, current: "tests" | "output") {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? "tests" : event.key === "End" ? "output" : current === "tests" ? "output" : "tests";
    onTabChange(next);
    document.getElementById(`run-tab-${next}`)?.focus();
  }

  return (
    <div className={`run-panel ${collapsed ? "collapsed" : ""}`}>
      <div className="run-panel-header">
        <button className="run-button" onClick={onRun} disabled={running}>
          {running ? <span className="run-spinner" aria-hidden="true" /> : <span aria-hidden="true">▶</span>}
          Run
        </button>
        <div className="run-tabs" role="tablist" aria-label="Code results">
          <button
            id="run-tab-tests"
            className={activeTab === "tests" ? "run-tab active" : "run-tab"}
            onClick={() => onTabChange("tests")}
            onKeyDown={(event) => moveTab(event, "tests")}
            type="button"
            role="tab"
            aria-selected={activeTab === "tests"}
            aria-controls="run-panel-tests"
            tabIndex={activeTab === "tests" ? 0 : -1}
          >
            Tests
            <span className={badgeClass}>
              {passedCount === null ? `Tests —/${badgeTotal}` : `Tests ${passedCount}/${badgeTotal}`}
            </span>
          </button>
          <button
            id="run-tab-output"
            className={activeTab === "output" ? "run-tab active" : "run-tab"}
            onClick={() => onTabChange("output")}
            onKeyDown={(event) => moveTab(event, "output")}
            type="button"
            role="tab"
            aria-selected={activeTab === "output"}
            aria-controls="run-panel-output"
            tabIndex={activeTab === "output" ? 0 : -1}
          >
            Output
          </button>
        </div>
        <button className="run-collapse" onClick={onToggleCollapsed} type="button" aria-label={collapsed ? "Expand run panel" : "Collapse run panel"}>
          {collapsed ? "⌃" : "⌄"}
        </button>
      </div>

      {!collapsed && (
        <div className="run-panel-body">
          <div id="run-panel-tests" role="tabpanel" aria-labelledby="run-tab-tests" hidden={activeTab !== "tests"}><TestsTab running={running} result={result} totalTests={totalTests} /></div>
          <div id="run-panel-output" role="tabpanel" aria-labelledby="run-tab-output" hidden={activeTab !== "output"}><OutputTab result={result} /></div>
        </div>
      )}
    </div>
  );
}

function TestsTab({
  running,
  result,
  totalTests
}: {
  running: boolean;
  result: RunResult | null;
  totalTests: number;
}) {
  if (!result && !running) {
    return (
      <div className="run-tests idle">
        <p className="run-caption">Run your code to check it against the test cases.</p>
        <ul>
          {Array.from({ length: totalTests }, (_, index) => (
            <li key={index} className="test-row pending">
              <span className="test-mark">○</span>
              <span>Test {index + 1}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (running && !result) {
    return <p className="run-caption">Running tests…</p>;
  }

  if (!result) return null;

  if (result.status === "compile_error" || result.status === "fatal_error" || result.status === "timeout") {
    return <div className="run-error-block" role="alert">{result.message}</div>;
  }

  return (
    <ul className="run-tests">
      {result.tests.map((test) => (
        <li key={test.index} className={test.passed ? "test-row pass" : "test-row fail"}>
          <span className="test-mark">{test.passed ? "✓" : "✗"}</span>
          <span className="test-label">Test {test.index}</span>
          <span className="test-args">{displayValue(test.args.length === 1 ? test.args[0] : test.args)}</span>
          <span className="test-detail">
            {test.error
              ? test.error
              : test.passed
                ? `→ ${displayValue(test.got)}`
                : `expected ${displayValue(test.expected)}, got ${displayValue(test.got)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function OutputTab({ result }: { result: RunResult | null }) {
  if (!result) {
    return <p className="run-caption">Console output and type warnings appear here after a run.</p>;
  }

  const lines = [
    ...result.warnings.map((line) => ({ kind: "warn" as const, text: line })),
    ...result.consoleOutput.map((line) => ({ kind: "log" as const, text: line }))
  ];

  if (lines.length === 0) {
    return <p className="run-caption">No console output.</p>;
  }

  return (
    <ul className="run-output">
      {lines.map((line, index) => (
        <li key={`${line.kind}-${index}`} className={line.kind === "warn" ? "output-warn" : "output-log"}>
          {line.kind === "warn" ? "⚠ " : ""}
          {line.text}
        </li>
      ))}
    </ul>
  );
}
