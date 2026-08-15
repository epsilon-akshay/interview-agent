import type { WorkerInbound, WorkerOutbound } from "./types";

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]));
  }
  return false;
}

function stringifyArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

self.onmessage = (event: MessageEvent<WorkerInbound>) => {
  const { javascript, entryFunction, tests } = event.data;
  const consoleOutput: string[] = [];

  const pushConsole = (...args: unknown[]) => {
    if (consoleOutput.length >= 100) return;
    consoleOutput.push(args.map(stringifyArg).join(" "));
  };

  self.console.log = pushConsole;
  self.console.warn = pushConsole;
  self.console.error = pushConsole;

  const reply = (payload: WorkerOutbound) => {
    self.postMessage(payload);
  };

  let entry: ((...args: unknown[]) => unknown) | null = null;
  try {
    entry = new Function(
      `${javascript}\n; return typeof ${entryFunction} === "function" ? ${entryFunction} : null;`
    )() as ((...args: unknown[]) => unknown) | null;
  } catch (error) {
    reply({
      consoleOutput,
      results: [],
      fatalError: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (!entry) {
    reply({
      consoleOutput,
      results: [],
      fatalError: `Could not find a function named '${entryFunction}'. Do not rename it.`
    });
    return;
  }

  const results: WorkerOutbound["results"] = [];
  for (let i = 0; i < tests.length; i += 1) {
    const test = tests[i];
    try {
      const got = entry(...test.args);
      results.push({
        index: i,
        passed: deepEqual(got, test.expected),
        got,
        error: null
      });
    } catch (error) {
      results.push({
        index: i,
        passed: false,
        got: undefined,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  reply({ consoleOutput, results, fatalError: null });
};
