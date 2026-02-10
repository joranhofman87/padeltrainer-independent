import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NavLink } from "@/components/NavLink";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ProfileSwitcher } from "@/components/ProfileSwitcher";
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
  Users,
  UserCircle,
  Calendar,
  BookOpen,
  Building2,
  Settings,
  CreditCard,
  ChevronRight,
  LogOut,
  ExternalLink,
  PanelLeftClose,
  PanelLeft,
  CheckCircle,
  Trophy,
} from "lucide-react";
import { signOut } from "@/lib/auth";
import { getMarketingUrl } from "@/lib/domains";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";
import type { ClubProfile } from "@/lib/club";
import type { Location } from "@/lib/locations";

interface ClubWithLocation extends ClubProfile {
  role: string;
  location: Location;
}

interface ClubSidebarProps {
  club: ClubWithLocation | null;
  onClubChange?: (club: ClubWithLocation) => void;
}

export function ClubSidebar({ club, onClubChange }: ClubSidebarProps) {
  const { t, i18n } = useTranslation("club");
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const { toast } = useToast();

  const [peopleOpen, setPeopleOpen] = useState(
    location.pathname.includes("/app/club/trainers") ||
    location.pathname.includes("/app/club/players")
  );
  const [scheduleOpen, setScheduleOpen] = useState(
    location.pathname.includes("/app/club/calendar")
  );
  const [businessOpen, setBusinessOpen] = useState(
    location.pathname.includes("/app/club/subscription") ||
    location.pathname.includes("/app/club/settings")
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

  const handleViewPublicProfile = () => {
    if (club?.location?.slug) {
      const lang = i18n.language === "en" || i18n.language === "nl" ? i18n.language : "nl";
      window.open(getMarketingUrl(`locations/${club.location.slug}`, lang), "_blank");
    }
  };

  const isActive = (path: string) => location.pathname.startsWith(path);

  const initials = club?.location?.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "C";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b">
        {!collapsed && (
          <div className="px-3 pt-3 pb-1">
            <Logo className="h-6" variant="dark" />
          </div>
        )}
        <div className={cn(
          "flex px-2 py-2",
          collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
        )}>
          <div className={cn(
            "flex items-center",
            collapsed ? "justify-center" : "gap-2"
          )}>
            {club?.logo_url ? (
              <Avatar className="h-8 w-8">
                <AvatarImage src={club.logo_url} />
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
            ) : (
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                <Building2 className="h-4 w-4 text-primary" />
              </div>
            )}
            {!collapsed && (
              <div className="flex flex-col min-w-0">
                <span className="font-semibold text-sm truncate max-w-[140px]">
                  {club?.location?.name || "Club"}
                </span>
                <div className="flex items-center gap-1">
                  {club?.is_verified ? (
                    <Badge
                      variant="secondary"
                      className="w-fit text-[10px] px-1.5 py-0 bg-green-500/10 text-green-600 dark:text-green-400"
                    >
                      <CheckCircle className="h-2.5 w-2.5 mr-0.5" />
                      {t("common:verified")}
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="w-fit text-[10px] px-1.5 py-0"
                    >
                      {t("badge")}
                    </Badge>
                  )}
                </div>
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
                    to="/app/club"
                    end
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                  >
                    <LayoutDashboard className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.dashboard")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Profile */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.profile")}>
                  <NavLink
                    to="/app/club/profile"
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                  >
                    <Building2 className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.profile")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* People Group */}
              <Collapsible
                open={peopleOpen && !collapsed}
                onOpenChange={setPeopleOpen}
                className="group/people"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      tooltip={t("nav.people")}
                      className={isActive("/app/club/trainers") || isActive("/app/club/players")
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : ""}
                    >
                      <Users className="h-4 w-4" />
                      {!collapsed && (
                        <>
                          <span className="flex-1">{t("nav.people")}</span>
                          <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]/people:rotate-90" />
                        </>
                      )}
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/club/trainers"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.trainers")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/club/players"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.players")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>

              {/* Calendar */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.calendar")}>
                  <NavLink
                    to="/app/club/calendar"
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                  >
                    <Calendar className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.calendar")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Tournaments */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.tournaments")}>
                  <NavLink
                    to="/app/club/tournaments"
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                  >
                    <Trophy className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.tournaments")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Business Group */}
              <Collapsible
                open={businessOpen && !collapsed}
                onOpenChange={setBusinessOpen}
                className="group/business"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      tooltip={t("nav.business")}
                      className={isActive("/app/club/subscription") || isActive("/app/club/settings")
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : ""}
                    >
                      <CreditCard className="h-4 w-4" />
                      {!collapsed && (
                        <>
                          <span className="flex-1">{t("nav.business")}</span>
                          <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]/business:rotate-90" />
                        </>
                      )}
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/club/subscription"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.subscription")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/club/settings"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            <Settings className="h-4 w-4" />
                            {t("nav.settings")}
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
        <div className={cn(
          "flex p-2",
          collapsed ? "flex-col items-center gap-2" : "flex-col gap-2"
        )}>
          <ProfileSwitcher
            context="club"
            activeClubId={club?.id}
            onClubChange={onClubChange}
            collapsed={collapsed}
          />

          {/* View Public Profile */}
          {club?.location?.slug && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleViewPublicProfile}
              className={cn(
                "w-full",
                collapsed && "w-auto px-2",
                "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <ExternalLink className="h-4 w-4" />
              {!collapsed && <span className="ml-2">{t("dashboard.viewPublicProfile")}</span>}
            </Button>
          )}

          {/* Theme and Logout */}
          <div className={cn(
            "flex",
            collapsed ? "flex-col items-center gap-2" : "items-center gap-2"
          )}>
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              className="h-9 w-9"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
