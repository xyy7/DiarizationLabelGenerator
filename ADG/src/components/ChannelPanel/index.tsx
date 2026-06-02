import React, { useState, useRef, useEffect } from 'react';
import { Button, Input, Popconfirm, Table, Space } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, UploadOutlined, UpOutlined, DownOutlined } from '@ant-design/icons';
import Timeline from '../Timeline';
import { Channel, TrackItem } from '../../types';
import { useAppContext } from '../../store';
import { exportSRT, importSRT } from '../../utils';

interface ChannelPanelProps {
  channel: Channel;
  channels: Channel[];
  duration: number;
  currentAudioFile?: any;
  onScrollToItem?: (itemId: string) => void;
}

const ChannelPanel: React.FC<ChannelPanelProps> = ({ channel, channels, duration, currentAudioFile, onScrollToItem }) => {
  const { dispatch } = useAppContext();
  const [isEditingName, setIsEditingName] = useState(false);
  const [name, setName] = useState(channel.name);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  // 处理外部传来的滚动事件
  useEffect(() => {
    if (onScrollToItem) {
      const originalOnScroll = onScrollToItem;
      // 这里我们通过一个 ref 或自定义事件来处理，但这里先跳过，后面在 Timeline 中处理
    }
  }, [onScrollToItem]);

  const handleSaveName = () => {
    dispatch({ type: 'UPDATE_CHANNEL', channelId: channel.id, updates: { name } });
    setIsEditingName(false);
  };

  const itemColumns = [
    {
      title: '开始时间',
      dataIndex: 'startTime',
      key: 'startTime',
      render: (time: number) => formatTime(time),
    },
    {
      title: '结束时间',
      dataIndex: 'endTime',
      key: 'endTime',
      render: (time: number) => formatTime(time),
    },
    {
      title: '内容',
      dataIndex: 'text',
      key: 'text',
      render: (text: string, record: TrackItem) => (
        <Input
          value={text}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_ITEM',
              channelId: channel.id,
              itemId: record.id,
              updates: { text: e.target.value },
            })
          }
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: TrackItem) => (
        <Popconfirm
          title="确定删除此标签？"
          onConfirm={() =>
            dispatch({ type: 'DELETE_ITEM', channelId: channel.id, itemId: record.id })
          }
          okText="确定"
          cancelText="取消"
        >
          <Button type="text" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  const handleImportSubtitle = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const subtitles = importSRT(content);
      subtitles.forEach(sub => {
        dispatch({
          type: 'ADD_ITEM',
          channelId: channel.id,
          startTime: sub.startTime,
          endTime: sub.endTime,
          text: sub.text,
        });
      });
    };
    reader.readAsText(file);
    return false;
  };

  const handleExportSubtitle = () => {
    const content = exportSRT(channel.items);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${channel.name}_subtitle.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  // 滚动到指定的标签行
  const scrollToItem = (itemId: string) => {
    if (!tableRef.current) return;

    const rows = tableRef.current.querySelectorAll('.ant-table-row');
    const sortedItems = [...channel.items].sort((a, b) => a.startTime - b.startTime);
    const index = sortedItems.findIndex(item => item.id === itemId);

    if (index >= 0 && rows[index]) {
      rows[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedItemId(itemId);
      setTimeout(() => setHighlightedItemId(null), 2000);
    }
  };

  return (
    <div style={{ marginBottom: 16, border: '1px solid #e8e8e8', borderRadius: 8, overflow: 'hidden' }}>
      <div
        style={{
          padding: '8px 16px',
          background: channel.color,
          color: 'white',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
        }}
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }} onClick={(e) => e.stopPropagation()}>
          {isCollapsed ? (
            <DownOutlined style={{ fontSize: 12 }} />
          ) : (
            <UpOutlined style={{ fontSize: 12 }} />
          )}
          
          {isEditingName ? (
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleSaveName}
              onPressEnter={handleSaveName}
              autoFocus
              style={{ width: 200 }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 16 }}>{channel.name}</span>
              <Button
                type="text"
                icon={<EditOutlined style={{ color: 'white' }} />}
                onClick={() => setIsEditingName(true)}
              />
            </div>
          )}
        </div>
        
        <Popconfirm
          title="确定删除此通道？"
          onConfirm={() => dispatch({ type: 'DELETE_CHANNEL', channelId: channel.id })}
          okText="确定"
          cancelText="取消"
        >
          <Button 
            type="text" 
            danger 
            icon={<DeleteOutlined style={{ color: 'white' }} />} 
            onClick={(e) => e.stopPropagation()}
          />
        </Popconfirm>
      </div>

      {!isCollapsed && (
        <div style={{ padding: '0 16px' }}>
          <div style={{ padding: '8px 0 16px' }}>
            <p style={{ fontSize: 12, color: '#666', margin: '0 0 8px' }}>
              在下方拖动鼠标选择区域添加标签
            </p>
            <Timeline 
              channel={channel} 
              channels={channels} 
              duration={duration} 
              currentAudioFile={currentAudioFile}
              onItemClick={scrollToItem}
            />
          </div>

          <div style={{ padding: '0 0 16px' }}>
            <Space style={{ marginBottom: 16 }}>
              <Button
                icon={<PlusOutlined />}
                onClick={() =>
                  dispatch({
                    type: 'ADD_ITEM',
                    channelId: channel.id,
                    startTime: 0,
                    endTime: 5,
                    text: '新标签',
                  })
                }
              >
                添加标签
              </Button>
              <UploadOutlined
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.srt';
                  input.onchange = (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (file) handleImportSubtitle(file);
                  };
                  input.click();
                }}
                style={{ cursor: 'pointer', fontSize: 20 }}
              />
              <Button icon={<UploadOutlined />} onClick={handleExportSubtitle}>
                导出字幕
              </Button>
            </Space>
            
            <div style={{ maxHeight: 300, overflowY: 'auto' }} ref={tableRef}>
              <Table
                dataSource={channel.items.sort((a, b) => a.startTime - b.startTime)}
                columns={itemColumns}
                rowKey="id"
                size="small"
                pagination={false}
                rowClassName={(record) => 
                  highlightedItemId === record.id ? 'highlighted-row' : ''
                }
              />
            </div>
            
            {/* 高亮样式 */}
            <style>{`
              .highlighted-row {
                background-color: #e6f7ff !important;
                transition: background-color 0.3s;
              }
            `}</style>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChannelPanel;
