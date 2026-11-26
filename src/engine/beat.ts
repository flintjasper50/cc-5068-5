import { BeatGrid } from "./types";
import { onsetEnvelope, normaliseEnvelope } from "./dsp";

const EPS = 1e-9;

export interface BeatOptions {
  sampleRate: number;
  beatsPerBar: number;
}

interface TempoEstimate {
  bpm: number;
  confidence: number;
}

function autocorrelation(env: Float32Array, lag: number): number {
  let acc = 0;
  let count = 0;
  for (let i = 0; i + lag < env.length; i++) {
    acc += env[i] * env[i + lag];
    count++;
  }
  return count > 0 ? acc / count : 0;
}

/**
 * Tempo by autocorrelation scored against a harmonic comb, so a period that is
 * the true beat's double (or triple) does not win merely by accumulating more
 * onset mass. A log-normal prior keeps the estimate near musical tempi.
 */
export function estimateTempo(env: Float32Array, frameRate: number): TempoEstimate {
  const minBpm = 45;
  const maxBpm = 215;
  const minLag = Math.max(1, Math.floor((60 / maxBpm) * frameRate));
  const maxLag = Math.min(env.length - 2, Math.ceil((60 / minBpm) * frameRate));
  if (maxLag <= minLag) return { bpm: 120, confidence: 0 };
  const ac = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) ac[lag] = autocorrelation(env, lag);

  // Harmonic comb score: the period should also explain 2x, 3x and 4x lags,
  // but a doubled period explains no energy at its own half-lag.
  const scores = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let harmonicSum = 0;
    let weightSum = 0;
    for (let k = 1; k <= 4; k++) {
      const l = Math.round(lag * k);
      if (l > maxLag) break;
      const w = 1 / k;
      harmonicSum += ac[l] * w;
      weightSum += w;
    }
    const base = weightSum > 0 ? harmonicSum / weightSum : 0;
    // Penalise if the half period carries about as much energy: then `lag`
    // is likely a multiple of the real beat.
    let subPenalty = 1;
    for (const div of [2, 3]) {
      const l = Math.round(lag / div);
      if (l >= minLag && l <= maxLag) {
        const sub = ac[l];
        if (sub > 0) subPenalty *= Math.min(1, Math.max(0.15, 1 - (sub / Math.max(base, 1e-9)) * 0.35));
      }
    }
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    scores[lag] = base * subPenalty * prior;
  }

  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (scores[lag] > best) {
      best = scores[lag];
      bestLag = lag;
    }
  }
  let refined = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = scores[bestLag - 1];
    const b = scores[bestLag];
    const c = scores[bestLag + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > EPS) {
      const offset = (0.5 * (a - c)) / denom;
      if (Math.abs(offset) <= 0.5) refined = bestLag + offset;
    }
  }
  const bpm = (60 * frameRate) / refined;
  const acBest = Math.max(0, ac[Math.round(refined)]);
  const variance = env.reduce((acc, v) => acc + v * v, 0) / Math.max(1, env.length);
  const confidence = Math.max(0, Math.min(1, acBest / Math.max(variance, EPS)));
  return { bpm, confidence };
}

/**
 * Dynamic-programming beat tracker (Ellis 2007 style): maximises onset
 * strength while penalising deviation from the estimated period.
 */
export function trackBeats(
  env: Float32Array,
  frameRate: number,
  bpm: number,
  tightness = 60
): number[] {
  const n = env.length;
  const period = (60 / bpm) * frameRate;
  if (n < 3 || period < 2) return [];
  const backlink = new Int32Array(n).fill(-1);
  const cumulative = new Float64Array(n);
  const low = Math.max(1, Math.round(period * 0.5));
  const high = Math.max(2, Math.round(period * 2));
  for (let i = 0; i < n; i++) {
    cumulative[i] = env[i];
    let bestScore = -Infinity;
    let bestPrev = -1;
    for (let j = Math.max(0, i - high); j <= i - low; j++) {
      const ratio = (i - j) / period;
      const transition = cumulative[j] + tightness * -(Math.log(ratio) ** 2);
      if (transition > bestScore) {
        bestScore = transition;
        bestPrev = j;
      }
    }
    if (bestPrev >= 0) {
      cumulative[i] += bestScore;
      backlink[i] = bestPrev;
    }
  }
  // Find the best end point in the last period.
  let end = n - 1;
  let bestEnd = -Infinity;
  const searchStart = Math.max(0, n - Math.round(period * 2));
  for (let i = searchStart; i < n; i++) {
    if (cumulative[i] > bestEnd) {
      bestEnd = cumulative[i];
      end = i;
    }
  }
  const frames: number[] = [];
  let cursor = end;
  while (cursor >= 0) {
    frames.push(cursor);
    cursor = backlink[cursor];
  }
  frames.reverse();
  return frames;
}

export function estimateBeatGrid(fineEnv: Float32Array, envHopSeconds: number, options: BeatOptions): BeatGrid {
  const frameRate = 1 / envHopSeconds;
  const tempo = estimateTempo(fineEnv, frameRate);
  const bpm = Math.max(40, Math.min(240, tempo.bpm));
  const beatFrames = trackBeats(fineEnv, frameRate, bpm);
  const beatTimes = new Float64Array(
    beatFrames.map((f) => (f + 0.5) * envHopSeconds)
  );
  const beatSeconds = 60 / bpm;

  // Regularity from inter-beat intervals.
  let regularity = 0;
  if (beatTimes.length > 2) {
    const intervals: number[] = [];
    for (let i = 1; i < beatTimes.length; i++) intervals.push(beatTimes[i] - beatTimes[i - 1]);
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const std = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length);
    regularity = Math.max(0, Math.min(1, 1 - std / Math.max(mean, EPS)));
  }

  // Downbeat phase: choose the phase with the strongest change at bar starts.
  const phaseScores = new Array(options.beatsPerBar).fill(0);
  const envAtFrame = (t: number) => {
    const idx = Math.round(t / envHopSeconds - 0.5);
    if (idx < 0 || idx >= fineEnv.length) return 0;
    return fineEnv[idx];
  };
  for (let i = 0; i < beatTimes.length; i++) {
    const phase = i % options.beatsPerBar;
    // Weight later beats slightly less to avoid edge bias.
    const envValue = Math.max(0, envAtFrame(beatTimes[i]));
    phaseScores[phase] += envValue;
  }
  let bestPhase = 0;
  let bestScore = -Infinity;
  let secondScore = -Infinity;
  for (let p = 0; p < phaseScores.length; p++) {
    if (phaseScores[p] > bestScore) {
      secondScore = bestScore;
      bestScore = phaseScores[p];
      bestPhase = p;
    } else if (phaseScores[p] > secondScore) {
      secondScore = phaseScores[p];
    }
  }
  const phaseConfidence =
    bestScore > EPS ? Math.max(0, Math.min(1, 1 - secondScore / Math.max(bestScore, EPS))) : 0;

  const downbeatTimes: number[] = [];
  for (let i = bestPhase; i < beatTimes.length; i += options.beatsPerBar) {
    downbeatTimes.push(beatTimes[i]);
  }

  // Extend the downbeat grid to cover the start and end of the programme.
  const barSeconds = beatSeconds * options.beatsPerBar;
  if (downbeatTimes.length > 0) {
    while (downbeatTimes[0] - barSeconds >= -barSeconds * 0.5) {
      downbeatTimes.unshift(downbeatTimes[0] - barSeconds);
    }
  }
  let confidence = 0.25 * tempo.confidence + 0.35 * regularity + 0.4 * phaseConfidence;
  if (beatTimes.length < 4) confidence *= 0.4;
  confidence = Math.max(0, Math.min(1, confidence));

  const method =
    beatTimes.length >= 4
      ? "autocorrelation tempo + DP beat tracking + onset-weighted downbeat phase"
      : "insufficient beats; uniform grid fallback";

  return {
    bpm,
    beatTimes,
    downbeatTimes: Float64Array.from(downbeatTimes),
    beatSeconds,
    barSeconds,
    beatsPerBar: options.beatsPerBar,
    confidence,
    tempoConfidence: tempo.confidence,
    regularity,
    phaseConfidence,
    method
  };
}

/** Build a uniform fallback grid for material with no reliable beat. */
export function fallbackBeatGrid(duration: number, options: BeatOptions): BeatGrid {
  const bpm = 120;
  const beatSeconds = 60 / bpm;
  const barSeconds = beatSeconds * options.beatsPerBar;
  const count = Math.max(1, Math.ceil(duration / barSeconds));
  const downbeats = new Float64Array(count + 1);
  for (let i = 0; i <= count; i++) downbeats[i] = i * barSeconds;
  return {
    bpm,
    beatTimes: downbeats,
    downbeatTimes: downbeats,
    beatSeconds,
    barSeconds,
    beatsPerBar: options.beatsPerBar,
    confidence: 0,
    tempoConfidence: 0,
    regularity: 0,
    phaseConfidence: 0,
    method: "uniform 120 BPM fallback (no stable beat detected)"
  };
}

export function analyseBeats(mono: Float32Array, sampleRate: number, options: BeatOptions & { duration: number }): BeatGrid {
  const { envelope, hop } = onsetEnvelope(mono, sampleRate);
  const env = normaliseEnvelope(envelope);
  const grid = estimateBeatGrid(env, hop / sampleRate, options);
  if (grid.beatTimes.length < 4 || grid.confidence < 0.12) {
    const fallback = fallbackBeatGrid(options.duration, options);
    return {
      ...fallback,
      method: `${grid.method} — rejected (confidence ${grid.confidence.toFixed(2)}), using ${fallback.method}`
    };
  }
  return grid;
}
