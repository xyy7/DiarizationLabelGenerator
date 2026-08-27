import { v4 as uuidv4 } from 'uuid';
import { Channel } from '../types';

export const getRandomColor = (): string => {
  const colors = [
    '#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1',
    '#13c2c2', '#eb2f96', '#fa8c16', '#a0d911', '#2f54eb'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
};

export const exportLabels = (channels: Channel[]): string => {
  const data = channels.map(channel => ({
    channelId: channel.id,
    channelName: channel.name,
    items: channel.items,
  }));
  return JSON.stringify(data, null, 2);
};

export const importLabels = (jsonString: string): Channel[] => {
  const data = JSON.parse(jsonString);
  return data.map((item: any) => ({
    id: item.channelId || uuidv4(),
    name: item.channelName,
    color: getRandomColor(),
    items: item.items || item.labels || [],
  }));
};

export const exportRTTM = (channels: Channel[], fileName: string = 'audio'): string => {
  const lines: string[] = [];

  channels.forEach((channel, channelIndex) => {
    channel.items.forEach(item => {
      const duration = (item.endTime - item.startTime).toFixed(6);
      const startTime = item.startTime.toFixed(6);
      const speakerName = channel.name.replace(/\s+/g, '_');
      
      const line = `SPEAKER ${fileName} ${channelIndex + 1} ${startTime} ${duration} <NA> <NA> ${speakerName} <NA> <NA> ${item.text || '<NA>'}`;
      lines.push(line);
    });
  });

  return lines.join('\n');
};