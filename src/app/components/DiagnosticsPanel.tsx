import type { AnalysisResult } from "../../engine/types";
import { pct } from "../lib/format";

interface Props {
  result: AnalysisResult;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="diag-row">
      <span className="diag-label">{label}</span>
      <span className="diag-value">{value}</span>
    </div>
  );
}

/**
 * Everything a reader needs to trace a boundary back to the waveform: the frame
 * rate, the quantisation it implies, the beat-grid confidence, and the exact
 * support measurements that were required.
 */
export function DiagnosticsPanel({ result }: Props) {
  const d = result.diagnostics;
  const timing = d.featureTiming;
  return (
    <div className="diagnostics" data-testid="diagnostics">
      <h2>Diagnostics</h2>

      <section>
        <h3>Feature time resolution</h3>
        <Row label="Input sample rate" value={`${d.inputSampleRate} Hz`} />
        <Row label="Analysis sample rate" value={`${d.analysisSampleRate} Hz`} />
        <Row label="STFT window" value={`${timing.windowSeconds.toFixed(3)} s`} />
        <Row label="Fine hop" value={`${timing.fineHopSeconds.toFixed(3)} s (${timing.fineFrameRate.toFixed(1)} Hz)`} />
        <Row
          label="Structural hop"
          value={`${timing.hopSeconds.toFixed(3)} s (${timing.frameRate.toFixed(2)} Hz)`}
        />
        <Row label="Temporal averaging" value={`${timing.temporalAveragingSeconds.toFixed(2)} s`} />
        {timing.downsampled && (
          <Row label="Downsampled" value={`from ${timing.requestedFrameRate} Hz to bound memory`} />
        )}
        <Row label="Frame quantisation" value={`±${(timing.hopSeconds / 2).toFixed(3)} s`} />
      </section>

      <section>
        <h3>Beat and bar grid</h3>
        <Row label="Tempo" value={`${d.beat.bpm.toFixed(1)} BPM (${pct(d.beat.tempoConfidence)})`} />
        <Row label="Method" value={d.beat.method} />
        <Row label="Regularity" value={pct(d.beat.regularity)} />
        <Row label="Downbeat phase" value={pct(d.beat.phaseConfidence)} />
        <Row label="Tuning offset" value={`${d.tuningOffsetSemitones.toFixed(2)} semitones`} />
      </section>

      <section>
        <h3>Boundaries and error sources</h3>
        {result.boundaries.length === 0 && <p className="hint">No boundary passed the evidence tests.</p>}
        {result.boundaries.map((b) => (
          <div className="boundary-diag" key={b.id}>
            <div className="boundary-head">
              <strong>{b.id}</strong> · {b.time.toFixed(2)} s → cue {b.cueTime.toFixed(2)} s · {b.kind} ·{" "}
              {pct(b.confidence)}
            </div>
            <Row label="Contrast z (H/T)" value={`${b.zScore.toFixed(2)} (${b.support.harmonicContrast.toFixed(2)}/${b.support.timbreContrast.toFixed(2)})`} />
            <Row label="Loudness contrast" value={`${b.support.loudnessContrastDb.toFixed(1)} dB`} />
            <Row label="Transposition" value={`${b.support.contextTransposition} semitones`} />
            <Row label="Total uncertainty" value={`±${b.uncertainty.totalSeconds.toFixed(2)} s`} />
            <ul className="sources">
              {b.uncertainty.sources.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section>
        <h3>Repeated-section grouping</h3>
        <p className="hint">
          A family needs transposition-invariant melodic alignment plus timbre closer than this
          programme's own baseline; assignment is mutual-best, so a disputed section is reported
          unique rather than forced into a family.
        </p>
        {result.sections.map((s) => (
          <div className="group-diag" key={s.id} data-testid={`group-${s.id}`}>
            <span className="diag-label">
              {s.label} → {s.group || "–"}
            </span>
            <span className="diag-value">
              {s.groupConfidence > 0 ? `match confidence ${pct(s.groupConfidence)}` : "unique"}
              {s.notes.length > 0 ? ` · ${s.notes.join(" ")}` : ""}
            </span>
          </div>
        ))}
      </section>

      <section>
        <h3>Rejected candidates ({result.rejected.length})</h3>
        {result.rejected.length === 0 && <p className="hint">None rejected.</p>}
        {result.rejected.map((r, i) => (
          <div className="rejected" key={`${r.time}-${i}`}>
            <span>{r.time.toFixed(2)} s</span>
            <span className="rejected-reason">{r.reason}</span>
          </div>
        ))}
      </section>

      <section>
        <h3>Notes</h3>
        <ul className="notes">
          {d.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
