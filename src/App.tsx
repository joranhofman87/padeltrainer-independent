import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import SelectRole from "./pages/SelectRole";
import PlayerDashboard from "./pages/PlayerDashboard";
import TrainerDashboard from "./pages/TrainerDashboard";
import Trainers from "./pages/Trainers";
import TrainerProfile from "./pages/TrainerProfile";
import EditProfile from "./pages/EditProfile";
import ManageLessons from "./pages/ManageLessons";
import ManageAvailability from "./pages/ManageAvailability";
import PlayerBookings from "./pages/PlayerBookings";
import TrainerBookings from "./pages/TrainerBookings";
import BookLesson from "./pages/BookLesson";
import Checkout from "./pages/Checkout";
import TrainerEarnings from "./pages/TrainerEarnings";
import TrainerSubscription from "./pages/TrainerSubscription";
import TrainerAnalytics from "./pages/TrainerAnalytics";
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
            <Route path="/" element={<Index />} />
            <Route path="/auth" element={<Auth />} />
            <Route path="/select-role" element={<SelectRole />} />
            <Route path="/player" element={<PlayerDashboard />} />
            <Route path="/trainer" element={<TrainerDashboard />} />
            <Route path="/trainers" element={<Trainers />} />
            <Route path="/trainer/:trainerId" element={<TrainerProfile />} />
            <Route path="/profile/edit" element={<EditProfile />} />
            <Route path="/lessons" element={<ManageLessons />} />
            <Route path="/availability" element={<ManageAvailability />} />
            <Route path="/bookings" element={<PlayerBookings />} />
            <Route path="/trainer-bookings" element={<TrainerBookings />} />
            <Route path="/book/:trainerId" element={<BookLesson />} />
            <Route path="/checkout" element={<Checkout />} />
            <Route path="/earnings" element={<TrainerEarnings />} />
            <Route path="/subscription" element={<TrainerSubscription />} />
            <Route path="/analytics" element={<TrainerAnalytics />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
