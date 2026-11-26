import type { AnalysisResult, CueReference, ResolvedCue, Section } from "../../engine/types";
import { describeCueStatus } from "../../engine/alignment";
import { fmtTime, groupColour } from "../lib/format";

interface Props {
  result: AnalysisResult;
  cues: CueReference[];
  resolved: ResolvedCue[];
  jumpTarget: string | null;
  onJump: (cue: ResolvedCue) => void;
  takeActive: boolean;
}

/**
 * The reference and the take share cue identifiers. A cue is citable because it
 * points at a bar of the reference; when it is resolved against a different
 * take the same identifier is re-used and the status says whether the bar still
 * exists, was retargeted to a surviving neighbour, or fell back.
 */
export function OrchestratorPanel({ result, cues, resolved, jumpTarget, onJump, takeActive }: Props) {
  const bySection = new Map<string, ResolvedCue[]>();
  for (const r of resolved) {
    const list = bySection.get(r.cue.sectionLabel) ?? [];
    list.push(r);
    bySection.set(r.cue.sectionLabel, list);
  }

  return (
    <div className="orchestrator" data-testid="orchestrator">
      <h2>Audition orchestrator</h2>
      <p className="hint">
        Cues are bar-anchored references into the analysed programme. In the take column each cue is
        resolved against the take: <span className="status valid">valid</span>{" "}
        <span className="status retargeted">retargeted</span>{" "}
        <span className="status fallback">fallback</span>{" "}
        <span className="status invalid">invalid</span>
      </p>
      <div className="cue-groups">
        {result.sections.map((section: Section) => {
          const list = bySection.get(section.id) ?? [];
          return (
            <div className="cue-group" key={section.id}>
              <div className="cue-group-head" style={{ color: groupColour(section.group) }}>
                {section.label} · family {section.group || "–"} ·{" "}
                {fmtTime(section.start)}–{fmtTime(section.end)}
              </div>
              <div className="cue-row">
                {list.map((r) => {
                  const isJump = jumpTarget === r.cue.id;
                  return (
                    <button
                      key={r.cue.id}
                      className={`cue-chip ${r.status}${isJump ? " jump" : ""}`}
                      onClick={() => onJump(r)}
                      data-testid={`cue-${r.cue.id}`}
                      title={r.note}
                    >
                      <span className="cue-id">{r.cue.id}</span>
                      <span className="cue-status">{takeActive ? describeCueStatus(r.status) : "reference"}</span>
                      <span className="cue-time">
                        {takeActive ? (r.takeTime !== null ? fmtTime(r.takeTime) : "—") : fmtTime(r.cue.sourceCueTime)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {cues.length === 0 && <p className="hint">No cues yet.</p>}
      </div>
    </div>
  );
}
