export interface AudioData {
  sampleRate: number;
  channels: Float32Array[];
  duration: number;
}

export function decodeWav(buffer: ArrayBuffer): AudioData {
  const view = new DataView(buffer);
  if (view.byteLength < 12) throw new Error("not a WAV file: too short");
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let fmt: {
    format: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    blockAlign: number;
  } | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= view.byteLength) {
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      fmt = { format, channels, sampleRate, bitsPerSample, blockAlign };
    } else if (id === "data") {
      dataOffset = body;
      dataSize = Math.min(size, view.byteLength - body);
    }
    offset = body + size + (size & 1);
  }
  if (!fmt) throw new Error("WAV missing fmt chunk");
  if (dataOffset < 0) throw new Error("WAV missing data chunk");
  if (fmt.channels < 1 || fmt.channels > 32) throw new Error("unsupported channel count");
  if (![1, 2, 3].includes(fmt.format) && fmt.format !== 0xfffe) {
    throw new Error(`unsupported WAV format tag ${fmt.format}`);
  }
  const bytes = fmt.bitsPerSample / 8;
  if (![1, 2, 3, 4, 8].includes(bytes)) {
    throw new Error(`unsupported WAV bit depth ${fmt.bitsPerSample}`);
  }
  const frameBytes = bytes * fmt.channels;
  const frames = Math.floor(dataSize / frameBytes);
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const at = dataOffset + i * frameBytes + c * bytes;
      let value: number;
      if (fmt.format === 3) {
        value = bytes === 4 ? view.getFloat32(at, true) : view.getFloat64(at, true);
      } else if (fmt.bitsPerSample === 8) {
        value = (view.getUint8(at) - 128) / 128;
      } else if (fmt.bitsPerSample === 16) {
        value = view.getInt16(at, true) / 32768;
      } else if (fmt.bitsPerSample === 24) {
        const b0 = view.getUint8(at);
        const b1 = view.getUint8(at + 1);
        const b2 = view.getUint8(at + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff;
        value = v / 8388608;
      } else {
        value = view.getInt32(at, true) / 2147483648;
      }
      channels[c][i] = value;
    }
  }
  return { sampleRate: fmt.sampleRate, channels, duration: frames / fmt.sampleRate };
}

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  format: "pcm16" | "float32" = "pcm16"
): ArrayBuffer {
  if (channels.length < 1) throw new Error("at least one channel required");
  const frames = channels[0].length;
  for (const ch of channels) {
    if (ch.length !== frames) throw new Error("channel lengths differ");
  }
  const bytesPerSample = format === "pcm16" ? 2 : 4;
  const blockAlign = bytesPerSample * channels.length;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format === "pcm16" ? 1 : 3, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels.length; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (format === "pcm16") {
        view.setInt16(at, Math.round(s * 32767), true);
        at += 2;
      } else {
        view.setFloat32(at, s, true);
        at += 4;
      }
    }
  }
  return buffer;
}

export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= scale;
  return out;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
