import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useTranslation } from 'react-i18next';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useLocalizedPath } from '@/hooks/useLocalizedPath';

interface MarketingLayoutProps {
  children: React.ReactNode;
}

export default function MarketingLayout({ children }: MarketingLayoutProps) {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { t } = useTranslation('marketing');
  
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
              <span className="font-bold text-xl tracking-tight">
                PadelTrainer<span className="text-primary">.ai</span>
              </span>
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
              <Button variant="ghost" asChild>
                <LocalizedLink to="/auth">{t('nav.signIn')}</LocalizedLink>
              </Button>
              <Button asChild className="bg-primary hover:bg-primary/90">
                <LocalizedLink to="/signup/player">{t('nav.getStarted')}</LocalizedLink>
              </Button>
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
                  </div>
                  <Button variant="ghost" asChild>
                    <LocalizedLink to="/auth">{t('nav.signIn')}</LocalizedLink>
                  </Button>
                  <Button asChild className="bg-primary hover:bg-primary/90">
                    <LocalizedLink to="/signup/player">{t('nav.getStarted')}</LocalizedLink>
                  </Button>
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
                <span className="font-bold text-lg">
                  PadelTrainer<span className="text-primary">.ai</span>
                </span>
              </LocalizedLink>
              <p className="text-sm text-muted-foreground">
                {t('footer.tagline')}
              </p>
            </div>

            <div>
              <h4 className="font-semibold mb-4">{t('footer.platform')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><LocalizedLink to="/trainers" className="hover:text-primary transition-colors">{t('footer.findTrainers')}</LocalizedLink></li>
                <li><LocalizedLink to="/locations" className="hover:text-primary transition-colors">{t('footer.locations')}</LocalizedLink></li>
                <li><LocalizedLink to="/pricing" className="hover:text-primary transition-colors">{t('nav.pricing')}</LocalizedLink></li>
                <li><LocalizedLink to="/blog" className="hover:text-primary transition-colors">{t('nav.blog')}</LocalizedLink></li>
                <li><LocalizedLink to="/signup/club" className="hover:text-primary transition-colors">{t('footer.registerClub', 'Register your club')}</LocalizedLink></li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold mb-4">Popular Cities</h4>
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
