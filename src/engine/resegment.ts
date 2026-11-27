/**
 * Pure "what-if" resegmentation kernel for the threshold workbench.
 *
 * The expensive feature/beat extraction is reused from a cached AnalysisResult;
 * only the threshold-sensitive stages (boundary detection and section
 * grouping) run again. Every control in the UI is driven by THRESHOLD_LIMITS
 * and every invalid edit is rejected here with a named error so the interface
 * can feed the failure back instead of silently clamping.
 */
import type {
  AnalysisResult,
  Boundary,
  Group,
  RejectedCandidate,
  Section
} from "./types";
import { detectBoundaries } from "./boundary";
import { buildSections } from "./sections";

export class StructureEditError extends Error {
  field: keyof ThresholdEdits | "form";
  constructor(field: keyof ThresholdEdits | "form", message: string) {
    super(message);
    this.name = "StructureEditError";
    this.field = field;
  }
}

export interface ThresholdEdits {
  /** Transposition-invariant melody gate for repetition families. */
  melodyThreshold?: number;
  /** Local bar-alignment gate for repetition families. */
  localThreshold?: number;
  /** Foote/local-z base threshold; candidate gate is this + 0.6. */
  boundaryThresholdZ?: number;
}

export interface ThresholdSpec {
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  label: string;
  help: string;
  testId: string;
}

export const THRESHOLD_LIMITS: Record<keyof Required<ThresholdEdits>, ThresholdSpec> = {
  melodyThreshold: {
    min: 0.5,
    max: 0.99,
    step: 0.01,
    defaultValue: 0.9,
    label: "Family melody similarity",
    help: "Transposition-invariant chroma + bar contour gate. Lower it to admit looser reprises.",
    testId: "melody-threshold"
  },
  localThreshold: {
    min: 0.5,
    max: 0.99,
    step: 0.01,
    defaultValue: 0.85,
    label: "Family bar alignment",
    help: "Local diagonal bar-similarity gate used with the melody threshold.",
    testId: "local-threshold"
  },
  boundaryThresholdZ: {
    min: 0.4,
    max: 2.2,
    step: 0.1,
    defaultValue: 1.0,
    label: "Boundary z threshold",
    help: "Base local-z gate; a bar peak must exceed this + 0.6 to become a candidate.",
    testId: "boundary-z-threshold"
  }
};

export function defaultEdits(): Required<ThresholdEdits> {
  return {
    melodyThreshold: THRESHOLD_LIMITS.melodyThreshold.defaultValue,
    localThreshold: THRESHOLD_LIMITS.localThreshold.defaultValue,
    boundaryThresholdZ: THRESHOLD_LIMITS.boundaryThresholdZ.defaultValue
  };
}

/** Validate a draft edit set; throws StructureEditError on the first bad field. */
export function validateEdits(edits: ThresholdEdits): Required<ThresholdEdits> {
  const out = defaultEdits();
  (Object.keys(THRESHOLD_LIMITS) as (keyof Required<ThresholdEdits>)[]).forEach((key) => {
    const raw = edits[key];
    if (raw === undefined || raw === null || raw === ("" as unknown)) return;
    const value = typeof raw === "string" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new StructureEditError(key, `${THRESHOLD_LIMITS[key].label} must be a number`);
    }
    const spec = THRESHOLD_LIMITS[key];
    if (value < spec.min || value > spec.max) {
      throw new StructureEditError(
        key,
        `${spec.label} must be between ${spec.min} and ${spec.max}, got ${value}`
      );
    }
    out[key] = value;
  });
  return out;
}

export interface StructureView {
  edits: Required<ThresholdEdits>;
  boundaries: Boundary[];
  rejected: RejectedCandidate[];
  sections: Section[];
  groups: Group[];
  notes: string[];
}

/** Re-run the threshold-sensitive structure stages on cached analysis data. */
export function resegmentStructure(
  result: AnalysisResult,
  draft: ThresholdEdits = {}
): StructureView {
  const edits = validateEdits(draft);
  const options = {
    ...result.options,
    melodySimThreshold: edits.melodyThreshold,
    localScoreThreshold: edits.localThreshold,
    boundaryThresholdZ: edits.boundaryThresholdZ
  };
  const detection = detectBoundaries(
    result.features,
    result.ssm,
    result.bars,
    result.beats,
    options
  );
  const built = buildSections(
    detection.boundaries,
    result.bars,
    result.ssm,
    result.duration,
    options
  );
  return {
    edits,
    boundaries: detection.boundaries,
    rejected: detection.rejected,
    sections: built.sections,
    groups: built.groups,
    notes: [...detection.notes, ...built.notes]
  };
}

export interface BoundaryDelta {
  time: number;
  kind: "added" | "removed" | "kept";
  nearestBefore?: number;
  errorSeconds?: number;
}

export interface StructureDiff {
  boundaryDeltas: BoundaryDelta[];
  addedBoundaries: number[];
  removedBoundaries: number[];
  beforeSectionCount: number;
  afterSectionCount: number;
  beforeFamilies: { label: string; members: string[] }[];
  afterFamilies: { label: string; members: string[] }[];
  familyChanges: string[];
  sectionRows: {
    id: string;
    start: number;
    end: number;
    group: string;
    changed: boolean;
    /** A baseline section occupies the same span; only then is a group delta meaningful. */
    sameSpan: boolean;
    groupChanged: boolean;
  }[];
}

/** Compare a baseline result with an edited view for the before/after panel. */
export function diffStructure(baseline: AnalysisResult, edited: StructureView): StructureDiff {
  const beforeTimes = baseline.boundaries.map((b) => b.cueTime);
  const afterTimes = edited.boundaries.map((b) => b.cueTime);
  const tol = Math.max(0.2, baseline.beats.barSeconds * 0.6);

  const boundaryDeltas: BoundaryDelta[] = [];
  const addedBoundaries: number[] = [];
  const removedBoundaries: number[] = [];
  const usedAfter = new Set<number>();
  for (const t of beforeTimes) {
    let best = -1;
    let bestErr = Infinity;
    afterTimes.forEach((u, i) => {
      if (usedAfter.has(i)) return;
      const err = Math.abs(u - t);
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    });
    if (best >= 0 && bestErr <= tol) {
      usedAfter.add(best);
      boundaryDeltas.push({ time: afterTimes[best], kind: "kept", nearestBefore: t, errorSeconds: bestErr });
    } else {
      removedBoundaries.push(t);
      boundaryDeltas.push({ time: t, kind: "removed" });
    }
  }
  afterTimes.forEach((u, i) => {
    if (!usedAfter.has(i)) {
      addedBoundaries.push(u);
      boundaryDeltas.push({ time: u, kind: "added" });
    }
  });
  boundaryDeltas.sort((a, b) => a.time - b.time);

  const fam = (groups: Group[]) =>
    groups.filter((g) => g.sectionIds.length > 1).map((g) => ({ label: g.label, members: g.sectionIds }));
  const beforeFamilies = fam(baseline.groups);
  const afterFamilies = fam(edited.groups);

  const familyChanges: string[] = [];
  const sig = (f: { members: string[] }[]) =>
    f
      .map((g) => [...g.members].sort().join("="))
      .sort()
      .join(" | ");
  if (sig(beforeFamilies) !== sig(afterFamilies)) {
    familyChanges.push(`families changed: [${sig(beforeFamilies) || "none"}] → [${sig(afterFamilies) || "none"}]`);
  }

  const SPAN_TOL = Math.max(0.25, baseline.beats.barSeconds * 0.3);
  const sectionRows = edited.sections.map((s) => {
    // Ids are positional and get renumbered when boundary counts change, so
    // compare spans, not ids, before claiming a regrouping.
    const before = baseline.sections.find(
      (b) => Math.abs(b.cueStart - s.cueStart) <= SPAN_TOL && Math.abs(b.cueEnd - s.cueEnd) <= SPAN_TOL
    );
    const sameSpan = !!before;
    const groupChanged = !!before && before.group !== s.group;
    return {
      id: s.id,
      start: s.cueStart,
      end: s.cueEnd,
      group: s.group,
      sameSpan,
      groupChanged,
      changed: !sameSpan || groupChanged
    };
  });

  return {
    boundaryDeltas,
    addedBoundaries,
    removedBoundaries,
    beforeSectionCount: baseline.sections.length,
    afterSectionCount: edited.sections.length,
    beforeFamilies,
    afterFamilies,
    familyChanges,
    sectionRows
  };
}
