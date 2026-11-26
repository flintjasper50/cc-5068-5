import type { AnalysisResult, Section } from "../../engine/types";
import { fmtTime, groupColour, pct } from "../lib/format";

interface Props {
  result: AnalysisResult;
  activeSection: string | null;
  onPlaySection: (section: Section) => void;
}

export function SectionTimeline({ result, activeSection, onPlaySection }: Props) {
  return (
    <div className="timeline" data-testid="section-timeline">
      {result.sections.map((section) => {
        const width = `${(section.duration / result.duration) * 100}%`;
        return (
          <button
            key={section.id}
            className={`timeline-cell${activeSection === section.id ? " active" : ""}`}
            style={{ width, borderColor: groupColour(section.group) }}
            onClick={() => onPlaySection(section)}
            title={`${section.label} ${fmtTime(section.start)}–${fmtTime(section.end)} (bars ${section.startBar + 1}–${section.endBar + 1}) family ${section.group || "–"}${section.groupConfidence > 0 ? ` (match confidence ${pct(section.groupConfidence)})` : ""}${section.notes.length ? ` — ${section.notes[0]}` : ""}`}
            data-testid={`section-${section.id}`}
          >
            <span className="timeline-label" style={{ color: groupColour(section.group) }}>
              {section.label}
            </span>
            <span className="timeline-family">{section.group || "–"}</span>
            <span className="timeline-conf">{pct(section.confidence)}</span>
          </button>
        );
      })}
    </div>
  );
}
