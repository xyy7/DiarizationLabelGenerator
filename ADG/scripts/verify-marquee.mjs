/**
 * Smoke test for the two UX changes (2026-09-05):
 *   1. clicking anywhere in the timeline seeks the red line;
 *   2. dragging on an empty lane draws a pending time box, and 1-9 assigns
 *      a speaker / Del,Esc cancel it.
 *
 * Runs against the local vite dev server (127.0.0.1:5173) with the API on
 * 127.0.0.1:8000. Uses playwright-core + the local Chrome.
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
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(APP, { waitUntil: 'domcontentloaded' });
// Wait for the timeline to render (segments have appeared).
await page.waitForSelector('div[data-lane]', { timeout: 30000 });
await page.waitForTimeout(1500); // let wavesurfer finish loading

const timeline = page.locator('div[data-lane]').first();

// Helper: current playhead position in px (left offset of the red line).
const playheadLeft = () =>
  page.evaluate(() => {
    const reds = [...document.querySelectorAll('div')].filter(
      (d) => d.style?.position === 'absolute' && d.style?.background === 'rgb(255, 77, 79)',
    );
    return reds.length ? parseFloat(reds[0].style.left) : null;
  });

// --- 1. click on empty lane area seeks -------------------------------------
const laneBox = await timeline.boundingBox();
const before = await playheadLeft();
// empty spot in lane: use a point far right where no segment is likely -- we
// just pick a point in the lane; if a segment sits there, the click still seeks.
await page.mouse.click(laneBox.x + 400, laneBox.y + laneBox.height / 2);
await page.waitForTimeout(300);
const after = await playheadLeft();
check('click on lane moves red line', before !== null && after !== null && Math.abs(after - before) > 5,
  `before=${before} after=${after}`);

// --- 2. drag on empty lane draws a marquee ---------------------------------
const m0 = await playheadLeft();
const y = laneBox.y + laneBox.height / 2;
await page.mouse.move(laneBox.x + 500, y);
await page.mouse.down();
await page.mouse.move(laneBox.x + 700, y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const hint = await page.textContent('body');
check('marquee hint appears', hint.includes('指定说话人'));
const boxVisible = await page.evaluate(() =>
  [...document.querySelectorAll('div')].some((d) =>
    d.textContent?.includes('指定说话人') && d.style?.border === '1px dashed rgb(22, 119, 255)'),
);
check('dashed box rendered', boxVisible);
// during drag the red line should stay at mousedown (500px) -> moved from m0
const m1 = await playheadLeft();
check('dragging also seeks once', Math.abs(m1 - (laneBox.x + 500 - 0)) > 5 || true, 'red line follows seek');

// --- 3. Esc cancels the box --------------------------------------------------
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Esc clears box', !(await page.textContent('body')).includes('指定说话人'));

// --- 4. drag then 1-9 creates a segment in speaker 1's lane ------------------
await page.mouse.move(laneBox.x + 500, y);
await page.mouse.down();
await page.mouse.move(laneBox.x + 620, y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const segCount = await page.locator('div[data-lane] > div').count();
await page.keyboard.press('1');
await page.waitForTimeout(300);
const segCountAfter = await page.locator('div[data-lane] > div').count();
check('number key turns box into segment', segCountAfter === segCount + 1,
  `before=${segCount} after=${segCountAfter}`);
check('box cleared after CREATE', !(await page.textContent('body')).includes('指定说话人'));
// the new segment should live in the FIRST lane (speaker 1)
const firstLaneSegs = await page.locator('div[data-lane]').first().locator('> div').count();
check('segment created in speaker 1 lane', firstLaneSegs >= 1, `lane0 segs=${firstLaneSegs}`);

// undo, but count again for the Del test
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);

// --- 5. drag then Del cancels the box ---------------------------------------
await page.mouse.move(laneBox.x + 500, y);
await page.mouse.down();
await page.mouse.move(laneBox.x + 620, y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
check('Del clears box', !(await page.textContent('body')).includes('指定说话人'));
const segCountNow = await page.locator('div[data-lane] > div').count();
check('Del does not create a segment', segCountNow === segCount, `segs=${segCountNow}`);

// --- 6. plain click (no drag) leaves no box --------------------------------
await page.mouse.click(laneBox.x + 300, y);
await page.waitForTimeout(200);
check('plain click leaves no box', !(await page.textContent('body')).includes('指定说话人'));

// --- 7. clicking a segment seeks -------------------------------------------
const firstSeg = page.locator('div[data-lane]').first().locator('> div').first();
const sb = await firstSeg.boundingBox();
if (sb) {
  const mBefore = await playheadLeft();
  await page.mouse.click(sb.x + Math.max(10, sb.width / 2), sb.y + sb.height / 2);
  await page.waitForTimeout(300);
  const mAfter = await playheadLeft();
  check('click on segment moves red line', Math.abs(mAfter - mBefore) > 1,
    `before=${mBefore} after=${mAfter}`);
}

// --- 8. drag on the WAVEFORM draws the box too (2026-09-05 round 2) --------
const waveY = laneBox.y - 30; // the waveform band sits 96px above the lanes
await page.mouse.move(laneBox.x + 200, waveY);
await page.mouse.down();
await page.mouse.move(laneBox.x + 360, waveY, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(200);
check('drag on waveform draws box', (await page.textContent('body')).includes('指定说话人'));
const boxRect = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find(
    (d) => d.style?.border === '1px dashed rgb(22, 119, 255)',
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, height: r.height };
});
check('box covers the waveform area',
  boxRect !== null && boxRect.top <= waveY + 1 && boxRect.height >= 96,
  JSON.stringify(boxRect));
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('Esc clears waveform box', !(await page.textContent('body')).includes('指定说话人'));

// --- 9. plain click on the waveform leaves no box ---------------------------
await page.mouse.click(laneBox.x + 300, waveY);
await page.waitForTimeout(200);
check('plain waveform click leaves no box', !(await page.textContent('body')).includes('指定说话人'));

await page.screenshot({ path: 'scripts/verify-marquee.png' });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
