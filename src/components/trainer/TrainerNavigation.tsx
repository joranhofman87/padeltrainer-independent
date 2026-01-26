import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { 
  LayoutDashboard, 
  Calendar, 
  CalendarDays,
  Users,
  FileText,
  Briefcase,
  CreditCard,
  Settings,
  BarChart3,
  ChevronDown,
  Clock
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

const groupedItems: NavGroup[] = [
  {
    key: "schedule",
    icon: Calendar,
    items: [
      { key: "calendar", path: "/trainer/calendar", icon: Calendar },
      { key: "openSlots", path: "/trainer/open-slots", icon: Clock },
    ],
  },
  {
    key: "players",
    icon: Users,
    items: [
      { key: "myPlayers", path: "/trainer/players", icon: Users },
      { key: "intakeRequests", path: "/trainer/intake-requests", icon: FileText },
    ],
  },
  {
    key: "registration",
    icon: CalendarDays,
    items: [
      { key: "cycles", path: "/trainer/cycles", icon: CalendarDays },
      { key: "cyclus", path: "/trainer/cyclus", icon: Calendar },
    ],
  },
  {
    key: "business",
    icon: Briefcase,
    items: [
      { key: "earnings", path: "/earnings", icon: CreditCard },
      { key: "subscription", path: "/subscription", icon: CreditCard },
      { key: "analytics", path: "/analytics", icon: BarChart3 },
      { key: "settings", path: "/trainer/settings", icon: Settings },
    ],
  },
];

export function TrainerNavigation() {
  const { t } = useTranslation("trainer");
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;
  const isGroupActive = (items: NavItem[]) => items.some((item) => isActive(item.path));

  return (
    <nav className="flex items-center gap-1 overflow-x-auto pb-2 scrollbar-hide">
      {/* Dashboard - standalone */}
      <Button
        variant={isActive("/trainer") ? "secondary" : "ghost"}
        size="sm"
        onClick={() => navigate("/trainer")}
        className={cn(
          "flex items-center gap-2 whitespace-nowrap",
          isActive("/trainer") && "bg-secondary"
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
    </nav>
  );
}
