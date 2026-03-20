import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Globe } from 'lucide-react';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '@/components/LanguageRouter';
import { useTranslationsContext } from '@/contexts/TranslationsContext';

const languages = [
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'nl', name: 'Nederlands', flag: '🇳🇱' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
];

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { lang } = useParams<{ lang: string }>();
  const { translations, pathPrefix } = useTranslationsContext();

  const currentLanguage = languages.find(l => l.code === i18n.language) || languages[0];

  const handleLanguageChange = (newLang: string) => {
    // If we have CMS translations, link to the translated slug
    if (translations.length > 0 && pathPrefix) {
      const translation = translations.find(t => t.language === newLang);
      if (translation) {
        navigate(`/${newLang}/${pathPrefix}/${translation.slug}`);
        i18n.changeLanguage(newLang);
        return;
      }
    }

    // Check if we're on a language-prefixed route
    const isLanguagePrefixedRoute = lang && SUPPORTED_LANGUAGES.includes(lang);
    
    if (isLanguagePrefixedRoute) {
      // Replace the language prefix in the URL
      const pathWithoutLang = location.pathname.replace(/^\/(en|nl|es|de|fr)/, '');
      const newPath = `/${newLang}${pathWithoutLang || ''}${location.search}`;
      navigate(newPath);
    } else {
      // For app routes, just change the i18n language (uses localStorage)
      i18n.changeLanguage(newLang);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Globe className="h-5 w-5" />
          <span className="sr-only">Change language</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {languages.map((language) => {
          // If we have translations, check if this language is available
          const hasTranslation = translations.length === 0 || translations.some(t => t.language === language.code);
          
          return (
            <DropdownMenuItem
              key={language.code}
              onClick={() => handleLanguageChange(language.code)}
              className={i18n.language === language.code ? 'bg-accent' : ''}
              disabled={!hasTranslation}
            >
              <span className="mr-2">{language.flag}</span>
              {language.name}
              {!hasTranslation && <span className="ml-auto text-xs text-muted-foreground">—</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
