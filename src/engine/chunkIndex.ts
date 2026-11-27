/**
 * Chunked long-song index with explainable pruning.
 *
 * The index stores one unit vector per bar and groups bars into fixed,
 * contiguous chunks. Each chunk carries two rigorous similarity upper bounds
 * for every query vector:
 *
 *   1. an axis-aligned envelope bound  U_box  = sum_k max(q_k lo_k, q_k hi_k)
 *   2. a mean/radius Euclidean bound  U_rad  = 1 - max(0, d(q,m) - R)^2 / 2
 *
 * For unit vectors cosine similarity equals 1 - d^2 / 2, so whenever the
 * tighter of the two bounds is below the seed threshold, *every* bar in the
 * chunk is provably a mismatch and no exact distance has to be computed.
 * Pruning is therefore one-sided: it can only remove positions that a full
 * search would reject. Approximation enters only through the optional
 * memory-budget branch that retains uncertain candidates instead of verifying
 * them immediately; those positions are reported as `uncertain`, never as
 * mismatches, which is what keeps false exclusions at zero.
 *
 * Computation order for a scan:
 *   normalise query -> chunk upper bounds -> prune whole chunks ->
 *   exact seed similarities on surviving bars and uncovered/new bars ->
 *   memory decision (rescan vs retain) -> diagonal extension/verification ->
 *   verdict + comparison/memory accounting.
 */

export class ChunkIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkIndexError";
  }
}

export interface BarMeta {
  start?: number;
  label?: string;
}

export type BarCoverage = "new" | "covered";

export interface IndexedBar {
  index: number;
  id: string;
  vector: Float32Array;
  coverage: BarCoverage;
  meta: BarMeta;
}

export interface ChunkSummary {
  id: number;
  startBar: number;
  endBar: number;
  count: number;
  mean: Float32Array;
  radius: number;
  lo: Float32Array;
  hi: Float32Array;
  bytes: number;
}

export interface IndexMemoryStats {
  dim: number;
  barCount: number;
  chunkCount: number;
  vectorBytes: number;
  chunkSummaryBytes: number;
  retainedCandidateBytes: number;
  totalBytes: number;
  /** Exact dense NxN similarity matrix cost this index avoids. */
  fullMatrixBytes: number;
  memoryBudgetBytes: number | null;
  withinBudget: boolean;
}

export interface IndexHit {
  /** Start bar of the aligned target segment. */
  startBar: number;
  endBar: number;
  score: number;
  agreeFraction: number;
  barScores: number[];
  /** How the seed was found: exact scan of a surviving chunk or a new bar. */
  seedSource: "covered-exact" | "uncovered";
  meta: BarMeta | null;
}

export interface UncertainCandidate {
  startBar: number;
  seedSimilarity: number;
  reason: "memory-budget" | "near-threshold";
  source: "covered-exact" | "uncovered";
  estimatedVerificationBytes: number;
}

export interface ScanOptions {
  /** Mean bar similarity required for a verified hit. */
  matchThreshold?: number;
  /** Per-bar floor used by the agreement fraction. */
  barThreshold?: number;
  /** Required fraction of query bars above barThreshold. */
  minAgreeFraction?: number;
  /** Seed threshold; defaults to matchThreshold. */
  seedThreshold?: number;
  /** Seeds within this margin below seedThreshold stay candidates. */
  retainMargin?: number;
  /** Exact scores within this band of matchThreshold stay uncertain. */
  uncertaintyBand?: number;
  /** Allow +/- warp bars around the diagonal when extending. */
  warp?: number;
  /**
   * "rescan" (default) verifies every seed now with streaming O(L) memory.
   * "budget" retains all uncertain seeds when their storage fits
   * memoryBudgetBytes/maxCandidates, and otherwise rescans now so a tight cap
   * never has to drop or falsely exclude a candidate.
   */
  memoryPolicy?: "rescan" | "budget";
  /** Memory cap for candidate verification + retained candidates. */
  memoryBudgetBytes?: number;
  /** Simpler cap: maximum candidates that may be retained. */
  maxCandidates?: number;
}

export type ScanDecision = "rescan" | "retain-uncertain";

export interface ScanResult {
  queryBars: number;
  matches: IndexHit[];
  /** Bars not yet covered by the index (new material). */
  uncoveredBars: number[];
  /** Covered bars eliminated by a rigorous bound or an exact seed score. */
  provenMismatchBars: number[];
  uncertainCandidates: UncertainCandidate[];
  retainedCount: number;
  decision: ScanDecision;
  estimatedRescanBytes: number;
  memoryBudgetBytes: number | null;
  /** Exact bar-vector similarity computations performed. */
  comparisons: number;
  /** Comparisons a naive exhaustive query scan would perform. */
  naiveComparisons: number;
  savedComparisons: number;
  savedFraction: number;
  /** Number of chunk-pair/query bound checks (cheap dim ops). */
  boundChecks: number;
  prunedChunks: number[];
  scannedChunks: number[];
  memory: IndexMemoryStats;
}

export interface IndexOptions {
  dim?: number;
  chunkBars?: number;
  idPrefix?: string;
}

const FLOAT_BYTES = 4;
const CANDIDATE_OVERHEAD_BYTES = 48;

function l2Normalise(src: ArrayLike<number>, dim: number): Float32Array {
  const out = new Float32Array(dim);
  let norm = 0;
  for (let k = 0; k < dim; k++) {
    const v = src[k] ?? 0;
    out[k] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-12) for (let k = 0; k < dim; k++) out[k] /= norm;
  return out;
}

export function cosineUnit(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
  // Inputs are unit vectors; clamp protects against float drift.
  return Math.max(-1, Math.min(1, dot));
}

/** Upper bound on cosine(q, x) for every x described by a chunk summary. */
export function chunkSimilarityUpperBound(q: Float32Array, chunk: ChunkSummary): number {
  let box = 0;
  for (let k = 0; k < q.length; k++) {
    const qk = q[k];
    box += Math.max(qk * chunk.lo[k], qk * chunk.hi[k]);
  }
  box = Math.max(-1, Math.min(1, box));

  let d2 = 0;
  for (let k = 0; k < q.length; k++) {
    const d = q[k] - chunk.mean[k];
    d2 += d * d;
  }
  const dq = Math.sqrt(d2);
  const gap = Math.max(0, dq - chunk.radius);
  const radiusBound = 1 - 0.5 * gap * gap;
  return Math.min(box, Math.max(-1, Math.min(1, radiusBound)));
}

export class LongSongIndex {
  readonly dim: number;
  chunkBars: number;
  private idPrefix: string;
  bars: IndexedBar[] = [];
  chunks: ChunkSummary[] = [];
  retained: UncertainCandidate[] = [];

  constructor(options: IndexOptions = {}) {
    this.dim = options.dim ?? 12;
    this.chunkBars = Math.max(1, Math.floor(options.chunkBars ?? 4));
    this.idPrefix = options.idPrefix ?? "bar";
  }

  private toVector(v: Float32Array | number[]): Float32Array {
    if (v.length !== this.dim) {
      throw new ChunkIndexError(`vector dim ${v.length} does not match index dim ${this.dim}`);
    }
    return l2Normalise(v, this.dim);
  }

  /** Append brand-new, uncovered bars. */
  appendNewBars(
    vectors: Array<Float32Array | number[]>,
    metas: BarMeta[] = []
  ): number[] {
    const start = this.bars.length;
    const inserted: number[] = [];
    vectors.forEach((v, i) => {
      const index = this.bars.length;
      this.bars.push({
        index,
        id: `${this.idPrefix}-${index}`,
        vector: this.toVector(v),
        coverage: "new",
        meta: metas[i] ?? {}
      });
      inserted.push(index);
    });
    this.reindexIds();
    this.rechunk();
    return inserted.map((_, i) => start + i);
  }

  /**
   * Insert an alternative segment at an arbitrary bar position. Inserted bars
   * start uncovered; existing bars keep their coverage state. Chunk summaries
   * are recomputed over the new contiguous layout.
   */
  insertSegment(
    atBar: number,
    vectors: Array<Float32Array | number[]>,
    metas: BarMeta[] = []
  ): number[] {
    const at = Math.max(0, Math.min(this.bars.length, Math.floor(atBar)));
    const fresh: IndexedBar[] = vectors.map((v, i) => ({
      index: -1,
      id: "",
      vector: this.toVector(v),
      coverage: "new",
      meta: metas[i] ?? {}
    }));
    this.bars.splice(at, 0, ...fresh);
    this.reindexIds();
    this.rechunk();
    return fresh.map((_, i) => at + i);
  }

  private reindexIds(): void {
    this.bars.forEach((b, i) => {
      b.index = i;
      if (!b.id) b.id = `${this.idPrefix}-${i}`;
    });
  }

  /** Build rigorous envelope/mean-radius summaries over fixed chunks. */
  rechunk(): void {
    this.chunks = [];
    for (let start = 0; start < this.bars.length; start += this.chunkBars) {
      const end = Math.min(this.bars.length, start + this.chunkBars);
      const count = end - start;
      const mean = new Float32Array(this.dim);
      const lo = new Float32Array(this.dim).fill(Infinity);
      const hi = new Float32Array(this.dim).fill(-Infinity);
      for (let i = start; i < end; i++) {
        const v = this.bars[i].vector;
        for (let k = 0; k < this.dim; k++) {
          mean[k] += v[k];
          if (v[k] < lo[k]) lo[k] = v[k];
          if (v[k] > hi[k]) hi[k] = v[k];
        }
      }
      for (let k = 0; k < this.dim; k++) {
        mean[k] /= count;
        if (!Number.isFinite(lo[k])) lo[k] = 0;
        if (!Number.isFinite(hi[k])) hi[k] = 0;
      }
      let radius = 0;
      for (let i = start; i < end; i++) {
        const v = this.bars[i].vector;
        let d2 = 0;
        for (let k = 0; k < this.dim; k++) {
          const d = v[k] - mean[k];
          d2 += d * d;
        }
        radius = Math.max(radius, Math.sqrt(d2));
      }
      // mean(Float32) + lo + hi
      const bytes = 3 * this.dim * FLOAT_BYTES + 16;
      this.chunks.push({ id: this.chunks.length, startBar: start, endBar: end, count, mean, radius, lo, hi, bytes });
    }
  }

  /** Mark all new bars covered (the "top-up scan" completing the index). */
  coverNew(maxBars?: number): number {
    let covered = 0;
    for (const b of this.bars) {
      if (b.coverage === "new") {
        if (maxBars !== undefined && covered >= maxBars) break;
        b.coverage = "covered";
        covered++;
      }
    }
    return covered;
  }

  get newBars(): number[] {
    return this.bars.filter((b) => b.coverage === "new").map((b) => b.index);
  }

  chunkOf(barIndex: number): ChunkSummary | null {
    const id = Math.floor(barIndex / this.chunkBars);
    return this.chunks[id] ?? null;
  }

  memoryStats(retainedCandidateBytes = 0, budget: number | null = null): IndexMemoryStats {
    const vectorBytes = this.bars.length * this.dim * FLOAT_BYTES;
    const chunkSummaryBytes = this.chunks.reduce((a, c) => a + c.bytes, 0);
    const n = this.bars.length;
    return {
      dim: this.dim,
      barCount: n,
      chunkCount: this.chunks.length,
      vectorBytes,
      chunkSummaryBytes,
      retainedCandidateBytes,
      totalBytes: vectorBytes + chunkSummaryBytes + retainedCandidateBytes,
      fullMatrixBytes: n * n * FLOAT_BYTES,
      memoryBudgetBytes: budget,
      withinBudget: budget === null || vectorBytes + chunkSummaryBytes + retainedCandidateBytes <= budget
    };
  }

  /**
   * Scan a query phrase. See the module comment for the computation order and
   * the exact meaning of each returned set.
   */
  scan(query: Array<Float32Array | number[]>, options: ScanOptions = {}): ScanResult {
    if (!query || query.length === 0) throw new ChunkIndexError("query must contain at least one bar");
    const q = query.map((v) => this.toVector(v));
    const L = q.length;
    const matchThreshold = options.matchThreshold ?? 0.8;
    const barThreshold = options.barThreshold ?? 0.7;
    const minAgreeFraction = options.minAgreeFraction ?? 0.75;
    const seedThreshold = options.seedThreshold ?? matchThreshold;
    const retainMargin = options.retainMargin ?? 0.08;
    const uncertaintyBand = options.uncertaintyBand ?? 0.03;
    const warp = options.warp ?? 0;
    const budget = options.memoryBudgetBytes ?? null;
    const maxCandidates = options.maxCandidates ?? Number.POSITIVE_INFINITY;

    for (const [name, x] of [
      ["matchThreshold", matchThreshold],
      ["barThreshold", barThreshold],
      ["minAgreeFraction", minAgreeFraction],
      ["seedThreshold", seedThreshold]
    ] as const) {
      if (!Number.isFinite(x) || x < -1 || x > 1) {
        if (name === "minAgreeFraction" && x >= 0 && x <= 1) continue;
        throw new ChunkIndexError(`${name} must be a finite similarity in [-1,1], got ${x}`);
      }
    }

    let comparisons = 0;
    let boundChecks = 0;
    const prunedChunks: number[] = [];
    const scannedChunks: number[] = [];
    const provenMismatchBars = new Set<number>();
    const uncoveredBars: number[] = [];
    for (const b of this.bars) if (b.coverage === "new") uncoveredBars.push(b.index);

    interface Seed {
      bar: number;
      sim: number;
      source: "covered-exact" | "uncovered";
    }
    const seeds: Seed[] = [];
    const retainAt = seedThreshold - retainMargin;

    for (const chunk of this.chunks) {
      const containsNew = this.bars
        .slice(chunk.startBar, chunk.endBar)
        .some((b) => b.coverage === "new");
      if (!containsNew) {
        boundChecks++;
        const upper = chunkSimilarityUpperBound(q[0], chunk);
        if (upper < seedThreshold - 1e-9) {
          prunedChunks.push(chunk.id);
          for (let j = chunk.startBar; j < chunk.endBar; j++) provenMismatchBars.add(j);
          continue;
        }
      }
      scannedChunks.push(chunk.id);
      for (let j = chunk.startBar; j < chunk.endBar; j++) {
        const bar = this.bars[j];
        comparisons++;
        const sim = cosineUnit(q[0], bar.vector);
        if (sim >= retainAt) {
          seeds.push({ bar: j, sim, source: bar.coverage === "new" ? "uncovered" : "covered-exact" });
        } else if (bar.coverage === "covered") {
          // Exact seed score below the retention floor: this bar cannot start
          // a qualifying alignment for q0.
          provenMismatchBars.add(j);
        }
      }
    }

    // A seed must leave room for at least ceil(minAgreeFraction*L) query bars;
    // edge positions are still scored with partial coverage below.
    const estimatedVerificationBytes = seeds.length * (CANDIDATE_OVERHEAD_BYTES + L * FLOAT_BYTES);
    const baseBytes = this.memoryStats().totalBytes;
    const budgetAllowsRetention =
      budget === null ? true : baseBytes + estimatedVerificationBytes <= budget;
    const countAllowsRetention = seeds.length <= maxCandidates;
    // Retaining uncertainty spends memory to save a rescan; when the cap cannot
    // hold the candidates, a streaming exact rescan resolves them instead.
    const decision: ScanDecision =
      options.memoryPolicy === "budget" && budgetAllowsRetention && countAllowsRetention
        ? "retain-uncertain"
        : "rescan";

    const uncertainCandidates: UncertainCandidate[] = [];
    const matches: IndexHit[] = [];

    if (decision === "retain-uncertain") {
      for (const s of seeds) {
        uncertainCandidates.push({
          startBar: s.bar,
          seedSimilarity: s.sim,
          reason: "memory-budget",
          source: s.source,
          estimatedVerificationBytes: CANDIDATE_OVERHEAD_BYTES + L * FLOAT_BYTES
        });
      }
      this.retained = uncertainCandidates;
    } else {
      this.retained = [];
      for (const s of seeds) {
        const scored = this.scoreAlignment(q, s.bar, warp);
        comparisons += scored.comparisons;
        if (scored.agreeFraction >= minAgreeFraction && scored.score >= matchThreshold) {
          matches.push({
            startBar: s.bar,
            endBar: Math.min(this.bars.length, s.bar + L),
            score: scored.score,
            agreeFraction: scored.agreeFraction,
            barScores: scored.barScores,
            seedSource: s.source,
            meta: this.bars[s.bar]?.meta ?? null
          });
        } else if (Math.abs(scored.score - matchThreshold) <= uncertaintyBand) {
          uncertainCandidates.push({
            startBar: s.bar,
            seedSimilarity: s.sim,
            reason: "near-threshold",
            source: s.source,
            estimatedVerificationBytes: CANDIDATE_OVERHEAD_BYTES + L * FLOAT_BYTES
          });
        } else if (this.bars[s.bar]?.coverage === "covered") {
          provenMismatchBars.add(s.bar);
        }
      }
      matches.sort((a, b) => b.score - a.score);
    }

    const naiveComparisons = Math.max(0, this.bars.length - L + 1) * L;
    const savedComparisons = Math.max(0, naiveComparisons - comparisons);
    const retainedBytes = uncertainCandidates.length * (CANDIDATE_OVERHEAD_BYTES + L * FLOAT_BYTES);
    return {
      queryBars: L,
      matches,
      uncoveredBars,
      provenMismatchBars: Array.from(provenMismatchBars).sort((a, b) => a - b),
      uncertainCandidates,
      retainedCount: uncertainCandidates.length,
      decision,
      estimatedRescanBytes: estimatedVerificationBytes,
      memoryBudgetBytes: budget,
      comparisons,
      naiveComparisons,
      savedComparisons,
      savedFraction: naiveComparisons > 0 ? savedComparisons / naiveComparisons : 0,
      boundChecks,
      prunedChunks,
      scannedChunks,
      memory: this.memoryStats(retainedBytes, budget)
    };
  }

  private scoreAlignment(
    q: Float32Array[],
    startBar: number,
    warp: number
  ): { score: number; agreeFraction: number; barScores: number[]; comparisons: number } {
    const L = q.length;
    const barScores: number[] = [];
    let comparisons = 0;
    for (let i = 0; i < L; i++) {
      const centre = startBar + i;
      let best = -2;
      const lo = Math.max(0, centre - warp);
      const hi = Math.min(this.bars.length - 1, centre + warp);
      for (let j = lo; j <= hi; j++) {
        comparisons++;
        best = Math.max(best, cosineUnit(q[i], this.bars[j].vector));
      }
      if (centre >= this.bars.length) best = 0;
      barScores.push(Math.max(0, best));
    }
    const score = barScores.reduce((a, b) => a + b, 0) / L;
    const agree = barScores.filter((s) => s >= 0.7).length / L;
    return { score, agreeFraction: agree, barScores, comparisons };
  }

  /** Re-run a scan once more memory is available; clears retained state. */
  rescanRetained(query: Array<Float32Array | number[]>, options: ScanOptions = {}): ScanResult {
    return this.scan(query, { ...options, memoryBudgetBytes: undefined, maxCandidates: undefined });
  }
}

// ---- Full-matrix oracle ----------------------------------------------------

export interface OracleHit {
  startBar: number;
  score: number;
  agreeFraction: number;
}

/** Exhaustive diagonal search used as the small-library ground truth. */
export function oracleSearch(
  bars: Array<Float32Array | number[]>,
  query: Array<Float32Array | number[]>,
  options: Pick<ScanOptions, "matchThreshold" | "barThreshold" | "minAgreeFraction" | "warp"> = {}
): OracleHit[] {
  const dim = bars[0]?.length ?? query[0]?.length ?? 0;
  const normBars = bars.map((b) => l2Normalise(b, dim));
  const q = query.map((v) => l2Normalise(v, dim));
  const L = q.length;
  const matchThreshold = options.matchThreshold ?? 0.8;
  const barThreshold = options.barThreshold ?? 0.7;
  const minAgreeFraction = options.minAgreeFraction ?? 0.75;
  const warp = options.warp ?? 0;
  const hits: OracleHit[] = [];
  for (let s = 0; s + L <= normBars.length; s++) {
    const scores: number[] = [];
    for (let i = 0; i < L; i++) {
      const centre = s + i;
      let best = -2;
      for (let d = -warp; d <= warp; d++) {
        const j = centre + d;
        if (j < 0 || j >= normBars.length) continue;
        best = Math.max(best, cosineUnit(q[i], normBars[j]));
      }
      scores.push(Math.max(0, best));
    }
    const score = scores.reduce((a, b) => a + b, 0) / L;
    const agree = scores.filter((x) => x >= barThreshold).length / L;
    if (score >= matchThreshold && agree >= minAgreeFraction) {
      hits.push({ startBar: s, score, agreeFraction: agree });
    }
  }
  return hits;
}

export interface OracleComparison {
  oracleCount: number;
  indexCount: number;
  recovered: number[];
  missed: number[];
  recall: number;
  /** Oracle hit starts the index labelled as proven mismatches. */
  falseExclusions: number[];
  falseExclusionCount: number;
  /** Total query lengths (bars) of missed oracle hits. */
  missedLengthBars: number;
  extraHits: number[];
}

/** Match hits by start bar within `startTolerance` bars. */
export function compareToOracle(
  oracle: OracleHit[],
  indexResult: ScanResult,
  queryLengthBars: number,
  startTolerance = 0
): OracleComparison {
  const recovered: number[] = [];
  const missed: number[] = [];
  const falseExclusions: number[] = [];
  for (const o of oracle) {
    const hit = indexResult.matches.some((h) => Math.abs(h.startBar - o.startBar) <= startTolerance);
    const keptUncertain = indexResult.uncertainCandidates.some(
      (u) => Math.abs(u.startBar - o.startBar) <= startTolerance
    );
    if (hit) recovered.push(o.startBar);
    else missed.push(o.startBar);
    if (!hit && !keptUncertain) {
      const excluded = indexResult.provenMismatchBars.some(
        (b) => Math.abs(b - o.startBar) <= startTolerance
      );
      if (excluded) falseExclusions.push(o.startBar);
    }
  }
  const oracleStarts = new Set(oracle.map((o) => o.startBar));
  const extraHits = indexResult.matches
    .map((h) => h.startBar)
    .filter((s) => !Array.from(oracleStarts).some((o) => Math.abs(o - s) <= startTolerance));
  return {
    oracleCount: oracle.length,
    indexCount: indexResult.matches.length,
    recovered,
    missed,
    recall: oracle.length ? recovered.length / oracle.length : 1,
    falseExclusions,
    falseExclusionCount: falseExclusions.length,
    missedLengthBars: missed.length * queryLengthBars,
    extraHits
  };
}

/** Dense NxN bar similarity matrix, the reference the chunk index is judged against. */
export function fullBarMatrix(bars: Array<Float32Array | number[]>): Float32Array {
  const n = bars.length;
  const dim = bars[0]?.length ?? 0;
  const norm = bars.map((b) => l2Normalise(b, dim));
  const mat = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    mat[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = Math.max(0, cosineUnit(norm[i], norm[j]));
      mat[i * n + j] = s;
      mat[j * n + i] = s;
    }
  }
  return mat;
}
