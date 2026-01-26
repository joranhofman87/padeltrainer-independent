import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { 
  LayoutDashboard, 
  Calendar, 
  Users,
  User,
  Bell,
  CalendarSync,
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

const groupedItems: NavGroup[] = [
  {
    key: "account",
    icon: User,
    items: [
      { key: "editProfile", path: "/player/profile", icon: User },
      { key: "notifications", path: "/player/settings/notifications", icon: Bell },
      { key: "calendarSync", path: "/player/settings/calendar", icon: CalendarSync },
    ],
  },
];

export function PlayerNavigation() {
  const { t } = useTranslation("player");
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) => location.pathname === path;
  const isGroupActive = (items: NavItem[]) => items.some((item) => isActive(item.path));

  return (
    <nav className="flex items-center gap-1 overflow-x-auto pb-2 scrollbar-hide">
      {/* Dashboard - standalone */}
      <Button
        variant={isActive("/player") ? "secondary" : "ghost"}
        size="sm"
        onClick={() => navigate("/player")}
        className={cn(
          "flex items-center gap-2 whitespace-nowrap",
          isActive("/player") && "bg-secondary"
        )}
      >
        <LayoutDashboard className="h-4 w-4" />
        <span className="hidden sm:inline">{t("nav.dashboard")}</span>
      </Button>

      {/* Bookings - standalone */}
      <Button
        variant={isActive("/player/bookings") ? "secondary" : "ghost"}
        size="sm"
        onClick={() => navigate("/player/bookings")}
        className={cn(
          "flex items-center gap-2 whitespace-nowrap",
          isActive("/player/bookings") && "bg-secondary"
        )}
      >
        <Calendar className="h-4 w-4" />
        <span className="hidden sm:inline">{t("nav.bookings")}</span>
      </Button>

      {/* Following - standalone */}
      <Button
        variant={isActive("/player/following") ? "secondary" : "ghost"}
        size="sm"
        onClick={() => navigate("/player/following")}
        className={cn(
          "flex items-center gap-2 whitespace-nowrap",
          isActive("/player/following") && "bg-secondary"
        )}
      >
        <Users className="h-4 w-4" />
        <span className="hidden sm:inline">{t("nav.following")}</span>
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
