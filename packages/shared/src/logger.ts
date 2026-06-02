type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getCurrentLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel as LogLevel;
  }
  return 'info';
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export function createLogger(namespace: string): Logger {
  const log = (level: LogLevel, message: string, ...args: unknown[]) => {
    const currentLevel = getCurrentLogLevel();
    if (LOG_LEVELS[level] >= LOG_LEVELS[currentLevel]) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${level.toUpperCase()}] [${namespace}]`;
      // MCP stdio transport uses stdout for JSON-RPC — all logs must go to stderr
      const formatted = args.length > 0
        ? `${prefix} ${message} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`
        : `${prefix} ${message}`;
      process.stderr.write(formatted + '\n');
    }
  };

  return {
    debug: (message: string, ...args: unknown[]) => log('debug', message, ...args),
    info: (message: string, ...args: unknown[]) => log('info', message, ...args),
    warn: (message: string, ...args: unknown[]) => log('warn', message, ...args),
    error: (message: string, ...args: unknown[]) => log('error', message, ...args),
  };
}
