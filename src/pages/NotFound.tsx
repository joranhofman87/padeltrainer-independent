import { useLocation } from "react-router-dom";
import { LocalizedLink } from "@/components/LocalizedLink";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { logger } from "@/lib/logger";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Home, ArrowLeft, Search, Users, GraduationCap, BookOpen, CalendarDays } from "lucide-react";

interface Suggestion {
  icon: React.ReactNode;
  labelKey: string;
  labelFallback: string;
  to: string;
}

function useSuggestions(pathname: string): Suggestion[] {
  return useMemo(() => {
    const p = pathname.toLowerCase();

    if (/\/(trainer|coach|book|lesson)/.test(p)) {
      return [
        { icon: <Users className="h-4 w-4" />, labelKey: "notFound.suggestions.findTrainer", labelFallback: "Find a trainer", to: "/trainers" },
        { icon: <GraduationCap className="h-4 w-4" />, labelKey: "notFound.suggestions.browseAcademies", labelFallback: "Browse academies", to: "/academies" },
      ];
    }
    if (/\/(academ|school)/.test(p)) {
      return [
        { icon: <GraduationCap className="h-4 w-4" />, labelKey: "notFound.suggestions.browseAcademies", labelFallback: "Browse academies", to: "/academies" },
        { icon: <Users className="h-4 w-4" />, labelKey: "notFound.suggestions.findTrainer", labelFallback: "Find a trainer", to: "/trainers" },
      ];
    }
    if (/\/(blog|article|nieuws)/.test(p)) {
      return [
        { icon: <BookOpen className="h-4 w-4" />, labelKey: "notFound.suggestions.readBlog", labelFallback: "Read our blog", to: "/blog" },
      ];
    }
    if (/\/(cycle|register|intake|inschrijv)/.test(p)) {
      return [
        { icon: <CalendarDays className="h-4 w-4" />, labelKey: "notFound.suggestions.findTrainer", labelFallback: "Find a trainer", to: "/trainers" },
      ];
    }

    // Default suggestions
    return [
      { icon: <Users className="h-4 w-4" />, labelKey: "notFound.suggestions.findTrainer", labelFallback: "Find a trainer", to: "/trainers" },
      { icon: <GraduationCap className="h-4 w-4" />, labelKey: "notFound.suggestions.browseAcademies", labelFallback: "Browse academies", to: "/academies" },
    ];
  }, [pathname]);
}

const NotFound = () => {
  const location = useLocation();
  const { t } = useTranslation("common");
  const suggestions = useSuggestions(location.pathname);

  useEffect(() => {
    logger.warn("404 Error: User attempted to access non-existent route", { path: location.pathname });
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-md text-center space-y-6">
        {/* Icon + heading */}
        <div className="flex flex-col items-center gap-3">
          <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
            <Search className="h-8 w-8 text-primary" />
          </div>
          <p className="text-sm font-medium text-muted-foreground tracking-wide">404</p>
          <h1 className="text-2xl font-bold">{t("notFound.title")}</h1>
          <p className="text-muted-foreground">{t("notFound.description")}</p>
        </div>

        {/* Contextual suggestions */}
        <Card className="text-left">
          <CardContent className="pt-5 space-y-3">
            <p className="text-sm font-medium">
              {t("notFound.suggestions.heading", "Maybe you were looking for:")}
            </p>
            <div className="space-y-2">
              {suggestions.map((s) => (
                <Button
                  key={s.to}
                  variant="outline"
                  className="w-full justify-start gap-2"
                  asChild
                >
                  <LocalizedLink to={s.to}>
                    {s.icon}
                    {t(s.labelKey, s.labelFallback)}
                  </LocalizedLink>
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Standard actions */}
        <div className="flex gap-3 justify-center">
          <Button variant="ghost" size="sm" onClick={() => window.history.back()}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            {t("back")}
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <LocalizedLink to="/">
              <Home className="mr-1.5 h-4 w-4" />
              {t("notFound.goHome")}
            </LocalizedLink>
          </Button>
        </div>
      </div>
    </div>
  );
};

export default NotFound;
