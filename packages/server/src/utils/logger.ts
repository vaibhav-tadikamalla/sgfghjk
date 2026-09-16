import pino from 'pino';
import { getConfig } from '../config';

let _logger: pino.Logger | null = null;

export function createLogger(): pino.Logger {
  const config = getConfig();
  const isDev = config.NODE_ENV === 'development';

  _logger = pino({
    level: isDev ? 'debug' : 'info',
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
    base: {
      pid: process.pid,
      instance: config.INSTANCE_ID,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  });

  return _logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    return createLogger();
  }
  return _logger;
}

// Child logger factory for request-scoped logging
export function createRequestLogger(
  requestId: string,
  userId?: string,
  documentId?: string,
): pino.Logger {
  return getLogger().child({
    requestId,
    userId,
    documentId,
  });
}

// Child logger factory for trace-ID–scoped logging
export function createTraceLogger(
  traceId: string,
  extra?: Record<string, unknown>,
): pino.Logger {
  return getLogger().child({ traceId, ...extra });
}
