import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import type { UserRole, UserProfile, TrainerProfile } from './auth';

// Mock the supabase client
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      signUp: vi.fn(),
      signInWithPassword: vi.fn(),
      signInWithOAuth: vi.fn(),
      signOut: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updateUser: vi.fn(),
    },
    from: vi.fn(),
    rpc: vi.fn(),
    functions: {
      invoke: vi.fn(),
    },
  },
}));

// Mock domains module
vi.mock('@/lib/domains', () => ({
  getAuthRedirectUrl: vi.fn((path: string) => `http://localhost:3000${path}`),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { supabase } from '@/lib/supabaseClient';

// Import functions after mocking
import {
  signUpWithEmail,
  signInWithEmail,
  signInWithGoogle,
  signOut,
  getUserRole,
  getUserRoles,
  setUserRole,
  getProfile,
  updateProfile,
  getTrainerProfile,
  sendPasswordResetEmail,
  updatePassword,
} from './auth';

describe('Auth module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('signUpWithEmail', () => {
    it('calls signup edge function and signs in', async () => {
      const mockUser = { id: 'user-123', email: 'test@example.com' };
      (supabase.functions.invoke as Mock).mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });
      (supabase.auth.signInWithPassword as Mock).mockResolvedValue({
        data: { user: mockUser, session: { access_token: 'tok' } },
        error: null,
      });

      const result = await signUpWithEmail(
        'test@example.com',
        'password123',
        'John',
        'Doe',
        '+31612345678',
      );

      expect(supabase.functions.invoke).toHaveBeenCalledWith('signup-user', expect.objectContaining({
        body: expect.objectContaining({
          email: 'test@example.com',
          firstName: 'John',
          lastName: 'Doe',
          fullName: 'John Doe',
        }),
      }));
      expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.data.user).toEqual(mockUser);
      expect(result.error).toBeNull();
    });

    it('returns error when signup function fails', async () => {
      (supabase.functions.invoke as Mock).mockResolvedValue({
        data: null,
        error: { message: 'Signup failed' },
      });

      const result = await signUpWithEmail('test@example.com', 'password123', 'John', 'Doe');

      expect(result.error).toBeTruthy();
    });

    it('supports legacy fullName-only callers', async () => {
      const mockUser = { id: 'user-123', email: 'test@example.com' };
      (supabase.functions.invoke as Mock).mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });
      (supabase.auth.signInWithPassword as Mock).mockResolvedValue({
        data: { user: mockUser, session: { access_token: 'tok' } },
        error: null,
      });

      await signUpWithEmail('test@example.com', 'password123', 'John Doe', undefined, undefined, 'player');

      expect(supabase.functions.invoke).toHaveBeenCalledWith('signup-user', expect.objectContaining({
        body: expect.objectContaining({
          firstName: 'John',
          lastName: 'Doe',
          fullName: 'John Doe',
          role: 'player',
        }),
      }));
    });

    it('does not fail if no phone provided', async () => {
      const mockUser = { id: 'user-123', email: 'test@example.com' };
      (supabase.functions.invoke as Mock).mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });
      (supabase.auth.signInWithPassword as Mock).mockResolvedValue({
        data: { user: mockUser, session: { access_token: 'tok' } },
        error: null,
      });

      const result = await signUpWithEmail('test@example.com', 'password123', 'John', 'Doe');

      expect(supabase.functions.invoke).toHaveBeenCalled();
      expect(result.data.user).toEqual(mockUser);
    });
  });

  describe('signInWithEmail', () => {
    it('calls supabase.auth.signInWithPassword', async () => {
      const mockSession = { access_token: 'token' };
      (supabase.auth.signInWithPassword as Mock).mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      const result = await signInWithEmail('test@example.com', 'password123');

      expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'password123',
      });
      expect(result.data.session).toEqual(mockSession);
    });

    it('returns error on invalid credentials', async () => {
      const mockError = { message: 'Invalid login credentials' };
      (supabase.auth.signInWithPassword as Mock).mockResolvedValue({
        data: { session: null },
        error: mockError,
      });

      const result = await signInWithEmail('test@example.com', 'wrongpass');

      expect(result.error).toMatchObject({
        message: mockError.message,
        name: 'AuthError',
      });
    });
  });

  describe('signInWithGoogle', () => {
    it('calls supabase.auth.signInWithOAuth with google provider', async () => {
      (supabase.auth.signInWithOAuth as Mock).mockResolvedValue({
        data: { url: 'https://accounts.google.com/...' },
        error: null,
      });

      await signInWithGoogle();

      expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/app/auth`,
        },
      });
    });
  });

  describe('signOut', () => {
    it('calls supabase.auth.signOut', async () => {
      (supabase.auth.signOut as Mock).mockResolvedValue({ error: null });

      const result = await signOut();

      expect(supabase.auth.signOut).toHaveBeenCalled();
      expect(result.error).toBeNull();
    });
  });

  describe('getUserRole', () => {
    it('returns admin as highest priority role', async () => {
      (supabase.rpc as Mock).mockImplementation((_fn: string, args: { _role: UserRole }) =>
        Promise.resolve({
          data: ['admin', 'trainer', 'player'].includes(args._role),
          error: null,
        }),
      );

      const role = await getUserRole('user-123');

      expect(role).toBe('admin');
    });

    it('returns trainer over club and player', async () => {
      (supabase.rpc as Mock).mockImplementation((_fn: string, args: { _role: UserRole }) =>
        Promise.resolve({
          data: ['trainer', 'club', 'player'].includes(args._role),
          error: null,
        }),
      );

      const role = await getUserRole('user-123');

      expect(role).toBe('trainer');
    });

    it('returns club over player', async () => {
      (supabase.rpc as Mock).mockImplementation((_fn: string, args: { _role: UserRole }) =>
        Promise.resolve({
          data: args._role === 'club' || args._role === 'player',
          error: null,
        }),
      );

      const role = await getUserRole('user-123');

      expect(role).toBe('club');
    });

    it('returns null for user with no roles', async () => {
      (supabase.rpc as Mock).mockResolvedValue({ data: false, error: null });

      const role = await getUserRole('user-123');

      expect(role).toBeNull();
    });
  });

  describe('getUserRoles', () => {
    it('returns roles via has_role RPC without querying user_roles table', async () => {
      (supabase.rpc as Mock).mockImplementation((_fn: string, args: { _role: UserRole }) =>
        Promise.resolve({
          data: args._role === 'player' || args._role === 'trainer',
          error: null,
        }),
      );

      const result = await getUserRoles('user-123');

      expect(result.data).toEqual(['trainer', 'player']);
      expect(result.failed).toBe(false);
      expect(supabase.from).not.toHaveBeenCalledWith('user_roles');
      expect(supabase.rpc).toHaveBeenCalledWith('has_role', {
        _user_id: 'user-123',
        _role: 'player',
      });
    });

    it('returns failed on RPC error', async () => {
      (supabase.rpc as Mock).mockResolvedValue({
        data: null,
        error: { message: 'Database error' },
      });

      const result = await getUserRoles('user-123');

      expect(result.data).toEqual([]);
      expect(result.failed).toBe(true);
    });
  });

  describe('setUserRole', () => {
    it('skips user_roles insert when has_role is already true', async () => {
      (supabase.rpc as Mock).mockResolvedValue({ data: true, error: null });

      await setUserRole('user-123', 'player');

      expect(supabase.rpc).toHaveBeenCalledWith('has_role', {
        _user_id: 'user-123',
        _role: 'player',
      });
      expect(supabase.from).not.toHaveBeenCalledWith('user_roles');
    });

    it('inserts role and creates trainer profile for trainer role when missing', async () => {
      (supabase.rpc as Mock).mockResolvedValue({ data: false, error: null });

      const mockSingle = vi.fn().mockResolvedValue({
        data: { user_id: 'user-123', role: 'trainer' },
        error: null,
      });
      const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockInsert = vi.fn().mockReturnValue({ select: mockSelect });

      const mockTrainerInsert = vi.fn().mockResolvedValue({ error: null });
      const mockTrainerMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockTrainerEq = vi.fn().mockReturnValue({ maybeSingle: mockTrainerMaybeSingle });
      const mockTrainerSelect = vi.fn().mockReturnValue({ eq: mockTrainerEq });

      (supabase.from as Mock).mockImplementation((table: string) => {
        if (table === 'user_roles') {
          return { insert: mockInsert };
        }
        if (table === 'trainer_profiles') {
          return { select: mockTrainerSelect, insert: mockTrainerInsert };
        }
        return {};
      });

      await setUserRole('user-123', 'trainer');

      expect(supabase.from).toHaveBeenCalledWith('user_roles');
      expect(mockInsert).toHaveBeenCalledWith({ user_id: 'user-123', role: 'trainer' });
      expect(supabase.from).toHaveBeenCalledWith('trainer_profiles');
      expect(mockTrainerInsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'user-123' }));
    });

    it('does not create trainer profile for player role', async () => {
      (supabase.rpc as Mock).mockResolvedValue({ data: false, error: null });

      const mockSingle = vi.fn().mockResolvedValue({
        data: { user_id: 'user-123', role: 'player' },
        error: null,
      });
      const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockInsert = vi.fn().mockReturnValue({ select: mockSelect });

      (supabase.from as Mock).mockReturnValue({ insert: mockInsert });

      await setUserRole('user-123', 'player');

      expect(supabase.from).toHaveBeenCalledWith('user_roles');
      expect(supabase.from).not.toHaveBeenCalledWith('trainer_profiles');
    });
  });

  describe('getProfile', () => {
    it('returns profile for user', async () => {
      const mockProfile: Partial<UserProfile> = {
        id: 'profile-123',
        user_id: 'user-123',
        full_name: 'John Doe',
        email: 'john@example.com',
      };

      const mockSingle = vi.fn().mockResolvedValue({
        data: mockProfile,
        error: null,
      });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      (supabase.from as Mock).mockReturnValue({ select: mockSelect });

      const result = await getProfile('user-123');

      expect(supabase.from).toHaveBeenCalledWith('profiles_owner');
      expect(result?.data?.full_name).toBe('John Doe');
      expect(result?.failed).toBe(false);
    });

    it('returns failed on error', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Not found', code: 'SOME_ERROR' },
      });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      (supabase.from as Mock).mockReturnValue({ select: mockSelect });

      const result = await getProfile('user-123');

      expect(result?.data).toBeNull();
      expect(result?.failed).toBe(true);
    });
  });

  describe('sendPasswordResetEmail', () => {
    it('calls send-auth-email edge function with correct params', async () => {
      (supabase.functions.invoke as Mock).mockResolvedValue({
        data: { success: true },
        error: null,
      });

      await sendPasswordResetEmail('test@example.com');

      expect(supabase.functions.invoke).toHaveBeenCalledWith('send-auth-email', {
        body: {
          type: 'password_reset',
          email: 'test@example.com',
          redirectTo: 'http://localhost:3000/app/reset-password',
        },
      });
    });
  });

  describe('updatePassword', () => {
    it('calls supabase.auth.updateUser with new password', async () => {
      (supabase.auth.updateUser as Mock).mockResolvedValue({
        data: { user: { id: 'user-123' } },
        error: null,
      });

      const result = await updatePassword('newSecurePassword123');

      expect(supabase.auth.updateUser).toHaveBeenCalledWith({
        password: 'newSecurePassword123',
      });
      expect(result.error).toBeNull();
    });
  });
});

describe('UserRole type', () => {
  it('includes all expected roles', () => {
    const roles: UserRole[] = ['player', 'trainer', 'admin', 'club'];
    expect(roles.length).toBe(4);
  });
});
