import { v4 as uuidv4 } from 'uuid';
import { TrackItem } from '../types';

export const formatTime = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

export const parseTime = (timeStr: string): number => {
  const [hms, ms] = timeStr.split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + (ms ? Number(ms) / 1000 : 0);
};

export const exportSRT = (items: TrackItem[]): string => {
  return items
    .sort((a, b) => a.startTime - b.startTime)
    .map((item, index) => `${index + 1}\n${formatTime(item.startTime)} --> ${formatTime(item.endTime)}\n${item.text}\n`)
    .join('\n');
};

export const importSRT = (srtContent: string): TrackItem[] => {
  const items: TrackItem[] = [];
  const blocks = srtContent.trim().split(/\n\s*\n/);
  
  blocks.forEach(block => {
    const lines = block.split('\n');
    if (lines.length >= 3) {
      const timeLine = lines[1];
      const [startStr, endStr] = timeLine.split(' --> ');
      const text = lines.slice(2).join('\n');
      items.push({
        id: uuidv4(),
        startTime: parseTime(startStr),
        endTime: parseTime(endStr),
        text,
      });
    }
  });
  
  return items;
};