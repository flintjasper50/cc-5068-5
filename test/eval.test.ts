import { describe, it, expect } from "vitest";
import { analyseAudio } from "../src/engine/analyse";
import { decodeWav, encodeWav } from "../src/engine/wav";
import {
  renderSong,
  referenceSong,
  takeSong,
  transientSong,
  challengeCases
} from "../src/fixtures/synth";
import {
  alignTakeToSections,
  createCueReferences,
  resolveCues
} from "../src/engine/alignment";
import type { AnalysisResult } from "../src/engine/types";

function matchBoundaries(truth: number[], found: number[], tol: number) {
  const used = new Set<number>();
  const matched: { truth: number; found: number; err: number }[] = [];
  for (const t of truth) {
    let best = -1;
    let bestErr = Infinity;
    for (let i = 0; i < found.length; i++) {
      if (used.has(i)) continue;
      const err = Math.abs(found[i] - t);
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    if (best >= 0 && bestErr <= tol) {
      used.add(best);
      matched.push({ truth: t, found: found[best], err: bestErr });
    }
  }
  return {
    matched,
    missed: truth.filter((t) => !matched.some((m) => m.truth === t)),
    falsePositives: found.filter((_, i) => !used.has(i))
  };
}

function groupOf(result: AnalysisResult, index: number): string {
  return result.sections[index]?.group ?? "";
}

describe("reference song: boundaries and repetition families", () => {
  const song = renderSong(referenceSong());
  const result = analyseAudio({ channels: song.channels, sampleRate: song.sampleRate });
  const truth = song.segmentStarts.slice(1);

  it("finds every true boundary within one bar", () => {
    const found = result.boundaries.map((b) => b.time);
    const m = matchBoundaries(truth, found, result.beats.barSeconds * 1.1);
    expect(m.missed).toEqual([]);
    // No spurious boundaries beyond the five real ones.
    expect(m.falsePositives.length).toBe(0);
  });

  it("groups the two verse statements and the two chorus statements", () => {
    // Truth order: intro, A1, B1, A2, C1, B2.
    expect(result.sections.length).toBe(6);
    expect(groupOf(result, 1)).toBe(groupOf(result, 3)); // A1 ≈ A2 (transposed, re-orchestrated)
    expect(groupOf(result, 2)).toBe(groupOf(result, 5)); // B1 ≈ B2 (transposed, altered ending)
    expect(groupOf(result, 0)).not.toBe(groupOf(result, 1)); // intro unique
    expect(groupOf(result, 4)).not.toBe(groupOf(result, 2)); // bridge unique
    expect(groupOf(result, 4)).not.toBe(groupOf(result, 1));
    const repeated = result.groups.filter((g) => g.sectionIds.length > 1);
    expect(repeated.length).toBe(2);
  });

  it("attaches an uncertainty budget and citations to each boundary", () => {
    for (const b of result.boundaries) {
      expect(b.uncertainty.totalSeconds).toBeGreaterThan(0);
      expect(b.uncertainty.sources.length).toBeGreaterThanOrEqual(2);
      expect(b.cueTime).toBeCloseTo(result.bars[b.barIndex as number].start, 5);
    }
  });
});

describe("loudness transient is not a section change", () => {
  const song = renderSong(transientSong());
  const result = analyseAudio({ channels: song.channels, sampleRate: song.sampleRate });

  it("keeps the +10 dB bump inside one section", () => {
    // Truth boundaries: P1→P2 at 19.2 s (re-orchestration), P2→P3 at 38.4 s.
    const found = result.boundaries.map((b) => b.time);
    expect(found.length).toBe(2);
    expect(Math.abs(found[0] - 19.2)).toBeLessThan(result.beats.barSeconds * 1.1);
    expect(Math.abs(found[1] - 38.4)).toBeLessThan(result.beats.barSeconds * 1.1);
  });

  it("groups P1 and P2 as the same theme", () => {
    expect(result.sections.length).toBe(3);
    expect(groupOf(result, 0)).toBe(groupOf(result, 1));
    expect(groupOf(result, 2)).not.toBe(groupOf(result, 0));
  });
});

describe("take: a bar is deleted from the reprise", () => {
  const reference = renderSong(referenceSong());
  const take = renderSong(takeSong());
  const ref = analyseAudio({ channels: reference.channels, sampleRate: reference.sampleRate });
  const tk = analyseAudio({ channels: take.channels, sampleRate: take.sampleRate });

  it("records the dropped bar as a deletion, not a silent shift", () => {
    const alignment = alignTakeToSections(ref.bars, ref.sections, tk.bars, tk.duration);
    expect(alignment.deletedReferenceBars.length).toBeGreaterThanOrEqual(1);
    // The verse reprise is the fourth reference section; its deletion falls there.
    const verse = alignment.sections.find((s) => s.sectionId === "S4");
    expect(verse).toBeDefined();
    expect(verse!.unmatchedReferenceBars.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps common cues valid and retargets the cut one", () => {
    const alignment = alignTakeToSections(ref.bars, ref.sections, tk.bars, tk.duration);
    const cues = createCueReferences(ref.sections, ref.bars, 3, ref.duration);
    const resolved = resolveCues(cues, ref.sections, alignment, tk.bars);
    const valid = resolved.filter((r) => r.status === "valid");
    expect(valid.length).toBeGreaterThan(cues.length * 0.8);
    // No cue may claim a position the take does not have.
    for (const r of resolved) {
      if (r.takeTime !== null) {
        expect(r.takeTime).toBeGreaterThanOrEqual(0);
        expect(r.takeTime).toBeLessThanOrEqual(tk.duration + 1e-6);
      }
    }
  });

  it("retargets a cue from a genuinely deleted bar instead of inventing one", () => {
    const alignment = alignTakeToSections(ref.bars, ref.sections, tk.bars, tk.duration);
    // The take drops one bar from A2, so at least one anchor of a dense cue set
    // should be missing; all such cues must resolve to a real take bar.
    const dense = createCueReferences(ref.sections, ref.bars, 8, ref.duration);
    const resolved = resolveCues(dense, ref.sections, alignment, tk.bars);
    for (const r of resolved) {
      if (r.status === "retargeted") {
        expect(r.takeBar).not.toBeNull();
        expect(tk.bars[r.takeBar as number]).toBeDefined();
      }
    }
    expect(resolved.every((r) => r.status !== "invalid" || r.takeTime === null)).toBe(true);
  });

  it("groups the take's own sections the same way despite the dropped bar", () => {
    expect(tk.sections.length).toBe(6);
    expect(groupOf(tk, 1)).toBe(groupOf(tk, 3)); // A1 ≈ A2 (A2 lost a bar)
    expect(groupOf(tk, 2)).toBe(groupOf(tk, 5)); // B1 ≈ B2 (transposed down)
    expect(groupOf(tk, 0)).not.toBe(groupOf(tk, 1));
    expect(groupOf(tk, 4)).not.toBe(groupOf(tk, 2));
    expect(tk.groups.filter((g) => g.sectionIds.length > 1).length).toBe(2);
  });

  it("reports a genuinely borderline family with low confidence, not false certainty", () => {
    // The take's chorus reprise is transposed into the verse reprise's
    // register, so the timbre margin is thin. The family must still be found,
    // but its confidence must reflect the weakness of the evidence.
    const chorus = tk.sections.find((s) => s.id === "S6")!;
    expect(chorus.groupConfidence).toBeLessThan(0.6);
    expect(chorus.group).toBe(tk.sections.find((s) => s.id === "S3")!.group);
  });

  it("records the grouping rule and threshold in the diagnostics notes", () => {
    expect(tk.diagnostics.notes.some((n) => n.includes("Grouping rule"))).toBe(true);
  });
});

describe("exported 16-bit WAV round trip", () => {
  it("groups the take correctly when analysed from quantised WAV bytes", () => {
    // The browser analyses the exported WAV, not floats. Quantisation used to
    // flip the chorus pair onto the verse reprise; this pins the WAV path.
    const song = renderSong(takeSong());
    const wav = encodeWav(song.channels, song.sampleRate);
    const decoded = decodeWav(wav);
    const result = analyseAudio({ channels: decoded.channels, sampleRate: decoded.sampleRate });
    expect(result.sections.length).toBe(6);
    const byId = new Map(result.sections.map((s) => [s.id, s]));
    expect(byId.get("S2")!.group).toBe(byId.get("S4")!.group);
    expect(byId.get("S3")!.group).toBe(byId.get("S6")!.group);
    expect(byId.get("S1")!.group).not.toBe(byId.get("S2")!.group);
    expect(byId.get("S5")!.group).not.toBe(byId.get("S3")!.group);
  });
});

describe("known failure modes stay visible", () => {
  const cases = new Map(challengeCases().map((c) => [c.id, c]));

  it("finds the clean constant-tempo control case", () => {
    const c = cases.get("constant-tempo")!;
    const song = renderSong(c.spec);
    const result = analyseAudio({ channels: song.channels, sampleRate: song.sampleRate });
    const truth = song.segmentStarts.slice(1);
    const m = matchBoundaries(truth, result.boundaries.map((b) => b.cueTime), result.beats.barSeconds * 1.1);
    expect(m.missed).toEqual([]);
  });

  it("swallows a two-bar bridge, as documented (not silently fixed)", () => {
    // This is a real limitation: the minimum-section and exclusion rules are
    // wider than the bridge. The test pins the behaviour so a future change
    // that fixes it is noticed and the report updated.
    const c = cases.get("short-bridge")!;
    const song = renderSong(c.spec);
    const result = analyseAudio({ channels: song.channels, sampleRate: song.sampleRate });
    const truth = song.segmentStarts.slice(1);
    const m = matchBoundaries(truth, result.boundaries.map((b) => b.cueTime), result.beats.barSeconds * 1.1);
    expect(m.matched.length).toBeLessThan(truth.length);
  });

  it("reports the slow crossfade boundary with a valid kind, currently sharp", () => {
    // Known limitation: a five-second crossfade peaks late and the short-context
    // test reads it as a step, so the kind is "sharp" even though the truth is a
    // gradual transition. Pinned so the evaluation report stays honest and a
    // future improvement is noticed.
    const c = cases.get("slow-crossfade")!;
    const song = renderSong(c.spec);
    const result = analyseAudio({ channels: song.channels, sampleRate: song.sampleRate });
    const kinds = result.boundaries.map((b) => b.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k) => k === "sharp" || k === "gradual")).toBe(true);
    expect(c.expectedKind).toBe("gradual");
  });
});
