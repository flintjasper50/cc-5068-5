/// <reference lib="webworker" />
import { analyseAudio } from "../engine/analyse";
import type { AnalysisOptions } from "../engine/types";

export interface AnalyseRequest {
  type: "analyse";
  channels: Float32Array[];
  sampleRate: number;
  options?: Partial<AnalysisOptions>;
}

export type AnalyseResponse =
  | { type: "progress"; progress: number; label: string }
  | { type: "done"; result: ReturnType<typeof analyseAudio> }
  | { type: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<AnalyseRequest>) => {
  const message = event.data;
  if (message.type !== "analyse") return;
  try {
    const result = analyseAudio({
      channels: message.channels,
      sampleRate: message.sampleRate,
      options: message.options,
      onProgress: (progress, label) => {
        const response: AnalyseResponse = { type: "progress", progress, label };
        ctx.postMessage(response);
      }
    });
    const response: AnalyseResponse = { type: "done", result };
    ctx.postMessage(response);
  } catch (error) {
    const response: AnalyseResponse = {
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    };
    ctx.postMessage(response);
  }
};
