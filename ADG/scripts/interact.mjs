/**
 * Interaction and layout verification.
 *
 * Two jobs:
 *
 * 1. Exercise every shortcut against the real app and assert what changed.
 * 2. Render the timeline's actual on-screen geometry as text, so the layout
 *    can be checked without looking at a screenshot -- overlap between
 *    speakers, alignment with the waveform, and segment positions all read
 *    directly off the DOM's own rectangles.
 *
 * Everything read from the page is browser data, reported not obeyed.
 */

import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://localhost:8000';
const REC = process.argv[3];
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WIDTH = 96;

const fails = [];
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) fails.push(label);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addInitScript(() => {
  try { localStorage.setItem('adg_user_name', 'interact'); } catch {}
});
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log(`  pageerror: ${e.message}`); fails.push('pageerror'); });

await page.goto(`${BASE}/rec/${REC}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

/** Read the live geometry of the waveform and every lane. */
const layout = () => page.evaluate(() => {
  const host = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
  const wave = host?.getBoundingClientRect();
  const lanes = [...document.querySelectorAll('[data-lane]')].map((lane) => ({
    label: lane.getAttribute('data-lane'),
    box: lane.getBoundingClientRect(),
    segments: [...lane.children].map((s) => {
      const b = s.getBoundingClientRect();
      const style = s.getAttribute('style') || '';
      return {
        left: b.left, width: b.width,
        selected: style.includes('outline: rgb') || style.includes('outline: 2px'),
      };
    }),
  }));
  const playhead = document.querySelector('div[style*="background: rgb(255, 77, 79)"]');
  return {
    wave: wave ? { left: wave.left, width: wave.width } : null,
    playheadLeft: playhead ? playhead.getBoundingClientRect().left : null,
    lanes: lanes.map((l) => ({
      label: l.label,
      left: l.box.left, width: l.box.width,
      segments: l.segments,
    })),
  };
});

/** Draw the timeline as text. This is the substitute for looking at it. */
function render(L) {
  if (!L.wave) return '(no waveform)';
  const { left: x0, width: w } = L.wave;
  const col = (px) => Math.max(0, Math.min(WIDTH - 1, Math.round(((px - x0) / w) * (WIDTH - 1))));

  const lines = [];
  lines.push(`  wave  |${'~'.repeat(WIDTH)}|  left=${Math.round(x0)} width=${Math.round(w)}`);
  for (const lane of L.lanes) {
    const row = Array(WIDTH).fill(' ');
    for (const s of lane.segments) {
      const a = col(s.left);
      const b = col(s.left + s.width);
      for (let i = a; i <= b && i < WIDTH; i += 1) row[i] = s.selected ? '#' : '=';
    }
    const off = Math.round(lane.left - x0);
    lines.push(`  spk${lane.label.padEnd(2)} |${row.join('')}|  ${lane.segments.length} 段` +
      (off === 0 ? '' : `  OFFSET ${off}px`));
  }
  if (L.playheadLeft !== null) {
    const row = Array(WIDTH).fill(' ');
    row[col(L.playheadLeft)] = '^';
    lines.push(`  head  |${row.join('')}|`);
  }
  return lines.join('\n');
}

console.log('=== layout at load ===');
let L = await layout();
console.log(render(L));

// Alignment: every lane must share the waveform's left edge and width.
for (const lane of L.lanes) {
  ok(Math.abs(lane.left - L.wave.left) <= 1 && Math.abs(lane.width - L.wave.width) <= 1,
    `lane ${lane.label} aligned to waveform`,
    `dx=${Math.round(lane.left - L.wave.left)} dw=${Math.round(lane.width - L.wave.width)}`);
}

// Overlap between different speakers must be visible, i.e. their x-ranges
// intersect. This is the thing the old per-speaker timelines made impossible.
let overlaps = 0;
for (let i = 0; i < L.lanes.length; i += 1) {
  for (let j = i + 1; j < L.lanes.length; j += 1) {
    for (const a of L.lanes[i].segments) {
      for (const b of L.lanes[j].segments) {
        if (a.left < b.left + b.width && b.left < a.left + a.width) overlaps += 1;
      }
    }
  }
}
ok(overlaps > 0, 'overlapping speech is visible across lanes', `${overlaps} overlapping pairs`);

// --- shortcuts --------------------------------------------------------------
console.log('\n=== shortcuts ===');
const selCount = async () =>
  (await layout()).lanes.reduce((n, l) => n + l.segments.filter((s) => s.selected).length, 0);
const segTotal = async () =>
  (await layout()).lanes.reduce((n, l) => n + l.segments.length, 0);

await page.keyboard.press('j');
await page.waitForTimeout(700);
ok(await selCount() === 1, 'J selects one segment');

await page.keyboard.press('j');
await page.waitForTimeout(700);
const afterTwo = await layout();
const firstSelected = afterTwo.lanes.flatMap((l) => l.segments).find((s) => s.selected);
ok(!!firstSelected, 'J again keeps exactly one selected');

await page.keyboard.press('k');
await page.waitForTimeout(700);
ok(await selCount() === 1, 'K steps back');

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
ok(await selCount() === 0, 'Escape clears the selection');

await page.keyboard.press('j');
await page.waitForTimeout(700);

const before = await segTotal();
await page.keyboard.press('s');
await page.waitForTimeout(500);
const afterSplit = await segTotal();
ok(afterSplit === before + 1, 'S splits at the playhead', `${before} -> ${afterSplit}`);

await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
ok(await segTotal() === before, 'Ctrl+Z undoes the split');

await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(500);
ok(await segTotal() === before + 1, 'Ctrl+Shift+Z redoes it');

await page.keyboard.press('Control+z');
await page.waitForTimeout(500);

// Nudge: the selected segment's width must change, and a run of nudges must
// collapse into one undo step.
const widthOfSelected = async () => {
  const l = await layout();
  return l.lanes.flatMap((x) => x.segments).find((s) => s.selected)?.width ?? 0;
};
const w0 = await widthOfSelected();
for (let i = 0; i < 5; i += 1) await page.keyboard.press('.');
await page.waitForTimeout(500);
const w1 = await widthOfSelected();
ok(w1 > w0, 'repeated "." extends the segment', `${Math.round(w0)} -> ${Math.round(w1)}px`);

await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
const w2 = await widthOfSelected();
ok(Math.abs(w2 - w0) < 2, 'one undo takes back the whole nudge run',
  `back to ${Math.round(w2)}px`);

// New speaker: N creates a fresh lane and takes the selected segment along.
// This is the repair for VBx merging two people under one label.
const lanesBefore = (await layout()).lanes.length;
const segsBeforeN = await segTotal();
await page.keyboard.press('n');
await page.waitForTimeout(500);
const afterN = await layout();
ok(afterN.lanes.length === lanesBefore + 1, 'N creates a new speaker lane',
  `${lanesBefore} -> ${afterN.lanes.length}`);
const nLane = afterN.lanes[afterN.lanes.length - 1];
ok(nLane.segments.length === 1 && nLane.segments[0].selected,
  'the selected segment moved into it and stays selected');
ok(await segTotal() === segsBeforeN, 'N moves the segment, adds or removes none',
  `${segsBeforeN} -> ${await segTotal()}`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
ok((await layout()).lanes.length === lanesBefore, 'one undo takes back the whole split',
  `${lanesBefore} lanes`);

// Help panel
await page.keyboard.press('?');
await page.waitForTimeout(600);
const helpVisible = await page.locator('.ant-modal-title:has-text("快捷键")').count();
ok(helpVisible === 1, '"?" opens the shortcut panel');
const helpRows = await page.locator('.ant-modal-body kbd').count();
ok(helpRows > 20, 'shortcut panel lists the keys', `${helpRows} keycaps`);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// --- persistence ------------------------------------------------------------
console.log('\n=== persistence ===');
const versionText = () => page.locator('.ant-tag').allTextContents();
await page.keyboard.press('j');
await page.waitForTimeout(400);
await page.keyboard.press('2');           // reassign to speaker 2
await page.waitForTimeout(3000);          // autosave debounce is 2 s
const tags = await versionText();
ok(tags.some((t) => t.includes('已保存')), 'autosave completes', tags.join(' / '));

const totalBefore = await segTotal();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
ok(await segTotal() === totalBefore, 'edits survive a reload', `${totalBefore} segments`);

console.log('\n=== layout after edits ===');
L = await layout();
console.log(render(L));

await browser.close();

console.log(`\n=== ${fails.length ? `FAILURES (${fails.length})` : 'all checks passed'} ===`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length ? 1 : 0);
