import React, { useState, useRef, useEffect } from 'react';
import { Button, Input, Popconfirm, Tooltip, Modal, Form, InputNumber, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, SettingOutlined } from '@ant-design/icons';
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
  const [labelSettingsModalVisible, setLabelSettingsModalVisible] = useState(false);
  const [currentEditingLabel, setCurrentEditingLabel] = useState<Label | null>(null);
  const [form] = Form.useForm();

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

  const openLabelSettings = (e: React.MouseEvent, label: Label) => {
    e.stopPropagation();
    setCurrentEditingLabel(label);
    form.setFieldsValue({
      text: label.text,
      startTime: label.startTime,
      endTime: label.endTime,
    });
    setLabelSettingsModalVisible(true);
  };

  const saveLabelSettings = () => {
    form.validateFields().then((values) => {
      if (currentEditingLabel) {
        dispatch({
          type: 'UPDATE_LABEL',
          channelId: channel.id,
          labelId: currentEditingLabel.id,
          updates: {
            text: values.text,
            startTime: values.startTime,
            endTime: values.endTime,
          },
        });
      }
      setLabelSettingsModalVisible(false);
    });
  };

  const handleDoubleClick = (e: React.MouseEvent, label: Label) => {
    e.stopPropagation();
    openLabelSettings(e, label);
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
              onDoubleClick={(e) => handleDoubleClick(e, label)}
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
                <Tooltip title="标签设置">
                  <Button
                    type="text"
                    size="small"
                    icon={<SettingOutlined style={{ color: 'white', fontSize: 12 }} />}
                    onClick={(e) => openLabelSettings(e, label)}
                  />
                </Tooltip>
                <Tooltip title="编辑文字">
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

              <div style={{ position: 'absolute', bottom: -18, left: 0, right: 0, textAlign: 'center', fontSize: 10, color: '#999' }}>
                <Tag color={channel.color} style={{ fontSize: 10, margin: 0 }}>
                  {formatDetailedTime(label.startTime)} - {formatDetailedTime(label.endTime)}
                </Tag>
              </div>
            </div>
          ))}
      </div>

      <Modal
        title="标签设置"
        open={labelSettingsModalVisible}
        onOk={saveLabelSettings}
        onCancel={() => setLabelSettingsModalVisible(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="text"
            label="标签文字"
            rules={[{ required: true, message: '请输入标签文字' }]}
          >
            <Input placeholder="请输入标签文字" />
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
    </div>
  );
};

export default Timeline;
