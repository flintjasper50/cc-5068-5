import {
  AnalysisOptions,
  Bar,
  BeatGrid,
  Boundary,
  BoundaryKind,
  BoundarySupport,
  BoundaryUncertainty,
  FeatureSet,
  NoveltyCurves,
  RejectedCandidate,
  SsmData
} from "./types";
import { checkerboardNovelty, cosineVV, normaliseVec } from "./ssm";

const EPS = 1e-9;

export interface BoundaryDetectionOutput {
  novelty: NoveltyCurves;
  boundaries: Boundary[];
  rejected: RejectedCandidate[];
  notes: string[];
}

// ---- Numeric helpers ------------------------------------------------------

function boxSmooth(x: Float32Array, radius: number): Float32Array {
  if (radius <= 0) return x;
  const n = x.length;
  const out = new Float32Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

function localZ(x: Float32Array, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const prefix = new Float64Array(n + 1);
  const prefixSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + x[i];
    prefixSq[i + 1] = prefixSq[i] + x[i] * x[i];
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    const count = hi - lo;
    const mean = (prefix[hi] - prefix[lo]) / count;
    const variance = Math.max(0, (prefixSq[hi] - prefixSq[lo]) / count - mean * mean);
    out[i] = variance > EPS ? (x[i] - mean) / Math.sqrt(variance) : 0;
  }
  return out;
}

function refinePeak(x: Float32Array, i: number): number {
  if (i <= 0 || i >= x.length - 1) return i;
  const a = x[i - 1];
  const b = x[i];
  const c = x[i + 1];
  const denom = a - 2 * b + c;
  if (Math.abs(denom) < EPS) return i;
  const offset = (0.5 * (a - c)) / denom;
  return Math.abs(offset) <= 0.5 ? i + offset : i;
}

// ---- Bar-level contrast ---------------------------------------------------

/**
 * Before/after block contrast on a symmetric NxN bar-similarity matrix:
 * mean within-block similarity minus cross-block similarity, for blocks of K
 * bars on either side of each bar boundary. Computed directly (bar counts are
 * small), and returned for a single similarity matrix.
 */
function barContrast(mat: Float32Array, n: number, K: number): Float32Array {
  const out = new Float32Array(n);
  for (let c = K; c < n - K; c++) {
    let left = 0;
    let right = 0;
    let cross = 0;
    for (let i = c - K; i < c; i++) {
      for (let j = c - K; j < c; j++) left += mat[i * n + j];
    }
    for (let i = c; i < c + K; i++) {
      for (let j = c; j < c + K; j++) right += mat[i * n + j];
    }
    for (let i = c - K; i < c; i++) {
      for (let j = c; j < c + K; j++) cross += mat[i * n + j];
    }
    out[c] = 0.5 * (left + right) / (K * K) - cross / (K * K);
  }
  return out;
}

function barSimilarityMatrix(
  bars: Bar[],
  channel: "harmonic" | "timbre"
): Float32Array {
  const n = bars.length;
  const dim = channel === "harmonic" ? 12 : bars[0]?.features.mfcc.length ?? 12;
  const out = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const a = channel === "harmonic" ? bars[i].features.chroma : bars[i].features.mfcc;
      const b = channel === "harmonic" ? bars[j].features.chroma : bars[j].features.mfcc;
      const v = Math.max(0, Math.min(1, cosineVV(a, 0, b, 0, dim)));
      out[i * n + j] = out[j * n + i] = v;
    }
  }
  return out;
}

// ---- Context support and uncertainty -------------------------------------

function blockMean(
  data: Float32Array,
  n: number,
  startFrame: number,
  endFrame: number,
  dim: number
): Float32Array {
  const out = new Float32Array(dim);
  let count = 0;
  for (let f = Math.max(0, startFrame); f < Math.min(n, endFrame); f++) {
    for (let d = 0; d < dim; d++) out[d] += data[f * dim + d];
    count++;
  }
  if (count > 0) for (let d = 0; d < dim; d++) out[d] /= count;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Measured, rendered context difference around a boundary time. */
export function computeSupport(
  features: FeatureSet,
  chromaNorm: Float32Array,
  mfccNorm: Float32Array,
  timeSeconds: number,
  contextSeconds: number,
  mfccBands: number
): BoundarySupport {
  const n = features.times.length;
  const hop = features.timing.hopSeconds;
  const centre = Math.max(0, Math.min(n - 1, Math.round(timeSeconds / hop)));
  const contextFrames = Math.max(2, Math.round(contextSeconds / hop));
  const chromaBefore = blockMean(chromaNorm, n, centre - contextFrames, centre, 12);
  const chromaAfter = blockMean(chromaNorm, n, centre, centre + contextFrames, 12);
  const mfccBefore = blockMean(mfccNorm, n, centre - contextFrames, centre, mfccBands);
  const mfccAfter = blockMean(mfccNorm, n, centre, centre + contextFrames, mfccBands);

  let na = 0;
  let nb = 0;
  for (let i = 0; i < 12; i++) {
    na += chromaBefore[i] * chromaBefore[i];
    nb += chromaAfter[i] * chromaAfter[i];
  }
  na = Math.sqrt(na) || 1;
  nb = Math.sqrt(nb) || 1;
  let plain = 0;
  let bestTi = -Infinity;
  let bestShift = 0;
  for (let shift = 0; shift < 12; shift++) {
    let acc = 0;
    for (let k = 0; k < 12; k++) acc += chromaBefore[k] * chromaAfter[(k + shift) % 12];
    const s = acc / (na * nb);
    if (shift === 0) plain = s;
    if (s > bestTi) {
      bestTi = s;
      bestShift = shift;
    }
  }
  const mna = Math.sqrt(dot(mfccBefore, mfccBefore)) || 1;
  const mnb = Math.sqrt(dot(mfccAfter, mfccAfter)) || 1;
  const timbreSim = dot(mfccBefore, mfccAfter) / (mna * mnb);

  const loud = (from: number, to: number) => {
    let acc = 0;
    let count = 0;
    for (let f = Math.max(0, from); f < Math.min(n, to); f++) {
      acc += features.loudnessDb[f];
      count++;
    }
    return count ? acc / count : -120;
  };
  const loudBefore = loud(centre - contextFrames, centre);
  const loudAfter = loud(centre, centre + contextFrames);

  return {
    harmonicContrast: Math.max(0, Math.min(1, 1 - plain)),
    tiHarmonicContrast: Math.max(0, Math.min(1, 1 - bestTi)),
    timbreContrast: Math.max(0, Math.min(1, 1 - timbreSim)),
    loudnessContrastDb: Math.abs(loudAfter - loudBefore),
    contextTransposition: bestShift > 6 ? bestShift - 12 : bestShift
  };
}

function buildUncertainty(  hopSeconds: number,
  timeSeconds: number,
  cueTime: number,
  halfWidthFrames: number,
  beatSeconds: number,
  barAligned: boolean
): BoundaryUncertainty {
  const frameSeconds = hopSeconds / 2;
  const peakHalfWidthSeconds = (halfWidthFrames * hopSeconds) / 2;
  const halfBeatSeconds = beatSeconds / 2;
  const gridOffset = cueTime - timeSeconds;
  const sources = [
    `frame quantisation ±${frameSeconds.toFixed(2)}s at ${(1 / hopSeconds).toFixed(1)} Hz`,
    `contrast peak half-width ±${peakHalfWidthSeconds.toFixed(2)}s`
  ];
  if (barAligned) {
    sources.push(`bar-grid cue is ${Math.abs(gridOffset).toFixed(2)}s from the acoustic peak`);
    sources.push(`beat phase uncertainty ±${halfBeatSeconds.toFixed(2)}s`);
  } else {
    sources.push("no bar-grid snap: cue equals the acoustic peak");
  }
  const total = Math.sqrt(
    frameSeconds * frameSeconds +
      peakHalfWidthSeconds * peakHalfWidthSeconds +
      (barAligned ? halfBeatSeconds * halfBeatSeconds : 0)
  );
  return {
    frameSeconds,
    gridOffsetSeconds: Math.abs(gridOffset),
    peakHalfWidthSeconds,
    halfBeatSeconds,
    totalSeconds: total,
    sources
  };
}

/**
 * Decide whether a boundary is a sharp cut or a gradual transition. The
 * practical test is: does the change already look like a step over a short
 * context? If a one-beat context on each side already shows most of the
 * long-context contrast, the transition is abrupt; if the short context sees
 * much less, the material morphed in and the cue time is approximate.
 */
function classifyKind(
  zScore: number,
  sharpness: number,
  support: BoundarySupport
): BoundaryKind {
  const evidence = Math.max(support.harmonicContrast, support.tiHarmonicContrast, support.timbreContrast);
  if (zScore < 1.2) return "weak";
  if (sharpness >= 0.6 && zScore >= 1.8 && evidence >= 0.08) return "sharp";
  if (sharpness < 0.35) return "gradual";
  if (zScore < 1.6 || evidence < 0.07) return "weak";
  return "gradual";
}

function peakHalfWidth(x: Float32Array, index: number, peak: number): number {
  const target = peak * 0.5;
  let left = index;
  while (left > 0 && x[left] > target) left--;
  let right = index;
  while (right < x.length - 1 && x[right] > target) right++;
  return right - left;
}

// ---- Main entry -----------------------------------------------------------

export function detectBoundaries(
  features: FeatureSet,
  ssm: SsmData,
  bars: Bar[],
  beats: BeatGrid,
  options: AnalysisOptions
): BoundaryDetectionOutput {
  const chromaNorm = new Float32Array(features.chroma);
  const mfccNorm = new Float32Array(features.mfcc);
  for (let f = 0; f < features.times.length; f++) {
    normaliseVec(chromaNorm, f * 12, 12);
    normaliseVec(mfccNorm, f * options.mfccBands, options.mfccBands);
  }
  const n = ssm.n;
  const hopSeconds = ssm.hopSeconds;
  const notes: string[] = [];
  const thresholdZ = 1.0;

  // Display traces, frame-resolution checkerboard novelty of the SSM channels.
  const displayHarmonic = checkerboardNovelty(ssm.harmonic, n, options.kernelSeconds, hopSeconds);
  const displayTimbre = checkerboardNovelty(ssm.timbre, n, options.kernelSeconds, hopSeconds);
  const displayCombined = new Float32Array(n);
  for (let i = 0; i < n; i++) displayCombined[i] = 0.5 * displayHarmonic[i] + 0.5 * displayTimbre[i];

  // Decision: bar-level two-channel contrast. Bars average out note-level
  // texture, and requiring both harmony and timbre to move keeps orchestration
  // noise from masquerading as a structural change.
  const barCount = bars.length;
  const K = Math.max(2, Math.round(options.contrastBars));
  const harmonicBars = barSimilarityMatrix(bars, "harmonic");
  const timbreBars = barSimilarityMatrix(bars, "timbre");
  const harmonicContrast = barContrast(harmonicBars, barCount, K);
  const timbreContrast = barContrast(timbreBars, barCount, K);
  const zHarmonic = localZ(boxSmooth(harmonicContrast, 0), Math.max(4, K + 1));
  const zTimbre = localZ(boxSmooth(timbreContrast, 0), Math.max(4, K + 1));

  interface Candidate {
    barIndex: number;
    time: number;
    zH: number;
    zT: number;
    prominence: number;
  }
  const candidates: Candidate[] = [];
  // A boundary is a bar where at least one channel has a local maximum, and
  // the other channel does not actively disagree. Per-channel peaks matter
  // because a re-orchestration moves timbre while harmony holds, and a
  // modulation moves harmony while instrumentation holds; requiring a joint
  // peak would suppress either case. Bars are ranked by their combined z so
  // that, when both channels peak just apart, the stronger total wins.
  const jointContrast = new Float32Array(barCount);
  for (let b = 0; b < barCount; b++) jointContrast[b] = harmonicContrast[b] + timbreContrast[b];
  const zJoint = localZ(jointContrast, Math.max(4, K + 1));
  for (let b = 1; b < barCount - 1; b++) {
    const isPeakH = harmonicContrast[b] >= harmonicContrast[b - 1] && harmonicContrast[b] >= harmonicContrast[b + 1];
    const isPeakT = timbreContrast[b] >= timbreContrast[b - 1] && timbreContrast[b] >= timbreContrast[b + 1];
    if (!isPeakH && !isPeakT) continue;
    const zMax = Math.max(zHarmonic[b], zTimbre[b]);
    const zMin = Math.min(zHarmonic[b], zTimbre[b]);
    // One channel must be clearly above its local baseline and the other must
    // not contradict it. A single strong channel is enough: re-orchestration
    // moves timbre while harmony holds, and metrical/key changes can move
    // harmony while instrumentation holds.
    if (zMax < thresholdZ + 0.6) continue;
    if (zMin < -0.6) continue;
    candidates.push({
      barIndex: b,
      time: bars[b].start,
      zH: zHarmonic[b],
      zT: zTimbre[b],
      prominence: zJoint[b]
    });
  }
  candidates.sort((a, b) => b.prominence - a.prominence);
  const minBarGap = Math.max(2, Math.round(options.minBoundaryDistanceSeconds / beats.barSeconds));
  const kept: Candidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const contextSeconds = options.contextSeconds;
  for (const cand of candidates) {
    const support = computeSupport(
      features,
      chromaNorm,
      mfccNorm,
      cand.time,
      contextSeconds,
      options.mfccBands
    );
    const harmonicEvidence = Math.max(support.harmonicContrast, support.tiHarmonicContrast);
    const conflict = kept.find((k) => Math.abs(k.barIndex - cand.barIndex) < minBarGap);
    if (conflict) {
      rejected.push({
        time: cand.time,
        zScore: Math.max(cand.zH, cand.zT),
        reason: `within ${minBarGap} bars of stronger boundary at ${(bars[conflict.barIndex].start).toFixed(2)}s`,
        support
      });
      continue;
    }
    if (harmonicEvidence < 0.015 && support.timbreContrast < 0.015) {
      rejected.push({
        time: cand.time,
        zScore: Math.max(cand.zH, cand.zT),
        reason: "loudness-only transient: harmonic and timbre context unchanged",
        support
      });
      continue;
    }
    kept.push(cand);
  }
  kept.sort((a, b) => a.time - b.time);

  const boundaries: Boundary[] = [];
  for (let k = 0; k < kept.length; k++) {
    const cand = kept[k];
    const support = computeSupport(
      features,
      chromaNorm,
      mfccNorm,
      cand.time,
      contextSeconds,
      options.mfccBands
    );
    const bar = bars[cand.barIndex];
    const cueTime = bar.start;
    const zScore = Math.max(cand.zH, cand.zT);
    const halfWidth = peakHalfWidth(
      Math.max(cand.zH, cand.zT) === cand.zH ? harmonicContrast : timbreContrast,
      cand.barIndex,
      Math.max(cand.zH, cand.zT) === cand.zH ? harmonicContrast[cand.barIndex] : timbreContrast[cand.barIndex]
    );
    // Short-context support: if one beat either side already shows most of the
    // long-context contrast, the change is a step, not a morph.
    const shortSupport = computeSupport(
      features,
      chromaNorm,
      mfccNorm,
      cand.time,
      Math.min(contextSeconds, 1.0),
      options.mfccBands
    );
    const longEvidence = Math.max(
      support.harmonicContrast,
      support.tiHarmonicContrast,
      support.timbreContrast
    );
    const shortEvidence = Math.max(
      shortSupport.harmonicContrast,
      shortSupport.tiHarmonicContrast,
      shortSupport.timbreContrast
    );
    const sharpness = longEvidence > 1e-6 ? Math.min(1, shortEvidence / longEvidence) : 0;
    const kind = classifyKind(zScore, sharpness, support);
    const evidence = Math.max(support.harmonicContrast, support.tiHarmonicContrast);
    const confidence = Math.max(
      0,
      Math.min(
        1,
        0.35 * Math.min(1, (cand.zH + cand.zT) / 4) +
          0.35 * Math.min(1, evidence / 0.15) +
          0.15 * Math.min(1, support.timbreContrast / 0.1) +
          0.15 * (bar.index > 0 ? 1 : 0.5)
      )
    );
    boundaries.push({
      id: `B${k + 1}`,
      time: cand.time,
      cueTime,
      barIndex: bar.index,
      beatAligned: true,
      zScore,
      strength: zScore,
      confidence,
      kind,
      support,
      uncertainty: buildUncertainty(hopSeconds, cand.time, cueTime, halfWidth, beats.beatSeconds, true),
      prominence: cand.prominence
    });
  }

  if (boundaries.length === 0) {
    notes.push("No bar passed both harmony and timbre contrast tests; the programme was not subdivided.");
  }
  if (boundaries.every((b) => b.kind === "gradual")) {
    notes.push("All detected changes are gradual; treat cue times as approximate.");
  }

  const novelty: NoveltyCurves = {
    times: ssm.times,
    combined: displayCombined,
    harmonic: displayHarmonic,
    timbre: displayTimbre,
    barTimes: Float64Array.from(bars.map((b) => b.start)),
    barHarmonicContrast: harmonicContrast,
    barTimbreContrast: timbreContrast,
    barHarmonicZ: zHarmonic,
    barTimbreZ: zTimbre,
    thresholdZ,
    kernelSeconds: options.kernelSeconds,
    contrastBars: K,
    smoothingSeconds: 0
  };
  return { novelty, boundaries, rejected, notes };
}
