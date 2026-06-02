// @cdp-mcp/core - barrel export

// CDP
export { CdpClient } from './cdp/cdp-client.js';
export type { CdpClientOptions } from './cdp/cdp-client.js';
export { ConnectionPool } from './cdp/connection-pool.js';
export * from './cdp/protocol-types.js';

// Context
export { ContextRouter } from './context/context-router.js';
export type { EvaluationResult, EvaluateOptions as RouterEvaluateOptions } from './context/context-router.js';
export { adviseContext } from './context/context-advisor.js';
export type { ContextAdvice } from './context/context-advisor.js';
export { CONTEXT_CAPABILITIES, CONTEXT_REQUIRED_MESSAGE } from './context/context-types.js';
export type { ContextCapability } from './context/context-types.js';

// Act
export { navigate } from './act/navigate.js';
export type { NavigateOptions, NavigateResult } from './act/navigate.js';
export { click } from './act/click.js';
export type { ClickOptions, ClickResult } from './act/click.js';
export { evaluate } from './act/evaluate.js';
export type { EvaluateOptions, EvaluateResult } from './act/evaluate.js';
export { typeText } from './act/type.js';
export type { TypeOptions, TypeResult } from './act/type.js';
export { uploadFile } from './act/upload-file.js';
export type { UploadFileOptions, UploadFileResult, UploadMethod } from './act/upload-file.js';

// Observe
export { screenshot } from './observe/screenshot.js';
export type { ScreenshotOptions, ScreenshotResult } from './observe/screenshot.js';
export { getPageInfo } from './observe/page-info.js';
export type { PageInfo } from './observe/page-info.js';
export type { FrameInfo as PageFrameInfo } from './observe/page-info.js';
export { startCapture, stopCapture, getMessages, clearAllCaptures } from './observe/console-capture.js';
export type {
  ConsoleLevel, ConsoleEntry, CaptureOptions, CaptureStatus,
  StartCaptureResult, StopCaptureResult, GetMessagesResult,
} from './observe/console-capture.js';
export {
  startNetworkCapture, stopNetworkCapture, getNetworkRequests,
  waitForNetworkRequest, clearAllNetworkCaptures,
} from './observe/network-capture.js';
export type {
  CapturedRequest, NetworkCaptureOptions, NetworkCaptureStatus,
  StartNetworkCaptureResult, StopNetworkCaptureResult,
  GetNetworkRequestsOptions, GetNetworkRequestsResult,
  WaitForNetworkRequestResult,
} from './observe/network-capture.js';
export {
  startIntercept, stopIntercept, addRule, removeRule, listRules, clearAllIntercepts,
} from './observe/network-intercept.js';
export type {
  InterceptRule, StartInterceptResult, StopInterceptResult,
  AddRuleResult, ListRulesResult,
} from './observe/network-intercept.js';

// Infra
export { ChromeManager } from './infra/chrome-pool.js';
export type { ChromeLaunchOptions } from './infra/chrome-pool.js';
export { TabManager } from './infra/tab-manager.js';
export { ExtensionManager } from './infra/extension-manager.js';
export type { ExtensionInfo } from './infra/extension-manager.js';
export { PortManager } from './infra/port-manager.js';

// Tools (MCP registration)
export { registerActTools } from './tools/act-tools.js';
export { registerObserveTools } from './tools/observe-tools.js';
export { registerInfraTools } from './tools/infra-tools.js';
export { registerQaqcTools } from './tools/qaqc-tools.js';
export { registerNetworkTools } from './tools/network-tools.js';

// Server
export { createServer, LazyConnectionManager } from './server.js';
