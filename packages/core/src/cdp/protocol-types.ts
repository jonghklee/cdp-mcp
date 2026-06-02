// CDP Protocol types — only what Phase 1 uses

// Runtime
export interface RuntimeEvaluateParams {
  expression: string;
  objectGroup?: string;
  includeCommandLineAPI?: boolean;
  silent?: boolean;
  contextId?: number;
  returnByValue?: boolean;
  awaitPromise?: boolean;
  userGesture?: boolean;
}

export interface RuntimeEvaluateResult {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

export interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

export interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface StackTrace {
  description?: string;
  callFrames: CallFrame[];
  parent?: StackTrace;
}

export interface ExceptionDetails {
  exceptionId: number;
  text: string;
  lineNumber: number;
  columnNumber: number;
  exception?: RemoteObject;
  stackTrace?: StackTrace;
}

export interface RuntimeConsoleAPICalledParams {
  type: 'log' | 'debug' | 'info' | 'error' | 'warning' | 'dir' | 'dirxml' |
        'table' | 'trace' | 'clear' | 'startGroup' | 'startGroupCollapsed' |
        'endGroup' | 'assert' | 'profile' | 'profileEnd' | 'count' | 'timeEnd';
  args: RemoteObject[];
  executionContextId: number;
  timestamp: number;
  stackTrace?: StackTrace;
}

export interface RuntimeExceptionThrownParams {
  timestamp: number;
  exceptionDetails: ExceptionDetails;
}

// Page
export interface PageNavigateParams {
  url: string;
  referrer?: string;
  transitionType?: string;
  frameId?: string;
}

export interface PageNavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

export interface PageLifecycleEventParams {
  frameId: string;
  loaderId: string;
  name: string;
  timestamp: number;
}

export interface FrameTree {
  frame: FrameInfo;
  childFrames?: FrameTree[];
}

export interface FrameInfo {
  id: string;
  parentId?: string;
  loaderId: string;
  name?: string;
  url: string;
  securityOrigin: string;
  mimeType: string;
}

// Input
export interface InputDispatchMouseEventParams {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
  x: number;
  y: number;
  button?: 'none' | 'left' | 'middle' | 'right';
  buttons?: number;
  clickCount?: number;
  modifiers?: number;
}

export interface InputDispatchKeyEventParams {
  type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
  modifiers?: number;
  text?: string;
  unmodifiedText?: string;
  key?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
}

// Target (HTTP /json endpoint response — per-target WS URL 포함)
export interface TargetInfoHttp {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
  description?: string;
  faviconUrl?: string;
}

// Target (CDP Target.getTargets response)
export interface TargetInfoCdp {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId?: string;
  openerId?: string;
}

export interface TargetCreatedEvent {
  targetInfo: TargetInfoCdp;
}

export interface TargetDestroyedEvent {
  targetId: string;
}

export interface TargetInfoChangedEvent {
  targetInfo: TargetInfoCdp;
}

export interface AttachToTargetResult {
  sessionId: string;
}

// Page.captureScreenshot
export interface CaptureScreenshotParams {
  format?: 'jpeg' | 'png' | 'webp';
  quality?: number;
  clip?: Viewport;
  fromSurface?: boolean;
}

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}

export interface CaptureScreenshotResult {
  data: string; // base64
}

// Emulation
export interface SetDeviceMetricsOverrideParams {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

// Page.getFrameTree
export interface GetFrameTreeResult {
  frameTree: FrameTree;
}

// Network
export interface NetworkRequestWillBeSentParams {
  requestId: string;
  loaderId: string;
  documentURL: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    hasPostData?: boolean;
  };
  timestamp: number;
  wallTime: number;
  type?: string;
  frameId?: string;
}

export interface NetworkResponseReceivedParams {
  requestId: string;
  loaderId: string;
  timestamp: number;
  type: string;
  response: {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
  };
  frameId?: string;
}

export interface NetworkLoadingFinishedParams {
  requestId: string;
  timestamp: number;
  encodedDataLength: number;
}

export interface NetworkLoadingFailedParams {
  requestId: string;
  timestamp: number;
  type: string;
  errorText: string;
  canceled?: boolean;
}

export interface NetworkGetResponseBodyResult {
  body: string;
  base64Encoded: boolean;
}

// Fetch (network interception)
export interface FetchRequestPausedParams {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  frameId?: string;
  resourceType: string;
  responseStatusCode?: number;
}

export interface FetchHeaderEntry {
  name: string;
  value: string;
}

// DOM
export interface DOMResolveNodeResult {
  object: RemoteObject;
}

export interface DOMGetBoxModelResult {
  model: {
    content: number[];
    padding: number[];
    border: number[];
    margin: number[];
    width: number;
    height: number;
  };
}

// Page.createIsolatedWorld
export interface CreateIsolatedWorldParams {
  frameId: string;
  worldName?: string;
  grantUniveralAccess?: boolean;
}

export interface CreateIsolatedWorldResult {
  executionContextId: number;
}

// Layout Metrics
export interface GetLayoutMetricsResult {
  layoutViewport: {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
  };
  visualViewport: {
    offsetX: number;
    offsetY: number;
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
    scale: number;
    zoom: number;
  };
  contentSize: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
