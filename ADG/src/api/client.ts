/**
 * Server API client.
 *
 * The server is the system of record: nothing here caches annotations in the
 * browser. The only thing kept locally is which name the annotator typed, so
 * they are not asked on every page load.
 */

import type {
  Annotation, Job, Recording, SaveResult, Segment, SimilarityResult, Speaker, User,
} from '../types';

const BASE = '/api';
const USER_KEY = 'adg_user_name';

export function getUserName(): string {
  try {
    return localStorage.getItem(USER_KEY) ?? '';
  } catch {
    // Private windows and blocked site data both throw here.
    return '';
  }
}

export function setUserName(name: string): void {
  try {
    localStorage.setItem(USER_KEY, name);
  } catch {
    /* not worth telling the user about */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-User-Name', getUserName() || 'anonymous');

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (!res.ok) {
    let code = String(res.status);
    let message = res.statusText;
    let detail: Record<string, unknown> = {};
    try {
      const body = await res.json();
      const d = body?.detail;
      if (d && typeof d === 'object') {
        detail = d;
        code = String(d.code ?? code);
        message = String(d.message ?? message);
      } else if (typeof d === 'string') {
        message = d;
      }
    } catch {
      /* keep the status text */
    }
    throw new ApiError(res.status, code, message, detail);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listRecordings(params: { status?: string; q?: string } = {}) {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.q) query.set('q', params.q);
    const suffix = query.toString() ? `?${query}` : '';
    return request<{ items: Recording[]; total: number }>(`/recordings${suffix}`);
  },

  getRecording(id: string) {
    return request<Recording>(`/recordings/${id}`);
  },

  upload(file: File, onProgress?: (fraction: number) => void) {
    // XHR rather than fetch: upload progress is the one thing fetch still
    // cannot report, and these files run to hundreds of megabytes.
    return new Promise<Recording>((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/recordings`);
      xhr.setRequestHeader('X-User-Name', getUserName() || 'anonymous');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let body: any = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
        const d = body?.detail ?? {};
        reject(new ApiError(xhr.status, String(d.code ?? xhr.status), String(d.message ?? xhr.statusText), d));
      };
      xhr.onerror = () => reject(new ApiError(0, 'network', '上传失败'));
      xhr.send(form);
    });
  },

  deleteRecording(id: string) {
    return request<void>(`/recordings/${id}`, { method: 'DELETE' });
  },

  claim(id: string, force = false) {
    return request<Recording>(`/recordings/${id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
  },

  complete(id: string) {
    return request<Recording>(`/recordings/${id}/complete`, { method: 'POST' });
  },

  diarize(id: string) {
    return request<Job>(`/recordings/${id}/diarize`, { method: 'POST' });
  },

  latestJob(id: string) {
    return request<Job>(`/recordings/${id}/job`);
  },

  getAnnotation(id: string) {
    return request<Annotation>(`/recordings/${id}/annotation`);
  },

  saveAnnotation(id: string, version: number, speakers: Speaker[], segments: Segment[]) {
    return request<SaveResult>(`/recordings/${id}/annotation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version,
        speakers,
        // Client-side ids (from a split) are not the server's to know about.
        segments: segments.map(({ id: sid, ...rest }) => ({
          ...rest,
          ...(sid && !sid.startsWith('tmp-') ? { id: sid } : {}),
        })),
      }),
    });
  },

  /**
   * Ranked similarity of one audio window against the stable segments.
   * Located by time on purpose: the window may never have reached the server.
   */
  similarity(id: string, start_sec: number, end_sec: number) {
    return request<SimilarityResult>(`/recordings/${id}/similarity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_sec, end_sec }),
    });
  },

  importRttm(id: string, file: File, version: number, allowUriMismatch = false) {
    const form = new FormData();
    form.append('file', file);
    form.append('version', String(version));
    form.append('allow_uri_mismatch', String(allowUriMismatch));
    return request<SaveResult>(`/recordings/${id}/annotation/rttm`, {
      method: 'POST',
      body: form,
    });
  },

  listUsers() {
    return request<User[]>('/users');
  },

  audioUrl(id: string) {
    return `${BASE}/recordings/${id}/audio`;
  },

  rttmUrl(id: string) {
    return `${BASE}/recordings/${id}/rttm`;
  },

  exportAllUrl(status = 'done') {
    return `${BASE}/export/rttm.zip?status=${status}`;
  },

  /**
   * Waveform envelope, one float per 10 ms, already normalised to -1..1.
   * Handed straight to wavesurfer so the browser never decodes the audio.
   */
  async peaks(id: string): Promise<Float32Array> {
    const res = await fetch(`${BASE}/recordings/${id}/peaks`);
    if (!res.ok) throw new ApiError(res.status, 'peaks', '波形数据加载失败');
    return new Float32Array(await res.arrayBuffer());
  },
};
