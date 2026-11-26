import { AnalysisOptions, Bar, BeatGrid, FeatureSet } from "./types";

function blockMeanFeature(
  features: FeatureSet,
  start: number,
  end: number,
  dim: number,
  into: Float32Array,
  offset: number
): void {
  const n = features.times.length;
  const hop = features.timing.hopSeconds;
  const from = Math.max(0, Math.floor(start / hop));
  const to = Math.min(n, Math.max(from + 1, Math.ceil(end / hop)));
  let count = 0;
  for (let f = from; f < to; f++) {
    for (let d = 0; d < dim; d++) into[offset + d] += features.chroma[f * 12 + d];
    count++;
  }
  if (count > 0) for (let d = 0; d < dim; d++) into[offset + d] /= count;
}

function l2(vec: Float32Array): void {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-9) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
}

/**
 * Build bar-level feature aggregates from the beat grid. Bars are the shared
 * musical grid used for aligning takes and for citable references.
 */
export function buildBars(features: FeatureSet, beats: BeatGrid, duration: number, options: AnalysisOptions): Bar[] {
  const downbeats: number[] = Array.from(beats.downbeatTimes);
  if (downbeats.length === 0) return [];
  const barSeconds = beats.barSeconds;
  // Close the grid so the last bar extends to the end of the programme.
  const ends: number[] = [];
  for (let i = 0; i < downbeats.length; i++) {
    const next = i + 1 < downbeats.length ? downbeats[i + 1] : Math.max(downbeats[i] + barSeconds, duration);
    ends.push(next);
  }
  const bars: Bar[] = [];
  const mfccBands = options.mfccBands;
  for (let i = 0; i < downbeats.length; i++) {
    const start = Math.max(0, downbeats[i]);
    const end = Math.min(duration, ends[i]);
    if (end - start < 0.15) continue;
    const chroma = new Float32Array(12);
    const mfcc = new Float32Array(mfccBands);
    // Reuse the generic aggregator for chroma, then MFCC by direct mean.
    blockMeanFeature(features, start, end, 12, chroma, 0);
    const hop = features.timing.hopSeconds;
    const from = Math.max(0, Math.floor(start / hop));
    const to = Math.min(features.times.length, Math.max(from + 1, Math.ceil(end / hop)));
    let mfccCount = 0;
    let loud = 0;
    for (let f = from; f < to; f++) {
      for (let c = 0; c < mfccBands; c++) mfcc[c] += features.mfcc[f * mfccBands + c];
      loud += features.loudnessDb[f];
      mfccCount++;
    }
    if (mfccCount > 0) {
      for (let c = 0; c < mfccBands; c++) mfcc[c] /= mfccCount;
      loud /= mfccCount;
    }
    l2(chroma);
    l2(mfcc);
    bars.push({
      index: bars.length,
      start,
      end,
      beatIndex: Math.round(start / beats.beatSeconds),
      features: { chroma, mfcc, loudnessDb: loud }
    });
  }
  return bars;
}

export function barStarts(bars: Bar[]): Float64Array {
  return Float64Array.from(bars.map((b) => b.start));
}

/** Find the bar containing (or immediately preceding) a time. */
export function barAtTime(bars: Bar[], time: number): number {
  if (bars.length === 0) return -1;
  let lo = 0;
  let hi = bars.length - 1;
  if (time < bars[0].start) return 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].start <= time) {
      if (mid === bars.length - 1 || bars[mid + 1].start > time) return mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return 0;
}
