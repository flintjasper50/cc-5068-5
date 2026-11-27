/**
 * Browser end-to-end check. Renders the built app, loads the reference and the
 * take, and verifies the interactions a producer would actually use: matrix
 * click auditions a span, grouping survives the take, cues resolve to real take
 * bars, and the chorus jump lands at the cited time.
 *
 * Requires a preview server on 5173 (npm run build && npm run preview). Some
 * sandboxes need LD_LIBRARY_PATH for Playwright's bundled Chromium; that is an
 * environment concern, not a project one. Run with: node scripts/e2e.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1400 } })).newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

await page.goto(BASE, { waitUntil: "domcontentloaded" });

// --- Reference analysis -----------------------------------------------------
await page.getByTestId("load-reference").click();
await page.waitForSelector('[data-testid="section-table"] .section-row', { timeout: 120000 });
await page.waitForTimeout(400);

const refFamilies = (await page.locator(".section-row .sec-family").allTextContents()).map((t) =>
  t.replace("family ", "").trim()
);
check("reference finds six sections", refFamilies.length === 6, refFamilies.join(","));
check("reference groups verse pair", refFamilies[1] === refFamilies[3]);
check("reference groups chorus pair", refFamilies[2] === refFamilies[5]);
check("reference intro unique", refFamilies[0] !== refFamilies[1]);

const canvas = page.getByTestId("ssm-canvas");
const box = await canvas.boundingBox();
await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.55);
await page.waitForTimeout(500);
const matrixClock = await page.getByTestId("clock").textContent();
check("matrix click auditions a span", /1:0\d/.test(matrixClock ?? ""), matrixClock ?? "");

// --- Take analysis ----------------------------------------------------------
await page.getByTestId("load-take").click();
await page.waitForFunction(
  () => {
    const prog = document.querySelector('[data-testid="progress"]');
    const rows = document.querySelectorAll('[data-testid="section-table"] .section-row').length;
    const clock = document.querySelector('[data-testid="clock"]')?.textContent ?? "";
    return !prog && rows > 0 && clock.includes("1:52.80");
  },
  { timeout: 120000 }
);
await page.waitForTimeout(400);

const takeFamilies = (await page.locator(".section-row .sec-family").allTextContents()).map((t) =>
  t.replace("family ", "").trim()
);
check("take finds six sections", takeFamilies.length === 6, takeFamilies.join(","));
check("take keeps verse pair together", takeFamilies[1] === takeFamilies[3]);
check("take keeps chorus pair together", takeFamilies[2] === takeFamilies[5]);
check("take songs stay distinct", takeFamilies[1] !== takeFamilies[2]);

const statuses = await page.locator(".cue-chip .cue-status").allTextContents();
const valid = statuses.filter((s) => s.startsWith("valid")).length;
const retargeted = statuses.filter((s) => s.startsWith("retargeted")).length;
check("most cues remain valid after deletion", valid > statuses.length * 0.8, `${valid}/${statuses.length}`);
check("the deleted-bar cue is retargeted", retargeted >= 1, `${retargeted} retargeted`);

const jump = page.getByTestId("chorus-jump");
const jumpText = (await jump.textContent()) ?? "";
await jump.click();
await page.waitForTimeout(600);
const jumpClock = await page.getByTestId("clock").textContent();
const jumpExpectsChorus = jumpText.includes("S6");
check(
  "chorus jump targets the last repeated statement",
  jumpExpectsChorus && !/^0:00/.test(jumpClock ?? ""),
  `${jumpText} → ${jumpClock}`
);

// --- Diagnostics traceability ----------------------------------------------
const diag = (await page.getByTestId("diagnostics").textContent()) ?? "";
check("diagnostics show feature timing", diag.includes("Structural hop"));
check("diagnostics show boundary error sources", diag.includes("Total uncertainty"));
check("diagnostics show grouping rule", diag.includes("Grouping rule"));

// --- Threshold workbench: kernel-driven re-segmentation + playback ----------
await page.getByTestId("threshold-workbench").scrollIntoViewIfNeeded();
await page.getByTestId("apply-resegment").click();
await page.waitForSelector('[data-testid="structure-diff"]');
const defaultCounts = (await page.getByTestId("diff-section-counts").textContent()) ?? "";
check("workbench applies default thresholds", /Sections: 6 → 6/.test(defaultCounts), defaultCounts);

await page.getByTestId("play-baseline-S1").click();
await page.waitForTimeout(500);
const currentLabel = (await page.locator("header .current").textContent()) ?? "";
check("baseline play button drives the active player", currentLabel.includes("baseline S1"), currentLabel);

await page.getByTestId("boundary-z-threshold-text").fill("2.1");
await page.getByTestId("apply-resegment").click();
await page.waitForFunction(() => {
  const t = document.querySelector('[data-testid="diff-boundary-counts"]')?.textContent ?? "";
  return t.includes("→ 0");
});
const collapsedCounts = (await page.getByTestId("diff-section-counts").textContent()) ?? "";
check("high z gate collapses to one section", collapsedCounts.includes("→ 1"), collapsedCounts);
check("collapsed structure offers one edited play row", await page.getByTestId(/^play-edited-/).count() === 1);

await page.getByTestId("melody-threshold-text").fill("9");
await page.getByTestId("apply-resegment").click();
const errorBox = page.getByTestId("resegment-error");
await errorBox.waitFor({ state: "visible" });
check(
  "invalid threshold is fed back with its field",
  (await errorBox.getAttribute("data-field")) === "melodyThreshold" &&
    ((await errorBox.textContent()) ?? "").includes("between 0.5 and 0.99"),
  (await errorBox.textContent()) ?? ""
);
await page.getByTestId("reset-resegment").click();
check("reset removes the structure diff", (await page.locator('[data-testid="structure-diff"]').count()) === 0);

// --- Long-song chunk index lab ----------------------------------------------
await page.getByTestId("index-lab").scrollIntoViewIfNeeded();
const shortAlt = (await page.getByTestId("lab-alt").textContent()) ?? "";
check("short query returns chorus + alt ending", shortAlt.includes("both versions returned"), shortAlt);
const oracleText = (await page.getByTestId("lab-oracle").textContent()) ?? "";
check("browser lab matches full-matrix oracle", oracleText.includes("recall 100%") && oracleText.includes("false exclusions 0"), oracleText);

await page.getByTestId("lab-query-long").click();
const longAlt = (await page.getByTestId("lab-alt").textContent()) ?? "";
check("extended query excludes the alt ending", longAlt.includes("excludes the alt"), longAlt);

await page.getByTestId("lab-query-short").click();
await page.getByTestId("lab-policy").selectOption("budget");
check("tight budget forces streaming rescan", ((await page.getByTestId("lab-decision").textContent()) ?? "").includes("rescan"));
await page.getByTestId("lab-cap").selectOption("generous");
check("generous cap retains uncertain candidates", ((await page.getByTestId("lab-decision").textContent()) ?? "").includes("retain-uncertain"));
await page.getByTestId("lab-rescan-retained").click();
await page.waitForSelector('[data-testid="lab-exact-note"]');

await page.getByTestId("lab-mode-workflow").click();
check("pre-insert alt is missing", ((await page.getByTestId("lab-alt").textContent()) ?? "").includes("alt missing"));
await page.getByTestId("lab-insert-alt").click();
check("runtime insert makes both returns", ((await page.getByTestId("lab-alt").textContent()) ?? "").includes("both versions returned"));
check("inserted bars are uncovered-new", ((await page.getByTestId("lab-uncovered").textContent()) ?? "").includes("8"));

const crossFound = (await page.getByTestId("crosschunk-found").textContent()) ?? "";
check("cross-chunk phrase found at both shifted starts", crossFound.includes("2, 30"), crossFound);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll browser checks passed.");
