import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export interface CookieConsent {
  necessary: boolean;   // Always true (session, auth)
  analytics: boolean;   // Google Analytics
  preferences: boolean; // Sidebar state, theme
}

interface CookieConsentContextType {
  consent: CookieConsent | null;
  hasResponded: boolean;
  acceptAll: () => void;
  rejectNonEssential: () => void;
  savePreferences: (consent: CookieConsent) => void;
}

const defaultConsent: CookieConsent = {
  necessary: true,
  analytics: false,
  preferences: false,
};

const CookieConsentContext = createContext<CookieConsentContextType>({
  consent: null,
  hasResponded: false,
  acceptAll: () => {},
  rejectNonEssential: () => {},
  savePreferences: () => {},
});

const CONSENT_KEY = 'cookie-consent';

export function CookieConsentProvider({ children }: { children: ReactNode }) {
  const [consent, setConsent] = useState<CookieConsent | null>(null);
  const [hasResponded, setHasResponded] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(CONSENT_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as CookieConsent;
        setConsent(parsed);
        setHasResponded(true);
      } catch {
        // Invalid stored value, reset
        localStorage.removeItem(CONSENT_KEY);
      }
    }
  }, []);

  const saveToStorage = (newConsent: CookieConsent) => {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(newConsent));
    setConsent(newConsent);
    setHasResponded(true);
    
    // Dispatch event for analytics initialization
    window.dispatchEvent(new CustomEvent('cookie-consent-updated', { 
      detail: newConsent 
    }));
  };

  const acceptAll = () => {
    saveToStorage({
      necessary: true,
      analytics: true,
      preferences: true,
    });
  };

  const rejectNonEssential = () => {
    saveToStorage({
      necessary: true,
      analytics: false,
      preferences: false,
    });
  };

  const savePreferences = (newConsent: CookieConsent) => {
    saveToStorage({
      ...newConsent,
      necessary: true, // Always required
    });
  };

  return (
    <CookieConsentContext.Provider 
      value={{ 
        consent, 
        hasResponded, 
        acceptAll, 
        rejectNonEssential, 
        savePreferences 
      }}
    >
      {children}
    </CookieConsentContext.Provider>
  );
}

export function useCookieConsent() {
  const context = useContext(CookieConsentContext);
  if (!context) {
    throw new Error('useCookieConsent must be used within a CookieConsentProvider');
  }
  return context;
}
