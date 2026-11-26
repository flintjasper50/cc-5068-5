import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisOptions, AnalysisResult } from "../../engine/types";
import type { AnalyseResponse } from "../../worker/analyse.worker";

export interface AnalysisState {
  status: "idle" | "running" | "done" | "error";
  progress: number;
  label: string;
  result: AnalysisResult | null;
  error: string | null;
}

export function useAnalyser() {
  const workerRef = useRef<Worker | null>(null);
  const [state, setState] = useState<AnalysisState>({
    status: "idle",
    progress: 0,
    label: "",
    result: null,
    error: null
  });

  useEffect(() => {
    const worker = new Worker(
      new URL("../../worker/analyse.worker.ts", import.meta.url),
      { type: "module" }
    );
    worker.onmessage = (event: MessageEvent<AnalyseResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        setState((s) => ({ ...s, status: "running", progress: message.progress, label: message.label }));
      } else if (message.type === "done") {
        setState({
          status: "done",
          progress: 1,
          label: "Done",
          result: message.result,
          error: null
        });
        workerRef.current = worker;
      } else {
        setState({ status: "error", progress: 0, label: "", result: null, error: message.message });
      }
    };
    worker.onerror = (event) => {
      setState({ status: "error", progress: 0, label: "", result: null, error: event.message });
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const analyse = useCallback(
    (channels: Float32Array[], sampleRate: number, options?: Partial<AnalysisOptions>) => {
      if (!workerRef.current) {
        setState({ status: "error", progress: 0, label: "", result: null, error: "Worker unavailable" });
        return;
      }
      setState({ status: "running", progress: 0, label: "Queued", result: null, error: null });
      workerRef.current.postMessage({ type: "analyse", channels, sampleRate, options });
    },
    []
  );

  return { state, analyse };
}
