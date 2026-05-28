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
