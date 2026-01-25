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
  FileText,
  Trophy,
  ChevronDown
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NavItem {
  key: string;
  path: string;
  icon: React.ElementType;
}

interface NavGroup {
  key: string;
  icon: React.ElementType;
  items: NavItem[];
}

const standaloneItems: NavItem[] = [
  { key: "dashboard", path: "/club", icon: LayoutDashboard },
  { key: "tournaments", path: "/club/tournaments", icon: Trophy },
];

const groupedItems: NavGroup[] = [
  {
    key: "people",
    icon: Users,
    items: [
      { key: "trainers", path: "/club/trainers", icon: Users },
      { key: "players", path: "/club/players", icon: UserCircle },
    ],
  },
  {
    key: "schedule",
    icon: Calendar,
    items: [
      { key: "calendar", path: "/club/calendar", icon: Calendar },
      { key: "lessons", path: "/club/lessons", icon: BookOpen },
    ],
  },
  {
    key: "registration",
    icon: CalendarDays,
    items: [
      { key: "cycles", path: "/club/cycles", icon: CalendarDays },
      { key: "intakeRequests", path: "/club/intake-requests", icon: FileText },
    ],
  },
  {
    key: "club",
    icon: Building2,
    items: [
      { key: "profile", path: "/club/profile", icon: Building2 },
      { key: "subscription", path: "/club/subscription", icon: CreditCard },
      { key: "settings", path: "/club/settings", icon: Settings },
    ],
  },
];

export function ClubNavigation() {
  const { t } = useTranslation("club");
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;
  const isGroupActive = (items: NavItem[]) => items.some((item) => isActive(item.path));

  return (
    <nav className="flex items-center gap-1 overflow-x-auto pb-2 scrollbar-hide">
      {/* Dashboard - standalone */}
      <Button
        variant={isActive("/club") ? "secondary" : "ghost"}
        size="sm"
        onClick={() => navigate("/club")}
        className={cn(
          "flex items-center gap-2 whitespace-nowrap",
          isActive("/club") && "bg-secondary"
        )}
      >
        <LayoutDashboard className="h-4 w-4" />
        <span className="hidden sm:inline">{t("nav.dashboard")}</span>
      </Button>

      {/* Grouped dropdowns */}
      {groupedItems.map((group) => {
        const GroupIcon = group.icon;
        const groupIsActive = isGroupActive(group.items);

        return (
          <DropdownMenu key={group.key}>
            <DropdownMenuTrigger asChild>
              <Button
                variant={groupIsActive ? "secondary" : "ghost"}
                size="sm"
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap",
                  groupIsActive && "bg-secondary"
                )}
              >
                <GroupIcon className="h-4 w-4" />
                <span className="hidden sm:inline">{t(`nav.${group.key}`)}</span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={8} className="bg-popover z-50 min-w-[160px]">
              {group.items.map((item) => {
                const ItemIcon = item.icon;
                return (
                  <DropdownMenuItem
                    key={item.key}
                    onClick={() => navigate(item.path)}
                    className={cn(
                      "flex items-center gap-2 cursor-pointer",
                      isActive(item.path) && "bg-accent"
                    )}
                  >
                    <ItemIcon className="h-4 w-4" />
                    <span>{t(`nav.${item.key}`)}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}

      {/* Tournaments - standalone */}
      <Button
        variant={isActive("/club/tournaments") ? "secondary" : "ghost"}
        size="sm"
        onClick={() => navigate("/club/tournaments")}
        className={cn(
          "flex items-center gap-2 whitespace-nowrap",
          isActive("/club/tournaments") && "bg-secondary"
        )}
      >
        <Trophy className="h-4 w-4" />
        <span className="hidden sm:inline">{t("nav.tournaments")}</span>
      </Button>
    </nav>
  );
}
