import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
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
  useSidebar,
} from "@/components/ui/sidebar";
import {
  CreditCard,
  LogOut,
  ExternalLink,
  PanelLeftClose,
  PanelLeft,
  GraduationCap,
  Gift,
  X,
} from "lucide-react";
import { showReferralWidget } from "@/components/ReferralWidget";
import { signOut } from "@/lib/auth";
import { getMarketingUrl } from "@/lib/domains";
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
  appSidebarHeaderClass,
  appSidebarGhostButtonClass,
  appSidebarShellClass,
} from "@/components/ui/appSidebarStyles";
import type { AcademyProfile } from "@/lib/academy";
import {
  ACADEMY_PRIMARY_NAV,
  isAcademyNavItemActive,
  type AcademyNavItem,
} from "@/components/academy/academySidebarNav";

interface AcademySidebarProps {
  academy: (AcademyProfile & { role: string }) | null;
  onAcademyChange?: (academy: AcademyProfile & { role: string }) => void;
  isExpired?: boolean;
}

function AcademyNavLink({
  item,
  label,
  collapsed,
  onNavigate,
}: {
  item: AcademyNavItem;
  label: string;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  const location = useLocation();
  const active = isAcademyNavItemActive(location.pathname, item);

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
          {!collapsed && <span className="truncate">{label}</span>}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AcademySidebar({ academy, onAcademyChange, isExpired = false }: AcademySidebarProps) {
  const { t, i18n } = useTranslation("academy");
  const navigate = useNavigate();
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar();
  const collapsed = state === "collapsed";
  const { toast } = useToast();

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

  const handleViewPublicProfile = () => {
    if (academy?.slug && academy.is_verified && academy.is_public) {
      const lang = i18n.language === "en" || i18n.language === "nl" ? i18n.language : "nl";
      window.open(getMarketingUrl(`academies/${academy.slug}`, lang), "_blank");
    }
  };

  const initials = academy?.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "A";

  const statusLabel = academy?.is_verified
    ? t("common.verified")
    : t("badge");

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
                  {academy?.name || "Academy"}
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
              aria-label={collapsed ? t("nav.expandSidebar", "Expand sidebar") : t("nav.collapseSidebar", "Collapse sidebar")}
            >
              {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent className={cn(appSidebarContentClass, isExpired && "relative")}>
        {isExpired && <div className="absolute inset-0 z-10" aria-hidden />}
        <nav aria-label={t("nav.primary", "Academy navigation")} className={cn(isExpired && "opacity-50 pointer-events-none")}>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5 px-1">
                {ACADEMY_PRIMARY_NAV.map((item) => (
                  <AcademyNavLink
                    key={item.id}
                    item={item}
                    label={t(item.labelKey, item.defaultLabel)}
                    collapsed={collapsed}
                    onNavigate={closeMobileDrawer}
                  />
                ))}
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
          {!collapsed && academy && (
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              {academy.logo_url ? (
                <Avatar className="h-8 w-8">
                  <AvatarImage src={academy.logo_url} alt={academy.name || ""} />
                  <AvatarFallback className="text-xs bg-slate-100 text-slate-700">
                    {initials}
                  </AvatarFallback>
                </Avatar>
              ) : (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100">
                  <GraduationCap className="h-4 w-4 text-slate-500" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{academy.name}</p>
                <p className="truncate text-xs text-slate-500">{statusLabel}</p>
              </div>
            </div>
          )}

          <ProfileSwitcher
            context="academy"
            activeAcademyId={academy?.id}
            onAcademyChange={onAcademyChange}
            collapsed={collapsed}
          />

          {academy?.slug && academy?.is_verified && academy?.is_public && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleViewPublicProfile}
              className={cn(
                cn("w-full justify-start", appSidebarGhostButtonClass),
                collapsed && "w-auto px-2",
              )}
            >
              <ExternalLink className="h-4 w-4 shrink-0" />
              {!collapsed && (
                <span className="ml-2 truncate">{t("dashboard.viewPublicProfile")}</span>
              )}
            </Button>
          )}

          <div
            className={cn(
              "flex",
              collapsed ? "flex-col items-center gap-2" : "items-center gap-1",
            )}
          >
            <ThemeToggle />
            <LanguageSwitcher />
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-9 w-9", appSidebarGhostButtonClass)}
              onClick={() => {
                closeMobileDrawer();
                navigate("/app/academy/subscription");
              }}
              title={t("nav.subscription")}
              aria-label={t("nav.subscription")}
            >
              <CreditCard className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-9 w-9", appSidebarGhostButtonClass)}
              onClick={showReferralWidget}
              aria-label={t("nav.referral", "Referral")}
            >
              <Gift className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              className={cn("h-9 w-9", appSidebarGhostButtonClass)}
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
