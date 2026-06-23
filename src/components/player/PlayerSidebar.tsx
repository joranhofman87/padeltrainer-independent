import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ProfileSwitcher } from "@/components/ProfileSwitcher";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  ChevronRight,
  LogOut,
  PanelLeftClose,
  PanelLeft,
  Gift,
  Gamepad2,
  User,
  X,
} from "lucide-react";
import { showReferralWidget } from "@/components/ReferralWidget";
import { useAuth } from "@/hooks/useAuth";
import { useUnseenFeedbackCount } from "@/lib/playerJourney";
import { signOut } from "@/lib/auth";
import { getFriendlyErrorMessage } from "@/lib/friendlyError";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";
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
  PLAYER_PRIMARY_NAV,
  isPlayerNavItemActive,
  type PlayerNavItem,
} from "@/components/player/playerSidebarNav";

function PlayerNavLink({
  item,
  label,
  collapsed,
  onNavigate,
  badge,
}: {
  item: PlayerNavItem;
  label: string;
  collapsed: boolean;
  onNavigate: () => void;
  badge?: number;
}) {
  const Icon = item.icon;
  const location = useLocation();
  const active = isPlayerNavItemActive(location.pathname, item);
  const showBadge = typeof badge === "number" && badge > 0;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={label} isActive={active}>
        <Link
          to={item.to}
          data-testid={item.testId}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={cn(appNavLinkBase, active ? appNavLinkActive : appNavLinkInactive)}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          {!collapsed && <span className="flex-1 truncate">{label}</span>}
          {!collapsed && showBadge && (
            <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
              {badge}
            </span>
          )}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function PlayerSidebar() {
  const { t, i18n } = useTranslation("player");
  const { t: tCommon } = useTranslation("common");
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar();
  const collapsed = state === "collapsed";
  const { profile } = useAuth();
  const { data: unseenFeedback = 0 } = useUnseenFeedbackCount(profile?.id);
  const { toast } = useToast();

  const [accountOpen, setAccountOpen] = useState(
    location.pathname.startsWith("/app/player/settings"),
  );

  const closeMobileDrawer = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  const handleLogout = async () => {
    const { error } = await signOut();
    if (error) {
      toast({
        title: "Error",
        description: getFriendlyErrorMessage(error, t("nav.logoutError", "Failed to log out. Please try again.")),
        variant: "destructive",
      });
    } else {
      navigate("/app/auth");
    }
  };

  const isSettingsActive = location.pathname.startsWith("/app/player/settings");

  const initials =
    profile?.full_name
      ?.split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase() || "P";

  return (
    <Sidebar
      collapsible="icon"
      className={appSidebarShellClass}
    >
      <SidebarHeader className={appSidebarHeaderClass}>
        <div
          className={cn(
            "flex items-center gap-2 px-2 pt-2",
            collapsed ? "flex-col justify-center" : "justify-between",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 items-center",
              collapsed ? "justify-center" : "gap-2",
            )}
          >
            <Logo className="h-5 w-auto shrink-0" />
            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold tracking-tight text-slate-800">
                  padeltrainer
                </p>
                <p className="truncate text-[11px] text-slate-500">
                  {profile?.full_name || t("nav.dashboard", "Player")}
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
              data-testid="player-mobile-menu-close"
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
              {collapsed ? (
                <PanelLeft className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
        {!collapsed && (
          <div className="flex items-center gap-2 px-2 pb-2">
            <Avatar className="h-8 w-8">
              <AvatarImage src={profile?.avatar_url || undefined} />
              <AvatarFallback className="bg-slate-100 text-xs text-slate-700">
                {initials}
              </AvatarFallback>
            </Avatar>
            <span className="truncate text-sm font-medium text-slate-900">
              {profile?.full_name || "Player"}
            </span>
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className={appSidebarContentClass}>
        <nav aria-label={t("nav.primary", "Player navigation")}>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5 px-1">
                {PLAYER_PRIMARY_NAV.map((item) => (
                  <PlayerNavLink
                    key={item.id}
                    item={item}
                    label={t(item.labelKey, item.defaultLabel)}
                    collapsed={collapsed}
                    onNavigate={closeMobileDrawer}
                    badge={item.id === "journey" ? unseenFeedback : undefined}
                  />
                ))}

                {/* Playground (external) */}
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip={t("nav.playground", "Playground")}>
                    <a
                      href={`/${i18n.language || "en"}/playground`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={closeMobileDrawer}
                      className={cn(appNavLinkBase, appNavLinkInactive)}
                    >
                      <Gamepad2 className="h-4 w-4 shrink-0" aria-hidden />
                      {!collapsed && (
                        <span className="truncate">{t("nav.playground", "Playground")}</span>
                      )}
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>

      <SidebarFooter className={appSidebarFooterClass}>
        <div
          className={cn(
            "flex p-2",
            collapsed ? "flex-col items-center gap-2" : "flex-col gap-2",
          )}
        >
          <ProfileSwitcher context="player" collapsed={collapsed} />

          <Collapsible
            open={accountOpen && !collapsed}
            onOpenChange={setAccountOpen}
            className="group/account w-full"
          >
            <SidebarMenu>
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton
                    tooltip={t("nav.account")}
                    className={cn(
                      appNavLinkBase,
                      isSettingsActive ? appNavLinkActive : appNavLinkInactive,
                      "w-full",
                    )}
                  >
                    <User className="h-4 w-4 shrink-0" aria-hidden />
                    {!collapsed && (
                      <>
                        <span className="flex-1 truncate text-left">{t("nav.account")}</span>
                        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]/account:rotate-90" />
                      </>
                    )}
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub className="mx-1">
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton asChild>
                        <Link
                          to="/app/player/settings"
                          onClick={closeMobileDrawer}
                          className={cn(
                            appNavLinkBase,
                            "py-1.5 text-sm",
                            location.pathname === "/app/player/settings"
                              ? appNavLinkActive
                              : appNavLinkInactive,
                          )}
                        >
                          {t("nav.settings")}
                        </Link>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton asChild>
                        <Link
                          to="/app/player/settings/notifications"
                          onClick={closeMobileDrawer}
                          className={cn(
                            appNavLinkBase,
                            "py-1.5 text-sm",
                            location.pathname.startsWith("/app/player/settings/notifications")
                              ? appNavLinkActive
                              : appNavLinkInactive,
                          )}
                        >
                          {t("nav.notifications")}
                        </Link>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </SidebarMenu>
          </Collapsible>

          <div
            className={cn(
              "flex w-full",
              collapsed ? "flex-col items-center gap-2" : "items-center justify-between",
            )}
          >
            <ThemeToggle />
            <LanguageSwitcher className={appSidebarGhostButtonClass} />
            <Button variant="ghost" size="icon" onClick={showReferralWidget} aria-label="Referrals">
              <Gift className="h-4 w-4 text-primary" />
            </Button>
            <Button
              variant="ghost"
              size={collapsed ? "icon" : "sm"}
              onClick={handleLogout}
              className={appSidebarGhostButtonClass}
            >
              <LogOut className="h-4 w-4" />
              {!collapsed && <span className="ml-2">{tCommon("signOut")}</span>}
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
