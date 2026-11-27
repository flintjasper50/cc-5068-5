import { useEffect, useMemo, useState } from "react";
import type { AnalysisResult } from "../../engine/types";
import {
  THRESHOLD_LIMITS,
  defaultEdits,
  resegmentStructure,
  diffStructure,
  StructureEditError
} from "../../engine/resegment";
import type { ThresholdEdits, ThresholdSpec, StructureView, StructureDiff } from "../../engine/resegment";
import { fmtTime, groupColour } from "../lib/format";

interface ThresholdWorkbenchProps {
  result: AnalysisResult;
  onPlayRange: (start: number, end: number, label: string) => void;
}

type DraftMap = Record<keyof Required<ThresholdEdits>, string>;
type SpecEntry = [keyof Required<ThresholdEdits>, ThresholdSpec];

function draftDefaults(): DraftMap {
  const d = defaultEdits();
  return {
    melodyThreshold: String(d.melodyThreshold),
    localThreshold: String(d.localThreshold),
    boundaryThresholdZ: String(d.boundaryThresholdZ)
  };
}

/**
 * Sound-analysis threshold workbench. Sliders/number fields edit the same
 * thresholds the kernel reads; Apply re-runs boundary detection + grouping on
 * the cached features. Validation failures are fed back into this panel.
 */
export function ThresholdWorkbench({ result, onPlayRange }: ThresholdWorkbenchProps) {
  const [drafts, setDrafts] = useState<DraftMap>(draftDefaults);
  const [view, setView] = useState<StructureView | null>(null);
  const [diff, setDiff] = useState<StructureDiff | null>(null);
  const [error, setError] = useState<{ field: string; message: string } | null>(null);

  // A newly loaded analysis invalidates any what-if view.
  useEffect(() => {
    setDrafts(draftDefaults());
    setView(null);
    setDiff(null);
    setError(null);
  }, [result]);

  const specs = useMemo<SpecEntry[]>(
    () => Object.entries(THRESHOLD_LIMITS) as SpecEntry[],
    []
  );

  const apply = () => {
    try {
      const candidate: ThresholdEdits = {};
      for (const [key] of specs) {
        const raw = drafts[key].trim();
        if (raw !== "") candidate[key] = Number(raw);
      }
      // The kernel validates first, then re-segments; an invalid draft throws
      // before any structure state is replaced.
      const next = resegmentStructure(result, candidate);
      setView(next);
      setDiff(diffStructure(result, next));
      setError(null);
    } catch (e) {
      if (e instanceof StructureEditError) {
        setError({ field: e.field, message: e.message });
      } else {
        setError({ field: "form", message: e instanceof Error ? e.message : String(e) });
      }
    }
  };

  const reset = () => {
    setDrafts(draftDefaults());
    setView(null);
    setDiff(null);
    setError(null);
  };

  return (
    <section className="panel threshold-workbench" data-testid="threshold-workbench">
      <div className="panel-head">
        <h2>Threshold workbench · 声音分析窗口</h2>
        <div className="wb-actions">
          <button onClick={apply} data-testid="apply-resegment" className="primary">
            Apply &amp; re-segment
          </button>
          <button onClick={reset} data-testid="reset-resegment">
            Reset
          </button>
        </div>
      </div>
      <p className="hint">
        Edit the live similarity / z gates, then re-run the same boundary and grouping kernel on the
        cached STFT/SSM. Use the play buttons in either column to audition the baseline and edited
        passages against the same recording.
      </p>

      <div className="threshold-controls">
        {specs.map(([key, spec]) => {
          const invalid = error?.field === key;
          return (
            <div className={`threshold-control${invalid ? " invalid" : ""}`} key={key}>
              <label htmlFor={`${spec.testId}-range`}>{spec.label}</label>
              <div className="threshold-inputs">
                <input
                  id={`${spec.testId}-range`}
                  type="range"
                  data-testid={spec.testId}
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={Number(drafts[key]) || spec.min}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [key]: e.target.value }))
                  }
                />
                <input
                  type="text"
                  inputMode="decimal"
                  className="threshold-number"
                  data-testid={`${spec.testId}-text`}
                  aria-label={`${spec.label} numeric value`}
                  value={drafts[key]}
                  onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                />
              </div>
              <span className="threshold-help">{spec.help}</span>
              <span className="threshold-range">
                {spec.min} – {spec.max} (step {spec.step}, default {spec.defaultValue})
              </span>
            </div>
          );
        })}
      </div>

      <div
        className={`resegment-error${error ? " show" : ""}`}
        data-testid="resegment-error"
        role="alert"
        data-field={error?.field ?? ""}
      >
        {error ? error.message : ""}
      </div>

      {diff && view && (
        <div className="structure-diff" data-testid="structure-diff">
          <div className="diff-summary">
            <span data-testid="diff-section-counts">
              Sections: {diff.beforeSectionCount} → {diff.afterSectionCount}
            </span>
            <span data-testid="diff-boundary-counts">
              Boundaries: {result.boundaries.length} → {view.boundaries.length}
            </span>
            <span className="diff-added" data-testid="diff-added">
              +{diff.addedBoundaries.length} added
              {diff.addedBoundaries.length
                ? ` (${diff.addedBoundaries.map((t) => fmtTime(t)).join(", ")})`
                : ""}
            </span>
            <span className="diff-removed" data-testid="diff-removed">
              −{diff.removedBoundaries.length} removed
              {diff.removedBoundaries.length
                ? ` (${diff.removedBoundaries.map((t) => fmtTime(t)).join(", ")})`
                : ""}
            </span>
          </div>
          {diff.familyChanges.length > 0 && (
            <ul className="diff-families" data-testid="diff-families">
              {diff.familyChanges.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}

          <div className="compare-grid">
            <div className="compare-col">
              <h3>Before · baseline structure</h3>
              {result.sections.map((s) => (
                <div className="compare-row" key={`before-${s.id}`}>
                  <span className="dot" style={{ background: groupColour(s.group) }} />
                  <span className="compare-label">
                    {s.label} <em>{s.group ? `family ${s.group}` : "unique"}</em>
                  </span>
                  <span className="compare-time">{fmtTime(s.cueStart)}–{fmtTime(s.cueEnd)}</span>
                  <button
                    data-testid={`play-baseline-${s.id}`}
                    onClick={() => onPlayRange(s.cueStart, s.cueEnd, `baseline ${s.label}`)}
                  >
                    ▶ Play
                  </button>
                </div>
              ))}
            </div>
            <div className="compare-col edited">
              <h3>After · re-segmented{diff.afterSectionCount !== diff.beforeSectionCount ? " *" : ""}</h3>
              {view.sections.map((s) => {
                const row = diff.sectionRows.find((r) => r.id === s.id);
                return (
                  <div className={`compare-row${row?.changed ? " changed" : ""}`} key={`after-${s.id}`}>
                    <span className="dot" style={{ background: groupColour(s.group) }} />
                    <span className="compare-label">
                      {s.label} <em>{s.group ? `family ${s.group}` : "unique"}</em>
                      {row && !row.sameSpan
                        ? " · span changed"
                        : row?.groupChanged
                          ? " · regrouped"
                          : ""}
                    </span>
                    <span className="compare-time">{fmtTime(s.cueStart)}–{fmtTime(s.cueEnd)}</span>
                    <button
                      data-testid={`play-edited-${s.id}`}
                      onClick={() => onPlayRange(s.cueStart, s.cueEnd, `edited ${s.label}`)}
                    >
                      ▶ Play
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
