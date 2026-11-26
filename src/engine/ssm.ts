import { AnalysisOptions, FeatureSet, SsmData } from "./types";

const EPS = 1e-10;

export function normaliseVec(vec: Float32Array, from = 0, length = vec.length): void {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += vec[from + i] * vec[from + i];
  const norm = Math.sqrt(sum);
  if (norm > EPS) for (let i = 0; i < length; i++) vec[from + i] /= norm;
}

export function cosineVV(a: Float32Array, ai: number, b: Float32Array, bi: number, dim: number): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < dim; i++) {
    const x = a[ai + i];
    const y = b[bi + i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= EPS || nb <= EPS) return 0;
  return dot / Math.sqrt(na * nb);
}

export interface SsmBuild {
  ssm: SsmData;
  /** Unit-normalised raw chroma, reused for grouping and display. */
  chromaNorm: Float32Array;
  /** Mean-centred, unit-normalised chroma used for boundary detection. */
  chromaContrast: Float32Array;
  mfccNorm: Float32Array;
}

/**
 * Per-frame mean removal before SSM construction. Harmonic profiles share a
 * large common component (the prevailing key's scale tones); subtracting the
 * frame mean exposes *which* tones move, which is what a boundary actually is.
 */
function centreChroma(src: Float32Array, n: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = 0; k < 12; k++) m += src[i * 12 + k];
    m /= 12;
    let norm = 0;
    for (let k = 0; k < 12; k++) {
      const v = src[i * 12 + k] - m;
      out[i * 12 + k] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm > EPS) for (let k = 0; k < 12; k++) out[i * 12 + k] /= norm;
  }
  return out;
}

/** Per-dimension z-scoring over time, so every MFCC coefficient has equal say. */
function zScoreDims(src: Float32Array, n: number, dim: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let k = 0; k < dim; k++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += src[i * dim + k];
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      const d = src[i * dim + k] - mean;
      variance += d * d;
    }
    const std = Math.sqrt(variance / n) || 1;
    for (let i = 0; i < n; i++) out[i * dim + k] = (src[i * dim + k] - mean) / std;
  }
  return out;
}

export function buildSsm(features: FeatureSet, options: AnalysisOptions): SsmBuild {
  const n = features.times.length;
  const hopSeconds = features.timing.hopSeconds;
  const dim = options.mfccBands;

  const chromaNorm = new Float32Array(features.chroma);
  for (let i = 0; i < n; i++) normaliseVec(chromaNorm, i * 12, 12);
  const chromaContrast = centreChroma(features.chroma, n);
  const mfccZ = zScoreDims(features.mfcc, n, dim);
  const mfccNorm = new Float32Array(mfccZ);
  for (let i = 0; i < n; i++) normaliseVec(mfccNorm, i * dim, dim);

  const harmonic = new Float32Array(n * n);
  const timbre = new Float32Array(n * n);
  const combined = new Float32Array(n * n);
  const tiHarmonic = new Float32Array(n * n);

  // Timbre RBF bandwidth in normalised-L2 units.
  const bandwidth = 1.35;

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const self = i === j;
      let h: number;
      let t: number;
      let ti: number;
      if (self) {
        h = 1;
        t = 1;
        ti = 1;
      } else {
        h = Math.max(0, Math.min(1, cosineVV(chromaNorm, i * 12, chromaNorm, j * 12, 12)));
        let dist2 = 0;
        for (let k = 0; k < dim; k++) {
          const d = mfccNorm[i * dim + k] - mfccNorm[j * dim + k];
          dist2 += d * d;
        }
        t = Math.exp(-dist2 / (2 * bandwidth * bandwidth));
        let bestTi = 0;
        for (let shift = 0; shift < 12; shift++) {
          let dot = 0;
          for (let k = 0; k < 12; k++) {
            dot += chromaNorm[i * 12 + k] * chromaNorm[j * 12 + ((k + shift) % 12)];
          }
          if (dot > bestTi) bestTi = dot;
        }
        ti = Math.max(0, Math.min(1, bestTi));
      }
      const c = 0.5 * h + 0.5 * t;
      harmonic[i * n + j] = harmonic[j * n + i] = h;
      timbre[i * n + j] = timbre[j * n + i] = t;
      tiHarmonic[i * n + j] = tiHarmonic[j * n + i] = ti;
      combined[i * n + j] = combined[j * n + i] = c;
    }
  }

  const ssm: SsmData = {
    n,
    hopSeconds,
    times: features.times,
    harmonic,
    timbre,
    combined,
    tiHarmonic,
    weights: { harmonic: 0.5, timbre: 0.5 },
    blurSigmaFrames: 1
  };
  return { ssm, chromaNorm, chromaContrast, mfccNorm };
}

/** Separable Gaussian blur of an NxN row-major matrix with edge clamping. */
export function blurMatrix(mat: Float32Array, n: number, sigma: number): Float32Array {
  if (sigma <= 0) return mat;
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + radius];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const jj = Math.min(n - 1, Math.max(0, j + k));
        acc += mat[i * n + jj] * kernel[k + radius];
      }
      tmp[i * n + j] = acc;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const ii = Math.min(n - 1, Math.max(0, i + k));
        acc += tmp[ii * n + j] * kernel[k + radius];
      }
      out[i * n + j] = acc;
    }
  }
  return out;
}

/**
 * Foote checkerboard novelty: correlate a Gaussian-tapered checkerboard kernel
 * with the SSM along the diagonal. Each output value is normalised by the
 * kernel weight actually used (edges see fewer terms).
 */
export function checkerboardNovelty(
  ssm: Float32Array,
  n: number,
  kernelSeconds: number,
  hopSeconds: number
): Float32Array {
  const half = Math.max(1, Math.round(kernelSeconds / 2 / hopSeconds));
  const size = 2 * half;
  const kernel = new Float32Array(size * size);
  const sigma = half / 2;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const gx = Math.exp(-((i - half + 0.5) ** 2) / (2 * sigma * sigma));
      const gy = Math.exp(-((j - half + 0.5) ** 2) / (2 * sigma * sigma));
      const sign = (i < half) === (j < half) ? 1 : -1;
      kernel[i * size + j] = sign * gx * gy;
    }
  }
  const novelty = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    let acc = 0;
    let weight = 0;
    for (let i = 0; i < size; i++) {
      const row = c - half + i;
      if (row < 0 || row >= n) continue;
      for (let j = 0; j < size; j++) {
        const col = c - half + j;
        if (col < 0 || col >= n) continue;
        const k = kernel[i * size + j];
        acc += ssm[row * n + col] * k;
        weight += Math.abs(k);
      }
    }
    novelty[c] = weight > EPS ? acc / weight : 0;
  }
  return novelty;
}
