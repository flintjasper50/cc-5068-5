import {
  AlignmentStep,
  Bar,
  CueReference,
  CueStatus,
  ResolvedCue,
  Section,
  SectionAlignment,
  TakeAlignment
} from "./types";
import { cosineSim, tiChromaSim } from "./sections";

export interface BarPairScore {
  ti: number;
  timbre: number;
  shift: number;
  sim: number;
}

export function barSimilarity(a: Bar, b: Bar): BarPairScore {
  const { sim: ti, shift } = tiChromaSim(a.features.chroma, b.features.chroma);
  const timbre = cosineSim(a.features.mfcc, b.features.mfcc);
  const sim = 0.65 * Math.max(0, ti) + 0.35 * Math.max(0, timbre);
  return { ti: Math.max(0, ti), timbre: Math.max(0, timbre), shift, sim };
}

/**
 * Dynamic time warping over bars with an explicit deletion penalty. A take that
 * drops a bar still aligns monotonically: the reference bar is recorded as
 * deleted (-1) and the bars after it keep their true correspondence.
 */
export function alignBarsGlobal(
  ref: Bar[],
  take: Bar[],
  deletionPenalty = 0.55
): { barMap: Int32Array; costPerRefBar: number; coverage: number; deleted: number[] } {
  const n = ref.length;
  const m = take.length;
  const barMap = new Int32Array(n).fill(-1);
  if (n === 0 || m === 0) {
    return { barMap, costPerRefBar: 1, coverage: 0, deleted: Array.from({ length: n }, (_, i) => i) };
  }
  const dp = new Float64Array((n + 1) * (m + 1));
  const back = new Uint8Array((n + 1) * (m + 1)); // 0 diagonal, 1 ref deleted, 2 take inserted
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) dp[at(i, 0)] = i * deletionPenalty;
  for (let j = 1; j <= m; j++) dp[at(0, j)] = j * deletionPenalty;

  const sims = new Float32Array(n * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) sims[i * m + j] = barSimilarity(ref[i], take[j]).sim;
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const substitution = dp[at(i - 1, j - 1)] + (1 - sims[(i - 1) * m + (j - 1)]);
      const deletion = dp[at(i - 1, j)] + deletionPenalty;
      const insertion = dp[at(i, j - 1)] + deletionPenalty;
      let best = substitution;
      let dir = 0;
      if (deletion < best) {
        best = deletion;
        dir = 1;
      }
      if (insertion < best) {
        best = insertion;
        dir = 2;
      }
      dp[at(i, j)] = best;
      back[at(i, j)] = dir;
    }
  }

  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i === 0) {
      j--;
      continue;
    }
    if (j === 0) {
      barMap[i - 1] = -1;
      i--;
      continue;
    }
    const dir = back[at(i, j)];
    if (dir === 0) {
      barMap[i - 1] = j - 1;
      i--;
      j--;
    } else if (dir === 1) {
      barMap[i - 1] = -1;
      i--;
    } else {
      j--;
    }
  }

  let costSum = 0;
  let matched = 0;
  const deleted: number[] = [];
  for (let k = 0; k < n; k++) {
    if (barMap[k] >= 0) {
      costSum += 1 - barSimilarity(ref[k], take[barMap[k]]).sim;
      matched++;
    } else {
      deleted.push(k);
      costSum += deletionPenalty;
    }
  }
  return {
    barMap,
    costPerRefBar: costSum / n,
    coverage: matched / n,
    deleted
  };
}

/**
 * Section-local alignment: choose one take offset for the whole section, then
 * run a monotonic DTW inside a band around that offset. The band tolerates a
 * reprise that moved in time or changed key (similarity is transposition-
 * invariant), while monotonicity means a bar removed from the take is recorded
 * as a deletion instead of being silently absorbed by mapping two reference
 * bars onto the same take bar. Without the monotone constraint a dropped bar
 * disappears from the bar map and downstream cue resolution cannot see it.
 */
export function alignBarsLocal(
  ref: Bar[],
  take: Bar[],
  window = 1
): { barMap: Int32Array; offset: number; costPerRefBar: number; coverage: number; shift: number } {
  const n = ref.length;
  const m = take.length;
  const barMap = new Int32Array(n).fill(-1);
  if (n === 0 || m === 0) return { barMap, offset: 0, costPerRefBar: 1, coverage: 0, shift: 0 };

  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let offset = -n + 1; offset < m; offset++) {
    let acc = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const j = i + offset;
      if (j < 0 || j >= m) continue;
      acc += barSimilarity(ref[i], take[j]).sim;
      count++;
    }
    if (count < Math.min(n, m) * 0.5) continue;
    const score = (acc / count) * Math.min(1, count / n);
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  // Take window the band covers, widened by `window` bars on each side.
  const bandLo = Math.max(0, bestOffset - window);
  const bandHi = Math.min(m, bestOffset + n + window);
  const takeSlice = take.slice(bandLo, bandHi);
  if (takeSlice.length === 0) return { barMap, offset: bestOffset, costPerRefBar: 1, coverage: 0, shift: 0 };

  const sub = alignBarsGlobal(ref, takeSlice, 0.55);
  let costSum = 0;
  let matched = 0;
  let shiftAcc = 0;
  for (let i = 0; i < n; i++) {
    const local = sub.barMap[i];
    if (local >= 0) {
      const j = bandLo + local;
      barMap[i] = j;
      const s = barSimilarity(ref[i], take[j]);
      costSum += 1 - s.sim;
      shiftAcc += s.shift;
      matched++;
    } else {
      costSum += 0.55;
    }
  }
  return {
    barMap,
    offset: bestOffset,
    costPerRefBar: costSum / n,
    coverage: matched / n,
    shift: matched ? Math.round(shiftAcc / matched) : 0
  };
}

export interface AlignOptions {
  deletionPenalty?: number;
  localMargin?: number;
}

/**
 * Align every section of the reference to a take. The global map over the whole
 * programme is computed once to keep sections non-overlapping; each section then
 * compares its global slice against a local offset search and records the trade-off.
 */
export function alignTakeToSections(
  referenceBars: Bar[],
  sections: Section[],
  takeBars: Bar[],
  takeDuration: number,
  options: AlignOptions = {}
): TakeAlignment {
  const deletionPenalty = options.deletionPenalty ?? 0.55;
  const localMargin = options.localMargin ?? 0.02;
  const global = alignBarsGlobal(referenceBars, takeBars, deletionPenalty);
  const sectionAlignments: SectionAlignment[] = [];
  const globalMap = new Int32Array(referenceBars.length).fill(-1);

  for (const section of sections) {
    const refStart = section.startBar;
    const refEnd = Math.min(section.endBar, referenceBars.length - 1);
    if (refEnd < refStart) continue;
    const refSlice = referenceBars.slice(refStart, refEnd + 1);

    let globalCost = 0;
    let globalMatched = 0;
    const globalSlice = new Int32Array(refSlice.length).fill(-1);
    for (let k = 0; k < refSlice.length; k++) {
      const mapped = global.barMap[refStart + k];
      globalSlice[k] = mapped;
      if (mapped >= 0) {
        globalCost += 1 - barSimilarity(refSlice[k], takeBars[mapped]).sim;
        globalMatched++;
      } else {
        globalCost += deletionPenalty;
      }
    }
    const globalCostPerBar = refSlice.length ? globalCost / refSlice.length : 1;
    const globalCoverage = refSlice.length ? globalMatched / refSlice.length : 0;

    // Local search is restricted to the take span the global map suggests, widened
    // to the section length, so it cannot latch onto a different occurrence.
    const mappedTake = Array.from(globalSlice).filter((v) => v >= 0);
    const local = mappedTake.length
      ? (() => {
          const lo = Math.max(0, Math.min(...mappedTake) - Math.ceil(refSlice.length * 0.25));
          const hi = Math.min(takeBars.length, Math.max(...mappedTake) + Math.ceil(refSlice.length * 0.25) + 2);
          const sub = alignBarsLocal(refSlice, takeBars.slice(lo, hi));
          return {
            barMap: Int32Array.from(sub.barMap, (v) => (v >= 0 ? v + lo : -1)),
            costPerRefBar: sub.costPerRefBar,
            coverage: sub.coverage,
            shift: sub.shift
          };
        })()
      : alignBarsLocal(refSlice, takeBars);

    const useGlobal = globalCostPerBar <= local.costPerRefBar + localMargin && globalCoverage >= 0.5;
    const chosenMap = useGlobal ? globalSlice : local.barMap;
    const decisionNote = useGlobal
      ? `global alignment: ${(globalCoverage * 100).toFixed(0)}% of bars matched at ${globalCostPerBar.toFixed(3)} cost/bar; local alternative ${local.costPerRefBar.toFixed(3)}. Deletions stay citable as bar gaps.`
      : `local similarity: ${local.costPerRefBar.toFixed(3)} cost/bar beats global ${globalCostPerBar.toFixed(3)} (coverage ${(globalCoverage * 100).toFixed(0)}%); section is referenced by a stable offset instead of a warp.`;

    let shiftAcc = 0;
    let shiftCount = 0;
    const unmatched: number[] = [];
    const steps: AlignmentStep[] = [];
    for (let k = 0; k < refSlice.length; k++) {
      const takeBar = chosenMap[k];
      const refBar = refStart + k;
      const s = takeBar >= 0 ? barSimilarity(refSlice[k], takeBars[takeBar]) : null;
      if (takeBar >= 0) {
        globalMap[refBar] = takeBar;
        shiftAcc += s!.shift;
        shiftCount++;
      } else {
        unmatched.push(refBar);
      }
      steps.push({
        refBar,
        takeBar: takeBar >= 0 ? takeBar : null,
        cost: s ? 1 - s.sim : 1,
        tiSimilarity: s ? s.ti : 0,
        timbreSimilarity: s ? s.timbre : 0,
        shiftSemitones: s ? s.shift : 0
      });
    }

    const mappedBars = steps.filter((s) => s.takeBar !== null).map((s) => s.takeBar as number);
    sectionAlignments.push({
      sectionId: section.id,
      sectionIndex: section.index,
      referenceBarStart: refStart,
      referenceBarEnd: refEnd,
      steps,
      localScore: 1 - local.costPerRefBar,
      globalScore: 1 - globalCostPerBar,
      localCostPerBar: local.costPerRefBar,
      globalCostPerBar,
      coverage: useGlobal ? globalCoverage : local.coverage,
      unmatchedReferenceBars: unmatched,
      dominantTransposition: shiftCount ? Math.round(shiftAcc / shiftCount) : 0,
      takeStartBar: mappedBars.length ? Math.min(...mappedBars) : null,
      takeEndBar: mappedBars.length ? Math.max(...mappedBars) : null,
      decision: useGlobal ? "global" : "local",
      decisionNote
    });
  }

  const deleted = Array.from(globalMap)
    .map((v, i) => (v < 0 ? i : -1))
    .filter((v) => v >= 0);
  let scoreSum = 0;
  let scoreCount = 0;
  let mappedCount = 0;
  for (const a of sectionAlignments) {
    scoreSum += a.globalScore;
    scoreCount++;
    mappedCount += a.steps.filter((s) => s.takeBar !== null).length;
  }
  return {
    takeDuration,
    takeBarCount: takeBars.length,
    sections: sectionAlignments,
    barMap: globalMap,
    deletedReferenceBars: deleted,
    score: scoreCount ? scoreSum / scoreCount : 0
  };
}

export interface CueAnchorCount {
  anchorsPerSection: number;
}

/** Create citable references anchored to specific bars of the reference. */
export function createCueReferences(
  sections: Section[],
  referenceBars: Bar[],
  anchorsPerSection: number,
  referenceDuration: number
): CueReference[] {
  const cues: CueReference[] = [];
  for (const section of sections) {
    const firstBar = section.startBar;
    const lastBar = Math.min(section.endBar, referenceBars.length - 1);
    const barCount = lastBar - firstBar + 1;
    if (barCount <= 0) continue;
    const offsets = new Set<number>();
    const anchors = Math.max(1, anchorsPerSection);
    if (barCount <= anchors) {
      for (let k = 0; k < barCount; k++) offsets.add(k);
    } else {
      for (let a = 0; a < anchors; a++) {
        offsets.add(Math.round((a * (barCount - 1)) / Math.max(1, anchors - 1)));
      }
    }
    for (const offset of Array.from(offsets).sort((a, b) => a - b)) {
      const bar = referenceBars[firstBar + offset];
      if (!bar) continue;
      cues.push({
        id: `${section.id}-b${offset + 1}`,
        label: `${section.label} bar ${offset + 1}`,
        sectionIndex: section.index,
        sectionLabel: section.label,
        barOffset: offset,
        fingerprintChroma: Array.from(bar.features.chroma),
        fingerprintMfcc: Array.from(bar.features.mfcc),
        sourceStart: bar.start,
        sourceCueTime: Math.min(referenceDuration, bar.start)
      });
    }
  }
  return cues;
}

/**
 * Resolve references against a take. A cue holds while its mapped bar survives;
 * if the exact bar was cut it retargets to the nearest surviving bar of the same
 * section; if the section vanished entirely it falls back to the last valid cue
 * rather than inventing a position.
 */
export function resolveCues(
  cues: CueReference[],
  sections: Section[],
  alignment: TakeAlignment,
  takeBars: Bar[]
): ResolvedCue[] {
  const sectionById = new Map<number, SectionAlignment>();
  for (const a of alignment.sections) sectionById.set(a.sectionIndex, a);
  const resolved: ResolvedCue[] = [];
  let lastValid: ResolvedCue | null = null;

  for (const cue of cues) {
    const secAlign = sectionById.get(cue.sectionIndex);
    const section = sections[cue.sectionIndex];
    if (!secAlign || !section) {
      const r: ResolvedCue = {
        cue,
        status: "invalid",
        sourceBar: null,
        takeBar: null,
        takeTime: null,
        note: "section has no alignment against this take"
      };
      if (lastValid) {
        r.status = "fallback";
        r.takeBar = lastValid.takeBar;
        r.takeTime = lastValid.takeTime;
        r.fallbackOf = lastValid.cue.id;
        r.note = `section ${section?.label ?? "?"} not found; falls back to ${lastValid.cue.id}`;
      }
      resolved.push(r);
      continue;
    }
    const sourceBar = section.startBar + cue.barOffset;
    const takeBar = alignment.barMap[sourceBar] ?? -1;
    if (takeBar >= 0 && takeBars[takeBar]) {
      const r: ResolvedCue = {
        cue,
        status: "valid",
        sourceBar,
        takeBar,
        takeTime: takeBars[takeBar].start,
        note: `${section.label} bar ${cue.barOffset + 1} → take bar ${takeBar + 1}`
      };
      resolved.push(r);
      lastValid = r;
      continue;
    }

    // Prefer the nearest surviving bar within the same section.
    const candidates: { refBar: number; takeBar: number }[] = [];
    for (let k = secAlign.referenceBarStart; k <= secAlign.referenceBarEnd; k++) {
      const v = alignment.barMap[k];
      if (v >= 0) candidates.push({ refBar: k, takeBar: v });
    }
    if (candidates.length > 0) {
      candidates.sort(
        (a, b) => Math.abs(a.refBar - sourceBar) - Math.abs(b.refBar - sourceBar)
      );
      const nearest = candidates[0];
      const dist = Math.abs(nearest.refBar - sourceBar);
      const r: ResolvedCue = {
        cue,
        status: "retargeted",
        sourceBar,
        takeBar: nearest.takeBar,
        takeTime: takeBars[nearest.takeBar].start,
        note: `bar was cut from the take; retargeted to nearest surviving bar (${dist} bar${dist === 1 ? "" : "s"} away)`
      };
      resolved.push(r);
      lastValid = r;
      continue;
    }

    const r: ResolvedCue = {
      cue,
      status: "invalid",
      sourceBar,
      takeBar: null,
      takeTime: null,
      note: "no bar from this section survived in the take"
    };
    if (lastValid) {
      r.status = "fallback";
      r.takeBar = lastValid.takeBar;
      r.takeTime = lastValid.takeTime;
      r.fallbackOf = lastValid.cue.id;
      r.note = `section vanished from the take; jump point falls back to last valid cue ${lastValid.cue.id}`;
    }
    resolved.push(r);
  }
  return resolved;
}

export function describeCueStatus(status: CueStatus): string {
  switch (status) {
    case "valid":
      return "valid";
    case "retargeted":
      return "retargeted (bar removed)";
    case "fallback":
      return "fallback (section missing)";
    default:
      return "invalid";
  }
}
