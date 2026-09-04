/**
 * wavesurfer, sized to the shared timeline rather than to its own container.
 *
 * Two things matter here:
 *
 * 1. Peaks come from the server, so the browser never decodes the audio. A
 *    twenty-minute file would otherwise cost hundreds of megabytes of decoded
 *    samples before the first pixel appeared.
 * 2. `fillParent: false` plus a container already `duration * pxPerSec` wide
 *    leaves wavesurfer's internal scroller with nothing to scroll, so the
 *    outer timeline owns scrolling and the lanes stay in lockstep with the
 *    waveform by construction. There is no scroll-sync code because there is
 *    nothing to sync.
 */

import { useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { resume as resumeVolume } from '../audio/masterVolume';

interface Props {
  audioUrl: string;
  peaks: Float32Array | null;
  duration: number;
  pxPerSec: number;
  height?: number;
  onReady?: (ws: WaveSurfer) => void;
  onTime?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}

export default function Waveform({
  audioUrl, peaks, duration, pxPerSec, height = 96,
  onReady, onTime, onPlayingChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  // zoom() throws "No audio loaded" before the decode finishes, and an
  // exception thrown from an effect takes the whole page down with it.
  const readyRef = useRef(false);
  const pendingZoom = useRef(pxPerSec);
  // Kept in refs so changing a handler never tears down the audio element.
  const handlers = useRef({ onReady, onTime, onPlayingChange });
  handlers.current = { onReady, onTime, onPlayingChange };

  useEffect(() => {
    if (!containerRef.current || !peaks || duration <= 0) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height,
      waveColor: '#c9d3df',
      progressColor: '#7fa8d4',
      cursorColor: 'transparent', // the timeline draws one playhead for every lane
      normalize: false,           // the server already normalised to -1..1
      fillParent: false,
      hideScrollbar: true,
      autoScroll: false,
      minPxPerSec: pxPerSec,
      interact: true,
      url: audioUrl,
      peaks: [peaks],
      duration,
    });

    // Debug aid: open the page with ?debug=playhead to see which event streams
    // actually reach the app while the red line misbehaves.
    const debug = new URLSearchParams(window.location.search).get('debug') === 'playhead';
    const log = debug ? (...a: unknown[]) => console.log('[ph]', ...a) : () => {};
    if (debug) {
      // A crashed React tree freezes the red line while native audio keeps
      // going -- the exact reported symptom -- so surface page errors here.
      window.addEventListener('error', (e) => log('window-error', e.message, e.error?.stack?.split('\n')[1] ?? ''));
      window.addEventListener('unhandledrejection', (e) => log('unhandled-rejection', e.reason));
    }

    ws.on('ready', () => {
      readyRef.current = true;
      log('ready');
      // Apply any zoom the user asked for while the audio was still decoding.
      if (pendingZoom.current > 0) ws.zoom(pendingZoom.current);
      handlers.current.onReady?.(ws);
    });
    ws.on('error', (err) => {
      // Surfaced rather than thrown: a failed decode should leave the rest of
      // the annotator usable.
      console.error('waveform failed to load', err);
      log('error', String(err).slice(0, 120));
    });
    // Load-phase probe (debug only): tells us at which event the pipeline
    // stalls on machines where the wave never becomes ready.
    if (debug) {
      ws.on('load', (u) => log('load', String(u).slice(-40)));
      ws.on('loading', (p) => log('loading', p));
      ws.on('decode', (d) => log('decode', d));
      ws.on('redraw', () => log('redraw'));
    }

    // The 16 ms timer that emits 'audioprocess' is gated behind wavesurfer's
    // internal isSeeking signal. A seek whose 'seeked' never arrives (a
    // waveform click whose byte range stalls or gets superseded mid-fetch --
    // easy against a slow or remote audio endpoint) can leave that signal
    // stuck true: the element keeps playing but 'audioprocess' stops forever,
    // and the playhead freezes while the sound runs on. The media element's
    // own 'timeupdate' is NOT gated, so it is the ground truth once the
    // smooth path is broken -- mirror both; duplicates are idempotent.
    ws.on('audioprocess', (t) => { log('audioprocess', t.toFixed(3)); handlers.current.onTime?.(t); });
    ws.on('timeupdate', (t) => { log('timeupdate', t.toFixed(3)); handlers.current.onTime?.(t); });
    ws.on('play', () => { log('play'); handlers.current.onPlayingChange?.(true); });
    ws.on('pause', () => { log('pause'); handlers.current.onPlayingChange?.(false); });
    ws.on('finish', () => { log('finish'); handlers.current.onPlayingChange?.(false); });
    // v7 renamed this from 'seek'. The old name silently never fired, which is
    // why clicking the waveform while paused used to leave the playhead behind.
    ws.on('seeking', (t) => {
      // A waveform click seeks; when the boost chain is engaged the media
      // element routes through a suspended AudioContext and plays silently.
      // This runs inside the pointer gesture, so it resumes.
      resumeVolume();
      log('seeking', t.toFixed(3));
      handlers.current.onTime?.(t);
    });

    wsRef.current = ws;
    return () => {
      wsRef.current = null;
      readyRef.current = false;
      ws.destroy();
    };
    // Deliberately not reacting to pxPerSec: zooming is a call, not a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl, peaks, duration, height]);

  useEffect(() => {
    pendingZoom.current = pxPerSec;
    if (!wsRef.current || !readyRef.current || pxPerSec <= 0) return;
    try {
      wsRef.current.zoom(pxPerSec);
    } catch (err) {
      console.error('zoom failed', err);
    }
  }, [pxPerSec]);

  return <div ref={containerRef} style={{ width: duration * pxPerSec }} />;
}
