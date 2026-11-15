const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('arc', {
  platform: process.platform,
  launchBuild: (payload) => ipcRenderer.invoke('arc:launch-build', payload),
  closeBuild: (payload) => ipcRenderer.invoke('arc:close-build', payload),
  checkBuilds: (builds) => ipcRenderer.invoke('arc:check-builds', builds),
  downloadBuild: (payload) => ipcRenderer.invoke('arc:download-build', payload),
  deleteBuild: (payload) => ipcRenderer.invoke('arc:delete-build', payload),
  verifyBuild: (payload) => ipcRenderer.invoke('arc:verify-build', payload),
  cancelDownload: (payload) => ipcRenderer.invoke('arc:cancel-download', payload),
  onDownloadProgress: (callback) => subscribe('arc:download-progress', callback),
  onBuildExited: (callback) => subscribe('arc:build-exited', callback),
  onLaunchStatus: (callback) => subscribe('arc:launch-status', callback),
  pickFolder: () => ipcRenderer.invoke('arc:pick-folder'),
  lanIp: () => ipcRenderer.invoke('arc:lan-ip'),
  publicAddress: () => ipcRenderer.invoke('arc:public-address'),
  getPublicAddress: () => ipcRenderer.invoke('arc:get-public-address'),
  setPublicAddress: (value) => ipcRenderer.invoke('arc:set-public-address', value),
  scanBuilds: () => ipcRenderer.invoke('arc:scan-builds'),
  checkUpdates: () => ipcRenderer.invoke('arc:check-updates'),
  installUpdate: () => ipcRenderer.invoke('arc:install-update'),
  onUpdateAvailable: (callback) => subscribe('arc:update-available', callback),
  onUpdateDownloaded: (callback) => subscribe('arc:update-downloaded', callback),
  syncInventory: (payload) => ipcRenderer.invoke('arc:sync-inventory', payload),
  accountSession: {
    read: () => ipcRenderer.invoke('arc:account-session-read'),
    save: (value) => ipcRenderer.invoke('arc:account-session-save', value),
    clear: () => ipcRenderer.invoke('arc:account-session-clear'),
  },
  session: {
    readSync: () => ipcRenderer.sendSync('arc:read-session-sync'),
    save: (value) => ipcRenderer.invoke('arc:save-session', value),
    clear: () => ipcRenderer.invoke('arc:clear-session'),
  },
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
    close: () => ipcRenderer.invoke('win:close'),
  },
})
