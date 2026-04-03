const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  checkCC: () => ipcRenderer.invoke('cc-check'),
  setupCC: () => ipcRenderer.invoke('cc-setup'),
});
