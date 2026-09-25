'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { useSettings } from '@/app/parametres/page';
import { useTheme } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import { useAuth } from '@/components/auth-provider';
import { AppVersionDisplay } from '@/components/update-status';
import { SyncIndicator } from '@/components/sync-indicator';
import { NavIcon } from '@/components/nav-icons';
import { Tooltip } from '@/components/tooltip';
import { NAVIGATION, STORAGE_KEYS, labelForPath } from '@/lib/navigation';
// `ROLE_LABELS` vient de `lib/permissions.ts` (module **client-safe**) ; la
// décision d'accès vient du contexte d'authentification, donc des permissions
// **effectives** (matrice du rôle + surcharges par utilisateur).
import { ROLE_LABELS } from '@/lib/permissions';
import { applyThemeColors } from '@/lib/colors';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * Coquille de l'application : sidebar à **6 groupes et repliable**, drawer
 * mobile, carte utilisateur (README §5.4).
 *
 * Améliorations assumées par rapport au projet Gaz :
 *  - navigation **groupée** (18 modules : un menu à plat serait illisible) ;
 *  - sidebar **repliable** en icônes seules, état mémorisé **localement** ;
 *  - menu **filtré par permission** (`lib/permissions.ts`) ;
 *  - élément actif signalé par **deux indices** simultanés (bord + fond) et
 *    jamais par la couleur seule — accessibilité daltonisme ;
 *  - `aria-current="page"`, infobulles et `aria-label` sur chaque bouton-icône.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { settings, isLoading: isSettingsLoading, updateSettings } = useSettings();
  const { theme, isLoading: isThemeLoading } = useTheme();
  const { user, isLoading: isAuthLoading, logout, can } = useAuth();
  const isDark = theme === 'dark';
  const displayName = settings.companyName || 'Planète Déco';
  const branch = settings.companyBranch || 'Filiale Meubles';

  // État de repli : restauré localement (préférence d'affichage, non synchronisée).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.sidebarCollapsed);
      if (stored === 'true') setCollapsed(true);
      else if (stored === 'false') setCollapsed(false);
      else if (settings.sidebarCollapsed) setCollapsed(true);
    } catch {
      /* localStorage indisponible : on garde le défaut déployé. */
    }
  }, [settings.sidebarCollapsed]);

  /**
   * Applique les couleurs configurées (README §5.3, §9.1).
   *
   * C'est ici, et non dans le `SettingsProvider` : le fournisseur de thème est
   * monté **sous** celui des paramètres, donc seul un composant situé à
   * l'intérieur des deux connaît à la fois la couleur choisie et le mode
   * clair/sombre — indispensable au calcul des couleurs de base.
   */
  useEffect(() => {
    try {
      applyThemeColors(settings.primaryColor, settings.sidebarColor, theme === 'dark');
    } catch {
      /* une couleur invalide ne doit pas empêcher l'application de s'afficher */
    }
  }, [settings.primaryColor, settings.sidebarColor, theme]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, String(next));
      } catch {
        /* sans effet : le repli reste fonctionnel pour la session */
      }
      // Persisté dans les réglages **locaux** (§23.9) sans bloquer l'interface.
      void updateSettings({ sidebarCollapsed: next }, { silent: true }).catch(() => {});
      return next;
    });
  }, [updateSettings]);

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  // La page de connexion se rend sans coquille : aucune sidebar, aucun en-tête.
  if (pathname === '/login') {
    return <>{children}</>;
  }

  if (isAuthLoading || isSettingsLoading || isThemeLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-100">
        <span className="loading loading-spinner loading-lg text-base-content/30" />
      </div>
    );
  }

  /** Groupes visibles pour le rôle courant. Un groupe sans entrée disparaît. */
  const visibleGroups = NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => can(item.action)),
  })).filter((group) => group.items.length > 0);

  const navLinkClass = (active: boolean) =>
    `group relative flex items-center rounded-xl transition-colors duration-200 ${
      collapsed ? 'justify-center px-0 py-3' : 'gap-3 px-4 py-2.5'
    }`;

  const navLinkStyle = (active: boolean): React.CSSProperties => ({
    backgroundColor: active ? 'var(--sidebar-active)' : 'transparent',
    color: active ? 'var(--sidebar-text)' : 'var(--sidebar-text-muted)',
  });

  return (
    <div className="flex min-h-screen">
      {/* ------------------------------- Sidebar (desktop) ------------------------------- */}
      <aside
        className={`no-print hidden min-h-screen flex-col transition-[width] duration-200 lg:flex ${
          collapsed ? 'w-20' : 'w-72'
        }`}
        style={{ backgroundColor: 'var(--sidebar-color)', color: 'var(--sidebar-text)' }}
      >
        {/* Identité : logo + nom + filiale */}
        <div
          className={`flex items-center border-b ${collapsed ? 'justify-center px-2 py-5' : 'gap-3 px-5 py-5'}`}
          style={{ borderColor: 'var(--sidebar-border)' }}
        >
          <Link href="/" className="flex items-center gap-3" aria-label="Accueil">
            <Image
              src="/logo.jpg"
              alt=""
              width={collapsed ? 32 : 40}
              height={collapsed ? 32 : 40}
              className="shrink-0 rounded-lg"
            />
            {!collapsed && (
              <div className="min-w-0">
                <h1 className="truncate text-base font-bold leading-tight" style={{ color: 'var(--sidebar-text)' }}>
                  {displayName}
                </h1>
                <p className="truncate text-[11px]" style={{ color: 'var(--sidebar-text-muted)' }}>
                  {branch}
                </p>
              </div>
            )}
          </Link>
        </div>

        {/* Navigation groupée */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-4" aria-label="Navigation principale">
          {visibleGroups.map((group) => (
            <div key={group.title} className="mb-4">
              {collapsed ? (
                <div
                  className="mx-auto mb-2 h-px w-8"
                  style={{ backgroundColor: 'var(--sidebar-border)' }}
                  aria-hidden
                />
              ) : (
                <h2
                  className="mb-1.5 px-3 text-[11px] font-bold uppercase tracking-wider"
                  style={{ color: 'var(--sidebar-text-muted)' }}
                >
                  {group.title}
                </h2>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = isActive(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={navLinkClass(active)}
                        style={navLinkStyle(active)}
                        aria-current={active ? 'page' : undefined}
                        title={collapsed ? item.label : undefined}
                        aria-label={collapsed ? item.label : undefined}
                      >
                        {/* Indice 1 : bord gauche accentué (jamais la couleur seule) */}
                        {active && (
                          <span
                            className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r"
                            style={{ backgroundColor: 'var(--color-primary)' }}
                            aria-hidden
                          />
                        )}
                        <span className="shrink-0" style={{ color: active ? 'var(--color-primary)' : 'inherit' }}>
                          <NavIcon iconKey={item.iconKey} />
                        </span>
                        {!collapsed && <span className="truncate text-sm font-medium">{item.label}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Pied : carte utilisateur */}
        <div className="border-t p-3" style={{ borderColor: 'var(--sidebar-border)' }}>
          {user && (
            <div className="mb-3 flex items-center gap-3 px-1" title={collapsed ? user.name : undefined}>
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold"
                style={{ background: 'linear-gradient(135deg, var(--p-color), var(--s-color))', color: '#fff' }}
              >
                {user.name.charAt(0).toUpperCase()}
              </div>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" style={{ color: 'var(--sidebar-text)' }}>
                    {user.name}
                  </p>
                  <p className="truncate text-[11px]" style={{ color: 'var(--sidebar-text-muted)' }}>
                    {ROLE_LABELS[user.role] ?? user.role}
                  </p>
                </div>
              )}
            </div>
          )}

          <div className={`mb-2 flex items-center gap-2 ${collapsed ? 'flex-col' : 'justify-between'} px-1`}>
            {!collapsed && (
              <span className="text-[11px]" style={{ color: 'var(--sidebar-text-muted)' }}>
                Thème
              </span>
            )}
            <ThemeToggle />
          </div>

          <div className={`mb-2 ${collapsed ? 'flex justify-center' : 'px-1'}`}>
            <AppVersionDisplay />
          </div>

          <div className={`mb-3 ${collapsed ? 'flex justify-center' : 'px-1'}`}>
            <SyncIndicator collapsed={collapsed} />
          </div>

          {can('settings.view') && (
            <Tooltip label="Paramètres">
              <Link
                href="/parametres"
                className="btn btn-sm mb-2 w-full border-0 text-white"
                style={{ background: 'linear-gradient(135deg, var(--p-color), var(--s-color))' }}
                aria-label="Paramètres"
              >
                <NavIcon iconKey="settings" className="h-4 w-4" />
                {!collapsed && 'Paramètres'}
              </Link>
            </Tooltip>
          )}

          <button
            type="button"
            onClick={toggleCollapsed}
            className="btn btn-ghost btn-sm mb-2 w-full"
            style={{ color: 'var(--sidebar-text-muted)' }}
            aria-label={collapsed ? 'Déployer le menu' : 'Replier le menu'}
            title={collapsed ? 'Déployer le menu' : 'Replier le menu'}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-4 w-4 transition-transform ${collapsed ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
            {!collapsed && 'Replier'}
          </button>

          <button
            type="button"
            onClick={() => void logout()}
            className="btn btn-ghost btn-sm w-full"
            style={{ color: 'var(--sidebar-text-muted)' }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
            {!collapsed && 'Déconnexion'}
          </button>
        </div>
      </aside>

      {/* ------------------------------- En-tête mobile ------------------------------- */}
      <div className="no-print fixed left-0 right-0 top-0 z-50 flex h-16 items-center justify-between border-b border-base-200 bg-base-100 px-4 shadow-sm sm:px-6 lg:hidden">
        <Link href="/" className="flex min-w-0 items-center gap-2">
          <Image src="/logo.jpg" alt="" width={32} height={32} className="rounded" />
          <span className="truncate text-sm font-bold">{displayName}</span>
        </Link>
        <div className="flex items-center gap-1">
          <Tooltip label="Recharger la page">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="btn btn-ghost btn-sm btn-square text-base-content/60"
              aria-label="Recharger la page"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
          </Tooltip>
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            className="btn btn-ghost btn-sm btn-square"
            aria-label={mobileMenuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
            aria-expanded={mobileMenuOpen}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              {mobileMenuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* ------------------------------- Drawer mobile ------------------------------- */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.aside
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.1 }}
              className="fixed right-0 top-0 z-50 h-full w-80 overflow-y-auto shadow-2xl sm:w-96 lg:hidden"
              style={{ backgroundColor: 'var(--sidebar-color)', color: 'var(--sidebar-text)' }}
            >
              <div
                className="flex items-center justify-between border-b p-4"
                style={{ borderColor: 'var(--sidebar-border)' }}
              >
                <Link href="/" className="flex items-center gap-2" onClick={() => setMobileMenuOpen(false)}>
                  <Image src="/logo.jpg" alt="" width={28} height={28} className="rounded" />
                  <span className="text-sm font-bold" style={{ color: 'var(--sidebar-text)' }}>
                    {displayName}
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="btn btn-ghost btn-sm btn-square"
                  style={{ color: 'var(--sidebar-text)' }}
                  aria-label="Fermer le menu"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <nav className="p-4" aria-label="Navigation mobile">
                {visibleGroups.map((group) => (
                  <div key={group.title} className="mb-4">
                    <h2
                      className="mb-1.5 px-3 text-[11px] font-bold uppercase tracking-wider"
                      style={{ color: 'var(--sidebar-text-muted)' }}
                    >
                      {group.title}
                    </h2>
                    <ul className="space-y-0.5">
                      {group.items.map((item) => {
                        const active = isActive(item.href);
                        return (
                          <li key={item.href}>
                            <Link
                              href={item.href}
                              onClick={() => setMobileMenuOpen(false)}
                              className="relative flex items-center gap-3 rounded-xl px-4 py-3 transition-colors"
                              style={{
                                backgroundColor: active ? 'var(--sidebar-active)' : 'transparent',
                                color: active ? 'var(--sidebar-text)' : 'var(--sidebar-text-muted)',
                              }}
                              aria-current={active ? 'page' : undefined}
                            >
                              {active && (
                                <span
                                  className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r"
                                  style={{ backgroundColor: 'var(--color-primary)' }}
                                  aria-hidden
                                />
                              )}
                              <span style={{ color: active ? 'var(--color-primary)' : 'inherit' }}>
                                <NavIcon iconKey={item.iconKey} />
                              </span>
                              <span className="text-sm font-medium">{item.label}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </nav>

              <div
                className="space-y-3 border-t p-4"
                style={{ borderColor: 'var(--sidebar-border)' }}
              >
                {user && (
                  <div className="mb-2 flex items-center gap-3 px-3">
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold text-white"
                      style={{ background: 'linear-gradient(135deg, var(--p-color), var(--s-color))' }}
                    >
                      {user.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" style={{ color: 'var(--sidebar-text)' }}>
                        {user.name}
                      </p>
                      <p className="truncate text-[11px]" style={{ color: 'var(--sidebar-text-muted)' }}>
                        {ROLE_LABELS[user.role] ?? user.role}
                      </p>
                    </div>
                  </div>
                )}
                <SyncIndicator />
                <AppVersionDisplay />
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="btn btn-ghost btn-sm w-full"
                  style={{ color: 'var(--sidebar-text-muted)' }}
                >
                  Déconnexion
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ------------------------------- Contenu ------------------------------- */}
      {/*
       * `min-w-0` est **obligatoire** ici.
       *
       * Un élément flex a `min-width: auto` par défaut : il refuse de rétrécir
       * sous la largeur minimale de son contenu. Un tableau large (liste des
       * stocks, des modèles, des achats…) imposait donc à `main` une largeur
       * supérieure à la place restante, et **toute la page débordait
       * horizontalement** — barre de défilement en bas, contenu coupé à droite.
       * Avec `min-w-0`, `main` se limite à la place disponible ; c'est ensuite
       * au tableau de défiler dans sa propre carte (`ResponsiveTable`).
       */}
      <main className="min-w-0 min-h-screen flex-1 bg-base-100 pt-16 lg:pt-0">
        <div className="mx-auto min-w-0 max-w-7xl p-4 sm:p-6 lg:p-8">{children}</div>
      </main>
    </div>
  );
}

/** Titre du document, exposé pour les pages qui veulent un en-tête homogène. */
export { labelForPath };
