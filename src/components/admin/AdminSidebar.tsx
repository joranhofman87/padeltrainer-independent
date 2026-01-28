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
  SidebarTrigger,
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
  Building2,
  FileCheck,
  School,
  MapPin,
  Award,
  Settings,
  ChevronDown,
  CreditCard,
  Scale,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { signOut } from "@/lib/auth";
import { useNavigate } from "react-router-dom";

const mainNavItems = [
  { title: "Dashboard", url: "/admin", icon: LayoutDashboard, end: true },
  { title: "Users", url: "/admin/users", icon: Users },
  { title: "Trainers", url: "/admin/trainers", icon: GraduationCap },
  { title: "Clubs", url: "/admin/clubs", icon: Building2 },
  { title: "Academies", url: "/admin/academies", icon: School },
  { title: "Locations", url: "/admin/locations", icon: MapPin },
  { title: "Certifications", url: "/admin/certifications", icon: Award },
];

const settingsNavItems = [
  { title: "Rating Systems", url: "/admin/rating-systems", icon: Scale },
  { title: "Pricing Plans", url: "/admin/pricing", icon: CreditCard },
];

export function AdminSidebar() {
  const navigate = useNavigate();
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const { data: pendingClaimsCount = 0 } = usePendingClaimsCount();

  const handleLogout = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b">
        <div className="flex items-center gap-2 px-2 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="h-4 w-4" />
          </div>
          {!collapsed && (
            <span className="font-semibold">Admin Panel</span>
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

              {/* Club Claims with Badge */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Club Claims">
                  <NavLink
                    to="/admin/club-claims"
                    className="flex items-center gap-2"
                    activeClassName="bg-sidebar-accent text-sidebar-accent-foreground"
                  >
                    <FileCheck className="h-4 w-4" />
                    {!collapsed && (
                      <span className="flex-1 flex items-center justify-between">
                        Club Claims
                        {pendingClaimsCount > 0 && (
                          <Badge variant="destructive" className="ml-2 h-5 px-1.5 text-xs">
                            {pendingClaimsCount}
                          </Badge>
                        )}
                      </span>
                    )}
                    {collapsed && pendingClaimsCount > 0 && (
                      <Badge variant="destructive" className="absolute -top-1 -right-1 h-4 w-4 p-0 text-[10px] flex items-center justify-center">
                        {pendingClaimsCount}
                      </Badge>
                    )}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Settings Group */}
        <SidebarGroup>
          <Collapsible defaultOpen className="group/collapsible">
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
