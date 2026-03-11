/**
 * Centralized logging utility for production error tracking and monitoring.
 * Sends errors and warnings to PostHog as $exception events.
 */

import posthog from 'posthog-js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  component?: string;
  action?: string;
  userId?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

const isDev = import.meta.env.DEV;

/**
 * Format a log entry for console output
 */
function formatLogEntry(entry: LogEntry): string {
  const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}]`;
  const contextStr = entry.context 
    ? ` | ${Object.entries(entry.context).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`
    : '';
  return `${prefix} ${entry.message}${contextStr}`;
}

/**
 * Create a log entry object
 */
function createLogEntry(
  level: LogLevel,
  message: string,
  context?: LogContext,
  error?: Error
): LogEntry {
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    context,
    error: error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : undefined,
  };
}

/**
 * Send log to PostHog as a $exception event.
 * Falls back to sessionStorage in dev or when PostHog isn't active.
 */
function sendToMonitoring(entry: LogEntry): void {
  // Send to PostHog if available (production only)
  try {
    const ph = posthog;
    if (ph && typeof ph.capture === 'function' && ph._isIdentified !== undefined) {
      ph.capture('$exception', {
        $exception_message: entry.error?.message || entry.message,
        $exception_type: entry.error?.name || (entry.level === 'warn' ? 'Warning' : 'Error'),
        $exception_stack_trace_raw: entry.error?.stack,
        $exception_source: 'logger',
        $exception_level: entry.level,
        ...(entry.context || {}),
      });
    }
  } catch {
    // Silently ignore — PostHog may not be initialized
  }

  // Keep sessionStorage fallback for dev debugging
  if (entry.level === 'error') {
    try {
      const storedErrors = JSON.parse(sessionStorage.getItem('app_errors') || '[]');
      storedErrors.push(entry);
      if (storedErrors.length > 50) storedErrors.shift();
      sessionStorage.setItem('app_errors', JSON.stringify(storedErrors));
    } catch {
      // Ignore storage errors
    }
  }
}

/**
 * Logger instance with methods for each log level
 */
export const logger = {
  /**
   * Debug level - only shown in development
   */
  debug(message: string, context?: LogContext): void {
    if (!isDev) return;
    const entry = createLogEntry('debug', message, context);
    console.debug(formatLogEntry(entry), context);
  },

  /**
   * Info level - general information
   */
  info(message: string, context?: LogContext): void {
    const entry = createLogEntry('info', message, context);
    if (isDev) {
      console.info(formatLogEntry(entry), context);
    }
    // In production, we might send to monitoring for important info logs
  },

  /**
   * Warning level - potential issues
   */
  warn(message: string, context?: LogContext): void {
    const entry = createLogEntry('warn', message, context);
    console.warn(formatLogEntry(entry), context);
    if (!isDev) {
      sendToMonitoring(entry);
    }
  },

  /**
   * Error level - actual errors
   */
  error(message: string, error?: Error, context?: LogContext): void {
    const entry = createLogEntry('error', message, context, error);
    console.error(formatLogEntry(entry), { error, context });
    sendToMonitoring(entry);
  },

  /**
   * Track a user action for analytics/debugging
   */
  track(action: string, context?: LogContext): void {
    const entry = createLogEntry('info', `Action: ${action}`, { action, ...context });
    if (isDev) {
      console.log(`[TRACK] ${action}`, context);
    }
    // Could send to analytics service in production
  },

  /**
   * Measure performance of an async operation
   */
  async measure<T>(
    operationName: string,
    operation: () => Promise<T>,
    context?: LogContext
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await operation();
      const duration = performance.now() - start;
      this.debug(`${operationName} completed in ${duration.toFixed(2)}ms`, {
        ...context,
        operation: operationName,
        durationMs: duration,
      });
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.error(`${operationName} failed after ${duration.toFixed(2)}ms`, error as Error, {
        ...context,
        operation: operationName,
        durationMs: duration,
      });
      throw error;
    }
  },

  /**
   * Get stored errors (useful for debugging in production)
   */
  getStoredErrors(): LogEntry[] {
    try {
      return JSON.parse(sessionStorage.getItem('app_errors') || '[]');
    } catch {
      return [];
    }
  },

  /**
   * Clear stored errors
   */
  clearStoredErrors(): void {
    sessionStorage.removeItem('app_errors');
  },
};

export default logger;
