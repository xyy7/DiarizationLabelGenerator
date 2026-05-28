import React, { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Button, Slider, Space, Tooltip } from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  SoundOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
} from '@ant-design/icons';
import { useAppContext } from '../../store';

interface AudioPlayerProps {
  audioUrl: string | null;
}

const AudioPlayer: React.FC<AudioPlayerProps> = ({ audioUrl }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const { state, dispatch } = useAppContext();
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#ddd',
      progressColor: '#1890ff',
      cursorColor: '#1890ff',
      barWidth: 2,
      barGap: 3,
      barRadius: 3,
      height: 128,
      normalize: true,
      minPxPerSec: 50,
      interact: true,
    });

    ws.on('ready', () => {
      setIsReady(true);
      dispatch({ type: 'SET_DURATION', duration: ws.getDuration() });
    });

    ws.on('audioprocess', () => {
      dispatch({ type: 'SET_CURRENT_TIME', time: ws.getCurrentTime() });
    });

    ws.on('play', () => dispatch({ type: 'SET_PLAYING', isPlaying: true }));
    ws.on('pause', () => dispatch({ type: 'SET_PLAYING', isPlaying: false }));
    ws.on('finish', () => dispatch({ type: 'SET_PLAYING', isPlaying: false }));
    ws.on('seek', (time) => dispatch({ type: 'SET_CURRENT_TIME', time }));

    wavesurferRef.current = ws;

    return () => {
      ws.destroy();
      setIsReady(false);
    };
  }, []);

  useEffect(() => {
    if (audioUrl && wavesurferRef.current) {
      wavesurferRef.current.load(audioUrl);
    }
  }, [audioUrl]);

  useEffect(() => {
    if (wavesurferRef.current && isReady) {
      wavesurferRef.current.setPlaybackRate(state.playbackRate);
      wavesurferRef.current.setVolume(state.volume);
    }
  }, [state.playbackRate, state.volume, isReady]);

  const togglePlay = () => {
    if (wavesurferRef.current) {
      wavesurferRef.current.playPause();
    }
  };

  const skip = (seconds: number) => {
    if (wavesurferRef.current) {
      const newTime = Math.max(0, Math.min(state.duration, wavesurferRef.current.getCurrentTime() + seconds));
      wavesurferRef.current.seekTo(newTime / state.duration);
    }
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  return (
    <div style={{ padding: '16px', background: '#f5f5f5', borderRadius: '8px' }}>
      <div ref={containerRef} style={{ marginBottom: '16px' }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
        <Space>
          <Tooltip title="后退 5 秒">
            <Button icon={<StepBackwardOutlined />} onClick={() => skip(-5)} />
          </Tooltip>
          <Button
            type="primary"
            size="large"
            icon={state.isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            onClick={togglePlay}
          >
            {state.isPlaying ? '暂停' : '播放'}
          </Button>
          <Tooltip title="前进 5 秒">
            <Button icon={<StepForwardOutlined />} onClick={() => skip(5)} />
          </Tooltip>
        </Space>

        <Space>
          <span>{formatTime(state.currentTime)}</span>
          <span>/</span>
          <span>{formatTime(state.duration)}</span>
        </Space>

        <Space>
          <SoundOutlined />
          <Slider
            style={{ width: 100 }}
            min={0}
            max={1}
            step={0.01}
            value={state.volume}
            onChange={(value) => dispatch({ type: 'SET_VOLUME', volume: value })}
          />
        </Space>

        <Space>
          <span>倍速:</span>
          <Slider
            style={{ width: 100 }}
            min={0.5}
            max={2}
            step={0.1}
            value={state.playbackRate}
            onChange={(value) => dispatch({ type: 'SET_PLAYBACK_RATE', rate: value })}
          />
          <span>{state.playbackRate}x</span>
        </Space>
      </div>
    </div>
  );
};

export default AudioPlayer;
