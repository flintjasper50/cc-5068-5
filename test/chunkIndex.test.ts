import { describe, it, expect } from "vitest";
import {
  LongSongIndex,
  oracleSearch,
  compareToOracle,
  chunkSimilarityUpperBound
} from "../src/engine/chunkIndex";
import {
  buildAlternativeChorusScenario,
  buildCrossChunkPhraseScenario,
  SCENARIO_DIM
} from "../src/fixtures/longIndexScenario";

const SCAN = { matchThreshold: 0.8, barThreshold: 0.7, minAgreeFraction: 0.75 } as const;

describe("alternative ending passage in the long-song index", () => {
  it("short prefix query returns both the chorus and the inserted alternative", () => {
    const s = buildAlternativeChorusScenario();
    const res = s.index.scan(s.shortQuery, SCAN);
    const starts = res.matches.map((h) => h.startBar).sort((a, b) => a - b);
    expect(starts).toContain(s.trueChorusStart);
    expect(starts).toContain(s.altStart);
    // Exactly the two passage starts: the alt's contrasting close must not
    // itself answer the opening query from an in-alt offset.
    expect(res.matches.length).toBe(2);
    expect(starts).not.toContain(s.altStart + 4);
  });

  it("extended query excludes the alternative once its different ending is included", () => {
    const s = buildAlternativeChorusScenario();
    const res = s.index.scan(s.chorus, SCAN);
    const starts = res.matches.map((h) => h.startBar);
    expect(starts).toContain(s.trueChorusStart);
    expect(starts).not.toContain(s.altStart);
    // The alt must not be silently declared a proven mismatch by a bound:
    // it is exact-verified and rejected on its ending evidence.
    const altHit = res.matches.find((h) => h.startBar === s.altStart);
    expect(altHit).toBeUndefined();
  });

  it("supports inserting the alternative after the index was already built", () => {
    const s = buildAlternativeChorusScenario({ insertAlt: false });
    const before = s.index.scan(s.shortQuery, SCAN);
    expect(before.matches.map((h) => h.startBar)).toContain(s.trueChorusStart);
    expect(before.matches.some((h) => h.startBar === s.altStart)).toBe(false);

    const insertedAt = s.trueChorusStart + 12;
    s.index.insertSegment(insertedAt, s.alt);
    // Inserted bars are uncovered-new, not proven mismatches.
    expect(s.index.newBars.length).toBe(s.alt.length);
    const afterShort = s.index.scan(s.shortQuery, SCAN);
    const shortStarts = afterShort.matches.map((h) => h.startBar);
    expect(shortStarts).toContain(s.trueChorusStart);
    expect(shortStarts).toContain(insertedAt);

    const afterLong = s.index.scan(s.chorus, SCAN);
    const longStarts = afterLong.matches.map((h) => h.startBar);
    expect(longStarts).toContain(s.trueChorusStart);
    expect(longStarts).not.toContain(insertedAt);
  });
});

describe("new bars vs proven mismatches and the memory budget", () => {
  it("keeps uncovered new bars in a separate set from proven mismatches", () => {
    const s = buildAlternativeChorusScenario();
    s.index.appendNewBars([
      Float32Array.from({ length: SCENARIO_DIM }, (_, k) => (k === 0 ? 1 : 0))
    ]);
    const res = s.index.scan(s.shortQuery, SCAN);
    expect(res.uncoveredBars.length).toBeGreaterThan(0);
    for (const b of res.uncoveredBars) {
      expect(res.provenMismatchBars).not.toContain(b);
    }
  });

  it("rescans under a tight cap and retains uncertain candidates when the cap allows", () => {
    const s = buildAlternativeChorusScenario();
    const baseBytes = s.index.memoryStats().totalBytes;

    // Tight cap: candidate storage does not fit, so the kernel must rescan
    // now (streaming memory) rather than retain or drop the candidates.
    const tight = s.index.scan(s.chorus, {
      ...SCAN,
      memoryPolicy: "budget",
      memoryBudgetBytes: baseBytes
    });
    expect(tight.decision).toBe("rescan");
    expect(tight.matches.map((h) => h.startBar)).toContain(s.trueChorusStart);
    expect(tight.matches.map((h) => h.startBar)).not.toContain(s.altStart);
    expect(tight.memory.withinBudget).toBe(true);

    // Generous cap: all seeds fit, uncertainty is retained instead of rescanned.
    const generous = s.index.scan(s.chorus, {
      ...SCAN,
      memoryPolicy: "budget",
      memoryBudgetBytes: baseBytes + 1_000_000
    });
    expect(generous.decision).toBe("retain-uncertain");
    expect(generous.uncertainCandidates.length).toBeGreaterThan(0);
    for (const u of generous.uncertainCandidates) {
      expect(generous.provenMismatchBars).not.toContain(u.startBar);
    }
    expect(generous.memory.withinBudget).toBe(true);

    // Raising the budget and rescanning resolves candidates exactly.
    const full = s.index.rescanRetained(s.chorus, SCAN);
    expect(full.decision).toBe("rescan");
    expect(full.matches.map((h) => h.startBar)).toContain(s.trueChorusStart);
    expect(full.matches.map((h) => h.startBar)).not.toContain(s.altStart);
  });

  it("maxCandidates cap forces a rescan when too many seeds would be retained", () => {
    const s = buildAlternativeChorusScenario();
    const res = s.index.scan(s.shortQuery, {
      ...SCAN,
      memoryPolicy: "budget",
      memoryBudgetBytes: 1 << 30,
      maxCandidates: 0
    });
    expect(res.decision).toBe("rescan");
    expect(res.matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("full-matrix oracle on the small library", () => {
  it("has full recall and zero false exclusions for the alt-chorus library", () => {
    const s = buildAlternativeChorusScenario();
    for (const q of [
      { q: s.shortQuery, len: 4 },
      { q: s.chorus, len: 8 }
    ] as const) {
      const oracle = oracleSearch(s.vectors, q.q, SCAN);
      const indexed = s.index.scan(q.q, SCAN);
      const cmp = compareToOracle(oracle, indexed, q.len);
      expect(cmp.recall).toBe(1);
      expect(cmp.missed).toEqual([]);
      expect(cmp.falseExclusionCount).toBe(0);
      expect(cmp.missedLengthBars).toBe(0);
    }
  });

  it("chunk upper bound never lies below the true chunk maximum", () => {
    const s = buildAlternativeChorusScenario();
    for (const chunk of s.index.chunks) {
      for (const q of s.chorus) {
        const upper = chunkSimilarityUpperBound(q, chunk);
        for (let j = chunk.startBar; j < chunk.endBar; j++) {
          let dot = 0;
          const v = s.index.bars[j].vector;
          for (let k = 0; k < q.length; k++) dot += q[k] * v[k];
          expect(upper + 1e-6).toBeGreaterThanOrEqual(dot);
        }
      }
    }
  });
});

describe("cross-chunk repeated phrases", () => {
  it("finds a six-bar phrase straddling chunk boundaries and saves comparisons", () => {
    const { index, phrase, starts } = buildCrossChunkPhraseScenario(4);
    const res = index.scan(phrase, SCAN);
    const foundStarts = res.matches.map((h) => h.startBar);
    for (const expected of starts) expect(foundStarts).toContain(expected);

    const oracle = oracleSearch(index.bars.map((b) => b.vector), phrase, SCAN);
    const cmp = compareToOracle(oracle, res, phrase.length);
    expect(cmp.recall).toBe(1);
    expect(cmp.falseExclusionCount).toBe(0);
    expect(cmp.missedLengthBars).toBe(0);

    expect(res.savedComparisons).toBeGreaterThan(0);
    expect(res.savedFraction).toBeGreaterThan(0.2);
    expect(res.prunedChunks.length).toBeGreaterThan(0);
    // Extension must cross the boundary: at least one hit spans two chunks.
    const crossing = res.matches.find((h) =>
      starts.includes(h.startBar) && Math.floor(h.startBar / 4) !== Math.floor((h.startBar + phrase.length - 1) / 4)
    );
    expect(crossing).toBeDefined();
  });
});

describe("index guards", () => {
  it("rejects wrong-dim vectors and empty queries with named errors", () => {
    const idx = new LongSongIndex({ dim: 4 });
    expect(() => idx.appendNewBars([new Float32Array(3)])).toThrow(/dim/);
    expect(() => idx.scan([])).toThrow(/at least one bar/);
    expect(() => idx.scan([new Float32Array(4)], { matchThreshold: 2 })).toThrow(/matchThreshold/);
  });
});
