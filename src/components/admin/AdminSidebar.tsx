import { NavLink } from "@/components/NavLink";
import { usePendingClaimsCount } from "@/hooks/useAdminData";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
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
  Tags,
  FileCheck,
  PanelLeftClose,
  PanelLeft,
  Mail,
} from "lucide-react";
import { signOut } from "@/lib/auth";
import { useNavigate, useLocation } from "react-router-dom";
import { useState } from "react";

const mainNavItems = [
  { title: "Dashboard", url: "/admin", icon: LayoutDashboard, end: true },
  { title: "Users", url: "/admin/users", icon: Users },
  { title: "Trainers", url: "/admin/trainers", icon: GraduationCap },
  { title: "Academies", url: "/admin/academies", icon: School },
];

const settingsNavItems = [
  { title: "Certifications", url: "/admin/certifications", icon: Award },
  { title: "Rating Systems", url: "/admin/rating-systems", icon: Scale },
  { title: "Review Tags", url: "/admin/review-tags", icon: Tags },
  { title: "Pricing Plans", url: "/admin/pricing", icon: CreditCard },
  { title: "Onboarding Emails", url: "/admin/onboarding-emails", icon: Mail },
];

export function AdminSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const { data: pendingClaimsCount = 0 } = usePendingClaimsCount();

  // Track which collapsibles are open
  const [locationsOpen, setLocationsOpen] = useState(
    location.pathname.startsWith("/admin/locations") || 
    location.pathname.startsWith("/admin/club")
  );
  const [settingsOpen, setSettingsOpen] = useState(
    settingsNavItems.some(item => location.pathname.startsWith(item.url))
  );

  const handleLogout = async () => {
    await signOut();
    navigate("/");
  };

  const isLocationActive = location.pathname.startsWith("/admin/locations") || 
                           location.pathname.startsWith("/admin/clubs") ||
                           location.pathname.startsWith("/admin/club-claims");

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b">
        <div className="flex items-center justify-between px-2 py-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="h-4 w-4" />
            </div>
            {!collapsed && (
              <span className="font-semibold">Admin Panel</span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={toggleSidebar}
          >
            {collapsed ? (
              <PanelLeft className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild tooltip={item.title}>
                    <NavLink
                      to={item.url}
                      end={item.end}
                      className="flex items-center gap-2"
                      activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                    >
                      <item.icon className="h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}

              {/* Locations Group with Club Claims */}
              <Collapsible
                open={locationsOpen && !collapsed}
                onOpenChange={setLocationsOpen}
                className="group/locations"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton 
                      tooltip="Locations" 
                      className={isLocationActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}
                    >
                      <MapPin className="h-4 w-4" />
                      {!collapsed && (
                        <>
                          <span className="flex-1">Locations</span>
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
                            to="/admin/locations"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            All Locations
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/admin/clubs"
                            className="flex items-center gap-2"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            Verified Clubs
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink
                            to="/admin/club-claims"
                            className="flex items-center justify-between"
                            activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                          >
                            <span>Club Claims</span>
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

        {/* Settings Group */}
        <SidebarGroup>
          <Collapsible 
            open={settingsOpen && !collapsed} 
            onOpenChange={setSettingsOpen}
            className="group/collapsible"
          >
            <CollapsibleTrigger asChild>
              <SidebarMenuButton className="w-full justify-between" tooltip="Settings">
                <div className="flex items-center gap-2">
                  <Settings className="h-4 w-4" />
                  {!collapsed && <span>Settings</span>}
                </div>
                {!collapsed && (
                  <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]/collapsible:rotate-180" />
                )}
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu className="pl-4">
                  {settingsNavItems.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton asChild tooltip={item.title}>
                        <NavLink
                          to={item.url}
                          className="flex items-center gap-2"
                          activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
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

      <SidebarFooter className="border-t">
        <div className="flex items-center justify-between p-2">
          <ThemeToggle />
          {!collapsed && (
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="h-4 w-4 mr-2" />
              Logout
            </Button>
          )}
          {collapsed && (
            <Button variant="ghost" size="icon" onClick={handleLogout}>
              <LogOut className="h-4 w-4" />
            </Button>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
