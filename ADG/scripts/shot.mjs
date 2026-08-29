/**
 * Screenshot helper. Format follows the output extension so the file's
 * contents and its name never disagree.
 *
 *   node scripts/shot.mjs <url> <outPath> [width] [height]
 */
import { chromium } from 'playwright-core';

const [, , url, out, w = '1440', h = '900'] = process.argv;
const type = out.toLowerCase().endsWith('.jpg') || out.toLowerCase().endsWith('.jpeg')
  ? 'jpeg' : 'png';

const b = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const c = await b.newContext({ viewport: { width: Number(w), height: Number(h) } });
await c.addInitScript(() => { try { localStorage.setItem('adg_user_name', 'shot'); } catch {} });
const p = await c.newPage();
await p.goto(url, { waitUntil: 'networkidle' });
await p.waitForTimeout(3000);
await p.screenshot({ path: out, ...(type === 'jpeg' ? { type, quality: 80 } : { type }) });
console.log(`wrote ${out} (${type})`);
await b.close();
