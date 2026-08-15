import OpenAI from "openai";
import { setDefaultOpenAIClient, setTracingDisabled } from "@openai/agents";

export type ModelConfig = {
  observerModel: string;
  orchestratorModel: string;
  realtimeModel: string;
};

let modelConfig: ModelConfig | null = null;

/**
 * Points the Agents SDK at the Go proxy so the real API key never reaches the
 * browser. Call this once before running any Agent. Safe to call repeatedly.
 */
export async function initialiseAgentClient(): Promise<ModelConfig> {
  if (modelConfig) return modelConfig;

  setDefaultOpenAIClient(
    new OpenAI({
      baseURL: `${window.location.origin}/api/openai/v1`,
      apiKey: "proxied-by-go-server",
      dangerouslyAllowBrowser: true
    })
  );
  // Tracing does not work when the core SDK is bundled for the browser.
  setTracingDisabled(true);

  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("Could not load model configuration.");
  modelConfig = (await response.json()) as ModelConfig;
  return modelConfig;
}

export function getModelConfig(): ModelConfig {
  if (!modelConfig) throw new Error("initialiseAgentClient() was not called.");
  return modelConfig;
}
