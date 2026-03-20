import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { AnimatePresence, motion } from 'framer-motion';
import { Menu, X, Linkedin, Facebook, Instagram, Youtube, BookOpen, Target, MapPin, GraduationCap, Video, PenLine, Dumbbell, DollarSign, Rocket, Users, Building, Handshake } from 'lucide-react';
import { useState } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useTranslation } from 'react-i18next';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useLocalizedPath } from '@/hooks/useLocalizedPath';
import { getAppUrl } from '@/lib/domains';
import { useAuth } from '@/hooks/useAuth';
import { Logo } from '@/components/Logo';
import { captureUtmParams } from '@/lib/utm';
import { MegaMenu, MegaMenuMobile } from '@/components/marketing/MegaMenu';

const getDashboardPath = (role?: string | null) => {
  switch (role) {
    case 'trainer': return '/trainer';
    case 'club': return '/club';
    case 'academy': return '/academy';
    default: return '/player';
  }
};

interface MarketingLayoutProps {
  children: React.ReactNode;
}

export default function MarketingLayout({ children }: MarketingLayoutProps) {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { t } = useTranslation('marketing');
  const { user, role, loading: authLoading } = useAuth();
  const dashboardUrl = getAppUrl(getDashboardPath(role));

  useEffect(() => {
    captureUtmParams();
  }, []);

  const pricingPath = useLocalizedPath('/pricing');
  const aboutPath = useLocalizedPath('/about');
  const blogPath = useLocalizedPath('/blog');

  const closeMobile = () => setMobileMenuOpen(false);

  // Players mega menu columns
  const playersColumns = [
    {
      title: t('footer.learnPadel', 'Learn Padel'),
      items: [
        { to: '/padel-rules', label: t('nav.rules', 'Padel Rules'), description: t('megamenu.rulesDesc', 'Official rules explained'), icon: <BookOpen className="h-4 w-4" /> },
        { to: '/padel-strokes', label: t('nav.strokes', 'Padel Strokes'), description: t('megamenu.strokesDesc', 'Master every technique'), icon: <Target className="h-4 w-4" /> },
        { to: '/padel-coaches', label: t('footer.coaches', 'Coaches'), description: t('megamenu.coachesDesc', 'Expert coaching guides'), icon: <GraduationCap className="h-4 w-4" /> },
      ],
    },
    {
      title: t('megamenu.findAndPlay', 'Find & Play'),
      items: [
        { to: '/trainers', label: t('footer.findTrainers', 'Find Trainers'), description: t('megamenu.trainersDesc', 'Book a session near you'), icon: <Dumbbell className="h-4 w-4" /> },
        { to: '/locations', label: t('footer.locations', 'Find Club'), description: t('megamenu.locationsDesc', 'Discover padel clubs'), icon: <MapPin className="h-4 w-4" /> },
        { to: '/academies', label: t('footer.academies', 'Academies'), description: t('megamenu.academiesDesc', 'Join an academy'), icon: <Building className="h-4 w-4" /> },
      ],
    },
    {
      title: t('megamenu.content', 'Content'),
      items: [
        { to: '/video-tips', label: t('footer.videoTips', 'Video Tips'), description: t('megamenu.videoDesc', 'Watch & learn'), icon: <Video className="h-4 w-4" /> },
        { to: '/blog', label: t('nav.blog', 'Blog'), description: t('megamenu.blogDesc', 'News & insights'), icon: <PenLine className="h-4 w-4" /> },
        { to: '/racket-finder', label: t('quiz.title', 'Racket Finder'), description: t('quiz.subtitle', 'Find your perfect racket'), icon: <Target className="h-4 w-4" /> },
      ],
    },
  ];

  // For Trainers mega menu columns
  const trainersColumns = [
    {
      title: t('megamenu.forTrainers', 'For Trainers'),
      items: [
        { to: '/about', label: t('megamenu.platformOverview', 'Platform Overview'), description: t('megamenu.platformDesc', 'How PadelTrainer.ai works'), icon: <Rocket className="h-4 w-4" /> },
        { to: '/pricing', label: t('nav.pricing', 'Pricing'), description: t('megamenu.pricingDesc', 'Plans & pricing'), icon: <DollarSign className="h-4 w-4" /> },
      ],
    },
    {
      title: t('megamenu.forAcademies', 'For Academies'),
      items: [
        { to: '/about', label: t('megamenu.manageTeams', 'Manage Teams'), description: t('megamenu.teamsDesc', 'Organize your trainers'), icon: <Users className="h-4 w-4" /> },
        { to: '/partner', label: t('footer.becomePartner', 'Partner with us'), description: t('megamenu.partnerDesc', 'Grow together'), icon: <Handshake className="h-4 w-4" /> },
      ],
    },
  ];

  const standaloneLinks = [
    { href: pricingPath, label: t('nav.pricing'), path: '/pricing' },
    { href: aboutPath, label: t('nav.about'), path: '/about' },
    { href: blogPath, label: t('nav.blog'), path: '/blog' },
  ];

  const isActive = (path: string) => {
    const currentPath = location.pathname.replace(/^\/(en|nl|es|de|fr)/, '');
    return currentPath === path || (path === '/' && currentPath === '');
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-4">
          <div className="flex h-16 items-center justify-between">
            {/* Logo */}
            <LocalizedLink to="/" className="flex items-center gap-2" aria-label="PadelTrainer.ai home">
              <Logo className="h-7" />
            </LocalizedLink>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-6">
              <MegaMenu label={t('nav.players', 'Players')} columns={playersColumns} />
              <MegaMenu label={t('megamenu.forTrainersNav', 'For Trainers')} columns={trainersColumns} />
              {standaloneLinks.map((link) => (
                <Link
                  key={link.href}
                  to={link.href}
                  className={`text-sm font-medium transition-colors hover:text-foreground ${
                    isActive(link.path) ? 'text-foreground' : 'text-muted-foreground'
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
                    <Link to={getAppUrl('/signup/trainer')}>{t('homev2.cta.startTrial', 'Start free trial')}</Link>
                  </Button>
                </>
              )}
            </div>

            {/* Mobile Menu Button */}
            <button
              className="md:hidden p-2 min-h-[48px] min-w-[48px] flex items-center justify-center"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            >
              {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>

          {/* Mobile Menu */}
          <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="md:hidden py-4 border-t"
            >
              <nav className="flex flex-col gap-4">
                <MegaMenuMobile label={t('nav.players', 'Players')} columns={playersColumns} onNavigate={closeMobile} />
                <MegaMenuMobile label={t('megamenu.forTrainersNav', 'For Trainers')} columns={trainersColumns} onNavigate={closeMobile} />

                {standaloneLinks.map((link) => (
                  <Link
                    key={link.href}
                    to={link.href}
                    onClick={closeMobile}
                    className={`text-sm font-medium transition-colors hover:text-foreground ${
                      isActive(link.path) ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {link.label}
                  </Link>
                ))}
                <div className="flex flex-col gap-2 pt-4 border-t">
                  <div className="flex items-center gap-2">
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
                        <Link to={getAppUrl('/signup/trainer')}>{t('homev2.cta.startTrial', 'Start free trial')}</Link>
                      </Button>
                    </>
                  )}
                </div>
              </nav>
            </motion.div>
          )}
          </AnimatePresence>
        </div>
      </header>

      {/* Main Content */}
      <main>{children}</main>

      {/* Footer */}
      <footer className="border-t bg-muted text-foreground">
        <div className="container mx-auto px-4 py-12">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-8">
            {/* Brand */}
            <div className="col-span-2 md:col-span-3 lg:col-span-1">
              <LocalizedLink to="/" className="flex items-center gap-2 mb-4" aria-label="PadelTrainer.ai home">
                <Logo className="h-6" />
              </LocalizedLink>
              <p className="text-sm text-muted-foreground">
                {t('footer.tagline')}
              </p>
              <div className="flex gap-3 mt-4">
                <a href="https://www.linkedin.com/company/padel-trainer/" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn" className="text-muted-foreground hover:text-primary transition-colors">
                  <Linkedin className="h-5 w-5" />
                </a>
                <a href="https://www.facebook.com/people/PadelTrainerai/61587581553043/" target="_blank" rel="noopener noreferrer" aria-label="Facebook" className="text-muted-foreground hover:text-primary transition-colors">
                  <Facebook className="h-5 w-5" />
                </a>
                <a href="https://www.instagram.com/padeltrainerai/" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="text-muted-foreground hover:text-primary transition-colors">
                  <Instagram className="h-5 w-5" />
                </a>
                <a href="https://www.youtube.com/@PadelTrainerAI" target="_blank" rel="noopener noreferrer" aria-label="YouTube" className="text-muted-foreground hover:text-primary transition-colors">
                  <Youtube className="h-5 w-5" />
                </a>
                <a href="https://www.tiktok.com/@padeltrainer.ai" target="_blank" rel="noopener noreferrer" aria-label="TikTok" className="text-muted-foreground hover:text-primary transition-colors">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
                    <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/>
                  </svg>
                </a>
              </div>
            </div>

            {/* Platform */}
            <div>
              <h4 className="font-semibold mb-4">{t('footer.platform')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><LocalizedLink to="/trainers" className="hover:text-primary transition-colors">{t('footer.findTrainers')}</LocalizedLink></li>
                <li><LocalizedLink to="/locations" className="hover:text-primary transition-colors">{t('footer.locations')}</LocalizedLink></li>
                <li><LocalizedLink to="/academies" className="hover:text-primary transition-colors">{t('footer.academies', 'Academies')}</LocalizedLink></li>
                <li><LocalizedLink to="/pricing" className="hover:text-primary transition-colors">{t('nav.pricing')}</LocalizedLink></li>
              </ul>
            </div>

            {/* Learn Padel */}
            <div>
              <h4 className="font-semibold mb-4">{t('footer.learnPadel', 'Learn Padel')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><LocalizedLink to="/learn" className="hover:text-primary transition-colors">{t('footer.learnPadel', 'Learn Padel')}</LocalizedLink></li>
                <li><LocalizedLink to="/padel-rules" className="hover:text-primary transition-colors">{t('nav.rules', 'Rules')}</LocalizedLink></li>
                <li><LocalizedLink to="/padel-strokes" className="hover:text-primary transition-colors">{t('nav.strokes', 'Strokes')}</LocalizedLink></li>
                <li><LocalizedLink to="/padel-coaches" className="hover:text-primary transition-colors">{t('footer.coaches', 'Coaches')}</LocalizedLink></li>
                <li><LocalizedLink to="/video-tips" className="hover:text-primary transition-colors">{t('footer.videoTips', 'Video Tips')}</LocalizedLink></li>
                <li><LocalizedLink to="/blog" className="hover:text-primary transition-colors">{t('nav.blog')}</LocalizedLink></li>
                <li><LocalizedLink to="/racket-finder" className="hover:text-primary transition-colors">{t('quiz.title', 'Racket Finder')}</LocalizedLink></li>
              </ul>
            </div>

            {/* Popular Cities */}
            <div>
              <h4 className="font-semibold mb-4">{t('footer.popularCities')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><LocalizedLink to="/trainers/amsterdam" className="hover:text-primary transition-colors">Amsterdam</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/madrid" className="hover:text-primary transition-colors">Madrid</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/barcelona" className="hover:text-primary transition-colors">Barcelona</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/rotterdam" className="hover:text-primary transition-colors">Rotterdam</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/antwerpen" className="hover:text-primary transition-colors">Antwerpen</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/munchen" className="hover:text-primary transition-colors">München</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/koln" className="hover:text-primary transition-colors">Köln</LocalizedLink></li>
                <li><LocalizedLink to="/trainers/valencia" className="hover:text-primary transition-colors">Valencia</LocalizedLink></li>
              </ul>
            </div>

            {/* Company */}
            <div>
              <h4 className="font-semibold mb-4">{t('footer.company')}</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><LocalizedLink to="/about" className="hover:text-primary transition-colors">{t('footer.aboutUs')}</LocalizedLink></li>
                <li><LocalizedLink to="/partner" className="hover:text-primary transition-colors">{t('footer.becomePartner')}</LocalizedLink></li>
                <li><a href="mailto:hello@padeltrainer.ai" className="hover:text-primary transition-colors">{t('footer.contact')}</a></li>
                <li>
                  <Link to={getAppUrl('/signup/club')} className="hover:text-primary transition-colors">{t('footer.registerClub', 'Register your club')}</Link>
                </li>
              </ul>
            </div>

            {/* Legal */}
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
