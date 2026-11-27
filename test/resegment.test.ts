import { describe, it, expect, beforeAll } from "vitest";
import { analyseAudio } from "../src/engine/analyse";
import { renderSong, referenceSong } from "../src/fixtures/synth";
import {
  resegmentStructure,
  diffStructure,
  validateEdits,
  StructureEditError
} from "../src/engine/resegment";
import type { AnalysisResult } from "../src/engine/types";

let result: AnalysisResult;

beforeAll(() => {
  const song = renderSong(referenceSong());
  result = analyseAudio({ channels: song.channels, sampleRate: song.sampleRate });
});

describe("resegment kernel", () => {
  it("default edits reproduce the pinned analysis structure", () => {
    const view = resegmentStructure(result);
    expect(view.boundaries.length).toBe(result.boundaries.length);
    expect(view.sections.length).toBe(result.sections.length);
    expect(view.sections.map((s) => s.group)).toEqual(result.sections.map((s) => s.group));
  });

  it("raising the boundary z threshold removes a weak boundary first", () => {
    const strict = resegmentStructure(result, { boundaryThresholdZ: 1.6 });
    expect(strict.boundaries.length).toBeLessThan(result.boundaries.length);
    expect(strict.boundaries.length).toBe(4);
    const diff = diffStructure(result, strict);
    expect(diff.removedBoundaries.length).toBeGreaterThan(0);
  });

  it("high z threshold rejects every boundary back to one section", () => {
    const strict = resegmentStructure(result, { boundaryThresholdZ: 2.1 });
    expect(strict.boundaries.length).toBe(0);
    expect(strict.sections.length).toBe(1);
  });

  it("lower boundary z threshold adds candidates/boundaries or keeps all", () => {
    const loose = resegmentStructure(result, { boundaryThresholdZ: 0.4 });
    expect(loose.boundaries.length).toBeGreaterThanOrEqual(result.boundaries.length);
  });

  it("threshold edits change the grouping rule note to the live value", () => {
    const view = resegmentStructure(result, { melodyThreshold: 0.75 });
    expect(view.notes.some((n) => n.includes("≥ 75%"))).toBe(true);
  });

  it("rejects non-finite and out-of-range thresholds with field errors", () => {
    expect(() => validateEdits({ melodyThreshold: Number.NaN })).toThrow(StructureEditError);
    try {
      validateEdits({ melodyThreshold: 1.4 });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StructureEditError);
      expect((e as StructureEditError).field).toBe("melodyThreshold");
    }
    expect(() => resegmentStructure(result, { boundaryThresholdZ: -3 })).toThrow(/Boundary z/);
  });

  it("diff reports section and family structure for the before/after panel", () => {
    const strict = resegmentStructure(result, { boundaryThresholdZ: 2.2, melodyThreshold: 0.6 });
    const diff = diffStructure(result, strict);
    expect(diff.beforeSectionCount).toBe(result.sections.length);
    expect(diff.afterSectionCount).toBe(strict.sections.length);
    expect(diff.sectionRows.length).toBe(strict.sections.length);
    expect(Array.isArray(diff.familyChanges)).toBe(true);
  });
});
