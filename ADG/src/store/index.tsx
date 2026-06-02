import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { AppState, Project, Channel, AudioFile, TrackItem } from '../types';
import { getRandomColor } from '../utils';

const createTrackItem = (startTime: number, endTime: number, text: string = ''): TrackItem => ({
  id: uuidv4(),
  startTime,
  endTime,
  text,
});

type Action =
  | { type: 'CREATE_PROJECT'; name: string }
  | { type: 'ADD_AUDIO_FILES'; files: AudioFile[] }
  | { type: 'SET_CURRENT_AUDIO'; audioId: string | null }
  | { type: 'ADD_CHANNEL'; name: string }
  | { type: 'UPDATE_CHANNEL'; channelId: string; updates: Partial<Channel> }
  | { type: 'DELETE_CHANNEL'; channelId: string }
  | { type: 'ADD_ITEM'; channelId: string; startTime: number; endTime: number; text?: string }
  | { type: 'UPDATE_ITEM'; channelId: string; itemId: string; updates: Partial<TrackItem> }
  | { type: 'DELETE_ITEM'; channelId: string; itemId: string }
  | { type: 'SET_PLAYING'; isPlaying: boolean }
  | { type: 'SET_CURRENT_TIME'; time: number }
  | { type: 'SET_DURATION'; duration: number }
  | { type: 'SET_PLAYBACK_RATE'; rate: number }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'LOAD_PROJECT'; project: Project }
  | { type: 'CREATE_CLIP_PROJECT'; project: Project };

const initialState: AppState = {
  project: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  volume: 1,
};

const appReducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case 'CREATE_PROJECT':
      return {
        ...state,
        project: {
          id: uuidv4(),
          name: action.name,
          audioFiles: [],
          currentAudioId: null,
          channels: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };

    case 'ADD_AUDIO_FILES':
      if (!state.project) return state;
      return {
        ...state,
        project: {
          ...state.project,
          audioFiles: [...state.project.audioFiles, ...action.files],
          updatedAt: Date.now(),
        },
      };

    case 'SET_CURRENT_AUDIO':
      if (!state.project) return state;
      return {
        ...state,
        project: {
          ...state.project,
          currentAudioId: action.audioId,
          updatedAt: Date.now(),
        },
      };

    case 'ADD_CHANNEL':
      if (!state.project) return state;
      const newChannel: Channel = {
        id: uuidv4(),
        name: action.name,
        color: getRandomColor(),
        items: [],
      };
      return {
        ...state,
        project: {
          ...state.project,
          channels: [...state.project.channels, newChannel],
          updatedAt: Date.now(),
        },
      };

    case 'UPDATE_CHANNEL':
      if (!state.project) return state;
      return {
        ...state,
        project: {
          ...state.project,
          channels: state.project.channels.map(ch =>
            ch.id === action.channelId ? { ...ch, ...action.updates } : ch
          ),
          updatedAt: Date.now(),
        },
      };

    case 'DELETE_CHANNEL':
      if (!state.project) return state;
      return {
        ...state,
        project: {
          ...state.project,
          channels: state.project.channels.filter(ch => ch.id !== action.channelId),
          updatedAt: Date.now(),
        },
      };

    case 'ADD_ITEM':
      if (!state.project) return state;
      return {
        ...state,
        project: {
          ...state.project,
          channels: state.project.channels.map(ch =>
            ch.id === action.channelId
              ? { ...ch, items: [...ch.items, createTrackItem(action.startTime, action.endTime, action.text)] }
              : ch
          ),
          updatedAt: Date.now(),
        },
      };

    case 'UPDATE_ITEM':
      if (!state.project) return state;
      return {
        ...state,
        project: {
          ...state.project,
          channels: state.project.channels.map(ch =>
            ch.id === action.channelId
              ? {
                  ...ch,
                  items: ch.items.map(item =>
                    item.id === action.itemId ? { ...item, ...action.updates } : item
                  ),
                }
              : ch
          ),
          updatedAt: Date.now(),
        },
      };

    case 'DELETE_ITEM':
      if (!state.project) return state;
      return {
        ...state,
        project: {
          ...state.project,
          channels: state.project.channels.map(ch =>
            ch.id === action.channelId
              ? { ...ch, items: ch.items.filter(item => item.id !== action.itemId) }
              : ch
          ),
          updatedAt: Date.now(),
        },
      };

    case 'SET_PLAYING':
      return { ...state, isPlaying: action.isPlaying };

    case 'SET_CURRENT_TIME':
      return { ...state, currentTime: action.time };

    case 'SET_DURATION':
      return { ...state, duration: action.duration };

    case 'SET_PLAYBACK_RATE':
      return { ...state, playbackRate: action.rate };

    case 'SET_VOLUME':
      return { ...state, volume: action.volume };

    case 'LOAD_PROJECT':
      return { ...state, project: action.project };

    case 'CREATE_CLIP_PROJECT':
      return { ...state, project: action.project };

    default:
      return state;
  }
};

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<Action>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(appReducer, initialState);
  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useAppContext must be used within AppProvider');
  return context;
};
