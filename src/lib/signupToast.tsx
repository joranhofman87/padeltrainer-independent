import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { ToastAction } from '@/components/ui/toast';
import { logger } from '@/lib/logger';
import {
  isSignupEmailAlreadyRegistered,
  type SignupFailure,
} from '@/lib/signupErrors';

type AuthT = (key: string, fallback?: string) => string;

type ToastFn = (props: {
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive';
  action?: ReactElement;
}) => void;

export function showSignupErrorToast(
  toast: ToastFn,
  t: AuthT,
  error: SignupFailure,
  logContext: { component: string; action?: string },
): void {
  logger.error('Signup failed', new Error(error.message), {
    ...logContext,
    code: error.code,
  });

  if (isSignupEmailAlreadyRegistered(error)) {
    toast({
      title: t('signUp.error', 'Error'),
      description: t(
        'form.emailAlreadyRegistered',
        'This email is already registered. Please sign in instead.',
      ),
      variant: 'destructive',
      action: (
        <ToastAction altText={t('signIn.button', 'Sign in')} asChild>
          <Link to="/app/auth">{t('signIn.button', 'Sign in')}</Link>
        </ToastAction>
      ),
    });
    return;
  }

  toast({
    title: t('signUp.error', 'Error'),
    description: t(
      'form.signupGenericError',
      'Something went wrong. Please try again.',
    ),
    variant: 'destructive',
  });
}
