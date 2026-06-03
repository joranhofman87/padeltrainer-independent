/** Normalized signup-user failure codes (client-side). */
export const SIGNUP_ERROR_CODE = {
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  GENERIC: 'GENERIC',
} as const;

export type SignupErrorCode = (typeof SIGNUP_ERROR_CODE)[keyof typeof SIGNUP_ERROR_CODE];

export interface SignupFailure {
  name: 'SignupError';
  code: SignupErrorCode;
  /** Raw detail for logs only — not for user-facing copy. */
  message: string;
}

export function createSignupFailure(code: SignupErrorCode, logMessage: string): SignupFailure {
  return { name: 'SignupError', code, message: logMessage };
}

export function isSignupEmailAlreadyRegistered(error: unknown): error is SignupFailure {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as SignupFailure).code === SIGNUP_ERROR_CODE.EMAIL_ALREADY_REGISTERED
  );
}

/** Matches signup-user and related Auth API duplicate-user messages. */
export function isDuplicateEmailSignupMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('already registered') ||
    normalized.includes('user already exists') ||
    normalized.includes('email already') ||
    normalized.includes('already been registered')
  );
}

export function extractSignupResponseError(response: unknown): string | undefined {
  if (!response || typeof response !== 'object' || !('error' in response)) {
    return undefined;
  }
  const err = (response as { error?: unknown }).error;
  return typeof err === 'string' ? err : undefined;
}

function collectInvokeErrorMessages(invokeError: unknown): string[] {
  const messages: string[] = [];
  if (!invokeError || typeof invokeError !== 'object') {
    return messages;
  }

  if ('message' in invokeError && typeof (invokeError as Error).message === 'string') {
    messages.push((invokeError as Error).message);
  }

  const context = (invokeError as { context?: unknown }).context;
  if (typeof context === 'string') {
    messages.push(context);
  } else if (context && typeof context === 'object') {
    if ('body' in context && typeof (context as { body?: unknown }).body === 'string') {
      messages.push((context as { body: string }).body);
    }
    if ('json' in context && typeof (context as { json?: () => Promise<unknown> }).json === 'function') {
      // not awaited here — sync path only
    }
  }

  return messages;
}

/**
 * Classify signup-user invoke failures. Checks JSON body even when Supabase sets invokeError on 4xx.
 */
export function normalizeSignupFailure(invokeError: unknown, response: unknown): SignupFailure {
  const responseError = extractSignupResponseError(response);
  const combined = [responseError, ...collectInvokeErrorMessages(invokeError)].filter(Boolean).join(' ');

  if (isDuplicateEmailSignupMessage(combined)) {
    return createSignupFailure(
      SIGNUP_ERROR_CODE.EMAIL_ALREADY_REGISTERED,
      responseError || combined || 'User already registered',
    );
  }

  return createSignupFailure(
    SIGNUP_ERROR_CODE.GENERIC,
    responseError || combined || 'Signup failed',
  );
}
