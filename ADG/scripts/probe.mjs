/**
 * Focused probe of the waveform.
 *
 * wavesurfer v7 renders into a shadow root, so a plain document.querySelector
 * finds nothing and it looks like the waveform is missing when it is not.
 * Playwright's CSS locators pierce shadow DOM; raw evaluate() has to walk it
 * by hand.
 */
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://localhost:8000';
const REC = process.argv[3];
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addInitScript(() => {
  try { localStorage.setItem('adg_user_name', 'probe'); } catch {}
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`  pageerror: ${e.message}`));

await page.goto(`${BASE}/rec/${REC}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

console.log('canvases (shadow-piercing locator):', await page.locator('canvas').count());

const dump = await page.evaluate(() => {
  const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
  const root = host?.shadowRoot;
  const canvases = root ? [...root.querySelectorAll('canvas')] : [];
  const scrollDiv = root?.querySelector('.scroll') ?? root?.firstElementChild;
  const lane = document.querySelector('[data-lane]');
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), width: Math.round(b.width), height: Math.round(b.height) };
  };

  // Walk up from a lane to whatever is actually scrolling.
  let scroller = lane?.parentElement ?? null;
  while (scroller && scroller.scrollWidth <= scroller.clientWidth) scroller = scroller.parentElement;

  return {
    hostTag: host?.tagName.toLowerCase() ?? null,
    hostRect: r(host),
    canvasCount: canvases.length,
    canvasRects: canvases.map(r),
    wsScroll: scrollDiv ? {
      cls: scrollDiv.className,
      scrollWidth: scrollDiv.scrollWidth,
      clientWidth: scrollDiv.clientWidth,
      overflowX: getComputedStyle(scrollDiv).overflowX,
    } : null,
    laneRect: r(lane),
    outerScroller: scroller ? {
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
    } : null,
  };
});

console.log(JSON.stringify(dump, null, 2));

// The claim under test: waveform and lanes share one coordinate system.
if (dump.hostRect && dump.laneRect) {
  const dx = Math.abs(dump.hostRect.left - dump.laneRect.left);
  const dw = Math.abs(dump.hostRect.width - dump.laneRect.width);
  console.log(`\nALIGNMENT  dx=${dx}px  dw=${dw}px  ->  ${dx <= 2 && dw <= 2 ? 'OK' : 'MISALIGNED'}`);
}

await browser.close();
