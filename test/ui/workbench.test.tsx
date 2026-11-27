// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { analyseAudio } from "../../src/engine/analyse";
import { renderSong, referenceSong } from "../../src/fixtures/synth";
import type { AnalysisResult } from "../../src/engine/types";
import { ThresholdWorkbench } from "../../src/app/components/ThresholdWorkbench";
import { IndexLab } from "../../src/app/components/IndexLab";
import { buildAlternativeChorusScenario } from "../../src/fixtures/longIndexScenario";

let ref: AnalysisResult;

beforeAll(() => {
  const reference = renderSong(referenceSong());
  ref = analyseAudio({ channels: reference.channels, sampleRate: reference.sampleRate });
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => null
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

describe("threshold workbench (kernel-driven UI)", () => {
  it("re-segments with default thresholds and shows a no-op diff", () => {
    render(<ThresholdWorkbench result={ref} onPlayRange={() => {}} />);
    fireEvent.click(screen.getByTestId("apply-resegment"));
    const diff = screen.getByTestId("structure-diff");
    expect(diff).toBeTruthy();
    const counts = screen.getByTestId("diff-section-counts").textContent ?? "";
    expect(counts).toContain(`${ref.sections.length} → ${ref.sections.length}`);
    expect(screen.getByTestId("diff-boundary-counts").textContent).toContain(
      `${ref.boundaries.length} → ${ref.boundaries.length}`
    );
  });

  it("raises the boundary z gate to collapse boundaries and offers before/after playback", () => {
    const onPlay = vi.fn();
    render(<ThresholdWorkbench result={ref} onPlayRange={onPlay} />);

    const zText = screen.getByTestId("boundary-z-threshold-text") as HTMLInputElement;
    fireEvent.change(zText, { target: { value: "2.1" } });
    fireEvent.click(screen.getByTestId("apply-resegment"));

    expect(screen.getByTestId("diff-boundary-counts").textContent).toContain(
      `${ref.boundaries.length} → 0`
    );
    expect(screen.getByTestId("diff-section-counts").textContent).toContain("→ 1");

    fireEvent.click(screen.getByTestId("play-baseline-S1"));
    expect(onPlay).toHaveBeenCalledTimes(1);
    const [start, end, label] = onPlay.mock.calls[0];
    expect(end).toBeGreaterThan(start);
    expect(typeof label).toBe("string");

    // The collapsed structure has exactly one edited row, also playable.
    const editedPlayButtons = screen.getAllByTestId(/^play-edited-/);
    expect(editedPlayButtons.length).toBe(1);
    fireEvent.click(editedPlayButtons[0]);
    expect(onPlay).toHaveBeenCalledTimes(2);
  });

  it("feeds validation failures back without replacing the structure", () => {
    render(<ThresholdWorkbench result={ref} onPlayRange={() => {}} />);
    const melodyText = screen.getByTestId("melody-threshold-text") as HTMLInputElement;
    fireEvent.change(melodyText, { target: { value: "9" } });
    fireEvent.click(screen.getByTestId("apply-resegment"));

    const error = screen.getByTestId("resegment-error");
    expect(error.classList.contains("show")).toBe(true);
    expect(error.getAttribute("data-field")).toBe("melodyThreshold");
    expect(error.textContent ?? "").toMatch(/between 0\.5 and 0\.99/);
    expect(screen.queryByTestId("structure-diff")).toBeNull();
  });

  it("reset clears the edited diff and restores default draft values", () => {
    render(<ThresholdWorkbench result={ref} onPlayRange={() => {}} />);
    fireEvent.change(screen.getByTestId("boundary-z-threshold-text"), {
      target: { value: "1.6" }
    });
    fireEvent.click(screen.getByTestId("apply-resegment"));
    expect(screen.queryByTestId("structure-diff")).toBeTruthy();

    fireEvent.click(screen.getByTestId("reset-resegment"));
    expect(screen.queryByTestId("structure-diff")).toBeNull();
    const zText = screen.getByTestId("boundary-z-threshold-text") as HTMLInputElement;
    expect(zText.value).toBe("1");
  });
});

describe("index lab", () => {
  it("short query returns both passages; extended query excludes the alt", () => {
    const scenario = buildAlternativeChorusScenario();
    render(<IndexLab />);

    const hits = screen.getByTestId("lab-hits").textContent ?? "";
    expect(hits).toContain(String(scenario.trueChorusStart));
    expect(hits).toContain(String(scenario.altStart));
    expect(hits).toContain("— 2");
    expect(screen.getByTestId("lab-alt").textContent).toContain("both versions returned");
    expect(screen.getByTestId("lab-oracle").textContent).toContain("recall 100%");
    expect(screen.getByTestId("lab-oracle").textContent).toContain("false exclusions 0");

    fireEvent.click(screen.getByTestId("lab-query-long"));
    const longHits = screen.getByTestId("lab-hits").textContent ?? "";
    expect(longHits).toContain(String(scenario.trueChorusStart));
    expect(longHits).not.toContain(String(scenario.altStart));
    expect(screen.getByTestId("lab-alt").textContent).toContain("excludes the alt");
  });

  it("separates tight-budget rescan from generous-budget retention", () => {
    render(<IndexLab />);
    const policy = screen.getByTestId("lab-policy") as HTMLSelectElement;

    fireEvent.change(policy, { target: { value: "budget" } });
    // Default cap option is tight.
    expect(screen.getByTestId("lab-decision").textContent).toContain("rescan");

    fireEvent.change(screen.getByTestId("lab-cap"), { target: { value: "generous" } });
    expect(screen.getByTestId("lab-decision").textContent).toContain("retain-uncertain");
    expect(screen.getByTestId("lab-rescan-retained")).toBeTruthy();

    fireEvent.click(screen.getByTestId("lab-rescan-retained"));
    expect(screen.getByTestId("lab-exact-note").textContent).toContain("Exact rescan resolved");
  });

  it("supports runtime insertion: one hit before, two after for the short query", () => {
    render(<IndexLab />);
    fireEvent.click(screen.getByTestId("lab-mode-workflow"));

    const insertButton = screen.getByTestId("lab-insert-alt");
    expect((screen.getByTestId("lab-alt").textContent ?? "")).toContain("alt missing");
    expect(screen.getByTestId("lab-uncovered").textContent).toContain("uncovered-new bars: 0");

    fireEvent.click(insertButton);
    expect(screen.getByTestId("lab-alt").textContent).toContain("both versions returned");
    // The eight inserted bars are reported as uncovered-new.
    expect(screen.getByTestId("lab-uncovered").textContent).toContain("uncovered-new bars: 8");

    fireEvent.click(screen.getByTestId("lab-query-long"));
    expect(screen.getByTestId("lab-alt").textContent).toContain("excludes the alt");
  });

  it("reports the cross-chunk phrase at both shifted starts with zero missed length", () => {
    render(<IndexLab />);
    const panel = screen.getByTestId("crosschunk-panel");
    expect(within(panel).getByTestId("crosschunk-found").textContent).toContain("2, 30");
    expect(within(panel).getByTestId("crosschunk-missed").textContent).toContain(
      "missed length 0 bars"
    );
  });
});
