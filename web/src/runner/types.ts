export type QuestionTest = {
  args: unknown[];
  expected: unknown;
};

export type QuestionConfig = {
  id: string;
  language: string;
  entryFunction: string;
  prompt: string;
  starterCode: string;
  tests: QuestionTest[];
};

export type TestResult = {
  index: number;
  args: unknown[];
  expected: unknown;
  got: unknown;
  passed: boolean;
  error: string | null;
};

export type RunResult = {
  status: "compile_error" | "fatal_error" | "timeout" | "completed";
  message: string | null;
  warnings: string[];
  consoleOutput: string[];
  tests: TestResult[];
  passedCount: number;
  totalCount: number;
  ranAt: number;
  codeRevision: number;
};

export type WorkerInbound = {
  javascript: string;
  entryFunction: string;
  tests: QuestionTest[];
};

export type WorkerOutbound = {
  consoleOutput: string[];
  results: { index: number; passed: boolean; got: unknown; error: string | null }[];
  fatalError: string | null;
};
