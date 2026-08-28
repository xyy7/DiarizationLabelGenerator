/**
 * Editing state with undo/redo.
 *
 * Undo is not a nicety here. Correction work is a long sequence of small
 * destructive edits -- reassign, split, merge, nudge -- and without a way back
 * every mistake costs the annotator their place in the recording. It was one
 * of the stated problems with the previous version.
 *
 * History holds whole snapshots rather than inverse operations. A snapshot is
 * two arrays of a few hundred small objects; the simplicity is worth far more
 * than the bytes.
 */

import * as ops from './operations';
import type { Segment, Speaker } from '../types';

export interface Snapshot {
  speakers: Speaker[];
  segments: Segment[];
  selectedId: string | null;
}

export interface EditState extends Snapshot {
  /** Server version this edit buffer descends from. */
  version: number;
  duration: number;
  past: Snapshot[];
  future: Snapshot[];
  /** Unsaved changes exist. */
  dirty: boolean;
  /**
   * Groups consecutive same-kind edits into one undo step, so holding a nudge
   * key does not bury the previous real action under fifty entries.
   */
  lastCoalesceKey: string | null;
  /** Reported by the last operation, for a transient notice in the UI. */
  notice: string | null;
}

export type Action =
  | { type: 'LOAD'; speakers: Speaker[]; segments: Segment[]; version: number; duration: number }
  | { type: 'SAVED'; version: number }
  | { type: 'SELECT'; id: string | null }
  | { type: 'SPLIT'; id: string; time: number }
  | { type: 'MERGE_NEXT'; id: string }
  | { type: 'REASSIGN'; id: string; label: string }
  | { type: 'SET_BOUNDARY'; id: string; edge: ops.Edge; time: number; coalesce?: boolean }
  | { type: 'NUDGE'; id: string; edge: ops.Edge; delta: number }
  | { type: 'MOVE'; id: string; delta: number; coalesce?: boolean }
  | { type: 'DELETE'; id: string }
  | { type: 'CREATE'; label: string; start: number; end: number }
  | { type: 'MERGE_SPEAKERS'; from: string; into: string }
  | { type: 'SPLIT_SPEAKER'; segmentIds: string[]; palette: readonly string[] }
  | { type: 'RENAME_SPEAKER'; label: string; name: string }
  | { type: 'SET_TEXT'; id: string; text: string; coalesce?: boolean }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'CLEAR_NOTICE' };

export const MAX_HISTORY = 200;

export const initialState: EditState = {
  speakers: [],
  segments: [],
  selectedId: null,
  version: 0,
  duration: 0,
  past: [],
  future: [],
  dirty: false,
  lastCoalesceKey: null,
  notice: null,
};

function snapshot(state: EditState): Snapshot {
  return {
    speakers: state.speakers,
    segments: state.segments,
    selectedId: state.selectedId,
  };
}

/** Apply an edit, pushing the previous state onto the undo stack. */
function commit(
  state: EditState,
  next: Partial<Snapshot>,
  options: { coalesceKey?: string | null; notice?: string | null } = {},
): EditState {
  const coalesceKey = options.coalesceKey ?? null;
  const sameRun = coalesceKey !== null && coalesceKey === state.lastCoalesceKey;

  return {
    ...state,
    ...next,
    // A continuing run of the same gesture reuses the entry already on the
    // stack, so one undo takes back the whole drag or key-repeat.
    past: sameRun ? state.past : [...state.past, snapshot(state)].slice(-MAX_HISTORY),
    future: [],
    dirty: true,
    lastCoalesceKey: coalesceKey,
    notice: options.notice ?? null,
  };
}

export function reducer(state: EditState, action: Action): EditState {
  switch (action.type) {
    case 'LOAD':
      return {
        ...initialState,
        speakers: action.speakers,
        segments: action.segments,
        version: action.version,
        duration: action.duration,
      };

    case 'SAVED':
      return { ...state, version: action.version, dirty: false, lastCoalesceKey: null };

    case 'SELECT':
      // Selection is not an edit: it does not touch history or the dirty flag.
      return { ...state, selectedId: action.id, lastCoalesceKey: null };

    case 'SPLIT': {
      const { segments, newId } = ops.splitSegment(state.segments, action.id, action.time);
      if (!newId) return state;
      // Select the right-hand half: the annotator is working forwards.
      return commit(state, { segments, selectedId: newId });
    }

    case 'MERGE_NEXT': {
      const segments = ops.mergeWithNext(state.segments, action.id);
      if (segments === state.segments) return state;
      return commit(state, { segments });
    }

    case 'REASSIGN': {
      const segments = ops.reassignSpeaker(state.segments, action.id, action.label);
      return commit(state, { segments });
    }

    case 'SET_BOUNDARY': {
      const segments = ops.setBoundary(
        state.segments, action.id, action.edge, action.time, state.duration,
      );
      return commit(state, { segments }, {
        coalesceKey: action.coalesce ? `boundary:${action.id}:${action.edge}` : null,
      });
    }

    case 'NUDGE': {
      const segments = ops.nudgeBoundary(
        state.segments, action.id, action.edge, action.delta, state.duration,
      );
      return commit(state, { segments }, {
        coalesceKey: `nudge:${action.id}:${action.edge}`,
      });
    }

    case 'MOVE': {
      const segments = ops.moveSegment(state.segments, action.id, action.delta, state.duration);
      return commit(state, { segments }, {
        coalesceKey: action.coalesce ? `move:${action.id}` : null,
      });
    }

    case 'DELETE': {
      const segments = ops.deleteSegment(state.segments, action.id);
      if (segments.length === state.segments.length) return state;
      const selectedId = state.selectedId === action.id ? null : state.selectedId;
      return commit(state, { segments, selectedId });
    }

    case 'CREATE': {
      const { segments, newId } = ops.createSegment(
        state.segments, action.label, action.start, action.end,
      );
      if (!newId) return state;
      return commit(state, { segments, selectedId: newId });
    }

    case 'MERGE_SPEAKERS': {
      const { speakers, segments, merged } = ops.mergeSpeakers(
        state.speakers, state.segments, action.from, action.into,
      );
      if (speakers === state.speakers) return state;
      return commit(state, { speakers, segments }, {
        // Coalescing overlaps is a real change to the data, so it gets said.
        notice: merged
          ? `合并说话人后，${merged} 处自重叠片段被合并`
          : null,
      });
    }

    case 'SPLIT_SPEAKER': {
      const { speakers, segments } = ops.splitSpeaker(
        state.speakers, state.segments, action.segmentIds, action.palette,
      );
      return commit(state, { speakers, segments });
    }

    case 'RENAME_SPEAKER': {
      const speakers = ops.renameSpeaker(state.speakers, action.label, action.name);
      return commit(state, { speakers }, { coalesceKey: `rename:${action.label}` });
    }

    case 'SET_TEXT': {
      const segments = state.segments.map((s) =>
        s.id === action.id ? { ...s, text: action.text } : s,
      );
      return commit(state, { segments }, {
        coalesceKey: action.coalesce ? `text:${action.id}` : null,
      });
    }

    case 'UNDO': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        ...state,
        ...previous,
        past: state.past.slice(0, -1),
        future: [snapshot(state), ...state.future],
        dirty: true,
        lastCoalesceKey: null,
        notice: null,
      };
    }

    case 'REDO': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return {
        ...state,
        ...next,
        past: [...state.past, snapshot(state)],
        future: rest,
        dirty: true,
        lastCoalesceKey: null,
        notice: null,
      };
    }

    case 'CLEAR_NOTICE':
      return { ...state, notice: null };

    default:
      return state;
  }
}

export const canUndo = (s: EditState): boolean => s.past.length > 0;
export const canRedo = (s: EditState): boolean => s.future.length > 0;
