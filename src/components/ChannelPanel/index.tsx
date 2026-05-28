import React, { useState } from 'react';
import { Button, Input, Popconfirm, Tabs, Table, Space } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import Timeline from '../Timeline';
import { Channel, Subtitle } from '../../types';
import { useAppContext } from '../../store';
import { exportSRT, importSRT } from '../../utils';

interface ChannelPanelProps {
  channel: Channel;
  channels: Channel[];
  duration: number;
  currentAudioFile?: any;
}

const ChannelPanel: React.FC<ChannelPanelProps> = ({ channel, channels, duration, currentAudioFile }) => {
  const { dispatch, state } = useAppContext();
  const [isEditingName, setIsEditingName] = useState(false);
  const [name, setName] = useState(channel.name);
  const [activeTab, setActiveTab] = useState('labels');

  const handleSaveName = () => {
    dispatch({ type: 'UPDATE_CHANNEL', channelId: channel.id, updates: { name } });
    setIsEditingName(false);
  };

  const subtitleColumns = [
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
      title: '字幕内容',
      dataIndex: 'text',
      key: 'text',
      render: (text: string, record: Subtitle) => (
        <Input
          value={text}
          onChange={(e) =>
            dispatch({
              type: 'UPDATE_SUBTITLE',
              channelId: channel.id,
              subtitleId: record.id,
              updates: { text: e.target.value },
            })
          }
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: Subtitle) => (
        <Popconfirm
          title="确定删除此字幕？"
          onConfirm={() =>
            dispatch({ type: 'DELETE_SUBTITLE', channelId: channel.id, subtitleId: record.id })
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
          type: 'ADD_SUBTITLE',
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
    const content = exportSRT(channel.subtitles);
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
        }}
      >
        {isEditingName ? (
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleSaveName}
            onEnterPress={handleSaveName}
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
        <Popconfirm
          title="确定删除此通道？"
          onConfirm={() => dispatch({ type: 'DELETE_CHANNEL', channelId: channel.id })}
          okText="确定"
          cancelText="取消"
        >
          <Button type="text" danger icon={<DeleteOutlined style={{ color: 'white' }} />} />
        </Popconfirm>
      </div>

      <Tabs activeKey={activeTab} onChange={setActiveTab} style={{ padding: '0 16px' }}>
        <Tabs.TabPane tab="标签" key="labels">
          <div style={{ padding: '8px 0 16px' }}>
            <p style={{ fontSize: 12, color: '#666', margin: '0 0 8px' }}>
              在下方拖动鼠标选择区域添加标签
            </p>
            <Timeline 
              channel={channel} 
              channels={channels} 
              duration={duration} 
              currentAudioFile={currentAudioFile}
            />
          </div>
        </Tabs.TabPane>

        <Tabs.TabPane tab="字幕" key="subtitles">
          <div style={{ padding: '8px 0 16px' }}>
            <Space style={{ marginBottom: 16 }}>
              <Button
                icon={<PlusOutlined />}
                onClick={() =>
                  dispatch({
                    type: 'ADD_SUBTITLE',
                    channelId: channel.id,
                    startTime: 0,
                    endTime: 5,
                    text: '新字幕',
                  })
                }
              >
                添加字幕
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
            <Table
              dataSource={channel.subtitles.sort((a, b) => a.startTime - b.startTime)}
              columns={subtitleColumns}
              rowKey="id"
              size="small"
              pagination={false}
            />
          </div>
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
};

export default ChannelPanel;
