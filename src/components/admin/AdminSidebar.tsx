import { NavLink } from "@/components/NavLink";
import { cn } from "@/lib/utils";
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
  Star,
  Tags,
  FileCheck,
  PanelLeftClose,
  PanelLeft,
  Mail,
  ImageIcon,
  FileText,
  ListTodo,
} from "lucide-react";
import { signOut } from "@/lib/auth";
import { useNavigate, useLocation } from "react-router-dom";
import { useState } from "react";
import { Logo } from "@/components/Logo";

const mainNavItems = [
  { title: "Dashboard", url: "/app/admin", icon: LayoutDashboard, end: true },
  { title: "Users", url: "/app/admin/users", icon: Users },
  { title: "Player Ratings", url: "/app/admin/player-ratings", icon: Star },
  { title: "Trainers", url: "/app/admin/trainers", icon: GraduationCap },
  { title: "Academies", url: "/app/admin/academies", icon: School },
];

const contentNavItems = [
  { title: "Blog Articles", url: "/app/admin/blog", icon: FileText },
  { title: "Topics Queue", url: "/app/admin/blog/topics", icon: ListTodo },
];

const settingsNavItems = [
  { title: "Certifications", url: "/app/admin/certifications", icon: Award },
  { title: "Rating Systems", url: "/app/admin/rating-systems", icon: Scale },
  { title: "Review Tags", url: "/app/admin/review-tags", icon: Tags },
  { title: "Pricing Plans", url: "/app/admin/pricing", icon: CreditCard },
  { title: "Onboarding Emails", url: "/app/admin/onboarding-emails", icon: Mail },
  { title: "Partner Banners", url: "/app/admin/banners", icon: ImageIcon },
];

export function AdminSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const { data: pendingClaimsCount = 0 } = usePendingClaimsCount();

  // Track which collapsibles are open
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
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="h-4 w-4" />
            </div>
            {!collapsed && (
              <span className="font-semibold">Admin Panel</span>
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
                            to="/app/admin/locations"
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
                            to="/app/admin/clubs"
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
                            to="/app/admin/club-claims"
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

        {/* Content Group */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {contentNavItems.map((item) => (
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
        <div className={cn(
          "flex p-2",
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
      </SidebarFooter>
    </Sidebar>
  );
}
