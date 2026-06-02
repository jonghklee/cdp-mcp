export { PortManager } from './port-manager.js';
export { ChromeManager } from './chrome-pool.js';
export type { ChromeLaunchOptions } from './chrome-pool.js';
export { TabManager } from './tab-manager.js';
export { ExtensionManager } from './extension-manager.js';
export type { ExtensionInfo } from './extension-manager.js';
export { SessionInfoTabManager, isSessionInfoTab } from './session-info-tab.js';
export type { SessionInfoData } from './session-info-tab.js';
export {
  acquireLock,
  releaseLock,
  isPortLocked,
  isMyLock,
  readLock,
  getAllLocks,
  assignPort,
  releasePort,
  cleanupStaleAssignments,
  EXCLUDED_PORTS,
} from './port-store.js';
export type { LockInfo, PortAssignment } from './port-store.js';
export { CdpCard, CdpCardTimeoutError } from './cdp-card.js';
export { saveSession, loadSession, clearSession } from './session-store.js';
