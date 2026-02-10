import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NavLink } from "@/components/NavLink";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProfileSwitcher } from "@/components/ProfileSwitcher";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  LayoutDashboard,
  Calendar,
  Users,
  User,
  Bell,
  CalendarSync,
  ChevronRight,
  LogOut,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { signOut } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";

export function PlayerSidebar() {
  const { t } = useTranslation("player");
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const { profile } = useAuth();
  const { toast } = useToast();

  const [accountOpen, setAccountOpen] = useState(
    location.pathname.startsWith("/app/player/settings")
  );

  const handleLogout = async () => {
    const { error } = await signOut();
    if (error) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } else {
      navigate("/app/auth");
    }
  };

  const isActive = (path: string) => location.pathname.startsWith(`/app${path}`);

  const initials =
    profile?.full_name
      ?.split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase() || "P";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b">
        {!collapsed && (
          <div className="px-3 pt-3 pb-1">
            <Logo className="h-6" variant="dark" />
          </div>
        )}
        <div
          className={cn(
            "flex px-2 py-2",
            collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
          )}
        >
          <div
            className={cn(
              "flex items-center",
              collapsed ? "justify-center" : "gap-2"
            )}
          >
            <Avatar className="h-8 w-8">
              <AvatarImage src={profile?.avatar_url || undefined} />
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="flex flex-col">
                <span className="font-semibold text-sm truncate max-w-[140px]">
                  {profile?.full_name || "Player"}
                </span>
                <Badge
                  variant="secondary"
                  className="w-fit text-[10px] px-1.5 py-0 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                >
                  {t("badge")}
                </Badge>
              </div>
            )}
          </div>
          {!collapsed ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={toggleSidebar}
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={toggleSidebar}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {/* Dashboard */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.dashboard")}>
                  <NavLink
                    to="/app/player"
                    end
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                    data-testid="nav-player-dashboard"
                  >
                    <LayoutDashboard className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.dashboard")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Bookings */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.bookings")}>
                  <NavLink
                    to="/app/player/bookings"
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                    data-testid="nav-player-bookings"
                  >
                    <Calendar className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.bookings")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* My Profile */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.profile", "My Profile")}>
                  <NavLink
                    to="/app/player/profile"
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                  >
                    <User className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.profile", "My Profile")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Following */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.following")}>
                  <NavLink
                    to="/app/player/following"
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                  >
                    <Users className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.following")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Account Group */}
              <Collapsible
                open={accountOpen && !collapsed}
                onOpenChange={setAccountOpen}
                className="group/account"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      tooltip={t("nav.account")}
                      className={
                        isActive("/player/settings")
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : ""
                      }
                    >
                      <User className="h-4 w-4" />
                      {!collapsed && (
                        <>
                          <span className="flex-1">{t("nav.account")}</span>
                          <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]/account:rotate-90" />
                        </>
                      )}
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                    to="/app/player/settings"
                    end
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.settings")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/player/settings/notifications"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.notifications")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/player/settings/calendar"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.calendarSync")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <div
          className={cn(
            "flex p-2",
            collapsed ? "flex-col items-center gap-2" : "flex-col gap-2"
          )}
        >
          <ProfileSwitcher context="player" collapsed={collapsed} />

          <div
            className={cn(
              "flex",
              collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
            )}
          >
            <LanguageSwitcher />
            <ThemeToggle />
            <Button
              variant="ghost"
              size={collapsed ? "icon" : "sm"}
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4" />
              {!collapsed && <span className="ml-2">Logout</span>}
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
