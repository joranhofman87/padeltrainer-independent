import { useState, useEffect } from "react";
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
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
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
  User,
  Calendar,
  CalendarClock,
  CalendarDays,
  Settings,
  CreditCard,
  ChevronRight,
  LogOut,
  ExternalLink,
  PanelLeftClose,
  PanelLeft,
  Gift,
  X,
} from "lucide-react";
import { showReferralWidget } from "@/components/ReferralWidget";
import { useAuth } from "@/hooks/useAuth";
import { signOut, getTrainerProfile } from "@/lib/auth";
import { getTrainerAcademy } from "@/lib/academy";
import { getMarketingUrl } from "@/lib/domains";
import { useToast } from "@/hooks/use-toast";
import { getFriendlyErrorMessage } from "@/lib/friendlyError";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";

interface TrainerSidebarProps {
  isExpired?: boolean;
}

export function TrainerSidebar({ isExpired = false }: TrainerSidebarProps) {
  const { t, i18n } = useTranslation("trainer");
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar();
  const collapsed = state === "collapsed";
  const { user, profile } = useAuth();
  const { toast } = useToast();

  const [trainerProfileId, setTrainerProfileId] = useState<string | null>(null);
  const [trainerSlug, setTrainerSlug] = useState<string | null>(null);
  
  const [hasAcademy, setHasAcademy] = useState<boolean>(false);

  // Track which groups are open
  const [scheduleOpen, setScheduleOpen] = useState(
    location.pathname.startsWith("/app/trainer/calendar") ||
    location.pathname.startsWith("/app/trainer/open-slots") ||
    location.pathname.startsWith("/app/trainer/schedule-overview")
  );
  const [registrationOpen, setRegistrationOpen] = useState(
    location.pathname.startsWith("/app/trainer/cycles") ||
    location.pathname.startsWith("/app/trainer/intake-requests") ||
    location.pathname.startsWith("/app/trainer/waiting-list")
  );
  
  const [businessOpen, setBusinessOpen] = useState(
    location.pathname.startsWith("/app/trainer/settings") ||
    location.pathname.startsWith("/app/trainer/subscription") ||
    location.pathname.startsWith("/app/trainer/earnings")
  );

  const closeMobileDrawer = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  // Fetch trainer profile, clubs, and academy status
  useEffect(() => {
    const fetchTrainerData = async () => {
      if (!user) return;

      const trainerProfile = await getTrainerProfile(user.id);
      if (trainerProfile) {
        setTrainerProfileId(trainerProfile.id);
        setTrainerSlug(trainerProfile.slug);

        const academy = await getTrainerAcademy(trainerProfile.id);
        setHasAcademy(!!academy);
      }
    };

    fetchTrainerData();
  }, [user]);

  const handleLogout = async () => {
    const { error } = await signOut();
    if (error) {
      toast({
        title: "Error",
        description: getFriendlyErrorMessage(error, t("logoutError", "Could not sign out. Please try again.")),
        variant: "destructive",
      });
    } else {
      navigate("/app/auth");
    }
  };

  const handleViewPublicProfile = () => {
    if (trainerProfileId) {
      const lang = i18n.language === "en" || i18n.language === "nl" ? i18n.language : "nl";
      window.open(getMarketingUrl(`trainer/${trainerSlug || trainerProfileId}`, lang), "_blank");
    }
  };

  const isActive = (path: string, exact = false) => {
    if (exact) return location.pathname === path;
    return location.pathname.startsWith(path);
  };

  const initials = profile?.full_name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase() || "T";

  return (
    <Sidebar collapsible="icon" className={appSidebarShellClass} data-testid="trainer-sidebar-shell">
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
                  {profile?.full_name || t("badge")}
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
              data-testid="trainer-mobile-menu-close"
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
        {!collapsed && (
          <div className="flex items-center gap-2 px-2 pb-2">
            <Avatar className="h-8 w-8">
              <AvatarImage src={profile?.avatar_url || undefined} />
              <AvatarFallback className="bg-slate-100 text-xs text-slate-700">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-900">
                {profile?.full_name || "Trainer"}
              </p>
              <Badge
                variant="secondary"
                className="mt-0.5 w-fit text-[10px] px-1.5 py-0 bg-orange-500/10 text-orange-600 dark:text-orange-400"
              >
                {t("badge")}
              </Badge>
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
              {/* My Profile */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.myProfile")}>
                  <NavLink
                    to="/app/trainer/profile"
                    className={cn(appNavLinkBase, appNavLinkInactive)}
                    activeClassName={appNavLinkActive}
                    onClick={closeMobileDrawer}
                    data-testid="nav-trainer-profile"
                  >
                    <User className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.myProfile")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* === Academy trainer: only show Schedule + Players === */}
              {hasAcademy ? (
                <>
                  {/* My Schedule - direct link */}
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip={t("nav.calendar")}>
                      <NavLink
                        to="/app/trainer/calendar"
                        className={cn(appNavLinkBase, appNavLinkInactive)}
                        activeClassName={appNavLinkActive}
                        onClick={closeMobileDrawer}
                      >
                        <Calendar className="h-4 w-4" />
                        {!collapsed && <span>{t("nav.calendar")}</span>}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>

                  {/* Agenda - day/week list */}
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip={t("nav.agenda")}>
                      <NavLink
                        to="/app/trainer/agenda"
                        className={cn(appNavLinkBase, appNavLinkInactive)}
                        activeClassName={appNavLinkActive}
                        onClick={closeMobileDrawer}
                      >
                        <CalendarClock className="h-4 w-4" />
                        {!collapsed && <span>{t("nav.agenda")}</span>}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>

                  {/* My Players */}
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip={t("nav.players")}>
                      <NavLink
                        to="/app/trainer/players"
                        className={cn(appNavLinkBase, appNavLinkInactive)}
                        activeClassName={appNavLinkActive}
                        onClick={closeMobileDrawer}
                      >
                        <Users className="h-4 w-4" />
                        {!collapsed && <span>{t("nav.players")}</span>}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </>
              ) : (
                <>
                  {/* Dashboard */}
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip={t("nav.dashboard")}>
                      <NavLink
                        to="/app/trainer"
                        end
                        className={cn(appNavLinkBase, appNavLinkInactive)}
                        activeClassName={appNavLinkActive}
                        onClick={closeMobileDrawer}
                        data-testid="nav-trainer-dashboard"
                      >
                        <LayoutDashboard className="h-4 w-4" />
                        {!collapsed && <span>{t("nav.dashboard")}</span>}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>

                  {/* Players - standalone */}
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip={t("nav.players")}>
                      <NavLink
                        to="/app/trainer/players"
                        className={cn(appNavLinkBase, appNavLinkInactive)}
                        activeClassName={appNavLinkActive}
                        onClick={closeMobileDrawer}
                      >
                        <Users className="h-4 w-4" />
                        {!collapsed && <span>{t("nav.players")}</span>}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>

                  {/* Schedule Group */}
                  <Collapsible
                    open={scheduleOpen && !collapsed}
                    onOpenChange={setScheduleOpen}
                    className="group/schedule"
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton
                          tooltip={t("nav.schedule")}
                          className={cn(
                            appNavLinkBase,
                            isActive("/app/trainer/calendar") ||
                              isActive("/app/trainer/open-slots") ||
                              isActive("/app/trainer/schedule-overview")
                              ? appNavLinkActive
                              : appNavLinkInactive,
                          )}
                        >
                          <Calendar className="h-4 w-4" />
                          {!collapsed && (
                            <>
                              <span className="flex-1">{t("nav.schedule")}</span>
                              <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]/schedule:rotate-90" />
                            </>
                          )}
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild>
                              <NavLink
                                to="/app/trainer/calendar"
                                className={cn(appNavLinkBase, appNavLinkInactive)}
                                activeClassName={appNavLinkActive}
                                onClick={closeMobileDrawer}
                              >
                                {t("nav.calendar")}
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild>
                              <NavLink
                                to="/app/trainer/open-slots"
                                className={cn(appNavLinkBase, appNavLinkInactive)}
                                activeClassName={appNavLinkActive}
                                onClick={closeMobileDrawer}
                              >
                                {t("nav.openSlots")}
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild>
                              <NavLink
                                to="/app/trainer/schedule-overview"
                                className={cn(appNavLinkBase, appNavLinkInactive)}
                                activeClassName={appNavLinkActive}
                                onClick={closeMobileDrawer}
                              >
                                {t("nav.scheduleOverview", "Overview")}
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>

                  {/* Registration Group */}
                  <Collapsible
                    open={registrationOpen && !collapsed}
                    onOpenChange={setRegistrationOpen}
                    className="group/registration"
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton
                          tooltip={t("nav.registration")}
                          className={cn(
                            appNavLinkBase,
                            isActive("/app/trainer/cycles") ||
                              isActive("/app/trainer/intake-requests") ||
                              isActive("/app/trainer/waiting-list")
                              ? appNavLinkActive
                              : appNavLinkInactive,
                          )}
                        >
                          <CalendarDays className="h-4 w-4" />
                          {!collapsed && (
                            <>
                              <span className="flex-1">{t("nav.registration")}</span>
                              <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]/registration:rotate-90" />
                            </>
                          )}
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild>
                              <NavLink
                                to="/app/trainer/cycles"
                                className={cn(appNavLinkBase, appNavLinkInactive)}
                                activeClassName={appNavLinkActive}
                                onClick={closeMobileDrawer}
                              >
                                {t("nav.registrations", "Registrations")}
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild>
                              <NavLink
                                to="/app/trainer/intake-requests"
                                className={cn(appNavLinkBase, appNavLinkInactive)}
                                activeClassName={appNavLinkActive}
                                onClick={closeMobileDrawer}
                              >
                                {t("nav.intakeRequests")}
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild>
                              <NavLink
                                to="/app/trainer/waiting-list"
                                className={cn(appNavLinkBase, appNavLinkInactive)}
                                activeClassName={appNavLinkActive}
                                onClick={closeMobileDrawer}
                              >
                                {t("nav.waitingList", "Waiting List")}
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>

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
                          className={cn(
                            appNavLinkBase,
                            isActive("/app/trainer/settings") ||
                              isActive("/app/trainer/subscription") ||
                              isActive("/app/trainer/earnings")
                              ? appNavLinkActive
                              : appNavLinkInactive,
                          )}
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
                                to="/app/trainer/settings"
                                className={cn(appNavLinkBase, appNavLinkInactive)}
                                activeClassName={appNavLinkActive}
                                onClick={closeMobileDrawer}
                              >
                                <Settings className="h-4 w-4" />
                                {t("nav.settings")}
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild>
                              <NavLink
                                to="/app/trainer/subscription"
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
                                to="/app/trainer/earnings"
                                className={cn(appNavLinkBase, appNavLinkInactive)}
                                activeClassName={appNavLinkActive}
                                onClick={closeMobileDrawer}
                              >
                                {t("nav.earnings")}
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>

                </>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className={appSidebarFooterClass}>
        <div className={cn(
          "flex p-2",
          collapsed ? "flex-col items-center gap-2" : "flex-col gap-2"
        )}>
          {/* Profile Switcher for clubs/academies */}
          <ProfileSwitcher context="trainer" collapsed={collapsed} />
          
          {/* View Public Profile */}
          {trainerProfileId && (
            <Button
              variant="ghost"
              size={collapsed ? "icon" : "sm"}
              className={cn(
                collapsed ? "h-8 w-8" : "w-full justify-start",
                cn("w-full justify-start", appSidebarGhostButtonClass)
              )}
              onClick={handleViewPublicProfile}
            >
              <ExternalLink className="h-4 w-4" />
              {!collapsed && <span className="ml-2">{t("nav.viewPublicProfile")}</span>}
            </Button>
          )}
          
          <div className={cn(
            "flex",
            collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
          )}>
            <ThemeToggle />
            <LanguageSwitcher className={appSidebarGhostButtonClass} />
            <Button
              variant="ghost"
              size="icon"
              onClick={showReferralWidget}
              aria-label={t("nav.referral", "Refer a friend")}
            >
              <Gift className="h-4 w-4 text-primary" />
            </Button>
            <Button
              variant="ghost"
              size={collapsed ? "icon" : "sm"}
              onClick={handleLogout}
              className={appSidebarGhostButtonClass}
            >
              <LogOut className="h-4 w-4" />
              {!collapsed && <span className="ml-2">{t("nav.logout", "Log out")}</span>}
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
