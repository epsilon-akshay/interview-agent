declare module "monaco-editor/language/typescript/monaco.contribution.js" {
  export function getTypeScriptWorker(): Promise<(uri: unknown) => Promise<unknown>>;
}
