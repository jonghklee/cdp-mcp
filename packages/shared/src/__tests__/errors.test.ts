import { describe, it, expect } from 'vitest';
import { CdpMcpError } from '../types.js';
import {
  CdpConnectionError,
  CdpTimeoutError,
  CdpEvaluationError,
  ContextError,
  TabNotFoundError,
  ExtensionNotFoundError,
} from '../errors.js';

describe('CdpMcpError', () => {
  it('has correct name and message', () => {
    const err = new CdpMcpError('test message', 'TEST_CODE');
    expect(err.name).toBe('CdpMcpError');
    expect(err.message).toBe('test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('CdpConnectionError', () => {
  it('is instanceof CdpMcpError', () => {
    const err = new CdpConnectionError('connection failed');
    expect(err).toBeInstanceOf(CdpMcpError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct name and code', () => {
    const err = new CdpConnectionError('connection failed');
    expect(err.name).toBe('CdpConnectionError');
    expect(err.code).toBe('CDP_CONNECTION_ERROR');
    expect(err.message).toBe('connection failed');
  });
});

describe('CdpTimeoutError', () => {
  it('is instanceof CdpMcpError', () => {
    const err = new CdpTimeoutError('timed out', 5000);
    expect(err).toBeInstanceOf(CdpMcpError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct name and code', () => {
    const err = new CdpTimeoutError('timed out');
    expect(err.name).toBe('CdpTimeoutError');
    expect(err.code).toBe('CDP_TIMEOUT_ERROR');
  });

  it('stores timeoutMs', () => {
    const err = new CdpTimeoutError('timed out', 5000);
    expect(err.timeoutMs).toBe(5000);
  });

  it('timeoutMs is undefined when not provided', () => {
    const err = new CdpTimeoutError('timed out');
    expect(err.timeoutMs).toBeUndefined();
  });
});

describe('CdpEvaluationError', () => {
  it('is instanceof CdpMcpError', () => {
    const err = new CdpEvaluationError('eval failed');
    expect(err).toBeInstanceOf(CdpMcpError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct name and code', () => {
    const err = new CdpEvaluationError('eval failed');
    expect(err.name).toBe('CdpEvaluationError');
    expect(err.code).toBe('CDP_EVALUATION_ERROR');
  });

  it('stores exceptionDetails', () => {
    const details = { text: 'ReferenceError', lineNumber: 42 };
    const err = new CdpEvaluationError('eval failed', details);
    expect(err.exceptionDetails).toEqual(details);
  });

  it('exceptionDetails is undefined when not provided', () => {
    const err = new CdpEvaluationError('eval failed');
    expect(err.exceptionDetails).toBeUndefined();
  });
});

describe('ContextError', () => {
  it('is instanceof CdpMcpError', () => {
    const err = new ContextError('wrong context');
    expect(err).toBeInstanceOf(CdpMcpError);
  });

  it('has correct name and code', () => {
    const err = new ContextError('wrong context');
    expect(err.name).toBe('ContextError');
    expect(err.code).toBe('CONTEXT_ERROR');
  });
});

describe('TabNotFoundError', () => {
  it('is instanceof CdpMcpError', () => {
    const err = new TabNotFoundError();
    expect(err).toBeInstanceOf(CdpMcpError);
  });

  it('has correct name, code, and default message', () => {
    const err = new TabNotFoundError();
    expect(err.name).toBe('TabNotFoundError');
    expect(err.code).toBe('TAB_NOT_FOUND');
    expect(err.message).toBe('No matching tab found');
  });

  it('accepts custom message', () => {
    const err = new TabNotFoundError('tab with id 123 not found');
    expect(err.message).toBe('tab with id 123 not found');
  });
});

describe('ExtensionNotFoundError', () => {
  it('is instanceof CdpMcpError', () => {
    const err = new ExtensionNotFoundError();
    expect(err).toBeInstanceOf(CdpMcpError);
  });

  it('has correct name, code, and default message', () => {
    const err = new ExtensionNotFoundError();
    expect(err.name).toBe('ExtensionNotFoundError');
    expect(err.code).toBe('EXTENSION_NOT_FOUND');
    expect(err.message).toBe('Extension not found');
  });

  it('accepts custom message', () => {
    const err = new ExtensionNotFoundError('ChatLens not found');
    expect(err.message).toBe('ChatLens not found');
  });
});
