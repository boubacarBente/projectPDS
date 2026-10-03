import type { Action } from '@/lib/permissions';

/**
 * Navigation principale : **6 groupes, 19 modules** (README §5.4).
 *
 * Un menu à plat serait illisible avec 18 modules — d'où les groupes. Chaque
 * entrée porte la **permission** qui la rend visible : le menu est filtré par
 * rôle, mais les API vérifient aussi (masquer n'est pas protéger).
 */

export type NavItem = {
  href: string;
  label: string;
  iconKey: IconKey;
  action: Action;
};

export type NavGroup = {
  title: string;
  items: NavItem[];
};

export type IconKey =
  | 'dashboard'
  | 'reports'
  | 'balances'
  | 'sales'
  | 'customers'
  | 'purchases'
  | 'suppliers'
  | 'products'
  | 'stock'
  | 'jobs'
  | 'jobsDashboard'
  | 'requests'
  | 'quotes'
  | 'services'
  | 'workers'
  | 'subcontractors'
  | 'planning'
  | 'stores'
  | 'transfers'
  | 'inventory'
  | 'cash'
  | 'receipts'
  | 'expenses'
  | 'users'
  | 'settings'
  | 'sync';

export const NAVIGATION: NavGroup[] = [
  {
    title: 'Pilotage',
    items: [
      { href: '/', label: 'Tableau de bord', iconKey: 'dashboard', action: 'dashboard.view' },
      { href: '/rapports', label: 'Rapports', iconKey: 'reports', action: 'reports.view' },
      { href: '/soldes', label: 'Soldes', iconKey: 'balances', action: 'balances.view' },
    ],
  },
  {
    title: 'Commercial',
    items: [
      { href: '/ventes', label: 'Ventes', iconKey: 'sales', action: 'sales.view' },
      { href: '/clients', label: 'Clients', iconKey: 'customers', action: 'customers.view' },
      { href: '/achats', label: 'Achats', iconKey: 'purchases', action: 'purchases.view' },
      { href: '/fournisseurs', label: 'Fournisseurs', iconKey: 'suppliers', action: 'suppliers.view' },
    ],
  },
  {
    title: 'Gestion',
    items: [
      { href: '/produits', label: 'Produits', iconKey: 'products', action: 'products.view' },
      { href: '/stocks', label: 'Stocks', iconKey: 'stock', action: 'stock.view' },
      { href: '/transferts', label: 'Transferts', iconKey: 'transfers', action: 'transfers.view' },
      { href: '/inventaires', label: 'Inventaires', iconKey: 'inventory', action: 'inventory.view' },
    ],
  },
  {
    /*
     * Prestations de chantier (cahier « Prestations » §22) : le parcours suit
     * l'ordre du métier — demande, devis, chantier — puis les référentiels
     * (prestations, ouvriers, sous-traitants).
     */
    title: 'Chantiers',
    items: [
      { href: '/chantiers/pilotage', label: 'Pilotage chantiers', iconKey: 'jobsDashboard', action: 'jobs.view' },
      { href: '/chantiers/demandes', label: 'Demandes', iconKey: 'requests', action: 'jobs.view' },
      { href: '/chantiers/devis', label: 'Devis', iconKey: 'quotes', action: 'jobs.view' },
      { href: '/chantiers', label: 'Chantiers', iconKey: 'jobs', action: 'jobs.view' },
      { href: '/chantiers/planning', label: 'Planning', iconKey: 'planning', action: 'jobs.view' },
      { href: '/prestations', label: 'Prestations', iconKey: 'services', action: 'jobs.view' },
      { href: '/ouvriers', label: 'Ouvriers et équipes', iconKey: 'workers', action: 'jobs.view' },
      { href: '/sous-traitants', label: 'Sous-traitants', iconKey: 'subcontractors', action: 'jobs.view' },
    ],
  },
  {
    title: 'Finances',
    items: [
      { href: '/caisse', label: 'Caisse', iconKey: 'cash', action: 'cash.view' },
      { href: '/recus', label: 'Reçus', iconKey: 'receipts', action: 'payments.view' },
      { href: '/depenses', label: 'Dépenses', iconKey: 'expenses', action: 'expenses.view' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { href: '/magasins', label: 'Magasins', iconKey: 'stores', action: 'stores.view' },
      { href: '/utilisateurs', label: 'Utilisateurs', iconKey: 'users', action: 'users.manage' },
      { href: '/parametres', label: 'Paramètres', iconKey: 'settings', action: 'settings.view' },
      { href: '/synchronisation', label: 'Synchronisation', iconKey: 'sync', action: 'sync.manage' },
    ],
  },
];

/** Tous les chemins connus — utile pour les tests de navigation. */
export const ALL_NAV_HREFS = NAVIGATION.flatMap((g) => g.items.map((i) => i.href));

/**
 * Entrée de menu correspondant à un chemin : la **plus précise** (le plus long
 * préfixe). /chantiers/devis/12 désigne « Devis », pas « Chantiers ».
 */
export function activeNavHref(pathname: string): string | null {
  let best: string | null = null;
  for (const href of ALL_NAV_HREFS) {
    const match = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
    if (match && (!best || href.length > best.length)) best = href;
  }
  return best;
}

/** Le libellé d'un chemin, pour le fil d'ariane ou le titre d'onglet. */
export function labelForPath(pathname: string): string {
  const href = activeNavHref(pathname);
  for (const group of NAVIGATION) {
    for (const item of group.items) if (item.href === href) return item.label;
  }
  return 'Planète Déco';
}

export const STORAGE_KEYS = {
  sidebarCollapsed: 'pd-sidebar-collapsed',
} as const;
