/**
 * Adapter from analysed music bars to the generic chunk index. Chroma carries
 * the theme and MFCC the timbre; concatenating weighted copies gives the index
 * one vector per bar while keeping both axes in the distance.
 */
import type { Bar } from "./types";
import { LongSongIndex } from "./chunkIndex";
import type { BarMeta } from "./chunkIndex";

export interface BarVectorOptions {
  chromaWeight?: number;
  mfccWeight?: number;
}

export function barToVector(bar: Bar, options: BarVectorOptions = {}): Float32Array {
  const cw = options.chromaWeight ?? 1;
  const mw = options.mfccWeight ?? 0.5;
  const dim = bar.features.chroma.length + bar.features.mfcc.length;
  const out = new Float32Array(dim);
  let norm = 0;
  for (let k = 0; k < bar.features.chroma.length; k++) {
    out[k] = cw * bar.features.chroma[k];
    norm += out[k] * out[k];
  }
  for (let k = 0; k < bar.features.mfcc.length; k++) {
    out[bar.features.chroma.length + k] = mw * bar.features.mfcc[k];
    const v = out[bar.features.chroma.length + k];
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < dim; k++) out[k] /= norm;
  return out;
}

export function createIndexFromBars(
  bars: Bar[],
  options: BarVectorOptions & { chunkBars?: number } = {}
): LongSongIndex {
  const first = bars[0];
  const chromaDim = first?.features.chroma.length ?? 12;
  const mfccDim = first?.features.mfcc.length ?? 12;
  const index = new LongSongIndex({
    dim: chromaDim + mfccDim,
    chunkBars: options.chunkBars ?? 4
  });
  const vectors = bars.map((b) => barToVector(b, options));
  const metas: BarMeta[] = bars.map((b) => ({ start: b.start, label: `bar ${b.index + 1}` }));
  index.appendNewBars(vectors, metas);
  index.coverNew();
  return index;
}
