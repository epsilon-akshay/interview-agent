import type { OnMount } from "@monaco-editor/react";
import type { QuestionTest, RunResult, WorkerInbound, WorkerOutbound } from "./types";

type EditorInstance = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];
type TextModel = NonNullable<ReturnType<EditorInstance["getModel"]>>;

type TsDiagnostic = {
  start?: number;
  messageText: string | { messageText: string };
};

type TsWorkerClient = {
  getSyntacticDiagnostics: (uri: string) => Promise<TsDiagnostic[]>;
  getSemanticDiagnostics: (uri: string) => Promise<TsDiagnostic[]>;
  getEmitOutput: (uri: string) => Promise<{ outputFiles: { text: string }[] }>;
};

function formatDiagnostic(model: TextModel, diagnostic: TsDiagnostic): string {
  const message =
    typeof diagnostic.messageText === "string"
      ? diagnostic.messageText
      : diagnostic.messageText.messageText;
  const start = diagnostic.start ?? 0;
  const position = model.getPositionAt(start);
  return `Line ${position.lineNumber}: ${message}`;
}

function createWorker() {
  return new Worker(new URL("./execute.worker.ts", import.meta.url), { type: "module" });
}

export async function runCode(options: {
  monaco: MonacoInstance;
  model: TextModel;
  entryFunction: string;
  tests: QuestionTest[];
  codeRevision: number;
}): Promise<RunResult> {
  const { monaco, model, entryFunction, tests, codeRevision } = options;
  const ranAt = Date.now();
  const uri = model.uri.toString();

  const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
  const client = (await getWorker(model.uri)) as TsWorkerClient;
  const syntactic = await client.getSyntacticDiagnostics(uri);

  if (syntactic.length > 0) {
    const message = syntactic.map((d) => formatDiagnostic(model, d)).join("\n");
    return {
      status: "compile_error",
      message,
      warnings: [],
      consoleOutput: [],
      tests: [],
      passedCount: 0,
      totalCount: tests.length,
      ranAt,
      codeRevision
    };
  }

  const semantic = await client.getSemanticDiagnostics(uri);
  const warnings = semantic.map((d) => formatDiagnostic(model, d));
  const emit = await client.getEmitOutput(uri);
  const javascript = emit.outputFiles[0]?.text ?? "";

  return await new Promise<RunResult>((resolve) => {
    const worker = createWorker();
    let settled = false;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };

    const timer = window.setTimeout(() => {
      finish({
        status: "timeout",
        message: "Execution timed out after 3 seconds.",
        warnings,
        consoleOutput: [],
        tests: [],
        passedCount: 0,
        totalCount: tests.length,
        ranAt,
        codeRevision
      });
    }, 3000);

    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const payload = event.data;
      if (payload.fatalError) {
        finish({
          status: "fatal_error",
          message: payload.fatalError,
          warnings,
          consoleOutput: payload.consoleOutput,
          tests: [],
          passedCount: 0,
          totalCount: tests.length,
          ranAt,
          codeRevision
        });
        return;
      }

      const mapped = payload.results.map((item) => {
        const test = tests[item.index];
        return {
          index: item.index + 1,
          args: test.args,
          expected: test.expected,
          got: item.got,
          passed: item.passed,
          error: item.error
        };
      });
      const passedCount = mapped.filter((item) => item.passed).length;

      finish({
        status: "completed",
        message: null,
        warnings,
        consoleOutput: payload.consoleOutput,
        tests: mapped,
        passedCount,
        totalCount: tests.length,
        ranAt,
        codeRevision
      });
    };

    worker.onerror = (error) => {
      finish({
        status: "fatal_error",
        message: error.message || "Worker failed.",
        warnings,
        consoleOutput: [],
        tests: [],
        passedCount: 0,
        totalCount: tests.length,
        ranAt,
        codeRevision
      });
    };

    const inbound: WorkerInbound = { javascript, entryFunction, tests };
    worker.postMessage(inbound);
  });
}

export function buildEvidenceObservation(result: RunResult): string {
  if (result.status === "compile_error") {
    return `Code run at revision ${result.codeRevision} failed to compile: ${result.message}`;
  }
  if (result.status === "fatal_error") {
    return `Code run at revision ${result.codeRevision} failed: ${result.message}`;
  }
  if (result.status === "timeout") {
    return `Code run at revision ${result.codeRevision} timed out after 3 seconds.`;
  }

  const failures = result.tests
    .filter((test) => !test.passed)
    .map((test) => {
      if (test.error) {
        return `Test ${test.index} (input: ${JSON.stringify(test.args)}) threw: ${test.error}`;
      }
      return `Test ${test.index} (input: ${JSON.stringify(test.args)}) returned ${JSON.stringify(test.got)}.`;
    });

  const head = `Code run at revision ${result.codeRevision}: ${result.passedCount} of ${result.totalCount} tests passed.`;
  return failures.length > 0 ? `${head} ${failures.join(" ")}` : head;
}
