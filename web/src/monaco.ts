import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "typescript" || label === "javascript") return new TypeScriptWorker();
    return new EditorWorker();
  }
};

// Passing the installed ESM build prevents @monaco-editor/loader from fetching
// Monaco workers or editor files from a CDN.
loader.config({ monaco });
