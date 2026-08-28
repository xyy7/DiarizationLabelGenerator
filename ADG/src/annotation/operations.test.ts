import { beforeEach, describe, expect, it } from 'vitest';

import * as ops from './operations';
import type { Segment, Speaker } from '../types';

const DURATION = 30;
const PALETTE = ['#a', '#b', '#c'] as const;

function seg(id: string, start: number, end: number, label = '0', text = ''): Segment {
  return { id, speaker_label: label, start_sec: start, end_sec: end, text };
}

function speaker(label: string): Speaker {
  return { label, name: `说话人 ${label}`, color: '#1890ff', sort_order: 0 };
}

beforeEach(() => ops.resetIdCounter());

describe('traversal', () => {
  const segments = [seg('b', 5, 6, '1'), seg('a', 1, 2, '0'), seg('c', 9, 10, '0')];

  it('orders by time regardless of speaker', () => {
    expect(ops.byTime(segments).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('walks forward across speakers', () => {
    // The correction loop runs down the recording, not one speaker at a time.
    expect(ops.nextSegment(segments, 'a')?.id).toBe('b');
    expect(ops.nextSegment(segments, 'c')).toBeUndefined();
    expect(ops.nextSegment(segments, null)?.id).toBe('a');
  });

  it('walks backward', () => {
    expect(ops.prevSegment(segments, 'b')?.id).toBe('a');
    expect(ops.prevSegment(segments, 'a')).toBeUndefined();
  });
});

describe('split', () => {
  it('cuts one segment into two', () => {
    const { segments, newId } = ops.splitSegment([seg('a', 1, 5)], 'a', 3);

    expect(newId).not.toBeNull();
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ id: 'a', start_sec: 1, end_sec: 3 });
    expect(segments[1]).toMatchObject({ start_sec: 3, end_sec: 5 });
  });

  it('refuses a cut that would leave a sliver', () => {
    const original = [seg('a', 1, 5)];

    expect(ops.splitSegment(original, 'a', 1.001).newId).toBeNull();
    expect(ops.splitSegment(original, 'a', 4.999).newId).toBeNull();
  });

  it('does not carry text into the new half', () => {
    const { segments } = ops.splitSegment([seg('a', 1, 5, '0', 'hello')], 'a', 3);

    expect(segments[0].text).toBe('hello');
    expect(segments[1].text).toBe('');
  });
});

describe('merge with next', () => {
  it('swallows the gap to the next segment of the same speaker', () => {
    // DiariZen splits an utterance at every short pause; closing those is the
    // most common repair.
    const segments = ops.mergeWithNext([seg('a', 1, 2), seg('b', 2.4, 3)], 'a');

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ id: 'a', start_sec: 1, end_sec: 3 });
  });

  it('ignores segments belonging to someone else', () => {
    const original = [seg('a', 1, 2, '0'), seg('b', 3, 4, '1')];

    expect(ops.mergeWithNext(original, 'a')).toBe(original);
  });

  it('joins the text of both', () => {
    const segments = ops.mergeWithNext(
      [seg('a', 1, 2, '0', '你好'), seg('b', 3, 4, '0', '世界')], 'a',
    );

    expect(segments[0].text).toBe('你好 世界');
  });
});

describe('boundaries', () => {
  it('snaps an edge to a time', () => {
    const segments = ops.setBoundary([seg('a', 1, 5)], 'a', 'start', 2.5, DURATION);

    expect(segments[0].start_sec).toBe(2.5);
  });

  it('will not let an edge cross its partner', () => {
    const segments = ops.setBoundary([seg('a', 1, 5)], 'a', 'start', 9, DURATION);

    expect(segments[0].start_sec).toBeCloseTo(5 - ops.MIN_DURATION);
  });

  it('clamps to the end of the audio', () => {
    const segments = ops.setBoundary([seg('a', 1, 5)], 'a', 'end', 99, DURATION);

    expect(segments[0].end_sec).toBe(DURATION);
  });

  it('nudges by a delta', () => {
    const segments = ops.nudgeBoundary([seg('a', 1, 5)], 'a', 'end', -0.01, DURATION);

    expect(segments[0].end_sec).toBeCloseTo(4.99);
  });
});

describe('move', () => {
  it('keeps the length', () => {
    const segments = ops.moveSegment([seg('a', 1, 5)], 'a', 2, DURATION);

    expect(segments[0]).toMatchObject({ start_sec: 3, end_sec: 7 });
  });

  it('stops at both ends of the audio', () => {
    expect(ops.moveSegment([seg('a', 1, 5)], 'a', -99, DURATION)[0])
      .toMatchObject({ start_sec: 0, end_sec: 4 });
    expect(ops.moveSegment([seg('a', 1, 5)], 'a', 99, DURATION)[0])
      .toMatchObject({ start_sec: 26, end_sec: 30 });
  });
});

describe('speaker merge', () => {
  const speakers = [speaker('0'), speaker('1')];

  it('folds one speaker into another and drops the label', () => {
    const result = ops.mergeSpeakers(speakers, [seg('a', 1, 2, '0'), seg('b', 5, 6, '1')], '1', '0');

    expect(result.speakers.map((s) => s.label)).toEqual(['0']);
    expect(result.segments.every((s) => s.speaker_label === '0')).toBe(true);
    expect(result.merged).toBe(0);
  });

  it('coalesces the self-overlap it creates, and says how much', () => {
    // One person cannot overlap themselves; leaving it would double-count
    // speech time during scoring.
    const result = ops.mergeSpeakers(
      speakers, [seg('a', 1, 6, '0'), seg('b', 4, 8, '1')], '1', '0',
    );

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start_sec: 1, end_sec: 8 });
    expect(result.merged).toBe(1);
  });

  it('leaves overlap between different speakers alone', () => {
    // Overlapping speech is the phenomenon being annotated.
    const result = ops.mergeSpeakers(
      [speaker('0'), speaker('1'), speaker('2')],
      [seg('a', 1, 6, '0'), seg('b', 4, 8, '1'), seg('c', 2, 9, '2')],
      '1', '0',
    );

    expect(result.segments.filter((s) => s.speaker_label === '2')).toHaveLength(1);
  });

  it('is a no-op when merging a speaker into itself', () => {
    const result = ops.mergeSpeakers(speakers, [seg('a', 1, 2, '0')], '0', '0');

    expect(result.speakers).toBe(speakers);
  });
});

describe('speaker split', () => {
  it('moves the chosen segments to a fresh label', () => {
    const result = ops.splitSpeaker(
      [speaker('0')], [seg('a', 1, 2, '0'), seg('b', 5, 6, '0')], ['b'], PALETTE,
    );

    expect(result.speakers).toHaveLength(2);
    expect(result.segments.find((s) => s.id === 'b')?.speaker_label).toBe(result.label);
    expect(result.segments.find((s) => s.id === 'a')?.speaker_label).toBe('0');
  });

  it('never reuses an existing label', () => {
    const result = ops.splitSpeaker(
      [speaker('0'), speaker('1')], [seg('a', 1, 2, '0')], ['a'], PALETTE,
    );

    expect(['0', '1']).not.toContain(result.label);
  });
});

describe('coalesce', () => {
  it('joins touching segments', () => {
    const { segments, merged } = ops.coalesceSpeaker([seg('a', 1, 3), seg('b', 3, 5)], '0');

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ start_sec: 1, end_sec: 5 });
    expect(merged).toBe(1);
  });

  it('leaves a real gap alone', () => {
    const { merged } = ops.coalesceSpeaker([seg('a', 1, 3), seg('b', 4, 5)], '0');

    expect(merged).toBe(0);
  });
});

describe('speech duration', () => {
  it('counts overlapping speech once', () => {
    const total = ops.speechDuration([seg('a', 0, 10, '0'), seg('b', 5, 15, '1')]);

    expect(total).toBe(15);
  });
});
