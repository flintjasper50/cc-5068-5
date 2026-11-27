# Optimisation benchmark evidence

Generated: 2026-11-27T02:04:04.346Z on linux arm64, Node v22.23.4.
Regenerate with `npm run bench`; this file is produced, not hand-written.

## Computation order

Normalise chroma/MFCC per frame → build per-block lo/hi envelopes → derive
corner dot bounds (harmony) and box min/max distance bounds (RBF timbre) →
prune non-diagonal blocks whose combined upper bound < threshold → exact
distance + 12-shift TI chroma for retained pairs → midpoint-bound fills for
pruned pairs → symmetrise → Gaussian blur → unchanged bar-matrix boundary
detection → mutual-best section grouping.

## Small library vs full-matrix oracle

Songs: 8 (2 queries each) · oracle hits: 24 · recall: **100.0%** · false exclusions: **0** · missed length: **0 bars** · mean comparisons saved: **95.0%**

## Chunk index scaling

| bars | comparisons | naive | saved | index bytes | dense NxN bytes | memory ratio | scan ms | oracle recall |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 128 | 36 | 968 | 96.3% | 14848 | 65536 | 4.41× | 0.55 | 100% |
| 512 | 36 | 4040 | 99.1% | 59392 | 1048576 | 17.66× | 0.39 | 100% |
| 2048 | 48 | 16328 | 99.7% | 237568 | 16777216 | 70.62× | 0.34 | 100% |

## Frame SSM: full vs block-pruned

Chunked opt-in defaults measured here: blockFrames=8, pruneBound=0.5. Pruning keeps the diagonal band exact and fills pruned block pairs at interval midpoints.

| frames | full ms | chunked ms | speedup | pairs saved | mean/max matrix error | certified fill bound | dense MB | sparse KB | compression |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 300 | 8.35 | 7.33 | 1.14× | 31.7% | 0.00763 / 0.3399 | 0.4423 | 1.4 | 489.1 | 2.88× |
| 700 | 43 | 32.84 | 1.31× | 32.7% | 0.00799 / 0.3514 | 0.4472 | 7.5 | 2597.6 | 2.95× |
| 1400 | 177.17 | 120.66 | 1.47× | 33.0% | 0.00812 / 0.3851 | 0.4471 | 29.9 | 10303.3 | 2.97× |

Cost decomposition also records normalise/blur/novelty timings in results.json.

## End-to-end boundary evidence (real analyseAudio runs)

| programme/strategy | bars | ms | heap Δ MB | RSS Δ MB | boundaries | sections | truth matched | missed | false+ | max cue err s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| reference-full | 49 | 1540 | 5.56 | 1.5 | 5 | 6 | 5/5 | 0 | 0 | 2.371 |
| reference-chunked | 49 | 1423 | 2.57 | 1.9 | 5 | 6 | 5/5 | 0 | 0 | 2.371 |
| take-full | 47 | 1242 | 2.54 | 4.9 | 5 | 6 | 5/5 | 0 | 0 | 0.035 |
| take-chunked | 47 | 1403 | 5.73 | -0.5 | 5 | 6 | 5/5 | 0 | 0 | 0.035 |
| transient-full | 25 | 601 | 1.72 | 0.0 | 2 | 3 | 2/2 | 0 | 0 | 0.035 |
| transient-chunked | 25 | 597 | 3.40 | 0.0 | 2 | 3 | 2/2 | 0 | 0 | 0.035 |
| long-recap-full | 45 | 1205 | 1.91 | 0.0 | 5 | 6 | 4/4 | 0 | 1 | 2.373 |
| long-recap-chunked | 45 | 1126 | 13.69 | 2.0 | 5 | 6 | 4/4 | 0 | 1 | 2.373 |

Heap Δ is the **signed** `process.memoryUsage().heapUsed` delta after two `gc()` calls (run bench with `--expose-gc`, wired into `npm run bench`); negative values are real GC/JIT movement, not clamped. RSS Δ captures allocator-retained memory. Deterministic byte-cost counters in the index/SSM tables are the reliable storage evidence.

## Behaviour gate

Verdict: **safe-opt-in**
- Chunked strategy preserves section counts and repetition families; boundary output is bar-matrix-driven and identical in count. Keeping the production default at full anyway preserves exact display matrices; chunked remains an explicit opt-in.

| case | sections identical | groups identical | boundary count Δ | full max err | chunked max err |
|---|:---:|:---:|---:|---:|---:|
| reference | yes | yes | 0 | 2.371 | 2.371 |
| take | yes | yes | 0 | 0.035 | 0.035 |
| transient | yes | yes | 0 | 0.035 | 0.035 |
| long-recap | yes | yes | 0 | 2.373 | 2.373 |
