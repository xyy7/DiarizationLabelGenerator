/**
 * File workbench: upload, see what state everything is in, claim something,
 * import pre-labels.
 *
 * A test set is dozens to hundreds of files worked on by more than one person,
 * so "which files exist and who has which" is the first question the tool has
 * to answer. The previous version had no answer: one project, one implicit
 * file, everything in the annotator's own browser storage.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Empty, Input, Modal, Popconfirm, Space, Table, Tag, Upload, message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { api, ApiError, getUserName, setUserName } from '../api/client';
import type { Recording, RecordingStatus } from '../types';

const STATUS_LABEL: Record<RecordingStatus, { text: string; color: string }> = {
  uploaded: { text: '待预标注', color: 'default' },
  queued: { text: '排队中', color: 'blue' },
  running: { text: '识别中', color: 'processing' },
  ready: { text: '待标注', color: 'gold' },
  annotating: { text: '标注中', color: 'orange' },
  done: { text: '已完成', color: 'green' },
  failed: { text: '失败', color: 'red' },
};

export default function Workbench() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(getUserName());
  const [asking, setAsking] = useState(!getUserName());
  const importFor = useRef<Recording | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const { items } = await api.listRecordings();
      setRows(items);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : '加载列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Diarization runs at about 1x realtime, so anything queued will be a while.
  // A slow poll is plenty and keeps the queue position honest.
  useEffect(() => {
    if (!rows.some((r) => r.status === 'queued' || r.status === 'running')) return;
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [rows, refresh]);

  const openImport = (rec: Recording) => {
    importFor.current = rec;
    fileInput.current?.click();
  };

  const doImport = async (file: File, allowMismatch = false) => {
    const rec = importFor.current;
    if (!rec) return;
    try {
      const res = await api.importRttm(rec.id, file, rec.annotation_version, allowMismatch);
      message.success(`已导入预标注（v${res.version}）`);
      for (const a of res.adjustments) {
        message.warning(
          a.after
            ? `片段 ${a.index} 超出音频，已收到 ${a.after[1].toFixed(3)}s`
            : `片段 ${a.index} 完全在音频之外，已丢弃`,
          6,
        );
      }
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'uri_mismatch') {
        Modal.confirm({
          title: '文件名对不上',
          content: `这个 RTTM 标的是「${e.detail.file_uri}」，而这条录音是「${e.detail.session_name}」。多半是选错了文件——导错会污染测试集。确定要继续吗？`,
          okText: '确定，我知道自己在做什么',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => doImport(file, true),
        });
      } else {
        message.error(e instanceof ApiError ? e.message : '导入失败');
      }
    }
  };

  const columns: ColumnsType<Recording> = [
    {
      title: '名称',
      dataIndex: 'session_name',
      render: (v: string, r) => (
        <a onClick={() => navigate(`/rec/${r.id}`)}>{v}</a>
      ),
    },
    {
      title: '时长',
      dataIndex: 'duration_sec',
      width: 90,
      render: (v: number) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (s: RecordingStatus, r) => (
        <Space direction="vertical" size={0}>
          <Tag color={STATUS_LABEL[s].color}>{STATUS_LABEL[s].text}</Tag>
          {r.error && <span style={{ fontSize: 11, color: '#cf1322' }}>{r.error.slice(0, 60)}</span>}
        </Space>
      ),
    },
    {
      title: '认领人',
      dataIndex: 'claimed_by',
      width: 100,
      render: (u: Recording['claimed_by']) => u?.name ?? '—',
    },
    { title: '版本', dataIndex: 'annotation_version', width: 70 },
    {
      title: '操作',
      width: 300,
      render: (_, r) => (
        <Space size={4} wrap>
          {/* Only an not-yet-diarized file can be queued for pre-labelling;
              the queued/running rows poll themselves and need no button. */}
          {r.status === 'uploaded' && (
            <Button
              size="small"
              onClick={async () => {
                try {
                  await api.diarize(r.id);
                  message.success(`已入队，正在预标注 ${r.session_name}`);
                  refresh();
                } catch (e) {
                  if (e instanceof ApiError && e.code === 'job_active') {
                    message.info('这条录音已经在排队了');
                  } else {
                    message.error(e instanceof ApiError ? e.message : '预标注入队失败');
                  }
                }
              }}
            >
              预标注
            </Button>
          )}
          <Button size="small" onClick={() => openImport(r)}>导入 RTTM</Button>
          {/* Pre-labelling is optional since 2026-09-04: any status can be
              claimed. The server cancels an in-flight job on claim, so a
              human never races an ongoing diarization. */}
          <Button
            size="small"
            onClick={async () => {
              try {
                await api.claim(r.id);
                navigate(`/rec/${r.id}`);
              } catch (e) {
                if (e instanceof ApiError && e.code === 'already_claimed') {
                  Modal.confirm({
                    title: '已被认领',
                    content: `${e.message}。强行接管会让对方的未保存修改丢失。`,
                    okText: '强行接管',
                    okButtonProps: { danger: true },
                    onOk: async () => {
                      await api.claim(r.id, true);
                      navigate(`/rec/${r.id}`);
                    },
                  });
                } else {
                  message.error(e instanceof ApiError ? e.message : '认领失败');
                }
              }
            }}
          >
            认领并标注
          </Button>
          <a href={api.rttmUrl(r.id)} target="_blank" rel="noreferrer">RTTM</a>
          <Popconfirm
            title="连同音频和标注一起删除？"
            onConfirm={async () => { await api.deleteRecording(r.id); refresh(); }}
          >
            <Button size="small" danger type="text">删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Space style={{ marginBottom: 16 }} wrap>
        <h2 style={{ margin: 0 }}>说话人分离标注</h2>
        <Upload
          multiple
          showUploadList={false}
          beforeUpload={async (file) => {
            const hide = message.loading(`上传 ${file.name}…`, 0);
            try {
              await api.upload(file as File);
              message.success(`${file.name} 已上传`);
            } catch (e) {
              if (e instanceof ApiError && e.code === 'duplicate') {
                message.warning(`${file.name} 已经在库里了`);
              } else {
                message.error(e instanceof ApiError ? e.message : '上传失败');
              }
            } finally {
              hide();
              refresh();
            }
            return false;
          }}
        >
          <Button type="primary">上传音频</Button>
        </Upload>
        <a href={api.exportAllUrl('done')}>导出全部已完成（zip）</a>
        <span style={{ color: '#888' }}>
          标注员：<a onClick={() => setAsking(true)}>{name || '未设置'}</a>
        </span>
        <Button size="small" onClick={refresh}>刷新</Button>
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        columns={columns}
        size="small"
        pagination={{ pageSize: 25 }}
        locale={{ emptyText: <Empty description="还没有音频，先上传一个" /> }}
      />

      <input
        ref={fileInput}
        type="file"
        accept=".rttm,text/plain"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) doImport(f);
        }}
      />

      <Modal
        open={asking}
        title="你是谁？"
        closable={false}
        maskClosable={false}
        onOk={() => { setUserName(name.trim()); setAsking(false); }}
        okButtonProps={{ disabled: !name.trim() }}
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <p style={{ color: '#888' }}>
          只是用来记录谁认领了哪个文件、谁最后改的，没有密码。
        </p>
        <Input
          value={name}
          autoFocus
          placeholder="你的名字"
          onChange={(e) => setName(e.target.value)}
          onPressEnter={() => name.trim() && (setUserName(name.trim()), setAsking(false))}
        />
      </Modal>
    </div>
  );
}
