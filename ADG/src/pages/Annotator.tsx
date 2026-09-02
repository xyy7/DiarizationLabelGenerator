/**
 * The correction workspace.
 *
 * The working loop is listen, judge, fix, next -- so the keyboard is built
 * around it. Tab walks segments in time order and plays each one; the number
 * keys reassign the selected segment to a speaker, which is the single most
 * frequent repair because VBx clustering cannot be told how many speakers to
 * expect and routinely splits one person across two labels.
 *
 * Playback rate lost the number keys to that. It is a listening convenience;
 * reassignment is the job.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Empty, Menu, Modal, Popover, Slider, Space, Spin, Tag, Tooltip, message } from 'antd';
import type WaveSurfer from 'wavesurfer.js';

import Timeline from '../components/Timeline';
import SimilarityPanel from '../components/SimilarityPanel';
import ShortcutHelp, { ShortcutBar } from '../components/ShortcutHelp';
import { api, ApiError } from '../api/client';
import { canRedo, canUndo, initialState, reducer } from '../annotation/reducer';
import { find, nextSegment, prevSegment } from '../annotation/operations';
import {
  attach as attachVolume, BOOST_MAX, BOOST_MIN, getBoost, resume as resumeVolume, setBoost as setBoostVolume,
} from '../audio/masterVolume';
import { PALETTE } from '../palette';
import type { Recording, Segment } from '../types';

const AUTOSAVE_MS = 2000;
const NUDGE = 0.01;
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export default function Annotator() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const [state, dispatch] = useReducer(reducer, initialState);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [pxPerSec, setPxPerSec] = useState(60);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  // Right-click menu target and the identify panel's segment.
  const [menu, setMenu] = useState<{ segment: Segment; x: number; y: number } | null>(null);
  const [panelSegId, setPanelSegId] = useState<string | null>(null);
  const [boostPct, setBoostPct] = useState(() => Math.round(getBoost() * 100));

  const wsRef = useRef<WaveSurfer | null>(null);
  // Stops playback at the end of a single segment when auditioning one.
  const playUntil = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // --- load -----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [rec, ann, pk] = await Promise.all([
          api.getRecording(id), api.getAnnotation(id), api.peaks(id),
        ]);
        if (cancelled) return;
        setRecording(rec);
        setPeaks(pk);
        dispatch({
          type: 'LOAD',
          speakers: ann.speakers,
          segments: ann.segments,
          version: ann.version,
          duration: ann.duration_sec,
        });
      } catch (e) {
        message.error(e instanceof ApiError ? e.message : '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (state.notice) {
      message.info(state.notice);
      dispatch({ type: 'CLEAR_NOTICE' });
    }
  }, [state.notice]);

  // --- save -----------------------------------------------------------------
  const save = useCallback(async () => {
    const s = stateRef.current;
    if (!s.dirty || saving) return;
    setSaving(true);
    try {
      const res = await api.saveAnnotation(id, s.version, s.speakers, s.segments);
      dispatch({ type: 'SAVED', version: res.version });
      // The server moved a boundary; say so rather than let it pass unseen.
      for (const a of res.adjustments) {
        message.warning(
          a.after
            ? `片段 ${a.index} 超出音频，已收到 ${a.after[1].toFixed(3)}s`
            : `片段 ${a.index} 完全在音频之外，已丢弃`,
          6,
        );
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        Modal.error({
          title: '有人先保存了',
          content: '这份标注在别处被改动过。请重新载入后再改，避免覆盖对方的修正。',
        });
      } else {
        message.error(e instanceof ApiError ? e.message : '保存失败');
      }
    } finally {
      setSaving(false);
    }
  }, [id, saving]);

  useEffect(() => {
    if (!state.dirty) return;
    const t = setTimeout(save, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [state.dirty, state.segments, state.speakers, save]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (stateRef.current.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // --- playback -------------------------------------------------------------
  const seek = useCallback((t: number) => {
    const ws = wsRef.current;
    if (!ws || !state.duration) return;
    // A manual seek moves the head off whatever was playing; the old segment
    // end must not stop playback at what is now a stale boundary.
    playUntil.current = null;
    ws.seekTo(Math.max(0, Math.min(1, t / state.duration)));
    setCurrentTime(t);
  }, [state.duration]);

  const playSegment = useCallback((segId: string) => {
    const seg = find(stateRef.current.segments, segId);
    const ws = wsRef.current;
    if (!seg || !ws) return;
    seek(seg.start_sec);
    playUntil.current = seg.end_sec; // AFTER seek() cleared it
    resumeVolume(); // the master chain must run for any routed element
    ws.play();
  }, [seek]);

  const handleTime = useCallback((t: number) => {
    setCurrentTime(t);
    if (playUntil.current !== null && t >= playUntil.current) {
      playUntil.current = null;
      wsRef.current?.pause();
    }
  }, []);

  const step = useCallback((dir: 1 | -1) => {
    const s = stateRef.current;
    const target = dir === 1
      ? nextSegment(s.segments, s.selectedId)
      : prevSegment(s.segments, s.selectedId);
    if (!target?.id) return;
    dispatch({ type: 'SELECT', id: target.id });
    playSegment(target.id);
  }, [playSegment]);

  // Add a speaker. With a segment selected it takes that segment with it --
  // this is the repair for VBx putting two people under one label. Without
  // one it is just a new empty lane, for a person DiariZen never placed.
  const newSpeaker = useCallback(() => {
    const s = stateRef.current;
    if (s.selectedId) {
      dispatch({ type: 'SPLIT_SPEAKER', segmentIds: [s.selectedId], palette: PALETTE });
    } else {
      dispatch({ type: 'CREATE_SPEAKER', palette: PALETTE });
    }
  }, []);

  // Open the auto-identify panel. The panel plays on its own audio; the main
  // player must be stopped so the two never talk over each other.
  const openIdentify = useCallback((segId?: string) => {
    const s = stateRef.current;
    const id = segId ?? s.selectedId;
    if (!id) return;
    wsRef.current?.pause();
    playUntil.current = null;
    setPanelSegId(id);
  }, []);

  // --- keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      // Not just editable fields: a focused button or slider must keep the
      // keys the browser gives it (Space/Enter activates, arrows move the
      // slider). Menu items and dropdowns live in portals but the window
      // handler still sees their keydowns -- without this, an open dropdown
      // would have J/K suddenly re-annotating segments.
      if (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.isContentEditable ||
        el.closest('button, a[href], [role="slider"], [role="spinbutton"], [role="combobox"], [role="option"], [role="menuitem"], [role="listbox"]')
      ) return;

      const s = stateRef.current;
      const sel = s.selectedId;
      const ws = wsRef.current;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? 'REDO' : 'UNDO' });
        return;
      }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
      if (mod) return;

      switch (e.key) {
        case '?':
          e.preventDefault();
          setHelpOpen((v) => !v);
          return;
        case 'Escape':
          setHelpOpen(false);
          dispatch({ type: 'SELECT', id: null });
          return;
        case ' ':
          e.preventDefault();
          playUntil.current = null;
          resumeVolume();
          ws?.playPause();
          return;
        case 'Enter':
          e.preventDefault();
          if (sel) playSegment(sel);
          return;
        // Tab is deliberately NOT bound. It is the only key that moves
        // keyboard focus, and taking it left the page with no way to reach a
        // button without a mouse. J/K and the arrows do the same job here.
        case 'ArrowDown':
          e.preventDefault();
          step(1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          step(-1);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          seek(Math.max(0, currentTime - (e.shiftKey ? 5 : 1)));
          return;
        case 'ArrowRight':
          e.preventDefault();
          seek(Math.min(s.duration, currentTime + (e.shiftKey ? 5 : 1)));
          return;
        case 'Delete':
        case 'Backspace':
          if (sel) { e.preventDefault(); dispatch({ type: 'DELETE', id: sel }); }
          return;
        case '[':
          if (sel) dispatch({ type: 'SET_BOUNDARY', id: sel, edge: 'start', time: currentTime });
          return;
        case ']':
          if (sel) dispatch({ type: 'SET_BOUNDARY', id: sel, edge: 'end', time: currentTime });
          return;
        case ',':
        case '.': {
          if (!sel) return;
          e.preventDefault();
          const delta = (e.key === ',' ? -1 : 1) * (e.shiftKey ? NUDGE * 10 : NUDGE);
          dispatch({ type: 'NUDGE', id: sel, edge: 'end', delta });
          return;
        }
        case '-':
        case '=': {
          const i = RATES.indexOf(rate);
          const next = RATES[Math.max(0, Math.min(RATES.length - 1, i + (e.key === '=' ? 1 : -1)))];
          setRate(next);
          ws?.setPlaybackRate(next);
          return;
        }
        default:
          break;
      }

      const lower = e.key.toLowerCase();
      if (lower === 'j') { e.preventDefault(); step(1); return; }
      if (lower === 'k') { e.preventDefault(); step(-1); return; }
      if (lower === 'i') { e.preventDefault(); openIdentify(); return; }
      if (lower === 's' && sel) { dispatch({ type: 'SPLIT', id: sel, time: currentTime }); return; }
      if (lower === 'm' && sel) { dispatch({ type: 'MERGE_NEXT', id: sel }); return; }
      if (lower === 'n') { e.preventDefault(); newSpeaker(); return; }

      if (/^[1-9]$/.test(e.key) && sel) {
        const speaker = s.speakers[Number(e.key) - 1];
        if (speaker) dispatch({ type: 'REASSIGN', id: sel, label: speaker.label });
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentTime, rate, save, step, playSegment, newSpeaker, openIdentify]);

  // --- speaker actions ------------------------------------------------------
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);

  const stats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of state.segments) {
      counts.set(s.speaker_label, (counts.get(s.speaker_label) ?? 0) + 1);
    }
    return counts;
  }, [state.segments]);

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>;
  if (!recording) return <Empty description="找不到这条录音" />;

  const selected = state.selectedId ? find(state.segments, state.selectedId) : undefined;
  const panelSegment = panelSegId ? find(state.segments, panelSegId) ?? null : null;

  return (
    <div style={{ padding: 16 }}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Button onClick={() => navigate('/')}>← 返回</Button>
        <strong>{recording.session_name}</strong>
        <Tag>{recording.status}</Tag>
        <Tag color={state.dirty ? 'orange' : 'green'}>
          {saving ? '保存中…' : state.dirty ? '未保存' : `已保存 v${state.version}`}
        </Tag>
        <Button size="small" disabled={!canUndo(state)} onClick={() => dispatch({ type: 'UNDO' })}>
          撤销
        </Button>
        <Button size="small" disabled={!canRedo(state)} onClick={() => dispatch({ type: 'REDO' })}>
          重做
        </Button>
        <Button size="small" onClick={() => setPxPerSec((p) => Math.max(10, p / 1.5))}>缩小</Button>
        <Button size="small" onClick={() => setPxPerSec((p) => Math.min(1200, p * 1.5))}>放大</Button>
        <span style={{ color: '#888', fontSize: 12 }}>{pxPerSec.toFixed(0)} px/s · {rate}×</span>
        <Popover
          trigger="click"
          content={
            <div style={{ width: 240 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <b>音量增益</b>
                <span>{boostPct}%</span>
              </div>
              <Slider
                min={BOOST_MIN}
                max={BOOST_MAX}
                step={50}
                value={boostPct}
                onChange={(v) => { setBoostVolume(v / 100); setBoostPct(v); }}
              />
              <div style={{ fontSize: 12, color: '#888' }}>
                100% 以下降低，100%–500% 为数字放大（页面上限 100%，
                超过即 WebAudio 增益 + 限幅，同视频站点做法；大声时可能
                有轻微压缩感）
              </div>
            </div>
          }
        >
          <Button size="small">音量 {boostPct}%</Button>
        </Popover>
        <Button type="primary" size="small" loading={saving} onClick={save} disabled={!state.dirty}>
          保存
        </Button>
        <Button
          size="small"
          onClick={async () => {
            await save();
            await api.complete(id);
            message.success('已标记完成');
            navigate('/');
          }}
        >
          标记完成
        </Button>
        <a href={api.rttmUrl(id)} target="_blank" rel="noreferrer">导出 RTTM</a>
        <Button size="small" onClick={() => setHelpOpen(true)}>快捷键 ?</Button>
      </Space>

      <Timeline
        duration={state.duration}
        pxPerSec={pxPerSec}
        audioUrl={api.audioUrl(id)}
        peaks={peaks}
        speakers={state.speakers}
        segments={state.segments}
        selectedId={state.selectedId}
        currentTime={currentTime}
        onReady={(ws) => {
          wsRef.current = ws;
          ws.setPlaybackRate(rate);
          // Route the player's element through the master gain chain so the
          // volume control (50%–500%) also governs the timeline player.
          attachVolume(ws.getMediaElement());
        }}
        onTime={handleTime}
        onPlayingChange={setPlaying}
        onSelect={(sid) => dispatch({ type: 'SELECT', id: sid })}
        onDragBoundary={(sid, edge, t) =>
          dispatch({ type: 'SET_BOUNDARY', id: sid, edge, time: t, coalesce: true })}
        onDragMove={(sid, delta) => dispatch({ type: 'MOVE', id: sid, delta, coalesce: true })}
        onDragEnd={() => dispatch({ type: 'SELECT', id: stateRef.current.selectedId })}
        onCreate={(label, start, end) => dispatch({ type: 'CREATE', label, start, end })}
        onSegmentContextMenu={(segment, x, y) => setMenu({ segment, x, y })}
      />

      {/* The essentials stay on screen; `?` opens the full list. */}
      <div style={{ marginTop: 8 }}>
        <ShortcutBar onOpen={() => setHelpOpen(true)} />
      </div>

      <Space align="start" style={{ marginTop: 16 }} size={32}>
        <div>
          <h4 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            说话人
            <Tooltip title="选中片段时新建说话人并把这片段拆给他（快捷键 N）；未选中则只新建一个空说话人">
              <Button size="small" type="primary" ghost onClick={newSpeaker}>
                ＋ 新建说话人
              </Button>
            </Tooltip>
          </h4>
          {state.speakers.map((sp, i) => (
            <div key={sp.label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 14, height: 14, background: sp.color, borderRadius: 3 }} />
              <Tooltip title={`按 ${i + 1} 把选中片段改判给他`}>
                <kbd style={{ fontSize: 11, color: '#888' }}>{i + 1}</kbd>
              </Tooltip>
              <input
                value={sp.name}
                aria-label={`说话人 ${sp.label} 的名称`}
                onChange={(e) =>
                  dispatch({ type: 'RENAME_SPEAKER', label: sp.label, name: e.target.value })}
                style={{ border: '1px solid #ddd', borderRadius: 4, padding: '2px 6px', width: 130 }}
              />
              <span style={{ color: '#999', fontSize: 12 }}>{stats.get(sp.label) ?? 0} 段</span>
              <Button
                size="small"
                danger
                onClick={() => setMergeFrom(sp.label)}
                disabled={state.speakers.length < 2}
              >
                合并到…
              </Button>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12, color: '#666', lineHeight: 2 }}>
          <h4 style={{ color: '#000' }}>当前</h4>
          {selected ? (
            <div style={{ color: '#111' }}>
              选中 {selected.start_sec.toFixed(3)} – {selected.end_sec.toFixed(3)}s
              （{(selected.end_sec - selected.start_sec).toFixed(3)}s，
              {state.speakers.find((s) => s.label === selected.speaker_label)?.name}）
            </div>
          ) : (
            <div>未选中片段 —— 按 J 开始走查</div>
          )}
          <div>
            共 {state.segments.length} 段 / {state.speakers.length} 人
            {playing ? ' · 播放中' : ''}
          </div>
        </div>
      </Space>

      {/* Right-click menu: identify, stable flag, delete. */}
      {menu && menu.segment.id ? (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 1090 }}
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          />
          <div style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1100 }}>
            <Menu
              selectable={false}
              items={[
                { key: 'identify', label: '自动识别相似度…' },
                { key: 'stable', label: menu.segment.is_stable ? '取消稳定音频' : '设为稳定音频' },
                { type: 'divider' as const },
                { key: 'delete', label: '删除该段', danger: true },
              ]}
              onClick={({ key }) => {
                const seg = menu.segment;
                setMenu(null);
                if (key === 'identify') openIdentify(seg.id);
                if (key === 'stable') dispatch({ type: 'TOGGLE_STABLE', id: seg.id! });
                if (key === 'delete') dispatch({ type: 'DELETE', id: seg.id! });
              }}
            />
          </div>
        </>
      ) : null}

      <SimilarityPanel
        open={panelSegment !== null}
        recordingId={id}
        segment={panelSegment}
        speakers={state.speakers}
        onClose={() => setPanelSegId(null)}
        onAssign={(labels) => {
          if (panelSegment?.id) dispatch({ type: 'REASSIGN_MULTI', id: panelSegment.id, labels });
          setPanelSegId(null);
        }}
        save={save}
      />

      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

      <Modal
        open={mergeFrom !== null}
        title={`把「${state.speakers.find((s) => s.label === mergeFrom)?.name}」合并到哪个说话人？`}
        onCancel={() => setMergeFrom(null)}
        footer={null}
      >
        <p style={{ color: '#888' }}>
          该说话人的所有片段会改判过去，标签本身被删除。若合并后同一人出现自重叠，重叠部分会被合并并提示。
        </p>
        <Space wrap>
          {state.speakers
            .filter((s) => s.label !== mergeFrom)
            .map((s) => (
              <Button
                key={s.label}
                onClick={() => {
                  dispatch({ type: 'MERGE_SPEAKERS', from: mergeFrom!, into: s.label });
                  setMergeFrom(null);
                }}
              >
                {s.name}
              </Button>
            ))}
        </Space>
      </Modal>
    </div>
  );
}
