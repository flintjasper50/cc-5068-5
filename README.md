# SectionScope

Music structure analysis from harmony and timbre self-similarity. This branch adds
a rigorous chunked/sparse bar index for long songs, an insertable alternative
ending scenario, a threshold workbench in the UI, and an honest benchmark/gate
harness. The exact dense SSM remains the production default; chunked frame SSM is
an explicit opt-in.

## 启动界面（怎么运行）

```bash
npm install
npm run dev
```

Then open **http://localhost:5173/** (the dev server binds `0.0.0.0:5173`).

- Click **Load reference** (and optionally **Load take (bar dropped)**) and wait
  for analysis; the worker renders the SSM, sections and diagnostics.
- Scroll to **Threshold workbench · 声音分析窗口**: move the three
  similarity/z sliders (or type values), click **Apply & re-segment** to re-run
  the real kernel (`detectBoundaries` + `buildSections` on cached features),
  compare before/after sections and families, and use each row's **Play** button
  to audition that span through the active player. Out-of-range values are
  rejected in an alert region tied to the offending field.
- The **Long-song chunk index lab · 长曲分块索引** panel runs the deterministic
  alt-chorus scenario live: short 4-bar query returns both the real chorus and
  the alternative passage, the extended 8-bar query excludes the alt; the memory
  policy select shows streaming-rescan vs retain-uncertain, and the
  *Insert-after-build workflow* demonstrates runtime insertion and the
  uncovered-new vs proven-mismatch separation.

Production build and preview:

```bash
npm run build
npm run preview     # http://localhost:4173/
```

The browser e2e expects the dev server on `127.0.0.1:5173`:

```bash
npm run dev &
node scripts/e2e.mjs
```

## Other commands

```bash
npm test            # vitest, node + jsdom suites (58 tests)
npm run typecheck   # tsc --noEmit
npm run evaluate    # reference/take/challenge report; pinned known outcomes
npm run bench       # real measurements -> benchmarks/{results,report,...}
npm run gate        # behaviour gate; --check exits 1 on revert-chunked
```

`npm run bench` runs with `NODE_OPTIONS=--expose-gc` so memory deltas are
measured after explicit GC; deltas are signed and never clamped.

## What was added and where

| Requirement | Code | Evidence / tests |
|---|---|---|
| Chunk/pruned similarity with explainable error | `src/engine/chunkIndex.ts`, `src/engine/ssmChunked.ts` | `test/chunkIndex.test.ts`, `test/ssmChunked.test.ts` |
| Alt-ending insert + short-both / long-one | `src/fixtures/longIndexScenario.ts`, `LongSongIndex.insertSegment` | scenario + UI lab; oracle audit in `scripts/bench-lib.ts` |
| New-uncovered vs proven-mismatch; memory cap rescan/retain | `ScanResult.{uncoveredBars,provenMismatchBars,uncertainCandidates,decision}` | memory-policy tests |
| Full-matrix oracle recall / false exclusion | `oracleSearch`, `compareToOracle`, `fullBarMatrix` | 8-song library in `benchmarks/report.md` |
| Cross-chunk phrase + saved comparisons + missed length | `buildCrossChunkPhraseScenario` | two shifted 6-bar occurrences, missed length 0 |
| Threshold editing + before/after + playback | `src/engine/resegment.ts`, `src/app/components/ThresholdWorkbench.tsx` | `test/resegment.test.ts`, `test/ui/workbench.test.tsx`, `scripts/e2e.mjs` |
| Index lab UI | `src/app/components/IndexLab.tsx` | jsdom + browser e2e |
| Cost decomposition, stress programmes, boundary/memory evidence | `scripts/bench-lib.ts`, `scripts/bench.ts`, `src/fixtures/synth.ts` (`longRecapSong`, `timbreRamp`) | `benchmarks/results.json`, `benchmarks/report.md` |
| Behaviour gate / revert criterion | `scripts/gate-optimization.ts`, `runGate` | `benchmarks/optimization-gate.json` |

## Chunk SSM computation order (and why it is safe to prune)

1. Normalise chroma/MFCC per frame exactly as the dense path does
   (`prepareSsmVectors`, shared code).
2. Summarise every fixed frame block with per-dimension lo/hi envelopes.
3. For each block pair derive rigorous bounds without evaluating every frame
   pair: axis-aligned envelope **corner-product dot bounds** for harmony and a
   **box min/max distance** for the RBF timbre kernel.
4. Keep the diagonal band (`|i-j| <= 1` blocks) exact. Otherwise, when the
   combined upper bound stays below the prune gate (`chunkPruneBound`, opt-in
   default 0.5 with 8-frame blocks), skip exact scoring; every skipped value is
   certified to lie inside its interval.
5. Retained pairs get the exact distance plus the 12-shift
   transposition-invariant chroma evaluation.
6. Pruned entries are filled at interval midpoints;
   `guaranteedMaxFillError` records the worst certified half-width, and
   `compareMatrices` measures realised mean/max error against the dense matrix.
7. Symmetrise, Gaussian blur, then run the **unchanged** bar-matrix boundary
   detection and mutual-best section grouping. Boundary semantics and the
   reference thresholds are untouched unless the user explicitly edits them.

The bar index uses the same guarantee philosophy at bar scale: chunk envelope
bounds can only overestimate similarity, so a pruned bar/chunk can never be a
false exclusion. Candidates near the seed gate are kept as uncertain or
exactly rescanned; a tight memory cap forces a streaming rescan (`O(L)` memory)
rather than dropping candidates.

## Gate and revert policy

`runGate` compares full vs chunked end-to-end on four synth programmes. Section
counts and repetition-family signatures must match; boundary-count drift is
only tolerated when truth matching stays benign. Any other regression yields
`verdict: "revert-chunked"` and `npm run gate -- --check` exits 1. The latest
recorded verdict is **safe-opt-in**; regardless, the production default stays
`ssmStrategy: "full"` so the displayed matrix remains exact and pinned
evaluations do not move. Enable the experiment per analysis with
`options.ssmStrategy = "chunked"`.

## Honest measurement notes

`benchmarks/` is produced by one real `npm run bench` run and should be
regenerated rather than hand-edited. The bar index is the large win
(~95–99.7% comparisons saved, up to ~70× storage ratio vs a dense bar matrix,
zero oracle false exclusions). Frame-level pruning at the measured operating
point saves ~33% of pairs for ~1.1–1.5× median build speed on this machine with
mean matrix error ~0.008; end-to-end analyse time also contains STFT, beat
tracking and rendering, so its delta is noisier and is shown raw. The
long-recap stress case carries one pre-existing false-positive boundary under
**both** strategies; the report records it instead of hiding it.
