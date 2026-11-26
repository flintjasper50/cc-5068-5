import { FFT, hannWindow, nextPow2 } from "./fft";

export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate <= 0 || toRate <= 0) throw new Error("invalid sample rate");
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/**
 * Band-limited resampling: zero-stuff/linear interpolation followed by a
 * windowed-sinc low-pass at the target Nyquist frequency.
 */
export function resampleSinc(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const cutoff = Math.min(1, ratio) * 0.95;
  const half = 16;
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    let acc = 0;
    let norm = 0;
    for (let k = -half + 1; k <= half; k++) {
      const idx = i0 + k;
      if (idx < 0 || idx >= input.length) continue;
      const x = src - idx;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (half + 0.5));
      const weight = sinc * w;
      acc += input[idx] * weight;
      norm += weight;
    }
    out[i] = norm > 1e-9 ? acc / norm : 0;
  }
  return out;
}

/** Simple 2nd-order Butterworth-style low-pass via RBJ biquad, applied forward-backward. */
export function lowpass(input: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const fc = Math.min(cutoffHz, sampleRate * 0.49);
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const cosW = Math.cos(w0);
  const b0 = (1 - cosW) / 2;
  const b1 = 1 - cosW;
  const b2 = (1 - cosW) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW;
  const a2 = 1 - alpha;
  const forward = biquad(input, b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  const backward = biquad(reverse(forward), b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  return reverse(backward);
}

function biquad(
  x: Float32Array,
  b0: number,
  b1: number,
  b2: number,
  a1: number,
  a2: number
): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const v = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    y[i] = v;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = v;
  }
  return y;
}

function reverse(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[x.length - 1 - i];
  return y;
}

/** Remove the per-signal mean/energy bias of an onset envelope. */
export function normaliseEnvelope(x: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= Math.max(1, x.length);
  const out = new Float32Array(x.length);
  let energy = 0;
  for (let i = 0; i < x.length; i++) {
    out[i] = x[i] - mean;
    energy += out[i] * out[i];
  }
  const rms = Math.sqrt(energy / Math.max(1, x.length)) || 1;
  for (let i = 0; i < x.length; i++) out[i] /= rms;
  return out;
}

/** Exponentially decaying positive-difference onset envelope. */
export function onsetEnvelope(signal: Float32Array, sampleRate: number): { envelope: Float32Array; hop: number } {
  const hop = 256;
  const fftSize = nextPow2(Math.round(sampleRate * 0.046));
  const win = hannWindow(fftSize);
  const fft = new FFT(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const frames = Math.max(0, Math.floor((signal.length - fftSize) / hop) + 1);
  const prev = new Float32Array(fftSize / 2 + 1);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = signal[start + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    let flux = 0;
    for (let k = 0; k < re.length / 2; k++) {
      const mag = Math.log1p(1000 * Math.hypot(re[k], im[k]));
      const d = mag - prev[k];
      if (d > 0) flux += d;
      prev[k] = mag;
    }
    env[f] = flux;
  }
  return { envelope: normaliseEnvelope(env), hop };
}
