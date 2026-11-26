// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { analyseAudio } from "../../src/engine/analyse";
import { renderSong, referenceSong, takeSong } from "../../src/fixtures/synth";
import {
  alignTakeToSections,
  createCueReferences,
  resolveCues
} from "../../src/engine/alignment";
import type { AnalysisResult, CueReference, ResolvedCue } from "../../src/engine/types";
import { SectionTimeline } from "../../src/app/components/SectionTimeline";
import { OrchestratorPanel } from "../../src/app/components/OrchestratorPanel";
import { DiagnosticsPanel } from "../../src/app/components/DiagnosticsPanel";
import { SimilarityMatrix } from "../../src/app/components/SimilarityMatrix";

let ref: AnalysisResult;
let tk: AnalysisResult;
let cues: CueReference[];
let resolved: ResolvedCue[];

beforeAll(() => {
  const reference = renderSong(referenceSong());
  const take = renderSong(takeSong());
  ref = analyseAudio({ channels: reference.channels, sampleRate: reference.sampleRate });
  tk = analyseAudio({ channels: take.channels, sampleRate: take.sampleRate });
  cues = createCueReferences(ref.sections, ref.bars, 3, ref.duration);
  const alignment = alignTakeToSections(ref.bars, ref.sections, tk.bars, tk.duration);
  resolved = resolveCues(cues, ref.sections, alignment, tk.bars);
});

// jsdom has no canvas 2D implementation; the components guard on null, and we
// only assert on the DOM-level interaction and text content here.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

describe("section timeline", () => {
  it("renders every section with its acoustic family", () => {
    const onPlay = vi.fn();
    render(<SectionTimeline result={ref} activeSection={null} onPlaySection={onPlay} />);
    const cells = screen.getAllByTestId(/^section-S/);
    expect(cells.length).toBe(ref.sections.length);
    // A1 and A2 share a family; the intro does not.
    const labels = ref.sections.map((s) => s.group);
    expect(labels[1]).toBe(labels[3]);
    expect(screen.getByTestId("section-S2")).toBeTruthy();
    fireEvent.click(screen.getByTestId("section-S2"));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay.mock.calls[0][0].id).toBe("S2");
  });
});

describe("orchestrator cues", () => {
  it("lists reference cues and their resolved take statuses", () => {
    render(
      <OrchestratorPanel
        result={ref}
        cues={cues}
        resolved={resolved}
        jumpTarget={null}
        onJump={() => {}}
        takeActive={true}
      />
    );
    const chips = screen.getAllByTestId(/^cue-/);
    expect(chips.length).toBe(cues.length);
    // Every resolved cue must be a known status; at least most remain valid.
    const valid = resolved.filter((r) => r.status === "valid").length;
    expect(valid).toBeGreaterThan(cues.length * 0.8);
    const text = screen.getByTestId("orchestrator").textContent ?? "";
    expect(text).toContain("retargeted");
  });

  it("invokes the jump handler with the clicked cue", () => {
    const onJump = vi.fn();
    render(
      <OrchestratorPanel
        result={ref}
        cues={cues}
        resolved={resolved}
        jumpTarget={null}
        onJump={onJump}
        takeActive={false}
      />
    );
    const target = cues[0];
    fireEvent.click(screen.getByTestId(`cue-${target.id}`));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.calls[0][0].cue.id).toBe(target.id);
  });
});

describe("diagnostics", () => {
  it("exposes feature timing and per-boundary error sources", () => {
    render(<DiagnosticsPanel result={ref} />);
    const text = screen.getByTestId("diagnostics").textContent ?? "";
    expect(text).toContain("Structural hop");
    expect(text).toContain("Frame quantisation");
    expect(text).toContain("Total uncertainty");
    expect(ref.boundaries.length).toBeGreaterThan(0);
    for (const b of ref.boundaries) {
      expect(text).toContain(b.id);
    }
    expect(text).toContain("Rejected candidates");
  });
});

describe("similarity matrix interaction", () => {
  it("maps a click to a time span and reports it", () => {
    const onPick = vi.fn();
    render(
      <SimilarityMatrix
        result={ref}
        channel="combined"
        selection={null}
        onPickCell={onPick}
      />
    );
    const canvas = screen.getByTestId("ssm-canvas");
    // jsdom reports zero-size rects, so stub one matching the CSS size.
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 520, height: 520, right: 520, bottom: 520, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(canvas, { clientX: 260, clientY: 260 });
    fireEvent.pointerUp(canvas, { clientX: 312, clientY: 312 });
    expect(onPick).toHaveBeenCalled();
    const [a, b] = onPick.mock.calls[onPick.mock.calls.length - 1];
    expect(Math.min(a, b)).toBeGreaterThan(0);
    expect(Math.max(a, b)).toBeLessThanOrEqual(ref.duration + 1e-6);
    // Half-way across the matrix is half-way through the programme.
    expect(Math.abs(Math.min(a, b) - ref.duration / 2)).toBeLessThan(ref.duration * 0.05);
  });
});
