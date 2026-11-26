import { describe, it, expect } from "vitest";
import { encodeWav, decodeWav, downmixToMono } from "../src/engine/wav";

describe("WAV codec", () => {
  it("round-trips pcm16 stereo", () => {
    const n = 1000;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
      r[i] = Math.cos((2 * Math.PI * 220 * i) / 44100) * 0.25;
    }
    const buf = encodeWav([l, r], 44100);
    const got = decodeWav(buf);
    expect(got.sampleRate).toBe(44100);
    expect(got.channels.length).toBe(2);
    expect(got.channels[0].length).toBe(n);
    for (let i = 0; i < n; i += 37) {
      expect(got.channels[0][i]).toBeCloseTo(l[i], 3);
      expect(got.channels[1][i]).toBeCloseTo(r[i], 3);
    }
  });

  it("round-trips float32 mono", () => {
    const n = 513;
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = Math.sin(i * 0.01) * 0.9;
    const got = decodeWav(encodeWav([m], 22050, "float32"));
    expect(got.sampleRate).toBe(22050);
    for (let i = 0; i < n; i += 11) expect(got.channels[0][i]).toBeCloseTo(m[i], 6);
  });

  it("rejects garbage", () => {
    expect(() => decodeWav(new ArrayBuffer(16))).toThrow();
  });

  it("downmix averages channels", () => {
    const m = downmixToMono([new Float32Array([1, 1]), new Float32Array([0, 0.5])]);
    expect(Array.from(m)).toEqual([0.5, 0.75]);
  });
});
