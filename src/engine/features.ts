import { AnalysisOptions, FeatureSet, FeatureTiming } from "./types";
import { FFT, hannWindow } from "./fft";
import { dct2, melFilterbank } from "./stft";
import { onsetEnvelope, resampleSinc } from "./dsp";

const EPS = 1e-10;

export interface FeatureInput {
  mono: Float32Array;
  sampleRate: number;
  options: AnalysisOptions;
}

function l2NormaliseInPlace(vec: Float32Array, from: number, length: number): void {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += vec[from + i] * vec[from + i];
  const norm = Math.sqrt(sum);
  if (norm > EPS) {
    for (let i = 0; i < length; i++) vec[from + i] /= norm;
  }
}

function estimateTuning(
  signal: Float32Array,
  sampleRate: number,
  fftSize: number
): number {
  const win = hannWindow(fftSize);
  const fft = new FFT(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  // Histogram of deviations from equal temperament, weighted by peak energy.
  const bins = 120;
  const dev = new Float32Array(bins);
  const step = Math.max(fftSize, Math.floor(signal.length / 160));
  for (let start = 0; start + fftSize <= signal.length; start += step) {
    let frameEnergy = 0;
    for (let i = 0; i < fftSize; i++) {
      re[i] = signal[start + i] * win[i];
      im[i] = 0;
      frameEnergy += re[i] * re[i];
    }
    if (frameEnergy < 1e-6) continue;
    fft.transform(re, im);
    const mag = new Float32Array(fftSize / 2 + 1);
    for (let k = 1; k < mag.length - 1; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
    }
    for (let k = 2; k < mag.length - 1; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > 1e-4) {
        // Parabolic interpolation for a sub-bin peak. The denominator is
        // negative at a true peak; do not clamp it upward or the estimated
        // frequency (and hence the tuning offset) is nonsense.
        const a = mag[k - 1];
        const b = mag[k];
        const c = mag[k + 1];
        const denom = a - 2 * b + c;
        if (Math.abs(denom) < EPS) continue;
        const delta = (0.5 * (a - c)) / denom;
        if (Math.abs(delta) > 0.5) continue;
        const freq = ((k + delta) * sampleRate) / fftSize;
        if (freq < 55 || freq > 4000) continue;
        const midi = 69 + 12 * Math.log2(freq / 440);
        const frac = midi - Math.round(midi);
        const idx = Math.min(bins - 1, Math.max(0, Math.round(((frac + 0.5) / 1) * (bins - 1))));
        dev[idx] += Math.log1p(mag[k]);
      }
    }
  }
  let best = 0;
  let bestVal = -Infinity;
  // Smooth circularly before picking the mode.
  for (let i = 0; i < bins; i++) {
    let acc = 0;
    for (let d = -2; d <= 2; d++) acc += dev[(i + d + bins) % bins];
    if (acc > bestVal) {
      bestVal = acc;
      best = i;
    }
  }
  const offset = (best / (bins - 1)) - 0.5;
  return Math.abs(offset) < 0.5 ? offset : 0;
}

export function extractFeatures(input: FeatureInput): FeatureSet {
  const { mono, sampleRate, options } = input;
  const duration = mono.length / sampleRate;
  const requestedHop = 1 / options.frameRate;
  let hopSeconds = requestedHop;
  let downsampled = false;
  const framesAtRequested = Math.ceil(duration / requestedHop);
  if (framesAtRequested > options.maxFrames) {
    hopSeconds = duration / options.maxFrames;
    downsampled = true;
  }
  const frameCount = Math.max(1, Math.ceil(duration / hopSeconds));
  const timing: FeatureTiming = {
    windowSeconds: options.fftSize / sampleRate,
    fineHopSeconds: options.hopSize / sampleRate,
    fineFrameRate: sampleRate / options.hopSize,
    hopSeconds,
    frameRate: 1 / hopSeconds,
    temporalAveragingSeconds: hopSeconds,
    requestedFrameRate: options.frameRate,
    downsampled
  };

  const tuning = estimateTuning(mono, sampleRate, options.fftSize);

  // Fine STFT, aggregated directly into structural frames to bound memory.
  const fftSize = options.fftSize;
  const hop = options.hopSize;
  const win = hannWindow(fftSize);
  const fft = new FFT(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const binCount = fftSize / 2 + 1;
  const binHz = sampleRate / fftSize;

  const chroma = new Float32Array(frameCount * 12);
  const mfcc = new Float32Array(frameCount * options.mfccBands);
  const loudnessDb = new Float32Array(frameCount);
  const loudnessAcc = new Float64Array(frameCount);
  const loudnessCount = new Float64Array(frameCount);
  const times = new Float64Array(frameCount);
  for (let j = 0; j < frameCount; j++) times[j] = (j + 0.5) * hopSeconds;

  const mel = melFilterbank(options.melBands, fftSize, sampleRate, 40, Math.min(8000, sampleRate / 2));
  const melAcc = new Float64Array(frameCount * options.melBands);
  const frameWeight = new Float64Array(frameCount);

  // Precompute pitch class for each FFT bin. Chroma is restricted to the
  // melodic band: kick and bass fundamentals below ~110 Hz are loud but carry
  // almost no harmonic identity, and including them lets one pitch class
  // dominate every frame. Above 2 kHz partials are dense enough that pitch
  // class becomes noise.
  const binPitch = new Int8Array(binCount);
  binPitch.fill(-1);
  const chromaBandLow = 110;
  const chromaBandHigh = 2000;
  for (let k = 1; k < binCount; k++) {
    const f = k * binHz;
    if (f < chromaBandLow || f > Math.min(chromaBandHigh, sampleRate / 2)) continue;
    const midi = 69 + 12 * Math.log2(f / 440) - tuning;
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    binPitch[k] = pc;
  }

  const fineFrames = Math.max(0, Math.floor((mono.length - fftSize) / hop) + 1);
  const fineHopSeconds = hop / sampleRate;
  for (let f = 0; f < fineFrames; f++) {
    const start = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = mono[start + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    const mag = new Float32Array(binCount);
    for (let k = 0; k < binCount; k++) mag[k] = Math.hypot(re[k], im[k]);

    const centre = (start + fftSize / 2) / sampleRate;
    const j = Math.min(frameCount - 1, Math.max(0, Math.floor(centre / hopSeconds)));
    frameWeight[j] += 1;

    // Chroma with log compression to limit the influence of loud partials.
    for (let k = 1; k < binCount; k++) {
      const pc = binPitch[k];
      if (pc < 0) continue;
      chroma[j * 12 + pc] += Math.log1p(mag[k] * 20);
    }
    // Mel energy for MFCC.
    for (let b = 0; b < options.melBands; b++) {
      const w = mel.weights[b];
      let acc = 0;
      for (let k = 0; k < binCount; k++) {
        if (w[k] > 0) acc += mag[k] * mag[k] * w[k];
      }
      melAcc[j * options.melBands + b] += acc;
    }
    // Time-domain loudness over the same window.
    let sumSq = 0;
    for (let i = 0; i < fftSize; i++) {
      const s = mono[start + i];
      sumSq += s * s;
    }
    loudnessAcc[j] += 10 * Math.log10(sumSq / fftSize + 1e-12);
    loudnessCount[j] += 1;
  }

  for (let j = 0; j < frameCount; j++) {
    l2NormaliseInPlace(chroma, j * 12, 12);
    const w = Math.max(1, frameWeight[j]);
    const melVec = new Float32Array(options.melBands);
    for (let b = 0; b < options.melBands; b++) {
      melVec[b] = Math.log(melAcc[j * options.melBands + b] / w + 1e-10);
    }
    const coeff = dct2(melVec, options.mfccBands + 1);
    for (let c = 1; c <= options.mfccBands; c++) mfcc[j * options.mfccBands + c - 1] = coeff[c];
    loudnessDb[j] = loudnessCount[j] > 0 ? loudnessAcc[j] / loudnessCount[j] : -120;
  }

  // Standardise each MFCC coefficient over time (removes channel/gain colouring).
  const mfccStd = new Float32Array(options.mfccBands);
  for (let c = 0; c < options.mfccBands; c++) {
    let mean = 0;
    for (let j = 0; j < frameCount; j++) mean += mfcc[j * options.mfccBands + c];
    mean /= frameCount;
    let variance = 0;
    for (let j = 0; j < frameCount; j++) {
      const d = mfcc[j * options.mfccBands + c] - mean;
      variance += d * d;
    }
    mfccStd[c] = Math.sqrt(variance / frameCount) || 1;
    for (let j = 0; j < frameCount; j++) {
      mfcc[j * options.mfccBands + c] = (mfcc[j * options.mfccBands + c] - mean) / mfccStd[c];
    }
  }

  // Onset envelope aggregated by maximum, so short transients remain visible.
  const onsetFine = onsetEnvelope(mono, sampleRate);
  const onset = new Float32Array(frameCount);
  const fineOnsetHop = onsetFine.hop / sampleRate;
  for (let i = 0; i < onsetFine.envelope.length; i++) {
    const t = (i + 0.5) * fineOnsetHop;
    const j = Math.min(frameCount - 1, Math.max(0, Math.floor(t / hopSeconds)));
    if (onsetFine.envelope[i] > onset[j]) onset[j] = onsetFine.envelope[i];
  }

  return {
    times,
    chroma,
    mfcc,
    loudnessDb,
    onset,
    timing,
    tuningOffsetSemitones: tuning
  };
}

export function resampleIfNeeded(
  mono: Float32Array,
  inputRate: number,
  targetRate: number
): { signal: Float32Array; rate: number } {
  if (inputRate === targetRate) return { signal: mono, rate: targetRate };
  return { signal: resampleSinc(mono, inputRate, targetRate), rate: targetRate };
}
