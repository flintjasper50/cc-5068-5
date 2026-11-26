import { useCallback, useEffect, useRef, useState } from "react";

export interface PlaybackState {
  playing: boolean;
  position: number;
  duration: number;
  /** Label of what is currently sounding, surfaced in the UI. */
  current: string;
}

function makeBufferSource(
  ctx: AudioContext,
  buffer: AudioBuffer,
  duration: number
): { source: AudioBufferSourceNode; gain: GainNode } {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = 1;
  source.connect(gain).connect(ctx.destination);
  void duration;
  return { source, gain };
}

/**
 * Plays the decoded programme and supports jumping to an absolute time and
 * stopping after a span. Playback is driven by the AudioContext clock, which
 * is the same clock the analysis output is expressed in, so cue jumps land
 * where the analysis says they do.
 */
export function useAudioPlayer() {
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const stopAtRef = useRef<number | null>(null);
  const [state, setState] = useState<PlaybackState>({ playing: false, position: 0, duration: 0, current: "" });

  const ensureContext = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const stop = useCallback(() => {
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        /* already stopped */
      }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    offsetRef.current = 0;
    stopAtRef.current = null;
    setState((s) => ({ ...s, playing: false, position: 0 }));
  }, []);

  const load = useCallback((buffer: AudioBuffer) => {
    stop();
    bufferRef.current = buffer;
    setState((s) => ({ ...s, duration: buffer.duration, position: 0, playing: false }));
  }, [stop]);

  const play = useCallback(
    (from?: number, until?: number, label?: string) => {
      const buffer = bufferRef.current;
      if (!buffer) return;
      const ctx = ensureContext();
      if (sourceRef.current) {
        try {
          sourceRef.current.stop();
        } catch {
          /* noop */
        }
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
      const start = Math.max(0, Math.min(buffer.duration - 0.02, from ?? offsetRef.current));
      const { source } = makeBufferSource(ctx, buffer, buffer.duration);
      sourceRef.current = source;
      startedAtRef.current = ctx.currentTime;
      offsetRef.current = start;
      stopAtRef.current = until ?? null;
      source.start(0, start);
      source.onended = () => {
        sourceRef.current = null;
        setState((s) => (s.playing ? { ...s, playing: false, position: stopAtRef.current ?? s.position } : s));
        stopAtRef.current = null;
      };
      setState((s) => ({ ...s, playing: true, current: label ?? s.current, position: start }));
    },
    [ensureContext]
  );

  // Poll the audio clock for the playhead and enforce the optional stop point.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const ctx = ctxRef.current;
      if (ctx && sourceRef.current) {
        const pos = offsetRef.current + (ctx.currentTime - startedAtRef.current);
        if (stopAtRef.current !== null && pos >= stopAtRef.current) {
          sourceRef.current.stop();
          sourceRef.current.disconnect();
          sourceRef.current = null;
          setState((s) => ({ ...s, playing: false, position: stopAtRef.current as number }));
          stopAtRef.current = null;
        } else {
          setState((s) => ({ ...s, position: pos }));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return { state, load, play, stop };
}
