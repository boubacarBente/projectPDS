'use client';

import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { defaultSettings, useSettings } from '@/app/parametres/page';
import { useAuth } from '@/components/auth-provider';
import { applyThemeColors } from '@/lib/colors';

const THEME_KEY = 'app-theme';

type ThemeContextType = {
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
  isLoading: boolean;
};

const ThemeContext = createContext<ThemeContextType>({
  theme: 'light',
  setTheme: () => {},
  isLoading: true,
});

export const useTheme = () => useContext(ThemeContext);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const { settings, updateSettings, isLoading: isSettingsLoading } = useSettings();
  const [theme, setTheme] = useState<'light' | 'dark'>(defaultSettings.theme);
  const [isLoading, setIsLoading] = useState(true);

  const applyTheme = useCallback(
    (nextTheme: 'light' | 'dark', primaryColor = settings.primaryColor, sidebarColor = settings.sidebarColor) => {
      document.documentElement.setAttribute('data-theme', nextTheme);
      document.documentElement.classList.toggle('dark', nextTheme === 'dark');
      applyThemeColors(
        primaryColor || defaultSettings.primaryColor,
        sidebarColor || defaultSettings.sidebarColor,
        nextTheme === 'dark',
      );
    },
    [settings.primaryColor, settings.sidebarColor],
  );

  useEffect(() => {
    if (isAuthLoading || (user && isSettingsLoading)) {
      setIsLoading(true);
      return;
    }

    const nextTheme = user
      ? settings.theme || defaultSettings.theme
      : (localStorage.getItem(THEME_KEY) as 'light' | 'dark' | null) || defaultSettings.theme;

    setTheme(nextTheme);
    applyTheme(nextTheme, settings.primaryColor, settings.sidebarColor);
    localStorage.setItem(THEME_KEY, nextTheme);
    setIsLoading(false);
  }, [
    applyTheme,
    isAuthLoading,
    isSettingsLoading,
    settings.primaryColor,
    settings.sidebarColor,
    settings.theme,
    user,
  ]);

  const handleSetTheme = async (nextTheme: 'light' | 'dark') => {
    setTheme(nextTheme);
    applyTheme(nextTheme);
    localStorage.setItem(THEME_KEY, nextTheme);

    toast.success(`Theme applique: ${nextTheme === 'dark' ? 'Mode Nuit' : 'Mode Jour'}`, {
      position: 'top-right',
      autoClose: 3000,
      hideProgressBar: false,
      closeOnClick: true,
      pauseOnHover: true,
      draggable: true,
      progress: undefined,
      theme: nextTheme,
    });

    try {
      await updateSettings({ theme: nextTheme }, { silent: true });
    } catch {
      // Le theme local reste applique meme si la sauvegarde echoue.
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme: handleSetTheme, isLoading }}>
      {children}
    </ThemeContext.Provider>
  );
}
