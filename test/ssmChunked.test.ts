import { describe, it, expect } from "vitest";
import { buildSsm, blurMatrix } from "../src/engine/ssm";
import { buildSsmChunked, compareMatrices } from "../src/engine/ssmChunked";
import { analyseAudio } from "../src/engine/analyse";
import { renderSong, challengeCases } from "../src/fixtures/synth";
import { DEFAULT_OPTIONS } from "../src/engine/types";
import type { FeatureSet } from "../src/engine/types";

function syntheticFeatures(n: number, dim = 12): FeatureSet {
  const chroma = new Float32Array(n * 12);
  const mfcc = new Float32Array(n * dim);
  const times = new Float64Array(n);
  // Four strongly separated "sections" of 16 frames. Chroma uses disjoint
  // pitch-class sets; MFCC uses near-orthogonal Walsh sign bases so z-scoring
  // cannot introduce a shared positive floor.
  const walsh = [
    [1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1],
    [1, 1, -1, -1, 1, 1, -1, -1, 1, 1, -1, -1],
    [1, 1, 1, 1, -1, -1, -1, -1, 1, 1, 1, 1],
    [-1, 1, -1, 1, 1, -1, 1, -1, -1, 1, -1, 1]
  ];
  for (let i = 0; i < n; i++) {
    const section = Math.floor(i / 16) % 4;
    for (let k = 0; k < 12; k++) {
      const active = k >= section * 3 && k < section * 3 + 3;
      chroma[i * 12 + k] = (active ? 1 : 0) + 0.004 * Math.sin(i * 1.7 + k);
    }
    for (let k = 0; k < dim; k++) {
      mfcc[i * dim + k] = 2 * walsh[section][k] + 0.03 * Math.cos(i * 0.3 + k);
    }
    times[i] = i * 0.1;
  }
  return {
    times,
    chroma,
    mfcc,
    loudnessDb: new Float32Array(n).fill(-20),
    onset: new Float32Array(n),
    timing: {
      windowSeconds: 0.09,
      fineHopSeconds: 0.012,
      fineFrameRate: 86,
      hopSeconds: 0.1,
      frameRate: 10,
      temporalAveragingSeconds: 0.4,
      requestedFrameRate: 10,
      downsampled: false
    },
    tuningOffsetSemitones: 0
  };
}

describe("chunked SSM optimisation", () => {
  const options = { ...DEFAULT_OPTIONS };
  const features = syntheticFeatures(128);

  it("accounts for every pair as either exact or skipped", () => {
    const { stats } = buildSsmChunked(features, options, { blockFrames: 8, pruneBound: 0.35 });
    expect(stats.exactPairs + stats.skippedPairs).toBe(stats.totalPairs);
    expect(stats.savedPairFraction).toBeGreaterThan(0.2);
    expect(stats.guaranteedMaxFillError).toBeGreaterThanOrEqual(0);
  });

  it("keeps matrix error inside the certified fill bound and close to full", () => {
    const full = buildSsm(features, options).ssm;
    const { ssm: approx, stats } = buildSsmChunked(features, options, {
      blockFrames: 8,
      pruneBound: 0.35
    });
    const error = compareMatrices(approx, full);
    // Midpoint-fill certification (float tolerance).
    expect(error.maxAbs).toBeLessThanOrEqual(stats.guaranteedMaxFillError + 1e-4);
    // Conservative prune threshold keeps the realised error modest.
    expect(error.channels.find((c) => c.channel === "combined")!.meanAbs).toBeLessThan(0.12);
  });

  it("prunes harder when the bound is raised, trading more error for fewer pairs", () => {
    const soft = buildSsmChunked(features, options, { blockFrames: 8, pruneBound: 0.2 });
    const hard = buildSsmChunked(features, options, { blockFrames: 8, pruneBound: 0.6 });
    expect(hard.stats.savedPairFraction).toBeGreaterThanOrEqual(soft.stats.savedPairFraction);
    const full = buildSsm(features, options).ssm;
    const eSoft = compareMatrices(soft.ssm, full).meanAbs;
    const eHard = compareMatrices(hard.ssm, full).meanAbs;
    expect(eHard).toBeGreaterThanOrEqual(eSoft - 1e-6);
  });

  it("blurred chunked matrix stays finite for the novelty stage", () => {
    const { ssm } = buildSsmChunked(features, options, { blockFrames: 8 });
    const blurred = blurMatrix(ssm.combined, ssm.n, 1);
    let bad = 0;
    for (const v of blurred) if (!Number.isFinite(v)) bad++;
    expect(bad).toBe(0);
  });
});

describe("chunked strategy through the full analysis kernel", () => {
  it("preserves boundary count and repetition families on the control song", () => {
    // Reuse the constant-tempo control case, a clean three-section programme.
    const spec = challengeCases().find((c) => c.id === "constant-tempo")!.spec;
    const song = renderSong(spec);
    const full = analyseAudio({ channels: song.channels, sampleRate: song.sampleRate });
    const chunked = analyseAudio({
      channels: song.channels,
      sampleRate: song.sampleRate,
      options: { ssmStrategy: "chunked" }
    });
    expect(chunked.boundaries.length).toBe(full.boundaries.length);
    expect(chunked.sections.length).toBe(full.sections.length);
    expect(chunked.sections.map((s) => s.group)).toEqual(full.sections.map((s) => s.group));
    expect(chunked.diagnostics.ssmOptimization).toBeTruthy();
  }, 120000);
});
