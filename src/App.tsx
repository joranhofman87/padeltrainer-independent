import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";

// Marketing pages
import Home from "./pages/marketing/Home";
import Pricing from "./pages/marketing/Pricing";
import About from "./pages/marketing/About";
import Blog from "./pages/marketing/Blog";
import BlogPost from "./pages/marketing/BlogPost";

// App pages
import Auth from "./pages/Auth";
import SelectRole from "./pages/SelectRole";
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
import Checkout from "./pages/Checkout";
import BookingSuccess from "./pages/BookingSuccess";
import TrainerEarnings from "./pages/TrainerEarnings";
import TrainerSubscription from "./pages/TrainerSubscription";
import TrainerAnalytics from "./pages/TrainerAnalytics";
import NotificationSettings from "./pages/NotificationSettings";
import CalendarSettings from "./pages/CalendarSettings";
import FollowingList from "./pages/FollowingList";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
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
            
            {/* App routes */}
            <Route path="/auth" element={<Auth />} />
            <Route path="/select-role" element={<SelectRole />} />
            <Route path="/player" element={<PlayerDashboard />} />
            <Route path="/trainer" element={<TrainerDashboard />} />
            <Route path="/trainers" element={<Trainers />} />
            <Route path="/trainer/:trainerId" element={<TrainerProfile />} />
            <Route path="/profile/edit" element={<EditProfile />} />
            <Route path="/lessons" element={<ManageLessons />} />
            <Route path="/availability" element={<ManageAvailability />} />
            <Route path="/schedule" element={<ManageSchedule />} />
            <Route path="/bookings" element={<PlayerBookings />} />
            <Route path="/trainer-bookings" element={<TrainerBookings />} />
            <Route path="/book/:trainerId" element={<BookLesson />} />
            <Route path="/checkout" element={<Checkout />} />
            <Route path="/booking-success" element={<BookingSuccess />} />
            <Route path="/earnings" element={<TrainerEarnings />} />
            <Route path="/subscription" element={<TrainerSubscription />} />
            <Route path="/analytics" element={<TrainerAnalytics />} />
            <Route path="/settings/notifications" element={<NotificationSettings />} />
            <Route path="/settings/calendar" element={<CalendarSettings />} />
            <Route path="/player/following" element={<FollowingList />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
