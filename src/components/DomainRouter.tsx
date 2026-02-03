import { Routes, Route, Navigate } from 'react-router-dom';
import { useHostname } from '@/hooks/useHostname';
import { LanguageRouter, RootRedirect } from '@/components/LanguageRouter';
import { useEffect } from 'react';
import { logger } from '@/lib/logger';

// Marketing pages
import Home from '@/pages/marketing/Home';
import Pricing from '@/pages/marketing/Pricing';
import About from '@/pages/marketing/About';
import Blog from '@/pages/marketing/Blog';
import BlogPost from '@/pages/marketing/BlogPost';
import Privacy from '@/pages/marketing/Privacy';
import Terms from '@/pages/marketing/Terms';
import Partner from '@/pages/marketing/Partner';
import Trainers from '@/pages/Trainers';
import TrainersCity from '@/pages/TrainersCity';
import TrainerProfile from '@/pages/TrainerProfile';
import Locations from '@/pages/Locations';
import LocationDetail from '@/pages/LocationDetail';
import Academies from '@/pages/Academies';
import AcademyPublicProfile from '@/pages/AcademyPublicProfile';
import BookLesson from '@/pages/BookLesson';
import CycleRegistration from '@/pages/CycleRegistration';

// App pages
import Auth from '@/pages/Auth';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
import SelectRole from '@/pages/SelectRole';
import PlayerSignup from '@/pages/PlayerSignup';
import TrainerSignup from '@/pages/TrainerSignup';
import ClubSignup from '@/pages/ClubSignup';
import ClubOnboarding from '@/pages/ClubOnboarding';
import Onboarding from '@/pages/Onboarding';
import PlayerDashboard from '@/pages/PlayerDashboard';
import TrainerDashboard from '@/pages/TrainerDashboard';
import TrainerSettings from '@/pages/TrainerSettings';
import TrainerBookingSettings from '@/pages/TrainerBookingSettings';
import EditProfile from '@/pages/EditProfile';
import ManageLessons from '@/pages/ManageLessons';
import PlayerBookings from '@/pages/PlayerBookings';
import TrainerBookings from '@/pages/TrainerBookings';
import BookingSuccess from '@/pages/BookingSuccess';
import TrainerEarnings from '@/pages/TrainerEarnings';
import TrainerSubscription from '@/pages/TrainerSubscription';
import TrainerAnalytics from '@/pages/TrainerAnalytics';
import TrainerCalendar from '@/pages/TrainerCalendar';
import TrainerPlayers from '@/pages/TrainerPlayers';
import TrainerCyclus from '@/pages/TrainerCyclus';
import TrainerCycles from '@/pages/TrainerCycles';
import TrainerIntakeRequests from '@/pages/TrainerIntakeRequests';
import OpenSlots from '@/pages/OpenSlots';
import TrainerLayout from '@/components/trainer/TrainerLayout';
import PlayerLayout from '@/components/player/PlayerLayout';
import NotificationSettings from '@/pages/NotificationSettings';
import CalendarSettings from '@/pages/CalendarSettings';
import FollowingList from '@/pages/FollowingList';
import AdminLayout from '@/components/admin/AdminLayout';
import AdminDashboard from '@/pages/AdminDashboard';
import AdminLocations from '@/pages/admin/AdminLocations';
import AdminCertifications from '@/pages/admin/AdminCertifications';
import AdminRatingSystems from '@/pages/admin/AdminRatingSystems';
import AdminReviewTags from '@/pages/admin/AdminReviewTags';
import AdminUsers from '@/pages/admin/AdminUsers';
import AdminClubs from '@/pages/admin/AdminClubs';
import AdminTrainers from '@/pages/admin/AdminTrainers';
import AdminAcademies from '@/pages/admin/AdminAcademies';
import AdminPricing from '@/pages/admin/AdminPricing';
import AdminOnboardingEmails from '@/pages/admin/AdminOnboardingEmails';
import AdminClubClaims from '@/pages/admin/AdminClubClaims';
import ClubDashboard from '@/pages/club/ClubDashboard';
import ClubLayout from '@/components/club/ClubLayout';
import ClubPlayers from '@/pages/club/ClubPlayers';
import ClubTrainers from '@/pages/club/ClubTrainers';
import ClubProfile from '@/pages/club/ClubProfile';
import ClubCalendar from '@/pages/club/ClubCalendar';
import ClubLessons from '@/pages/club/ClubLessons';
import ClubTournaments from '@/pages/club/ClubTournaments';
import ClubSettings from '@/pages/club/ClubSettings';
import ClubSubscription from '@/pages/club/ClubSubscription';
import ClubTrainerInvitation from '@/pages/club/ClubTrainerInvitation';
import AcademySignup from '@/pages/AcademySignup';
import AcademyOnboarding from '@/pages/AcademyOnboarding';
import AcademyLayout from '@/components/academy/AcademyLayout';
import AcademyDashboard from '@/pages/academy/AcademyDashboard';
import AcademyProfile from '@/pages/academy/AcademyProfile';
import AcademySettings from '@/pages/academy/AcademySettings';
import AcademyTrainers from '@/pages/academy/AcademyTrainers';
import AcademyLocations from '@/pages/academy/AcademyLocations';
import AcademyCycles from '@/pages/academy/AcademyCycles';
import AcademyCalendar from '@/pages/academy/AcademyCalendar';
import AcademyTrainerInvitation from '@/pages/academy/AcademyTrainerInvitation';
import NotFound from '@/pages/NotFound';

/**
 * Marketing routes - served on padeltrainer.ai
 * These are public-facing pages with language prefixes for SEO.
 */
function MarketingRoutes() {
  return (
    <Routes>
      {/* Root redirect - detects browser language */}
      <Route path="/" element={<RootRedirect />} />
      
      {/* App route redirects - MUST come before /:lang to avoid being caught as language */}
      <Route path="/auth" element={<RedirectToAppDomain path="/auth" />} />
      <Route path="/forgot-password" element={<RedirectToAppDomain path="/forgot-password" />} />
      <Route path="/reset-password" element={<RedirectToAppDomain path="/reset-password" />} />
      <Route path="/signup/*" element={<RedirectToAppDomain path="/signup" />} />
      <Route path="/onboarding/*" element={<RedirectToAppDomain path="/onboarding" />} />
      <Route path="/select-role" element={<RedirectToAppDomain path="/select-role" />} />
      <Route path="/player/*" element={<RedirectToAppDomain path="/player" />} />
      <Route path="/trainer/*" element={<RedirectToAppDomain path="/trainer" />} />
      <Route path="/club/*" element={<RedirectToAppDomain path="/club" />} />
      <Route path="/academy/*" element={<RedirectToAppDomain path="/academy" />} />
      <Route path="/admin/*" element={<RedirectToAppDomain path="/admin" />} />
      <Route path="/profile/*" element={<RedirectToAppDomain path="/profile" />} />
      <Route path="/lessons" element={<RedirectToAppDomain path="/lessons" />} />
      <Route path="/bookings" element={<RedirectToAppDomain path="/bookings" />} />
      <Route path="/booking-success" element={<RedirectToAppDomain path="/booking-success" />} />
      <Route path="/earnings" element={<RedirectToAppDomain path="/earnings" />} />
      <Route path="/subscription" element={<RedirectToAppDomain path="/subscription" />} />
      <Route path="/analytics" element={<RedirectToAppDomain path="/analytics" />} />
      <Route path="/settings/*" element={<RedirectToAppDomain path="/settings" />} />
      <Route path="/availability" element={<RedirectToAppDomain path="/availability" />} />
      <Route path="/schedule" element={<RedirectToAppDomain path="/schedule" />} />
      <Route path="/trainer-bookings" element={<RedirectToAppDomain path="/trainer-bookings" />} />
      
      {/* Language-prefixed marketing routes - MUST come after app routes */}
      <Route path="/:lang" element={<LanguageRouter />}>
        <Route index element={<Home />} />
        <Route path="pricing" element={<Pricing />} />
        <Route path="about" element={<About />} />
        <Route path="blog" element={<Blog />} />
        <Route path="blog/:slug" element={<BlogPost />} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="terms" element={<Terms />} />
        <Route path="partner" element={<Partner />} />
        <Route path="trainers" element={<Trainers />} />
        <Route path="trainers/:city" element={<TrainersCity />} />
        <Route path="trainer/:trainerId" element={<TrainerProfile />} />
        <Route path="locations" element={<Locations />} />
        <Route path="locations/:slug" element={<LocationDetail />} />
        <Route path="academies" element={<Academies />} />
        <Route path="academies/:slug" element={<AcademyPublicProfile />} />
        <Route path="book/:trainerId" element={<BookLesson />} />
        <Route path="register/:cycleId" element={<CycleRegistration />} />
      </Route>
      
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/**
 * App routes - served on app.padeltrainer.ai
 * These are authenticated/functional pages without language prefixes.
 */
function AppRoutes() {
  return (
    <Routes>
      {/* Redirect root to auth or dashboard based on login state */}
      <Route path="/" element={<Navigate to="/auth" replace />} />
      
      {/* Auth routes */}
      <Route path="/auth" element={<Auth />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/signup/player" element={<PlayerSignup />} />
      <Route path="/signup/trainer" element={<TrainerSignup />} />
      <Route path="/signup/club" element={<ClubSignup />} />
      <Route path="/signup/academy" element={<AcademySignup />} />
      <Route path="/onboarding/club" element={<ClubOnboarding />} />
      <Route path="/onboarding/:role" element={<Onboarding />} />
      <Route path="/academy/onboarding" element={<AcademyOnboarding />} />
      <Route path="/select-role" element={<SelectRole />} />
      
      {/* Player routes */}
      <Route path="/player" element={<PlayerLayout />}>
        <Route index element={<PlayerDashboard />} />
        <Route path="bookings" element={<PlayerBookings />} />
        <Route path="following" element={<FollowingList />} />
        <Route path="profile" element={<EditProfile />} />
        <Route path="settings/notifications" element={<NotificationSettings />} />
        <Route path="settings/calendar" element={<CalendarSettings />} />
      </Route>
      
      {/* Trainer routes */}
      <Route path="/trainer" element={<TrainerLayout />}>
        <Route index element={<TrainerDashboard />} />
        <Route path="settings" element={<TrainerSettings />} />
        <Route path="settings/bookings" element={<TrainerBookingSettings />} />
        <Route path="calendar" element={<TrainerCalendar />} />
        <Route path="players" element={<TrainerPlayers />} />
        <Route path="cyclus" element={<TrainerCyclus />} />
        <Route path="cycles" element={<TrainerCycles />} />
        <Route path="intake-requests" element={<TrainerIntakeRequests />} />
        <Route path="open-slots" element={<OpenSlots />} />
      </Route>

      {/* Legacy routes for backwards compatibility */}
      <Route path="/profile/edit" element={<EditProfile />} />
      <Route path="/lessons" element={<ManageLessons />} />
      <Route path="/availability" element={<TrainerCalendar />} />
      <Route path="/schedule" element={<TrainerCalendar />} />
      <Route path="/bookings" element={<PlayerBookings />} />
      <Route path="/trainer-bookings" element={<TrainerBookings />} />
      <Route path="/booking-success" element={<BookingSuccess />} />
      <Route path="/earnings" element={<TrainerEarnings />} />
      <Route path="/subscription" element={<TrainerSubscription />} />
      <Route path="/analytics" element={<TrainerAnalytics />} />
      <Route path="/settings/notifications" element={<NotificationSettings />} />
      <Route path="/settings/calendar" element={<CalendarSettings />} />
      
      {/* Admin routes */}
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminDashboard />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="clubs" element={<AdminClubs />} />
        <Route path="trainers" element={<AdminTrainers />} />
        <Route path="locations" element={<AdminLocations />} />
        <Route path="certifications" element={<AdminCertifications />} />
        <Route path="club-claims" element={<AdminClubClaims />} />
        <Route path="rating-systems" element={<AdminRatingSystems />} />
        <Route path="review-tags" element={<AdminReviewTags />} />
        <Route path="academies" element={<AdminAcademies />} />
        <Route path="pricing" element={<AdminPricing />} />
        <Route path="onboarding-emails" element={<AdminOnboardingEmails />} />
      </Route>
      
      {/* Club routes */}
      <Route path="/club" element={<ClubLayout />}>
        <Route index element={<ClubDashboard />} />
        <Route path="profile" element={<ClubProfile />} />
        <Route path="players" element={<ClubPlayers />} />
        <Route path="trainers" element={<ClubTrainers />} />
        <Route path="calendar" element={<ClubCalendar />} />
        <Route path="lessons" element={<ClubLessons />} />
        <Route path="tournaments" element={<ClubTournaments />} />
        <Route path="settings" element={<ClubSettings />} />
        <Route path="subscription" element={<ClubSubscription />} />
        <Route path="invitation/:token" element={<ClubTrainerInvitation />} />
      </Route>
      
      {/* Academy routes */}
      <Route path="/academy" element={<AcademyLayout />}>
        <Route index element={<AcademyDashboard />} />
        <Route path="profile" element={<AcademyProfile />} />
        <Route path="trainers" element={<AcademyTrainers />} />
        <Route path="locations" element={<AcademyLocations />} />
        <Route path="cycles" element={<AcademyCycles />} />
        <Route path="calendar" element={<AcademyCalendar />} />
        <Route path="settings" element={<AcademySettings />} />
      </Route>
      <Route path="/academy/invitation/:token" element={<AcademyTrainerInvitation />} />
      
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/**
 * Combined routes for development mode.
 * Shows all routes when in localhost or Lovable preview.
 */
function CombinedRoutes() {
  return (
    <Routes>
      {/* Root redirect - detects browser language */}
      <Route path="/" element={<RootRedirect />} />
      
      {/* App routes - MUST come before /:lang to avoid being caught by language router */}
      <Route path="/auth" element={<Auth />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/signup/player" element={<PlayerSignup />} />
      <Route path="/signup/trainer" element={<TrainerSignup />} />
      <Route path="/signup/club" element={<ClubSignup />} />
      <Route path="/signup/academy" element={<AcademySignup />} />
      <Route path="/onboarding/club" element={<ClubOnboarding />} />
      <Route path="/onboarding/:role" element={<Onboarding />} />
      <Route path="/academy/onboarding" element={<AcademyOnboarding />} />
      <Route path="/select-role" element={<SelectRole />} />
      
      {/* Player routes */}
      <Route path="/player" element={<PlayerLayout />}>
        <Route index element={<PlayerDashboard />} />
        <Route path="bookings" element={<PlayerBookings />} />
        <Route path="following" element={<FollowingList />} />
        <Route path="profile" element={<EditProfile />} />
        <Route path="settings/notifications" element={<NotificationSettings />} />
        <Route path="settings/calendar" element={<CalendarSettings />} />
      </Route>
      
      {/* Trainer routes */}
      <Route path="/trainer" element={<TrainerLayout />}>
        <Route index element={<TrainerDashboard />} />
        <Route path="settings" element={<TrainerSettings />} />
        <Route path="settings/bookings" element={<TrainerBookingSettings />} />
        <Route path="calendar" element={<TrainerCalendar />} />
        <Route path="players" element={<TrainerPlayers />} />
        <Route path="cyclus" element={<TrainerCyclus />} />
        <Route path="cycles" element={<TrainerCycles />} />
        <Route path="intake-requests" element={<TrainerIntakeRequests />} />
        <Route path="open-slots" element={<OpenSlots />} />
      </Route>

      {/* Legacy routes */}
      <Route path="/profile/edit" element={<EditProfile />} />
      <Route path="/lessons" element={<ManageLessons />} />
      <Route path="/availability" element={<TrainerCalendar />} />
      <Route path="/schedule" element={<TrainerCalendar />} />
      <Route path="/bookings" element={<PlayerBookings />} />
      <Route path="/trainer-bookings" element={<TrainerBookings />} />
      <Route path="/booking-success" element={<BookingSuccess />} />
      <Route path="/earnings" element={<TrainerEarnings />} />
      <Route path="/subscription" element={<TrainerSubscription />} />
      <Route path="/analytics" element={<TrainerAnalytics />} />
      <Route path="/settings/notifications" element={<NotificationSettings />} />
      <Route path="/settings/calendar" element={<CalendarSettings />} />
      
      {/* Admin routes */}
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminDashboard />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="clubs" element={<AdminClubs />} />
        <Route path="trainers" element={<AdminTrainers />} />
        <Route path="locations" element={<AdminLocations />} />
        <Route path="certifications" element={<AdminCertifications />} />
        <Route path="club-claims" element={<AdminClubClaims />} />
        <Route path="rating-systems" element={<AdminRatingSystems />} />
        <Route path="review-tags" element={<AdminReviewTags />} />
        <Route path="academies" element={<AdminAcademies />} />
        <Route path="pricing" element={<AdminPricing />} />
        <Route path="onboarding-emails" element={<AdminOnboardingEmails />} />
      </Route>
      
      {/* Club routes */}
      <Route path="/club" element={<ClubLayout />}>
        <Route index element={<ClubDashboard />} />
        <Route path="profile" element={<ClubProfile />} />
        <Route path="players" element={<ClubPlayers />} />
        <Route path="trainers" element={<ClubTrainers />} />
        <Route path="calendar" element={<ClubCalendar />} />
        <Route path="lessons" element={<ClubLessons />} />
        <Route path="tournaments" element={<ClubTournaments />} />
        <Route path="settings" element={<ClubSettings />} />
        <Route path="subscription" element={<ClubSubscription />} />
        <Route path="invitation/:token" element={<ClubTrainerInvitation />} />
      </Route>
      
      {/* Academy routes */}
      <Route path="/academy" element={<AcademyLayout />}>
        <Route index element={<AcademyDashboard />} />
        <Route path="profile" element={<AcademyProfile />} />
        <Route path="trainers" element={<AcademyTrainers />} />
        <Route path="locations" element={<AcademyLocations />} />
        <Route path="cycles" element={<AcademyCycles />} />
        <Route path="calendar" element={<AcademyCalendar />} />
        <Route path="settings" element={<AcademySettings />} />
      </Route>
      <Route path="/academy/invitation/:token" element={<AcademyTrainerInvitation />} />
      
      {/* Language-prefixed marketing routes - MUST come after app routes */}
      <Route path="/:lang" element={<LanguageRouter />}>
        <Route index element={<Home />} />
        <Route path="pricing" element={<Pricing />} />
        <Route path="about" element={<About />} />
        <Route path="blog" element={<Blog />} />
        <Route path="blog/:slug" element={<BlogPost />} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="terms" element={<Terms />} />
        <Route path="partner" element={<Partner />} />
        <Route path="trainers" element={<Trainers />} />
        <Route path="trainers/:city" element={<TrainersCity />} />
        <Route path="trainer/:trainerId" element={<TrainerProfile />} />
        <Route path="locations" element={<Locations />} />
        <Route path="locations/:slug" element={<LocationDetail />} />
        <Route path="academies" element={<Academies />} />
        <Route path="academies/:slug" element={<AcademyPublicProfile />} />
        <Route path="book/:trainerId" element={<BookLesson />} />
        <Route path="register/:cycleId" element={<CycleRegistration />} />
      </Route>
      
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
/**
 * Helper component to redirect to app subdomain.
 * Used on marketing domain when users try to access app routes.
 */
function RedirectToAppDomain({ path }: { path: string }) {
  const hostname = window.location.hostname;
  
  // Check if we're on the production marketing domain
  const isProductionMarketing = hostname === 'padeltrainer.ai' || hostname === 'www.padeltrainer.ai';
  
  // Check if we're in local development only
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
  
  // Log for debugging
  logger.debug('RedirectToAppDomain', { path, hostname, isProductionMarketing, isLocalhost });
  
  // PRODUCTION: On padeltrainer.ai, immediately redirect to app.padeltrainer.ai
  if (isProductionMarketing) {
    // Use direct assignment for immediate redirect before React can interfere
    window.location.href = `https://app.padeltrainer.ai${path}`;
    // Return loading state while redirect happens
    return <div>Redirecting...</div>;
  }
  
  // LOCALHOST: Use React Router navigation for local development
  if (isLocalhost) {
    return <Navigate to={path} replace />;
  }
  
  // LOVABLE PREVIEW: Use React Router navigation (all routes available)
  // This catches *.lovable.app and *.lovableproject.com
  return <Navigate to={path} replace />;
}

/**
 * Main router component that serves different routes based on hostname.
 */
export function DomainRouter() {
  const { isAppDomain, isMarketingDomain, isDevelopment, hostname } = useHostname();
  
  // Debug logging for production diagnostics
  useEffect(() => {
    logger.debug('DomainRouter routing', { hostname, isAppDomain, isMarketingDomain, isDevelopment });
  }, [hostname, isAppDomain, isMarketingDomain, isDevelopment]);
  
  // In development, show all routes
  if (isDevelopment) {
    return <CombinedRoutes />;
  }
  
  // In production, serve domain-specific routes
  if (isAppDomain) {
    return <AppRoutes />;
  }
  
  if (isMarketingDomain) {
    return <MarketingRoutes />;
  }
  
  // Fallback to combined routes (shouldn't happen in production)
  return <CombinedRoutes />;
}
