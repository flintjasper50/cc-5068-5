import { DEFAULT_OPTIONS, AnalysisOptions, AnalysisResult } from "./types";
import { downmixToMono } from "./wav";
import { resampleSinc } from "./dsp";
import { extractFeatures } from "./features";
import { analyseBeats } from "./beat";
import { buildBars } from "./bars";
import { buildSsm, blurMatrix } from "./ssm";
import { buildSsmChunked } from "./ssmChunked";
import { detectBoundaries } from "./boundary";
import { buildSections } from "./sections";

export interface AnalyseInput {
  channels: Float32Array[];
  sampleRate: number;
  options?: Partial<AnalysisOptions>;
  /** Optional hook for progress messages (0..1, label). */
  onProgress?: (progress: number, label: string) => void;
}

export function analyseAudio(input: AnalyseInput): AnalysisResult {
  const options: AnalysisOptions = { ...DEFAULT_OPTIONS, ...input.options };
  const progress = (p: number, label: string) => input.onProgress?.(p, label);
  progress(0.02, "Mixing to mono");
  const monoRaw = downmixToMono(input.channels);
  const duration = monoRaw.length / input.sampleRate;

  progress(0.08, "Resampling");
  const mono =
    input.sampleRate === options.sampleRate
      ? monoRaw
      : resampleSinc(monoRaw, input.sampleRate, options.sampleRate);

  progress(0.16, "Extracting harmonic and timbre features");
  const features = extractFeatures({ mono, sampleRate: options.sampleRate, options });

  progress(0.34, "Tracking beats and bars");
  const beats = analyseBeats(mono, options.sampleRate, {
    sampleRate: options.sampleRate,
    beatsPerBar: options.beatsPerBar,
    duration
  });
  const bars = buildBars(features, beats, duration, options);

  progress(0.44, "Building self-similarity matrices");
  // The default "full" path preserves the exact reference semantics. The
  // opt-in chunked path carries bound/error stats for the optimisation gate.
  let rawSsm;
  let ssmOptimization: Record<string, unknown> | null = null;
  if (options.ssmStrategy === "chunked") {
    const chunked = buildSsmChunked(features, options);
    rawSsm = chunked.ssm;
    ssmOptimization = chunked.stats as unknown as Record<string, unknown>;
  } else {
    rawSsm = buildSsm(features, options).ssm;
  }
  // Smooth the combined matrix before novelty, and keep the raw matrices for
  // the display so the visualisation reflects what was actually measured.
  const blurred = blurMatrix(rawSsm.combined, rawSsm.n, rawSsm.blurSigmaFrames);
  rawSsm.combined = blurred;
  rawSsm.harmonic = blurMatrix(rawSsm.harmonic, rawSsm.n, rawSsm.blurSigmaFrames);
  rawSsm.timbre = blurMatrix(rawSsm.timbre, rawSsm.n, rawSsm.blurSigmaFrames);

  progress(0.58, "Detecting structural boundaries");
  const detection = detectBoundaries(features, rawSsm, bars, beats, options);

  progress(0.74, "Grouping repeated sections");
  const { sections, groups, notes } = buildSections(
    detection.boundaries,
    bars,
    rawSsm,
    duration,
    options
  );

  progress(0.9, "Compiling diagnostics");
  const notesAll = [...detection.notes, ...notes];
  if (beats.method.includes("fallback")) {
    notesAll.push(
      "Beat grid is a uniform fallback; bar-aligned cue times are approximate and acoustic peak times should be preferred."
    );
  }
  if (features.timing.downsampled) {
    notesAll.push(
      `Structural frame rate reduced to ${features.timing.frameRate.toFixed(2)} Hz to bound memory; boundary resolution is ±${(features.timing.hopSeconds / 2).toFixed(2)}s.`
    );
  }
  if (Math.abs(features.tuningOffsetSemitones) > 0.08) {
    notesAll.push(
      `Estimated tuning offset ${features.tuningOffsetSemitones.toFixed(2)} semitones applied to chroma binning.`
    );
  }
  notesAll.push(
    "Section labels S1… and families A, B… describe acoustic repetition only; no functional labels were assigned."
  );

  const result: AnalysisResult = {
    version: 1,
    duration,
    features,
    beats,
    bars,
    ssm: rawSsm,
    novelty: detection.novelty,
    boundaries: detection.boundaries,
    rejected: detection.rejected,
    sections,
    groups,
    diagnostics: {
      duration,
      inputSampleRate: input.sampleRate,
      analysisSampleRate: options.sampleRate,
      featureTiming: features.timing,
      tuningOffsetSemitones: features.tuningOffsetSemitones,
      beat: {
        bpm: beats.bpm,
        confidence: beats.confidence,
        tempoConfidence: beats.tempoConfidence,
        regularity: beats.regularity,
        phaseConfidence: beats.phaseConfidence,
        method: beats.method,
        note:
          beats.beatTimes.length >= 4
            ? `${beats.beatTimes.length} beats; phase offset chosen by onset-weighted downbeats (confidence ${(beats.phaseConfidence * 100).toFixed(0)}%).`
            : "Too few beats for a stable grid."
      },
      ssmWeights: rawSsm.weights,
      ssmBlurSigmaFrames: rawSsm.blurSigmaFrames,
      noveltyThresholdZ: detection.novelty.thresholdZ,
      rejectedCandidates: detection.rejected,
      loudnessOnlyCandidates: detection.rejected.filter((r) => r.reason.startsWith("loudness-only")).length,
      notes: notesAll,
      ssmOptimization
    },
    options
  };
  progress(1, "Done");
  return result;
}
