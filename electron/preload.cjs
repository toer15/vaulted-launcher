const { contextBridge, ipcRenderer, webUtils } = require('electron')

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
  detectBuildVersion: (folder) => ipcRenderer.invoke('arc:detect-build-version', folder),
  // Discord-hosted seasons: find a client build the player downloaded in the
  // community Discord, then unpack it into the season's existing folder.
  findSeasonArchives: (payload) => ipcRenderer.invoke('arc:find-season-archives', payload),
  importSeasonArchive: (payload) => ipcRenderer.invoke('arc:import-season-archive', payload),
  openDiscordInvite: (url) => ipcRenderer.invoke('arc:open-discord-invite', url),
  downloadBuild: (payload) => ipcRenderer.invoke('arc:download-build', payload),
  syncProviderBuild: (payload) => ipcRenderer.invoke('arc:sync-provider-build', payload),
  // Start the season's other launcher after VAULTED installed its build, so
  // the project's own prepare/download begins automatically.
  startCompanionDownload: (providerId, folder) =>
    ipcRenderer.invoke('arc:start-companion-download', providerId, folder),
  deleteBuild: (payload) => ipcRenderer.invoke('arc:delete-build', payload),
  cleanupBuildStorage: () => ipcRenderer.invoke('arc:cleanup-build-storage'),
  verifyBuild: (payload) => ipcRenderer.invoke('arc:verify-build', payload),
  autoFix: {
    scan: (payload) => ipcRenderer.invoke('arc:autofix-scan', payload),
    repair: (payload) => ipcRenderer.invoke('arc:autofix-repair', payload),
    onProgress: (callback) => subscribe('arc:autofix-progress', callback),
  },
  cancelDownload: (payload) => ipcRenderer.invoke('arc:cancel-download', payload),
  pauseDownload: (payload) => ipcRenderer.invoke('arc:pause-download', payload),
  listInterruptedDownloads: () => ipcRenderer.invoke('arc:list-interrupted-downloads'),
  onDownloadProgress: (callback) => subscribe('arc:download-progress', callback),
  onBuildExited: (callback) => subscribe('arc:build-exited', callback),
  onProviderLauncherExited: (callback) => subscribe('arc:provider-launcher-exited', callback),
  onCompanionGameStarted: (callback) => subscribe('arc:companion-game-started', callback),
  onCommunityBuildLinked: (callback) => subscribe('arc:community-build-linked', callback),
  onCompanionGameTimeout: (callback) => subscribe('arc:companion-game-timeout', callback),
  onProviderSessionExpired: (callback) => subscribe('arc:provider-session-expired', callback),
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
  providerLauncherDetect: (providerId) =>
    ipcRenderer.invoke('arc:provider-launcher-detect', providerId),
  launcherAuthStatus: (providerId) =>
    ipcRenderer.invoke('arc:launcher-auth-status', providerId),
  scanLauncherAccounts: () => ipcRenderer.invoke('arc:scan-launcher-accounts'),
  launcherAccountRecord: (providerId, payload) =>
    ipcRenderer.invoke('arc:record-launcher-account', providerId, payload),
  discordGateVerify: (providerId) => ipcRenderer.invoke('arc:discord-gate-verify', providerId),
  providerLiveStatus: () => ipcRenderer.invoke('arc:provider-live-status'),
  providerPrepare: (providerId) => ipcRenderer.invoke('arc:provider-prepare', providerId),
  providerBuilds: (providerId) => ipcRenderer.invoke('arc:provider-builds', providerId),
  providerAuth: {
    status: () => ipcRenderer.invoke('arc:provider-auth-status'),
    login: (providerId, method) => ipcRenderer.invoke('arc:provider-auth-login', providerId, method),
    refresh: (providerId) => ipcRenderer.invoke('arc:provider-auth-refresh', providerId),
    verifyAccount: (providerId, options) =>
      ipcRenderer.invoke('arc:provider-auth-verify-account', providerId, options),
    logout: (providerId) => ipcRenderer.invoke('arc:provider-auth-logout', providerId),
    onProviderAuthChanged: (callback) => subscribe('arc:provider-auth-changed', callback),
  },
  probeServer: (payload) => ipcRenderer.invoke('arc:probe-server', payload),
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
  openProviderLauncher: (providerId, options) =>
    ipcRenderer.invoke('arc:open-provider-launcher', providerId, options),
  stopProviderLauncher: (providerId) =>
    ipcRenderer.invoke('arc:stop-provider-launcher', providerId),
  providerLauncherStatus: () => ipcRenderer.invoke('arc:provider-launcher-status'),
  providerRuntimeStatus: (providerId) =>
    ipcRenderer.invoke('arc:provider-runtime-status', providerId),
  installProviderRuntime: (providerId) =>
    ipcRenderer.invoke('arc:install-provider-runtime', providerId),
  onRuntimeProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('arc:runtime-progress', listener)
    return () => ipcRenderer.removeListener('arc:runtime-progress', listener)
  },
  /**
   * Discord communities distribute their launcher through the invite, so the
   * player brings VAULTED the file. It is scanned in main before install.
   */
  communityLauncher: {
    candidates: () => ipcRenderer.invoke('arc:community-launcher-candidates'),
    scan: (providerId, file) => ipcRenderer.invoke('arc:community-launcher-scan', providerId, file),
    import: (providerId, file) => ipcRenderer.invoke('arc:community-launcher-import', providerId, file),
    status: (providerId) => ipcRenderer.invoke('arc:community-launcher-status', providerId),
    forget: (providerId) => ipcRenderer.invoke('arc:community-launcher-forget', providerId),
    pick: () => ipcRenderer.invoke('arc:pick-community-launcher'),
    onProgress: (callback) => subscribe('arc:community-launcher-progress', callback),
  },
  /** Absolute path for a file dragged from Explorer onto VAULTED. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
    focus: () => ipcRenderer.invoke('win:focus'),
    close: () => ipcRenderer.invoke('win:close'),
  },
})
