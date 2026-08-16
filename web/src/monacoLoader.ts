import * as defaultMonaco from "monaco-editor";

type MonacoInstance = typeof defaultMonaco;
type CancelablePromise<T> = Promise<T> & { cancel: () => void };

let configuredMonaco: MonacoInstance = defaultMonaco;

function cancelable<T>(value: T): CancelablePromise<T> {
  const promise = Promise.resolve(value) as CancelablePromise<T>;
  promise.cancel = () => undefined;
  return promise;
}

// This is the small public loader contract consumed by @monaco-editor/react.
// Vite aliases it to the installed ESM Monaco package, so no AMD loader or CDN
// path is ever injected into the browser build.
const loader = {
  config(options: { monaco?: MonacoInstance }) {
    if (options.monaco) configuredMonaco = options.monaco;
  },
  init() {
    return cancelable(configuredMonaco);
  },
  __getMonacoInstance() {
    return configuredMonaco;
  }
};

export default loader;
