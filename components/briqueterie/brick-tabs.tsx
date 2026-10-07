'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePermission } from '@/components/role-gate';
import { StoreScopeSelect, scopeShowsStore, useStoreScope, type StoreScopeValue } from '@/components/store-scope';

/**
 * Portée de magasins **commune aux écrans de la briqueterie** (README §30) :
 * une seule préférence (`pd-scope:briqueterie`), affichée dans la barre
 * d'onglets. `withStore(url)` ajoute `store=` aux lectures ; une écriture va
 * toujours dans le magasin actif.
 */
export function useBrickScope() {
  const { scope, setScope, param } = useStoreScope('briqueterie');
  const withStore = useCallback(
    (url: string) => (param ? `${url}${url.includes('?') ? '&' : '?'}store=${encodeURIComponent(param)}` : url),
    [param],
  );
  return { scope, setScope, storeParam: param, withStore, showStore: scopeShowsStore(scope) };
}

/**
 * Sous-navigation du module **Briqueterie**.
 *
 * Pourquoi une barre d'onglets plutôt que six entrées de plus dans le menu
 * latéral : le menu compte déjà 19 modules (§5.4) et la briqueterie est *un*
 * module métier. Ses écrans sont donc regroupés ici, sous une seule entrée
 * « Briqueterie », ce qui évite d'allonger un menu déjà long sur mobile.
 *
 * Chaque onglet porte la **même permission que sa page** : un onglet visible
 * mais inaccessible serait un faux espoir (le serveur reste de toute façon seul
 * juge — masquer n'est pas protéger).
 */

type Tab = {
  href: string;
  label: string;
  /** Préfixe reconnu comme « actif » (permet `/briqueterie/commandes/12`). */
  match: string;
  /** `null` = aucune permission particulière au-delà de `brick.view`. */
  action: 'brick.view' | 'sales.view' | 'reports';
};

const TABS: Tab[] = [
  { href: '/briqueterie', label: 'Tableau de bord', match: '/briqueterie', action: 'brick.view' },
  {
    href: '/briqueterie/productions',
    label: 'Productions',
    match: '/briqueterie/productions',
    action: 'brick.view',
  },
  {
    href: '/briqueterie/stock',
    label: 'Stock',
    match: '/briqueterie/stock',
    action: 'brick.view',
  },
  {
    href: '/briqueterie/commandes',
    label: 'Commandes',
    match: '/briqueterie/commandes',
    action: 'brick.view',
  },
  {
    href: '/briqueterie/ventes',
    label: 'Ventes',
    match: '/briqueterie/ventes',
    action: 'sales.view',
  },
  {
    href: '/briqueterie/rapports',
    label: 'Rapports',
    match: '/briqueterie/rapports',
    // Rapport complet = rentabilité comprise : rapports et soldes requis.
    action: 'reports',
  },
];

export function BrickTabs({
  scope,
  onScopeChange,
}: {
  scope?: StoreScopeValue;
  onScopeChange?: (value: StoreScopeValue) => void;
} = {}) {
  const pathname = usePathname() ?? '';
  const canViewSales = usePermission('sales.view');
  const canViewAllReports = usePermission('reports.viewAll');
  const canViewBalances = usePermission('balances.view');
  const canViewReports = canViewAllReports && canViewBalances;

  const visible = TABS.filter((tab) => {
    if (tab.action === 'sales.view') return canViewSales;
    if (tab.action === 'reports') return canViewReports;
    return true;
  });

  /** « Actif » = le préfixe le plus long qui corresponde (sinon le tableau de bord l'emporte partout). */
  const activeHref = visible
    .filter((tab) => pathname === tab.match || pathname.startsWith(`${tab.match}/`))
    .sort((a, b) => b.match.length - a.match.length)[0]?.href;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
    <nav aria-label="Navigation de la briqueterie" className="-mb-px min-w-0 overflow-x-auto">
      <ul className="flex min-w-max items-center gap-1 border-b border-base-200">
        {visible.map((tab) => {
          const isActive = tab.href === activeHref;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={isActive ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors ${
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-base-content/60 hover:border-base-300 hover:text-base-content'
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
    {scope !== undefined && onScopeChange && (
      <StoreScopeSelect value={scope} onChange={onScopeChange} className="min-h-11 w-full sm:w-56" />
    )}
    </div>
  );
}
