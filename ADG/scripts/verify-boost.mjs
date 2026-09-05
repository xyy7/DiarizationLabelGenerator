/**
 * Smoke test for the volume boost chain (2026-09-05).
 *
 * Attempts: set 200% -> gain 2.0; drag on to 400% -> gain 4.0 (stuck at 2.0
 * before the fix); down to 50% -> gain 0.5; 100% -> 1.0; 300% -> 3.0. Also
 * asserts the AudioContext ends up RUNNING (a suspended context routes audio
 * into silence) and that a MediaElementSource was created (route() ran).
 *
 * The init script wraps AudioContext / createMediaElementSource so the test
 * can inspect the chain the app built. The popover shifts between clicks (the
 * trigger button label grows), so the rail rect is re-read before every click.
 */
import { chromium } from 'playwright-core';

const REC = '988f2bb0-ebb8-45d7-9435-758e487b5d74';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://127.0.0.1:5174/rec/' + REC;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

await page.addInitScript(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  window.__ctxs = [];
  window.__gains = [];
  window.__srcCount = 0;
  const OrigGain = AC.prototype.createGain;
  AC.prototype.createGain = function (...a) {
    const g = OrigGain.apply(this, a);
    window.__gains.push(g);
    return g;
  };
  const ACProto = AC.prototype;
  const OrigMS = ACProto.createMediaElementSource
    ? ACProto.createMediaElementSource.bind(ACProto)
    : null;
  if (OrigMS) {
    ACProto.createMediaElementSource = function (...a) {
      window.__srcCount += 1;
      return OrigMS(...a);
    };
  }
  window.AudioContext = class extends AC {
    constructor(...a) {
      super(...a);
      window.__ctxs.push(this);
    }
  };
});

await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear()); // fresh boost = 100%
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500); // waveform ready

// Open the boost popover.
await page.locator('button', { hasText: '音量' }).click();
await page.waitForSelector('.ant-slider-rail', { timeout: 5000 });
await page.waitForTimeout(400); // popover settle

const gain = () => page.evaluate(() => window.__gains[0]?.gain.value ?? null);
const ctxState = () => page.evaluate(() => window.__ctxs[0]?.state ?? null);
const srcCount = () => page.evaluate(() => window.__srcCount ?? 0);
const label = () => page.evaluate(() =>
  [...document.querySelectorAll('button')].map((b) => b.textContent).find((t) => t?.includes('音量')) ?? null);

async function setPct(pct) {
  // Re-read the rail every time: the popover re-anchors as the button label
  // ("音量 200%") grows.
  const rail = await page.locator('.ant-slider-rail').first().boundingBox();
  const x = rail.x + rail.width * ((pct - 50) / 450);
  const y = rail.y + rail.height / 2;
  await page.mouse.click(x, y);
  await page.waitForTimeout(350);
}

await setPct(200);
const g200 = await gain();
check('gain = 2.0 at 200%', g200 !== null && Math.abs(g200 - 2) < 0.01,
  `gain=${g200} label=${await label()}`);

await setPct(400);
const g400 = await gain();
check('gain follows to 4.0 at 400% (was stuck before fix)',
  g400 !== null && Math.abs(g400 - 4) < 0.01,
  `gain=${g400} label=${await label()}`);

await setPct(50);
const g50 = await gain();
check('gain = 0.5 at 50% (down-path through graph)',
  g50 !== null && Math.abs(g50 - 0.5) < 0.01, `gain=${g50} label=${await label()}`);

await setPct(100);
const g100 = await gain();
check('gain = 1.0 at 100%', g100 !== null && Math.abs(g100 - 1) < 0.01, `gain=${g100}`);

await setPct(300);
const g300 = await gain();
check('gain = 3.0 at 300%', g300 !== null && Math.abs(g300 - 3) < 0.01,
  `gain=${g300} label=${await label()}`);

// --- engage the graph for playback elements: resume + route ------------------
const state = await ctxState();
check('AudioContext running (not suspended-silent)', state === 'running', `state=${state}`);
const n = await srcCount();
check('media element routed into the gain graph', n >= 1, `sources=${n}`);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
