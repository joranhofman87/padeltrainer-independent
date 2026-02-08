import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { Menu, X, Linkedin, Facebook, Instagram, Youtube } from 'lucide-react';
import { useState } from 'react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTranslation } from 'react-i18next';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useLocalizedPath } from '@/hooks/useLocalizedPath';
import { getAppUrl } from '@/lib/domains';
import { useAuth } from '@/hooks/useAuth';
import { Logo } from '@/components/Logo';

const getDashboardPath = (role?: string | null) => {
  switch (role) {
    case 'trainer': return '/app/trainer';
    case 'club': return '/app/club';
    case 'academy': return '/app/academy';
    default: return '/app/player';
  }
};

interface MarketingLayoutProps {
  children: React.ReactNode;
}

export default function MarketingLayout({ children }: MarketingLayoutProps) {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { t } = useTranslation('marketing');
  const { user, role } = useAuth();
  const dashboardUrl = getAppUrl(getDashboardPath(role));
  
  // Get localized paths
  const homePath = useLocalizedPath('/');
  const pricingPath = useLocalizedPath('/pricing');
  const aboutPath = useLocalizedPath('/about');
  const blogPath = useLocalizedPath('/blog');
  const trainersPath = useLocalizedPath('/trainers');
  const locationsPath = useLocalizedPath('/locations');
  const partnerPath = useLocalizedPath('/partner');
  const privacyPath = useLocalizedPath('/privacy');
  const termsPath = useLocalizedPath('/terms');

  const navLinks = [
    { href: homePath, label: t('nav.home'), path: '/' },
    { href: pricingPath, label: t('nav.pricing'), path: '/pricing' },
    { href: aboutPath, label: t('nav.about'), path: '/about' },
    { href: blogPath, label: t('nav.blog'), path: '/blog' },
  ];

  // Check if current path matches (ignoring language prefix)
  const isActive = (path: string) => {
    const currentPath = location.pathname.replace(/^\/(en|nl)/, '');
    return currentPath === path || (path === '/' && currentPath === '');
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-4">
          <div className="flex h-16 items-center justify-between">
            {/* Logo */}
            <LocalizedLink to="/" className="flex items-center gap-2">
              <Logo className="h-7" />
            </LocalizedLink>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-8">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  to={link.href}
                  className={`text-sm font-medium transition-colors hover:text-primary ${
                    isActive(link.path)
                      ? 'text-primary'
                      : 'text-muted-foreground'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
            </nav>

            <div className="hidden md:flex items-center gap-3">
              <LanguageSwitcher />
              <ThemeToggle />
              {user ? (
                <Button asChild className="bg-primary hover:bg-primary/90">
                  <Link to={dashboardUrl}>{t('nav.dashboard', 'Dashboard')}</Link>
                </Button>
              ) : (
                <>
                  <Button variant="ghost" asChild>
                    <Link to={getAppUrl('/auth')}>{t('nav.signIn')}</Link>
                  </Button>
                  <Button asChild className="bg-primary hover:bg-primary/90">
                    <Link to={getAppUrl('/signup/player')}>{t('nav.getStarted')}</Link>
                  </Button>
                </>
              )}
            </div>

            {/* Mobile Menu Button */}
            <button
              className="md:hidden p-2"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>

          {/* Mobile Menu */}
          {mobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="md:hidden py-4 border-t"
            >
              <nav className="flex flex-col gap-4">
                {navLinks.map((link) => (
                  <Link
                    key={link.href}
                    to={link.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`text-sm font-medium transition-colors hover:text-primary ${
                      isActive(link.path)
                        ? 'text-primary'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {link.label}
                  </Link>
                ))}
                <div className="flex flex-col gap-2 pt-4 border-t">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{t('nav.language')}:</span>
                    <LanguageSwitcher />
                    <ThemeToggle />
                  </div>
                  {user ? (
                    <Button asChild className="bg-primary hover:bg-primary/90">
                      <Link to={dashboardUrl}>{t('nav.dashboard', 'Dashboard')}</Link>
                    </Button>
                  ) : (
                    <>
                      <Button variant="ghost" asChild>
                        <Link to={getAppUrl('/auth')}>{t('nav.signIn')}</Link>
                      </Button>
                      <Button asChild className="bg-primary hover:bg-primary/90">
                        <Link to={getAppUrl('/signup/player')}>{t('nav.getStarted')}</Link>
                      </Button>
                    </>
                  )}
                </div>
              </nav>
            </motion.div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main>{children}</main>

      {/* Footer */}
      <footer className="border-t bg-muted text-foreground">
        <div className="container mx-auto px-4 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {/* Brand */}
            <div className="col-span-2 md:col-span-1">
              <LocalizedLink to="/" className="flex items-center gap-2 mb-4">
                <Logo className="h-6" />
              </LocalizedLink>
              <p className="text-sm text-muted-foreground">
                {t('footer.tagline')}
              </p>
              <div className="flex gap-3 mt-4">
                <a href="https://www.linkedin.com/company/padel-trainer/" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors">
                  <Linkedin className="h-5 w-5" />
                </a>
                <a href="https://www.facebook.com/people/PadelTrainerai/61587581553043/" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors">
                  <Facebook className="h-5 w-5" />
                </a>
                <a href="https://www.instagram.com/padeltrainerai/" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors">
                  <Instagram className="h-5 w-5" />
                </a>
                <a href="https://www.youtube.com/@PadelTrainerAI" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors">
                  <Youtube className="h-5 w-5" />
                </a>
                <a href="https://www.tiktok.com/@padeltrainer.ai" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                    <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
                  </svg>
                </a>
              </div>
            </div>

            <div>
              <h4 className="font-semibold mb-4">{t('footer.platform')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><LocalizedLink to="/trainers" className="hover:text-primary transition-colors">{t('footer.findTrainers')}</LocalizedLink></li>
                <li><LocalizedLink to="/locations" className="hover:text-primary transition-colors">{t('footer.locations')}</LocalizedLink></li>
                <li><LocalizedLink to="/academies" className="hover:text-primary transition-colors">{t('footer.academies', 'Academies')}</LocalizedLink></li>
                <li><LocalizedLink to="/pricing" className="hover:text-primary transition-colors">{t('nav.pricing')}</LocalizedLink></li>
                <li><LocalizedLink to="/blog" className="hover:text-primary transition-colors">{t('nav.blog')}</LocalizedLink></li>
                <li>
                  <Link to={getAppUrl('/signup/club')} className="hover:text-primary transition-colors">{t('footer.registerClub', 'Register your club')}</Link>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold mb-4">{t('footer.popularCities')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><LocalizedLink to="/trainers/amsterdam" className="hover:text-primary transition-colors">Amsterdam</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/rotterdam" className="hover:text-primary transition-colors">Rotterdam</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/den-haag" className="hover:text-primary transition-colors">Den Haag</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/utrecht" className="hover:text-primary transition-colors">Utrecht</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/eindhoven" className="hover:text-primary transition-colors">Eindhoven</LocalizedLink></li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold mb-4">{t('footer.company')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><LocalizedLink to="/about" className="hover:text-primary transition-colors">{t('footer.aboutUs')}</LocalizedLink></li>
                <li><LocalizedLink to="/partner" className="hover:text-primary transition-colors">{t('footer.becomePartner')}</LocalizedLink></li>
                <li><a href="mailto:hello@padeltrainer.ai" className="hover:text-primary transition-colors">{t('footer.contact')}</a></li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold mb-4">{t('footer.legal')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><LocalizedLink to="/privacy" className="hover:text-primary transition-colors">{t('footer.privacyPolicy')}</LocalizedLink></li>
                <li><LocalizedLink to="/terms" className="hover:text-primary transition-colors">{t('footer.termsOfService')}</LocalizedLink></li>
              </ul>
            </div>
          </div>

          <div className="border-t border-border mt-8 pt-8 text-center text-sm text-muted-foreground">
            <p>{t('footer.copyright', { year: new Date().getFullYear() })}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
