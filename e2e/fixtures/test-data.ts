/**
 * Test data constants for E2E tests
 */

export const TEST_USERS = {
  player: {
    email: `test-player-${Date.now()}@example.com`,
    password: 'TestPassword123!',
    fullName: 'Test Player',
    phone: '+31612345678',
  },
  trainer: {
    email: `test-trainer-${Date.now()}@example.com`,
    password: 'TestPassword123!',
    fullName: 'Test Trainer',
    phone: '+31687654321',
  },
  club: {
    email: `test-club-${Date.now()}@example.com`,
    password: 'TestPassword123!',
    fullName: 'Test Club Manager',
  },
  academy: {
    email: `test-academy-${Date.now()}@example.com`,
    password: 'TestPassword123!',
    fullName: 'Test Academy Manager',
    academyName: 'Test Padel Academy',
  },
};

export const TEST_LOCATIONS = {
  amsterdam: 'Amsterdam',
  rotterdam: 'Rotterdam',
};

export const ROUTES = {
  home: '/',
  auth: '/auth',
  playerSignup: '/signup/player',
  trainerSignup: '/signup/trainer',
  clubSignup: '/signup/club',
  academySignup: '/signup/academy',
  trainers: '/en/trainers',
  locations: '/en/locations',
  pricing: '/en/pricing',
  playerDashboard: '/player',
  trainerDashboard: '/trainer',
  clubDashboard: '/club',
  academyDashboard: '/academy',
  forgotPassword: '/forgot-password',
};
