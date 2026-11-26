import { FFT, hannWindow } from "./fft";

export interface StftOptions {
  fftSize: number;
  hopSize: number;
  sampleRate: number;
}

export interface Spectrogram {
  /** Magnitude frames, each of length fftSize/2+1. */
  frames: Float32Array[];
  fftSize: number;
  hopSize: number;
  sampleRate: number;
  /** Centre time of each frame in seconds. */
  times: Float64Array;
}

/** Short-time Fourier transform with a periodic Hann window, no padding beyond edges. */
export function stft(signal: Float32Array, opts: StftOptions): Spectrogram {
  const { fftSize, hopSize, sampleRate } = opts;
  if (hopSize < 1) throw new Error("hopSize must be >= 1");
  if (fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) throw new Error("fftSize must be a power of two");
  const n = signal.length;
  const frameCount = n < fftSize ? 0 : Math.floor((n - fftSize) / hopSize) + 1;
  const binCount = fftSize / 2 + 1;
  const win = hannWindow(fftSize);
  const fft = new FFT(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const frames: Float32Array[] = [];
  const times = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const start = f * hopSize;
    for (let i = 0; i < fftSize; i++) {
      re[i] = signal[start + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    const mag = new Float32Array(binCount);
    for (let k = 0; k < binCount; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
    }
    frames.push(mag);
    times[f] = (start + fftSize / 2) / sampleRate;
  }
  return { frames, fftSize, hopSize, sampleRate, times };
}

/** Mel filterbank with `bands` triangular filters spanning [fmin, fmax]. */
export function melFilterbank(
  bands: number,
  fftSize: number,
  sampleRate: number,
  fmin = 30,
  fmax = sampleRate / 2
): { weights: Float32Array[]; centres: Float64Array } {
  const toMel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const fromMel = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const melLo = toMel(fmin);
  const melHi = toMel(Math.min(fmax, sampleRate / 2));
  const points = new Float64Array(bands + 2);
  for (let i = 0; i < points.length; i++) {
    points[i] = fromMel(melLo + ((melHi - melLo) * i) / (bands + 1));
  }
  const binCount = fftSize / 2 + 1;
  const binHz = sampleRate / fftSize;
  const weights: Float32Array[] = [];
  const centres = new Float64Array(bands);
  for (let b = 0; b < bands; b++) {
    const lo = points[b];
    const mid = points[b + 1];
    const hi = points[b + 2];
    centres[b] = mid;
    const w = new Float32Array(binCount);
    for (let k = 0; k < binCount; k++) {
      const f = k * binHz;
      if (f >= lo && f <= mid) w[k] = (f - lo) / Math.max(mid - lo, 1e-9);
      else if (f > mid && f <= hi) w[k] = (hi - f) / Math.max(hi - mid, 1e-9);
    }
    weights.push(w);
  }
  return { weights, centres };
}

/** DCT-II (orthonormal) over the first `count` coefficients. */
export function dct2(input: Float32Array, count: number): Float32Array {
  const n = input.length;
  const out = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += input[i] * Math.cos((Math.PI * k * (i + 0.5)) / n);
    }
    const scale = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
    out[k] = sum * scale;
  }
  return out;
}
