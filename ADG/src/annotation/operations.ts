/**
 * The correction vocabulary: split, merge, reassign, nudge.
 *
 * These are the actions the tool exists for. The previous version was built
 * around drawing new segments on an empty track, which is the rare case --
 * DiariZen produces the segments and a human fixes them.
 *
 * Every function is pure and returns new arrays, which is what makes undo a
 * matter of keeping the previous value rather than inverting an operation.
 */

import type { Segment, Speaker } from '../types';

/** Anything shorter than this is not a segment anyone meant to create. */
export const MIN_DURATION = 0.02;

let idCounter = 0;

/** Client-side id for a segment that does not exist on the server yet. */
export function tempId(): string {
  idCounter += 1;
  return `tmp-${idCounter}`;
}

export function resetIdCounter(): void {
  idCounter = 0;
}

export type Edge = 'start' | 'end';

export function byTime(segments: Segment[]): Segment[] {
  return [...segments].sort(
    (a, b) => a.start_sec - b.start_sec || a.speaker_label.localeCompare(b.speaker_label),
  );
}

export function find(segments: Segment[], id: string): Segment | undefined {
  return segments.find((s) => s.id === id);
}

/**
 * Next segment in time order across all speakers.
 *
 * Traversal is global rather than per-speaker because the correction loop is
 * "listen, judge, fix, next" down the recording, not one speaker at a time.
 */
export function nextSegment(segments: Segment[], id: string | null): Segment | undefined {
  const ordered = byTime(segments);
  if (!id) return ordered[0];
  const i = ordered.findIndex((s) => s.id === id);
  return i < 0 ? ordered[0] : ordered[i + 1];
}

export function prevSegment(segments: Segment[], id: string | null): Segment | undefined {
  const ordered = byTime(segments);
  if (!id) return ordered[ordered.length - 1];
  const i = ordered.findIndex((s) => s.id === id);
  return i <= 0 ? undefined : ordered[i - 1];
}

export function segmentAt(segments: Segment[], time: number, label?: string): Segment | undefined {
  return byTime(segments).find(
    (s) =>
      s.start_sec <= time &&
      time < s.end_sec &&
      (label === undefined || s.speaker_label === label),
  );
}

/** Split at `time`. Returns the original list unchanged if the cut misses. */
export function splitSegment(
  segments: Segment[],
  id: string,
  time: number,
): { segments: Segment[]; newId: string | null } {
  const target = find(segments, id);
  if (!target) return { segments, newId: null };

  // Both halves have to survive the minimum, or this is a mis-click near an
  // edge rather than a split.
  if (time - target.start_sec < MIN_DURATION || target.end_sec - time < MIN_DURATION) {
    return { segments, newId: null };
  }

  const newId = tempId();
  const left: Segment = { ...target, end_sec: time };
  const right: Segment = { ...target, id: newId, start_sec: time, text: '' };

  return {
    segments: segments.flatMap((s) => (s.id === id ? [left, right] : [s])),
    newId,
  };
}

/**
 * Absorb the next segment of the same speaker.
 *
 * The gap between them is swallowed deliberately: DiariZen splits a single
 * utterance at every short pause, and closing those is the most common repair
 * after fixing speaker identity.
 */
export function mergeWithNext(segments: Segment[], id: string): Segment[] {
  const target = find(segments, id);
  if (!target) return segments;

  const successor = byTime(segments).find(
    (s) => s.speaker_label === target.speaker_label && s.start_sec >= target.start_sec && s.id !== id,
  );
  if (!successor) return segments;

  const merged: Segment = {
    ...target,
    end_sec: Math.max(target.end_sec, successor.end_sec),
    text: [target.text, successor.text].filter(Boolean).join(' '),
  };

  return segments.filter((s) => s.id !== successor.id).map((s) => (s.id === id ? merged : s));
}

export function reassignSpeaker(segments: Segment[], id: string, label: string): Segment[] {
  return segments.map((s) => (s.id === id ? { ...s, speaker_label: label } : s));
}

/**
 * Move one edge to an absolute time, clamped so the segment stays valid.
 * Used by both "snap to playhead" and dragging.
 */
export function setBoundary(
  segments: Segment[],
  id: string,
  edge: Edge,
  time: number,
  duration: number,
): Segment[] {
  return segments.map((s) => {
    if (s.id !== id) return s;
    if (edge === 'start') {
      const start = Math.max(0, Math.min(time, s.end_sec - MIN_DURATION));
      return { ...s, start_sec: start };
    }
    const end = Math.min(duration, Math.max(time, s.start_sec + MIN_DURATION));
    return { ...s, end_sec: end };
  });
}

export function nudgeBoundary(
  segments: Segment[],
  id: string,
  edge: Edge,
  delta: number,
  duration: number,
): Segment[] {
  const target = find(segments, id);
  if (!target) return segments;
  const current = edge === 'start' ? target.start_sec : target.end_sec;
  return setBoundary(segments, id, edge, current + delta, duration);
}

/** Move the whole segment, keeping its length, clamped to the audio. */
export function moveSegment(
  segments: Segment[],
  id: string,
  delta: number,
  duration: number,
): Segment[] {
  return segments.map((s) => {
    if (s.id !== id) return s;
    const length = s.end_sec - s.start_sec;
    const start = Math.max(0, Math.min(s.start_sec + delta, duration - length));
    return { ...s, start_sec: start, end_sec: start + length };
  });
}

export function deleteSegment(segments: Segment[], id: string): Segment[] {
  return segments.filter((s) => s.id !== id);
}

export function createSegment(
  segments: Segment[],
  label: string,
  start: number,
  end: number,
): { segments: Segment[]; newId: string | null } {
  if (end - start < MIN_DURATION) return { segments, newId: null };
  const newId = tempId();
  return {
    segments: [
      ...segments,
      {
        id: newId, speaker_label: label, start_sec: start, end_sec: end, text: '', is_stable: false,
      },
    ],
    newId,
  };
}

/** Flag (or unflag) a segment as this speaker's reference audio. */
export function toggleStable(segments: Segment[], id: string): Segment[] {
  return segments.map((s) => (s.id === id ? { ...s, is_stable: !s.is_stable } : s));
}

/**
 * Replace a segment's speaker assignment with `labels` (checked speakers).
 *
 * One label is a plain reassign (kept by N=1 for parity with reassignSpeaker).
 * Several labels mark OVERLAPPING speech: the window belongs to every checked
 * speaker at once, which this system records as one segment per speaker
 * sharing the same time range. The original row keeps its id when its speaker
 * is among the checked set, so a boundary later moved on it stays one gesture;
 * the added speakers get fresh temp ids.
 *
 * Empty labels is a no-op: checking nothing cannot mean anything useful.
 */
export function reassignToSpeakers(
  segments: Segment[],
  id: string,
  labels: string[],
): Segment[] {
  const target = find(segments, id);
  if (!target || labels.length === 0) return segments;

  const unique = [...new Set(labels)];
  if (unique.length === 1) return reassignSpeaker(segments, id, unique[0]);

  const ownLabel = target.speaker_label;
  const replaced = unique.map((label) =>
    label === ownLabel
      ? { ...target } // the original row stays in place: id, stable flag, text
      : {
          ...target,
          id: tempId(),
          speaker_label: label,
          // A copy is not the original speaker's reference audio; flagging it
          // would silently extend that speaker's stable set.
          is_stable: false,
        },
  );

  return segments.flatMap((s) => (s.id === id ? replaced : [s]));
}

/**
 * Join overlapping or touching segments of one speaker into single spans.
 *
 * A person is either speaking or not, so one speaker overlapping themselves is
 * not a thing the reference should contain -- it would double-count speech time
 * during scoring. Returns the count so the caller can say what happened rather
 * than quietly rewriting the annotation.
 */
export function coalesceSpeaker(
  segments: Segment[],
  label: string,
): { segments: Segment[]; merged: number } {
  const mine = byTime(segments.filter((s) => s.speaker_label === label));
  const others = segments.filter((s) => s.speaker_label !== label);
  if (mine.length < 2) return { segments, merged: 0 };

  const out: Segment[] = [];
  let merged = 0;

  for (const seg of mine) {
    const last = out[out.length - 1];
    if (last && seg.start_sec <= last.end_sec) {
      last.end_sec = Math.max(last.end_sec, seg.end_sec);
      last.text = [last.text, seg.text].filter(Boolean).join(' ');
      merged += 1;
    } else {
      out.push({ ...seg });
    }
  }

  return { segments: [...others, ...out], merged };
}

/**
 * Fold one speaker into another.
 *
 * The most frequent repair there is: VBx clustering cannot be told how many
 * speakers to find, so it routinely splits one person across two labels.
 */
export function mergeSpeakers(
  speakers: Speaker[],
  segments: Segment[],
  fromLabel: string,
  intoLabel: string,
): { speakers: Speaker[]; segments: Segment[]; merged: number } {
  if (fromLabel === intoLabel) return { speakers, segments, merged: 0 };

  const moved = segments.map((s) =>
    s.speaker_label === fromLabel ? { ...s, speaker_label: intoLabel } : s,
  );
  const { segments: coalesced, merged } = coalesceSpeaker(moved, intoLabel);

  return {
    speakers: speakers.filter((s) => s.label !== fromLabel),
    segments: coalesced,
    merged,
  };
}

/**
 * The next speaker a correction gets assigned to: first free integer label
 * (labels come from DiariZen and must stay stable for re-run comparison, so a
 * new one has to avoid every label already in use, even a sparse set after a
 * merge), a display name mirroring the server's convention, and the palette
 * colour that would have gone to this slot.
 */
function freshSpeaker(
  speakers: Speaker[],
  palette: readonly string[],
): Speaker {
  const used = new Set(speakers.map((s) => s.label));
  let n = speakers.length;
  let label = String(n);
  while (used.has(label)) {
    n += 1;
    label = String(n);
  }

  return {
    label,
    name: `说话人 ${label}`,
    color: palette[speakers.length % palette.length],
    sort_order: speakers.length,
  };
}

/**
 * Add an empty speaker: a lane with no segments, ready for drawing or
 * reassignment by number key. This is how a person DiariZen never placed
 * anywhere gets introduced.
 */
export function createSpeaker(
  speakers: Speaker[],
  palette: readonly string[],
): { speakers: Speaker[]; speaker: Speaker } {
  const speaker = freshSpeaker(speakers, palette);
  return { speakers: [...speakers, speaker], speaker };
}

/** Move chosen segments to a brand-new speaker (the inverse of a bad merge). */
export function splitSpeaker(
  speakers: Speaker[],
  segments: Segment[],
  segmentIds: string[],
  palette: readonly string[],
): { speakers: Speaker[]; segments: Segment[]; label: string } {
  const speaker = freshSpeaker(speakers, palette);
  const ids = new Set(segmentIds);

  return {
    speakers: [...speakers, speaker],
    segments: segments.map((s) => (s.id && ids.has(s.id) ? { ...s, speaker_label: speaker.label } : s)),
    label: speaker.label,
  };
}

export function renameSpeaker(speakers: Speaker[], label: string, name: string): Speaker[] {
  return speakers.map((s) => (s.label === label ? { ...s, name } : s));
}

/** Total speech time, counting overlap once -- the usual sanity figure. */
export function speechDuration(segments: Segment[]): number {
  const ordered = byTime(segments);
  let total = 0;
  let cursor = -Infinity;

  for (const s of ordered) {
    const start = Math.max(s.start_sec, cursor);
    if (s.end_sec > start) {
      total += s.end_sec - start;
      cursor = s.end_sec;
    }
  }
  return total;
}
