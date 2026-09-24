const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateChecking: (callback) => on('update-checking', callback),
  onUpdateAvailable: (callback) => on('update-available', callback),
  onUpdateNotAvailable: (callback) => on('update-not-available', callback),
  onUpdateProgress: (callback) => on('update-progress', callback),
  onUpdateDownloaded: (callback) => on('update-downloaded', callback),
  onUpdateError: (callback) => on('update-error', callback),
  isElectron: true,
});
