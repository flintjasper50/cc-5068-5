import {
  AnalysisOptions,
  Bar,
  Boundary,
  Group,
  Section,
  SectionMatch,
  SsmData
} from "./types";
import { barAtTime } from "./bars";

const EPS = 1e-9;

/** Transposition-invariant cosine similarity between two chroma vectors. */
export function tiChromaSim(a: Float32Array, b: Float32Array): { sim: number; shift: number } {
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 12; i++) {
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  na = Math.sqrt(na) || 1;
  nb = Math.sqrt(nb) || 1;
  let best = -Infinity;
  let bestShift = 0;
  for (let shift = 0; shift < 12; shift++) {
    let acc = 0;
    for (let k = 0; k < 12; k++) acc += a[k] * b[(k + shift) % 12];
    const s = acc / (na * nb);
    if (s > best) {
      best = s;
      bestShift = shift;
    }
  }
  return { sim: best, shift: bestShift > 6 ? bestShift - 12 : bestShift };
}

export function plainChromaSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 12; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

function meanChroma(bars: Bar[], from: number, to: number): Float32Array {
  const out = new Float32Array(12);
  let count = 0;
  for (let i = Math.max(0, from); i < Math.min(bars.length, to); i++) {
    for (let k = 0; k < 12; k++) out[k] += bars[i].features.chroma[k];
    count++;
  }
  if (count > 0) for (let k = 0; k < 12; k++) out[k] /= count;
  normalise(out);
  return out;
}

function meanMfcc(bars: Bar[]): Float32Array {
  const dim = bars.length ? bars[0].features.mfcc.length : 12;
  const out = new Float32Array(dim);
  let count = 0;
  for (const b of bars) {
    for (let k = 0; k < dim; k++) out[k] += b.features.mfcc[k];
    count++;
  }
  if (count > 0) for (let k = 0; k < dim; k++) out[k] /= count;
  normalise(out);
  return out;
}

function normalise(v: Float32Array): void {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > EPS) for (let i = 0; i < v.length; i++) v[i] /= n;
}

/**
 * Local (diagonal-window) similarity between two bar sequences: for each bar in
 * the query, take the best matching bar in a small window around the expected
 * position. Sensitive to repeated phrases even when one is shortened or shifted,
 * but it does not require a global warp.
 */
export function localBarSimilarity(
  barsA: Bar[],
  barsB: Bar[],
  window = 2
): { score: number; coverage: number; endingScore: number } {
  if (barsA.length === 0 || barsB.length === 0) {
    return { score: 0, coverage: 0, endingScore: 0 };
  }
  const ratio = barsA.length / barsB.length;
  let acc = 0;
  for (let i = 0; i < barsA.length; i++) {
    const expected = i / ratio;
    const lo = Math.max(0, Math.floor(expected - window));
    const hi = Math.min(barsB.length - 1, Math.ceil(expected + window));
    let best = 0;
    for (let j = lo; j <= hi; j++) {
      const { sim } = tiChromaSim(barsA[i].features.chroma, barsB[j].features.chroma);
      if (sim > best) best = sim;
    }
    acc += best;
  }
  const score = acc / barsA.length;
  const endBars = Math.max(1, Math.round(Math.min(barsA.length, barsB.length) * 0.25));
  const aEnd = meanChroma(barsA, barsA.length - endBars, barsA.length);
  const bEnd = meanChroma(barsB, barsB.length - endBars, barsB.length);
  const endingScore = tiChromaSim(aEnd, bEnd).sim;
  return { score, coverage: 1, endingScore };
}

function meanOf(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function stdOf(v: number[], mean = meanOf(v)): number {
  if (!v.length) return 0;
  return Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / v.length);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Remove the mean so that a shared key's DC component cannot masquerade as a theme. */
function centred(v: Float32Array): Float32Array {
  let m = 0;
  for (let i = 0; i < v.length; i++) m += v[i];
  m /= v.length || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] - m;
  return out;
}

function buildMatches(sections: Section[], bars: Bar[]): void {
  for (const s of sections) {
    const ownBars = bars.slice(s.startBar, s.endBar + 1);
    const matches: SectionMatch[] = [];
    for (const other of sections) {
      if (other.id === s.id) continue;
      const otherBars = bars.slice(other.startBar, other.endBar + 1);
      const local = localBarSimilarity(ownBars, otherBars);
      const { sim: tiSim, shift } = tiChromaSim(s.centroidChroma, other.centroidChroma);
      const timbreSim = cosineSim(s.centroidMfcc, other.centroidMfcc);
      const themeChromaSimilarity = tiChromaSim(
        centred(s.centroidChroma),
        centred(other.centroidChroma)
      ).sim;
      matches.push({
        otherId: other.id,
        harmonicSimilarity: plainChromaSim(s.centroidChroma, other.centroidChroma),
        tiHarmonicSimilarity: tiSim,
        timbreSimilarity: timbreSim,
        transpositionSemitones: shift,
        themeChromaSimilarity,
        themeScore: 0.5 * timbreSim + 0.5 * themeChromaSimilarity,
        localScore: local.score,
        endingScore: local.endingScore
      });
    }
    matches.sort((a, b) => {
      const ea = 0.5 * a.timbreSimilarity + 0.5 * a.localScore;
      const eb = 0.5 * b.timbreSimilarity + 0.5 * b.localScore;
      return eb - ea;
    });
    s.matches = matches;
  }
}

export function buildSections(
  boundaries: Boundary[],
  bars: Bar[],
  ssm: SsmData,
  duration: number,
  options: AnalysisOptions
): { sections: Section[]; groups: Group[]; notes: string[] } {
  const notes: string[] = [];
  const edges: { time: number; cue: number }[] = [{ time: 0, cue: 0 }];
  for (const b of boundaries) edges.push({ time: b.time, cue: b.cueTime });
  edges.push({ time: duration, cue: duration });

  interface RawSection { start: number; end: number; cueStart: number; cueEnd: number }
  const raw: RawSection[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i].time;
    const end = edges[i + 1].time;
    if (end - start < options.minSectionSeconds) {
      // Merge too-short segment into the adjacent one (prefer the longer side).
      if (raw.length > 0) {
        raw[raw.length - 1].end = end;
        raw[raw.length - 1].cueEnd = edges[i + 1].cue;
      }
      continue;
    }
    raw.push({ start, end, cueStart: edges[i].cue, cueEnd: edges[i + 1].cue });
  }
  if (raw.length === 0 && duration > 0) raw.push({ start: 0, end: duration, cueStart: 0, cueEnd: duration });

  const sections: Section[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const startBar = Math.max(0, barAtTime(bars, r.start));
    const endBar = Math.max(startBar, barAtTime(bars, Math.max(r.start, r.end - 1e-6)));
    const ownBars = bars.slice(startBar, endBar + 1);
    const centroidChroma = meanChroma(bars, startBar, endBar + 1);
    const centroidMfcc = meanMfcc(ownBars);

    // Consistency: mean similarity of each bar to the section centroid.
    let hAcc = 0;
    let tAcc = 0;
    for (const bar of ownBars) {
      hAcc += tiChromaSim(bar.features.chroma, centroidChroma).sim;
      tAcc += cosineSim(bar.features.mfcc, centroidMfcc);
    }
    const harmonicConsistency = ownBars.length ? hAcc / ownBars.length : 0;
    const timbreConsistency = ownBars.length ? tAcc / ownBars.length : 0;

    // Section-level confidence from frame SSM consistency and section length.
    const from = Math.max(0, Math.floor(r.start / ssm.hopSeconds));
    const to = Math.min(ssm.n, Math.max(from + 1, Math.ceil(r.end / ssm.hopSeconds)));
    let frameAcc = 0;
    let frameCount = 0;
    for (let a = from; a < to; a += 2) {
      for (let b = a + 1; b < to; b += 2) {
        frameAcc += ssm.combined[a * ssm.n + b];
        frameCount++;
      }
    }
    const internalSim = frameCount ? frameAcc / frameCount : 0;
    const lengthFactor = Math.min(1, (r.end - r.start) / (options.minSectionSeconds * 2));
    const confidence = Math.max(
      0,
      Math.min(1, 0.5 * internalSim + 0.3 * harmonicConsistency + 0.2 * lengthFactor)
    );

    sections.push({
      id: `S${i + 1}`,
      index: i,
      start: r.start,
      end: r.end,
      cueStart: r.cueStart,
      cueEnd: r.cueEnd,
      startBar,
      endBar,
      label: `S${i + 1}`,
      group: "",
      groupConfidence: 0,
      confidence,
      duration: r.end - r.start,
      harmonicConsistency,
      timbreConsistency,
      centroidChroma,
      centroidMfcc,
      matches: [],
      notes: []
    });
  }

  buildMatches(sections, bars);

  // Repeated-section grouping.
  //
  // A family needs two independent kinds of evidence, because a single key
  // leaves harmony almost constant and re-orchestration moves timbre:
  //   1. melodic alignment — transposition-invariant bar similarity must be
  //      high, so the *same tune* is present (this survives key change);
  //   2. timbre — the two statements must be closer in timbre than the
  //      programme's own cross-section baseline, or orchestration alone is
  //      driving the match.
  // The timbre bar is adaptive (mean + one standard deviation of the pairwise
  // similarity the programme itself produced) with an absolute floor so that a
  // very homogeneous programme cannot make grouping trivial.
  //
  // Assignment is iterative mutual-best matching: a pair only becomes a family
  // when each section is the other's strongest remaining candidate. This is
  // what keeps a transposed reprise from being pulled into whichever section
  // happens to sit in its new register — if two sections compete for the same
  // partner, the weaker claim is not forced through.
  const pairOf = (a: Section, b: Section): SectionMatch | undefined =>
    a.matches.find((m) => m.otherId === b.id);

  const pairList: { i: number; j: number; m: SectionMatch }[] = [];
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const m = pairOf(sections[i], sections[j]);
      if (m) pairList.push({ i, j, m });
    }
  }

  const melodyThreshold = options.melodySimThreshold ?? 0.9;
  const localThreshold = options.localScoreThreshold ?? 0.85;
  const melodyAligned = (m: SectionMatch): boolean =>
    m.tiHarmonicSimilarity >= melodyThreshold && m.localScore >= localThreshold;

  const melodicPairs = pairList.filter((p) => melodyAligned(p.m));
  const timbreValues = melodicPairs.map((p) => p.m.timbreSimilarity);
  const timbreMean = meanOf(timbreValues);
  const timbreSd = stdOf(timbreValues, timbreMean);
  const timbreThreshold = Math.max(options.familyTimbreFloor ?? 0.18, timbreMean + timbreSd);

  const eligible = new Set<SectionMatch>(
    melodicPairs
      .filter((p) => p.m.timbreSimilarity >= timbreThreshold)
      .map((p) => p.m)
  );

  const assignment: number[] = new Array(sections.length).fill(-1);
  const groupsInternal: { label: string; members: number[] }[] = [];

  // Rank partners by combined evidence rather than timbre alone. Timbre is the
  // weak axis when a reprise is transposed into another section's register
  // (the chorus moved down onto the reed verse's octave here), so using it as
  // the tie-break can pick the wrong partner. Melodic alignment is the
  // reliable axis; timbre only has to clear its gate.
  const evidence = (m: SectionMatch): number =>
    0.4 * m.localScore + 0.3 * m.tiHarmonicSimilarity + 0.3 * m.timbreSimilarity;

  // Iterative mutual-best matching. On each pass, each unassigned section
  // names its best remaining eligible partner; only pairs that name each other
  // are committed, strongest first.
  for (;;) {
    const remaining = pairList.filter(
      (p) => eligible.has(p.m) && assignment[p.i] < 0 && assignment[p.j] < 0
    );
    if (remaining.length === 0) break;
    const bestFor = new Map<number, { i: number; j: number; m: SectionMatch }>();
    for (const p of remaining) {
      for (const [a, b] of [
        [p.i, p.j],
        [p.j, p.i]
      ] as const) {
        const cur = bestFor.get(a);
        if (!cur || evidence(p.m) > evidence(cur.m)) bestFor.set(a, p);
      }
    }
    const mutual = remaining
      .filter((p) => bestFor.get(p.i) === p && bestFor.get(p.j) === p)
      .sort((a, b) => evidence(b.m) - evidence(a.m));
    if (mutual.length === 0) break;
    const pick = mutual[0];
    const g = groupsInternal.length;
    groupsInternal.push({ label: "", members: [pick.i, pick.j] });
    assignment[pick.i] = g;
    assignment[pick.j] = g;
    // Grow the new family by complete linkage: an unassigned section joins
    // only if it is eligible against *every* current member, so a family never
    // becomes a chain of loosely related statements.
    let grew = true;
    while (grew) {
      grew = false;
      for (let k = 0; k < sections.length; k++) {
        if (assignment[k] >= 0) continue;
        const members = groupsInternal[g].members;
        const allEligible = members.every((mi) => {
          const m = pairOf(sections[mi], sections[k]);
          return !!m && eligible.has(m);
        });
        if (allEligible) {
          members.push(k);
          assignment[k] = g;
          grew = true;
        }
      }
    }
  }
  for (let i = 0; i < sections.length; i++) {
    if (assignment[i] < 0) {
      assignment[i] = groupsInternal.length;
      groupsInternal.push({ label: "", members: [i] });
    }
  }

  const groups: Group[] = [];
  for (let g = 0; g < groupsInternal.length; g++) {
    const label = String.fromCharCode(65 + (g % 26));
    groupsInternal[g].label = label;
    const memberSections = groupsInternal[g].members.map((i) => sections[i]);
    const centroidChroma = new Float32Array(12);
    const dim = memberSections[0]?.centroidMfcc.length ?? options.mfccBands;
    const centroidMfcc = new Float32Array(dim);
    for (const s of memberSections) {
      for (let k = 0; k < 12; k++) centroidChroma[k] += s.centroidChroma[k];
      for (let k = 0; k < dim; k++) centroidMfcc[k] += s.centroidMfcc[k];
    }
    normalise(centroidChroma);
    normalise(centroidMfcc);
    for (const s of memberSections) {
      s.group = label;
      if (memberSections.length === 1) {
        s.groupConfidence = 0;
      } else {
        const others = memberSections.filter((o) => o.id !== s.id);
        // Confidence = margin between the best in-family evidence and the best
        // out-of-family evidence. A family that only barely beat the nearest
        // outsider is reported as such rather than presented as a certainty.
        let ownAcc = 0;
        for (const o of others) {
          const m = pairOf(s, o);
          ownAcc += m ? evidence(m) : 0;
        }
        const own = ownAcc / others.length;
        let cross = 0;
        for (const o of sections) {
          if (memberSections.includes(o)) continue;
          const m = pairOf(s, o);
          if (!m) continue;
          cross = Math.max(cross, evidence(m));
        }
        s.groupConfidence = clamp01(0.5 + 1.5 * (own - cross));
      }
    }
    groups.push({
      label,
      sectionIds: memberSections.map((s) => s.id),
      centroidChroma,
      centroidMfcc
    });
  }

  // A section that stayed unique is reported with the exact reason, so the
  // grouping decision is traceable to the similarity numbers behind it.
  for (const s of sections) {
    const membersOfGroup = groups.find((g) => g.label === s.group);
    if (membersOfGroup && membersOfGroup.sectionIds.length > 1) continue;
    const candidates = s.matches.filter((m) => melodyAligned(m));
    if (candidates.length === 0) {
      s.notes.push(
        `No section shared enough of the melody (transposition-invariant bar similarity ≥ ${melodyThreshold.toFixed(2)}); reported as unique.`
      );
      continue;
    }
    const best = candidates.reduce(
      (a, b) => (b.timbreSimilarity > a.timbreSimilarity ? b : a),
      candidates[0]
    );
    if (best.timbreSimilarity < timbreThreshold) {
      s.notes.push(
        `Several sections align melodically, but the closest in timbre (${best.otherId}, ${(best.timbreSimilarity * 100).toFixed(0)}%) is below the family threshold ${(timbreThreshold * 100).toFixed(0)}%; reported as unique.`
      );
    } else {
      s.notes.push(
        `Close to ${best.otherId} in both melody and timbre, but that section was more strongly matched elsewhere; mutual-best matching left this one unique.`
      );
    }
  }

  // Ending-distinct note. Only meaningful inside a repetition family: an
  // altered close is where the body matches but the final bars do not. Compare
  // the ending against the pair's own body similarity rather than an absolute
  // cut, so a smeared chroma cannot trigger it on unrelated sections.
  for (const s of sections) {
    const group = groups.find((g) => g.label === s.group);
    if (!group || group.sectionIds.length < 2) continue;
    for (const m of s.matches) {
      if (!group.sectionIds.includes(m.otherId)) continue;
      if (m.otherId < s.id) continue; // report each pair once
      if (m.endingScore < m.localScore - 0.06) {
        s.notes.push(
          `Close to ${m.otherId} through the body but the closing bars differ (ending ${(m.endingScore * 100).toFixed(0)}% vs body ${(m.localScore * 100).toFixed(0)}%).`
        );
      }
    }
  }

  const repeated = groups.filter((g) => g.sectionIds.length > 1);
  if (sections.length > 1) {
    notes.push(
      `Grouping rule: transposition-invariant bar alignment ≥ ${Math.round(melodyThreshold * 100)}%, plus timbre similarity ≥ ${(timbreThreshold * 100).toFixed(0)}% (mean + 1σ of this programme's melodic-candidate pairs), assigned by mutual-best matching.`
    );
  }
  if (repeated.length > 0) {
    notes.push(
      `Repetition families: ${repeated.map((g) => `${g.label}=${g.sectionIds.join(",")}`).join("; ")}.`
    );
  } else {
    notes.push("No repetition family passed the bar-level similarity threshold; every section is unique here.");
  }
  return { sections, groups, notes };
}

/** Label assignment is descriptive only: letters denote repetition families, never song-function names. */
export function describeSections(sections: Section[]): string[] {
  return sections.map(
    (s) =>
      `${s.label} ${s.start.toFixed(1)}–${s.end.toFixed(1)}s bars ${s.startBar + 1}–${s.endBar + 1} family ${s.group || "-"}`
  );
}
