import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { 
  LayoutDashboard, 
  Users, 
  MapPin, 
  Calendar, 
  GraduationCap, 
  Settings,
  CreditCard,
  CalendarDays,
  FileText,
  ChevronDown,
  DollarSign
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
  { key: "dashboard", path: "/academy", icon: LayoutDashboard },
];

const groupedItems: NavGroup[] = [
  {
    key: "team",
    icon: Users,
    items: [
      { key: "trainers", path: "/academy/trainers", icon: Users },
      { key: "players", path: "/academy/players", icon: Users },
    ],
  },
  {
    key: "schedule",
    icon: Calendar,
    items: [
      { key: "calendar", path: "/academy/calendar", icon: Calendar },
      { key: "cycles", path: "/academy/cycles", icon: CalendarDays },
    ],
  },
  {
    key: "academy",
    icon: GraduationCap,
    items: [
      { key: "profile", path: "/academy/profile", icon: GraduationCap },
      { key: "locations", path: "/academy/locations", icon: MapPin },
      { key: "earnings", path: "/academy/earnings", icon: DollarSign },
      { key: "subscription", path: "/academy/subscription", icon: CreditCard },
      { key: "settings", path: "/academy/settings", icon: Settings },
    ],
  },
];

export function AcademyNavigation() {
  const { t } = useTranslation("academy");
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;
  const isGroupActive = (items: NavItem[]) => items.some((item) => isActive(item.path));

  return (
    <nav className="flex items-center gap-1 overflow-x-auto pb-2 scrollbar-hide">
      {/* Dashboard - standalone */}
      <Button
        variant={isActive("/academy") ? "secondary" : "ghost"}
        size="sm"
        onClick={() => navigate("/academy")}
        className={cn(
          "flex items-center gap-2 whitespace-nowrap",
          isActive("/academy") && "bg-secondary"
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
