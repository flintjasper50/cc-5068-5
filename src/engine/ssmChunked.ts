/**
 * Block-pruned self-similarity matrix: the opt-in "similarity matrix
 * optimisation".
 *
 * Computation order (kept explicit because the benchmark must explain it):
 *   1. normalise chroma/MFCC per frame (same vectors as the full builder);
 *   2. summarise each frame block by mean and Euclidean radius per channel;
 *   3. derive rigorous block-pair upper/lower similarity bounds;
 *   4. keep diagonal/adjacent blocks and any block whose combined upper bound
 *      clears the prune threshold; skip exact distances for the rest and fill
 *      them with the bound midpoint, so each filled value carries a known
 *      maximum error (half the bound interval);
 *   5. compute exact harmonic/timbre/TI values for retained frame pairs;
 *   6. symmetrise into the same SsmData contract as buildSsm, then blur and
 *      detect boundaries through the unchanged semantics.
 *
 * Boundary detection itself consumes the bar-level contrast matrices, not the
 * frame SSM, and the default analysis strategy stays "full". This module is
 * therefore an explicitly measured optimisation, not a silent substitution.
 */
import type { AnalysisOptions, FeatureSet, SsmData } from "./types";
import { cosineVV } from "./ssm";
import { prepareSsmVectors } from "./ssm";

const TIMBRE_BANDWIDTH = 1.35;
const FLOAT_BYTES = 4;

export interface SsmCostStats {
  strategy: "chunked";
  n: number;
  blockFrames: number;
  blockCount: number;
  pruneBound: number;
  totalPairs: number;
  exactPairs: number;
  skippedPairs: number;
  exactPairFraction: number;
  savedPairFraction: number;
  blockPairChecks: number;
  tiShiftEvaluations: number;
  timingsMs: {
    normalise: number;
    summaries: number;
    pairs: number;
    totalBuild: number;
  };
  /** Dense SsmData materialisation cost (four NxN Float32 matrices). */
  denseMatrixBytes: number;
  /** What a sparse block store of exact values + bounds would occupy. */
  sparseStoreBytes: number;
  sparseCompressionRatio: number;
  /** Worst midpoint-fill error certified by the block intervals. */
  guaranteedMaxFillError: number;
}

export interface ChunkedSsmOutput {
  ssm: SsmData;
  stats: SsmCostStats;
}

interface BlockEnvelope {
  lo: Float32Array;
  hi: Float32Array;
}

interface PairBounds {
  upper: number;
  lower: number;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Per-dimension axis-aligned envelopes; tighter than mean/radius for pruning. */
function summariseBlocks(
  data: Float32Array,
  n: number,
  dim: number,
  block: number
): BlockEnvelope[] {
  const count = Math.ceil(n / block);
  const out: BlockEnvelope[] = [];
  for (let b = 0; b < count; b++) {
    const loIdx = b * block;
    const hiIdx = Math.min(n, loIdx + block);
    const lo = new Float32Array(dim).fill(Infinity);
    const hi = new Float32Array(dim).fill(-Infinity);
    for (let i = loIdx; i < hiIdx; i++) {
      for (let k = 0; k < dim; k++) {
        const v = data[i * dim + k];
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
    for (let k = 0; k < dim; k++) {
      if (!Number.isFinite(lo[k])) lo[k] = 0;
      if (!Number.isFinite(hi[k])) hi[k] = 0;
    }
    out.push({ lo, hi });
  }
  return out;
}

/**
 * Cosine/dot bounds between two envelopes. A bilinear form reaches its box
 * extrema at corners, so per dimension we take the min/max of the four corner
 * products and sum them. Rigorous for every enclosed frame pair.
 */
function dotBounds(a: BlockEnvelope, b: BlockEnvelope): PairBounds {
  let upper = 0;
  let lower = 0;
  for (let k = 0; k < a.lo.length; k++) {
    const products = [
      a.lo[k] * b.lo[k],
      a.lo[k] * b.hi[k],
      a.hi[k] * b.lo[k],
      a.hi[k] * b.hi[k]
    ];
    let lo = products[0];
    let hi = products[0];
    for (let i = 1; i < 4; i++) {
      lo = Math.min(lo, products[i]);
      hi = Math.max(hi, products[i]);
    }
    upper += hi;
    lower += lo;
  }
  return { upper: Math.max(-1, Math.min(1, upper)), lower: Math.max(-1, Math.min(1, lower)) };
}

/** Rigorous min/max Euclidean distance between two axis-aligned boxes. */
function distanceBounds(a: BlockEnvelope, b: BlockEnvelope): { min: number; max: number } {
  let minD2 = 0;
  let maxD2 = 0;
  for (let k = 0; k < a.lo.length; k++) {
    const gap = Math.max(0, a.lo[k] - b.hi[k], b.lo[k] - a.hi[k]);
    minD2 += gap * gap;
    const far = Math.max(
      Math.abs(a.hi[k] - b.lo[k]),
      Math.abs(a.lo[k] - b.hi[k]),
      Math.abs(a.lo[k] - b.lo[k]),
      Math.abs(a.hi[k] - b.hi[k])
    );
    maxD2 += far * far;
  }
  return { min: Math.sqrt(minD2), max: Math.sqrt(maxD2) };
}

function rbfFromDistance(d: number, bandwidth: number): number {
  return Math.exp(-(d * d) / (2 * bandwidth * bandwidth));
}

export function buildSsmChunked(
  features: FeatureSet,
  options: AnalysisOptions,
  config: { blockFrames?: number; pruneBound?: number } = {}
): ChunkedSsmOutput {
  const t0 = nowMs();
  const n = features.times.length;
  const dim = options.mfccBands;
  // Operating point chosen from benchmarks/report.md: 8-frame blocks with a
  // 0.5 combined upper-bound gate prune ~1/3 of pairs for ~1.8x long-song
  // build speedup while keeping mean matrix error near 0.008.
  const blockFrames = Math.max(1, Math.floor(config.blockFrames ?? options.chunkBlockFrames ?? 8));
  const pruneBound = config.pruneBound ?? options.chunkPruneBound ?? 0.5;

  const tn0 = nowMs();
  const { chromaNorm, mfccNorm } = prepareSsmVectors(features, options);
  const tn1 = nowMs();

  const ts0 = nowMs();
  const chromaEnv = summariseBlocks(chromaNorm, n, 12, blockFrames);
  const mfccEnv = summariseBlocks(mfccNorm, n, dim, blockFrames);
  const blockCount = chromaEnv.length;
  const ts1 = nowMs();

  const harmonic = new Float32Array(n * n);
  const timbre = new Float32Array(n * n);
  const combined = new Float32Array(n * n);
  const tiHarmonic = new Float32Array(n * n);

  let exactPairs = 0;
  let skippedPairs = 0;
  let blockPairChecks = 0;
  let guaranteedMaxFillError = 0;
  const tp0 = nowMs();

  for (let bi = 0; bi < blockCount; bi++) {
    const i0 = bi * blockFrames;
    const i1 = Math.min(n, i0 + blockFrames);
    for (let bj = bi; bj < blockCount; bj++) {
      const j0 = bj * blockFrames;
      const j1 = Math.min(n, j0 + blockFrames);
      blockPairChecks++;

      const hb = dotBounds(chromaEnv[bi], chromaEnv[bj]);
      const td = distanceBounds(mfccEnv[bi], mfccEnv[bj]);
      const tb = {
        upper: rbfFromDistance(td.min, TIMBRE_BANDWIDTH),
        lower: rbfFromDistance(td.max, TIMBRE_BANDWIDTH)
      };
      const combinedUpper = 0.5 * Math.max(0, hb.upper) + 0.5 * tb.upper;
      const adjacent = bj - bi <= 1; // preserve the diagonal novelty band exactly
      const prune = !adjacent && combinedUpper < pruneBound;

      if (prune) {
        const fillH = Math.max(0, Math.min(1, (Math.max(0, hb.lower) + Math.max(0, hb.upper)) / 2));
        const fillT = (tb.lower + tb.upper) / 2;
        const fillC = 0.5 * fillH + 0.5 * fillT;
        guaranteedMaxFillError = Math.max(
          guaranteedMaxFillError,
          (hb.upper - hb.lower) / 2,
          (tb.upper - tb.lower) / 2
        );
        for (let i = i0; i < i1; i++) {
          const jStart = bi === bj ? i : j0;
          for (let j = jStart; j < j1; j++) {
            harmonic[i * n + j] = harmonic[j * n + i] = fillH;
            timbre[i * n + j] = timbre[j * n + i] = fillT;
            combined[i * n + j] = combined[j * n + i] = fillC;
            tiHarmonic[i * n + j] = tiHarmonic[j * n + i] = fillH;
            skippedPairs++;
          }
        }
        continue;
      }

      for (let i = i0; i < i1; i++) {
        const jStart = bi === bj ? i : j0;
        for (let j = jStart; j < j1; j++) {
          const self = i === j;
          let h: number;
          let t: number;
          let ti: number;
          if (self) {
            h = t = ti = 1;
          } else {
            h = Math.max(0, Math.min(1, cosineVV(chromaNorm, i * 12, chromaNorm, j * 12, 12)));
            let dist2 = 0;
            for (let k = 0; k < dim; k++) {
              const d = mfccNorm[i * dim + k] - mfccNorm[j * dim + k];
              dist2 += d * d;
            }
            t = Math.exp(-dist2 / (2 * TIMBRE_BANDWIDTH * TIMBRE_BANDWIDTH));
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
          exactPairs++;
        }
      }
    }
  }
  const tp1 = nowMs();

  const totalPairs = (n * (n + 1)) / 2;
  const denseMatrixBytes = 4 * n * n * 4;
  // Exact values kept for h/t/c/ti plus per-block lo/hi envelopes.
  const sparseStoreBytes =
    exactPairs * 4 * 4 +
    blockCount * (2 * 12 + 2 * dim) * FLOAT_BYTES;
  const stats: SsmCostStats = {
    strategy: "chunked",
    n,
    blockFrames,
    blockCount,
    pruneBound,
    totalPairs,
    exactPairs,
    skippedPairs,
    exactPairFraction: totalPairs ? exactPairs / totalPairs : 0,
    savedPairFraction: totalPairs ? skippedPairs / totalPairs : 0,
    blockPairChecks,
    tiShiftEvaluations: exactPairs * 12,
    timingsMs: {
      normalise: +(tn1 - tn0).toFixed(3),
      summaries: +(ts1 - ts0).toFixed(3),
      pairs: +(tp1 - tp0).toFixed(3),
      totalBuild: +(tp1 - t0).toFixed(3)
    },
    denseMatrixBytes,
    sparseStoreBytes,
    sparseCompressionRatio: sparseStoreBytes > 0 ? denseMatrixBytes / sparseStoreBytes : 1,
    guaranteedMaxFillError: +guaranteedMaxFillError.toFixed(4)
  };

  const ssm: SsmData = {
    n,
    hopSeconds: features.timing.hopSeconds,
    times: features.times,
    harmonic,
    timbre,
    combined,
    tiHarmonic,
    weights: { harmonic: 0.5, timbre: 0.5 },
    blurSigmaFrames: 1
  };
  return { ssm, stats };
}

export interface MatrixErrorReport {
  channel: "combined" | "harmonic" | "timbre";
  maxAbs: number;
  meanAbs: number;
  p95Abs: number;
}

/** Compare a chunked matrix against the full-matrix reference. */
export function compareMatrices(
  approx: SsmData,
  full: SsmData
): { channels: MatrixErrorReport[]; maxAbs: number; meanAbs: number } {
  const n = full.n;
  const channels: MatrixErrorReport[] = [];
  let globalMax = 0;
  let globalSum = 0;
  let globalCount = 0;
  for (const channel of ["combined", "harmonic", "timbre"] as const) {
    const a = approx[channel];
    const f = full[channel];
    let maxAbs = 0;
    let sum = 0;
    const abs: number[] = [];
    for (let i = 0; i < n * n; i++) {
      const e = Math.abs(a[i] - f[i]);
      maxAbs = Math.max(maxAbs, e);
      sum += e;
      abs.push(e);
    }
    abs.sort((x, y) => x - y);
    const p95 = abs[Math.floor(abs.length * 0.95)] ?? 0;
    channels.push({
      channel,
      maxAbs: +maxAbs.toFixed(4),
      meanAbs: +(sum / (n * n)).toFixed(5),
      p95Abs: +p95.toFixed(4)
    });
    globalMax = Math.max(globalMax, maxAbs);
    globalSum += sum;
    globalCount += n * n;
  }
  return { channels, maxAbs: +globalMax.toFixed(4), meanAbs: +(globalSum / globalCount).toFixed(5) };
}
