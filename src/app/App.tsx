import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisResult, CueReference, ResolvedCue, Section } from "../engine/types";
import { decodeWav } from "../engine/wav";
import {
  alignTakeToSections,
  createCueReferences,
  resolveCues
} from "../engine/alignment";
import { useAnalyser } from "./hooks/useAnalyser";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { SimilarityMatrix } from "./components/SimilarityMatrix";
import type { MatrixChannel } from "./components/SimilarityMatrix";
import { NoveltyPlot } from "./components/NoveltyPlot";
import { SectionTimeline } from "./components/SectionTimeline";
import { OrchestratorPanel } from "./components/OrchestratorPanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { ThresholdWorkbench } from "./components/ThresholdWorkbench";
import { IndexLab } from "./components/IndexLab";
import { fmtTime, groupColour, pct } from "./lib/format";

interface FixtureEntry {
  id: string;
  file: string;
  label: string;
  duration: number;
}

interface LoadedAudio {
  id: string;
  label: string;
  sampleRate: number;
  channels: Float32Array[];
  buffer: AudioBuffer | null;
  duration: number;
}

const CHANNELS: { id: MatrixChannel; label: string }[] = [
  { id: "combined", label: "Combined" },
  { id: "harmonic", label: "Harmony" },
  { id: "timbre", label: "Timbre" },
  { id: "tiHarmonic", label: "Harmony (transposition-invariant)" }
];

export function App() {
  const [fixtures, setFixtures] = useState<FixtureEntry[]>([]);
  const [reference, setReference] = useState<LoadedAudio | null>(null);
  const [take, setTake] = useState<LoadedAudio | null>(null);
  const [channel, setChannel] = useState<MatrixChannel>("combined");
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useTake, setUseTake] = useState(false);

  const refPlayer = useAudioPlayer();
  const takePlayer = useAudioPlayer();
  const activePlayer = useTake ? takePlayer : refPlayer;
  const refAnalyser = useAnalyser();
  const takeAnalyser = useAnalyser();
  const activeAnalyser = useTake ? takeAnalyser : refAnalyser;
  const state = activeAnalyser.state;

  // Reference and take analyses live in separate workers so loading one never
  // discards the other's result; the orchestration needs both simultaneously.
  const refResult: AnalysisResult | null = refAnalyser.state.result;
  const takeResult: AnalysisResult | null = takeAnalyser.state.result;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }, []);

  useEffect(() => {
    fetch("/fixtures/manifest.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: FixtureEntry[]) => setFixtures(list))
      .catch(() => setFixtures([]));
  }, []);

  const loadFixture = useCallback(
    async (entry: FixtureEntry) => {
      setError(null);
      setBusy(true);
      try {
        const res = await fetch(entry.file);
        if (!res.ok) throw new Error(`could not load ${entry.file}`);
        const arrayBuffer = await res.arrayBuffer();
        const decoded = decodeWav(arrayBuffer);
        const buffer = await getAudioContext().decodeAudioData(arrayBuffer.slice(0));
        const audio: LoadedAudio = {
          id: entry.id,
          label: entry.label,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          buffer,
          duration: decoded.duration
        };
        if (entry.id === "take") {
          setTake(audio);
          takePlayer.load(buffer);
          setUseTake(true);
          takeAnalyser.analyse(decoded.channels, decoded.sampleRate);
        } else {
          // Reference and the transient-stress programme are standalone
          // programmes, analysed in the reference slot.
          setReference(audio);
          refPlayer.load(buffer);
          setUseTake(false);
          refAnalyser.analyse(decoded.channels, decoded.sampleRate);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refAnalyser, takeAnalyser, getAudioContext, refPlayer, takePlayer]
  );

  const onFile = useCallback(
    async (file: File) => {
      setError(null);
      setBusy(true);
      try {
        const arrayBuffer = await file.arrayBuffer();
        const decoded = decodeWav(arrayBuffer);
        const buffer = await getAudioContext().decodeAudioData(arrayBuffer.slice(0));
        const audio: LoadedAudio = {
          id: "upload",
          label: file.name,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          buffer,
          duration: decoded.duration
        };
        setReference(audio);
        refPlayer.load(buffer);
        setUseTake(false);
        refAnalyser.analyse(decoded.channels, decoded.sampleRate);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refAnalyser, getAudioContext, refPlayer]
  );

  const result = useTake ? takeResult : refResult;

  const cues: CueReference[] = useMemo(() => {
    if (!refResult) return [];
    return createCueReferences(refResult.sections, refResult.bars, 3, refResult.duration);
  }, [refResult]);

  const resolved: ResolvedCue[] = useMemo(() => {
    if (!refResult || !takeResult) {
      return cues.map((cue) => ({
        cue,
        status: "valid" as const,
        sourceBar: null,
        takeBar: null,
        takeTime: null,
        note: "no take loaded; this is the reference position"
      }));
    }
    const alignment = alignTakeToSections(
      refResult.bars,
      refResult.sections,
      takeResult.bars,
      takeResult.duration
    );
    return resolveCues(cues, refResult.sections, alignment, takeResult.bars);
  }, [refResult, takeResult, cues]);

  const referenceCueTimes = useMemo(() => {
    if (!refResult) return [];
    return cues.map((cue) => ({
      id: cue.id,
      time: cue.sourceCueTime,
      sectionId: cue.sectionLabel
    }));
  }, [refResult, cues]);

  const onPickCell = useCallback(
    (a: number, b: number) => {
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      setSelection({ start, end });
      if (useTake) {
        takePlayer.play(start, Math.max(start + 0.15, end), "matrix cell");
      } else {
        refPlayer.play(start, Math.max(start + 0.15, end), "matrix cell");
      }
    },
    [useTake, refPlayer, takePlayer]
  );

  const onPlaySection = useCallback(
    (section: Section) => {
      setActiveSection(section.id);
      activePlayer.play(section.cueStart, section.cueEnd, `${section.label}`);
    },
    [activePlayer]
  );

  const onSeek = useCallback(
    (time: number) => {
      activePlayer.play(time, undefined, "seek");
    },
    [activePlayer]
  );

  const onJump = useCallback(
    (cue: ResolvedCue) => {
      if (!useTake || !takeResult) {
        // In reference mode, jump to the cue's own bar time.
        refPlayer.play(cue.cue.sourceCueTime, undefined, `${cue.cue.id} (reference)`);
        setJumpTarget(cue.cue.id);
        return;
      }
      const time = cue.takeTime ?? cue.cue.sourceCueTime;
      takePlayer.play(time, undefined, `${cue.cue.id} (${cue.status})`);
      setJumpTarget(cue.cue.id);
    },
    [useTake, takeResult, refPlayer, takePlayer]
  );

  // The "jump back to the chorus" demonstration. Without functional labels the
  // best structural proxy is the repeated family whose final statement comes
  // last: that is the return a producer usually wants. The jump uses that
  // statement's bar-anchored cue, so it is reproducible.
  const chorusJump = useMemo(() => {
    if (!refResult) return null;
    const repeated = refResult.groups.filter((g) => g.sectionIds.length > 1);
    if (repeated.length === 0) return null;
    const sectionById = new Map(refResult.sections.map((s) => [s.id, s]));
    const finalStart = (g: (typeof repeated)[number]) =>
      Math.max(...g.sectionIds.map((id) => sectionById.get(id)?.start ?? -Infinity));
    const group = repeated.reduce((a, b) => (finalStart(b) > finalStart(a) ? b : a), repeated[0]);
    const last = group.sectionIds[group.sectionIds.length - 1];
    const cue = cues.find((c) => c.sectionLabel === last);
    if (!cue) return null;
    if (!useTake || !takeResult) {
      return { id: cue.id, time: cue.sourceCueTime, label: `${group.label} · ${last}` };
    }
    const r = resolved.find((x) => x.cue.id === cue.id);
    return {
      id: cue.id,
      time: r?.takeTime ?? cue.sourceCueTime,
      label: `${group.label} · ${last} (${r?.status ?? "valid"})`
    };
  }, [refResult, useTake, takeResult, cues, resolved]);

  const playhead = useTake ? takePlayer.state.position : refPlayer.state.position;

  const jumpToChorus = useCallback(() => {
    if (!chorusJump) return;
    if (useTake && takeResult) takePlayer.play(chorusJump.time, undefined, "chorus jump");
    else refPlayer.play(chorusJump.time, undefined, "chorus jump");
    setJumpTarget(chorusJump.id);
  }, [chorusJump, useTake, takeResult, refPlayer, takePlayer]);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>SectionScope</h1>
          <p className="subtitle">
            Acoustic section structure from harmony and timbre. Boundaries are cited by bar-aligned cue
            time; nothing is read from chapter metadata.
          </p>
        </div>
        <div className="transport">
          <button
            onClick={() => {
              if (activePlayer.state.playing) activePlayer.stop();
              else activePlayer.play();
            }}
            disabled={!result}
            data-testid="play-toggle"
          >
            {activePlayer.state.playing ? "Stop" : "Play"}
          </button>
          <span className="clock" data-testid="clock">
            {fmtTime(playhead)} / {fmtTime(activePlayer.state.duration)}
          </span>
          <span className="current">{activePlayer.state.current}</span>
        </div>
      </header>

      <section className="sources">
        <div className="source-buttons">
          {fixtures.map((f) => (
            <button key={f.id} onClick={() => void loadFixture(f)} disabled={busy} data-testid={`load-${f.id}`}>
              {f.id === "reference" ? "Load reference" : f.id === "take" ? "Load take (bar dropped)" : `Load ${f.id}`}
            </button>
          ))}
          <label className="upload">
            Upload WAV
            <input
              type="file"
              accept=".wav,audio/wav"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
          </label>
        </div>
        <div className="mode-toggle">
          <button
            className={!useTake ? "active" : ""}
            onClick={() => {
              activePlayer.stop();
              setUseTake(false);
            }}
            disabled={!refResult}
          >
            Reference analysis
          </button>
          <button
            className={useTake ? "active" : ""}
            onClick={() => {
              activePlayer.stop();
              setUseTake(true);
            }}
            disabled={!takeResult}
          >
            Take analysis
          </button>
        </div>
      </section>

      {error && <div className="error">{error}</div>}
      {state.status === "running" && (
        <div className="progress" data-testid="progress">
          <div className="progress-bar" style={{ width: pct(state.progress) }} />
          <span>
            {state.label} — {pct(state.progress)}
          </span>
        </div>
      )}

      {result && (
        <main className="layout">
          <div className="left">
            <div className="panel">
              <div className="panel-head">
                <h2>Self-similarity matrix</h2>
                <div className="channel-tabs">
                  {CHANNELS.map((c) => (
                    <button
                      key={c.id}
                      className={channel === c.id ? "active" : ""}
                      onClick={() => setChannel(c.id)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="hint">
                Click or drag on the matrix to audition the segment between the two times. Outlined
                bands are sections coloured by repetition family; dashed lines are bar-aligned cue times.
              </p>
              <SimilarityMatrix
                result={result}
                channel={channel}
                selection={selection}
                onPickCell={onPickCell}
              />
            </div>

            <div className="panel">
              <h2>Bar-level decision curves</h2>
              <p className="hint">
                Before/after block contrast per bar boundary, the quantity boundaries are decided on.
              </p>
              <NoveltyPlot result={result} playhead={playhead} onSeek={onSeek} />
            </div>
          </div>

          <div className="right">
            <div className="panel">
              <h2>Sections</h2>
              <p className="hint">
                Neutral labels S1… and repetition families A, B… describe acoustic recurrence only.
              </p>
              <SectionTimeline result={result} activeSection={activeSection} onPlaySection={onPlaySection} />
              <div className="section-table" data-testid="section-table">
                {result.sections.map((s) => (
                  <div className="section-row" key={s.id}>
                    <span className="dot" style={{ background: groupColour(s.group) }} />
                    <span className="sec-label">{s.label}</span>
                    <span className="sec-time">
                      {fmtTime(s.start)}–{fmtTime(s.end)}
                    </span>
                    <span className="sec-bars">
                      bars {s.startBar + 1}–{s.endBar + 1}
                    </span>
                    <span className="sec-family">family {s.group || "–"}</span>
                    <span className="sec-conf">
                      {s.groupConfidence > 0 ? `match ${pct(s.groupConfidence)} · ` : ""}H {pct(s.harmonicConsistency)} · T{" "}
                      {pct(s.timbreConsistency)}
                    </span>
                    {(() => {
                      // Surface only the grouping decision (unique / borderline);
                      // ending-difference remarks stay in the row tooltip.
                      const groupingNote = s.notes.find(
                        (n) => n.includes("unique") || n.includes("mutual-best")
                      );
                      return groupingNote ? (
                        <span className="sec-note" title={s.notes.join(" ")}>
                          {groupingNote}
                        </span>
                      ) : null;
                    })()}
                  </div>
                ))}
              </div>
              {chorusJump && (
                <button className="chorus-jump" onClick={jumpToChorus} data-testid="chorus-jump">
                  Jump to repeated family at {fmtTime(chorusJump.time)} ({chorusJump.label})
                </button>
              )}
            </div>

            <OrchestratorPanel
              result={refResult ?? result}
              cues={cues}
              resolved={resolved}
              jumpTarget={jumpTarget}
              onJump={onJump}
              takeActive={useTake && !!takeResult}
            />

            <DiagnosticsPanel result={result} />
          </div>
        </main>
      )}

      {result && (
        <ThresholdWorkbench
          result={result}
          onPlayRange={(start, end, label) => activePlayer.play(start, end, label)}
        />
      )}

      <IndexLab />

      <footer className="app-footer">
        <p>
          Boundaries come from harmonic and timbre self-similarity only. Loudness peaks are tested for
          harmonic/timbre support and rejected when the context is unchanged. Feature rates and error
          sources are listed under Diagnostics.
        </p>
        <p className="cue-line">
          {referenceCueTimes.length} reference cues ·{" "}
          {takeResult ? `${takeResult.diagnostics.beat.bpm.toFixed(1)} BPM take` : "no take loaded"}
        </p>
      </footer>
    </div>
  );
}
