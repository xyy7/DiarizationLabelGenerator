/**
 * The shared timeline: ruler, waveform and one lane per speaker, all inside a
 * single horizontal scroller of width `duration * pxPerSec`.
 *
 * The previous version gave every speaker its own timeline with its own zoom
 * and scroll position, which made the one thing this tool exists for --
 * comparing speakers against each other, especially where they overlap --
 * impossible to do by eye.
 */

import { useCallback, useMemo, useRef } from 'react';
import type WaveSurfer from 'wavesurfer.js';

import Waveform from './Waveform';
import type { Segment, Speaker } from '../types';
import { byTime } from '../annotation/operations';

const LANE_HEIGHT = 44;
const HANDLE_PX = 8;

interface Props {
  duration: number;
  pxPerSec: number;
  audioUrl: string;
  peaks: Float32Array | null;
  speakers: Speaker[];
  segments: Segment[];
  selectedId: string | null;
  currentTime: number;
  onReady: (ws: WaveSurfer) => void;
  onTime: (t: number) => void;
  onPlayingChange: (p: boolean) => void;
  onSelect: (id: string | null) => void;
  onDragBoundary: (id: string, edge: 'start' | 'end', time: number) => void;
  onDragMove: (id: string, delta: number) => void;
  onDragEnd: () => void;
  onCreate: (label: string, start: number, end: number) => void;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** Tick spacing that keeps labels roughly 80 px apart at the current zoom. */
function tickStep(pxPerSec: number): number {
  const candidates = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return candidates.find((c) => c * pxPerSec >= 80) ?? 600;
}

export default function Timeline(props: Props) {
  const {
    duration, pxPerSec, audioUrl, peaks, speakers, segments, selectedId,
    currentTime, onReady, onTime, onPlayingChange, onSelect,
    onDragBoundary, onDragMove, onDragEnd, onCreate,
  } = props;

  const width = Math.max(1, duration * pxPerSec);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { kind: 'move'; id: string; lastTime: number }
    | { kind: 'edge'; id: string; edge: 'start' | 'end' }
    | { kind: 'create'; label: string; from: number; to: number }
    | null
  >(null);

  const timeAt = useCallback(
    (clientX: number) => {
      const el = scrollerRef.current;
      if (!el) return 0;
      const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
      return Math.max(0, Math.min(duration, x / pxPerSec));
    },
    [duration, pxPerSec],
  );

  const ticks = useMemo(() => {
    const step = tickStep(pxPerSec);
    const out: number[] = [];
    for (let t = 0; t <= duration; t += step) out.push(t);
    return out;
  }, [duration, pxPerSec]);

  const byLane = useMemo(() => {
    const map = new Map<string, Segment[]>();
    for (const sp of speakers) map.set(sp.label, []);
    for (const s of byTime(segments)) {
      if (!map.has(s.speaker_label)) map.set(s.speaker_label, []);
      map.get(s.speaker_label)!.push(s);
    }
    return map;
  }, [speakers, segments]);

  const handleMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = timeAt(e.clientX);
    if (d.kind === 'edge') {
      onDragBoundary(d.id, d.edge, t);
    } else if (d.kind === 'move') {
      onDragMove(d.id, t - d.lastTime);
      d.lastTime = t;
    } else {
      d.to = t;
    }
  };

  const finishDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'create') {
      const [a, b] = [d.from, d.to].sort((x, y) => x - y);
      if (b - a > 0.02) onCreate(d.label, a, b);
    } else {
      onDragEnd();
    }
  };

  return (
    <div
      ref={scrollerRef}
      style={{ overflowX: 'auto', overflowY: 'hidden', background: '#fff', userSelect: 'none' }}
      onMouseMove={handleMouseMove}
      onMouseUp={finishDrag}
      onMouseLeave={finishDrag}
    >
      <div style={{ width, position: 'relative' }}>
        {/* Ruler */}
        <div style={{ height: 22, position: 'relative', borderBottom: '1px solid #eee' }}>
          {ticks.map((t) => (
            <div
              key={t}
              style={{
                position: 'absolute', left: t * pxPerSec, top: 0, height: '100%',
                borderLeft: '1px solid #ddd', paddingLeft: 3,
                fontSize: 11, color: '#888', whiteSpace: 'nowrap',
              }}
            >
              {fmt(t)}
            </div>
          ))}
        </div>

        <Waveform
          audioUrl={audioUrl}
          peaks={peaks}
          duration={duration}
          pxPerSec={pxPerSec}
          onReady={onReady}
          onTime={onTime}
          onPlayingChange={onPlayingChange}
        />

        {/* One lane per speaker, stacked. Vertical alignment across lanes is
            what makes overlapping speech visible at a glance. */}
        {speakers.map((sp) => (
          <div
            key={sp.label}
            data-lane={sp.label}
            style={{
              height: LANE_HEIGHT, position: 'relative',
              borderBottom: '1px solid #f0f0f0', background: '#fafcff',
            }}
            onMouseDown={(e) => {
              if (e.button !== 0 || e.target !== e.currentTarget) return;
              const t = timeAt(e.clientX);
              drag.current = { kind: 'create', label: sp.label, from: t, to: t };
              onSelect(null);
            }}
          >
            {(byLane.get(sp.label) ?? []).map((s) => {
              const left = s.start_sec * pxPerSec;
              const w = Math.max(2, (s.end_sec - s.start_sec) * pxPerSec);
              const selected = s.id === selectedId;
              return (
                <div
                  key={s.id}
                  title={`${fmt(s.start_sec)} – ${fmt(s.end_sec)}`}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    if (!s.id) return;
                    onSelect(s.id);
                    drag.current = { kind: 'move', id: s.id, lastTime: timeAt(e.clientX) };
                  }}
                  style={{
                    position: 'absolute', left, width: w, top: 5,
                    height: LANE_HEIGHT - 12,
                    background: sp.color,
                    opacity: selected ? 1 : 0.72,
                    outline: selected ? '2px solid #111' : 'none',
                    borderRadius: 3, cursor: 'grab', overflow: 'hidden',
                    color: '#fff', fontSize: 11, lineHeight: `${LANE_HEIGHT - 12}px`,
                    paddingLeft: 6, whiteSpace: 'nowrap',
                  }}
                >
                  {w > 46 ? s.text || '' : ''}
                  <div
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (s.id) drag.current = { kind: 'edge', id: s.id, edge: 'start' };
                      if (s.id) onSelect(s.id);
                    }}
                    style={{
                      position: 'absolute', left: 0, top: 0, bottom: 0,
                      width: HANDLE_PX, cursor: 'ew-resize',
                    }}
                  />
                  <div
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (s.id) drag.current = { kind: 'edge', id: s.id, edge: 'end' };
                      if (s.id) onSelect(s.id);
                    }}
                    style={{
                      position: 'absolute', right: 0, top: 0, bottom: 0,
                      width: HANDLE_PX, cursor: 'ew-resize',
                    }}
                  />
                </div>
              );
            })}
          </div>
        ))}

        {/* A single playhead spanning every lane. */}
        <div
          style={{
            position: 'absolute', top: 0, bottom: 0,
            left: currentTime * pxPerSec, width: 1,
            background: '#ff4d4f', pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
}
