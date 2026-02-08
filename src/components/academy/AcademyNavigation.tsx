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
  { key: "dashboard", path: "/app/academy", icon: LayoutDashboard },
  { key: "calendar", path: "/app/academy/calendar", icon: Calendar },
  { key: "cycles", path: "/app/academy/cycles", icon: CalendarDays },
];

const groupedItems: NavGroup[] = [
  {
    key: "team",
    icon: Users,
    items: [
      { key: "trainers", path: "/app/academy/trainers", icon: Users },
      { key: "players", path: "/app/academy/players", icon: Users },
    ],
  },
  {
    key: "academy",
    icon: GraduationCap,
    items: [
      { key: "profile", path: "/app/academy/profile", icon: GraduationCap },
      { key: "locations", path: "/app/academy/locations", icon: MapPin },
      { key: "earnings", path: "/app/academy/earnings", icon: DollarSign },
      { key: "subscription", path: "/app/academy/subscription", icon: CreditCard },
      { key: "settings", path: "/app/academy/settings", icon: Settings },
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
      {/* Standalone items */}
      {standaloneItems.map((item) => {
        const ItemIcon = item.icon;
        return (
          <Button
            key={item.key}
            variant={isActive(item.path) ? "secondary" : "ghost"}
            size="sm"
            onClick={() => navigate(item.path)}
            className={cn(
              "flex items-center gap-2 whitespace-nowrap",
              isActive(item.path) && "bg-secondary"
            )}
          >
            <ItemIcon className="h-4 w-4" />
            <span className="hidden sm:inline">{t(`nav.${item.key}`)}</span>
          </Button>
        );
      })}

      {/* Grouped dropdowns - only show dropdown if more than 1 item */}
      {groupedItems.map((group) => {
        const GroupIcon = group.icon;
        const groupIsActive = isGroupActive(group.items);

        // If only one item, render as standalone button
        if (group.items.length === 1) {
          const item = group.items[0];
          const ItemIcon = item.icon;
          return (
            <Button
              key={group.key}
              variant={isActive(item.path) ? "secondary" : "ghost"}
              size="sm"
              onClick={() => navigate(item.path)}
              className={cn(
                "flex items-center gap-2 whitespace-nowrap",
                isActive(item.path) && "bg-secondary"
              )}
            >
              <ItemIcon className="h-4 w-4" />
              <span className="hidden sm:inline">{t(`nav.${item.key}`)}</span>
            </Button>
          );
        }

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
