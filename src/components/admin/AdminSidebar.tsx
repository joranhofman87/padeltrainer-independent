import { NavLink } from "@/components/NavLink";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { usePendingClaimsCount } from "@/hooks/useAdminData";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
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
  GraduationCap,
  School,
  MapPin,
  Award,
  Settings,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Scale,
  LogOut,
  ShieldCheck,
  Star,
  Tags,
  PanelLeftClose,
  PanelLeft,
  Mail,
  MessageSquareMore,
  FileText,
  ListTodo,
  Database,
  UserPlus,
  X,
} from "lucide-react";
import { signOut } from "@/lib/auth";
import { useNavigate, useLocation } from "react-router-dom";
import { useState } from "react";
import { Logo } from "@/components/Logo";

export function AdminSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar();
  const collapsed = state === "collapsed";
  const { data: pendingClaimsCount = 0 } = usePendingClaimsCount();
  const { t } = useTranslation("admin");

  const closeMobileDrawer = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  const mainNavItems = [
    { title: t("sidebar.dashboard"), url: "/app/admin", icon: LayoutDashboard, end: true },
    { title: t("sidebar.users"), url: "/app/admin/users", icon: Users },
    { title: t("sidebar.playerRatings"), url: "/app/admin/player-ratings", icon: Star },
    { title: t("sidebar.trainers"), url: "/app/admin/trainers", icon: GraduationCap },
    { title: t("sidebar.academies"), url: "/app/admin/academies", icon: School },
    { title: t("sidebar.registrations"), url: "/app/admin/guest-players", icon: UserPlus },
  ];

  const contentNavItems = [
    { title: t("sidebar.blogArticles"), url: "/app/admin/blog", icon: FileText },
    { title: t("sidebar.topicsQueue"), url: "/app/admin/blog/topics", icon: ListTodo },
    { title: t("sidebar.courtReviews"), url: "/app/admin/court-reviews", icon: MessageSquareMore },
  ];

  const settingsNavItems = [
    { title: t("sidebar.certifications"), url: "/app/admin/certifications", icon: Award },
    { title: t("sidebar.ratingSystems"), url: "/app/admin/rating-systems", icon: Scale },
    { title: t("sidebar.reviewTags"), url: "/app/admin/review-tags", icon: Tags },
    { title: t("sidebar.pricingPlans"), url: "/app/admin/pricing", icon: CreditCard },
    { title: t("sidebar.onboardingEmails"), url: "/app/admin/onboarding-emails", icon: Mail },
    { title: t("sidebar.backups"), url: "/app/admin/backups", icon: Database },
  ];

  const [locationsOpen, setLocationsOpen] = useState(
    location.pathname.startsWith("/app/admin/locations") ||
    location.pathname.startsWith("/app/admin/club")
  );
  const [settingsOpen, setSettingsOpen] = useState(
    settingsNavItems.some(item => location.pathname.startsWith(item.url))
  );

  const handleLogout = async () => {
    await signOut();
    navigate("/");
  };

  const isLocationActive = location.pathname.startsWith("/app/admin/locations") ||
                            location.pathname.startsWith("/app/admin/clubs") ||
                            location.pathname.startsWith("/app/admin/club-claims");

  const isSettingsActive = settingsNavItems.some(item => location.pathname.startsWith(item.url));

  return (
    <Sidebar collapsible="icon" className={appSidebarShellClass} data-testid="admin-sidebar-shell">
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
                <p className="truncate text-[11px] text-slate-500">{t("panelTitle")}</p>
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
              data-testid="admin-mobile-menu-close"
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
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <p className="truncate text-sm font-medium text-slate-900">{t("panelTitle")}</p>
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className={appSidebarContentClass}>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5 px-1">
              {mainNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild tooltip={item.title}>
                    <NavLink
                      to={item.url}
                      end={item.end}
                      className={cn(appNavLinkBase, appNavLinkInactive)}
                      activeClassName={appNavLinkActive}
                      onClick={closeMobileDrawer}
                    >
                      <item.icon className="h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}

              <Collapsible
                open={locationsOpen && !collapsed}
                onOpenChange={setLocationsOpen}
                className="group/locations"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      tooltip={t("sidebar.locations")}
                      className={cn(
                        appNavLinkBase,
                        isLocationActive ? appNavLinkActive : appNavLinkInactive,
                      )}
                    >
                      <MapPin className="h-4 w-4" />
                      {!collapsed && (
                        <>
                          <span className="flex-1">{t("sidebar.locations")}</span>
                          {pendingClaimsCount > 0 && (
                            <Badge variant="destructive" className="h-5 px-1.5 text-xs mr-1">
                              {pendingClaimsCount}
                            </Badge>
                          )}
                          <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]/locations:rotate-90" />
                        </>
                      )}
                      {collapsed && pendingClaimsCount > 0 && (
                        <Badge variant="destructive" className="absolute -top-1 -right-1 h-4 w-4 p-0 text-[10px] flex items-center justify-center">
                          {pendingClaimsCount}
                        </Badge>
                      )}
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/admin/locations"
                            className={cn(appNavLinkBase, appNavLinkInactive)}
                            activeClassName={appNavLinkActive}
                            onClick={closeMobileDrawer}
                          >
                            {t("sidebar.allLocations")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/admin/clubs"
                            className={cn(appNavLinkBase, appNavLinkInactive)}
                            activeClassName={appNavLinkActive}
                            onClick={closeMobileDrawer}
                          >
                            {t("sidebar.verifiedClubs")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/app/admin/club-claims"
                            className={cn(appNavLinkBase, appNavLinkInactive, "justify-between")}
                            activeClassName={appNavLinkActive}
                            onClick={closeMobileDrawer}
                          >
                            <span>{t("sidebar.clubClaims")}</span>
                            {pendingClaimsCount > 0 && (
                              <Badge variant="destructive" className="h-5 px-1.5 text-xs">
                                {pendingClaimsCount}
                              </Badge>
                            )}
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

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5 px-1">
              {contentNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild tooltip={item.title}>
                    <NavLink
                      to={item.url}
                      className={cn(appNavLinkBase, appNavLinkInactive)}
                      activeClassName={appNavLinkActive}
                      onClick={closeMobileDrawer}
                    >
                      <item.icon className="h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <Collapsible
            open={settingsOpen && !collapsed}
            onOpenChange={setSettingsOpen}
            className="group/collapsible"
          >
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                className={cn(
                  appNavLinkBase,
                  "w-full justify-between",
                  isSettingsActive ? appNavLinkActive : appNavLinkInactive,
                )}
                tooltip={t("sidebar.settings")}
              >
                <div className="flex items-center gap-2">
                  <Settings className="h-4 w-4" />
                  {!collapsed && <span>{t("sidebar.settings")}</span>}
                </div>
                {!collapsed && (
                  <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]/collapsible:rotate-180" />
                )}
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5 px-1 pl-4">
                  {settingsNavItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton asChild tooltip={item.title}>
                        <NavLink
                          to={item.url}
                          className={cn(appNavLinkBase, appNavLinkInactive)}
                          activeClassName={appNavLinkActive}
                          onClick={closeMobileDrawer}
                        >
                          <item.icon className="h-4 w-4" />
                          {!collapsed && <span>{item.title}</span>}
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </Collapsible>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className={appSidebarFooterClass}>
        <div className={cn(
          "flex p-2",
          collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
        )}>
          <ThemeToggle />
          <Button
            variant="ghost"
            size={collapsed ? "icon" : "sm"}
            onClick={handleLogout}
            className={cn("w-full justify-start", appSidebarGhostButtonClass)}
          >
            <LogOut className="h-4 w-4" />
            {!collapsed && <span className="ml-2">{t("logout")}</span>}
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
