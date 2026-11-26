import { describe, it, expect } from "vitest";
import { FFT, nextPow2, hannWindow } from "../src/engine/fft";

describe("FFT", () => {
  it("round-trips a delta via forward/inverse", () => {
    const n = 64;
    const fft = new FFT(n);
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    re[0] = 1;
    fft.transform(re, im);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(1, 5);
      expect(im[i]).toBeCloseTo(0, 5);
    }
  });

  it("puts a pure cosine at the expected bin", () => {
    const n = 128;
    const fft = new FFT(n);
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const k = 9;
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k * i) / n);
    fft.transform(re, im);
    expect(Math.hypot(re[k], im[k]) / (n / 2)).toBeCloseTo(1, 4);
    expect(Math.hypot(re[k + 1], im[k + 1])).toBeLessThan(1e-3);
  });

  it("nextPow2 grows to power of two", () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(1000)).toBe(1024);
  });

  it("hann window tapers to boundaries", () => {
    const w = hannWindow(8);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[4]).toBeCloseTo(1, 6);
    expect(w[7]).toBeLessThan(w[6]);
    expect(w[1]).toBeGreaterThan(w[0]);
  });
});
