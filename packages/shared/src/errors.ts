import { CdpMcpError } from './types.js';

export class CdpConnectionError extends CdpMcpError {
  constructor(message: string) {
    super(message, 'CDP_CONNECTION_ERROR');
    this.name = 'CdpConnectionError';
  }
}

export class CdpTimeoutError extends CdpMcpError {
  constructor(message: string, public timeoutMs?: number) {
    super(message, 'CDP_TIMEOUT_ERROR');
    this.name = 'CdpTimeoutError';
  }
}

export class CdpEvaluationError extends CdpMcpError {
  constructor(message: string, public exceptionDetails?: unknown) {
    super(message, 'CDP_EVALUATION_ERROR');
    this.name = 'CdpEvaluationError';
  }
}

export class ContextError extends CdpMcpError {
  constructor(message: string) {
    super(message, 'CONTEXT_ERROR');
    this.name = 'ContextError';
  }
}

export class TabNotFoundError extends CdpMcpError {
  constructor(message: string = 'No matching tab found') {
    super(message, 'TAB_NOT_FOUND');
    this.name = 'TabNotFoundError';
  }
}

export class ExtensionNotFoundError extends CdpMcpError {
  constructor(message: string = 'Extension not found') {
    super(message, 'EXTENSION_NOT_FOUND');
    this.name = 'ExtensionNotFoundError';
  }
}
