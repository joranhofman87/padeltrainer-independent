import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LanguageRouter, RootRedirect } from '@/components/LanguageRouter';
import { Loader2 } from 'lucide-react';

// Layout components lazy-loaded to reduce initial bundle size
const TrainerLayout = lazy(() => import('@/components/trainer/TrainerLayout'));
const PlayerLayout = lazy(() => import('@/components/player/PlayerLayout'));
const ClubLayout = lazy(() => import('@/components/club/ClubLayout'));
const AcademyLayout = lazy(() => import('@/components/academy/AcademyLayout'));
const AdminLayout = lazy(() => import('@/components/admin/AdminLayout'));

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
const Brand = lazy(() => import('@/pages/marketing/Brand'));
const PressKit = lazy(() => import('@/pages/marketing/PressKit'));
const About = lazy(() => import('@/pages/marketing/About'));
const Blog = lazy(() => import('@/pages/marketing/Blog'));
const BlogPost = lazy(() => import('@/pages/marketing/BlogPost'));
const Rules = lazy(() => import('@/pages/marketing/Rules'));
const RulesPage = lazy(() => import('@/pages/marketing/RulesPage'));
const Strokes = lazy(() => import('@/pages/marketing/Strokes'));
const StrokePage = lazy(() => import('@/pages/marketing/StrokePage'));
const Coaches = lazy(() => import('@/pages/marketing/Coaches'));
const CoachPage = lazy(() => import('@/pages/marketing/CoachPage'));
const VideoTips = lazy(() => import('@/pages/marketing/VideoTips'));
const VideoTipPage = lazy(() => import('@/pages/marketing/VideoTipPage'));
const LearnIndex = lazy(() => import('@/pages/marketing/LearnIndex'));
const LearningArticlePage = lazy(() => import('@/pages/marketing/LearningArticlePage'));
const TopicsIndex = lazy(() => import('@/pages/marketing/TopicsIndex'));
const TopicPage = lazy(() => import('@/pages/marketing/TopicPage'));
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
const BrandedCycleRegistration = lazy(() => import('@/pages/BrandedCycleRegistration'));
const RacketFinder = lazy(() => import('@/pages/marketing/RacketFinder'));
const RacketListing = lazy(() => import('@/pages/marketing/RacketListing'));
const RacketDetail = lazy(() => import('@/pages/marketing/RacketDetail'));
const PadelLevelTest = lazy(() => import('@/pages/marketing/PadelLevelTest'));
const CityLanding = lazy(() => import('@/pages/marketing/CityLanding'));
const PublicRatingCard = lazy(() => import('@/pages/marketing/PublicRatingCard'));
const FoundingTrainers = lazy(() => import('@/pages/marketing/FoundingTrainers'));
const Playground = lazy(() => import('@/pages/marketing/Playground'));
const RedFlagQuiz = lazy(() => import('@/pages/marketing/RedFlagQuiz'));
const RateMyCourtPage = lazy(() => import('@/pages/marketing/RateMyCourtPage'));
const ChallengeModePage = lazy(() => import('@/pages/marketing/ChallengeModePage'));

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
const TrainerOnboardingFlow = lazy(() => import('@/pages/onboarding/TrainerOnboardingFlow'));
const AcademySignup = lazy(() => import('@/pages/AcademySignup'));
const AcademyOnboarding = lazy(() => import('@/pages/AcademyOnboarding'));
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
const TrainerSettings = lazy(() => import('@/pages/TrainerSettings'));
const TrainerBookingSettings = lazy(() => import('@/pages/TrainerBookingSettings'));
const TrainerTerms = lazy(() => import('@/pages/TrainerTerms'));

const TrainerEarnings = lazy(() => import('@/pages/TrainerEarnings'));
const TrainerSubscription = lazy(() => import('@/pages/TrainerSubscription'));
const TrainerAnalytics = lazy(() => import('@/pages/TrainerAnalytics'));
const TrainerCalendar = lazy(() => import('@/pages/TrainerCalendar'));
const TrainerPlayers = lazy(() => import('@/pages/TrainerPlayers'));
const TrainerCyclus = lazy(() => import('@/pages/TrainerCyclus'));
const TrainerCycles = lazy(() => import('@/pages/TrainerCycles'));
const TrainerIntakeRequests = lazy(() => import('@/pages/TrainerIntakeRequests'));
const ProposalOverviewPage = lazy(() => import('@/pages/ProposalOverviewPage'));
const TrainerWaitingList = lazy(() => import('@/pages/TrainerWaitingList'));
const OpenSlots = lazy(() => import('@/pages/OpenSlots'));
const TrainerScheduleOverview = lazy(() => import('@/pages/TrainerScheduleOverview'));
const BookingSuccess = lazy(() => import('@/pages/BookingSuccess'));
const CycleFormPage = lazy(() => import('@/pages/CycleFormPage'));
const TrainerInvoices = lazy(() => import('@/pages/trainer/TrainerInvoices'));
const TrainerCreateInvoice = lazy(() => import('@/pages/trainer/TrainerCreateInvoice'));
const TrainerEditInvoice = lazy(() => import('@/pages/trainer/TrainerEditInvoice'));
const TrainerSlotDetail = lazy(() => import('@/pages/trainer/TrainerSlotDetail'));
const TrainerCreateSlot = lazy(() => import('@/pages/trainer/TrainerCreateSlot'));

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

const AdminClubClaims = lazy(() => import('@/pages/admin/AdminClubClaims'));
const AdminPlayerRatings = lazy(() => import('@/pages/admin/AdminPlayerRatings'));
const AdminBlog = lazy(() => import('@/pages/admin/AdminBlog'));
const AdminBlogEditor = lazy(() => import('@/pages/admin/AdminBlogEditor'));
const AdminBlogTopics = lazy(() => import('@/pages/admin/AdminBlogTopics'));
const AdminBlogSources = lazy(() => import('@/pages/admin/AdminBlogSources'));
const AdminBackups = lazy(() => import('@/pages/admin/AdminBackups'));
const AdminGuestPlayers = lazy(() => import('@/pages/admin/AdminGuestPlayers'));
const AdminCourtReviews = lazy(() => import('@/pages/admin/AdminCourtReviews'));

// Club pages
const ClubDashboard = lazy(() => import('@/pages/club/ClubDashboard'));
const ClubPlayers = lazy(() => import('@/pages/club/ClubPlayers'));
const ClubTrainers = lazy(() => import('@/pages/club/ClubTrainers'));
const ClubProfile = lazy(() => import('@/pages/club/ClubProfile'));
const ClubCalendar = lazy(() => import('@/pages/club/ClubCalendar'));
const ClubTournaments = lazy(() => import('@/pages/club/ClubTournaments'));
const ClubCycles = lazy(() => import('@/pages/club/ClubCycles'));
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
const AcademyBulkCopySlots = lazy(() => import('@/pages/academy/AcademyBulkCopySlots'));
const TrainerBulkCopySlots = lazy(() => import('@/pages/trainer/TrainerBulkCopySlots'));
const PriorityClaim = lazy(() => import('@/pages/PriorityClaim'));
const AcademyCycleDetail = lazy(() => import('@/pages/academy/AcademyCycleDetail'));
const AcademyCalendar = lazy(() => import('@/pages/academy/AcademyCalendar'));
const AcademySlotDetail = lazy(() => import('@/pages/academy/AcademySlotDetail'));
const AcademyCreateSlot = lazy(() => import('@/pages/academy/AcademyCreateSlot'));
const AcademyIntakeRequests = lazy(() => import('@/pages/academy/AcademyIntakeRequests'));
const AcademySubscription = lazy(() => import('@/pages/academy/AcademySubscription'));
const AcademyTrainerInvitation = lazy(() => import('@/pages/academy/AcademyTrainerInvitation'));
const AcademyTrainerDetail = lazy(() => import('@/pages/academy/AcademyTrainerDetail'));

const AcademyWaitingList = lazy(() => import('@/pages/academy/AcademyWaitingList'));
const AcademyPlayers = lazy(() => import('@/pages/academy/AcademyPlayers'));
const AcademyPlayerDetail = lazy(() => import('@/pages/academy/AcademyPlayerDetail'));

const AcademyInvoices = lazy(() => import('@/pages/academy/AcademyInvoices'));
const AcademyCreateInvoice = lazy(() => import('@/pages/academy/AcademyCreateInvoice'));
const AcademyEditInvoice = lazy(() => import('@/pages/academy/AcademyEditInvoice'));

// Public pages
const PublicInvoicePay = lazy(() => import('@/pages/PublicInvoicePay'));

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
        {/* Public invoice payment page */}
        <Route path="/pay/:token" element={<PublicInvoicePay />} />

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
        <Route path="/app/signup" element={<SignupRootRedirect />} />
        <Route path="/app/signup/player" element={<PlayerSignup />} />
        <Route path="/app/signup/trainer" element={<TrainerSignup />} />
        <Route path="/app/signup/club" element={<ClubSignup />} />
        <Route path="/app/signup/academy" element={<AcademySignup />} />
        <Route path="/app/onboarding/club" element={<ClubOnboarding />} />
        <Route path="/app/onboarding/trainer" element={<TrainerOnboardingFlow />} />
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
          {/* Calendar sync hidden — replaced by ICS download on bookings page */}
          {/* <Route path="settings/calendar" element={<CalendarSettings />} /> */}
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
          <Route path="cycles/bulk-copy" element={<TrainerBulkCopySlots />} />
          <Route path="cycles/new" element={<CycleFormPage ownerType="trainer" />} />
          <Route path="cycles/:cycleId/edit" element={<CycleFormPage ownerType="trainer" />} />
          <Route path="intake-requests" element={<TrainerIntakeRequests />} />
          <Route path="intake-requests/overview" element={<ProposalOverviewPage />} />
          <Route path="waiting-list" element={<TrainerWaitingList />} />
          <Route path="open-slots" element={<OpenSlots />} />
          <Route path="schedule-overview" element={<TrainerScheduleOverview />} />
          
          <Route path="profile" element={<EditProfile />} />
          <Route path="subscription" element={<TrainerSubscription />} />
          <Route path="earnings" element={<TrainerEarnings />} />
          <Route path="analytics" element={<TrainerAnalytics />} />
          
          <Route path="invoices" element={<TrainerInvoices />} />
          <Route path="invoices/new" element={<TrainerCreateInvoice />} />
          <Route path="invoices/:invoiceId/edit" element={<TrainerEditInvoice />} />
          <Route path="slot/new" element={<TrainerCreateSlot />} />
          <Route path="slot/:slotId" element={<TrainerSlotDetail />} />
          
          <Route path="get-started" element={<Navigate to="/app/trainer" replace />} />
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
          
          <Route path="player-ratings" element={<AdminPlayerRatings />} />
          <Route path="blog" element={<AdminBlog />} />
          <Route path="blog/new" element={<AdminBlogEditor />} />
          <Route path="blog/topics" element={<AdminBlogTopics />} />
          <Route path="blog/:id" element={<AdminBlogEditor />} />
          <Route path="blog/:id/sources" element={<AdminBlogSources />} />
          <Route path="backups" element={<AdminBackups />} />
          <Route path="guest-players" element={<AdminGuestPlayers />} />
          <Route path="court-reviews" element={<AdminCourtReviews />} />
        </Route>
        
        {/* Club routes */}
        <Route path="/app/club" element={<ClubLayout />}>
          <Route index element={<ClubDashboard />} />
          <Route path="profile" element={<ClubProfile />} />
          <Route path="players" element={<ClubPlayers />} />
          <Route path="trainers" element={<ClubTrainers />} />
          <Route path="calendar" element={<ClubCalendar />} />
          <Route path="registrations" element={<ClubCycles />} />
          <Route path="registrations/new" element={<CycleFormPage ownerType="club" />} />
          <Route path="registrations/:cycleId/edit" element={<CycleFormPage ownerType="club" />} />
          
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
          <Route path="trainers/:trainerId" element={<AcademyTrainerDetail />} />
          <Route path="players" element={<AcademyPlayers />} />
          <Route path="players/:playerId" element={<AcademyPlayerDetail />} />
          <Route path="open-slots" element={<Navigate to="/app/academy/calendar?tab=cycles" replace />} />
          <Route path="locations" element={<AcademyLocations />} />
          <Route path="cycles" element={<AcademyCycles />} />
          <Route path="cycles/bulk-copy" element={<AcademyBulkCopySlots />} />
          <Route path="cycles/new" element={<CycleFormPage ownerType="academy" />} />
          <Route path="cycles/:cycleId" element={<AcademyCycleDetail />} />
          <Route path="cycles/:cycleId/edit" element={<AcademyCycleDetail />} />
          <Route path="calendar" element={<AcademyCalendar />} />
          <Route path="slot/new" element={<AcademyCreateSlot />} />
          <Route path="slot/:slotId" element={<AcademySlotDetail />} />
          <Route path="intake-requests" element={<AcademyIntakeRequests />} />
          <Route path="intake-requests/overview" element={<ProposalOverviewPage />} />
          <Route path="waiting-list" element={<AcademyWaitingList />} />
          <Route path="settings" element={<AcademySettings />} />
          <Route path="settings/notifications" element={<NotificationSettings />} />
          <Route path="subscription" element={<AcademySubscription />} />
          
          <Route path="invoices" element={<AcademyInvoices />} />
          <Route path="invoices/new" element={<AcademyCreateInvoice />} />
          <Route path="invoices/:invoiceId/edit" element={<AcademyEditInvoice />} />
        </Route>
        <Route path="/app/academy/invitation/:token" element={<AcademyTrainerInvitation />} />

        {/* ===== SHORT-LINK REDIRECTS (social-friendly) ===== */}
        <Route path="/a/:slug" element={<ShortLinkRedirect kind="academy" />} />
        <Route path="/t/:slug" element={<ShortLinkRedirect kind="trainer" />} />

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
          {/* Note: legacy /:lang/rules redirect removed so the :topicSlug catch route below
              can serve the topic hub at /en/rules. /padel-rules remains the canonical Rules listing. */}
          <Route path="padel-rules" element={<Rules />} />
          <Route path="padel-rules/:slug" element={<RulesPage />} />
          <Route path="padel-strokes" element={<Strokes />} />
          <Route path="padel-strokes/:slug" element={<StrokePage />} />
          <Route path="padel-coaches" element={<Coaches />} />
          <Route path="padel-coaches/:slug" element={<CoachPage />} />
          <Route path="video-tips" element={<VideoTips />} />
          <Route path="video-tips/:slug" element={<VideoTipPage />} />
          <Route path="learn" element={<LearnIndex />} />
          <Route path="learn/:slug" element={<LearningArticlePage />} />
          <Route path="topics" element={<TopicsIndex />} />
          <Route path="topics/:slug" element={<TopicPage />} />
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
          <Route path="academies/:slug/pay/:token" element={<PublicInvoicePay />} />
          <Route path="academies/:slug/register/:cycleId" element={<BrandedCycleRegistration ownerType="academy" />} />
          <Route path="clubs/:slug/register/:cycleId" element={<BrandedCycleRegistration ownerType="club" />} />
          <Route path="book/:trainerId" element={<BookLesson />} />
          <Route path="register/:cycleId" element={<CycleRegistration />} />
          <Route path="claim/:token" element={<PriorityClaim />} />
          {/* Playground hub */}
          <Route path="playground" element={<Playground />} />
          <Route path="playground/red-flag-quiz" element={<RedFlagQuiz />} />
          <Route path="playground/racket-finder" element={<RacketFinder />} />
          <Route path="playground/level-test" element={<PadelLevelTest />} />
          <Route path="playground/rate-my-court" element={<RateMyCourtPage />} />
          <Route path="playground/challenge-mode" element={<ChallengeModePage />} />
          {/* Legacy redirects */}
          <Route path="racket-finder" element={<Navigate to="../playground/racket-finder" replace />} />
          <Route path="tools/padel-level-test" element={<Navigate to="../playground/level-test" replace />} />
          <Route path="gear/rackets" element={<RacketListing />} />
          <Route path="gear/rackets/:slug" element={<RacketDetail />} />
          <Route path="padel/:city" element={<CityLanding />} />
          <Route path="rating/:profileId" element={<PublicRatingCard />} />
          <Route path="founding-trainers" element={<FoundingTrainers />} />
          <Route path="brand" element={<Brand />} />
          <Route path="press" element={<PressKit />} />
          {/* Localized topic hubs (e.g. /nl/slagen, /en/strokes). MUST stay last so
              all static routes above win. TopicPage renders NotFound when no Sanity
              topic matches the (lang, slug) pair. */}
          <Route path=":topicSlug" element={<TopicPage />} />
        </Route>
        
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}

/** /app/signup → trainer signup; preserves ?redirect= and other query params. */
function SignupRootRedirect() {
  return <Navigate to={`/app/signup/trainer${window.location.search}`} replace />;
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

/**
 * Redirects unlocalized short links (`/a/:slug`, `/t/:slug`) to their
 * canonical localized public profile page. Picks the user's preferred
 * language from localStorage, falling back to `nl`.
 */
function ShortLinkRedirect({ kind }: { kind: 'academy' | 'trainer' }) {
  const path = window.location.pathname;
  const slug = path.split('/')[2] ?? '';
  const stored = (() => {
    try { return localStorage.getItem('i18nextLng'); } catch { return null; }
  })();
  const lang = (stored?.split('-')[0]) || 'nl';
  const target = kind === 'academy'
    ? `/${lang}/academies/${slug}`
    : `/${lang}/trainer/${slug}`;
  return <Navigate to={`${target}${window.location.search}`} replace />;
}
