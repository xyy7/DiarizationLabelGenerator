import React, { useEffect } from 'react';
import { Layout, Button, Space, Typography, List, Input, message } from 'antd';
import {
  PlusOutlined,
  FolderOpenOutlined,
  UploadOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import AudioPlayer from './components/AudioPlayer';
import ChannelPanel from './components/ChannelPanel';
import { AppProvider, useAppContext } from './store';
import { AudioFile } from './types';
import { exportLabels, importLabels } from './utils';

const { Header, Content, Sider } = Layout;
const { Title } = Typography;

const AppContent: React.FC = () => {
  const { state, dispatch } = useAppContext();

  // 自动保存到 localStorage
  useEffect(() => {
    if (state.project) {
      localStorage.setItem('audio_label_project', JSON.stringify(state.project));
    }
  }, [state.project]);

  // 加载保存的项目
  useEffect(() => {
    const saved = localStorage.getItem('audio_label_project');
    if (saved && !state.project) {
      try {
        const project = JSON.parse(saved);
        dispatch({ type: 'LOAD_PROJECT', project });
        message.success('已加载上次保存的项目');
      } catch (e) {
        console.error('Failed to load project:', e);
      }
    }
  }, [dispatch, state.project]);

  const handleCreateProject = () => {
    dispatch({ type: 'CREATE_PROJECT', name: '未命名项目' });
  };

  const handleAddAudio = (files: FileList) => {
    const audioFiles: AudioFile[] = Array.from(files).map(file => ({
      id: uuidv4(),
      name: file.name,
      url: URL.createObjectURL(file),
      file,
    }));
    dispatch({ type: 'ADD_AUDIO_FILES', files: audioFiles });
    if (!state.project?.currentAudioId && audioFiles.length > 0) {
      dispatch({ type: 'SET_CURRENT_AUDIO', audioId: audioFiles[0].id });
    }
    message.success(`已添加 ${audioFiles.length} 个音频文件`);
  };

  const handleAddChannel = () => {
    const count = (state.project?.channels.length || 0) + 1;
    dispatch({ type: 'ADD_CHANNEL', name: `说话人 ${count}` });
  };

  const handleExportLabels = () => {
    if (!state.project) return;
    const content = exportLabels(state.project.channels);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.project.name}_labels.json`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('标签已导出');
  };

  const handleImportLabels = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const channels = importLabels(content);
        channels.forEach(channel => {
          dispatch({ type: 'ADD_CHANNEL', name: channel.name });
        });
        message.success('标签已导入');
      } catch (err) {
        message.error('标签文件格式错误');
      }
    };
    reader.readAsText(file);
  };

  const currentAudio = state.project?.audioFiles.find(
    f => f.id === state.project?.currentAudioId
  );

  if (!state.project) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <Title level={2}>音频标签生成工具</Title>
          <p style={{ color: '#666', marginBottom: 32 }}>支持多说话人标签标记和字幕编辑</p>
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={handleCreateProject}>
            创建新项目
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ background: '#fff', padding: '0 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e8e8e8' }}>
        <Title level={4} style={{ margin: 0 }}>
          <Input
            value={state.project.name}
            onChange={(e) => dispatch({ type: 'LOAD_PROJECT', project: { ...state.project!, name: e.target.value } })}
            bordered={false}
            style={{ fontWeight: 600, fontSize: 20 }}
          />
        </Title>
        <Space>
          <Button
            icon={<UploadOutlined />}
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.json';
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) handleImportLabels(file);
              };
              input.click();
            }}
          >
            导入标签
          </Button>
          <Button icon={<SaveOutlined />} onClick={handleExportLabels}>
            导出标签
          </Button>
        </Space>
      </Header>
      <Layout>
        <Sider width={280} style={{ background: '#fff', borderRight: '1px solid #e8e8e8' }}>
          <div style={{ padding: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button
                type="primary"
                block
                icon={<FolderOpenOutlined />}
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = 'audio/*';
                  input.multiple = true;
                  input.onchange = (e) => {
                    const files = (e.target as HTMLInputElement).files;
                    if (files) handleAddAudio(files);
                  };
                  input.click();
                }}
              >
                导入音频文件
              </Button>

              <div style={{ marginTop: 16 }}>
                <Title level={5} style={{ marginBottom: 8 }}>音频文件</Title>
                <List
                  size="small"
                  bordered
                  dataSource={state.project.audioFiles}
                  renderItem={(file) => (
                    <List.Item
                      style={{
                        cursor: 'pointer',
                        background: file.id === state.project?.currentAudioId ? '#e6f7ff' : 'transparent',
                      }}
                      onClick={() => dispatch({ type: 'SET_CURRENT_AUDIO', audioId: file.id })}
                    >
                      {file.name}
                    </List.Item>
                  )}
                />
              </div>

              <div style={{ marginTop: 16 }}>
                <Title level={5} style={{ marginBottom: 8 }}>说话人通道</Title>
                <Button type="dashed" block icon={<PlusOutlined />} onClick={handleAddChannel}>
                  添加说话人
                </Button>
              </div>
            </Space>
          </div>
        </Sider>
        <Content style={{ padding: 24, background: '#f0f2f5', overflow: 'auto' }}>
          {currentAudio && (
            <div style={{ marginBottom: 24 }}>
              <AudioPlayer audioUrl={currentAudio.url} />
            </div>
          )}

          {state.project.channels.map(channel => (
            <ChannelPanel
              key={channel.id}
              channel={channel}
              duration={state.duration || 100}
            />
          ))}

          {state.project.channels.length === 0 && (
            <div style={{ textAlign: 'center', padding: 64, color: '#999' }}>
              <p>请先添加说话人通道，然后开始标记标签</p>
            </div>
          )}
        </Content>
      </Layout>
    </Layout>
  );
};

const App: React.FC = () => (
  <AppProvider>
    <AppContent />
  </AppProvider>
);

export default App;
