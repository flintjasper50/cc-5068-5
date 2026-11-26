import { useEffect, useRef } from "react";
import type { AnalysisResult } from "../../engine/types";
import { fmtTime, groupColour, ssmColour } from "../lib/format";

export type MatrixChannel = "combined" | "harmonic" | "timbre" | "tiHarmonic";

interface Props {
  result: AnalysisResult;
  channel: MatrixChannel;
  /** Selected cell in seconds, drawn as a marker. */
  selection: { start: number; end: number } | null;
  onPickCell: (start: number, end: number) => void;
}

const SIZE = 520;

/**
 * The matrix is drawn at frame resolution from the same SSM the boundary
 * detector consumed. Clicking a cell selects the span between the two frame
 * times, so what you hear is exactly the pair the similarity was computed for.
 */
export function SimilarityMatrix({ result, channel, selection, onPickCell }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const mat = result.ssm[channel];
    const n = result.ssm.n;
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      const row = Math.min(n - 1, Math.floor((y / SIZE) * n));
      for (let x = 0; x < SIZE; x++) {
        const col = Math.min(n - 1, Math.floor((x / SIZE) * n));
        const [r, g, b] = ssmColour(mat[row * n + col]);
        const idx = (y * SIZE + x) * 4;
        img.data[idx] = r;
        img.data[idx + 1] = g;
        img.data[idx + 2] = b;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const toPx = (t: number) => (t / result.duration) * SIZE;

    // Section bands along both axes, coloured by repetition family.
    ctx.lineWidth = 1;
    for (const section of result.sections) {
      const c = groupColour(section.group);
      ctx.strokeStyle = c;
      ctx.globalAlpha = 0.85;
      const x0 = toPx(section.start);
      const x1 = toPx(section.end);
      ctx.strokeRect(x0, 0, x1 - x0, SIZE);
      ctx.strokeRect(0, x0, SIZE, x1 - x0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = c;
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillText(section.label, x0 + 3, 13);
      ctx.save();
      ctx.translate(12, x0 + 3);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(section.label, 0, 0);
      ctx.restore();
    }

    // Boundary lines at their cue times, the positions the orchestrator uses.
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.setLineDash([4, 4]);
    for (const boundary of result.boundaries) {
      const p = toPx(boundary.cueTime);
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, SIZE);
      ctx.moveTo(0, p);
      ctx.lineTo(SIZE, p);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (selection) {
      const a = toPx(Math.min(selection.start, selection.end));
      const b = toPx(Math.max(selection.start, selection.end));
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(a, a, Math.max(2, b - a), Math.max(2, b - a));
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(a, a, Math.max(2, b - a), Math.max(2, b - a));
      ctx.globalAlpha = 1;
    }
  }, [result, channel, selection]);

  const frameAt = (offsetX: number, offsetY: number, rect: DOMRect) => {
    const x = ((offsetX - rect.left) / rect.width) * SIZE;
    const y = ((offsetY - rect.top) / rect.height) * SIZE;
    const n = result.ssm.n;
    const i = Math.min(n - 1, Math.max(0, Math.floor((y / SIZE) * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor((x / SIZE) * n)));
    return { timeY: result.ssm.times[i], timeX: result.ssm.times[j] };
  };

  return (
    <div className="matrix-wrap">
      <canvas
        ref={canvasRef}
        className="matrix-canvas"
        style={{ width: SIZE, height: SIZE }}
        data-testid="ssm-canvas"
        onPointerDown={(e) => {
          const { timeX } = frameAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
          dragStart.current = timeX;
          onPickCell(timeX, timeX);
        }}
        onPointerUp={(e) => {
          if (dragStart.current === null) return;
          const { timeX } = frameAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
          onPickCell(dragStart.current, timeX);
          dragStart.current = null;
        }}
      />
      <div className="matrix-axis">
        <span>0:00</span>
        <span>{fmtTime(result.duration / 2)}</span>
        <span>{fmtTime(result.duration)}</span>
      </div>
    </div>
  );
}
