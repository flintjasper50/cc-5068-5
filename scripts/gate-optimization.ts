/**
 * Optimisation behaviour gate. Runs the full and chunked strategies through
 * the complete analysis kernel on the synth programmes and withdraws the
 * chunked optimisation if anything beyond boundary localisation/memory moves.
 *
 * Run: npm run gate          (writes benchmarks/optimization-gate.json)
 *      npm run gate -- --check   (exit 1 when the verdict is revert-chunked)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchStructure, runGate } from "./bench-lib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "benchmarks");
mkdirSync(outDir, { recursive: true });

const structure = benchStructure();
const gate = runGate(structure);
writeFileSync(resolve(outDir, "optimization-gate.json"), JSON.stringify(gate, null, 2));
console.log(JSON.stringify(gate, null, 2));

if (process.argv.includes("--check") && gate.verdict === "revert-chunked") {
  console.error("Optimisation gate failed: revert the chunked SSM change.");
  process.exit(1);
}
