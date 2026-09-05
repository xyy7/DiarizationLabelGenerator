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
import { byTime, MIN_DURATION } from '../annotation/operations';

const LANE_HEIGHT = 44;
const HANDLE_PX = 8;
const RULER_HEIGHT = 22;
const WAVE_HEIGHT = 96;

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
  /** Move the red line. Every left-click in the timeline seeks. */
  onSeek: (t: number) => void;
  /**
   * Pending time-range box (a drag on an empty lane), waiting for a number key
   * to pick the speaker. Null once assigned, cancelled, or replaced.
   */
  marquee: { start: number; end: number } | null;
  onMarquee: (range: { start: number; end: number } | null) => void;
  /** Right-click on a segment: open the per-segment menu at (x, y). */
  onSegmentContextMenu: (segment: Segment, x: number, y: number) => void;
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
    onDragBoundary, onDragMove, onDragEnd, onSeek, marquee, onMarquee,
    onSegmentContextMenu,
  } = props;

  const width = Math.max(1, duration * pxPerSec);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { kind: 'move'; id: string; lastTime: number }
    | { kind: 'edge'; id: string; edge: 'start' | 'end' }
    | { kind: 'marquee'; from: number; to: number }
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
      onMarquee({ start: Math.min(d.from, t), end: Math.max(d.from, t) });
    }
  };

  const finishDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'marquee') {
      // A drag shorter than the minimum duration is a plain click: no box.
      const [a, b] = [d.from, d.to].sort((x, y) => x - y);
      if (b - a <= MIN_DURATION) onMarquee(null);
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
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // Reaches here for ruler / waveform / lane gaps -- segments and the
        // empty lane stop the event to handle the click themselves. Cancel any
        // pending box, seek (every click moves the red line) and start a fresh
        // marquee, so a drag on the waveform boxes just like on the lanes.
        if (marquee) onMarquee(null);
        const t = timeAt(e.clientX);
        onSeek(t);
        drag.current = { kind: 'marquee', from: t, to: t };
        onMarquee({ start: t, end: t });
      }}
    >
      <div style={{ width, position: 'relative' }}>
        {/* Ruler */}
        <div style={{ height: RULER_HEIGHT, position: 'relative', borderBottom: '1px solid #eee' }}>
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
          height={WAVE_HEIGHT}
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
              e.stopPropagation(); // this click seeks itself; no scroller duplicate
              const t = timeAt(e.clientX);
              drag.current = { kind: 'marquee', from: t, to: t };
              onMarquee({ start: t, end: t });
              onSelect(null);
              onSeek(t);
            }}
          >
            {(byLane.get(sp.label) ?? []).map((s) => {
              const left = s.start_sec * pxPerSec;
              const w = Math.max(2, (s.end_sec - s.start_sec) * pxPerSec);
              const selected = s.id === selectedId;
              return (
                <div
                  key={s.id}
                  title={`${fmt(s.start_sec)} – ${fmt(s.end_sec)}${s.is_stable ? ' ★稳定音频' : ''}`}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    if (!s.id) return;
                    onMarquee(null);
                    onSeek(timeAt(e.clientX));
                    onSelect(s.id);
                    drag.current = { kind: 'move', id: s.id, lastTime: timeAt(e.clientX) };
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (s.id) onSegmentContextMenu(s, e.clientX, e.clientY);
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
                  {s.is_stable ? (
                    <span
                      title="稳定音频（该说话人的参考声纹）"
                      style={{
                        position: 'absolute', right: 4, top: 0,
                        fontSize: 11, color: '#fff', textShadow: '0 0 2px #000',
                      }}
                    >
                      ★
                    </span>
                  ) : null}
                  <div
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (!s.id) return;
                      onMarquee(null);
                      onSeek(timeAt(e.clientX));
                      drag.current = { kind: 'edge', id: s.id, edge: 'start' };
                      onSelect(s.id);
                    }}
                    style={{
                      position: 'absolute', left: 0, top: 0, bottom: 0,
                      width: HANDLE_PX, cursor: 'ew-resize',
                    }}
                  />
                  <div
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (!s.id) return;
                      onMarquee(null);
                      onSeek(timeAt(e.clientX));
                      drag.current = { kind: 'edge', id: s.id, edge: 'end' };
                      onSelect(s.id);
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

        {/* The pending selection box: a time range across the waveform and
            every lane, waiting for a number key to pick the speaker. */}
        {marquee && marquee.end > marquee.start ? (
          <div
            style={{
              position: 'absolute',
              top: RULER_HEIGHT, bottom: 0,
              left: marquee.start * pxPerSec,
              width: (marquee.end - marquee.start) * pxPerSec,
              background: 'rgba(22,119,255,0.10)',
              border: '1px dashed #1677ff',
              pointerEvents: 'none', zIndex: 3,
            }}
          >
            <span
              style={{
                position: 'absolute', left: 2, top: 2,
                fontSize: 11, color: '#1677ff', background: 'rgba(255,255,255,0.92)',
                padding: '0 4px', borderRadius: 2, whiteSpace: 'nowrap',
              }}
            >
              1–9 指定说话人 · Del/Esc 取消 · {(marquee.end - marquee.start).toFixed(2)}s
            </span>
          </div>
        ) : null}

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
