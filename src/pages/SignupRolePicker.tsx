import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Users, GraduationCap, Building2, Trophy, ArrowLeft } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

const roles = [
  { key: 'player', icon: Users, path: '/app/signup/player' },
  { key: 'trainer', icon: GraduationCap, path: '/app/signup/trainer' },
  { key: 'academy', icon: Trophy, path: '/app/signup/academy' },
  { key: 'club', icon: Building2, path: '/app/signup/club' },
] as const;

export default function SignupRolePicker() {
  const { t } = useTranslation('auth');
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect');

  function buildPath(base: string) {
    return redirect ? `${base}?redirect=${encodeURIComponent(redirect)}` : base;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {t('signupPicker.title')}
          </h1>
          <p className="text-muted-foreground">
            {t('signupPicker.subtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {roles.map(({ key, icon: Icon, path }) => (
            <Link key={key} to={buildPath(path)} className="group">
              <Card className="h-full transition-all hover:border-primary hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-ring">
                <CardContent className="flex flex-col items-center text-center gap-3 p-6">
                  <div className="rounded-full bg-primary/10 p-3">
                    <Icon className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-foreground">
                      {t(`signupPicker.roles.${key}.title`)}
                    </h2>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t(`signupPicker.roles.${key}.description`)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        <div className="flex flex-col items-center gap-3 text-sm">
          <p className="text-muted-foreground">
            {t('signupPicker.alreadyHaveAccount')}{' '}
            <Link to="/app/auth" className="font-medium text-primary hover:underline">
              {t('signIn.button')}
            </Link>
          </p>
          <Link to="/" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
            {t('backToHome')}
          </Link>
        </div>
      </div>
    </div>
  );
}
