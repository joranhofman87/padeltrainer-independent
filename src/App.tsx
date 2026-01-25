import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { ThemeProvider } from "next-themes";
import { LanguageRouter, RootRedirect } from "@/components/LanguageRouter";
import { CookieConsentProvider } from "@/contexts/CookieConsentContext";
import { CookieConsentBanner } from "@/components/CookieConsentBanner";
import "@/i18n";

// Marketing pages
import Home from "./pages/marketing/Home";
import Pricing from "./pages/marketing/Pricing";
import About from "./pages/marketing/About";
import Blog from "./pages/marketing/Blog";
import BlogPost from "./pages/marketing/BlogPost";
import Privacy from "./pages/marketing/Privacy";
import Terms from "./pages/marketing/Terms";
import Partner from "./pages/marketing/Partner";

// App pages
import Auth from "./pages/Auth";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import SelectRole from "./pages/SelectRole";
import PlayerSignup from "./pages/PlayerSignup";
import TrainerSignup from "./pages/TrainerSignup";
import ClubSignup from "./pages/ClubSignup";
import ClubOnboarding from "./pages/ClubOnboarding";
import Onboarding from "./pages/Onboarding";
import PlayerDashboard from "./pages/PlayerDashboard";
import TrainerDashboard from "./pages/TrainerDashboard";
import TrainerSettings from "./pages/TrainerSettings";
import TrainerBookingSettings from "./pages/TrainerBookingSettings";
import Trainers from "./pages/Trainers";
import TrainersCity from "./pages/TrainersCity";
import TrainerProfile from "./pages/TrainerProfile";
import EditProfile from "./pages/EditProfile";
import ManageLessons from "./pages/ManageLessons";
import ManageAvailability from "./pages/ManageAvailability";
import ManageSchedule from "./pages/ManageSchedule";
import PlayerBookings from "./pages/PlayerBookings";
import TrainerBookings from "./pages/TrainerBookings";
import BookLesson from "./pages/BookLesson";

import BookingSuccess from "./pages/BookingSuccess";
import TrainerEarnings from "./pages/TrainerEarnings";
import TrainerSubscription from "./pages/TrainerSubscription";
import TrainerAnalytics from "./pages/TrainerAnalytics";
import TrainerCalendar from "./pages/TrainerCalendar";
import TrainerPlayers from "./pages/TrainerPlayers";
import TrainerCyclus from "./pages/TrainerCyclus";
import TrainerCycles from "./pages/TrainerCycles";
import TrainerIntakeRequests from "./pages/TrainerIntakeRequests";
import OpenSlots from "./pages/OpenSlots";
import TrainerLayout from "./components/trainer/TrainerLayout";
import CycleRegistration from "./pages/CycleRegistration";
import NotificationSettings from "./pages/NotificationSettings";
import CalendarSettings from "./pages/CalendarSettings";
import FollowingList from "./pages/FollowingList";
import AdminDashboard from "./pages/AdminDashboard";
import AdminLocations from "./pages/admin/AdminLocations";
import AdminCertifications from "./pages/admin/AdminCertifications";
import AdminRatingSystems from "./pages/admin/AdminRatingSystems";
import AdminUsers from "./pages/admin/AdminUsers";
import AdminClubs from "./pages/admin/AdminClubs";
import AdminTrainers from "./pages/admin/AdminTrainers";
import AdminPricing from "./pages/admin/AdminPricing";
import Locations from "./pages/Locations";
import LocationDetail from "./pages/LocationDetail";
import ClubDashboard from "./pages/club/ClubDashboard";
import ClubLayout from "./components/club/ClubLayout";
import ClubPlayers from "./pages/club/ClubPlayers";
import ClubTrainers from "./pages/club/ClubTrainers";
import ClubProfile from "./pages/club/ClubProfile";
import ClubCalendar from "./pages/club/ClubCalendar";
import ClubLessons from "./pages/club/ClubLessons";
import ClubCycles from "./pages/club/ClubCycles";
import ClubIntakeRequests from "./pages/club/ClubIntakeRequests";
import ClubTournaments from "./pages/club/ClubTournaments";
import ClubSettings from "./pages/club/ClubSettings";
import ClubSubscription from "./pages/club/ClubSubscription";
import ClubTrainerInvitation from "./pages/club/ClubTrainerInvitation";
import AdminClubClaims from "./pages/admin/AdminClubClaims";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    <QueryClientProvider client={queryClient}>
      <CookieConsentProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <AuthProvider>
            <Routes>
            {/* Root redirect - detects browser language */}
            <Route path="/" element={<RootRedirect />} />
            
            {/* Language-prefixed marketing routes */}
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
              <Route path="book/:trainerId" element={<BookLesson />} />
              <Route path="register/:cycleId" element={<CycleRegistration />} />
            </Route>
            
            {/* App routes - language agnostic (uses localStorage preference) */}
            <Route path="/auth" element={<Auth />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/signup/player" element={<PlayerSignup />} />
            <Route path="/signup/trainer" element={<TrainerSignup />} />
            <Route path="/signup/club" element={<ClubSignup />} />
            <Route path="/onboarding/club" element={<ClubOnboarding />} />
            <Route path="/onboarding/:role" element={<Onboarding />} />
            <Route path="/select-role" element={<SelectRole />} />
            <Route path="/player" element={<PlayerDashboard />} />
            
            {/* Trainer routes - wrapped in TrainerLayout for persistent header */}
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
            <Route path="/player/following" element={<FollowingList />} />
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/admin/users" element={<AdminUsers />} />
            <Route path="/admin/clubs" element={<AdminClubs />} />
            <Route path="/admin/trainers" element={<AdminTrainers />} />
            <Route path="/admin/locations" element={<AdminLocations />} />
            <Route path="/admin/certifications" element={<AdminCertifications />} />
            <Route path="/admin/club-claims" element={<AdminClubClaims />} />
            <Route path="/admin/rating-systems" element={<AdminRatingSystems />} />
            <Route path="/admin/pricing" element={<AdminPricing />} />
            <Route path="/club" element={<ClubLayout />}>
              <Route index element={<ClubDashboard />} />
              <Route path="profile" element={<ClubProfile />} />
              <Route path="players" element={<ClubPlayers />} />
              <Route path="trainers" element={<ClubTrainers />} />
              <Route path="calendar" element={<ClubCalendar />} />
              <Route path="lessons" element={<ClubLessons />} />
              <Route path="cycles" element={<ClubCycles />} />
              <Route path="intake-requests" element={<ClubIntakeRequests />} />
              <Route path="tournaments" element={<ClubTournaments />} />
              <Route path="settings" element={<ClubSettings />} />
              <Route path="subscription" element={<ClubSubscription />} />
              <Route path="invitation/:token" element={<ClubTrainerInvitation />} />
            </Route>
            <Route path="*" element={<NotFound />} />
            </Routes>
            <CookieConsentBanner />
            </AuthProvider>
          </BrowserRouter>
        </TooltipProvider>
      </CookieConsentProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
