import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { ThemeProvider } from "next-themes";
import "@/i18n";

// Marketing pages
import Home from "./pages/marketing/Home";
import Pricing from "./pages/marketing/Pricing";
import About from "./pages/marketing/About";
import Blog from "./pages/marketing/Blog";
import BlogPost from "./pages/marketing/BlogPost";
import Privacy from "./pages/marketing/Privacy";
import Terms from "./pages/marketing/Terms";

// App pages
import Auth from "./pages/Auth";
import SelectRole from "./pages/SelectRole";
import PlayerSignup from "./pages/PlayerSignup";
import TrainerSignup from "./pages/TrainerSignup";
import Onboarding from "./pages/Onboarding";
import PlayerDashboard from "./pages/PlayerDashboard";
import TrainerDashboard from "./pages/TrainerDashboard";
import Trainers from "./pages/Trainers";
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
import NotificationSettings from "./pages/NotificationSettings";
import CalendarSettings from "./pages/CalendarSettings";
import FollowingList from "./pages/FollowingList";
import AdminDashboard from "./pages/AdminDashboard";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AuthProvider>
          <Routes>
            {/* Marketing routes */}
            <Route path="/" element={<Home />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/about" element={<About />} />
            <Route path="/blog" element={<Blog />} />
            <Route path="/blog/:slug" element={<BlogPost />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            
            {/* App routes */}
            <Route path="/auth" element={<Auth />} />
            <Route path="/signup/player" element={<PlayerSignup />} />
            <Route path="/signup/trainer" element={<TrainerSignup />} />
            <Route path="/onboarding/:role" element={<Onboarding />} />
            <Route path="/select-role" element={<SelectRole />} />
            <Route path="/player" element={<PlayerDashboard />} />
            <Route path="/trainer" element={<TrainerDashboard />} />
            <Route path="/trainers" element={<Trainers />} />
            <Route path="/trainer/:trainerId" element={<TrainerProfile />} />
            <Route path="/profile/edit" element={<EditProfile />} />
            <Route path="/lessons" element={<ManageLessons />} />
            <Route path="/availability" element={<TrainerCalendar />} />
            <Route path="/schedule" element={<TrainerCalendar />} />
            <Route path="/bookings" element={<PlayerBookings />} />
            <Route path="/trainer-bookings" element={<TrainerBookings />} />
            <Route path="/book/:trainerId" element={<BookLesson />} />
            
            <Route path="/booking-success" element={<BookingSuccess />} />
            <Route path="/earnings" element={<TrainerEarnings />} />
            <Route path="/subscription" element={<TrainerSubscription />} />
            <Route path="/analytics" element={<TrainerAnalytics />} />
            <Route path="/trainer/calendar" element={<TrainerCalendar />} />
            <Route path="/trainer/players" element={<TrainerPlayers />} />
            <Route path="/trainer/cyclus" element={<TrainerCyclus />} />
            <Route path="/settings/notifications" element={<NotificationSettings />} />
            <Route path="/settings/calendar" element={<CalendarSettings />} />
            <Route path="/player/following" element={<FollowingList />} />
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="*" element={<NotFound />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
