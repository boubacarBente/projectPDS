'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePermission } from '@/components/role-gate';
import { useBranch } from '@/components/filiales/branch-context';
import { StoreScopeSelect, scopeShowsStore, useStoreScope, type StoreScopeValue } from '@/components/store-scope';
import { branchColorClasses } from '@/lib/branches-shared';

/**
 * Portée de magasins **commune aux écrans d'une filiale** (README §30, §31) :
 * une préférence par filiale (`pd-scope:filiale-<id>`), affichée dans la barre
 * d'onglets. `withStore(url)` ajoute `store=` aux lectures ; une écriture va
 * toujours dans le magasin actif.
 */
export function useBrickScope() {
  const { branch } = useBranch();
  const { scope, setScope, param } = useStoreScope(`filiale-${branch.id}`);
  const withStore = useCallback(
    (url: string) => (param ? `${url}${url.includes('?') ? '&' : '?'}store=${encodeURIComponent(param)}` : url),
    [param],
  );
  return { scope, setScope, storeParam: param, withStore, showStore: scopeShowsStore(scope) };
}

/**
 * Sous-navigation de l'espace d'une **filiale de production**.
 *
 * Chaque filiale a **une** entrée dans le menu latéral (son nom : « Briqueterie »,
 * « Vitrerie »…) ; ses écrans sont des onglets, ce qui évite d'allonger un menu
 * déjà long sur mobile.
 *
 * Chaque onglet porte la **même permission que sa page** : un onglet visible
 * mais inaccessible serait un faux espoir (le serveur reste seul juge —
 * masquer n'est pas protéger).
 */

type Tab = {
  path: string;
  label: string;
  action: 'brick.view' | 'sales.view' | 'customers.view' | 'reports' | 'inventory.view' | 'expenses.view' | 'cash.view' | 'atelier';
};

/** Onglets d'une filiale, dans l'ordre du cahier des charges (README §31.2). */
const TABS: Tab[] = [
  { path: '', label: 'Tableau de bord', action: 'brick.view' },
  { path: '/modeles', label: 'Modèles', action: 'brick.view' },
  { path: '/productions', label: 'Productions', action: 'brick.view' },
  { path: '/stock', label: 'Stock', action: 'brick.view' },
  { path: '/inventaire', label: 'Inventaire', action: 'inventory.view' },
  { path: '/commandes', label: 'Commandes', action: 'brick.view' },
  { path: '/ventes', label: 'Ventes', action: 'sales.view' },
  { path: '/depenses', label: 'Dépenses', action: 'expenses.view' },
  { path: '/caisse', label: 'Caisse', action: 'cash.view' },
  { path: '/clients', label: 'Clients', action: 'customers.view' },
  // Rapport complet = rentabilité comprise : rapports et soldes requis.
  { path: '/rapports', label: 'Rapports', action: 'reports' },
  { path: '/parametres', label: 'Paramètres', action: 'brick.view' },
  // Historique de l'ancien module /atelier (README §31.9) : filiale « Meubles » seulement.
  { path: '/atelier', label: 'Atelier (historique)', action: 'atelier' },
];

export function BrickTabs({
  scope,
  onScopeChange,
}: {
  scope?: StoreScopeValue;
  onScopeChange?: (value: StoreScopeValue) => void;
} = {}) {
  const pathname = usePathname() ?? '';
  const { branch, href, writable, canLevel } = useBranch();
  const canViewSales = usePermission('sales.view');
  const canCreateSales = usePermission('sales.create');
  const canViewCustomers = usePermission('customers.view');
  const canViewInventory = usePermission('inventory.view');
  const canViewExpenses = usePermission('expenses.view');
  const canViewCash = usePermission('cash.view');
  const canViewAllReports = usePermission('reports.viewAll');
  const canViewBalances = usePermission('balances.view');
  const canViewReports = canViewAllReports && canViewBalances;
  const color = branchColorClasses(branch.color);

  const visible = TABS.filter((tab) => {
    if (tab.action === 'sales.view') return canViewSales;
    if (tab.action === 'customers.view') return canViewCustomers;
    if (tab.action === 'reports') return canViewReports;
    if (tab.action === 'inventory.view') return canViewInventory;
    if (tab.action === 'expenses.view') return canViewExpenses;
    if (tab.action === 'cash.view') return canViewCash;
    if (tab.action === 'atelier') return branch.activity === 'furniture';
    return true;
  });

  /** « Actif » = le préfixe le plus long qui corresponde (sinon le tableau de bord l'emporte partout). */
  const activePath = visible
    .map((tab) => ({ tab, full: href(tab.path) }))
    .filter(({ full }) => pathname === full || pathname.startsWith(`${full}/`))
    .sort((a, b) => b.full.length - a.full.length)[0]?.tab.path;

  return (
    <div className="flex flex-col gap-2">
      {!writable && (
        <div role="status" className="alert alert-warning py-2 text-sm">
          La filiale « {branch.name} » est {branch.status === 'archived' ? 'archivée' : 'suspendue'} : son historique se consulte, mais
          aucune nouvelle opération n’est acceptée.
        </div>
      )}
      {/* Treize onglets : ils ont leur propre ligne (défilante), les commandes au-dessus. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className={`hidden items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold lg:inline-flex ${color.soft}`}>
            <span aria-hidden="true" className={`h-2 w-2 rounded-full ${color.dot}`} />
            {branch.name}
          </span>
          {canCreateSales && writable && canLevel('edit') && (
            <Link href={`/ventes/nouvelle?filiale=${branch.id}`} className="btn btn-primary btn-sm min-h-11">
              Nouvelle vente
            </Link>
          )}
          {scope !== undefined && onScopeChange && (
            <StoreScopeSelect value={scope} onChange={onScopeChange} className="min-h-11 w-full sm:w-56" />
          )}
        </div>
      </div>
      <nav aria-label={`Navigation de la filiale ${branch.name}`} className="-mb-px min-w-0 overflow-x-auto">
        <ul className="flex min-w-max items-center gap-1 border-b border-base-200">
          {visible.map((tab) => {
            const isActive = tab.path === activePath;
            return (
              <li key={tab.path || 'dashboard'}>
                <Link
                  href={href(tab.path)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`inline-flex min-h-11 items-center whitespace-nowrap rounded-t-lg border-b-2 px-3 text-sm font-medium transition-colors ${
                    isActive
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-transparent text-base-content/70 hover:border-base-300 hover:bg-base-200/60 hover:text-base-content'
                  }`}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
