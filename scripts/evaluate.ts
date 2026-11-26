/**
 * Evaluation harness. Runs the analyser over the synthetic programmes and the
 * hard challenge cases, and prints boundary accuracy, within-section
 * consistency and the cases the analyser gets wrong. Run with:
 *
 *   npm run evaluate
 *
 * This is deliberately a report, not a pass/fail gate: the failure cases are
 * part of what the analyser is supposed to disclose.
 */
import { analyseAudio } from "../src/engine/analyse";
import { renderSong } from "../src/fixtures/synth";
import {
  challengeCases,
  referenceSong,
  takeSong,
  transientSong
} from "../src/fixtures/synth";
import type { AnalysisResult, Section } from "../src/engine/types";

interface Truth {
  id: string;
  starts: number[];
  names: string[];
}

function analyse(spec: ReturnType<typeof referenceSong>): { result: AnalysisResult; truth: Truth } {
  const song = renderSong(spec);
  const result = analyseAudio({ channels: song.channels, sampleRate: song.sampleRate });
  return {
    result,
    truth: { id: "", starts: song.segmentStarts.slice(1), names: song.segmentNames }
  };
}

function matchBoundaries(truth: number[], found: number[], tol: number) {
  const used = new Set<number>();
  const matched: { truth: number; found: number; err: number }[] = [];
  for (const t of truth) {
    let best = -1;
    let bestErr = Infinity;
    for (let i = 0; i < found.length; i++) {
      if (used.has(i)) continue;
      const err = Math.abs(found[i] - t);
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    if (best >= 0 && bestErr <= tol) {
      used.add(best);
      matched.push({ truth: t, found: found[best], err: bestErr });
    }
  }
  return {
    matched,
    missed: truth.filter((t) => !matched.some((m) => m.truth === t)),
    falsePositives: found.filter((_, i) => !used.has(i))
  };
}

function meanConsistency(sections: Section[]): number {
  return sections.length
    ? sections.reduce((a, s) => a + (s.harmonicConsistency + s.timbreConsistency) / 2, 0) / sections.length
    : 0;
}

function report(label: string, spec: ReturnType<typeof referenceSong>, note?: string) {
  const { result, truth } = analyse(spec);
  const barSeconds = result.beats.barSeconds;
  const found = result.boundaries.map((b) => b.cueTime);
  const m = matchBoundaries(truth.starts, found, barSeconds * 1.1);
  const kinds = result.boundaries.map((b) => `${b.id}:${b.kind}`).join(" ");
  console.log(`\n## ${label}`);
  if (note) console.log(`   ${note}`);
  console.log(`   truth boundaries: ${truth.starts.map((t) => t.toFixed(1)).join(", ")}`);
  console.log(
    `   found:            ${found.map((t) => t.toFixed(1)).join(", ") || "none"}  [${kinds || "-"}]`
  );
  const status =
    m.missed.length === 0 && m.falsePositives.length === 0
      ? "PASS"
      : m.missed.length + m.falsePositives.length <= 1
        ? "PARTIAL"
        : "FAIL";
  console.log(
    `   match: ${status}  matched=${m.matched.length}/${truth.starts.length}  missed=${m.missed.length}  falsePositives=${m.falsePositives.length}`
  );
  if (m.matched.length) {
    console.log(
      `   cue error: ${m.matched.map((x) => `${x.err.toFixed(2)}s`).join(", ")} (bar = ${barSeconds.toFixed(2)}s)`
    );
  }
  console.log(
    `   sections: ${result.sections
      .map((s) => `${s.label}[${s.group || "-"}] ${s.start.toFixed(1)}-${s.end.toFixed(1)}`)
      .join("  ")}`
  );
  console.log(
    `   within-section consistency: ${(meanConsistency(result.sections) * 100).toFixed(1)}% (mean of harmony and timbre)  ·  family confidence: ${result.sections
      .map((s) => (s.groupConfidence > 0 ? s.groupConfidence.toFixed(2) : "-"))
      .join(" ")}`
  );
  return { result, m, status };
}

function main() {
  console.log("# SectionScope evaluation report");
  console.log(
    "Boundary tolerance is ±1.1 bars. Within-section consistency is the mean bar-to-centroid similarity."
  );

  const ref = report("Reference programme", referenceSong());
  const take = report("Take with one bar deleted from the verse reprise", takeSong());
  report("Loudness-transient stress", transientSong());

  console.log("\n# Challenge cases (expected: some fail, visibly)");
  const failures: string[] = [];
  for (const c of challengeCases()) {
    const r = report(c.id, c.spec, c.note);
    if (r.status !== "PASS") failures.push(`${c.id} (${c.probe}): ${r.status}`);
    if (c.expectedKind) {
      const wrongKinds = r.result.boundaries.filter((b) => b.kind !== c.expectedKind);
      if (wrongKinds.length > 0) {
        failures.push(
          `${c.id} (kind): expected ${c.expectedKind} at every boundary, got ${wrongKinds
            .map((b) => `${b.id}=${b.kind}`)
            .join(", ")}`
        );
      }
    }
  }

  console.log("\n## Repetition families");
  for (const [name, r] of [
    ["reference", ref],
    ["take", take]
  ] as const) {
    console.log(
      `   ${name}: ${r.result.groups
        .map((g) => `${g.label}=[${g.sectionIds.join(",")}]`)
        .join(" ")}`
    );
  }

  console.log("\n## Wrong segmentations to disclose");
  for (const f of failures) console.log(`   - ${f}`);

  const notes = ref.result.diagnostics.notes.filter((n) => n.includes("Grouping rule"));
  console.log("\n## Grouping rule actually used");
  for (const n of notes) console.log(`   ${n}`);
}

main();
