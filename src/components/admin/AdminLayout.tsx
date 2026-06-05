import { useEffect, Suspense } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Menu } from "lucide-react";
import { SidebarProvider, SidebarInset, useSidebar } from "@/components/ui/sidebar";
import { useTranslation } from "react-i18next";
import { AdminSidebar } from "./AdminSidebar";
import { Button } from "@/components/ui/button";
import { LogOut, ShieldAlert } from "lucide-react";
import { signOut } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { AppShellSkeleton } from "@/components/AppShellSkeleton";
import { PageContentSkeleton } from "@/components/AppShellSkeleton";

function AdminMobileHeader() {
  const { t } = useTranslation("admin");
  const { toggleSidebar } = useSidebar();

  return (
    <header
      className="sticky top-0 z-40 flex h-14 min-w-0 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-white/80 lg:hidden"
      data-testid="admin-mobile-header"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        onClick={toggleSidebar}
        aria-label={t("nav.openMenu", "Open menu")}
        data-testid="admin-mobile-menu-trigger"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{t("panelTitle")}</span>
    </header>
  );
}

export default function AdminLayout() {
  const navigate = useNavigate();
  const { user, roles, loading: authLoading, profileReady } = useAuth();
  const authResolving = authLoading || (!!user && !profileReady);
  const isAdmin = roles.includes('admin');
  const { toast } = useToast();

  useEffect(() => {
    if (!authResolving && !user) {
      navigate("/app/auth");
    }
  }, [authResolving, user, navigate]);

  const handleSignOut = async () => {
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

  if (authResolving) {
    return <AppShellSkeleton />;
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
        <ShieldAlert className="h-16 w-16 text-destructive" />
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground">You don't have admin privileges.</p>
        <p className="text-sm text-muted-foreground">If you were just granted admin access, please log out and log back in.</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleSignOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Log Out
          </Button>
          <Button onClick={() => navigate("/")}>Go Home</Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AdminSidebar />
        <SidebarInset className="flex-1">
          <AdminMobileHeader />
          <main className="flex-1 overflow-auto p-6">
            <Suspense fallback={<PageContentSkeleton />}>
              <Outlet />
            </Suspense>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
