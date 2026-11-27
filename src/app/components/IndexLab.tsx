import { useMemo, useState } from "react";
import {
  oracleSearch,
  compareToOracle
} from "../../engine/chunkIndex";
import type { ScanOptions, ScanResult } from "../../engine/chunkIndex";
import {
  buildAlternativeChorusScenario,
  buildCrossChunkPhraseScenario
} from "../../fixtures/longIndexScenario";

const SCAN_OPTS: Required<Pick<ScanOptions, "matchThreshold" | "barThreshold" | "minAgreeFraction">> = {
  matchThreshold: 0.8,
  barThreshold: 0.7,
  minAgreeFraction: 0.75
};

function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(2)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Interactive long-song chunk-index lab. Runs entirely on the deterministic
 * bar-vector fixture: short prefix returns both chorus and alt-ending, the
 * extended query excludes the alt. Exposes new-vs-mismatch separation and the
 * memory-cap rescan/retain decision, plus the cross-chunk phrase evidence.
 */
export function IndexLab() {
  const builtin = useMemo(() => buildAlternativeChorusScenario(), []);
  const [workflow, setWorkflow] = useState(() => buildAlternativeChorusScenario({ insertAlt: false }));
  const [inserted, setInserted] = useState(false);
  const [wfTick, setWfTick] = useState(0);
  const [mode, setMode] = useState<"builtin" | "workflow">("builtin");

  const [queryKind, setQueryKind] = useState<"short" | "long">("short");
  const [policy, setPolicy] = useState<"rescan" | "budget">("rescan");
  const [cap, setCap] = useState<"tight" | "generous">("tight");
  const [exact, setExact] = useState<ScanResult | null>(null);

  const scenario = mode === "builtin" ? builtin : workflow;
  // wfTick re-runs the memo after in-place insertSegment mutation.
  const query = queryKind === "short" ? scenario.shortQuery : scenario.chorus;

  const scanOptions: ScanOptions = useMemo(() => {
    const opts: ScanOptions = { ...SCAN_OPTS };
    if (policy === "budget") {
      opts.memoryPolicy = "budget";
      const base = scenario.index.memoryStats().totalBytes;
      if (cap === "tight") {
        // Exactly the resident index size: no room to retain candidates.
        opts.memoryBudgetBytes = base;
      } else {
        opts.memoryBudgetBytes = base + (1 << 20);
        opts.maxCandidates = 64;
      }
    }
    return opts;
    // wfTick intentionally part of the cache key for the mutable workflow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, cap, scenario, wfTick]);

  const scan = useMemo(
    () => scenario.index.scan(query, scanOptions),
    // wfTick covers insertSegment; query identity changes with scenario/kind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenario, query, scanOptions, wfTick]
  );

  const oracle = useMemo(
    () => oracleSearch(scenario.vectors, query, SCAN_OPTS),
    [scenario, query]
  );
  const viewed = exact ?? scan;
  const comparison = useMemo(
    () => compareToOracle(oracle, viewed, query.length),
    [oracle, viewed, query.length]
  );

  const cross = useMemo(() => buildCrossChunkPhraseScenario(4), []);
  const crossScan = useMemo(() => cross.index.scan(cross.phrase, SCAN_OPTS), [cross]);
  const crossOracle = useMemo(
    () => oracleSearch(cross.index.bars.map((b) => b.vector), cross.phrase, SCAN_OPTS),
    [cross]
  );
  const crossCmp = compareToOracle(crossOracle, crossScan, cross.phrase.length);

  const switchMode = (next: "builtin" | "workflow") => {
    setMode(next);
    setExact(null);
    // Each mode opens on the narrative defaults: short query + exact streaming
    // rescan, otherwise a retained-uncertain seed would not read as a hit.
    setQueryKind("short");
    setPolicy("rescan");
    setCap("tight");
  };

  const insertAltNow = () => {
    const at = workflow.trueChorusStart + 12;
    workflow.index.insertSegment(at, workflow.alt, [
      { label: "alt-b1" },
      { label: "alt-b2" },
      { label: "alt-b3" },
      { label: "alt-b4" },
      { label: "alt-b5" },
      { label: "alt-b6" },
      { label: "alt-b7" },
      { label: "alt-b8" }
    ]);
    setInserted(true);
    setExact(null);
    setWfTick((t) => t + 1);
  };

  const runExactRescan = () => {
    setExact(scenario.index.rescanRetained(query, SCAN_OPTS));
  };

  const hitStarts = viewed.matches.map((h) => h.startBar).sort((a, b) => a - b);
  const chorusHit = hitStarts.includes(scenario.trueChorusStart);
  const altBar = mode === "workflow" ? workflow.trueChorusStart + 12 : scenario.altStart;
  const altHit = hitStarts.includes(altBar);

  return (
    <section className="panel index-lab" data-testid="index-lab">
      <div className="panel-head">
        <h2>Long-song chunk index lab · 长曲分块索引</h2>
        <div className="wb-actions">
          <button
            className={mode === "builtin" ? "active" : ""}
            onClick={() => switchMode("builtin")}
            data-testid="lab-mode-builtin"
          >
            Built with alt passage
          </button>
          <button
            className={mode === "workflow" ? "active" : ""}
            onClick={() => switchMode("workflow")}
            data-testid="lab-mode-workflow"
          >
            Insert-after-build workflow
          </button>
        </div>
      </div>

      {mode === "workflow" && (
        <div className="insert-workflow" data-testid="insert-workflow">
          <p className="hint">
            Index was built without the alternative passage. Insert its 8 bars at bar{" "}
            {workflow.trueChorusStart + 12}; inserted bars enter the <strong>uncovered-new</strong> set
            and are never pre-judged as mismatches.
          </p>
          <button onClick={insertAltNow} disabled={inserted} data-testid="lab-insert-alt" className="primary">
            {inserted ? "Alternative passage inserted" : "Insert alternative ending at runtime"}
          </button>
        </div>
      )}

      <div className="lab-controls">
        <div className="lab-btn-group" role="group" aria-label="Query length">
          <button
            className={queryKind === "short" ? "active" : ""}
            onClick={() => {
              setQueryKind("short");
              setExact(null);
            }}
            data-testid="lab-query-short"
          >
            Short query · 4 opening bars
          </button>
          <button
            className={queryKind === "long" ? "active" : ""}
            onClick={() => {
              setQueryKind("long");
              setExact(null);
            }}
            data-testid="lab-query-long"
          >
            Extended query · full 8 bars
          </button>
        </div>
        <label className="lab-select">
          Memory policy
          <select
            data-testid="lab-policy"
            value={policy}
            onChange={(e) => {
              setPolicy(e.target.value as "rescan" | "budget");
              setExact(null);
            }}
          >
            <option value="rescan">streaming rescan (O(L) memory)</option>
            <option value="budget">memory cap: retain candidates if it fits</option>
          </select>
        </label>
        {policy === "budget" && (
          <label className="lab-select">
            Cap
            <select
              data-testid="lab-cap"
              value={cap}
              onChange={(e) => {
                setCap(e.target.value as "tight" | "generous");
                setExact(null);
              }}
            >
              <option value="tight">tight (index bytes only → rescan now)</option>
              <option value="generous">generous (+1 MB, ≤64 candidates → retain)</option>
            </select>
          </label>
        )}
      </div>

      <div className="lab-verdict" data-testid="lab-verdict">
        <span data-testid="lab-hits">
          Hits at bars [{hitStarts.join(", ")}] — {viewed.matches.length}
        </span>
        <span className={chorusHit ? "ok" : "bad"} data-testid="lab-chorus">
          {chorusHit ? "✓" : "✗"} real chorus (bar {scenario.trueChorusStart})
        </span>
        <span
          className={altHit ? (queryKind === "short" ? "ok" : "bad") : queryKind === "long" ? "ok" : "bad"}
          data-testid="lab-alt"
        >
          {queryKind === "short"
            ? altHit
              ? `✓ both versions returned (alt bar ${altBar})`
              : "✗ alt missing for short query"
            : altHit
              ? "✗ alt must be excluded by the extended ending"
              : `✓ extended query excludes the alt (bar ${altBar})`}
        </span>
      </div>

      <div className="lab-metrics">
        <span data-testid="lab-uncovered">uncovered-new bars: {scan.uncoveredBars.length}</span>
        <span data-testid="lab-proven">proven-mismatch bars: {scan.provenMismatchBars.length}</span>
        <span data-testid="lab-uncertain">uncertain candidates: {scan.uncertainCandidates.length}</span>
        <span data-testid="lab-decision">policy decision: {viewed.decision}</span>
        <span data-testid="lab-comparisons">
          comparisons: {scan.comparisons} / naive {scan.naiveComparisons}
        </span>
        <span data-testid="lab-saved">saved: {(scan.savedFraction * 100).toFixed(1)}%</span>
        <span data-testid="lab-bound-checks">rigorous bound checks: {scan.boundChecks}</span>
        <span data-testid="lab-memory">
          index {fmtBytes(scan.memory.totalBytes)} vs dense {fmtBytes(scan.memory.fullMatrixBytes)}
          {scan.memory.memoryBudgetBytes !== null
            ? ` · cap ${fmtBytes(scan.memory.memoryBudgetBytes)} · within cap ${scan.memory.withinBudget ? "yes" : "no"}`
            : ""}
        </span>
        <span data-testid="lab-oracle">
          oracle recall {(comparison.recall * 100).toFixed(0)}% · false exclusions{" "}
          {comparison.falseExclusionCount} · missed length {comparison.missedLengthBars} bars
        </span>
      </div>

      {scan.decision === "retain-uncertain" && !exact && (
        <button onClick={runExactRescan} data-testid="lab-rescan-retained" className="primary">
          Rescan retained candidates exactly now
        </button>
      )}
      {exact && <p className="hint" data-testid="lab-exact-note">Exact rescan resolved {exact.matches.length} hit(s).</p>}

      <details className="lab-crosschunk">
        <summary>Cross-chunk repeated phrase evidence</summary>
        <div className="lab-metrics" data-testid="crosschunk-panel">
          <span data-testid="crosschunk-found">
            six-bar phrase found at bars [{crossScan.matches.map((h) => h.startBar).join(", ")}]
          </span>
          <span data-testid="crosschunk-saved">saved: {(crossScan.savedFraction * 100).toFixed(1)}%</span>
          <span data-testid="crosschunk-missed">
            oracle recall {(crossCmp.recall * 100).toFixed(0)}% · missed length {crossCmp.missedLengthBars}{" "}
            bars · false exclusions {crossCmp.falseExclusionCount}
          </span>
        </div>
      </details>
    </section>
  );
}
