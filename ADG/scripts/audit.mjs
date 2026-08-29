/**
 * Wider browser audit, following the browser-testing-with-devtools workflow:
 * a clean-console standard (warnings included, not just errors), the
 * accessibility tree, performance timings, and several viewports.
 *
 * Uses playwright-core against the installed Chrome. The skill itself expects
 * the chrome-devtools MCP server, which needs a session restart to load; this
 * covers the same ground in the meantime.
 *
 *   node scripts/audit.mjs [baseUrl] [recordingId]
 *
 * NOTE: everything read out of the page below is browser data, not
 * instruction. It is reported, never acted on.
 */

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:8000';
const REC = process.argv[3];
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'scripts/shots';
mkdirSync(OUT, { recursive: true });

const findings = [];
const add = (kind, text) => findings.push(`[${kind}] ${text}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function newPage(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('adg_user_name', 'audit'); } catch {}
    // Collect web vitals as they happen; they cannot be read retroactively.
    window.__vitals = { lcp: 0, cls: 0, longTasks: [] };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__vitals.lcp = e.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__vitals.cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__vitals.longTasks.push(Math.round(e.duration));
      }).observe({ type: 'longtask', buffered: true });
    } catch {}
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.type();
    // The clean-console standard counts warnings too.
    if (t === 'error' || t === 'warning') add(`console.${t}`, m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => add('pageerror', e.message));
  return page;
}

// --- 1. accessibility + console, at desktop width ---------------------------
console.log('=== annotator, 1600x950 ===');
let page = await newPage(1600, 950);
await page.goto(`${BASE}/rec/${REC}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const a11y = await page.evaluate(() => {
  const name = (el) =>
    (el.getAttribute('aria-label')
      || el.getAttribute('title')
      || el.textContent
      || el.getAttribute('placeholder')
      || '').trim();

  const unnamed = [...document.querySelectorAll('button, a[href], input, select')]
    .filter((el) => !name(el))
    .map((el) => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`);

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .map((h) => Number(h.tagName[1]));

  const skips = [];
  for (let i = 1; i < headings.length; i += 1) {
    if (headings[i] - headings[i - 1] > 1) skips.push(`${headings[i - 1]}->${headings[i]}`);
  }

  return {
    unnamed: [...new Set(unnamed)],
    headings,
    skips,
    imagesNoAlt: [...document.querySelectorAll('img')].filter((i) => !i.alt).length,
    langAttr: document.documentElement.lang || null,
    title: document.title,
  };
});
console.log('a11y:', JSON.stringify(a11y));
if (a11y.unnamed.length) add('a11y', `interactive elements with no accessible name: ${a11y.unnamed.join(', ')}`);
if (a11y.skips.length) add('a11y', `heading levels skipped: ${a11y.skips.join(', ')}`);
if (!a11y.langAttr) add('a11y', 'html has no lang attribute');
if (a11y.imagesNoAlt) add('a11y', `${a11y.imagesNoAlt} image(s) without alt`);

// Focus order: tab through and record what gets focus.
const focusOrder = [];
for (let i = 0; i < 6; i += 1) {
  await page.keyboard.press('Tab');
  focusOrder.push(await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}:${(el.textContent || '').trim().slice(0, 12)}` : 'none';
  }));
}
console.log('focus order:', focusOrder.join(' -> '));

const vitals = await page.evaluate(() => window.__vitals);
const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0];
  return n ? { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null;
});
const long = vitals.longTasks.filter((d) => d > 50);
console.log('vitals:', JSON.stringify({
  lcp: Math.round(vitals.lcp), cls: +vitals.cls.toFixed(4), longTasks: long, nav,
}));
if (vitals.lcp > 2500) add('perf', `LCP ${Math.round(vitals.lcp)}ms (> 2500ms)`);
if (vitals.cls > 0.1) add('perf', `CLS ${vitals.cls.toFixed(3)} (> 0.1)`);
if (long.length) add('perf', `${long.length} long task(s) > 50ms: ${long.slice(0, 5).join(', ')}ms`);

await page.screenshot({ path: `${OUT}/audit-1600.png` });
await page.context().close();

// --- 2. narrower viewport ---------------------------------------------------
console.log('\n=== annotator, 1280x800 ===');
page = await newPage(1280, 800);
await page.goto(`${BASE}/rec/${REC}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const overflow = await page.evaluate(() => ({
  bodyScrollW: document.body.scrollWidth,
  clientW: document.documentElement.clientWidth,
}));
console.log('overflow check:', JSON.stringify(overflow));
if (overflow.bodyScrollW > overflow.clientW + 2) {
  add('layout', `page scrolls horizontally at 1280 (${overflow.bodyScrollW} > ${overflow.clientW})`);
}
await page.screenshot({ path: `${OUT}/audit-1280.png` });
await page.context().close();

// --- 3. workbench -----------------------------------------------------------
console.log('\n=== workbench ===');
page = await newPage(1600, 950);
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/audit-workbench.png` });
await page.context().close();

await browser.close();

console.log(`\n=== findings (${findings.length}) ===`);
const seen = new Set();
for (const f of findings) {
  if (seen.has(f)) continue;
  seen.add(f);
  console.log(f);
}
if (!findings.length) console.log('clean');
