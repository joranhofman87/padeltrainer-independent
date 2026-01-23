import { useLocation, Link } from "react-router-dom";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Home, ArrowLeft } from "lucide-react";

const NotFound = () => {
  const location = useLocation();
  const { t } = useTranslation('common');

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="text-center space-y-4 px-4">
        <h1 className="text-6xl font-bold text-primary">404</h1>
        <h2 className="text-2xl font-semibold">{t('notFound.title')}</h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          {t('notFound.description')}
        </p>
        <div className="flex gap-4 justify-center pt-4">
          <Button variant="outline" onClick={() => window.history.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('back')}
          </Button>
          <Button asChild>
            <Link to="/">
              <Home className="mr-2 h-4 w-4" />
              {t('notFound.goHome')}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
};

export default NotFound;
