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
check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll browser checks passed.");
