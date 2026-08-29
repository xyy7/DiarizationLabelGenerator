/**
 * The auto-identify panel: speakers ranked by eres2net similarity.
 *
 * Flow: right-click a segment -> 自动识别 -> this drawer. It plays the QUERY
 * segment first, then each stable audio clip, so the annotator can compare
 * with their ears while the numbers only narrow the candidates. Checking one
 * or more speakers and confirming reassigns the whole window to them --
 * several checked means the window belongs to all of them at once (overlap),
 * which is recorded as one segment per speaker over the same time range.
 *
 * Playback here is fully independent of the main wavesurfer (own <audio>): the
 * audio endpoint honours byte ranges, so seeking to the clip start is one
 * request. The main player is paused when the drawer opens.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Checkbox, Drawer, Empty, List, Spin, Tag, Tooltip,
} from 'antd';

import { api, ApiError } from '../api/client';
import { attach as attachVolume, resume as resumeVolume } from '../audio/masterVolume';
import type { Segment, SimilarityResult, Speaker } from '../types';

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

interface Props {
  open: boolean;
  recordingId: string;
  segment: Segment | null;
  speakers: Speaker[];
  onClose: () => void;
  onAssign: (labels: string[]) => void;
  /** Force-save before identifying, so stable flags have reached the server. */
  save: () => Promise<void>;
}

export default function SimilarityPanel({
  open, recordingId, segment, speakers, onClose, onAssign, save,
}: Props) {
  const [result, setResult] = useState<SimilarityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  // One shared <audio> for the query and every clip row: whichever plays,
  // everything else stands still.
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startedRef = useRef<string | null>(null);
  // The parent's `save` callback is recreated whenever its own saving state
  // flips; deps containing it would re-run the identify effect in the middle
  // of a request, cancel it, and leave the spinner forever (the bug this
  // component was written against). Always call the LATEST save, never
  // re-run on its identity.
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!open) return;
    setPlayingKey(null);
  }, [open]);

  useEffect(() => {
    if (!open || !segment) {
      startedRef.current = null;
      return;
    }
    const key = segment.id ?? `${segment.start_sec}-${segment.end_sec}`;
    if (startedRef.current === key) return;
    startedRef.current = key;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setChecked([segment.speaker_label]);

    (async () => {
      try {
        // The server ranks against ITS annotation: marking stable is an edit,
        // so flush the 2 s autosave first.
        await saveRef.current();
        const res = await api.similarity(
          recordingId, segment.start_sec, segment.end_sec,
        );
        if (!cancelled) setResult(res);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.code === 'verify_unavailable') {
          setError('识别服务不可用（verify 容器未启动或未构建）。标记仍可进行，只是暂时没有自动识别。');
        } else {
          setError(e instanceof ApiError ? e.message : '识别失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // `segment` is intentionally keyed by id only: an in-flight identify must
    // not be cancelled because some unrelated edit re-rendered its parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, segment?.id, recordingId]);

  const playAt = (key: string, start: number) => {
    const a = audioRef.current;
    if (!a) return;
    if (playingKey === key) {
      a.pause();
      setPlayingKey(null);
      return;
    }
    a.pause();
    attachVolume(a); // idempotent; routes the element to the master chain
    resumeVolume();  // must happen inside the click gesture
    // The endpoint answers byte ranges, so seeking is cheap. The seek must
    // wait for the metadata: setting currentTime on a not-yet-loaded element
    // is silently ignored in some browsers, which looks like "no sound".
    const go = () => {
      a.currentTime = start;
      void a.play().catch(() => setPlayingKey(null));
    };
    if (a.readyState >= HTMLMediaElement.HAVE_METADATA) {
      go();
    } else {
      a.addEventListener('loadedmetadata', go, { once: true });
    }
    setPlayingKey(key);
  };

  const speakerLabel = segment?.speaker_label ?? null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="自动识别相似度"
      width={420}
      destroyOnClose
      footer={
        <Button
          type="primary"
          block
          disabled={checked.length === 0 || loading}
          onClick={() => onAssign(checked)}
        >
          {checked.length === 0
            ? '请勾选至少一个说话人'
            : `改判给勾选的 ${checked.length} 个说话人${checked.length > 1 ? '（重叠标注）' : ''}`}
        </Button>
      }
    >
      <audio
        ref={audioRef}
        src={api.audioUrl(recordingId)}
        preload="metadata"
        onEnded={() => setPlayingKey(null)}
        onError={() => setPlayingKey(null)}
        style={{ display: 'none' }}
      />

      {segment ? (
        <div style={{ marginBottom: 12 }}>
          <div>
            <b>本段</b> {fmt(segment.start_sec)} – {fmt(segment.end_sec)}
            {speakerLabel !== null && (
              <Tag style={{ marginLeft: 8 }}>
                {speakers.find((s) => s.label === speakerLabel)?.name ?? speakerLabel}
              </Tag>
            )}
            <Button
              size="small"
              icon={<span aria-hidden>▶</span>}
              style={{ marginLeft: 8 }}
              onClick={() => playAt('query', segment.start_sec)}
            >
              播放本段
            </Button>
          </div>
          <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
            先听本段，再听各说话人的稳定音频；分数只是排序参考，耳朵说了算。
          </div>
        </div>
      ) : null}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
          <div style={{ color: '#888', marginTop: 8 }}>
            正在识别（首次约 1~3 秒，缓存补齐时会久一点）…
          </div>
        </div>
      ) : null}

      {error ? (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />
      ) : null}

      {result?.query.short ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="本段不足 0.8 秒，相似度仅供参考"
        />
      ) : null}

      {!loading && !error && result && (
        <List
          size="small"
          dataSource={result.items}
          renderItem={(item) => {
            const isCurrent = item.label === speakerLabel;
            const idx = checked.indexOf(item.label);
            return (
              <List.Item
                style={{ display: 'block', padding: '8px 0' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Checkbox
                    checked={idx >= 0}
                    onChange={() => setChecked((c) => (
                      idx >= 0 ? c.filter((l) => l !== item.label) : [...c, item.label]
                    ))}
                  />
                  <span style={{ width: 12, height: 12, background: item.color, borderRadius: 3 }} />
                  <span>{item.name}</span>
                  {isCurrent ? <Tag>当前说话人</Tag> : null}
                  <Tag color={item.best_score >= 60 ? 'green' : item.best_score >= 30 ? 'orange' : 'default'}>
                    {item.best_score.toFixed(0)}%
                  </Tag>
                </div>
                <div style={{ marginLeft: 32, marginTop: 4 }}>
                  {item.clips.map((clip) => {
                    const key = `${item.label}:${clip.segment_id ?? clip.start_sec}`;
                    return (
                      <div
                        key={key}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0', color: '#555', fontSize: 12 }}
                      >
                        <Button
                          size="small"
                          type="text"
                          icon={<span aria-hidden>▶</span>}
                          onClick={() => playAt(key, clip.start_sec)}
                        />
                        {fmt(clip.start_sec)} – {fmt(clip.end_sec)}
                        <span style={{ color: '#999' }}>{clip.score.toFixed(0)}%</span>
                        {clip.short ? <Tooltip title="稳定音频过短，参考性有限">⚠</Tooltip> : null}
                      </div>
                    );
                  })}
                </div>
              </List.Item>
            );
          }}
          locale={{ emptyText: <Empty description="还没有任何说话人设置稳定音频" /> }}
        />
      )}

      {!loading && !error && result && result.unranked.length > 0 ? (
        <div style={{ marginTop: 12, color: '#999', fontSize: 12 }}>
          <div>未设置稳定音频（无法比对）：</div>
          <div style={{ marginTop: 4 }}>
            {result.unranked.map((sp) => (
              <Tag key={sp.label} style={{ color: '#999', marginBottom: 4 }}>{sp.name}</Tag>
            ))}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
