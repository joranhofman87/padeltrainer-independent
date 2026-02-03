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
  FileText,
  Calendar,
  Clock,
  CalendarDays,
  Building2,
  Settings,
  CreditCard,
  ChevronRight,
  LogOut,
  ExternalLink,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { signOut, getTrainerProfile } from "@/lib/auth";
import { getTrainerAcademy } from "@/lib/academy";
import { getTrainerClubs, TrainerClub } from "@/lib/trainer";
import { getMarketingUrl } from "@/lib/domains";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export function TrainerSidebar() {
  const { t, i18n } = useTranslation("trainer");
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const { user, profile } = useAuth();
  const { toast } = useToast();

  const [trainerProfileId, setTrainerProfileId] = useState<string | null>(null);
  const [trainerClubs, setTrainerClubs] = useState<TrainerClub[]>([]);
  const [hasAcademy, setHasAcademy] = useState<boolean>(false);

  // Track which groups are open
  const [playersOpen, setPlayersOpen] = useState(
    location.pathname.startsWith("/trainer/players") ||
    location.pathname.startsWith("/trainer/intake-requests")
  );
  const [scheduleOpen, setScheduleOpen] = useState(
    location.pathname.startsWith("/trainer/calendar") ||
    location.pathname.startsWith("/trainer/open-slots")
  );
  const [registrationOpen, setRegistrationOpen] = useState(
    location.pathname.startsWith("/trainer/cyclus") ||
    location.pathname.startsWith("/trainer/cycles")
  );
  const [clubsOpen, setClubsOpen] = useState(false);
  const [businessOpen, setBusinessOpen] = useState(
    location.pathname.startsWith("/trainer/settings") ||
    location.pathname.startsWith("/trainer/subscription") ||
    location.pathname.startsWith("/trainer/earnings")
  );

  // Fetch trainer profile, clubs, and academy status
  useEffect(() => {
    const fetchTrainerData = async () => {
      if (!user) return;

      const trainerProfile = await getTrainerProfile(user.id);
      if (trainerProfile) {
        setTrainerProfileId(trainerProfile.id);

        // Fetch clubs and academy in parallel
        const [clubs, academy] = await Promise.all([
          getTrainerClubs(trainerProfile.id),
          getTrainerAcademy(trainerProfile.id),
        ]);

        setTrainerClubs(clubs);
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
        description: error.message,
        variant: "destructive",
      });
    } else {
      navigate("/auth");
    }
  };

  const handleViewPublicProfile = () => {
    if (trainerProfileId) {
      const lang = i18n.language === "en" || i18n.language === "nl" ? i18n.language : "nl";
      window.open(getMarketingUrl(`trainer/${trainerProfileId}`, lang), "_blank");
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
            <Avatar className="h-8 w-8">
              <AvatarImage src={profile?.avatar_url || undefined} />
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="flex flex-col">
                <span className="font-semibold text-sm truncate max-w-[140px]">
                  {profile?.full_name || "Trainer"}
                </span>
                <Badge
                  variant="secondary"
                  className="w-fit text-[10px] px-1.5 py-0 bg-orange-500/10 text-orange-600 dark:text-orange-400"
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
              {/* My Profile - First item */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.myProfile")}>
                  <NavLink
                    to="/trainer/profile"
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                    data-testid="nav-trainer-profile"
                  >
                    <User className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.myProfile")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Dashboard */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("nav.dashboard")}>
                  <NavLink
                    to="/trainer"
                    end
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                    data-testid="nav-trainer-dashboard"
                  >
                    <LayoutDashboard className="h-4 w-4" />
                    {!collapsed && <span>{t("nav.dashboard")}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Players Group */}
              <Collapsible
                open={playersOpen && !collapsed}
                onOpenChange={setPlayersOpen}
                className="group/players"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      tooltip={t("nav.players")}
                      className={isActive("/trainer/players") || isActive("/trainer/intake-requests")
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : ""}
                    >
                      <Users className="h-4 w-4" />
                      {!collapsed && (
                        <>
                          <span className="flex-1">{t("nav.players")}</span>
                          <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]/players:rotate-90" />
                        </>
                      )}
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/trainer/players"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.myPlayers")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/trainer/intake-requests"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.intakeRequests")}
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
                      className={isActive("/trainer/calendar") || isActive("/trainer/open-slots")
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
                            to="/trainer/calendar"
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
                            to="/trainer/open-slots"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.openSlots")}
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
                      className={isActive("/trainer/cyclus") || isActive("/trainer/cycles")
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : ""}
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
                            to="/trainer/cyclus"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.cyclus")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>

              {/* My Clubs Group - Only show if trainer has clubs */}
              {trainerClubs.length > 0 && (
                <Collapsible
                  open={clubsOpen && !collapsed}
                  onOpenChange={setClubsOpen}
                  className="group/clubs"
                >
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton tooltip={t("nav.myClubs")}>
                        <Building2 className="h-4 w-4" />
                        {!collapsed && (
                          <>
                            <span className="flex-1">{t("nav.myClubs")}</span>
                            <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]/clubs:rotate-90" />
                          </>
                        )}
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {trainerClubs.map((club) => (
                          <SidebarMenuSubItem key={club.clubId}>
                            <SidebarMenuSubButton asChild>
                              <NavLink
                                to={`/location/${club.locationSlug}`}
                                className="flex items-center gap-2"
                                activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                              >
                                <span className="truncate">{club.clubName}</span>
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              )}

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
                      className={isActive("/trainer/settings") || isActive("/trainer/subscription") || isActive("/trainer/earnings")
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
                            to="/trainer/settings"
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
                            to="/trainer/subscription"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            {t("nav.subscription")}
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      {!hasAcademy && (
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton asChild>
                            <NavLink
                              to="/trainer/earnings"
                              className="flex items-center gap-2"
                              activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                            >
                              {t("nav.earnings")}
                            </NavLink>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      )}
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
          {/* Profile Switcher for clubs/academies */}
          <ProfileSwitcher context="trainer" collapsed={collapsed} />
          
          {/* View Public Profile */}
          {trainerProfileId && (
            <Button
              variant="outline"
              size={collapsed ? "icon" : "sm"}
              className={collapsed ? "h-8 w-8" : "w-full justify-start"}
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
