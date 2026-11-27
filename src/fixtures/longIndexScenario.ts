/**
 * Canonical long-song scenario for the chunk index.
 *
 * The narrative fixture: a long programme containing a real 8-bar chorus and
 * an *inserted alternative* passage whose first four bars are identical to the
 * chorus opening but whose closing four bars are different. A 4-bar prefix
 * query must return both locations; the 8-bar extended query must keep only
 * the real chorus.
 *
 * Vectors are deterministic unit vectors shaped like bar-level chroma: filler
 * chunks are coherent around a chunk centre (as real phrase bars are), while
 * the chorus bars carry an exact, copyable melodic pattern.
 */
import { LongSongIndex } from "../engine/chunkIndex";
import type { BarMeta } from "../engine/chunkIndex";

export const SCENARIO_DIM = 16;
export const OPEN_BARS = 4;
export const CHORUS_BARS = 8;

export interface ScenarioLayout {
  index: LongSongIndex;
  vectors: Float32Array[];
  metas: BarMeta[];
  chorus: Float32Array[];
  shortQuery: Float32Array[];
  alt: Float32Array[];
  trueChorusStart: number;
  altStart: number;
  fillerChunksBefore: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unit(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Float32Array.from({ length: v.length }, (_, i) => v[i] / n);
}

function randomUnit(rand: () => number, dim: number): Float32Array {
  return unit(Array.from({ length: dim }, () => rand() * 2 - 1));
}

/** Four mutually coherent bars around one chunk centre. */
function coherentChunk(rand: () => number, dim: number): Float32Array[] {
  const centre = randomUnit(rand, dim);
  return Array.from({ length: 4 }, () => {
    const noise = randomUnit(rand, dim);
    return unit(centre.map((c, k) => 0.92 * c + 0.32 * noise[k]));
  });
}

/**
 * Contrasting ending bars. The pulse coordinates deliberately avoid the
 * opening pattern's coordinates so the close cannot itself answer the short
 * opening query (an earlier seed-only variant reused the same pulse formula and
 * accidentally scored 0.99 against the query).
 */
function contrastBars(seed: number, count: number, dim: number): Float32Array[] {
  const rand = rng(seed);
  const mainCoords = [9, 10, 11, 12];
  const sideCoords = [14, 15, 6, 7];
  return Array.from({ length: count }, (_, i) => {
    const v = new Array<number>(dim).fill(0);
    v[mainCoords[i % mainCoords.length] % dim] = 1.5;
    v[sideCoords[i % sideCoords.length] % dim] = 0.6;
    for (let k = 0; k < dim; k++) v[k] += (rand() - 0.5) * 0.1;
    return unit(v);
  });
}

/** Strongly separated pattern bars, exact copies are used for reprises. */
function patternBars(seed: number, count: number, dim: number): Float32Array[] {
  const rand = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    // Orthogonal-ish basis pulses plus a little seeded body.
    const v = new Array<number>(dim).fill(0);
    v[i % dim] = 1.4;
    v[(i * 5 + 3) % dim] = 0.5;
    for (let k = 0; k < dim; k++) v[k] += (rand() - 0.5) * 0.12;
    return unit(v);
  });
}

export interface BuildScenarioOptions {
  fillerChunksBefore?: number;
  fillerChunksBetween?: number;
  fillerChunksAfter?: number;
  chunkBars?: number;
  insertAlt?: boolean;
  seed?: number;
}

export function buildAlternativeChorusScenario(
  options: BuildScenarioOptions = {}
): ScenarioLayout {
  const fillerChunksBefore = options.fillerChunksBefore ?? 6; // 24 bars
  const fillerChunksBetween = options.fillerChunksBetween ?? 3; // 12 bars
  const fillerChunksAfter = options.fillerChunksAfter ?? 6;
  const chunkBars = options.chunkBars ?? 4;
  const seed = options.seed ?? 20261127;
  const rand = rng(seed);
  const dim = SCENARIO_DIM;

  const chorus = patternBars(101, CHORUS_BARS, dim);
  // Alt: exact shared opening, genuinely different close (also distinct from
  // the opening query so no extra in-alt start answers the short query).
  const differentClose = contrastBars(909, CHORUS_BARS - OPEN_BARS, dim);
  const alt = [...chorus.slice(0, OPEN_BARS), ...differentClose];

  const vectors: Float32Array[] = [];
  const metas: BarMeta[] = [];
  const pushFillerChunks = (chunks: number, prefix: string) => {
    for (let c = 0; c < chunks; c++) {
      for (const v of coherentChunk(rand, dim)) {
        vectors.push(v);
        metas.push({ label: `${prefix}-c${c}` });
      }
    }
  };

  pushFillerChunks(fillerChunksBefore, "before");
  const trueChorusStart = vectors.length;
  chorus.forEach((v, i) => {
    vectors.push(v);
    metas.push({ label: `chorus-b${i + 1}` });
  });
  pushFillerChunks(fillerChunksBetween, "between");
  const altStart = vectors.length;
  if (options.insertAlt ?? true) {
    alt.forEach((v, i) => {
      vectors.push(v);
      metas.push({ label: `alt-b${i + 1}` });
    });
  }
  pushFillerChunks(fillerChunksAfter, "after");

  const index = new LongSongIndex({ dim, chunkBars });
  index.appendNewBars(vectors, metas);
  index.coverNew();

  return {
    index,
    vectors,
    metas,
    chorus,
    shortQuery: chorus.slice(0, OPEN_BARS),
    alt,
    trueChorusStart,
    altStart: options.insertAlt ?? true ? altStart : -1,
    fillerChunksBefore
  };
}

/**
 * Cross-chunk phrase fixture: a six-bar phrase starts two bars inside a chunk,
 * so every occurrence straddles a chunk boundary.
 */
export function buildCrossChunkPhraseScenario(chunkBars = 4): {
  index: LongSongIndex;
  phrase: Float32Array[];
  starts: number[];
} {
  const dim = SCENARIO_DIM;
  const rand = rng(4242);
  const phrase = patternBars(77, 6, dim);
  const vectors: Float32Array[] = [];
  // Filler stream: coherent four-bar cells, emitted bar by bar so phrases can
  // start exactly two bars after a chunk boundary and therefore cross it.
  let cell = coherentChunk(rand, dim);
  let cellPos = 0;
  const fillerBar = (): Float32Array => {
    const v = cell[cellPos % cell.length];
    cellPos++;
    if (cellPos % cell.length === 0) cell = coherentChunk(rand, dim);
    return v;
  };
  const pushUntil = (target: number) => {
    while (vectors.length < target) vectors.push(fillerBar());
  };

  pushUntil(2);
  const starts: number[] = [2];
  phrase.forEach((v) => vectors.push(v)); // 2..7, crosses boundary at 4

  pushUntil(30);
  starts.push(30);
  phrase.forEach((v) => vectors.push(v)); // 30..35, crosses boundary at 32

  pushUntil(64);
  const index = new LongSongIndex({ dim, chunkBars });
  index.appendNewBars(vectors);
  index.coverNew();
  return { index, phrase, starts };
}
