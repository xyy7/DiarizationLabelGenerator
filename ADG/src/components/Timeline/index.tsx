import React, { useState, useRef, useEffect } from 'react';
import { Button, Input, Popconfirm, Tooltip, Modal, Form, InputNumber, Space, Input as AntInput, message } from 'antd';
import { DeleteOutlined, EditOutlined, ScissorOutlined, PlayCircleOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import { TrackItem, Channel } from '../../types';
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
  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartTime, setDragStartTime] = useState(0);
  const [dragEndTime, setDragEndTime] = useState(0);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [currentEditingItem, setCurrentEditingItem] = useState<TrackItem | null>(null);
  const [form] = Form.useForm();
  const [clipModalVisible, setClipModalVisible] = useState(false);
  const [clipStart, setClipStart] = useState(0);
  const [clipEnd, setClipEnd] = useState(duration || 10);
  const [zoom, setZoom] = useState(1);
  const [scrollX, setScrollX] = useState(0);
  const [viewWidth, setViewWidth] = useState(800);

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
    } else if (isDragging && dragType) {
      const deltaTime = time - getTimeFromX(dragStartX);
      const item = channel.items.find(i => i.id === isDragging);
      
      if (!item) return;

      if (dragType === 'move') {
        const newStart = dragStartTime + deltaTime;
        const newEnd = dragEndTime + deltaTime;
        if (newStart >= 0 && newEnd <= duration) {
          dispatch({
            type: 'UPDATE_ITEM',
            channelId: channel.id,
            itemId: isDragging,
            updates: { startTime: newStart, endTime: newEnd },
          });
        }
      } else if (dragType === 'start') {
        const newStart = Math.max(0, dragStartTime + deltaTime);
        if (newStart < item.endTime) {
          dispatch({
            type: 'UPDATE_ITEM',
            channelId: channel.id,
            itemId: isDragging,
            updates: { startTime: newStart },
          });
        }
      } else if (dragType === 'end') {
        const newEnd = Math.min(duration, dragEndTime + deltaTime);
        if (newEnd > item.startTime) {
          dispatch({
            type: 'UPDATE_ITEM',
            channelId: channel.id,
            itemId: isDragging,
            updates: { endTime: newEnd },
          });
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
          type: 'ADD_ITEM',
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
  };

  const startDrag = (
    e: React.MouseEvent,
    itemId: string,
    type: 'start' | 'end' | 'move',
    item: TrackItem
  ) => {
    e.stopPropagation();
    setIsDragging(itemId);
    setDragType(type);
    const rect = containerRef.current!.getBoundingClientRect();
    setDragStartX(e.clientX - rect.left);
    setDragStartTime(item.startTime);
    setDragEndTime(item.endTime);
  };

  const saveEdit = () => {
    if (editingItem) {
      dispatch({
        type: 'UPDATE_ITEM',
        channelId: channel.id,
        itemId: editingItem,
        updates: { text: editText },
      });
      setEditingItem(null);
    }
  };

  const openSettings = (e: React.MouseEvent, item: TrackItem) => {
    e.stopPropagation();
    setCurrentEditingItem(item);
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
        dispatch({
          type: 'UPDATE_ITEM',
          channelId: channel.id,
          itemId: currentEditingItem.id,
          updates: {
            text: values.text,
            startTime: values.startTime,
            endTime: values.endTime,
          },
        });
      }
      setSettingsModalVisible(false);
    });
  };

  const handleDoubleClick = (e: React.MouseEvent, item: TrackItem) => {
    e.stopPropagation();
    openSettings(e, item);
  };

  const openClipModal = (start: number, end: number) => {
    setClipStart(start);
    setClipEnd(end);
    setClipModalVisible(true);
  };

  const handleClipToNewProject = () => {
    const clipDuration = clipEnd - clipStart;
    
    const processedChannels = channels.map(ch => {
      const newChannelId = uuidv4();
      return {
        ...ch,
        id: newChannelId,
        items: ch.items
          .filter(i => i.endTime > clipStart && i.startTime < clipEnd)
          .map(i => ({
            ...i,
            id: uuidv4(),
            startTime: Math.max(0, i.startTime - clipStart),
            endTime: Math.min(clipDuration, i.endTime - clipStart),
          })),
      };
    });

    const newProject = {
      id: uuidv4(),
      name: `${state.project?.name || '项目'}_剪切_${formatDetailedTime(clipStart)}_${formatDetailedTime(clipEnd)}`,
      audioFiles: currentAudioFile ? [currentAudioFile] : [],
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
    const segmentDuration = clipEnd - clipStart;
    
    channels.forEach(ch => {
      ch.items.forEach(item => {
        if (item.endTime <= clipStart) {
        } else if (item.startTime >= clipEnd) {
          dispatch({
            type: 'UPDATE_ITEM',
            channelId: ch.id,
            itemId: item.id,
            updates: {
              startTime: item.startTime - segmentDuration,
              endTime: item.endTime - segmentDuration,
            },
          });
        } else if (item.startTime < clipStart && item.endTime > clipEnd) {
          dispatch({
            type: 'UPDATE_ITEM',
            channelId: ch.id,
            itemId: item.id,
            updates: { endTime: clipStart },
          });
          dispatch({
            type: 'ADD_ITEM',
            channelId: ch.id,
            startTime: clipStart,
            endTime: item.endTime - segmentDuration,
            text: item.text,
          });
        } else if (item.startTime < clipStart && item.endTime <= clipEnd) {
          dispatch({
            type: 'UPDATE_ITEM',
            channelId: ch.id,
            itemId: item.id,
            updates: { endTime: clipStart },
          });
        } else if (item.startTime >= clipStart && item.endTime > clipEnd) {
          dispatch({
            type: 'UPDATE_ITEM',
            channelId: ch.id,
            itemId: item.id,
            updates: {
              startTime: clipStart,
              endTime: item.endTime - segmentDuration,
            },
          });
        } else {
          dispatch({
            type: 'DELETE_ITEM',
            channelId: ch.id,
            itemId: item.id,
          });
        }
      });
    });
    
    message.success(`已删除片段！\n开始时间: ${formatDetailedTime(clipStart)}\n结束时间: ${formatDetailedTime(clipEnd)}`);
    setClipModalVisible(false);
  };

  const formatDetailedTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  };

  return (
    <div>
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
            height: 60,
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
          {(() => {
            let interval = 5;
            if (zoom >= 2) interval = 1;
            else if (zoom >= 5) interval = 0.5;
            else if (zoom >= 8) interval = 0.1;
            
            const maxTick = Math.ceil(duration / interval) + 1;
            return Array.from({ length: maxTick }).map((_, i) => {
              const time = i * interval;
              const x = getXFromTime(time);
              
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

        {channel.items.map(item => {
          const left = getXFromTime(item.startTime);
          const right = getXFromTime(item.endTime);
          const width = right - left;
          
          if (right < -100 || left > viewWidth + 100) return null;
          
          return (
            <div
              key={item.id}
              style={{
                position: 'absolute',
                top: 8,
                height: 40,
                left: `${left}px`,
                width: `${Math.max(width, 40)}px`,
                background: channel.color,
                borderRadius: 6,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                color: 'white',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'move',
                userSelect: 'none',
                minWidth: 40,
                boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
                zIndex: 5,
              }}
              onMouseDown={(e) => startDrag(e, item.id, 'move', item)}
              onDoubleClick={(e) => handleDoubleClick(e, item)}
            >
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 12,
                  cursor: 'w-resize',
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: '6px 0 0 6px',
                  zIndex: 10,
                }}
                onMouseDown={(e) => startDrag(e, item.id, 'start', item)}
              />
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: 12,
                  cursor: 'e-resize',
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: '0 6px 6px 0',
                  zIndex: 10,
                }}
                onMouseDown={(e) => startDrag(e, item.id, 'end', item)}
              />

              <div style={{ 
                padding: '4px 14px', 
                overflow: 'hidden', 
                textOverflow: 'ellipsis', 
                whiteSpace: 'nowrap',
                lineHeight: 1.3,
              }}>
                {editingItem === item.id ? (
                  <AntInput
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={saveEdit}
                    onPressEnter={saveEdit}
                    autoFocus
                    size="small"
                    style={{
                      width: '100%',
                      fontSize: 12,
                      border: 'none',
                      background: 'rgba(255,255,255,0.95)',
                      color: '#333',
                    }}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>
                      {item.text || `标签`}
                    </div>
                    <div style={{ fontSize: 10, opacity: 0.85 }}>
                      {formatDetailedTime(item.startTime)} - {formatDetailedTime(item.endTime)}
                    </div>
                  </div>
                )}
              </div>

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
                
                <Tooltip title="编辑">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined style={{ color: 'white', fontSize: 12 }} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      openSettings(e, item);
                    }}
                  />
                </Tooltip>
                
                <Popconfirm
                  title="确定删除此标签？"
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    dispatch({
                      type: 'DELETE_ITEM',
                      channelId: channel.id,
                      itemId: item.id,
                    });
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
            </div>
          );
        })}
        </div>
      </div>

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
                onChange={(value) => value !== null && setClipStart(value)}
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
                onChange={(value) => value !== null && setClipEnd(value)}
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
            删除该片段（并更新标签时间）
          </Button>
        </Space>
      </Modal>
    </div>
  );
};

export default Timeline;