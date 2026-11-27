/**
 * Honest benchmark + evidence generator. Run with: npm run bench
 *
 * Executes every optimisation to completion before comparing timings, and
 * writes measured results to benchmarks/results.json and
 * benchmarks/optimization-gate.json. The markdown report is generated from
 * those same numbers; do not hand-edit evidence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateSmallLibrary,
  benchIndexScale,
  benchSsmScale,
  benchStructure,
  runGate
} from "./bench-lib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "benchmarks");
mkdirSync(outDir, { recursive: true });

console.log("# SectionScope optimisation benchmark\n");
console.log("Node", process.version, "·", new Date().toISOString());

console.log("\n[1/4] small-library full-matrix oracle comparison…");
const library = evaluateSmallLibrary();
console.log(library);

console.log("\n[2/4] chunk-index scaling…");
const indexScale = benchIndexScale();
console.table(indexScale);

console.log("\n[3/4] frame-SSM scaling and cost decomposition…");
const ssmScale = benchSsmScale();
console.table(ssmScale);

console.log("\n[4/4] end-to-end structure on synth programmes (full vs chunked)…");
const structure = benchStructure();
console.table(
  structure.map((r) => ({
    id: r.id,
    bars: r.bars,
    ms: Math.round(r.analyseMs),
    heapDeltaMb: +r.heapUsedMb.toFixed(1),
    rssDeltaMb: +r.rssDeltaMb.toFixed(1),
    boundaries: r.boundaryCount,
    sections: r.sectionCount,
    truth: `${r.truth.matched}/${r.truth.truth.length}`,
    missed: r.truth.missed,
    fp: r.truth.falsePositives,
    maxErr: r.truth.maxErrorSeconds
  }))
);

const gate = runGate(structure);
console.log("\nGate:", gate.verdict);
for (const line of gate.rationale) console.log(" -", line);

const results = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  note: "All values measured by scripts/bench.ts; timings are medians of 3 builds for SSM.",
  library,
  indexScale,
  ssmScale,
  structure
};
writeFileSync(resolve(outDir, "results.json"), JSON.stringify(results, null, 2));
writeFileSync(resolve(outDir, "optimization-gate.json"), JSON.stringify(gate, null, 2));

const md: string[] = [];
md.push("# Optimisation benchmark evidence");
md.push("");
md.push(`Generated: ${results.generatedAt} on ${results.platform}, Node ${results.node}.`);
md.push("Regenerate with `npm run bench`; this file is produced, not hand-written.");
md.push("");
md.push("## Computation order");
md.push("");
md.push("Normalise chroma/MFCC per frame → build per-block lo/hi envelopes → derive");
md.push("corner dot bounds (harmony) and box min/max distance bounds (RBF timbre) →");
md.push("prune non-diagonal blocks whose combined upper bound < threshold → exact");
md.push("distance + 12-shift TI chroma for retained pairs → midpoint-bound fills for");
md.push("pruned pairs → symmetrise → Gaussian blur → unchanged bar-matrix boundary");
md.push("detection → mutual-best section grouping.");
md.push("");
md.push("## Small library vs full-matrix oracle");
md.push("");
md.push(
  `Songs: ${library.songs} (${library.queriesPerSong} queries each) · oracle hits: ${library.totalOracleHits} · recall: **${(library.recall * 100).toFixed(1)}%** · false exclusions: **${library.falseExclusions}** · missed length: **${library.missedLengthBars} bars** · mean comparisons saved: **${(library.meanSavedFraction * 100).toFixed(1)}%**`
);
md.push("");
md.push("## Chunk index scaling");
md.push("");
md.push("| bars | comparisons | naive | saved | index bytes | dense NxN bytes | memory ratio | scan ms | oracle recall |");
md.push("|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const r of indexScale) {
  md.push(
    `| ${r.bars} | ${r.comparisons} | ${r.naiveComparisons} | ${(r.savedFraction * 100).toFixed(1)}% | ${r.indexBytes} | ${r.fullMatrixBytes} | ${r.memoryRatio}× | ${r.scanMs} | ${(r.oracleRecall * 100).toFixed(0)}% |`
  );
}
md.push("");
md.push("## Frame SSM: full vs block-pruned");
md.push("");
const cfg = ssmScale[0];
if (cfg) {
  md.push(
    `Chunked opt-in defaults measured here: blockFrames=${cfg.blockFrames}, pruneBound=${cfg.pruneBound}. Pruning keeps the diagonal band exact and fills pruned block pairs at interval midpoints.`
  );
  md.push("");
}
md.push("| frames | full ms | chunked ms | speedup | pairs saved | mean/max matrix error | certified fill bound | dense MB | sparse KB | compression |");
md.push("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const r of ssmScale) {
  md.push(
    `| ${r.frames} | ${r.fullBuildMs} | ${r.chunkedBuildMs} | ${r.speedup}× | ${(r.savedPairFraction * 100).toFixed(1)}% | ${r.matrixMeanError} / ${r.matrixMaxError} | ${r.guaranteedMaxFillError} | ${r.denseMatrixMb} | ${r.sparseStoreKb} | ${r.sparseCompressionRatio}× |`
  );
}
md.push("");
md.push("Cost decomposition also records normalise/blur/novelty timings in results.json.");
md.push("");
md.push("## End-to-end boundary evidence (real analyseAudio runs)");
md.push("");
md.push("| programme/strategy | bars | ms | heap Δ MB | RSS Δ MB | boundaries | sections | truth matched | missed | false+ | max cue err s |");
md.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const r of structure) {
  md.push(
    `| ${r.id} | ${r.bars} | ${Math.round(r.analyseMs)} | ${r.heapUsedMb.toFixed(2)} | ${r.rssDeltaMb.toFixed(1)} | ${r.boundaryCount} | ${r.sectionCount} | ${r.truth.matched}/${r.truth.truth.length} | ${r.truth.missed} | ${r.truth.falsePositives} | ${r.truth.maxErrorSeconds} |`
  );
}
md.push("");
md.push(
  "Heap Δ is the **signed** `process.memoryUsage().heapUsed` delta after two `gc()` calls (run bench with `--expose-gc`, wired into `npm run bench`); negative values are real GC/JIT movement, not clamped. RSS Δ captures allocator-retained memory. Deterministic byte-cost counters in the index/SSM tables are the reliable storage evidence."
);
md.push("");
md.push("## Behaviour gate");
md.push("");
md.push(`Verdict: **${gate.verdict}**`);
for (const line of gate.rationale) md.push(`- ${line}`);
md.push("");
md.push("| case | sections identical | groups identical | boundary count Δ | full max err | chunked max err |");
md.push("|---|:---:|:---:|---:|---:|---:|");
for (const c of gate.cases) {
  md.push(
    `| ${c.id} | ${c.sameSectionCount ? "yes" : "NO"} | ${c.sameGroups ? "yes" : "NO"} | ${c.boundaryCountDelta} | ${c.fullMaxBoundaryError} | ${c.chunkedMaxBoundaryError} |`
  );
}
md.push("");
writeFileSync(resolve(outDir, "report.md"), md.join("\n"));

console.log(`\nWrote ${resolve(outDir, "results.json")}`);
console.log(`Wrote ${resolve(outDir, "optimization-gate.json")}`);
console.log(`Wrote ${resolve(outDir, "report.md")}`);
