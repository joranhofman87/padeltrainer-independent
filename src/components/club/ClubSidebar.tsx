import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NavLink } from "@/components/NavLink";
import {
  appNavLinkActive,
  appNavLinkBase,
  appNavLinkInactive,
  appSidebarContentClass,
  appSidebarFooterClass,
  appSidebarGhostButtonClass,
  appSidebarHeaderClass,
  appSidebarShellClass,
} from "@/components/ui/appSidebarStyles";
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
  Gift,
  X,
} from "lucide-react";
import { showReferralWidget } from "@/components/ReferralWidget";
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
  isExpired?: boolean;
}

export function ClubSidebar({ club, onClubChange, isExpired = false }: ClubSidebarProps) {
  const { t, i18n } = useTranslation("club");
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar();

  const closeMobileDrawer = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const collapsed = state === "collapsed";
  const { toast } = useToast();

  const [peopleOpen, setPeopleOpen] = useState(
    location.pathname.includes("/app/club/trainers") ||
    location.pathname.includes("/app/club/players")
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
    <Sidebar collapsible="icon" className={appSidebarShellClass} data-testid="club-sidebar-shell">
      <SidebarHeader className={appSidebarHeaderClass}>
        <div
          className={cn(
            "flex items-center gap-2 px-2 pt-2",
            collapsed ? "flex-col justify-center" : "justify-between",
          )}
        >
          <div className={cn("flex min-w-0 items-center", collapsed ? "justify-center" : "gap-2")}>
            <Logo className="h-5 w-auto shrink-0" />
            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold tracking-tight text-slate-800">
                  padeltrainer
                </p>
                <p className="truncate text-[11px] text-slate-500">
                  {club?.location?.name || "Club"}
                </p>
              </div>
            )}
          </div>
          {isMobile ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-slate-600"
              onClick={() => setOpenMobile(false)}
              aria-label={t("nav.closeMenu", "Close menu")}
              data-testid="club-mobile-menu-close"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-slate-600"
              onClick={toggleSidebar}
              aria-label={
                collapsed
                  ? t("nav.expandSidebar", "Expand sidebar")
                  : t("nav.collapseSidebar", "Collapse sidebar")
              }
            >
              {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
          )}
        </div>
        {!collapsed && club && (
          <div className="flex items-center gap-2 px-2 pb-2">
            {club.logo_url ? (
              <Avatar className="h-8 w-8">
                <AvatarImage src={club.logo_url} />
                <AvatarFallback className="bg-slate-100 text-xs text-slate-700">{initials}</AvatarFallback>
              </Avatar>
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100">
                <Building2 className="h-4 w-4 text-slate-500" />
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-900">
                {club.location?.name || "Club"}
              </p>
              {club.is_verified ? (
                <Badge
                  variant="secondary"
                  className="mt-0.5 w-fit text-[10px] px-1.5 py-0 bg-green-500/10 text-green-600 dark:text-green-400"
                >
                  <CheckCircle className="h-2.5 w-2.5 mr-0.5" />
                  {t("common:verified")}
                </Badge>
              ) : (
                <Badge variant="secondary" className="mt-0.5 w-fit text-[10px] px-1.5 py-0">
                  {t("badge")}
                </Badge>
              )}
            </div>
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className={cn(appSidebarContentClass, isExpired && "relative")}>
        {isExpired && (
          <div className="absolute inset-0 z-10" />
        )}
        <SidebarGroup>
          <SidebarGroupContent className={cn(isExpired && "opacity-50 pointer-events-none")}>
            <SidebarMenu className="gap-0.5 px-1">
              {/* Dashboard */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.dashboard")}>
                  <NavLink
                    to="/app/club"
                    end
                    className={cn(appNavLinkBase, appNavLinkInactive)}
                    activeClassName={appNavLinkActive}
                    onClick={closeMobileDrawer}
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
                    className={cn(appNavLinkBase, appNavLinkInactive)}
                    activeClassName={appNavLinkActive}
                    onClick={closeMobileDrawer}
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
                        ? cn(appNavLinkBase, appNavLinkActive)
                        : cn(appNavLinkBase, appNavLinkInactive)}
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
                            className={cn(appNavLinkBase, appNavLinkInactive)}
                            activeClassName={appNavLinkActive}
                            onClick={closeMobileDrawer}
                          >
                            {t("nav.trainers")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/club/players"
                            className={cn(appNavLinkBase, appNavLinkInactive)}
                            activeClassName={appNavLinkActive}
                            onClick={closeMobileDrawer}
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
                    className={cn(appNavLinkBase, appNavLinkInactive)}
                    activeClassName={appNavLinkActive}
                    onClick={closeMobileDrawer}
                  >
                    <Calendar className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.calendar")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Registrations */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.registrations", "Registrations")}>
                  <NavLink
                    to="/app/club/registrations"
                    className={cn(appNavLinkBase, appNavLinkInactive)}
                    activeClassName={appNavLinkActive}
                    onClick={closeMobileDrawer}
                  >
                    <BookOpen className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.registrations", "Registrations")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Tournaments */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.tournaments")}>
                  <NavLink
                    to="/app/club/tournaments"
                    className={cn(appNavLinkBase, appNavLinkInactive)}
                    activeClassName={appNavLinkActive}
                    onClick={closeMobileDrawer}
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
                        ? cn(appNavLinkBase, appNavLinkActive)
                        : cn(appNavLinkBase, appNavLinkInactive)}
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
                            className={cn(appNavLinkBase, appNavLinkInactive)}
                            activeClassName={appNavLinkActive}
                            onClick={closeMobileDrawer}
                          >
                            {t("nav.subscription")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/club/settings"
                            className={cn(appNavLinkBase, appNavLinkInactive)}
                            activeClassName={appNavLinkActive}
                            onClick={closeMobileDrawer}
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

      <SidebarFooter className={appSidebarFooterClass}>
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
                cn("w-full justify-start", appSidebarGhostButtonClass)
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
              onClick={showReferralWidget}
              aria-label={t("nav.referFriends", "Refer friends")}
            >
              <Gift className="h-4 w-4 text-primary" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              className="h-9 w-9"
              aria-label={t("nav.logout", "Log out")}
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
