import { useState, useEffect } from "react";
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
  User,
  Calendar,
  CalendarDays,
  MapPin,
  Settings,
  CreditCard,
  ChevronRight,
  LogOut,
  ExternalLink,
  PanelLeftClose,
  PanelLeft,
  GraduationCap,
  CheckCircle,
} from "lucide-react";
import { signOut } from "@/lib/auth";
import { getMarketingUrl } from "@/lib/domains";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { AcademyProfile } from "@/lib/academy";

interface AcademySidebarProps {
  academy: (AcademyProfile & { role: string }) | null;
  onAcademyChange?: (academy: AcademyProfile & { role: string }) => void;
}

export function AcademySidebar({ academy, onAcademyChange }: AcademySidebarProps) {
  const { t, i18n } = useTranslation("academy");
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const { toast } = useToast();

  // Track which groups are open
  const [teamOpen, setTeamOpen] = useState(
    location.pathname.includes("/academy/trainers")
  );
  const [scheduleOpen, setScheduleOpen] = useState(
    location.pathname.includes("/academy/calendar") ||
    location.pathname.includes("/academy/cycles")
  );
  const [businessOpen, setBusinessOpen] = useState(
    location.pathname.includes("/academy/settings") ||
    location.pathname.includes("/academy/subscription") ||
    location.pathname.includes("/academy/earnings")
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
      navigate("/auth");
    }
  };

  const handleViewPublicProfile = () => {
    if (academy?.slug && academy.is_verified && academy.is_public) {
      const lang = i18n.language === "en" || i18n.language === "nl" ? i18n.language : "nl";
      window.open(getMarketingUrl(`academies/${academy.slug}`, lang), "_blank");
    }
  };

  const isActive = (path: string, exact = false) => {
    if (exact) return location.pathname === path;
    return location.pathname.startsWith(path);
  };

  const initials = academy?.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "A";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b">
        <div className={cn(
          "flex px-2 py-2",
          collapsed ? "flex-col items-center gap-2" : "items-center justify-between"
        )}>
          <div className={cn(
            "flex items-center",
            collapsed ? "justify-center" : "gap-2"
          )}>
            {academy?.logo_url ? (
              <Avatar className="h-8 w-8">
                <AvatarImage src={academy.logo_url} />
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
            ) : (
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                <GraduationCap className="h-4 w-4 text-primary" />
              </div>
            )}
            {!collapsed && (
              <div className="flex flex-col min-w-0">
                <span className="font-semibold text-sm truncate max-w-[140px]">
                  {academy?.name || "Academy"}
                </span>
                <div className="flex items-center gap-1">
                  {academy?.is_verified ? (
                    <Badge
                      variant="secondary"
                      className="w-fit text-[10px] px-1.5 py-0 bg-green-500/10 text-green-600 dark:text-green-400"
                    >
                      <CheckCircle className="h-2.5 w-2.5 mr-0.5" />
                      {t("common.verified")}
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
                    to="/academy"
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
                    to="/academy/profile"
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                  >
                    <User className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.profile")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Team Group */}
              <Collapsible
                open={teamOpen && !collapsed}
                onOpenChange={setTeamOpen}
                className="group/team"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      tooltip={t("nav.team")}
                      className={isActive("/academy/trainers")
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : ""}
                    >
                      <Users className="h-4 w-4" />
                      {!collapsed && (
                        <>
                          <span className="flex-1">{t("nav.team")}</span>
                          <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]/team:rotate-90" />
                        </>
                      )}
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/academy/trainers"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.trainers")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>

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
                      className={isActive("/academy/calendar") || isActive("/academy/cycles")
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : ""}
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
                            to="/academy/calendar"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.calendar")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/academy/cycles"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.cycles")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>

              {/* Locations */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.locations")}>
                  <NavLink
                    to="/academy/locations"
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                  >
                    <MapPin className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.locations")}</span>}
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
                      tooltip={t("nav.settings")}
                      className={isActive("/academy/settings") || isActive("/academy/subscription") || isActive("/academy/earnings")
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : ""}
                    >
                      <CreditCard className="h-4 w-4" />
                      {!collapsed && (
                        <>
                          <span className="flex-1">{t("nav.settings")}</span>
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
                            to="/academy/settings"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            <Settings className="h-4 w-4" />
                            {t("nav.settings")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/academy/subscription"
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
                            to="/academy/earnings"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.earnings")}
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
            context="academy" 
            activeAcademyId={academy?.id}
            onAcademyChange={onAcademyChange}
            collapsed={collapsed}
          />
          
          {/* View Public Profile */}
          {academy?.slug && academy?.is_verified && academy?.is_public && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleViewPublicProfile}
              className={cn("w-full", collapsed && "w-auto px-2")}
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
