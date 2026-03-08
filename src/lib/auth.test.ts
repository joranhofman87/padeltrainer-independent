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
        'John Doe',
        '+31612345678'
      );

      expect(supabase.functions.invoke).toHaveBeenCalledWith('signup-user', expect.objectContaining({
        body: expect.objectContaining({ email: 'test@example.com' }),
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

      const result = await signUpWithEmail('test@example.com', 'password123', 'John Doe');

      expect(result.error).toBeTruthy();
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

      const result = await signUpWithEmail('test@example.com', 'password123', 'John Doe');

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

      expect(result.error).toEqual(mockError);
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
      const mockSelect = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [{ role: 'player' }, { role: 'admin' }, { role: 'trainer' }],
          error: null,
        }),
      });
      (supabase.from as Mock).mockReturnValue({ select: mockSelect });

      const role = await getUserRole('user-123');

      expect(role).toBe('admin');
    });

    it('returns trainer over club and player', async () => {
      const mockSelect = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [{ role: 'player' }, { role: 'trainer' }, { role: 'club' }],
          error: null,
        }),
      });
      (supabase.from as Mock).mockReturnValue({ select: mockSelect });

      const role = await getUserRole('user-123');

      expect(role).toBe('trainer');
    });

    it('returns club over player', async () => {
      const mockSelect = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [{ role: 'player' }, { role: 'club' }],
          error: null,
        }),
      });
      (supabase.from as Mock).mockReturnValue({ select: mockSelect });

      const role = await getUserRole('user-123');

      expect(role).toBe('club');
    });

    it('returns null for user with no roles', async () => {
      const mockSelect = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      });
      (supabase.from as Mock).mockReturnValue({ select: mockSelect });

      const role = await getUserRole('user-123');

      expect(role).toBeNull();
    });
  });

  describe('getUserRoles', () => {
    it('returns all roles for user', async () => {
      const mockSelect = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: [{ role: 'player' }, { role: 'trainer' }],
          error: null,
        }),
      });
      (supabase.from as Mock).mockReturnValue({ select: mockSelect });

      const roles = await getUserRoles('user-123');

      expect(roles).toEqual(['player', 'trainer']);
    });

    it('returns empty array on error', async () => {
      const mockSelect = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'Database error' },
        }),
      });
      (supabase.from as Mock).mockReturnValue({ select: mockSelect });

      const roles = await getUserRoles('user-123');

      expect(roles).toEqual([]);
    });
  });

  describe('setUserRole', () => {
    it('inserts role and creates trainer profile for trainer role', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: { user_id: 'user-123', role: 'trainer' },
        error: null,
      });
      const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
      const mockInsert = vi.fn().mockReturnValue({ select: mockSelect });
      
      const mockTrainerInsert = vi.fn().mockResolvedValue({ error: null });
      
      let callCount = 0;
      (supabase.from as Mock).mockImplementation((table: string) => {
        if (table === 'user_roles') {
          return { insert: mockInsert };
        }
        if (table === 'trainer_profiles') {
          return { insert: mockTrainerInsert };
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

      const profile = await getProfile('user-123');

      expect(supabase.from).toHaveBeenCalledWith('profiles');
      expect(profile?.full_name).toBe('John Doe');
    });

    it('returns null on error', async () => {
      const mockSingle = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Not found' },
      });
      const mockEq = vi.fn().mockReturnValue({ single: mockSingle });
      const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
      (supabase.from as Mock).mockReturnValue({ select: mockSelect });

      const profile = await getProfile('user-123');

      expect(profile).toBeNull();
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
