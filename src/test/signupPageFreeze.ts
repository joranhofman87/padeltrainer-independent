import { expect, vi } from 'vitest';
import { fireEvent, screen, type RenderResult } from '@testing-library/react';
import type { SignupRole } from '@/lib/auth';

/** Vitest/jsdom may lack localStorage; signup pages set pendingRole on Google OAuth. */
export function mockSignupLocalStorage() {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    key: () => null,
    length: 0,
  });
  return store;
}

/** Vitest/jsdom may lack sessionStorage; claim-flow toasts use it once per session. */
export function mockSessionStorage() {
  const store: Record<string, string> = {};
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    key: () => null,
    length: 0,
  });
  return store;
}

export function mockBrowserStorage() {
  return { local: mockSignupLocalStorage(), session: mockSessionStorage() };
}

export type SignupPageRole = SignupRole;

export const SIGNUP_ROUTES: Record<SignupPageRole, string> = {
  player: '/app/signup/player',
  trainer: '/app/signup/trainer',
  club: '/app/signup/club',
  academy: '/app/signup/academy',
};

/** Assert structured signup form — no legacy fullName field. */
export function assertSignupPageStructure(role: SignupPageRole, result?: RenderResult) {
  const root = result?.container ?? document.body;
  expect(screen.getByTestId(`form-signup-${role}`)).toBeInTheDocument();
  expect(screen.getByTestId('input-signup-firstName')).toBeInTheDocument();
  expect(screen.getByTestId('input-signup-lastName')).toBeInTheDocument();
  expect(screen.getByTestId('input-signup-email')).toBeInTheDocument();
  expect(screen.getByTestId('input-signup-password')).toBeInTheDocument();
  expect(screen.getByTestId('btn-signup-submit')).toBeInTheDocument();
  expect(screen.getByTestId(`signup-tab-${role}`)).toBeInTheDocument();
  expect(root.querySelector('input[name="fullName"]')).toBeNull();
  expect(root.querySelector('input#fullName')).toBeNull();
  expect(root.querySelector('[data-testid="input-signup-fullName"]')).toBeNull();
}

export function assertPasswordVisibilityToggle() {
  const passwordInput = screen.getByTestId('input-signup-password');
  expect(passwordInput).toHaveAttribute('type', 'password');
  fireEvent.change(passwordInput, { target: { value: 'password123' } });
  fireEvent.click(screen.getByRole('button', { name: 'form.passwordShow' }));
  expect(passwordInput).toHaveAttribute('type', 'text');
}

export function fillValidSignupForm(email: string) {
  fireEvent.change(screen.getByTestId('input-signup-firstName'), { target: { value: 'Alex' } });
  fireEvent.change(screen.getByTestId('input-signup-lastName'), { target: { value: 'Morgan' } });
  fireEvent.change(screen.getByTestId('input-signup-email'), { target: { value: email } });
  fireEvent.change(screen.getByTestId('input-signup-password'), { target: { value: 'password123' } });
}

export function clickGoogleSignup() {
  const googleButtons = screen.getAllByRole('button', { name: /social\.google/i });
  fireEvent.click(googleButtons[0]);
}
