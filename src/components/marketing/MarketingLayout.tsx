import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useTranslation } from 'react-i18next';

interface MarketingLayoutProps {
  children: React.ReactNode;
}

export default function MarketingLayout({ children }: MarketingLayoutProps) {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { t } = useTranslation('marketing');

  const navLinks = [
    { href: '/', label: t('nav.home') },
    { href: '/pricing', label: t('nav.pricing') },
    { href: '/about', label: t('nav.about') },
    { href: '/blog', label: t('nav.blog') },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-4">
          <div className="flex h-16 items-center justify-between">
            {/* Logo */}
            <Link to="/" className="flex items-center gap-2">
              <span className="font-bold text-xl tracking-tight">
                PadelTrainer<span className="text-primary">.ai</span>
              </span>
            </Link>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-8">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  to={link.href}
                  className={`text-sm font-medium transition-colors hover:text-primary ${
                    location.pathname === link.href
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
                <Link to="/auth">{t('nav.signIn')}</Link>
              </Button>
              <Button asChild className="bg-primary hover:bg-primary/90">
                <Link to="/signup/player">{t('nav.getStarted')}</Link>
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
                      location.pathname === link.href
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
                    <Link to="/auth">{t('nav.signIn')}</Link>
                  </Button>
                  <Button asChild className="bg-primary hover:bg-primary/90">
                    <Link to="/signup/player">{t('nav.getStarted')}</Link>
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
              <Link to="/" className="flex items-center gap-2 mb-4">
                <span className="font-bold text-lg">
                  PadelTrainer<span className="text-primary">.ai</span>
                </span>
              </Link>
              <p className="text-sm text-muted-foreground">
                {t('footer.tagline')}
              </p>
            </div>

            {/* Links */}
            <div>
              <h4 className="font-semibold mb-4">{t('footer.platform')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><Link to="/trainers" className="hover:text-primary transition-colors">{t('footer.findTrainers')}</Link></li>
                <li><Link to="/locations" className="hover:text-primary transition-colors">{t('footer.locations')}</Link></li>
                <li><Link to="/pricing" className="hover:text-primary transition-colors">{t('nav.pricing')}</Link></li>
                <li><Link to="/blog" className="hover:text-primary transition-colors">{t('nav.blog')}</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold mb-4">{t('footer.company')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><Link to="/about" className="hover:text-primary transition-colors">{t('footer.aboutUs')}</Link></li>
                <li><a href="mailto:hello@padeltrainer.ai" className="hover:text-primary transition-colors">{t('footer.contact')}</a></li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold mb-4">{t('footer.legal')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><Link to="/privacy" className="hover:text-primary transition-colors">{t('footer.privacyPolicy')}</Link></li>
                <li><Link to="/terms" className="hover:text-primary transition-colors">{t('footer.termsOfService')}</Link></li>
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
