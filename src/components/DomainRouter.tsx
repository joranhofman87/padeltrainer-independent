import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LanguageRouter, RootRedirect } from '@/components/LanguageRouter';
import { Loader2 } from 'lucide-react';

// Layout components stay eagerly loaded (they wrap child routes)
import TrainerLayout from '@/components/trainer/TrainerLayout';
import PlayerLayout from '@/components/player/PlayerLayout';
import ClubLayout from '@/components/club/ClubLayout';
import AcademyLayout from '@/components/academy/AcademyLayout';
import AdminLayout from '@/components/admin/AdminLayout';

// Lightweight loading fallback
function PageLoader() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

// ===== Lazy-loaded page components =====

// Marketing pages
const Home = lazy(() => import('@/pages/marketing/Home'));
const Pricing = lazy(() => import('@/pages/marketing/Pricing'));
const About = lazy(() => import('@/pages/marketing/About'));
const Blog = lazy(() => import('@/pages/marketing/Blog'));
const BlogPost = lazy(() => import('@/pages/marketing/BlogPost'));
const Privacy = lazy(() => import('@/pages/marketing/Privacy'));
const Terms = lazy(() => import('@/pages/marketing/Terms'));
const Partner = lazy(() => import('@/pages/marketing/Partner'));
const Trainers = lazy(() => import('@/pages/Trainers'));
const TrainersCity = lazy(() => import('@/pages/TrainersCity'));
const TrainersProvince = lazy(() => import('@/pages/TrainersProvince'));
const TrainerProfile = lazy(() => import('@/pages/TrainerProfile'));
const Locations = lazy(() => import('@/pages/Locations'));
const LocationDetail = lazy(() => import('@/pages/LocationDetail'));
const Academies = lazy(() => import('@/pages/Academies'));
const AcademyPublicProfile = lazy(() => import('@/pages/AcademyPublicProfile'));
const BookLesson = lazy(() => import('@/pages/BookLesson'));
const CycleRegistration = lazy(() => import('@/pages/CycleRegistration'));

// API callback pages
const MollieCallback = lazy(() => import('@/pages/MollieCallback'));
const BookingCancelled = lazy(() => import('@/pages/BookingCancelled'));

// Auth pages
const Auth = lazy(() => import('@/pages/Auth'));
const ForgotPassword = lazy(() => import('@/pages/ForgotPassword'));
const ResetPassword = lazy(() => import('@/pages/ResetPassword'));

// Signup & onboarding
const PlayerSignup = lazy(() => import('@/pages/PlayerSignup'));
const TrainerSignup = lazy(() => import('@/pages/TrainerSignup'));
const ClubSignup = lazy(() => import('@/pages/ClubSignup'));
const ClubOnboarding = lazy(() => import('@/pages/ClubOnboarding'));
const Onboarding = lazy(() => import('@/pages/Onboarding'));
const TrainerOnboarding = lazy(() => import('@/pages/TrainerOnboarding'));
const AcademySignup = lazy(() => import('@/pages/AcademySignup'));
const AcademyOnboarding = lazy(() => import('@/pages/AcademyOnboarding'));
const SignupRolePicker = lazy(() => import('@/pages/SignupRolePicker'));

// Player pages
const PlayerDashboard = lazy(() => import('@/pages/PlayerDashboard'));
const PlayerBookings = lazy(() => import('@/pages/PlayerBookings'));
const PlayerSettings = lazy(() => import('@/pages/PlayerSettings'));
const EditProfile = lazy(() => import('@/pages/EditProfile'));
const FollowingList = lazy(() => import('@/pages/FollowingList'));
const NotificationSettings = lazy(() => import('@/pages/NotificationSettings'));
const CalendarSettings = lazy(() => import('@/pages/CalendarSettings'));

// Trainer pages
const TrainerDashboard = lazy(() => import('@/pages/TrainerDashboard'));
const TrainerGetStarted = lazy(() => import('@/pages/TrainerGetStarted'));
const TrainerSettings = lazy(() => import('@/pages/TrainerSettings'));
const TrainerBookingSettings = lazy(() => import('@/pages/TrainerBookingSettings'));
const TrainerTerms = lazy(() => import('@/pages/TrainerTerms'));
const TrainerBookings = lazy(() => import('@/pages/TrainerBookings'));
const TrainerEarnings = lazy(() => import('@/pages/TrainerEarnings'));
const TrainerSubscription = lazy(() => import('@/pages/TrainerSubscription'));
const TrainerAnalytics = lazy(() => import('@/pages/TrainerAnalytics'));
const TrainerCalendar = lazy(() => import('@/pages/TrainerCalendar'));
const TrainerPlayers = lazy(() => import('@/pages/TrainerPlayers'));
const TrainerCyclus = lazy(() => import('@/pages/TrainerCyclus'));
const TrainerCycles = lazy(() => import('@/pages/TrainerCycles'));
const TrainerIntakeRequests = lazy(() => import('@/pages/TrainerIntakeRequests'));
const TrainerWaitingList = lazy(() => import('@/pages/TrainerWaitingList'));
const OpenSlots = lazy(() => import('@/pages/OpenSlots'));
const BookingSuccess = lazy(() => import('@/pages/BookingSuccess'));

// Admin pages
const AdminDashboard = lazy(() => import('@/pages/AdminDashboard'));
const AdminLocations = lazy(() => import('@/pages/admin/AdminLocations'));
const AdminCertifications = lazy(() => import('@/pages/admin/AdminCertifications'));
const AdminRatingSystems = lazy(() => import('@/pages/admin/AdminRatingSystems'));
const AdminReviewTags = lazy(() => import('@/pages/admin/AdminReviewTags'));
const AdminUsers = lazy(() => import('@/pages/admin/AdminUsers'));
const AdminClubs = lazy(() => import('@/pages/admin/AdminClubs'));
const AdminTrainers = lazy(() => import('@/pages/admin/AdminTrainers'));
const AdminAcademies = lazy(() => import('@/pages/admin/AdminAcademies'));
const AdminPricing = lazy(() => import('@/pages/admin/AdminPricing'));
const AdminOnboardingEmails = lazy(() => import('@/pages/admin/AdminOnboardingEmails'));
const AdminBanners = lazy(() => import('@/pages/admin/AdminBanners'));
const AdminClubClaims = lazy(() => import('@/pages/admin/AdminClubClaims'));
const AdminPlayerRatings = lazy(() => import('@/pages/admin/AdminPlayerRatings'));
const AdminBlog = lazy(() => import('@/pages/admin/AdminBlog'));
const AdminBlogEditor = lazy(() => import('@/pages/admin/AdminBlogEditor'));
const AdminBlogTopics = lazy(() => import('@/pages/admin/AdminBlogTopics'));
const AdminBlogSources = lazy(() => import('@/pages/admin/AdminBlogSources'));

// Club pages
const ClubDashboard = lazy(() => import('@/pages/club/ClubDashboard'));
const ClubPlayers = lazy(() => import('@/pages/club/ClubPlayers'));
const ClubTrainers = lazy(() => import('@/pages/club/ClubTrainers'));
const ClubProfile = lazy(() => import('@/pages/club/ClubProfile'));
const ClubCalendar = lazy(() => import('@/pages/club/ClubCalendar'));
const ClubTournaments = lazy(() => import('@/pages/club/ClubTournaments'));
const ClubSettings = lazy(() => import('@/pages/club/ClubSettings'));
const ClubSubscription = lazy(() => import('@/pages/club/ClubSubscription'));
const ClubTrainerInvitation = lazy(() => import('@/pages/club/ClubTrainerInvitation'));

// Academy pages
const AcademyDashboard = lazy(() => import('@/pages/academy/AcademyDashboard'));
const AcademyProfile = lazy(() => import('@/pages/academy/AcademyProfile'));
const AcademySettings = lazy(() => import('@/pages/academy/AcademySettings'));
const AcademyTrainers = lazy(() => import('@/pages/academy/AcademyTrainers'));
const AcademyLocations = lazy(() => import('@/pages/academy/AcademyLocations'));
const AcademyCycles = lazy(() => import('@/pages/academy/AcademyCycles'));
const AcademyCalendar = lazy(() => import('@/pages/academy/AcademyCalendar'));
const AcademyIntakeRequests = lazy(() => import('@/pages/academy/AcademyIntakeRequests'));
const AcademySubscription = lazy(() => import('@/pages/academy/AcademySubscription'));
const AcademyTrainerInvitation = lazy(() => import('@/pages/academy/AcademyTrainerInvitation'));
const AcademyEarnings = lazy(() => import('@/pages/academy/AcademyEarnings'));
const AcademyWaitingList = lazy(() => import('@/pages/academy/AcademyWaitingList'));
const AcademyPlayers = lazy(() => import('@/pages/academy/AcademyPlayers'));
const AcademyOpenSlots = lazy(() => import('@/pages/academy/AcademyOpenSlots'));

// Other
const NotFound = lazy(() => import('@/pages/NotFound'));

/**
 * Single unified route tree. All app routes live under /app/*.
 * Marketing routes live under /:lang/*.
 * No more hostname detection or subdomain routing.
 */
export function DomainRouter() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* API callback routes (legacy + new path) */}
        <Route path="/api/mollie-callback" element={<MollieCallback />} />
        <Route path="/app/api/mollie-callback" element={<MollieCallback />} />

        {/* Root redirect - detects browser language */}
        <Route path="/" element={<RootRedirect />} />

        {/* ===== APP ROUTES (under /app) ===== */}
        <Route path="/app" element={<Navigate to="/app/auth" replace />} />
        
        {/* Auth routes */}
        <Route path="/app/auth" element={<Auth />} />
        <Route path="/app/forgot-password" element={<ForgotPassword />} />
        <Route path="/app/reset-password" element={<ResetPassword />} />
        <Route path="/app/signup" element={<SignupRolePicker />} />
        <Route path="/app/signup/player" element={<PlayerSignup />} />
        <Route path="/app/signup/trainer" element={<TrainerSignup />} />
        <Route path="/app/signup/club" element={<ClubSignup />} />
        <Route path="/app/signup/academy" element={<AcademySignup />} />
        <Route path="/app/onboarding/club" element={<ClubOnboarding />} />
        <Route path="/app/onboarding/trainer" element={<TrainerOnboarding />} />
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
          <Route path="settings/notifications" element={<NotificationSettings />} />
          <Route path="terms" element={<TrainerTerms />} />
          <Route path="calendar" element={<TrainerCalendar />} />
          <Route path="players" element={<TrainerPlayers />} />
          <Route path="cyclus" element={<TrainerCyclus />} />
          <Route path="cycles" element={<TrainerCycles />} />
          <Route path="intake-requests" element={<TrainerIntakeRequests />} />
          <Route path="waiting-list" element={<TrainerWaitingList />} />
          <Route path="open-slots" element={<OpenSlots />} />
          
          <Route path="profile" element={<EditProfile />} />
          <Route path="subscription" element={<TrainerSubscription />} />
          <Route path="earnings" element={<TrainerEarnings />} />
          <Route path="analytics" element={<TrainerAnalytics />} />
          <Route path="bookings" element={<TrainerBookings />} />
          <Route path="get-started" element={<TrainerGetStarted />} />
        </Route>

        {/* Booking & standalone routes */}
        <Route path="/app/booking-success" element={<BookingSuccess />} />
        <Route path="/app/booking-cancelled" element={<BookingCancelled />} />
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
          <Route path="player-ratings" element={<AdminPlayerRatings />} />
          <Route path="blog" element={<AdminBlog />} />
          <Route path="blog/new" element={<AdminBlogEditor />} />
          <Route path="blog/topics" element={<AdminBlogTopics />} />
          <Route path="blog/:id" element={<AdminBlogEditor />} />
          <Route path="blog/:id/sources" element={<AdminBlogSources />} />
        </Route>
        
        {/* Club routes */}
        <Route path="/app/club" element={<ClubLayout />}>
          <Route index element={<ClubDashboard />} />
          <Route path="profile" element={<ClubProfile />} />
          <Route path="players" element={<ClubPlayers />} />
          <Route path="trainers" element={<ClubTrainers />} />
          <Route path="calendar" element={<ClubCalendar />} />
          
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
          <Route path="players" element={<AcademyPlayers />} />
          <Route path="open-slots" element={<AcademyOpenSlots />} />
          <Route path="locations" element={<AcademyLocations />} />
          <Route path="cycles" element={<AcademyCycles />} />
          <Route path="calendar" element={<AcademyCalendar />} />
          <Route path="intake-requests" element={<AcademyIntakeRequests />} />
          <Route path="waiting-list" element={<AcademyWaitingList />} />
          <Route path="settings" element={<AcademySettings />} />
          <Route path="settings/notifications" element={<NotificationSettings />} />
          <Route path="subscription" element={<AcademySubscription />} />
          <Route path="earnings" element={<AcademyEarnings />} />
        </Route>
        <Route path="/app/academy/invitation/:token" element={<AcademyTrainerInvitation />} />

        {/* ===== LEGACY REDIRECTS ===== */}
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
        <Route path="/booking-success" element={<LegacyRedirect prefix="/app/booking-success" />} />
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
          <Route path="trainers/region/:province" element={<TrainersProvince />} />
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
    </Suspense>
  );
}

/**
 * Redirects old unprefixed paths to /app/* equivalents.
 * Preserves the remaining path segments and search params.
 */
function LegacyRedirect({ prefix }: { prefix: string }) {
  const path = window.location.pathname;
  const basePath = prefix.replace('/app', '');
  const remaining = path.startsWith(basePath) ? path.slice(basePath.length) : '';
  return <Navigate to={`${prefix}${remaining}${window.location.search}`} replace />;
}
