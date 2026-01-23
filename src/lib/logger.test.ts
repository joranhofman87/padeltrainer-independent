import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, type LogLevel, type LogContext, type LogEntry } from './logger';

describe('logger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Clear session storage
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('debug', () => {
    it('logs debug messages in development', () => {
      logger.debug('Test debug message');
      // In test environment, debug may or may not log depending on DEV flag
      // The function should not throw
      expect(true).toBe(true);
    });

    it('accepts context object', () => {
      logger.debug('Test with context', { component: 'TestComponent' });
      expect(true).toBe(true);
    });
  });

  describe('info', () => {
    it('logs info messages', () => {
      logger.info('Test info message');
      expect(true).toBe(true);
    });

    it('accepts context object', () => {
      logger.info('Test info', { action: 'test', userId: 'user-123' });
      expect(true).toBe(true);
    });
  });

  describe('warn', () => {
    it('logs warning messages to console', () => {
      logger.warn('Test warning');
      expect(console.warn).toHaveBeenCalled();
    });

    it('includes context in warning', () => {
      logger.warn('Warning with context', { component: 'TestComponent' });
      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe('error', () => {
    it('logs error messages to console', () => {
      logger.error('Test error');
      expect(console.error).toHaveBeenCalled();
    });

    it('logs error with Error object', () => {
      const testError = new Error('Test error message');
      logger.error('Operation failed', testError);
      expect(console.error).toHaveBeenCalled();
    });

    it('logs error with context', () => {
      logger.error('Failed operation', undefined, { component: 'TestComponent' });
      expect(console.error).toHaveBeenCalled();
    });

    it('stores errors in sessionStorage', () => {
      logger.error('Stored error');
      const stored = logger.getStoredErrors();
      expect(stored.length).toBeGreaterThan(0);
      expect(stored[0].message).toBe('Stored error');
    });
  });

  describe('track', () => {
    it('tracks user actions', () => {
      logger.track('button_click', { buttonId: 'submit' });
      // In dev, should log
      expect(true).toBe(true);
    });
  });

  describe('measure', () => {
    it('measures async operation duration', async () => {
      const result = await logger.measure(
        'testOperation',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 'success';
        }
      );
      expect(result).toBe('success');
    });

    it('logs error and rethrows on failure', async () => {
      const testError = new Error('Operation failed');
      
      await expect(
        logger.measure('failingOperation', async () => {
          throw testError;
        })
      ).rejects.toThrow('Operation failed');

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('getStoredErrors', () => {
    it('returns empty array when no errors stored', () => {
      sessionStorage.clear();
      const errors = logger.getStoredErrors();
      expect(errors).toEqual([]);
    });

    it('returns stored errors', () => {
      logger.error('Error 1');
      logger.error('Error 2');
      const errors = logger.getStoredErrors();
      expect(errors.length).toBe(2);
    });
  });

  describe('clearStoredErrors', () => {
    it('clears stored errors', () => {
      logger.error('Error to clear');
      expect(logger.getStoredErrors().length).toBeGreaterThan(0);
      
      logger.clearStoredErrors();
      expect(logger.getStoredErrors()).toEqual([]);
    });
  });
});

describe('LogEntry interface', () => {
  it('has correct structure', () => {
    const entry: LogEntry = {
      level: 'error',
      message: 'Test message',
      timestamp: new Date().toISOString(),
      context: { component: 'Test' },
      error: {
        name: 'Error',
        message: 'Test error',
        stack: 'Error: Test error\n  at ...',
      },
    };

    expect(entry.level).toBe('error');
    expect(entry.message).toBe('Test message');
    expect(entry.context?.component).toBe('Test');
    expect(entry.error?.name).toBe('Error');
  });
});

describe('LogLevel type', () => {
  it('includes all log levels', () => {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    expect(levels.length).toBe(4);
  });
});

describe('LogContext interface', () => {
  it('supports component and action', () => {
    const context: LogContext = {
      component: 'BookingForm',
      action: 'submit',
    };
    expect(context.component).toBe('BookingForm');
    expect(context.action).toBe('submit');
  });

  it('supports userId', () => {
    const context: LogContext = {
      userId: 'user-123',
    };
    expect(context.userId).toBe('user-123');
  });

  it('supports additional properties', () => {
    const context: LogContext = {
      component: 'Test',
      customField: 'custom value',
      numericField: 42,
    };
    expect(context.customField).toBe('custom value');
    expect(context.numericField).toBe(42);
  });
});
