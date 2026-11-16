const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vaultedAuth', {
  close: () => ipcRenderer.send('arc:provider-auth-close'),
})
