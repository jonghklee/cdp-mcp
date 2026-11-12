export { TabManager } from './tab-manager.js';
export { ExtensionManager } from './extension-manager.js';
export type { ExtensionInfo } from './extension-manager.js';
export {
  acquireSharedChrome, releaseSharedChrome, restartSharedChrome, syncCookies, copyProfile, isChromeUp, SHARED_PORT,
} from './shared-chrome.js';
