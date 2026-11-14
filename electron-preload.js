const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setupAgent: agent => ipcRenderer.invoke('ai-setup',agent),
});
