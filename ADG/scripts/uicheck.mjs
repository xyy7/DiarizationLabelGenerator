/**
 * Drive the real UI in the installed Chrome and report what it does.
 *
 * playwright-core plus an existing browser, so nothing has to be downloaded --
 * Playwright's own Chromium is ~150 MB and this connection runs at about
 * 180 KB/s.
 *
 *   node scripts/uicheck.mjs [baseUrl] [recordingId]
 *
 * Everything the page complains about -- console errors, uncaught exceptions,
 * failed requests, 4xx/5xx responses -- is collected and printed at the end,
 * because a screenshot that looks fine while the console is full of errors is
 * the most misleading thing there is.
 */

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:8000';
const RECORDING = process.argv[3] ?? null;
const OUT = 'scripts/shots';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

mkdirSync(OUT, { recursive: true });

const problems = [];
const note = (kind, text) => problems.push(`[${kind}] ${text}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });

// Skip the "who are you" modal: identity is a name in localStorage.
await context.addInitScript(() => {
  try { localStorage.setItem('adg_user_name', 'uicheck'); } catch {}
});

const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') note(m.type(), m.text());
});
page.on('pageerror', (e) => note('pageerror', e.message));
page.on('requestfailed', (r) =>
  note('requestfailed', `${r.method()} ${r.url()} -- ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) note('http', `${r.status()} ${r.url()}`);
});

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`shot: ${OUT}/${name}.png`);
}

// --- workbench --------------------------------------------------------------
console.log(`=== ${BASE}/ ===`);
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
console.log('title:', await page.title());
console.log('rows:', await page.locator('tbody tr').count());
await shot('01-workbench');

// --- annotator --------------------------------------------------------------
let target = RECORDING;
if (!target) {
  const link = page.locator('tbody tr td a').first();
  if (await link.count()) {
    await link.click();
    await page.waitForURL(/\/rec\//, { timeout: 10000 }).catch(() => {});
    target = page.url().split('/rec/')[1];
  }
}

if (target) {
  console.log(`=== ${BASE}/rec/${target} ===`);
  await page.goto(`${BASE}/rec/${target}`, { waitUntil: 'networkidle' });
  // Waveform decoding + peaks fetch settle a moment after networkidle.
  await page.waitForTimeout(2500);

  // wavesurfer renders inside a shadow root, so its box has to be found by
  // walking to the shadow host rather than by querying for a canvas.
  const measure = () => {
    const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
    const lane = document.querySelector('[data-lane]');
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), width: Math.round(b.width) };
    };
    let scroller = lane?.parentElement ?? null;
    while (scroller && scroller.scrollWidth <= scroller.clientWidth) {
      scroller = scroller.parentElement;
    }
    return {
      lanes: document.querySelectorAll('[data-lane]').length,
      segments: document.querySelectorAll('[data-lane] > div').length,
      canvases: host?.shadowRoot.querySelectorAll('canvas').length ?? 0,
      wave: r(host),
      lane: r(lane),
      scrollWidth: scroller?.scrollWidth ?? null,
      clientWidth: scroller?.clientWidth ?? null,
    };
  };

  const geom = await page.evaluate(measure);
  console.log('geometry:', JSON.stringify(geom));

  // The whole point of the redesign: waveform and lanes share one coordinate
  // system, so their left edges and widths must agree.
  const checkAlign = (g, when) => {
    if (!g.wave || !g.lane) {
      note('align', `${when}: waveform or lane missing`);
      return;
    }
    const dx = Math.abs(g.wave.left - g.lane.left);
    const dw = Math.abs(g.wave.width - g.lane.width);
    console.log(`ALIGNMENT ${when}: dx=${dx}px dw=${dw}px`);
    if (dx > 2 || dw > 2) note('align', `${when}: dx=${dx} dw=${dw}`);
  };
  checkAlign(geom, 'at load');
  if (!geom.canvases) note('render', 'no waveform canvas drawn');

  await shot('02-annotator');

  // Zoom in: alignment has to survive it, since that is when the two
  // coordinate systems in the old version drifted apart.
  const zoomIn = page.locator('button:has-text("放大")');
  if (await zoomIn.count()) {
    await zoomIn.click();
    await zoomIn.click();
    await page.waitForTimeout(1500);
    const zoomed = await page.evaluate(measure);
    console.log('zoomed:', JSON.stringify(zoomed));
    checkAlign(zoomed, 'after zoom');
    await shot('03-zoomed');

    // Back to where we started so the last screenshot is the normal view.
    const zoomOut = page.locator('button:has-text("缩小")');
    await zoomOut.click();
    await zoomOut.click();
    await page.waitForTimeout(1000);
  } else {
    note('interaction', 'zoom buttons not found');
  }

  // Playback: the audio request logs an ERR_ABORTED (a media element probing
  // then re-requesting), so confirm sound actually plays rather than assuming.
  const playheadX = () => page.evaluate(() => {
    const el = document.querySelector('div[style*="background: rgb(255, 77, 79)"]');
    return el ? Math.round(el.getBoundingClientRect().left) : -1;
  });
  const x0 = await playheadX();
  await page.keyboard.press(' ');
  await page.waitForTimeout(1800);
  const x1 = await playheadX();
  await page.keyboard.press(' ');
  console.log(`playhead: ${x0}px -> ${x1}px`);
  if (x1 <= x0) note('playback', `playhead did not advance (${x0} -> ${x1})`);

  // J walks segments in time order and selects one. The selected block is the
  // one with a solid outline; `outline: none` is on all the others.
  await page.keyboard.press('j');
  await page.waitForTimeout(900);
  const selected = await page.locator('[data-lane] > div[style*="outline: rgb"]').count();
  console.log('selected after J:', selected);
  if (selected !== 1) note('interaction', `J selected ${selected} segments, expected 1`);
  await shot('04-after-step');

  // Tab must still move focus: it belongs to the browser, not to us.
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? 'none');
  console.log('focus after Tab:', focused);
  if (focused === 'body') note('a11y', 'Tab did not move focus -- keyboard trap');

  // Reassign the selection to speaker 2 -- the highest-frequency repair.
  const before = await page.locator('[data-lane]').nth(0).locator('> div').count();
  await page.keyboard.press('2');
  await page.waitForTimeout(600);
  const after = await page.locator('[data-lane]').nth(0).locator('> div').count();
  console.log(`lane 0 segments: ${before} -> ${after} after pressing "2"`);
  if (before === after) note('interaction', 'pressing 2 did not move the segment');
  await shot('05-after-reassign');
}

await browser.close();

console.log(`\n=== problems (${problems.length}) ===`);
for (const p of problems.slice(0, 40)) console.log(p);
if (!problems.length) console.log('none');
