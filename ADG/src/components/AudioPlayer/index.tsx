import React, { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Button, Slider, Space, Tooltip, message } from 'antd';
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
  onUrlInvalid?: () => void;
}

const AudioPlayer: React.FC<AudioPlayerProps> = ({ audioUrl, onUrlInvalid }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const { state, dispatch } = useAppContext();
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const loadTimeoutRef = useRef<number | null>(null);

  // 键盘快捷键处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 防止在输入框中触发快捷键
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          skip(-5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          skip(5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          skip(10);
          break;
        case 'ArrowDown':
          e.preventDefault();
          skip(-10);
          break;
        case 'Digit1':
          e.preventDefault();
          dispatch({ type: 'SET_PLAYBACK_RATE', rate: 0.5 });
          break;
        case 'Digit2':
          e.preventDefault();
          dispatch({ type: 'SET_PLAYBACK_RATE', rate: 1 });
          break;
        case 'Digit3':
          e.preventDefault();
          dispatch({ type: 'SET_PLAYBACK_RATE', rate: 1.5 });
          break;
        case 'Digit4':
          e.preventDefault();
          dispatch({ type: 'SET_PLAYBACK_RATE', rate: 2 });
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [state.playbackRate, isReady]);

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
      // 清除超时
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      setIsReady(true);
      setLoadError(false);
      dispatch({ type: 'SET_DURATION', duration: ws.getDuration() });
    });

    ws.on('error', (error) => {
      console.error('WaveSurfer error:', error);
      setLoadError(true);
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      // 提示用户音频加载失败
      message.error('音频加载失败，请尝试重新导入该音频文件');
      if (onUrlInvalid) {
        onUrlInvalid();
      }
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
      setLoadError(false);
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (audioUrl && wavesurferRef.current) {
      setLoadError(false);
      setIsReady(false);
      dispatch({ type: 'SET_DURATION', duration: 0 });
      
      // 设置加载超时（10秒）
      loadTimeoutRef.current = window.setTimeout(() => {
        if (!isReady) {
          setLoadError(true);
          message.error('音频加载超时，请尝试重新导入该音频文件');
          if (onUrlInvalid) {
            onUrlInvalid();
          }
        }
      }, 10000);
      
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
    if (loadError) {
      message.warning('音频加载失败，请尝试重新导入该音频文件');
      return;
    }
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

  const presetSpeeds = [0.5, 1, 1.5, 2];

  return (
    <div style={{ padding: '16px', background: '#f5f5f5', borderRadius: '8px' }}>
      <div ref={containerRef} style={{ marginBottom: '16px' }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <Space>
          <Tooltip title="后退 5 秒">
            <Button icon={<StepBackwardOutlined />} onClick={() => skip(-5)} />
          </Tooltip>
          <Button
            type="primary"
            size="large"
            icon={state.isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            onClick={togglePlay}
            disabled={loadError}
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
          {presetSpeeds.map((speed) => (
            <Button
              key={speed}
              type={state.playbackRate === speed ? 'primary' : 'default'}
              size="small"
              onClick={() => dispatch({ type: 'SET_PLAYBACK_RATE', rate: speed })}
            >
              {speed}x
            </Button>
          ))}
          <Slider
            style={{ width: 80 }}
            min={0.5}
            max={2}
            step={0.1}
            value={state.playbackRate}
            onChange={(value) => dispatch({ type: 'SET_PLAYBACK_RATE', rate: value })}
          />
        </Space>
      </div>
      <div style={{ marginTop: '8px', fontSize: '12px', color: '#999', textAlign: 'center' }}>
        快捷键: 空格播放/暂停, 方向键快进/退, 1-4预设倍速
      </div>
    </div>
  );
};

export default AudioPlayer;
