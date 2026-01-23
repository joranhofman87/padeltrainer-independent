import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { 
  LayoutDashboard, 
  Users, 
  UserCircle, 
  Calendar, 
  Building2, 
  Settings,
  CreditCard,
  BookOpen,
  CalendarDays,
  FileText
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const navItems = [
  { key: "dashboard", path: "/club", icon: LayoutDashboard },
  { key: "trainers", path: "/club/trainers", icon: Users },
  { key: "players", path: "/club/players", icon: UserCircle },
  { key: "calendar", path: "/club/calendar", icon: Calendar },
  { key: "lessons", path: "/club/lessons", icon: BookOpen },
  { key: "cycles", path: "/club/cycles", icon: CalendarDays },
  { key: "intakeRequests", path: "/club/intake-requests", icon: FileText },
  { key: "profile", path: "/club/profile", icon: Building2 },
  { key: "subscription", path: "/club/subscription", icon: CreditCard },
  { key: "settings", path: "/club/settings", icon: Settings },
];

export function ClubNavigation() {
  const { t } = useTranslation("club");
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="flex items-center gap-1 overflow-x-auto pb-2 scrollbar-hide">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = location.pathname === item.path;

        return (
          <Button
            key={item.key}
            variant={isActive ? "secondary" : "ghost"}
            size="sm"
            onClick={() => navigate(item.path)}
            className={cn(
              "flex items-center gap-2 whitespace-nowrap",
              isActive && "bg-secondary"
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{t(`nav.${item.key}`)}</span>
          </Button>
        );
      })}
    </nav>
  );
}
