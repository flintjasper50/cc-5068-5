/**
 * Synthetic test material with known section structure, used both by the Node
 * evaluation harness and the in-app demo. Everything is synthesised from
 * oscillators, so the ground truth is exact and no corpus is needed.
 */

export interface SynthNote {
  /** MIDI note number. */
  midi: number;
  /** Start in beats relative to the phrase start. */
  beat: number;
  /** Duration in beats. */
  beats: number;
  /** Relative amplitude. */
  amp?: number;
}

export interface Instrument {
  /** Harmonic amplitude profile from fundamental upward. */
  partials: number[];
  /** Exponential decay time constant in seconds, or Infinity for sustained. */
  decay: number;
  attack: number;
  /** Optional noise burst fraction for percussive timbres. */
  noise?: number;
  /** Vibrato depth in semitones. */
  vibrato?: number;
}

export const INSTRUMENTS: Record<string, Instrument> = {
  piano: { partials: [1, 0.55, 0.28, 0.16, 0.09, 0.05], decay: 1.4, attack: 0.006 },
  strings: { partials: [1, 0.7, 0.45, 0.3, 0.2, 0.12, 0.08], decay: Infinity, attack: 0.09, vibrato: 0.12 },
  flute: { partials: [1, 0.25, 0.12, 0.05], decay: Infinity, attack: 0.04, vibrato: 0.2 },
  reed: { partials: [1, 0.5, 0.6, 0.3, 0.25, 0.15, 0.1], decay: Infinity, attack: 0.03 },
  pluck: { partials: [1, 0.45, 0.35, 0.15, 0.2], decay: 0.45, attack: 0.003 },
  bass: { partials: [1, 0.8, 0.3, 0.12], decay: 0.9, attack: 0.005 }
};

export interface Phrase {
  /** Bars of material. Each bar is an array of notes (beat-relative within the bar). */
  bars: SynthNote[][];
}

export interface SegmentSpec {
  /** Reference section id this segment realises, or a novel label. */
  name: string;
  phrase: Phrase;
  /** Instrument per voice: voice 0 is melody/harmony, voice 1 is bass. */
  instruments: [string, string];
  /** Transposition in semitones applied to all notes. */
  transpose?: number;
  /** Gain in dB. */
  gainDb?: number;
  /** Crossfade seconds into the next segment. */
  fadeOutSeconds?: number;
  /** Bars to drop from the phrase (0-based) for take-editing tests. */
  dropBars?: number[];
  /** Optional bar to repeat (0-based) for insertion tests. */
  repeatBar?: number;
  /** Loudness bump in dB applied to a bar range, for transient tests. */
  loudnessBump?: { fromBar: number; toBar: number; db: number };
  /**
   * Gradual timbre morph of the melody voice from instruments[0] toward
   * `to`, linear over `overBars` (default: the whole segment). Used to stress
   * boundary detection with continuous timbre drift that must not create
   * spurious structural boundaries.
   */
  timbreRamp?: { to: string; overBars?: number };
}

export interface SongSpec {
  bpm: number;
  beatsPerBar: number;
  segments: SegmentSpec[];
}

export interface RenderedSong {
  sampleRate: number;
  channels: Float32Array[];
  duration: number;
  bpm: number;
  barSeconds: number;
  /** Ground-truth segment starts in seconds. */
  segmentStarts: number[];
  segmentNames: string[];
  segmentBarStarts: number[];
}

const A4 = 440;

export function midiToHz(midi: number): number {
  return A4 * 2 ** ((midi - 69) / 12);
}

function renderNote(
  out: Float32Array,
  sampleRate: number,
  startSec: number,
  lengthSec: number,
  midi: number,
  amp: number,
  inst: Instrument,
  rng: () => number
): void {
  const freq = midiToHz(midi);
  const start = Math.round(startSec * sampleRate);
  const length = Math.round(lengthSec * sampleRate);
  const attackSamples = Math.max(1, Math.round(inst.attack * sampleRate));
  const decaySamples = Number.isFinite(inst.decay) ? inst.decay * sampleRate : Infinity;
  for (let n = 0; n < length; n++) {
    const idx = start + n;
    if (idx < 0 || idx >= out.length) continue;
    const t = n / sampleRate;
    let env = 1;
    if (n < attackSamples) env = n / attackSamples;
    if (Number.isFinite(decaySamples)) env *= Math.exp(-n / decaySamples);
    // Release taper over the final 20 ms of the note.
    const release = Math.min(1, Math.max(0, (length - n) / (0.02 * sampleRate)));
    env *= release;
    const vib = inst.vibrato ? 1 + inst.vibrato * 0.01 * Math.sin(2 * Math.PI * 5.2 * t) : 1;
    let sample = 0;
    for (let h = 0; h < inst.partials.length; h++) {
      const f = freq * (h + 1) * vib;
      if (f > sampleRate / 2 - 200) break;
      sample += inst.partials[h] * Math.sin(2 * Math.PI * f * t + h * 0.7);
    }
    if (inst.noise) sample += inst.noise * (rng() * 2 - 1) * Math.exp(-t * 60);
    out[idx] += sample * env * amp * 0.12;
  }
}

/** Kick (low sine sweep) and hi-hat (noise burst) so the beat is unambiguous. */
function renderKick(out: Float32Array, sampleRate: number, startSec: number, amp: number): void {
  const start = Math.round(startSec * sampleRate);
  const length = Math.round(0.18 * sampleRate);
  for (let n = 0; n < length; n++) {
    const idx = start + n;
    if (idx < 0 || idx >= out.length) continue;
    const t = n / sampleRate;
    const freq = 120 * Math.exp(-t * 18) + 45;
    const env = Math.exp(-t * 26);
    out[idx] += Math.sin(2 * Math.PI * freq * t) * env * amp * 0.5;
  }
}

function renderHat(out: Float32Array, sampleRate: number, startSec: number, amp: number, rng: () => number): void {
  const start = Math.round(startSec * sampleRate);
  const length = Math.round(0.05 * sampleRate);
  let prev = 0;
  for (let n = 0; n < length; n++) {
    const idx = start + n;
    if (idx < 0 || idx >= out.length) continue;
    const t = n / sampleRate;
    const white = rng() * 2 - 1;
    // One-pole high-pass to give a bright, clicky timbre.
    const hp = white - prev;
    prev = white;
    out[idx] += hp * Math.exp(-t * 90) * amp * 0.12;
  }
}

function ampScale(gain: number): number {
  return Math.min(1.4, Math.max(0.35, gain));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderSong(spec: SongSpec, sampleRate = 22050, seed = 7): RenderedSong {
  const barSeconds = (60 / spec.bpm) * spec.beatsPerBar;
  const rng = mulberry32(seed);
  // First pass: total bars including repeats and drops.
  const planned = spec.segments.map((seg) => {
    const drop = new Set(seg.dropBars ?? []);
    const bars: number[] = [];
    for (let b = 0; b < seg.phrase.bars.length; b++) {
      if (drop.has(b)) continue;
      bars.push(b);
      if (seg.repeatBar === b) bars.push(b);
    }
    return { seg, bars };
  });
  const totalBars = planned.reduce((acc, p) => acc + p.bars.length, 0);
  const duration = totalBars * barSeconds + Math.max(0, ...spec.segments.map((s) => s.fadeOutSeconds ?? 0));
  const length = Math.ceil(duration * sampleRate);
  const out = new Float32Array(length);
  const segmentStarts: number[] = [];
  const segmentNames: string[] = [];
  const segmentBarStarts: number[] = [];
  let barCursor = 0;

  for (const { seg, bars } of planned) {
    segmentStarts.push(barCursor * barSeconds);
    segmentNames.push(seg.name);
    segmentBarStarts.push(barCursor);
    const [melodyName, bassName] = seg.instruments;
    const melody = INSTRUMENTS[melodyName];
    const bass = INSTRUMENTS[bassName];
    const rampInstrument = seg.timbreRamp ? INSTRUMENTS[seg.timbreRamp.to] : null;
    if (seg.timbreRamp && !rampInstrument) throw new Error(`unknown ramp instrument ${seg.timbreRamp.to}`);
    if (!melody || !bass) throw new Error(`unknown instrument in segment ${seg.name}`);
    const transpose = seg.transpose ?? 0;
    const gain = 10 ** ((seg.gainDb ?? 0) / 20);
    const bump = seg.loudnessBump;

    bars.forEach((phraseBarIndex, localIndex) => {
      const barStart = (barCursor + localIndex) * barSeconds;
      const bumpDb =
        bump && localIndex >= bump.fromBar && localIndex <= bump.toBar ? bump.db : 0;
      const barGain = gain * 10 ** (bumpDb / 20);
      const rampOver = seg.timbreRamp?.overBars ?? bars.length;
      const rampMix = seg.timbreRamp
        ? Math.max(0, Math.min(1, localIndex / Math.max(1, rampOver - 1)))
        : 0;
      for (const note of seg.phrase.bars[phraseBarIndex]) {
        const startSec = barStart + note.beat * (barSeconds / spec.beatsPerBar);
        // Notes sound through the bar unless the instrument is sustained, in which
        // case they are held to the next note in the same voice.
        const lengthSec = Math.min(
          note.beats * (barSeconds / spec.beatsPerBar),
          barSeconds * 0.98
        );
        const noteAmp = (note.amp ?? 1) * barGain;
        if (rampInstrument && rampMix > 0) {
          if (rampMix < 1) {
            renderNote(out, sampleRate, startSec, lengthSec, note.midi + transpose, noteAmp * (1 - rampMix), melody, rng);
          }
          renderNote(out, sampleRate, startSec, lengthSec, note.midi + transpose, noteAmp * rampMix, rampInstrument, rng);
        } else {
          renderNote(out, sampleRate, startSec, lengthSec, note.midi + transpose, noteAmp, melody, rng);
        }
      }
      // Bass: root of the lowest melody note, one octave down, two half-bar hits.
      const lowest = seg.phrase.bars[phraseBarIndex].reduce(
        (acc, n) => (n.midi < acc ? n.midi : acc),
        127
      );
      for (const beat of [0, 2]) {
        renderNote(
          out,
          sampleRate,
          barStart + beat * (barSeconds / spec.beatsPerBar),
          barSeconds / spec.beatsPerBar * 0.9,
          lowest - 12 + transpose,
          0.75 * barGain,
          bass,
          rng
        );
      }
      // Percussion on every beat; the kick reinforces beats 1 and 3.
      const beatSeconds = barSeconds / spec.beatsPerBar;
      for (let beat = 0; beat < spec.beatsPerBar; beat++) {
        const at = barStart + beat * beatSeconds;
        renderHat(out, sampleRate, at, (beat % 2 === 0 ? 1.0 : 0.7) * ampScale(gain), rng);
        if (beat % 2 === 0) renderKick(out, sampleRate, at, ampScale(gain));
      }
    });
    barCursor += bars.length;
  }

  // Apply crossfades at segment edges where requested.
  let cursorBars = 0;
  for (let s = 0; s < planned.length; s++) {
    const { seg, bars } = planned[s];
    const fade = seg.fadeOutSeconds ?? 0;
    if (fade > 0) {
      const fadeStart = (cursorBars + bars.length) * barSeconds - fade;
      const fadeLen = Math.round(fade * sampleRate);
      const start = Math.round(fadeStart * sampleRate);
      for (let n = 0; n < fadeLen; n++) {
        const idx = start + n;
        if (idx < 0 || idx >= out.length) continue;
        const g = Math.cos((n / fadeLen) * Math.PI * 0.5);
        // Fade both the tail of this segment and the head of the next.
        out[idx] *= g;
      }
    }
    cursorBars += bars.length;
  }

  normalisePeak(out, 0.85);
  return {
    sampleRate,
    channels: [out],
    duration: out.length / sampleRate,
    bpm: spec.bpm,
    barSeconds,
    segmentStarts,
    segmentNames,
    segmentBarStarts
  };
}

function normalisePeak(x: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 0) {
    const g = target / peak;
    for (let i = 0; i < x.length; i++) x[i] *= g;
  }
}

// ---- Phrase library --------------------------------------------------------
//
// Each section is a 4-bar cell repeated twice. The three cells use genuinely
// different tonal centres and registers so that repetition families are
// well defined: verse in C minor, chorus in E-flat major, bridge in A-flat.

const p = (midi: number, beat: number, beats: number, amp?: number): SynthNote => ({ midi, beat, beats, amp });

/**
 * Verse cell: C minor pentatonic, strictly *descending* contour, medium-low
 * register. Melody order is what identifies the theme, not the pitch-class set.
 */
const V_CELL: SynthNote[][] = [
  [p(72, 0, 1), p(70, 1, 1), p(67, 2, 2)],
  [p(65, 0, 1), p(63, 1, 1), p(62, 2, 2)],
  [p(60, 0, 2), p(58, 2, 2)],
  [p(55, 0, 4)]
];

/**
 * Chorus cell: E major, strictly *ascending* contour in a high register.
 * Ascending vs descending order survives transposition and re-orchestration.
 */
const C_CELL: SynthNote[][] = [
  [p(64, 0, 1), p(66, 1, 1), p(68, 2, 2)],
  [p(71, 0, 1), p(73, 1, 1), p(76, 2, 2)],
  [p(78, 0, 2), p(80, 2, 2)],
  [p(83, 0, 4)]
];

/** Chorus variant: same ascending opening, different (falling) close. */
const C_CELL_ALT: SynthNote[][] = [
  [p(64, 0, 1), p(66, 1, 1), p(68, 2, 2)],
  [p(71, 0, 1), p(73, 1, 1), p(76, 2, 2)],
  [p(78, 0, 2), p(76, 2, 2)],
  [p(71, 0, 4)]
];

/**
 * Bridge cell: A-flat major, wide oscillating leaps (down-up-down), a contour
 * distinct from both the descending verse and ascending chorus.
 */
const B_CELL: SynthNote[][] = [
  [p(68, 0, 2), p(80, 2, 2)],
  [p(63, 0, 2), p(75, 2, 2)],
  [p(68, 0, 2), p(80, 2, 2)],
  [p(60, 0, 4)]
];

/** Intro cell: sparse pedal tones, no melodic motion. */
const I_CELL: SynthNote[][] = [
  [p(48, 0, 4)],
  [p(55, 0, 4)],
  [p(51, 0, 4)],
  [p(50, 0, 4)]
];

function repeated(cell: SynthNote[][]): Phrase {
  return { bars: [...cell, ...cell.map((bar) => bar.map((n) => ({ ...n })))] };
}

/** Repeat a four-bar cell `times` times with independent note copies. */
function repeatCell(cell: SynthNote[][], times: number): Phrase {
  const bars: SynthNote[][] = [];
  for (let t = 0; t < times; t++) {
    for (const bar of cell) bars.push(bar.map((n) => ({ ...n })));
  }
  return { bars };
}

const VERSE: Phrase = repeated(V_CELL);
const CHORUS_SAME_OPEN: Phrase = repeated(C_CELL);
const CHORUS_ALT: Phrase = repeated(C_CELL_ALT);
const BRIDGE: Phrase = repeated(B_CELL);
const INTRO: Phrase = repeated(I_CELL);

export const PHRASES = { VERSE, CHORUS_SAME_OPEN, CHORUS_ALT, BRIDGE, INTRO };

/**
 * Reference song: intro, verse (piano), chorus (strings), verse reprise
 * (strings, transposed — same theme, new key and orchestration), bridge,
 * chorus reprise (piano, transposed, different closing bar).
 *
 * Repetition families by theme: verse {A1, A2}, chorus {B1, B2}, with intro
 * and bridge unique. All recurrences change key and/or instrumentation, so a
 * correct grouping cannot rely on exact transposition or timbre.
 */
export function referenceSong(): SongSpec {
  return {
    bpm: 100,
    beatsPerBar: 4,
    segments: [
      { name: "intro", phrase: INTRO, instruments: ["pluck", "bass"], gainDb: -4 },
      { name: "A1", phrase: VERSE, instruments: ["piano", "bass"] },
      { name: "B1", phrase: CHORUS_SAME_OPEN, instruments: ["strings", "bass"] },
      { name: "A2", phrase: VERSE, instruments: ["reed", "bass"], transpose: 3 },
      { name: "C1", phrase: BRIDGE, instruments: ["flute", "bass"], gainDb: -2 },
      { name: "B2", phrase: CHORUS_ALT, instruments: ["strings", "bass"], transpose: -4, fadeOutSeconds: 0.8 }
    ]
  };
}

/**
 * Take: the verse reprise loses one bar (bar 5), and the chorus reprise is
 * transposed and kept complete. Used to test deletion-aware alignment,
 * cue retargeting and local-vs-global choice.
 */
export function takeSong(): SongSpec {
  return {
    bpm: 100,
    beatsPerBar: 4,
    segments: [
      { name: "intro", phrase: INTRO, instruments: ["pluck", "bass"], gainDb: -4 },
      { name: "A1", phrase: VERSE, instruments: ["piano", "bass"] },
      { name: "B1", phrase: CHORUS_SAME_OPEN, instruments: ["strings", "bass"] },
      { name: "A2", phrase: VERSE, instruments: ["reed", "bass"], transpose: 3, dropBars: [5] },
      { name: "C1", phrase: BRIDGE, instruments: ["flute", "bass"], gainDb: -2 },
      { name: "B2", phrase: CHORUS_ALT, instruments: ["strings", "bass"], transpose: -4 }
    ]
  };
}

/**
 * Stress song for loudness-transient handling: a smooth instrumental
 * crossfade, a short loudness bump inside a repeated section, then a
 * modulation. The bump must not become a boundary.
 */
export function transientSong(): SongSpec {
  return {
    bpm: 100,
    beatsPerBar: 4,
    segments: [
      { name: "P1", phrase: VERSE, instruments: ["piano", "bass"] },
      {
        name: "P2",
        phrase: VERSE,
        instruments: ["strings", "bass"],
        fadeOutSeconds: 1.2,
        loudnessBump: { fromBar: 3, toBar: 3, db: 10 }
      },
      { name: "P3", phrase: CHORUS_SAME_OPEN, instruments: ["strings", "bass"], transpose: 3 }
    ]
  };
}

/**
 * Scale/stress programme: a normal verse/chorus cycle followed by a 24-bar
 * recapitulation of the chorus whose orchestration morphs gradually from
 * strings through reed to flute. The long repeated block raises the SSM and
 * alignment load; the continuous timbre ramp must not be split into fake
 * boundaries. `recapCells` scales the load for benchmarks.
 */
export function longRecapSong(recapCells = 6): SongSpec {
  return {
    bpm: 100,
    beatsPerBar: 4,
    segments: [
      { name: "intro", phrase: repeatCell(I_CELL, 1), instruments: ["pluck", "bass"], gainDb: -4 },
      { name: "A1", phrase: repeatCell(V_CELL, 2), instruments: ["piano", "bass"] },
      { name: "B1", phrase: repeatCell(C_CELL, 2), instruments: ["strings", "bass"] },
      { name: "A2", phrase: repeatCell(V_CELL, 2), instruments: ["reed", "bass"], transpose: 3 },
      {
        name: "B2-long-recap",
        phrase: repeatCell(C_CELL_ALT, Math.max(2, recapCells)),
        instruments: ["strings", "bass"],
        timbreRamp: { to: "flute" },
        fadeOutSeconds: 0.8
      }
    ]
  };
}

/**
 * Hard programmes for the evaluation report. These are expected to expose
 * failure modes rather than to pass: they exist so the analyser's limits are
 * visible and measurable, not hidden.
 */
export interface ChallengeCase {
  id: string;
  note: string;
  spec: SongSpec;
  /** Which behaviour the case is probing. */
  probe: "same-timbre" | "gradual" | "short-section" | "tempo-stable";
  /** The boundary kind a correct analysis should report, when it is known. */
  expectedKind?: "sharp" | "gradual";
}

export function challengeCases(): ChallengeCase[] {
  return [
    {
      id: "same-timbre",
      probe: "same-timbre",
      note:
        "Verse and chorus played on the same piano with the same bass: harmony and timbre differ only through the melody, so the boundary has the least evidence.",
      spec: {
        bpm: 100,
        beatsPerBar: 4,
        segments: [
          { name: "A1", phrase: VERSE, instruments: ["piano", "bass"] },
          { name: "B1", phrase: CHORUS_SAME_OPEN, instruments: ["piano", "bass"] },
          { name: "A2", phrase: VERSE, instruments: ["piano", "bass"], transpose: 3 }
        ]
      }
    },
    {
      id: "slow-crossfade",
      probe: "gradual",
      expectedKind: "gradual",
      note:
        "Two sections joined by a five-second crossfade: there is no instant where the contrast peaks, so the detected cue is expected to drift late and the kind should read gradual.",
      spec: {
        bpm: 100,
        beatsPerBar: 4,
        segments: [
          { name: "A1", phrase: VERSE, instruments: ["strings", "bass"], fadeOutSeconds: 5 },
          { name: "B1", phrase: CHORUS_SAME_OPEN, instruments: ["strings", "bass"], gainDb: -2 }
        ]
      }
    },
    {
      id: "short-bridge",
      probe: "short-section",
      note:
        "A two-bar bridge between two verse statements: shorter than the minimum-section rule and within the boundary exclusion radius, so it is expected to be swallowed.",
      spec: {
        bpm: 100,
        beatsPerBar: 4,
        segments: [
          { name: "A1", phrase: VERSE, instruments: ["piano", "bass"] },
          { name: "X", phrase: { bars: BRIDGE.bars.slice(0, 2) }, instruments: ["flute", "bass"] },
          { name: "A2", phrase: VERSE, instruments: ["piano", "bass"], transpose: -3 }
        ]
      }
    },
    {
      id: "constant-tempo",
      probe: "tempo-stable",
      note:
        "Three sections at a constant 100 BPM with re-orchestration; a control case that should segment cleanly.",
      spec: {
        bpm: 100,
        beatsPerBar: 4,
        segments: [
          { name: "A1", phrase: VERSE, instruments: ["piano", "bass"] },
          { name: "B1", phrase: CHORUS_SAME_OPEN, instruments: ["strings", "bass"] },
          { name: "A2", phrase: VERSE, instruments: ["reed", "bass"], transpose: 2 }
        ]
      }
    }
  ];
}

