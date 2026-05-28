import React, { useState, useRef, useEffect } from 'react';
import { Button, Input, Popconfirm, Tooltip } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { Label, Channel } from '../../types';
import { useAppContext } from '../../store';

interface TimelineProps {
  channel: Channel;
  duration: number;
}

const Timeline: React.FC<TimelineProps> = ({ channel, duration }) => {
  const { dispatch } = useAppContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState<string | null>(null);
  const [dragType, setDragType] = useState<'start' | 'end' | 'move' | null>(null);
  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartTime, setDragStartTime] = useState(0);
  const [dragEndTime, setDragEndTime] = useState(0);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);

  const getTimeFromX = (x: number): number => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (x / rect.width) * duration));
  };

  const getXFromTime = (time: number): number => {
    if (!containerRef.current) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    return (time / duration) * rect.width;
  };

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
      const label = channel.labels.find(l => l.id === isDragging);
      if (!label) return;

      if (dragType === 'move') {
        const newStart = dragStartTime + deltaTime;
        const newEnd = dragEndTime + deltaTime;
        if (newStart >= 0 && newEnd <= duration) {
          dispatch({
            type: 'UPDATE_LABEL',
            channelId: channel.id,
            labelId: isDragging,
            updates: { startTime: newStart, endTime: newEnd },
          });
        }
      } else if (dragType === 'start') {
        const newStart = Math.max(0, dragStartTime + deltaTime);
        if (newStart < label.endTime) {
          dispatch({
            type: 'UPDATE_LABEL',
            channelId: channel.id,
            labelId: isDragging,
            updates: { startTime: newStart },
          });
        }
      } else if (dragType === 'end') {
        const newEnd = Math.min(duration, dragEndTime + deltaTime);
        if (newEnd > label.startTime) {
          dispatch({
            type: 'UPDATE_LABEL',
            channelId: channel.id,
            labelId: isDragging,
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
  };

  const startDrag = (
    e: React.MouseEvent,
    labelId: string,
    type: 'start' | 'end' | 'move',
    label: Label
  ) => {
    e.stopPropagation();
    setIsDragging(labelId);
    setDragType(type);
    const rect = containerRef.current!.getBoundingClientRect();
    setDragStartX(e.clientX - rect.left);
    setDragStartTime(label.startTime);
    setDragEndTime(label.endTime);
  };

  const startEdit = (label: Label) => {
    setEditingLabel(label.id);
    setEditText(label.text);
  };

  const saveEdit = () => {
    if (editingLabel) {
      dispatch({
        type: 'UPDATE_LABEL',
        channelId: channel.id,
        labelId: editingLabel,
        updates: { text: editText },
      });
      setEditingLabel(null);
    }
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          height: 60,
          background: '#f0f0f0',
          borderRadius: 4,
          cursor: 'crosshair',
          overflow: 'hidden',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {isSelecting && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${getXFromTime(Math.min(selectionStart, selectionEnd))}px`,
              width: `${Math.abs(getXFromTime(selectionEnd) - getXFromTime(selectionStart))}px`,
              background: 'rgba(24, 144, 255, 0.3)',
              pointerEvents: 'none',
            }}
          />
        )}

        {channel.labels
          .sort((a, b) => a.startTime - b.startTime)
          .map(label => (
            <div
              key={label.id}
              style={{
                position: 'absolute',
                top: 8,
                bottom: 8,
                left: `${getXFromTime(label.startTime)}px`,
                width: `${getXFromTime(label.endTime) - getXFromTime(label.startTime)}px`,
                background: channel.color,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'move',
                userSelect: 'none',
                minWidth: 40,
              }}
              onMouseDown={(e) => startDrag(e, label.id, 'move', label)}
            >
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 8,
                  cursor: 'w-resize',
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: '4px 0 0 4px',
                }}
                onMouseDown={(e) => startDrag(e, label.id, 'start', label)}
              />
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  bottom: 0,
                  width: 8,
                  cursor: 'e-resize',
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: '0 4px 4px 0',
                }}
                onMouseDown={(e) => startDrag(e, label.id, 'end', label)}
              />

              {editingLabel === label.id ? (
                <Input
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={saveEdit}
                  onEnterPress={saveEdit}
                  autoFocus
                  style={{
                    width: '80%',
                    fontSize: 12,
                    border: 'none',
                    background: 'rgba(255,255,255,0.9)',
                    color: '#333',
                  }}
                />
              ) : (
                <div style={{ padding: '0 16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {label.text || `${formatTime(label.startTime)} - ${formatTime(label.endTime)}`}
                </div>
              )}

              <div style={{ position: 'absolute', right: 20, top: 2, display: 'flex', gap: 4 }}>
                <Tooltip title="编辑">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined style={{ color: 'white', fontSize: 12 }} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      startEdit(label);
                    }}
                  />
                </Tooltip>
                <Popconfirm
                  title="确定删除此标签？"
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    dispatch({
                      type: 'DELETE_LABEL',
                      channelId: channel.id,
                      labelId: label.id,
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
          ))}
      </div>
    </div>
  );
};

export default Timeline;
