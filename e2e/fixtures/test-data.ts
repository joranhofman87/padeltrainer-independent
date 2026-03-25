/**
 * Test data constants for E2E tests
 * 
 * Route structure:
 * - Marketing pages: /:lang/* (e.g., /en/trainers, /nl/locations)
 * - App pages: /app/* (e.g., /app/auth, /app/trainer)
 * - Signup pages: /app/signup/* (e.g., /app/signup/player)
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
  // Marketing / Public
  home: '/',
  trainers: '/en/trainers',
  locations: '/en/locations',
  pricing: '/en/pricing',
  about: '/en/about',
  academies: '/en/academies',

  // Auth (app routes)
  auth: '/app/auth',
  forgotPassword: '/app/forgot-password',

  // Signup (app routes)
  playerSignup: '/app/signup/player',
  trainerSignup: '/app/signup/trainer',
  clubSignup: '/app/signup/club',
  academySignup: '/app/signup/academy',

  // Player Dashboard
  playerDashboard: '/app/player',
  playerBookings: '/app/player/bookings',
  playerFollowing: '/app/player/following',
  playerSettings: '/app/player/settings',

  // Trainer Dashboard
  trainerDashboard: '/app/trainer',
  trainerCalendar: '/app/trainer/calendar',
  trainerPlayers: '/app/trainer/players',
  trainerCycles: '/app/trainer/cycles',
  trainerIntakeRequests: '/app/trainer/intake-requests',
  trainerSettings: '/app/trainer/settings',
  trainerSubscription: '/app/trainer/subscription',
  trainerEarnings: '/app/trainer/earnings',
  trainerAnalytics: '/app/trainer/analytics',

  // Club Dashboard
  clubDashboard: '/app/club',
  clubCalendar: '/app/club/calendar',
  clubPlayers: '/app/club/players',
  clubTrainers: '/app/club/trainers',
  clubCycles: '/app/club/cycles',
  clubIntakeRequests: '/app/club/intake-requests',
  clubTournaments: '/app/club/tournaments',
  clubProfile: '/app/club/profile',
  clubSettings: '/app/club/settings',
  clubSubscription: '/app/club/subscription',

  // Academy Dashboard
  academyDashboard: '/app/academy',
  academyTrainers: '/app/academy/trainers',
  academyLocations: '/app/academy/locations',
  academyCycles: '/app/academy/cycles',
  academyProfile: '/app/academy/profile',
  academySettings: '/app/academy/settings',

  // Registration
  registrationForm: '/nl/academies/rl-padel-performance/register/8c8cdf92-0189-4111-9f84-adca26fbd448',

  // Admin Dashboard
  admin: '/app/admin',
  adminUsers: '/app/admin/users',
  adminTrainers: '/app/admin/trainers',
  adminClubs: '/app/admin/clubs',
  adminAcademies: '/app/admin/academies',
  adminLocations: '/app/admin/locations',
  adminCertifications: '/app/admin/certifications',
  adminClubClaims: '/app/admin/club-claims',
  adminPricing: '/app/admin/pricing',
  adminRatingSystems: '/app/admin/rating-systems',
};

export const ADMIN_ROUTES = [
  ROUTES.admin,
  ROUTES.adminUsers,
  ROUTES.adminTrainers,
  ROUTES.adminClubs,
  ROUTES.adminAcademies,
  ROUTES.adminLocations,
  ROUTES.adminCertifications,
  ROUTES.adminClubClaims,
  ROUTES.adminPricing,
  ROUTES.adminRatingSystems,
];

export const PLAYER_ROUTES = [
  ROUTES.playerDashboard,
  ROUTES.playerBookings,
  ROUTES.playerFollowing,
];

export const TRAINER_ROUTES = [
  ROUTES.trainerDashboard,
  ROUTES.trainerCalendar,
  ROUTES.trainerPlayers,
  ROUTES.trainerCycles,
  ROUTES.trainerIntakeRequests,
  ROUTES.trainerSettings,
  ROUTES.trainerSubscription,
];

export const CLUB_ROUTES = [
  ROUTES.clubDashboard,
  ROUTES.clubCalendar,
  ROUTES.clubPlayers,
  ROUTES.clubTrainers,
  ROUTES.clubCycles,
  ROUTES.clubIntakeRequests,
  ROUTES.clubTournaments,
  ROUTES.clubProfile,
  ROUTES.clubSettings,
  ROUTES.clubSubscription,
];

export const ACADEMY_ROUTES = [
  ROUTES.academyDashboard,
  ROUTES.academyTrainers,
  ROUTES.academyLocations,
  ROUTES.academyCycles,
  ROUTES.academyProfile,
  ROUTES.academySettings,
];
