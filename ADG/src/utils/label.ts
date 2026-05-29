import { v4 as uuidv4 } from 'uuid';
import { Label, Channel } from '../types';

export const createLabel = (channelId: string, startTime: number, endTime: number, text: string = ''): Label => ({
  id: uuidv4(),
  channelId,
  startTime,
  endTime,
  text,
});

export const updateLabel = (labels: Label[], labelId: string, updates: Partial<Label>): Label[] =>
  labels.map(label => label.id === labelId ? { ...label, ...updates } : label);

export const deleteLabel = (labels: Label[], labelId: string): Label[] =>
  labels.filter(label => label.id !== labelId);

export const exportLabels = (channels: Channel[]): string => {
  const data = channels.map(channel => ({
    channelId: channel.id,
    channelName: channel.name,
    labels: channel.labels,
  }));
  return JSON.stringify(data, null, 2);
};

export const importLabels = (jsonString: string): Channel[] => {
  const data = JSON.parse(jsonString);
  return data.map((item: any) => ({
    id: item.channelId || uuidv4(),
    name: item.channelName,
    color: getRandomColor(),
    labels: item.labels || [],
    subtitles: [],
  }));
};

export const getRandomColor = (): string => {
  const colors = [
    '#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1',
    '#13c2c2', '#eb2f96', '#fa8c16', '#a0d911', '#2f54eb'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
};

export const exportRTTM = (channels: Channel[], fileName: string = 'audio'): string => {
  const lines: string[] = [];

  channels.forEach((channel, channelIndex) => {
    channel.labels.forEach(label => {
      // 查找对应的字幕
      let subtitleText = '<NA>';
      const matchingSubtitle = channel.subtitles.find(
        sub => Math.abs(sub.startTime - label.startTime) < 0.1 && Math.abs(sub.endTime - label.endTime) < 0.1
      );
      if (matchingSubtitle && matchingSubtitle.text.trim()) {
        subtitleText = matchingSubtitle.text;
      }

      // 构造 RTTM 行
      const duration = (label.endTime - label.startTime).toFixed(6);
      const startTime = label.startTime.toFixed(6);
      const speakerName = channel.name.replace(/\s+/g, '_');
      
      // RTTM 格式: SPEAKER <file-id> <channel> <start-time> <duration> <NA> <NA> <speaker> <NA> <NA> [subtitle]
      const line = `SPEAKER ${fileName} ${channelIndex + 1} ${startTime} ${duration} <NA> <NA> ${speakerName} <NA> <NA> ${subtitleText}`;
      lines.push(line);
    });
  });

  return lines.join('\n');
};
