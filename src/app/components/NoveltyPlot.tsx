import { useEffect, useRef } from "react";
import type { AnalysisResult } from "../../engine/types";
import { fmtTime } from "../lib/format";

interface Props {
  result: AnalysisResult;
  playhead: number;
  onSeek: (time: number) => void;
}

const W = 720;
const H = 170;
const PAD = { left: 30, right: 10, top: 12, bottom: 22 };

/** Decision curves and support values are plotted, not regenerated for show. */
export function NoveltyPlot({ result, playhead, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const xOf = (t: number) => PAD.left + (t / result.duration) * plotW;

    // Bar contrast curves are the quantity that decides boundaries.
    const series: { values: Float32Array; times: Float64Array; colour: string }[] = [
      { values: result.novelty.barHarmonicContrast, times: result.novelty.barTimes, colour: "#7fb0ff" },
      { values: result.novelty.barTimbreContrast, times: result.novelty.barTimes, colour: "#f6a35c" }
    ];
    let maxV = 0.0001;
    for (const s of series) for (const v of s.values) maxV = Math.max(maxV, Math.abs(v));
    const yOf = (v: number) => PAD.top + plotH - (v / maxV) * plotH;

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.moveTo(PAD.left, PAD.top + plotH);
    ctx.lineTo(W - PAD.right, PAD.top + plotH);
    ctx.stroke();

    for (const s of series) {
      ctx.strokeStyle = s.colour;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < s.values.length; i++) {
        const x = xOf(s.times[i]);
        const y = yOf(Math.max(0, s.values[i]));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Boundary ticks.
    for (const b of result.boundaries) {
      const x = xOf(b.cueTime);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(b.id, x + 2, PAD.top + 10);
    }

    // Playhead.
    const px = xOf(playhead);
    ctx.strokeStyle = "#6bd39a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, PAD.top);
    ctx.lineTo(px, PAD.top + plotH);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("0:00", PAD.left, H - 6);
    ctx.fillText(fmtTime(result.duration), W - PAD.right - 36, H - 6);
    ctx.fillText("harmonic", PAD.left + 4, PAD.top + 10);
    ctx.fillStyle = "#7fb0ff";
    ctx.fillRect(PAD.left + 4, PAD.top + 14, 10, 3);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillText("timbre", PAD.left + 74, PAD.top + 10);
    ctx.fillStyle = "#f6a35c";
    ctx.fillRect(PAD.left + 74, PAD.top + 14, 10, 3);
  }, [result, playhead]);

  return (
    <canvas
      ref={canvasRef}
      className="novelty-canvas"
      style={{ width: W, height: H }}
      data-testid="novelty-canvas"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const t = ((e.clientX - rect.left - PAD.left) / (W - PAD.left - PAD.right)) * result.duration;
        onSeek(Math.max(0, Math.min(result.duration, t)));
      }}
    />
  );
}
