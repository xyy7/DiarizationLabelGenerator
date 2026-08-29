import { beforeEach, describe, expect, it } from 'vitest';

import { canRedo, canUndo, initialState, MAX_HISTORY, reducer } from './reducer';
import type { Action, EditState } from './reducer';
import { resetIdCounter } from './operations';
import type { Segment, Speaker } from '../types';

const SPEAKERS: Speaker[] = [
  { label: '0', name: 'A', color: '#a', sort_order: 0 },
  { label: '1', name: 'B', color: '#b', sort_order: 1 },
];

const SEGMENTS: Segment[] = [
  { id: 'a', speaker_label: '0', start_sec: 1, end_sec: 5, text: '', is_stable: false },
  { id: 'b', speaker_label: '1', start_sec: 6, end_sec: 9, text: '', is_stable: false },
];

function loaded(): EditState {
  return reducer(initialState, {
    type: 'LOAD', speakers: SPEAKERS, segments: SEGMENTS, version: 3, duration: 30,
  });
}

function run(state: EditState, ...actions: Action[]): EditState {
  return actions.reduce(reducer, state);
}

beforeEach(() => resetIdCounter());

describe('speaker identification edits', () => {
  it('reassigns to several speakers as one undoable step', () => {
    const state = run(loaded(), { type: 'REASSIGN_MULTI', id: 'a', labels: ['1', '0'] });

    // Same window on two speakers: overlap is expressed as coexisting rows.
    expect(state.segments.filter((s) => s.start_sec === 1 && s.end_sec === 5))
      .toHaveLength(2);
    expect(state.dirty).toBe(true);
    expect(state.notice).toContain('重叠');
    expect(reducer(state, { type: 'UNDO' }).segments).toEqual(SEGMENTS);
  });

  it('toggling stable is undoable and announced', () => {
    const state = run(loaded(), { type: 'TOGGLE_STABLE', id: 'a' });

    expect(state.segments.find((s) => s.id === 'a')?.is_stable).toBe(true);
    expect(state.notice).toContain('稳定音频');
    expect(reducer(state, { type: 'UNDO' }).segments).toEqual(SEGMENTS);
  });

  it('overlapping rows are editable independently afterwards', () => {
    const state = run(
      loaded(),
      { type: 'REASSIGN_MULTI', id: 'a', labels: ['1', '0'] },
      { type: 'SET_BOUNDARY', id: 'a', edge: 'end', time: 4 },
    );

    // The original row moved; the copy to speaker 1 kept the old boundary.
    const original = state.segments.find((s) => s.id === 'a');
    const copy = state.segments.find((s) => s.speaker_label === '1' && s.start_sec === 1);
    expect(original?.end_sec).toBe(4);
    expect(copy?.end_sec).toBe(5);
  });
});

describe('loading', () => {
  it('starts clean with no history', () => {
    const state = loaded();

    expect(state.version).toBe(3);
    expect(state.dirty).toBe(false);
    expect(canUndo(state)).toBe(false);
  });

  it('marks the buffer clean again after a save', () => {
    const state = run(loaded(), { type: 'REASSIGN', id: 'a', label: '1' });

    expect(state.dirty).toBe(true);
    expect(reducer(state, { type: 'SAVED', version: 4 })).toMatchObject({
      version: 4, dirty: false,
    });
  });
});

describe('undo and redo', () => {
  it('takes back an edit', () => {
    const edited = run(loaded(), { type: 'REASSIGN', id: 'a', label: '1' });
    const undone = reducer(edited, { type: 'UNDO' });

    expect(undone.segments.find((s) => s.id === 'a')?.speaker_label).toBe('0');
    expect(canRedo(undone)).toBe(true);
  });

  it('puts it back', () => {
    const state = run(
      loaded(),
      { type: 'REASSIGN', id: 'a', label: '1' },
      { type: 'UNDO' },
      { type: 'REDO' },
    );

    expect(state.segments.find((s) => s.id === 'a')?.speaker_label).toBe('1');
  });

  it('does nothing at the ends of history', () => {
    const state = loaded();

    expect(reducer(state, { type: 'UNDO' })).toBe(state);
    expect(reducer(state, { type: 'REDO' })).toBe(state);
  });

  it('discards the redo branch once a new edit lands', () => {
    const state = run(
      loaded(),
      { type: 'REASSIGN', id: 'a', label: '1' },
      { type: 'UNDO' },
      { type: 'DELETE', id: 'b' },
    );

    expect(canRedo(state)).toBe(false);
  });

  it('restores a deleted segment', () => {
    const state = run(loaded(), { type: 'DELETE', id: 'a' }, { type: 'UNDO' });

    expect(state.segments).toHaveLength(2);
  });

  it('caps history so a long session cannot grow without bound', () => {
    let state = loaded();
    for (let i = 0; i < MAX_HISTORY + 50; i += 1) {
      state = reducer(state, { type: 'REASSIGN', id: 'a', label: i % 2 ? '0' : '1' });
    }

    expect(state.past.length).toBe(MAX_HISTORY);
  });
});

describe('selection', () => {
  it('is not an edit', () => {
    // Selecting while listening must not fill the undo stack or make the
    // buffer look unsaved.
    const state = reducer(loaded(), { type: 'SELECT', id: 'a' });

    expect(state.selectedId).toBe('a');
    expect(state.dirty).toBe(false);
    expect(canUndo(state)).toBe(false);
  });

  it('clears when the selected segment is deleted', () => {
    const state = run(loaded(), { type: 'SELECT', id: 'a' }, { type: 'DELETE', id: 'a' });

    expect(state.selectedId).toBeNull();
  });
});

describe('coalescing', () => {
  it('folds a run of nudges into a single undo step', () => {
    // Holding the nudge key must not bury the previous real action.
    let state = run(loaded(), { type: 'REASSIGN', id: 'a', label: '1' });
    const historyBefore = state.past.length;

    for (let i = 0; i < 20; i += 1) {
      state = reducer(state, { type: 'NUDGE', id: 'a', edge: 'end', delta: 0.01 });
    }

    expect(state.past.length).toBe(historyBefore + 1);
  });

  it('one undo takes back the whole run', () => {
    let state = loaded();
    for (let i = 0; i < 5; i += 1) {
      state = reducer(state, { type: 'NUDGE', id: 'a', edge: 'end', delta: 0.1 });
    }

    const undone = reducer(state, { type: 'UNDO' });

    expect(undone.segments.find((s) => s.id === 'a')?.end_sec).toBe(5);
  });

  it('starts a new step when the gesture changes', () => {
    const state = run(
      loaded(),
      { type: 'NUDGE', id: 'a', edge: 'end', delta: 0.1 },
      { type: 'NUDGE', id: 'a', edge: 'start', delta: 0.1 },
    );

    expect(state.past.length).toBe(2);
  });

  it('breaks the run when the user selects something', () => {
    const state = run(
      loaded(),
      { type: 'NUDGE', id: 'a', edge: 'end', delta: 0.1 },
      { type: 'SELECT', id: 'b' },
      { type: 'NUDGE', id: 'a', edge: 'end', delta: 0.1 },
    );

    expect(state.past.length).toBe(2);
  });
});

describe('split and merge', () => {
  it('selects the right-hand half after a split', () => {
    // The annotator is working forwards through the recording.
    const state = reducer(loaded(), { type: 'SPLIT', id: 'a', time: 3 });

    expect(state.segments).toHaveLength(3);
    expect(state.selectedId).not.toBe('a');
    expect(state.segments.find((s) => s.id === state.selectedId)).toMatchObject({
      start_sec: 3, end_sec: 5,
    });
  });

  it('ignores a split that would leave a sliver', () => {
    const state = loaded();

    expect(reducer(state, { type: 'SPLIT', id: 'a', time: 1.001 })).toBe(state);
  });
});

describe('speaker operations', () => {
  it('reports when merging speakers coalesced overlaps', () => {
    const state = reducer(
      { ...loaded(), segments: [
        { id: 'a', speaker_label: '0', start_sec: 1, end_sec: 6, text: '', is_stable: false },
        { id: 'b', speaker_label: '1', start_sec: 4, end_sec: 8, text: '', is_stable: false },
      ] },
      { type: 'MERGE_SPEAKERS', from: '1', into: '0' },
    );

    expect(state.speakers).toHaveLength(1);
    expect(state.notice).toContain('1');
  });

  it('says nothing when there was nothing to coalesce', () => {
    const state = reducer(loaded(), { type: 'MERGE_SPEAKERS', from: '1', into: '0' });

    expect(state.notice).toBeNull();
  });

  it('undoes a speaker merge completely', () => {
    const state = run(
      loaded(),
      { type: 'MERGE_SPEAKERS', from: '1', into: '0' },
      { type: 'UNDO' },
    );

    expect(state.speakers).toHaveLength(2);
    expect(state.segments.find((s) => s.id === 'b')?.speaker_label).toBe('1');
  });

  it('creates an empty speaker for someone DiariZen never placed', () => {
    const state = run(loaded(), { type: 'CREATE_SPEAKER', palette: ['#a', '#b', '#c'] });

    expect(state.speakers).toHaveLength(3);
    expect(state.speakers[2]).toMatchObject({
      label: '2', name: '说话人 2', color: '#c', sort_order: 2,
    });
    expect(state.dirty).toBe(true);
    expect(state.notice).toContain('（数字键 3）');
  });

  it('skips sparse labels left behind by a merge', () => {
    // labels 0,1,2 with "1" merged into "0" leaves a sparse set {0,2}; a new
    // speaker must not reuse "2" because DiariZen re-runs are compared
    // against these labels.
    const state = run(
      { ...loaded(), speakers: [...SPEAKERS, { label: '2', name: 'C', color: '#c', sort_order: 2 }] },
      { type: 'MERGE_SPEAKERS', from: '1', into: '0' },
      { type: 'CREATE_SPEAKER', palette: ['#a', '#b', '#c'] },
    );

    expect(state.speakers.map((s) => s.label)).toEqual(['0', '2', '3']);
  });

  it('splits the selected segment into a brand-new speaker', () => {
    // The inverse of a bad merge: VBx put two people under one label, the
    // annotator picks the clip of the second one and presses N.
    const state = run(
      loaded(),
      { type: 'SELECT', id: 'b' },
      { type: 'SPLIT_SPEAKER', segmentIds: ['b'], palette: ['#a', '#b', '#c'] },
    );

    expect(state.speakers).toHaveLength(3);
    expect(state.segments.find((s) => s.id === 'b')?.speaker_label).toBe('2');
    expect(state.segments.find((s) => s.id === 'a')?.speaker_label).toBe('0');
    expect(state.notice).toContain('数字键 3');
  });

  it('undoes a split speaker', () => {
    const state = run(
      loaded(),
      { type: 'SPLIT_SPEAKER', segmentIds: ['b'], palette: ['#a', '#b', '#c'] },
      { type: 'UNDO' },
    );

    expect(state.speakers).toHaveLength(2);
    expect(state.segments.find((s) => s.id === 'b')?.speaker_label).toBe('1');
  });
});
