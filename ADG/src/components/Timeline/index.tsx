import React, { useState, useRef, useEffect } from 'react';
import { Button, Input, Popconfirm, Tooltip, Modal, Form, InputNumber, Space, Input as AntInput, message, Slider } from 'antd';
import { DeleteOutlined, EditOutlined, SettingOutlined, ScissorOutlined, PlayCircleOutlined, PauseCircleOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import { Label, Channel, Subtitle } from '../../types';
import { useAppContext } from '../../store';

interface TimelineProps {
  channel: Channel;
  channels: Channel[];
  duration: number;
  currentAudioFile?: any;
  onPlaySegment?: (start: number, end: number) => void;
}

const Timeline: React.FC<TimelineProps> = ({ channel, channels, duration, currentAudioFile, onPlaySegment }) => {
  const { dispatch, state } = useAppContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState<string | null>(null);
  const [dragType, setDragType] = useState<'start' | 'end' | 'move' | null>(null);
  const [dragItemType, setDragItemType] = useState<'label' | 'subtitle' | null>(null);
  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartTime, setDragStartTime] = useState(0);
  const [dragEndTime, setDragEndTime] = useState(0);
  const [editingItem, setEditingItem] = useState<{ id: string; type: 'label' | 'subtitle' } | null>(null);
  const [editText, setEditText] = useState('');
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [currentEditingItem, setCurrentEditingItem] = useState<{ item: Label | Subtitle; type: 'label' | 'subtitle' } | null>(null);
  const [form] = Form.useForm();
  const [clipModalVisible, setClipModalVisible] = useState(false);
  const [clipStart, setClipStart] = useState(0);
  const [clipEnd, setClipEnd] = useState(duration || 10);
  const [zoom, setZoom] = useState(1); // 1 = 100%
  const [scrollX, setScrollX] = useState(0);
  const [viewWidth, setViewWidth] = useState(800); // 默认视口宽度

  // 计算缩放后的时间轴总宽度
  const getTimelineWidth = () => {
    return viewWidth * zoom;
  };

  const getTimeFromX = (x: number): number => {
    const timelineWidth = getTimelineWidth();
    return Math.max(0, Math.min(duration, ((x + scrollX) / timelineWidth) * duration));
  };

  const getXFromTime = (time: number): number => {
    const timelineWidth = getTimelineWidth();
    return (time / duration) * timelineWidth - scrollX;
  };

  // 缩放控制
  const handleZoomIn = () => {
    setZoom(prev => Math.min(10, prev * 1.2));
  };

  const handleZoomOut = () => {
    setZoom(prev => Math.max(0.2, prev / 1.2));
  };

  const handleZoomReset = () => {
    setZoom(1);
    setScrollX(0);
  };

  // 监听容器宽度变化
  useEffect(() => {
    const updateViewWidth = () => {
      if (scrollContainerRef.current) {
        const rect = scrollContainerRef.current.getBoundingClientRect();
        setViewWidth(rect.width);
      }
    };

    updateViewWidth();
    window.addEventListener('resize', updateViewWidth);
    return () => window.removeEventListener('resize', updateViewWidth);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = getTimeFromX(x);
    setIsSelecting(true);
    setSelectionStart(time);
    setSelectionEnd(time);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isSelecting && !isDragging) return;
    const rect = containerRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = getTimeFromX(x);

    if (isSelecting) {
      setSelectionEnd(time);
    } else if (isDragging && dragType && dragItemType) {
      const deltaTime = time - getTimeFromX(dragStartX);
      let item: Label | Subtitle | undefined;
      
      if (dragItemType === 'label') {
        item = channel.labels.find(l => l.id === isDragging);
      } else {
        item = channel.subtitles.find(s => s.id === isDragging);
      }
      
      if (!item) return;

      if (dragType === 'move') {
        const newStart = dragStartTime + deltaTime;
        const newEnd = dragEndTime + deltaTime;
        if (newStart >= 0 && newEnd <= duration) {
          if (dragItemType === 'label') {
            dispatch({
              type: 'UPDATE_LABEL',
              channelId: channel.id,
              labelId: isDragging,
              updates: { startTime: newStart, endTime: newEnd },
            });
          } else {
            dispatch({
              type: 'UPDATE_SUBTITLE',
              channelId: channel.id,
              subtitleId: isDragging,
              updates: { startTime: newStart, endTime: newEnd },
            });
          }
        }
      } else if (dragType === 'start') {
        const newStart = Math.max(0, dragStartTime + deltaTime);
        if (newStart < item.endTime) {
          if (dragItemType === 'label') {
            dispatch({
              type: 'UPDATE_LABEL',
              channelId: channel.id,
              labelId: isDragging,
              updates: { startTime: newStart },
            });
          } else {
            dispatch({
              type: 'UPDATE_SUBTITLE',
              channelId: channel.id,
              subtitleId: isDragging,
              updates: { startTime: newStart },
            });
          }
        }
      } else if (dragType === 'end') {
        const newEnd = Math.min(duration, dragEndTime + deltaTime);
        if (newEnd > item.startTime) {
          if (dragItemType === 'label') {
            dispatch({
              type: 'UPDATE_LABEL',
              channelId: channel.id,
              labelId: isDragging,
              updates: { endTime: newEnd },
            });
          } else {
            dispatch({
              type: 'UPDATE_SUBTITLE',
              channelId: channel.id,
              subtitleId: isDragging,
              updates: { endTime: newEnd },
            });
          }
        }
      }
    }
  };

  const handleMouseUp = () => {
    if (isSelecting) {
      const start = Math.min(selectionStart, selectionEnd);
      const end = Math.max(selectionStart, selectionEnd);
      if (end - start > 0.1) {
        dispatch({
          type: 'ADD_LABEL',
          channelId: channel.id,
          startTime: start,
          endTime: end,
          text: '新标签',
        });
      }
    }
    setIsSelecting(false);
    setIsDragging(null);
    setDragType(null);
    setDragItemType(null);
  };

  const startDrag = (
    e: React.MouseEvent,
    itemId: string,
    itemType: 'label' | 'subtitle',
    type: 'start' | 'end' | 'move',
    item: Label | Subtitle
  ) => {
    e.stopPropagation();
    setIsDragging(itemId);
    setDragItemType(itemType);
    setDragType(type);
    const rect = containerRef.current!.getBoundingClientRect();
    setDragStartX(e.clientX - rect.left);
    setDragStartTime(item.startTime);
    setDragEndTime(item.endTime);
  };

  const startEdit = (item: Label | Subtitle, type: 'label' | 'subtitle') => {
    setEditingItem({ id: item.id, type });
    setEditText(item.text);
  };

  const saveEdit = () => {
    if (editingItem) {
      if (editingItem.type === 'label') {
        dispatch({
          type: 'UPDATE_LABEL',
          channelId: channel.id,
          labelId: editingItem.id,
          updates: { text: editText },
        });
      } else {
        dispatch({
          type: 'UPDATE_SUBTITLE',
          channelId: channel.id,
          subtitleId: editingItem.id,
          updates: { text: editText },
        });
      }
      setEditingItem(null);
    }
  };

  const openSettings = (e: React.MouseEvent, item: Label | Subtitle, type: 'label' | 'subtitle') => {
    e.stopPropagation();
    setCurrentEditingItem({ item, type });
    form.setFieldsValue({
      text: item.text,
      startTime: item.startTime,
      endTime: item.endTime,
    });
    setSettingsModalVisible(true);
  };

  const saveSettings = () => {
    form.validateFields().then((values) => {
      if (currentEditingItem) {
        if (currentEditingItem.type === 'label') {
          dispatch({
            type: 'UPDATE_LABEL',
            channelId: channel.id,
            labelId: currentEditingItem.item.id,
            updates: {
              text: values.text,
              startTime: values.startTime,
              endTime: values.endTime,
            },
          });
        } else {
          dispatch({
            type: 'UPDATE_SUBTITLE',
            channelId: channel.id,
            subtitleId: currentEditingItem.item.id,
            updates: {
              text: values.text,
              startTime: values.startTime,
              endTime: values.endTime,
            },
          });
        }
      }
      setSettingsModalVisible(false);
    });
  };

  const handleDoubleClick = (e: React.MouseEvent, item: Label | Subtitle, type: 'label' | 'subtitle') => {
    e.stopPropagation();
    openSettings(e, item, type);
  };

  const convertLabelToSubtitle = (e: React.MouseEvent, label: Label) => {
    e.stopPropagation();
    dispatch({
      type: 'ADD_SUBTITLE',
      channelId: channel.id,
      startTime: label.startTime,
      endTime: label.endTime,
      text: label.text,
    });
    dispatch({
      type: 'DELETE_LABEL',
      channelId: channel.id,
      labelId: label.id,
    });
  };

  const convertSubtitleToLabel = (e: React.MouseEvent, subtitle: Subtitle) => {
    e.stopPropagation();
    dispatch({
      type: 'ADD_LABEL',
      channelId: channel.id,
      startTime: subtitle.startTime,
      endTime: subtitle.endTime,
      text: subtitle.text,
    });
    dispatch({
      type: 'DELETE_SUBTITLE',
      channelId: channel.id,
      subtitleId: subtitle.id,
    });
  };

  const openClipModal = (start: number, end: number) => {
    setClipStart(start);
    setClipEnd(end);
    setClipModalVisible(true);
  };

  const handleClipToNewProject = () => {
    // 剪切逻辑：更新所有标签和字幕的时间
    const clipDuration = clipEnd - clipStart;
    
    // 处理所有通道，不是只处理当前通道
    const processedChannels = channels.map(ch => {
      const newChannelId = uuidv4();
      return {
        ...ch,
        id: newChannelId,
        labels: ch.labels
          .filter(l => l.endTime > clipStart && l.startTime < clipEnd)
          .map(l => ({
            ...l,
            id: uuidv4(),
            channelId: newChannelId, // 更新channelId为新通道的id
            startTime: Math.max(0, l.startTime - clipStart),
            endTime: Math.min(clipDuration, l.endTime - clipStart),
          })),
        subtitles: ch.subtitles
          .filter(s => s.endTime > clipStart && s.startTime < clipEnd)
          .map(s => ({
            ...s,
            id: uuidv4(),
            startTime: Math.max(0, s.startTime - clipStart),
            endTime: Math.min(clipDuration, s.endTime - clipStart),
          })),
      };
    });
    
    // 创建新项目
    const newProject = {
      id: uuidv4(),
      name: `${state.project?.name || '项目'}_剪切_${formatDetailedTime(clipStart)}_${formatDetailedTime(clipEnd)}`,
      audioFiles: currentAudioFile ? [currentAudioFile] : [], // 保留原音频文件
      currentAudioId: currentAudioFile?.id || null,
      channels: processedChannels,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    dispatch({ type: 'CREATE_CLIP_PROJECT', project: newProject });
    message.success(`已创建剪切项目！\n开始时间: ${formatDetailedTime(clipStart)}\n结束时间: ${formatDetailedTime(clipEnd)}\n时长: ${(clipDuration).toFixed(2)}秒`);
    setClipModalVisible(false);
  };

  const handleDeleteSegment = () => {
    // 删除片段逻辑
    const segmentDuration = clipEnd - clipStart;
    
    // 对所有通道进行处理
    channels.forEach(ch => {
      // 更新标签
      ch.labels.forEach(label => {
        if (label.endTime <= clipStart) {
          // 标签在删除段前，无需更改
        } else if (label.startTime >= clipEnd) {
          // 标签在删除段后，向前移动
          dispatch({
            type: 'UPDATE_LABEL',
            channelId: ch.id,
            labelId: label.id,
            updates: {
              startTime: label.startTime - segmentDuration,
              endTime: label.endTime - segmentDuration,
            },
          });
        } else if (label.startTime < clipStart && label.endTime > clipEnd) {
          // 标签包含删除段，分割为两个标签
          dispatch({
            type: 'UPDATE_LABEL',
            channelId: ch.id,
            labelId: label.id,
            updates: { endTime: clipStart },
          });
          dispatch({
            type: 'ADD_LABEL',
            channelId: ch.id,
            startTime: clipStart,
            endTime: label.endTime - segmentDuration,
            text: label.text,
          });
        } else if (label.startTime < clipStart && label.endTime <= clipEnd) {
          // 标签与删除段前部分重叠
          dispatch({
            type: 'UPDATE_LABEL',
            channelId: ch.id,
            labelId: label.id,
            updates: { endTime: clipStart },
          });
        } else if (label.startTime >= clipStart && label.endTime > clipEnd) {
          // 标签与删除段后部分重叠
          dispatch({
            type: 'UPDATE_LABEL',
            channelId: ch.id,
            labelId: label.id,
            updates: {
              startTime: clipStart,
              endTime: label.endTime - segmentDuration,
            },
          });
        } else {
          // 标签完全在删除段内，删除
          dispatch({
            type: 'DELETE_LABEL',
            channelId: ch.id,
            labelId: label.id,
          });
        }
      });
      
      // 更新字幕
      ch.subtitles.forEach(subtitle => {
        if (subtitle.endTime <= clipStart) {
          // 字幕在删除段前，无需更改
        } else if (subtitle.startTime >= clipEnd) {
          // 字幕在删除段后，向前移动
          dispatch({
            type: 'UPDATE_SUBTITLE',
            channelId: ch.id,
            subtitleId: subtitle.id,
            updates: {
              startTime: subtitle.startTime - segmentDuration,
              endTime: subtitle.endTime - segmentDuration,
            },
          });
        } else if (subtitle.startTime < clipStart && subtitle.endTime > clipEnd) {
          // 字幕包含删除段，分割为两个字幕
          dispatch({
            type: 'UPDATE_SUBTITLE',
            channelId: ch.id,
            subtitleId: subtitle.id,
            updates: { endTime: clipStart },
          });
          dispatch({
            type: 'ADD_SUBTITLE',
            channelId: ch.id,
            startTime: clipStart,
            endTime: subtitle.endTime - segmentDuration,
            text: subtitle.text,
          });
        } else if (subtitle.startTime < clipStart && subtitle.endTime <= clipEnd) {
          // 字幕与删除段前部分重叠
          dispatch({
            type: 'UPDATE_SUBTITLE',
            channelId: ch.id,
            subtitleId: subtitle.id,
            updates: { endTime: clipStart },
          });
        } else if (subtitle.startTime >= clipStart && subtitle.endTime > clipEnd) {
          // 字幕与删除段后部分重叠
          dispatch({
            type: 'UPDATE_SUBTITLE',
            channelId: ch.id,
            subtitleId: subtitle.id,
            updates: {
              startTime: clipStart,
              endTime: subtitle.endTime - segmentDuration,
            },
          });
        } else {
          // 字幕完全在删除段内，删除
          dispatch({
            type: 'DELETE_SUBTITLE',
            channelId: ch.id,
            subtitleId: subtitle.id,
          });
        }
      });
    });
    
    message.success(`已删除片段！\n开始时间: ${formatDetailedTime(clipStart)}\n结束时间: ${formatDetailedTime(clipEnd)}`);
    setClipModalVisible(false);
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  const formatDetailedTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  };

  const allItems = [
    ...channel.labels.map(l => ({ ...l, type: 'label' })),
    ...channel.subtitles.map(s => ({ ...s, type: 'subtitle' })),
  ].sort((a, b) => a.startTime - b.startTime);

  return (
    <div>
      {/* 缩放控制栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
        padding: '4px 8px',
        background: '#fafafa',
        borderRadius: 4,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tooltip title="缩小">
            <Button
              type="text"
              icon={<ZoomOutOutlined />}
              onClick={handleZoomOut}
              disabled={zoom <= 0.2}
            />
          </Tooltip>
          <span style={{ fontSize: 12, color: '#666', minWidth: 60, textAlign: 'center' }}>
            {Math.round(zoom * 100)}%
          </span>
          <Tooltip title="放大">
            <Button
              type="text"
              icon={<ZoomInOutlined />}
              onClick={handleZoomIn}
              disabled={zoom >= 10}
            />
          </Tooltip>
          <Tooltip title="重置缩放">
            <Button
              type="text"
              size="small"
              onClick={handleZoomReset}
              style={{ fontSize: 12 }}
            >
              重置
            </Button>
          </Tooltip>
        </div>
        <div style={{ fontSize: 11, color: '#999' }}>
          提示：放大后可滚动查看更多细节
        </div>
      </div>

      {/* 滚动容器 */}
      <div
        ref={scrollContainerRef}
        style={{
          width: '100%',
          overflowX: 'auto',
          overflowY: 'visible',
          borderRadius: 8,
          marginBottom: 4,
        }}
        onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}
      >
        <div
          ref={containerRef}
          style={{
            position: 'relative',
            width: getTimelineWidth(),
            height: 100,
            background: '#f0f0f0',
            borderRadius: 8,
            cursor: 'crosshair',
            overflow: 'visible',
            padding: '4px 0',
            minWidth: viewWidth,
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* 时间轴刻度线 - 根据缩放动态调整密度 */}
          {(() => {
            // 根据缩放比例调整刻度间隔
            let interval = 5;
            if (zoom >= 2) interval = 1;
            else if (zoom >= 5) interval = 0.5;
            else if (zoom >= 8) interval = 0.1;
            
            const maxTick = Math.ceil(duration / interval) + 1;
            return Array.from({ length: maxTick }).map((_, i) => {
              const time = i * interval;
              const x = getXFromTime(time);
              
              // 只显示在可见范围内或附近的刻度
              if (x < -100 || x > viewWidth + 100) return null;
              
              const isMajor = time % 5 === 0;
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: `${x}px`,
                    bottom: 0,
                    width: isMajor ? 1 : 0.5,
                    background: isMajor ? '#ccc' : '#eee',
                    zIndex: 1,
                  }}
                >
                  {isMajor && (
                    <div style={{ fontSize: 10, color: '#999', marginTop: -18, marginLeft: 2, whiteSpace: 'nowrap' }}>
                      {formatDetailedTime(time)}
                    </div>
                  )}
                </div>
              );
            });
          })()}

        {isSelecting && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${getXFromTime(Math.min(selectionStart, selectionEnd))}px`,
              width: `${Math.abs(getXFromTime(selectionEnd) - getXFromTime(selectionStart))}px`,
              background: 'rgba(24, 144, 255, 0.2)',
              border: '2px dashed #1890ff',
              zIndex: 10,
              pointerEvents: 'none',
            }}
          >
            <div style={{
              position: 'absolute',
              top: -30,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(0,0,0,0.7)',
              color: 'white',
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 11,
              whiteSpace: 'nowrap',
            }}>
              {formatDetailedTime(Math.min(selectionStart, selectionEnd))} - {formatDetailedTime(Math.max(selectionStart, selectionEnd))}
              <Button
                type="text"
                size="small"
                icon={<ScissorOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  openClipModal(Math.min(selectionStart, selectionEnd), Math.max(selectionStart, selectionEnd));
                }}
                style={{ color: 'white', fontSize: 11, marginLeft: 8 }}
              />
            </div>
          </div>
        )}

        {allItems.map(item => {
          const left = getXFromTime(item.startTime);
          const right = getXFromTime(item.endTime);
          const width = right - left;
          
          // 只渲染在可见范围内或附近的项目
          if (right < -100 || left > viewWidth + 100) return null;
          
          return (
            <div
              key={item.id}
              style={{
                position: 'absolute',
                top: item.type === 'label' ? 8 : 52,
                height: 36,
                left: `${left}px`,
                width: `${Math.max(width, 30)}px`,
                background: item.type === 'label' ? channel.color : '#52c41a',
                borderRadius: 4,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                color: 'white',
                fontSize: 11,
                fontWeight: 500,
                cursor: 'move',
                userSelect: 'none',
                minWidth: 30,
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                zIndex: 5,
              }}
              onMouseDown={(e) => startDrag(e, item.id, item.type, 'move', item)}
              onDoubleClick={(e) => handleDoubleClick(e, item, item.type)}
            >
              {/* 拖动句柄 - 左 */}
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 10,
                  cursor: 'w-resize',
                  background: 'rgba(0,0,0,0.15)',
                  borderRadius: '4px 0 0 4px',
                  zIndex: 10,
                }}
                onMouseDown={(e) => startDrag(e, item.id, item.type, 'start', item)}
              />
              {/* 拖动句柄 - 右 */}
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: 10,
                  cursor: 'e-resize',
                  background: 'rgba(0,0,0,0.15)',
                  borderRadius: '0 4px 4px 0',
                  zIndex: 10,
                }}
                onMouseDown={(e) => startDrag(e, item.id, item.type, 'end', item)}
              />

              {/* 内容显示 */}
              <div style={{ 
                padding: '2px 12px', 
                overflow: 'hidden', 
                textOverflow: 'ellipsis', 
                whiteSpace: 'nowrap',
                lineHeight: 1.2,
              }}>
                {editingItem?.id === item.id && editingItem?.type === item.type ? (
                  <AntInput
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={saveEdit}
                    onPressEnter={saveEdit}
                    autoFocus
                    size="small"
                    style={{
                      width: '100%',
                      fontSize: 11,
                      border: 'none',
                      background: 'rgba(255,255,255,0.95)',
                      color: '#333',
                    }}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ fontWeight: 600, fontSize: 11 }}>
                      {item.text || `${formatDetailedTime(item.startTime)} - ${formatDetailedTime(item.endTime)}`}
                    </div>
                    <div style={{ fontSize: 9, opacity: 0.85 }}>
                      {formatDetailedTime(item.startTime)} - {formatDetailedTime(item.endTime)}
                    </div>
                  </div>
                )}
              </div>

              {/* 操作按钮 */}
              <div style={{ 
                position: 'absolute', 
                right: 14, 
                top: 2, 
                display: 'flex', 
                gap: 2,
                zIndex: 20,
              }}>
                {onPlaySegment && (
                  <Tooltip title="播放该片段">
                    <Button
                      type="text"
                      size="small"
                      icon={<PlayCircleOutlined style={{ color: 'white', fontSize: 12 }} />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlaySegment(item.startTime, item.endTime);
                      }}
                    />
                  </Tooltip>
                )}
                
                <Tooltip title="转换为字幕/标签">
                  <Button
                    type="text"
                    size="small"
                    icon={item.type === 'label' ? <SettingOutlined style={{ color: 'white', fontSize: 10 }} /> : <EditOutlined style={{ color: 'white', fontSize: 10 }} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (item.type === 'label') {
                        convertLabelToSubtitle(e, item as Label);
                      } else {
                        convertSubtitleToLabel(e, item as Subtitle);
                      }
                    }}
                  />
                </Tooltip>
                
                <Tooltip title="编辑">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined style={{ color: 'white', fontSize: 12 }} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      openSettings(e, item, item.type);
                    }}
                  />
                </Tooltip>
                
                <Popconfirm
                  title={`确定删除此${item.type === 'label' ? '标签' : '字幕'}？`}
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    if (item.type === 'label') {
                      dispatch({
                        type: 'DELETE_LABEL',
                        channelId: channel.id,
                        labelId: item.id,
                      });
                    } else {
                      dispatch({
                        type: 'DELETE_SUBTITLE',
                        channelId: channel.id,
                        subtitleId: item.id,
                      });
                    }
                  }}
                  okText="确定"
                  cancelText="取消"
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined style={{ color: 'white', fontSize: 12 }} />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Popconfirm>
              </div>

              {/* 类型标识 */}
              <div style={{
                position: 'absolute',
                top: -16,
                left: 0,
                fontSize: 10,
                background: item.type === 'label' ? channel.color : '#52c41a',
                color: 'white',
                padding: '1px 6px',
                borderRadius: '4px 4px 0 0',
                fontWeight: 600,
              }}>
                {item.type === 'label' ? '标签' : '字幕'}
              </div>
            </div>
          );
        })}
        </div>
      </div>

      {/* 设置弹窗 */}
      <Modal
        title="设置"
        open={settingsModalVisible}
        onOk={saveSettings}
        onCancel={() => setSettingsModalVisible(false)}
        width={500}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="text"
            label="文字内容"
            rules={[{ required: true, message: '请输入内容' }]}
          >
            <Input.TextArea placeholder="请输入内容" rows={3} />
          </Form.Item>
          <Form.Item
            name="startTime"
            label="开始时间 (秒)"
            rules={[{ required: true, message: '请输入开始时间' }]}
          >
            <InputNumber
              style={{ width: '100%' }}
              min={0}
              max={duration}
              step={0.01}
              precision={2}
              placeholder="开始时间"
            />
          </Form.Item>
          <Form.Item
            name="endTime"
            label="结束时间 (秒)"
            rules={[{ required: true, message: '请输入结束时间' }]}
          >
            <InputNumber
              style={{ width: '100%' }}
              min={0}
              max={duration}
              step={0.01}
              precision={2}
              placeholder="结束时间"
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 音频剪切弹窗 */}
      <Modal
        title="音频片段操作"
        open={clipModalVisible}
        onCancel={() => setClipModalVisible(false)}
        footer={null}
        width={500}
      >
        <div style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 16, fontSize: 14 }}>
            选择片段: <strong>{formatDetailedTime(clipStart)}</strong> - <strong>{formatDetailedTime(clipEnd)}</strong>
          </div>
          <Form layout="vertical">
            <Form.Item label="开始时间 (秒)">
              <InputNumber
                style={{ width: '100%' }}
                value={clipStart}
                onChange={setClipStart}
                min={0}
                max={clipEnd}
                step={0.01}
                precision={2}
              />
            </Form.Item>
            <Form.Item label="结束时间 (秒)">
              <InputNumber
                style={{ width: '100%' }}
                value={clipEnd}
                onChange={setClipEnd}
                min={clipStart}
                max={duration}
                step={0.01}
                precision={2}
              />
            </Form.Item>
          </Form>
        </div>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Button
            type="primary"
            icon={<ScissorOutlined />}
            block
            onClick={handleClipToNewProject}
          >
            剪切片段到新项目
          </Button>
          <Button
            danger
            icon={<DeleteOutlined />}
            block
            onClick={handleDeleteSegment}
          >
            删除该片段（并更新标签和字幕时间）
          </Button>
        </Space>
      </Modal>
    </div>
  );
};

export default Timeline;
