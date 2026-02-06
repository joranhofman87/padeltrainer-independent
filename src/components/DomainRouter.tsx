import { Routes, Route, Navigate } from 'react-router-dom';
import { LanguageRouter, RootRedirect } from '@/components/LanguageRouter';

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

// API callback pages
import MollieCallback from '@/pages/MollieCallback';

// App pages
import Auth from '@/pages/Auth';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';

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
import TrainerLessons from '@/pages/TrainerLessons';
import TrainerLayout from '@/components/trainer/TrainerLayout';
import PlayerLayout from '@/components/player/PlayerLayout';
import PlayerSettings from '@/pages/PlayerSettings';
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
import AdminBanners from '@/pages/admin/AdminBanners';
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
import AcademySubscription from '@/pages/academy/AcademySubscription';
import AcademyTrainerInvitation from '@/pages/academy/AcademyTrainerInvitation';
import AcademyEarnings from '@/pages/academy/AcademyEarnings';
import NotFound from '@/pages/NotFound';

/**
 * Single unified route tree. All app routes live under /app/*.
 * Marketing routes live under /:lang/*.
 * No more hostname detection or subdomain routing.
 */
export function DomainRouter() {
  return (
    <Routes>
      {/* API callback routes */}
      <Route path="/api/mollie-callback" element={<MollieCallback />} />

      {/* Root redirect - detects browser language */}
      <Route path="/" element={<RootRedirect />} />

      {/* ===== APP ROUTES (under /app) ===== */}
      <Route path="/app" element={<Navigate to="/app/auth" replace />} />
      
      {/* Auth routes */}
      <Route path="/app/auth" element={<Auth />} />
      <Route path="/app/forgot-password" element={<ForgotPassword />} />
      <Route path="/app/reset-password" element={<ResetPassword />} />
      <Route path="/app/signup/player" element={<PlayerSignup />} />
      <Route path="/app/signup/trainer" element={<TrainerSignup />} />
      <Route path="/app/signup/club" element={<ClubSignup />} />
      <Route path="/app/signup/academy" element={<AcademySignup />} />
      <Route path="/app/onboarding/club" element={<ClubOnboarding />} />
      <Route path="/app/onboarding/:role" element={<Onboarding />} />
      <Route path="/app/academy/onboarding" element={<AcademyOnboarding />} />
      
      {/* Player routes */}
      <Route path="/app/player" element={<PlayerLayout />}>
        <Route index element={<PlayerDashboard />} />
        <Route path="bookings" element={<PlayerBookings />} />
        <Route path="following" element={<FollowingList />} />
        <Route path="profile" element={<EditProfile />} />
        <Route path="settings" element={<PlayerSettings />} />
        <Route path="settings/notifications" element={<NotificationSettings />} />
        <Route path="settings/calendar" element={<CalendarSettings />} />
      </Route>
      
      {/* Trainer routes */}
      <Route path="/app/trainer" element={<TrainerLayout />}>
        <Route index element={<TrainerDashboard />} />
        <Route path="settings" element={<TrainerSettings />} />
        <Route path="settings/bookings" element={<TrainerBookingSettings />} />
        <Route path="calendar" element={<TrainerCalendar />} />
        <Route path="players" element={<TrainerPlayers />} />
        <Route path="cyclus" element={<TrainerCyclus />} />
        <Route path="cycles" element={<TrainerCycles />} />
        <Route path="intake-requests" element={<TrainerIntakeRequests />} />
        <Route path="open-slots" element={<OpenSlots />} />
        <Route path="lessons" element={<TrainerLessons />} />
        <Route path="profile" element={<EditProfile />} />
        <Route path="subscription" element={<TrainerSubscription />} />
        <Route path="earnings" element={<TrainerEarnings />} />
        <Route path="analytics" element={<TrainerAnalytics />} />
        <Route path="bookings" element={<TrainerBookings />} />
      </Route>

      {/* Booking & standalone routes */}
      <Route path="/app/booking-success" element={<BookingSuccess />} />
      <Route path="/app/book/:trainerId" element={<BookLesson />} />
      
      {/* Admin routes */}
      <Route path="/app/admin" element={<AdminLayout />}>
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
        <Route path="banners" element={<AdminBanners />} />
      </Route>
      
      {/* Club routes */}
      <Route path="/app/club" element={<ClubLayout />}>
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
      <Route path="/app/academy" element={<AcademyLayout />}>
        <Route index element={<AcademyDashboard />} />
        <Route path="profile" element={<AcademyProfile />} />
        <Route path="trainers" element={<AcademyTrainers />} />
        <Route path="locations" element={<AcademyLocations />} />
        <Route path="cycles" element={<AcademyCycles />} />
        <Route path="calendar" element={<AcademyCalendar />} />
        <Route path="settings" element={<AcademySettings />} />
        <Route path="subscription" element={<AcademySubscription />} />
        <Route path="earnings" element={<AcademyEarnings />} />
      </Route>
      <Route path="/app/academy/invitation/:token" element={<AcademyTrainerInvitation />} />

      {/* ===== LEGACY REDIRECTS ===== */}
      {/* Redirect old non-prefixed app routes to /app/* */}
      <Route path="/auth" element={<Navigate to="/app/auth" replace />} />
      <Route path="/forgot-password" element={<Navigate to="/app/forgot-password" replace />} />
      <Route path="/reset-password" element={<Navigate to="/app/reset-password" replace />} />
      <Route path="/signup/*" element={<LegacyRedirect prefix="/app/signup" />} />
      <Route path="/onboarding/*" element={<LegacyRedirect prefix="/app/onboarding" />} />
      <Route path="/player/*" element={<LegacyRedirect prefix="/app/player" />} />
      <Route path="/trainer/*" element={<LegacyRedirect prefix="/app/trainer" />} />
      <Route path="/club/*" element={<LegacyRedirect prefix="/app/club" />} />
      <Route path="/academy/*" element={<LegacyRedirect prefix="/app/academy" />} />
      <Route path="/admin/*" element={<LegacyRedirect prefix="/app/admin" />} />
      <Route path="/booking-success" element={<Navigate to="/app/booking-success" replace />} />
      <Route path="/book/*" element={<LegacyRedirect prefix="/app/book" />} />

      {/* ===== MARKETING ROUTES ===== */}
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
 * Redirects old unprefixed paths to /app/* equivalents.
 * Preserves the remaining path segments and search params.
 */
function LegacyRedirect({ prefix }: { prefix: string }) {
  const path = window.location.pathname;
  // Extract the part after the base segment (e.g., /signup/player -> /player)
  const basePath = prefix.replace('/app', '');
  const remaining = path.startsWith(basePath) ? path.slice(basePath.length) : '';
  return <Navigate to={`${prefix}${remaining}${window.location.search}`} replace />;
}
