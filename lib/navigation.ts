import type { Action } from '@/lib/permissions';

/**
 * Navigation principale : **6 groupes, 18 modules** (README §5.4).
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
  | 'bricks'
  | 'workshop'
  | 'cash'
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
    ],
  },
  {
    title: 'Production',
    items: [
      { href: '/chantiers', label: 'Chantiers', iconKey: 'jobs', action: 'jobs.view' },
      { href: '/briqueterie', label: 'Briqueterie', iconKey: 'bricks', action: 'brick.view' },
      { href: '/atelier', label: 'Atelier', iconKey: 'workshop', action: 'furniture.view' },
    ],
  },
  {
    title: 'Finances',
    items: [
      { href: '/caisse', label: 'Caisse', iconKey: 'cash', action: 'cash.view' },
      { href: '/depenses', label: 'Dépenses', iconKey: 'expenses', action: 'expenses.view' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { href: '/utilisateurs', label: 'Utilisateurs', iconKey: 'users', action: 'users.manage' },
      { href: '/parametres', label: 'Paramètres', iconKey: 'settings', action: 'settings.view' },
      { href: '/synchronisation', label: 'Synchronisation', iconKey: 'sync', action: 'sync.manage' },
    ],
  },
];

/** Tous les chemins connus — utile pour les tests de navigation. */
export const ALL_NAV_HREFS = NAVIGATION.flatMap((g) => g.items.map((i) => i.href));

/** Le libellé d'un chemin, pour le fil d'ariane ou le titre d'onglet. */
export function labelForPath(pathname: string): string {
  for (const group of NAVIGATION) {
    for (const item of group.items) {
      if (item.href === '/') {
        if (pathname === '/') return item.label;
        continue;
      }
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return item.label;
    }
  }
  return 'Planète Déco';
}

export const STORAGE_KEYS = {
  sidebarCollapsed: 'pd-sidebar-collapsed',
} as const;
