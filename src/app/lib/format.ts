export const GROUP_COLOURS = [
  "#4f9dff",
  "#ffb347",
  "#6bd39a",
  "#e06c75",
  "#b47cff",
  "#4fd1c5",
  "#d9a441",
  "#f07cb0"
];

export function groupColour(label: string): string {
  if (!label) return "#6b7280";
  const index = label.charCodeAt(0) - 65;
  return GROUP_COLOURS[((index % GROUP_COLOURS.length) + GROUP_COLOURS.length) % GROUP_COLOURS.length];
}

export function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Magma-like ramp for similarity, low = dark, high = warm. */
export function ssmColour(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  const stops: [number, [number, number, number]][] = [
    [0, [8, 10, 26]],
    [0.25, [46, 32, 84]],
    [0.5, [125, 50, 110]],
    [0.75, [219, 101, 74]],
    [1, [252, 220, 160]]
  ];
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const t = b === a ? 0 : (x - a) / (b - a);
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * t),
        Math.round(ca[1] + (cb[1] - ca[1]) * t),
        Math.round(ca[2] + (cb[2] - ca[2]) * t)
      ];
    }
  }
  return stops[stops.length - 1][1];
}
