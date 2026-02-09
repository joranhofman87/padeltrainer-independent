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
  // Marketing / Public
  home: '/',
  auth: '/auth',
  trainers: '/en/trainers',
  locations: '/en/locations',
  pricing: '/en/pricing',
  about: '/en/about',
  academies: '/en/academies',
  forgotPassword: '/forgot-password',
  
  // Signup
  playerSignup: '/signup/player',
  trainerSignup: '/signup/trainer',
  clubSignup: '/signup/club',
  academySignup: '/signup/academy',
  
  // Player Dashboard
  playerDashboard: '/player',
  playerBookings: '/player/bookings',
  playerFollowing: '/player/following',
  playerSettings: '/player/settings',
  
  // Trainer Dashboard
  trainerDashboard: '/trainer',
  trainerCalendar: '/trainer/calendar',
  trainerPlayers: '/trainer/players',
  trainerCycles: '/trainer/cycles',
  trainerIntakeRequests: '/trainer/intake-requests',
  trainerSettings: '/trainer/settings',
  trainerSubscription: '/trainer/subscription',
  trainerEarnings: '/trainer/earnings',
  trainerAnalytics: '/trainer/analytics',
  
  // Club Dashboard
  clubDashboard: '/club',
  clubCalendar: '/club/calendar',
  clubPlayers: '/club/players',
  clubTrainers: '/club/trainers',
  clubCycles: '/club/cycles',
  clubIntakeRequests: '/club/intake-requests',
  clubTournaments: '/club/tournaments',
  clubProfile: '/club/profile',
  clubSettings: '/club/settings',
  clubSubscription: '/club/subscription',
  
  
  // Academy Dashboard
  academyDashboard: '/academy',
  academyTrainers: '/academy/trainers',
  academyLocations: '/academy/locations',
  academyCycles: '/academy/cycles',
  academyProfile: '/academy/profile',
  academySettings: '/academy/settings',
  
  // Admin Dashboard
  admin: '/admin',
  adminUsers: '/admin/users',
  adminTrainers: '/admin/trainers',
  adminClubs: '/admin/clubs',
  adminAcademies: '/admin/academies',
  adminLocations: '/admin/locations',
  adminCertifications: '/admin/certifications',
  adminClubClaims: '/admin/club-claims',
  adminPricing: '/admin/pricing',
  adminRatingSystems: '/admin/rating-systems',
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
