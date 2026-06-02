export interface TrackItem {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
}

export interface Channel {
  id: string;
  name: string;
  color: string;
  items: TrackItem[];
}

export interface Project {
  id: string;
  name: string;
  audioFiles: AudioFile[];
  currentAudioId: string | null;
  channels: Channel[];
  createdAt: number;
  updatedAt: number;
}

export interface AudioFile {
  id: string;
  name: string;
  url: string;
  file?: File;
  duration?: number;
}

export interface AppState {
  project: Project | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  volume: number;
}
