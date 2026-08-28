/**
 * Shapes mirroring the server API. The server is the system of record; nothing
 * here is persisted in the browser.
 */

export interface User {
  id: string;
  name: string;
}

/** Server-side lifecycle. Only `ready`, `annotating` and `done` are claimable. */
export type RecordingStatus =
  | 'uploaded'
  | 'queued'
  | 'running'
  | 'ready'
  | 'annotating'
  | 'done'
  | 'failed';

export interface Recording {
  id: string;
  session_name: string;
  original_name: string;
  duration_sec: number;
  status: RecordingStatus;
  annotation_version: number;
  claimed_by: User | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `label` is the stable key and never changes -- DiariZen emits bare integers
 * ("0", "3") and those are kept verbatim so a re-run stays comparable. Renaming
 * a speaker touches `name` only.
 */
export interface Speaker {
  label: string;
  name: string;
  color: string;
  sort_order: number;
}

export interface Segment {
  id?: string;
  speaker_label: string;
  start_sec: number;
  end_sec: number;
  text: string;
}

export interface Annotation {
  version: number;
  duration_sec: number;
  speakers: Speaker[];
  segments: Segment[];
}

/** A boundary the server had to move to make the annotation storable. */
export interface Adjustment {
  index: number;
  reason: string;
  before: [number, number];
  after: [number, number] | null;
}

export interface SaveResult {
  version: number;
  adjustments: Adjustment[];
}

export interface Job {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}
