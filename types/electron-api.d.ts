declare global {
  type ElectronUpdatePayload = {
    source?: string;
    version?: string;
    percent?: number;
    message?: string;
  };

  type ElectronUpdateUnsubscribe = () => void;

  interface ElectronAPI {
    isElectron: boolean;
    getAppVersion: () => Promise<string>;
    checkForUpdates: () => Promise<{
      status?: 'ok' | 'dev' | 'unavailable' | 'error';
      version?: string;
      updateInfo?: ElectronUpdatePayload | null;
      error?: string;
    } | null>;
    onUpdateChecking?: (callback: (payload: ElectronUpdatePayload) => void) => ElectronUpdateUnsubscribe;
    onUpdateAvailable?: (callback: (payload: ElectronUpdatePayload) => void) => ElectronUpdateUnsubscribe;
    onUpdateNotAvailable?: (callback: (payload: ElectronUpdatePayload) => void) => ElectronUpdateUnsubscribe;
    onUpdateProgress?: (callback: (payload: ElectronUpdatePayload | number) => void) => ElectronUpdateUnsubscribe;
    onUpdateDownloaded?: (callback: (payload: ElectronUpdatePayload) => void) => ElectronUpdateUnsubscribe;
    onUpdateError?: (callback: (payload: ElectronUpdatePayload) => void) => ElectronUpdateUnsubscribe;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
