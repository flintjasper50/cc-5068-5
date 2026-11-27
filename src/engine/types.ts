export interface AnalysisOptions {
  /** Analysis sample rate; input is resampled to this. */
  sampleRate: number;
  fftSize: number;
  hopSize: number;
  /** Structural feature rate used for the self-similarity matrix. */
  frameRate: number;
  maxFrames: number;
  melBands: number;
  mfccBands: number;
  /** Checkerboard kernel total length in seconds (visual novelty trace). */
  kernelSeconds: number;
  /** Contrast block size in bars used for detection. */
  contrastBars: number;
  /** Context window used to test whether a change is sustained. */
  contextSeconds: number;
  minSectionSeconds: number;
  minBoundaryDistanceSeconds: number;
  beatsPerBar: number;
  /**
   * Optional live-edit overrides used by the threshold workbench. Undefined
   * keeps the pinned defaults, so the batch analysis path is unchanged.
   */
  boundaryThresholdZ?: number;
  melodySimThreshold?: number;
  localScoreThreshold?: number;
  familyTimbreFloor?: number;
  /** "full" (default) computes every SSM pair; "chunked" prunes by block bounds. */
  ssmStrategy?: "full" | "chunked";
  chunkBlockFrames?: number;
  chunkPruneBound?: number;
}

export const DEFAULT_OPTIONS: AnalysisOptions = {
  sampleRate: 22050,
  fftSize: 2048,
  hopSize: 512,
  frameRate: 10,
  maxFrames: 1500,
  melBands: 40,
  mfccBands: 12,
  kernelSeconds: 8,
  contrastBars: 4,
  contextSeconds: 4,
  minSectionSeconds: 9,
  minBoundaryDistanceSeconds: 10,
  beatsPerBar: 4
};

export interface FeatureTiming {
  windowSeconds: number;
  /** Fine STFT hop in seconds (onset envelope resolution). */
  fineHopSeconds: number;
  fineFrameRate: number;
  /** Structural hop after aggregation in seconds. */
  hopSeconds: number;
  frameRate: number;
  temporalAveragingSeconds: number;
  requestedFrameRate: number;
  downsampled: boolean;
}

export interface FeatureSet {
  times: Float64Array;
  chroma: Float32Array;
  /** MFCC coefficients 1..mfccBands, level-invariant (c0 dropped). */
  mfcc: Float32Array;
  loudnessDb: Float32Array;
  /** Spectral-flux onset strength aggregated to structural frames, for display. */
  onset: Float32Array;
  timing: FeatureTiming;
  tuningOffsetSemitones: number;
}

export interface BeatGrid {
  bpm: number;
  beatTimes: Float64Array;
  downbeatTimes: Float64Array;
  beatSeconds: number;
  barSeconds: number;
  beatsPerBar: number;
  confidence: number;
  tempoConfidence: number;
  regularity: number;
  phaseConfidence: number;
  method: string;
}

export interface Bar {
  index: number;
  start: number;
  end: number;
  /** Fractional beat offset of the bar start inside the beat sequence. */
  beatIndex: number;
  features: {
    chroma: Float32Array;
    mfcc: Float32Array;
    loudnessDb: number;
  };
}

export interface SsmData {
  n: number;
  hopSeconds: number;
  times: Float64Array;
  /** Row-major NxN cosine similarity of chroma, clipped to [0,1]. */
  harmonic: Float32Array;
  /** Row-major NxN cosine similarity of MFCC, mapped to [0,1]. */
  timbre: Float32Array;
  /** Row-major NxN weighted combination used for boundary detection. */
  combined: Float32Array;
  /** Row-major NxN transposition-invariant harmonic similarity. */
  tiHarmonic: Float32Array;
  weights: { harmonic: number; timbre: number };
  /** Similarity matrix smoothing applied before novelty (frames). */
  blurSigmaFrames: number;
}

export interface NoveltyCurves {
  /** Frame times for the checkerboard display traces. */
  times: Float64Array;
  /** Checkerboard novelty of the combined SSM (display trace). */
  combined: Float32Array;
  harmonic: Float32Array;
  timbre: Float32Array;
  /** Bar times for the decision curves. */
  barTimes: Float64Array;
  /** Before/after bar-block contrast per bar boundary. */
  barHarmonicContrast: Float32Array;
  barTimbreContrast: Float32Array;
  barHarmonicZ: Float32Array;
  barTimbreZ: Float32Array;
  thresholdZ: number;
  kernelSeconds: number;
  /** Contrast block size in bars. */
  contrastBars: number;
  smoothingSeconds: number;
}

export interface BoundarySupport {
  /** 1 - raw chroma similarity between context blocks before/after. */
  harmonicContrast: number;
  /** 1 - transposition-invariant chroma similarity between contexts. */
  tiHarmonicContrast: number;
  /** 1 - timbre similarity between contexts. */
  timbreContrast: number;
  /** Absolute median loudness difference in dB. */
  loudnessContrastDb: number;
  /** Best transposition between the two contexts, in semitones. */
  contextTransposition: number;
}

export interface BoundaryUncertainty {
  /** Half the structural frame hop, quantisation of peak time. */
  frameSeconds: number;
  /** Distance between acoustic peak and bar-aligned cue time. */
  gridOffsetSeconds: number;
  /** Half-width of the novelty peak above half prominence. */
  peakHalfWidthSeconds: number;
  /** Half a beat, the worst-case phase error of the beat grid. */
  halfBeatSeconds: number;
  /** Total acoustic localisation estimate (quadrature). */
  totalSeconds: number;
  sources: string[];
}

export type BoundaryKind = "sharp" | "gradual" | "weak";

export interface Boundary {
  id: string;
  /** Acoustic boundary time (sub-frame peak). */
  time: number;
  /** Bar/beat-aligned cue time used for playback and references. */
  cueTime: number;
  barIndex: number | null;
  beatAligned: boolean;
  zScore: number;
  strength: number;
  confidence: number;
  kind: BoundaryKind;
  support: BoundarySupport;
  uncertainty: BoundaryUncertainty;
  /** Peak prominence above the surrounding novelty baseline. */
  prominence: number;
}

export interface RejectedCandidate {
  time: number;
  zScore: number;
  reason: string;
  support: BoundarySupport;
}

export interface SectionMatch {
  otherId: string;
  harmonicSimilarity: number;
  tiHarmonicSimilarity: number;
  timbreSimilarity: number;
  transpositionSemitones: number;
  /**
   * Transposition-invariant similarity of mean-centred chroma centroids. Mean
   * removal strips the prevailing key's DC component, which otherwise pushes
   * every pair of sections in one key above 0.9 and hides the theme.
   */
  themeChromaSimilarity: number;
  /** Combined theme evidence, roughly -1..1: timbre centroid + centred chroma. */
  themeScore: number;
  /** Alignment-tolerant bar-level similarity (best match within a local window). */
  localScore: number;
  /** Similarity of the closing bars only, for reporting altered endings. */
  endingScore: number;
}

export interface Section {
  id: string;
  index: number;
  /** Acoustic extent from novelty peaks. */
  start: number;
  end: number;
  /** Bar-aligned playback extent. */
  cueStart: number;
  cueEnd: number;
  startBar: number;
  endBar: number;
  /** Neutral acoustic label S1, S2, ... */
  label: string;
  /** Repetition family A, B, ... based on transposition-invariant harmony. */
  group: string;
  groupConfidence: number;
  confidence: number;
  duration: number;
  /** 0..1, mean similarity of frames to the section centroid. */
  harmonicConsistency: number;
  timbreConsistency: number;
  centroidChroma: Float32Array;
  centroidMfcc: Float32Array;
  matches: SectionMatch[];
  notes: string[];
}

export interface Group {
  label: string;
  sectionIds: string[];
  centroidChroma: Float32Array;
  centroidMfcc: Float32Array;
}

export interface SsmStats {
  harmonicBlockMean: number;
  timbreBlockMean: number;
  combinedBlockMean: number;
  diagonalContrast: number;
}

export interface AnalysisDiagnostics {
  duration: number;
  inputSampleRate: number;
  analysisSampleRate: number;
  featureTiming: FeatureTiming;
  tuningOffsetSemitones: number;
  beat: {
    bpm: number;
    confidence: number;
    tempoConfidence: number;
    regularity: number;
    phaseConfidence: number;
    method: string;
    note: string;
  };
  ssmWeights: { harmonic: number; timbre: number };
  ssmBlurSigmaFrames: number;
  noveltyThresholdZ: number;
  rejectedCandidates: RejectedCandidate[];
  loudnessOnlyCandidates: number;
  notes: string[];
  /** Present when a non-default SSM strategy (e.g. chunked) was executed. */
  ssmOptimization?: Record<string, unknown> | null;
}

export interface AnalysisResult {
  version: 1;
  duration: number;
  features: FeatureSet;
  beats: BeatGrid;
  bars: Bar[];
  ssm: SsmData;
  novelty: NoveltyCurves;
  boundaries: Boundary[];
  rejected: RejectedCandidate[];
  sections: Section[];
  groups: Group[];
  diagnostics: AnalysisDiagnostics;
  options: AnalysisOptions;
}

export interface BarFeature {
  index: number;
  start: number;
  end: number;
  chroma: Float32Array;
  mfcc: Float32Array;
  loudnessDb: number;
}

export interface AlignmentStep {
  refBar: number;
  takeBar: number | null;
  cost: number;
  tiSimilarity: number;
  timbreSimilarity: number;
  shiftSemitones: number;
}

export interface SectionAlignment {
  sectionId: string;
  sectionIndex: number;
  referenceBarStart: number;
  referenceBarEnd: number;
  steps: AlignmentStep[];
  localScore: number;
  globalScore: number;
  localCostPerBar: number;
  globalCostPerBar: number;
  coverage: number;
  unmatchedReferenceBars: number[];
  dominantTransposition: number;
  takeStartBar: number | null;
  takeEndBar: number | null;
  decision: "local" | "global";
  decisionNote: string;
}

export interface TakeAlignment {
  takeDuration: number;
  takeBarCount: number;
  sections: SectionAlignment[];
  barMap: Int32Array;
  deletedReferenceBars: number[];
  score: number;
}

export interface CueReference {
  id: string;
  label: string;
  sectionIndex: number;
  sectionLabel: string;
  /** 0-based bar offset inside the section. */
  barOffset: number;
  /** Content fingerprint: L2-normalised chroma and MFCC of the anchor bar. */
  fingerprintChroma: number[];
  fingerprintMfcc: number[];
  sourceStart: number;
  sourceCueTime: number;
}

export type CueStatus = "valid" | "retargeted" | "invalid" | "fallback";

export interface ResolvedCue {
  cue: CueReference;
  status: CueStatus;
  sourceBar: number | null;
  takeBar: number | null;
  takeTime: number | null;
  fallbackOf?: string;
  note: string;
}
