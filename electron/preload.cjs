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
  pauseDownload: (payload) => ipcRenderer.invoke('arc:pause-download', payload),
  listInterruptedDownloads: () => ipcRenderer.invoke('arc:list-interrupted-downloads'),
  onDownloadProgress: (callback) => subscribe('arc:download-progress', callback),
  onBuildExited: (callback) => subscribe('arc:build-exited', callback),
  onJoinFailed: (callback) => subscribe('arc:join-failed', callback),
  onLaunchStatus: (callback) => subscribe('arc:launch-status', callback),
  pickFolder: () => ipcRenderer.invoke('arc:pick-folder'),
  pickInstallDir: () => ipcRenderer.invoke('arc:pick-install-dir'),
  pickExecutable: () => ipcRenderer.invoke('arc:pick-executable'),
  pickBuildsRoot: () => ipcRenderer.invoke('arc:pick-builds-root'),
  linkBuildFolder: () => ipcRenderer.invoke('arc:link-build-folder'),
  buildSize: (folder) => ipcRenderer.invoke('arc:build-size', folder),
  openBuildFolder: (folder) => ipcRenderer.invoke('arc:open-build-folder', folder),
  getBuildsRoot: () => ipcRenderer.invoke('arc:builds-root'),
  settings: {
    read: () => ipcRenderer.invoke('arc:settings-read'),
    save: (settings) => ipcRenderer.invoke('arc:settings-save', settings),
  },
  profiles: {
    read: () => ipcRenderer.invoke('arc:profiles-read'),
    save: (profiles) => ipcRenderer.invoke('arc:profiles-save', profiles),
  },
  fetchText: (url, options) => ipcRenderer.invoke('arc:fetch-text', url, options),
  fetchCommunityServers: (query) => ipcRenderer.invoke('arc:community-servers', query),
  providerCatalog: () => ipcRenderer.invoke('arc:provider-catalog'),
  providerAuth: {
    status: () => ipcRenderer.invoke('arc:provider-auth-status'),
    login: (providerId) => ipcRenderer.invoke('arc:provider-auth-login', providerId),
    logout: (providerId) => ipcRenderer.invoke('arc:provider-auth-logout', providerId),
  },
  probeServer: (payload) => ipcRenderer.invoke('arc:probe-server', payload),
  openExternal: (url) => ipcRenderer.invoke('arc:open-external', url),
  lanIp: () => ipcRenderer.invoke('arc:lan-ip'),
  publicAddress: () => ipcRenderer.invoke('arc:public-address'),
  sessionStatus: () => ipcRenderer.invoke('arc:session-status'),
  getPublicAddress: () => ipcRenderer.invoke('arc:get-public-address'),
  setPublicAddress: (value) => ipcRenderer.invoke('arc:set-public-address', value),
  scanBuilds: (roots) => ipcRenderer.invoke('arc:scan-builds', roots),
  checkUpdates: () => ipcRenderer.invoke('arc:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('arc:download-update'),
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
  launchOnlineProvider: (payload) => ipcRenderer.invoke('arc:online-provider-launch', payload),
  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
    close: () => ipcRenderer.invoke('win:close'),
  },
})
