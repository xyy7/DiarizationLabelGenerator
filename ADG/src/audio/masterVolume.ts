/**
 * Master playback volume with digital gain beyond 100%.
 *
 * Native <audio>.volume is spec-clamped to 1.0 -- 100% is the ceiling. The
 * "500%" in video sites is digital gain: the element is routed through a
 * WebAudio GainNode above 1.0, plus a limiter so the overshoot does not clip
 * the output apart.
 *
 * DESIGN RULE: the default (100%) NEVER touches WebAudio. Routing a media
 * element into an audio graph carries risk -- a suspended AudioContext plays
 * SILENTLY, among others -- and the annotator's existing playback worked fine
 * natively. The graph engages only when the user explicitly pushes the boost
 * above 100%, and everything then runs through one shared gain: the timeline
 * player (wavesurfer) and the similarity panel's <audio> are both routed to
 * the SAME gain/limiter nodes, so one slider governs both.
 */

export const BOOST_MIN = 50; // percent
export const BOOST_MAX = 500;

const BOOST_KEY = 'adg_boost';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let limiter: DynamicsCompressorNode | null = null;
// Elements known to us. routed: element currently in the gain graph.
const known = new Set<HTMLMediaElement>();
let boost = initialBoost();

function initialBoost(): number {
  try {
    const v = Number(localStorage.getItem(BOOST_KEY));
    return Number.isFinite(v) && v >= BOOST_MIN / 100 && v <= BOOST_MAX / 100
      ? v
      : 1;
  } catch {
    return 1;
  }
}

function ensureChain(): AudioContext {
  if (!ctx || !master || !limiter) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
    limiter = ctx.createDynamicsCompressor();
    // A hard-knee, fast-attack limiter: the job is not tone shaping, only
    // keeping gain-boosted peaks from clipping.
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master = ctx.createGain();
    master.gain.value = boost;
    master.connect(limiter);
    limiter.connect(ctx.destination);
  }
  return ctx;
}

// An element gets exactly one MediaElementAudioSourceNode for its lifetime
// (the spec forbids creating a second one); once routed it stays in the graph
// and its level is the shared master gain. The set must be consulted before
// re-routing, or a slider drag -- dozens of setBoost calls -- would throw on
// the second call and silently freeze the gain at the first value it saw.
const routed = new WeakSet<HTMLMediaElement>();

function route(el: HTMLMediaElement): void {
  if (routed.has(el)) return;
  const context = ensureChain();
  try {
    const source = context.createMediaElementSource(el);
    source.connect(master!);
    routed.add(el);
    el.volume = 1; // the gain chain is the single level control
  } catch {
    // Some browser/state combination refuses the re-route. Never leave the
    // element muted because of it.
    el.volume = Math.min(1, boost);
  }
}

function applyLevel(): void {
  if (boost > 1) {
    for (const el of known) route(el);
  } else if (master) {
    // Already routed elements cannot be un-routed (the spec forbids it);
    // the graph itself becomes the level control, with gain ≤ 1.
    master.gain.value = boost;
    return;
  } else {
    for (const el of known) el.volume = boost;
    return;
  }
  // boost > 1: the level always follows the slider, even mid-engagement --
  // every extra route() call above is a no-op, so set the gain here.
  if (master) master.gain.value = boost;
}

/** Register an element. Idempotent. At ≤100% this only sets nothing but the
 * native volume -- no audio graph exists at all. */
export function attach(el: HTMLMediaElement): void {
  known.add(el);
  if (boost > 1) {
    route(el);
  } else {
    el.volume = boost;
  }
}

/** Forget a dead element. Call from the owning component's cleanup: an
 * unmounted <audio> must not keep a strong reference (nor a MediaElement
 * source) live for the rest of the session. The graph connection itself is
 * irreversible, so this only frees the bookkeeping. */
export function detach(el: HTMLMediaElement): void {
  known.delete(el);
}

/** Resume the graph. Must run inside a user-gesture handler; no-op when the
 * graph was never engaged. */
export function resume(): void {
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
}

export function getBoost(): number {
  return boost;
}

export function setBoost(mult: number): void {
  boost = Math.min(
    BOOST_MAX / 100,
    Math.max(BOOST_MIN / 100, mult),
  );
  applyLevel();
  // The slider drag is a user gesture: a context left suspended would route
  // every element into SILENCE, so resume while the gesture is valid.
  resume();
  try {
    localStorage.setItem(BOOST_KEY, String(boost));
  } catch {
    /* private mode */
  }
}
