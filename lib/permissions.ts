/**
 * Rôles, permissions et filtrage de la navigation (README §5.4 et §17.2).
 *
 * Principe non négociable : **masquer n'est pas protéger**. Cette table sert à
 * la fois à filtrer le menu et à vérifier les droits **côté serveur** dans
 * chaque Route Handler.
 */

export type Role = 'admin' | 'manager' | 'seller' | 'storekeeper' | 'accountant';

export const ROLES: Role[] = [
  'admin',
  'manager',
  'seller',
  'storekeeper',
  'accountant',
];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrateur général',
  manager: 'Gérant de magasin',
  seller: 'Vendeur / Caissier',
  storekeeper: 'Magasinier',
  accountant: 'Comptable',
};

export const ROLE_LABELS_PLURAL: Record<Role, string> = {
  admin: 'Administrateurs généraux',
  manager: 'Gérants de magasin',
  seller: 'Vendeurs / Caissiers',
  storekeeper: 'Magasiniers',
  accountant: 'Comptables',
};

export type Action =
  /* Navigation / lecture générale */
  | 'dashboard.view'
  | 'reports.view'
  | 'reports.viewAll'
  | 'balances.view'
  /* Ventes */
  | 'sales.view'
  | 'sales.create'
  | 'sales.update'
  | 'sales.cancel'
  | 'sales.delete'
  /* Partenaires */
  | 'customers.view'
  | 'customers.create'
  | 'customers.update'
  | 'customers.delete'
  | 'suppliers.view'
  | 'suppliers.create'
  | 'suppliers.update'
  | 'suppliers.delete'
  /* Catalogue */
  | 'products.view'
  | 'products.create'
  | 'products.update'
  | 'products.delete'
  /* Achats et stock */
  | 'purchases.view'
  | 'purchases.create'
  | 'purchases.update'
  | 'purchases.delete'
  | 'stock.view'
  | 'stock.adjust'
  /* Caisse et dépenses */
  | 'cash.view'
  | 'cash.open'
  | 'cash.close'
  | 'cash.manual'
  | 'expenses.view'
  | 'expenses.create'
  | 'expenses.update'
  | 'expenses.delete'
  | 'expenses.approve'
  /* Paiements */
  | 'payments.view'
  | 'payments.create'
  /* Production */
  | 'workers.manage'
  | 'jobs.view'
  | 'jobs.create'
  | 'jobs.update'
  | 'jobs.delete'
  | 'services.manage'
  /* Atelier de meubles (README §29) */
  | 'furniture.view'
  | 'furniture.create'
  | 'furniture.update'
  | 'furniture.delete'
  | 'furniture.models'
  /* Filiales de production (README §30, §31) : préfixe `brick` conservé (droits déjà enregistrés) */
  | 'brick.view'
  | 'brick.create'
  | 'brick.update'
  | 'brick.delete'
  | 'brick.types'
  | 'brick.branches'
  /* Multi-magasins */
  | 'stores.view'
  | 'stores.manage'
  | 'stores.viewAll'
  | 'stores.switch'
  | 'transfers.view'
  | 'transfers.create'
  | 'transfers.approve'
  | 'transfers.ship'
  | 'transfers.receive'
  | 'inventory.view'
  | 'inventory.manage'
  | 'inventory.validate'
  /* Administration */
  | 'users.manage'
  | 'audit.view'
  | 'settings.view'
  | 'settings.update'
  | 'settings.critical'
  | 'backup.manage'
  | 'sync.manage';

/* ------------------------------------------------------------------ *
 * Domaines d'accès et niveaux (refonte du 4 octobre 2026, README §17.2)
 * ------------------------------------------------------------------ *
 *
 * Avant : chaque rôle était une liste de ~60 permissions techniques, et
 * personnaliser un compte voulait dire cocher des actions une par une. Un
 * administrateur non technicien ne savait pas ce qu'il accordait.
 *
 * Désormais, un rôle — et la personnalisation d'un compte — se décrit par
 * **domaine** (Ventes, Caisse, Stock…) avec un **niveau** cumulatif en mots
 * simples : Aucun accès → Consulter → Saisir → Gérer. Chaque niveau inclut
 * le précédent. Les permissions techniques (\`Action\`) restent la seule chose
 * que le serveur vérifie : les niveaux ne font que les regrouper.
 */

export type AccessLevel = 'none' | 'view' | 'edit' | 'manage';

export type AccessAreaLevel = {
  level: Exclude<AccessLevel, 'none'>;
  /** Ce que la personne peut faire à ce niveau, en mots simples. */
  label: string;
  /** Actions **ajoutées** par ce niveau (les niveaux sont cumulatifs). */
  actions: Action[];
};

export type AccessArea = {
  id: string;
  label: string;
  /** Une phrase : à quoi sert ce domaine. */
  description: string;
  levels: AccessAreaLevel[];
};

export const ACCESS_AREAS: AccessArea[] = [
  {
    id: 'pilotage',
    label: 'Tableau de bord et rapports',
    description: 'Les chiffres du magasin : ventes du jour, rapports, soldes et bénéfices.',
    levels: [
      { level: 'view', label: 'Tableau de bord et rapport du jour', actions: ['dashboard.view', 'reports.view'] },
      { level: 'manage', label: 'Tous les rapports, soldes et bénéfices', actions: ['reports.viewAll', 'balances.view'] },
    ],
  },
  {
    id: 'ventes',
    label: 'Ventes et encaissements',
    description: 'Factures de vente, brouillons et paiements des clients.',
    levels: [
      { level: 'view', label: 'Consulter les ventes et les reçus', actions: ['sales.view', 'payments.view'] },
      { level: 'edit', label: 'Vendre et encaisser', actions: ['sales.create', 'sales.update', 'sales.delete', 'payments.create'] },
      { level: 'manage', label: 'Annuler une vente validée', actions: ['sales.cancel'] },
    ],
  },
  {
    id: 'clients',
    label: 'Clients',
    description: 'Fiches clients du magasin, historique et soldes.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['customers.view'] },
      { level: 'edit', label: 'Créer et modifier', actions: ['customers.create', 'customers.update'] },
      { level: 'manage', label: 'Désactiver un client', actions: ['customers.delete'] },
    ],
  },
  {
    id: 'fournisseurs',
    label: 'Fournisseurs',
    description: 'Fiches fournisseurs et sous-traitants du magasin, dettes.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['suppliers.view'] },
      { level: 'edit', label: 'Créer et modifier', actions: ['suppliers.create', 'suppliers.update'] },
      { level: 'manage', label: 'Désactiver un fournisseur', actions: ['suppliers.delete'] },
    ],
  },
  {
    id: 'produits',
    label: 'Produits et catégories',
    description: 'Produits du magasin, prix, catégories.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['products.view'] },
      { level: 'edit', label: 'Prix et seuils du magasin, ajouter du catalogue', actions: ['products.update'] },
      { level: 'manage', label: 'Créer et désactiver des produits et catégories', actions: ['products.create', 'products.delete'] },
    ],
  },
  {
    id: 'achats',
    label: 'Achats',
    description: 'Factures d’achat chez les fournisseurs (entrées de stock).',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['purchases.view'] },
      { level: 'edit', label: 'Enregistrer et corriger un achat', actions: ['purchases.create', 'purchases.update'] },
      { level: 'manage', label: 'Annuler un achat', actions: ['purchases.delete'] },
    ],
  },
  {
    id: 'stock',
    label: 'Stock',
    description: 'Quantités en stock et journal des mouvements.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['stock.view'] },
      { level: 'manage', label: 'Corriger le stock', actions: ['stock.adjust'] },
    ],
  },
  {
    id: 'caisse',
    label: 'Caisse',
    description: 'Ouverture, clôture et mouvements de la caisse du magasin.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['cash.view'] },
      { level: 'edit', label: 'Ouvrir et clôturer la caisse', actions: ['cash.open', 'cash.close'] },
      { level: 'manage', label: 'Entrées et sorties d’argent manuelles', actions: ['cash.manual'] },
    ],
  },
  {
    id: 'depenses',
    label: 'Dépenses',
    description: 'Frais du magasin (loyer, transport…) et leur approbation.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['expenses.view'] },
      { level: 'edit', label: 'Saisir une dépense', actions: ['expenses.create'] },
      { level: 'manage', label: 'Approuver, modifier et annuler', actions: ['expenses.update', 'expenses.delete', 'expenses.approve'] },
    ],
  },
  {
    id: 'chantiers',
    label: 'Chantiers',
    description: 'Demandes, devis, chantiers, prestations et ouvriers.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['jobs.view'] },
      { level: 'edit', label: 'Demandes, devis et chantiers', actions: ['jobs.create', 'jobs.update'] },
      { level: 'manage', label: 'Prestations, ouvriers et annulations', actions: ['jobs.delete', 'services.manage', 'workers.manage'] },
    ],
  },
  {
    id: 'atelier',
    label: 'Atelier de meubles',
    description: 'Modèles de meubles, commandes de fabrication, matières, équipe et livraisons.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['furniture.view'] },
      { level: 'edit', label: 'Commandes, matières, équipe et étapes', actions: ['furniture.create', 'furniture.update'] },
      { level: 'manage', label: 'Modèles et annulations', actions: ['furniture.models', 'furniture.delete'] },
    ],
  },
  {
    // Identifiant `briqueterie` conservé : il nomme les niveaux déjà enregistrés des comptes.
    id: 'briqueterie',
    label: 'Filiales de production',
    description: 'Briqueterie, vitrerie, meubles… : productions, dépenses de production, stock, commandes, ventes et rapports de chaque filiale.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['brick.view'] },
      { level: 'edit', label: 'Productions, étapes, équipe et commandes', actions: ['brick.create', 'brick.update'] },
      { level: 'manage', label: 'Modèles, clients partagés et annulations', actions: ['brick.types', 'brick.delete'] },
    ],
  },
  {
    id: 'transferts',
    label: 'Transferts entre magasins',
    description: 'Envoyer et recevoir de la marchandise d’un magasin à l’autre.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['transfers.view'] },
      { level: 'edit', label: 'Demander, expédier et réceptionner', actions: ['transfers.create', 'transfers.ship', 'transfers.receive'] },
      { level: 'manage', label: 'Valider les transferts', actions: ['transfers.approve'] },
    ],
  },
  {
    id: 'inventaires',
    label: 'Inventaires',
    description: 'Comptage physique du stock et correction des écarts.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['inventory.view'] },
      { level: 'edit', label: 'Ouvrir un inventaire et compter', actions: ['inventory.manage'] },
      { level: 'manage', label: 'Valider (appliquer les écarts)', actions: ['inventory.validate'] },
    ],
  },
  {
    id: 'magasins',
    label: 'Magasins',
    description: 'Fiches des magasins et passage d’un magasin à l’autre.',
    levels: [
      { level: 'view', label: 'Voir ses magasins', actions: ['stores.view'] },
      { level: 'edit', label: 'Changer de magasin actif', actions: ['stores.switch'] },
      // Les filiales de production sont, comme les magasins, la structure centrale de l'entreprise.
      { level: 'manage', label: 'Voir et gérer tous les magasins et les filiales', actions: ['stores.viewAll', 'stores.manage', 'brick.branches'] },
    ],
  },
  {
    id: 'comptes',
    label: 'Comptes et historique',
    description: 'Comptes utilisateurs et journal des actions.',
    levels: [
      { level: 'view', label: 'Consulter l’historique des actions', actions: ['audit.view'] },
      { level: 'manage', label: 'Gérer les comptes de ses magasins', actions: ['users.manage'] },
    ],
  },
  {
    id: 'parametres',
    label: 'Paramètres',
    description: 'Réglages de l’entreprise, sauvegarde et synchronisation.',
    levels: [
      { level: 'view', label: 'Consulter', actions: ['settings.view'] },
      { level: 'edit', label: 'Modifier les paramètres', actions: ['settings.update'] },
      { level: 'manage', label: 'Sauvegarde, synchronisation, remise à zéro', actions: ['settings.critical', 'backup.manage', 'sync.manage'] },
    ],
  },
];

export const ACCESS_LEVEL_LABELS: Record<AccessLevel, string> = {
  none: 'Aucun accès',
  view: 'Consulter',
  edit: 'Saisir',
  manage: 'Gérer',
};

const LEVEL_ORDER: AccessLevel[] = ['none', 'view', 'edit', 'manage'];

/** Niveaux proposés pour un domaine (« Aucun accès » compris). */
export function areaLevels(area: AccessArea): AccessLevel[] {
  return ['none', ...area.levels.map((l) => l.level)];
}

/** Actions accordées par un niveau d'un domaine (niveaux cumulatifs). */
export function actionsForAreaLevel(area: AccessArea, level: AccessLevel): Action[] {
  const rank = LEVEL_ORDER.indexOf(level);
  return area.levels.filter((l) => LEVEL_ORDER.indexOf(l.level) <= rank).flatMap((l) => l.actions);
}

/**
 * Niveau correspondant exactement à un ensemble d'actions, ou \`custom\` si
 * l'ensemble ne tombe sur aucun niveau (personnalisation fine héritée de
 * l'ancien écran, par exemple).
 */
export function areaLevelOf(area: AccessArea, granted: Iterable<Action>): AccessLevel | 'custom' {
  const set = new Set(granted);
  const own = area.levels.flatMap((l) => l.actions).filter((a) => set.has(a));
  for (const level of areaLevels(area)) {
    const expected = actionsForAreaLevel(area, level);
    if (expected.length === own.length && expected.every((a) => set.has(a))) return level;
  }
  return 'custom';
}

/** Ensemble d'actions correspondant à un niveau par domaine. */
export function actionsForLevels(levels: Record<string, AccessLevel>): Action[] {
  return ACCESS_AREAS.flatMap((area) => actionsForAreaLevel(area, levels[area.id] ?? 'none'));
}

/**
 * **Rôles** = un niveau par domaine. C'est la seule définition des rôles :
 * \`PERMISSIONS\` en est déduit. Un domaine absent vaut « Aucun accès ».
 *
 * Choix assumés (changements par rapport à l'ancienne matrice) :
 *  - le vendeur ne voit plus les soldes ni les bénéfices (invariant 13) ;
 *  - le gérant consulte les paramètres de l'entreprise mais ne les modifie
 *    plus (ils valent pour tout le réseau) ;
 *  - personne d'autre que l'administrateur ne change de magasin d'office
 *    (README §28.6).
 */
export const ROLE_LEVELS: Record<Role, Record<string, AccessLevel>> = {
  admin: Object.fromEntries(ACCESS_AREAS.map((a) => [a.id, 'manage'])) as Record<string, AccessLevel>,
  manager: {
    pilotage: 'manage',
    ventes: 'manage',
    clients: 'manage',
    fournisseurs: 'manage',
    produits: 'manage',
    achats: 'manage',
    stock: 'manage',
    caisse: 'manage',
    depenses: 'manage',
    chantiers: 'manage',
    atelier: 'manage',
    briqueterie: 'manage',
    transferts: 'manage',
    inventaires: 'manage',
    magasins: 'view',
    comptes: 'manage',
    parametres: 'view',
  },
  seller: {
    pilotage: 'view',
    ventes: 'edit',
    clients: 'edit',
    fournisseurs: 'view',
    produits: 'view',
    stock: 'view',
    caisse: 'edit',
    depenses: 'edit',
    chantiers: 'view',
    atelier: 'view',
    briqueterie: 'view',
    magasins: 'view',
    parametres: 'view',
  },
  storekeeper: {
    pilotage: 'view',
    ventes: 'view',
    clients: 'view',
    fournisseurs: 'edit',
    produits: 'manage',
    achats: 'edit',
    stock: 'manage',
    chantiers: 'view',
    atelier: 'edit',
    briqueterie: 'edit',
    transferts: 'edit',
    inventaires: 'edit',
    magasins: 'view',
    parametres: 'view',
  },
  accountant: {
    pilotage: 'manage',
    ventes: 'view',
    clients: 'view',
    fournisseurs: 'view',
    produits: 'view',
    achats: 'view',
    stock: 'view',
    caisse: 'view',
    depenses: 'manage',
    chantiers: 'view',
    atelier: 'view',
    briqueterie: 'view',
    transferts: 'view',
    inventaires: 'view',
    magasins: 'view',
    comptes: 'view',
    parametres: 'view',
  },
};

/** Fiche de présentation d'un rôle, pour l'écran de création d'un compte. */
export const ROLE_PROFILES: Record<Role, { summary: string; can: string[]; cannot: string[] }> = {
  admin: {
    summary: 'Dirige l’entreprise : a tous les droits, dans tous les magasins.',
    can: ['Tout faire dans tous les magasins', 'Créer les magasins et les comptes', 'Modifier les paramètres de l’entreprise'],
    cannot: ['Être désactivé ou limité : un administrateur garde toujours tous ses droits'],
  },
  manager: {
    summary: 'Responsable d’un magasin : gère tout ce qui s’y passe.',
    can: ['Vendre, acheter, gérer la caisse et le stock', 'Approuver les dépenses et valider les transferts', 'Voir les rapports et le bénéfice', 'Gérer les comptes de son magasin'],
    cannot: ['Modifier les paramètres de l’entreprise', 'Changer de magasin sans autorisation'],
  },
  seller: {
    summary: 'Au comptoir : vend, encaisse et tient la caisse.',
    can: ['Créer des ventes et encaisser', 'Créer des clients', 'Ouvrir et clôturer la caisse', 'Saisir une dépense'],
    cannot: ['Annuler une vente validée', 'Voir les bénéfices', 'Modifier les prix ou le stock'],
  },
  storekeeper: {
    summary: 'À l’entrepôt : réceptionne, range et compte la marchandise.',
    can: ['Enregistrer les achats', 'Créer des produits et corriger le stock', 'Expédier et réceptionner les transferts', 'Compter les inventaires'],
    cannot: ['Vendre ou toucher à la caisse', 'Valider un inventaire', 'Voir les bénéfices'],
  },
  accountant: {
    summary: 'Contrôle les chiffres : consulte tout, approuve les dépenses.',
    can: ['Consulter ventes, achats, caisse et stock', 'Voir tous les rapports, soldes et bénéfices', 'Approuver les dépenses'],
    cannot: ['Vendre, acheter ou toucher au stock', 'Modifier une fiche client ou produit'],
  },
};

/**
 * Matrice des permissions (README §17.2), **déduite** des niveaux de
 * \`ROLE_LEVELS\`. Toute action absente d'un rôle est refusée.
 */
const PERMISSIONS: Record<Role, Action[]> = Object.fromEntries(
  ROLES.map((role) => [role, actionsForLevels(ROLE_LEVELS[role])]),
) as Record<Role, Action[]>;

export type PermissionUser = { role?: string | null } | null | undefined;

/**
 * Les actions de l'application, dans leur ordre d'affichage.
 * Cette liste est la **source unique** : l'écran de permissions la parcourt
 * pour construire sa matrice, ce qui garantit qu'aucune action n'est oubliée.
 */
export const ALL_ACTIONS: Action[] = [
  'dashboard.view',
  'reports.view',
  'reports.viewAll',
  'balances.view',
  'sales.view',
  'sales.create',
  'sales.update',
  'sales.cancel',
  'sales.delete',
  'customers.view',
  'customers.create',
  'customers.update',
  'customers.delete',
  'suppliers.view',
  'suppliers.create',
  'suppliers.update',
  'suppliers.delete',
  'products.view',
  'products.create',
  'products.update',
  'products.delete',
  'purchases.view',
  'purchases.create',
  'purchases.update',
  'purchases.delete',
  'stock.view',
  'stock.adjust',
  'cash.view',
  'cash.open',
  'cash.close',
  'cash.manual',
  'expenses.view',
  'expenses.create',
  'expenses.update',
  'expenses.delete',
  'expenses.approve',
  'payments.view',
  'payments.create',
  'workers.manage',
  'jobs.view',
  'jobs.create',
  'jobs.update',
  'jobs.delete',
  'services.manage',
  'furniture.view',
  'furniture.create',
  'furniture.update',
  'furniture.delete',
  'furniture.models',
  'brick.view',
  'brick.create',
  'brick.update',
  'brick.delete',
  'brick.types',
  'brick.branches',
  'stores.view',
  'stores.manage',
  'stores.viewAll',
  'stores.switch',
  'transfers.view',
  'transfers.create',
  'transfers.approve',
  'transfers.ship',
  'transfers.receive',
  'inventory.view',
  'inventory.manage',
  'inventory.validate',
  'users.manage',
  'audit.view',
  'settings.view',
  'settings.update',
  'settings.critical',
  'backup.manage',
  'sync.manage',
];

/** Ordre d'affichage des domaines dans l'écran de permissions. */
export const ACTION_GROUPS = [
  'Pilotage',
  'Ventes',
  'Clients et fournisseurs',
  'Catalogue et stock',
  'Achats',
  'Caisse et dépenses',
  'Paiements',
  'Production',
  'Magasins',
  'Administration',
] as const;

export type ActionGroup = (typeof ACTION_GROUPS)[number];

export type ActionMeta = {
  /** Libellé affiché à l'administrateur. */
  label: string;
  group: ActionGroup;
  /** Ce que l'action autorise réellement, en une phrase. */
  description: string;
  /**
   * Action sensible : l'accord doit être conscient. L'interface le signale,
   * elle ne l'interdit pas — c'est l'administrateur qui décide.
   */
  dangerous?: boolean;
};

export const ACTION_META: Record<Action, ActionMeta> = {
  'dashboard.view': { label: 'Voir le tableau de bord', group: 'Pilotage', description: "Accès à la page d'accueil et à ses indicateurs." },
  'reports.view': { label: 'Consulter les rapports', group: 'Pilotage', description: 'Rapports de ventes, stock, caisse et dettes.' },
  'reports.viewAll': { label: 'Rapports sur toutes les périodes', group: 'Pilotage', description: "Sans cette permission, seuls les rapports du jour sont accessibles." },
  'balances.view': { label: 'Voir les soldes et bénéfices', group: 'Pilotage', description: 'Créances clients, dettes fournisseurs, marges et bénéfice net.' },

  'sales.view': { label: 'Consulter les ventes', group: 'Ventes', description: 'Liste et détail des factures de vente.' },
  'sales.create': { label: 'Créer une vente', group: 'Ventes', description: 'Enregistrer une vente (avec sortie de stock et encaissement).' },
  'sales.update': { label: 'Modifier une vente', group: 'Ventes', description: 'Corriger les lignes et les totaux, avec ajustement du stock.' },
  'sales.cancel': { label: 'Annuler une vente', group: 'Ventes', description: 'Inverser le stock et contre-passer la caisse. Action sensible.', dangerous: true },
  'sales.delete': { label: 'Supprimer un brouillon', group: 'Ventes', description: "Retirer une vente jamais validée (ni stock ni caisse touchés)." },

  'customers.view': { label: 'Consulter les clients', group: 'Clients et fournisseurs', description: 'Fiches, historique et soldes.' },
  'customers.create': { label: 'Créer un client', group: 'Clients et fournisseurs', description: 'Ajouter une fiche client.' },
  'customers.update': { label: 'Modifier un client', group: 'Clients et fournisseurs', description: 'Corriger les coordonnées, le plafond de crédit.' },
  'customers.delete': { label: 'Désactiver un client', group: 'Clients et fournisseurs', description: 'Désactivation (jamais de suppression définitive).', dangerous: true },
  'suppliers.view': { label: 'Consulter les fournisseurs', group: 'Clients et fournisseurs', description: 'Fiches, historique des achats et dettes.' },
  'suppliers.create': { label: 'Créer un fournisseur', group: 'Clients et fournisseurs', description: 'Ajouter une fiche fournisseur.' },
  'suppliers.update': { label: 'Modifier un fournisseur', group: 'Clients et fournisseurs', description: 'Corriger les coordonnées.' },
  'suppliers.delete': { label: 'Désactiver un fournisseur', group: 'Clients et fournisseurs', description: 'Désactivation (jamais de suppression définitive).', dangerous: true },

  'products.view': { label: 'Consulter le catalogue', group: 'Catalogue et stock', description: 'Produits, catégories, prix de vente.' },
  'products.create': { label: 'Créer un produit', group: 'Catalogue et stock', description: 'Ajouter un produit ou une catégorie.' },
  'products.update': { label: 'Modifier un produit', group: 'Catalogue et stock', description: 'Prix d’achat et de vente, unité, seuil d’alerte. Action sensible.', dangerous: true },
  'products.delete': { label: 'Désactiver un produit', group: 'Catalogue et stock', description: 'Désactivation (jamais de suppression définitive).', dangerous: true },
  'stock.view': { label: 'Consulter le stock', group: 'Catalogue et stock', description: 'État du stock et journal des mouvements.' },
  'stock.adjust': { label: 'Corriger le stock', group: 'Catalogue et stock', description: 'Inventaire : enregistrer un écart sur le stock. Action sensible.', dangerous: true },

  'purchases.view': { label: 'Consulter les achats', group: 'Achats', description: 'Factures d’achat fournisseur.' },
  'purchases.create': { label: 'Créer un achat', group: 'Achats', description: 'Enregistrer un achat (avec entrée de stock).' },
  'purchases.update': { label: 'Modifier un achat', group: 'Achats', description: 'Corriger une facture d’achat.' },
  'purchases.delete': { label: 'Supprimer un achat', group: 'Achats', description: 'Retirer une facture d’achat, en inversant le stock.', dangerous: true },

  'cash.view': { label: 'Consulter la caisse', group: 'Caisse et dépenses', description: 'Solde, mouvements et historique des sessions.' },
  'cash.open': { label: 'Ouvrir la caisse', group: 'Caisse et dépenses', description: 'Démarrer une session journalière avec son montant initial.' },
  'cash.close': { label: 'Clôturer la caisse', group: 'Caisse et dépenses', description: 'Saisir le montant compté et enregistrer l’écart. Action sensible.', dangerous: true },
  'cash.manual': { label: 'Mouvement de caisse manuel', group: 'Caisse et dépenses', description: 'Entrée ou sortie d’argent saisie à la main. Action sensible.', dangerous: true },
  'expenses.view': { label: 'Consulter les dépenses', group: 'Caisse et dépenses', description: 'Frais de fonctionnement et rapports par catégorie.' },
  'expenses.create': { label: 'Enregistrer une dépense', group: 'Caisse et dépenses', description: 'Sortie de caisse (sans effet sur le stock).' },
  'expenses.update': { label: 'Modifier une dépense', group: 'Caisse et dépenses', description: 'Contre-passe et réenregistre le mouvement de caisse.' },
  'expenses.approve': { label: 'Approuver les dépenses', group: 'Caisse et dépenses', description: 'Valider ou rejeter les dépenses au-dessus du seuil d’approbation.', dangerous: true },
  'expenses.delete': { label: 'Annuler une dépense', group: 'Caisse et dépenses', description: 'Annulation avec motif, contre-passation de la caisse.', dangerous: true },

  'payments.view': { label: 'Consulter les paiements', group: 'Paiements', description: 'Historique des encaissements et réimpression des reçus.' },
  'payments.create': { label: 'Encaisser un paiement', group: 'Paiements', description: 'Enregistrer un acompte ou un solde, générer le reçu.' },

  'workers.manage': { label: 'Gérer les ouvriers', group: 'Production', description: 'Chefs d’équipe, ouvriers et apprentis, avec leur tarif journalier.' },
  'jobs.view': { label: 'Consulter les chantiers', group: 'Production', description: 'Demandes, devis, chantiers, catalogue des prestations, avancement et paiements.' },
  'jobs.create': { label: 'Créer une demande, un devis ou un chantier', group: 'Production', description: 'Enregistrer la demande d’un client, établir un devis, ouvrir un chantier.' },
  'jobs.update': { label: 'Modifier un chantier', group: 'Production', description: 'Prestations, étapes, équipe, sous-traitance, matériaux ; statut des demandes et des devis.' },
  'services.manage': { label: 'Gérer les prestations', group: 'Production', description: 'Catalogue des prestations du magasin : créer, tarifer, désactiver, archiver.' },
  'jobs.delete': { label: 'Annuler un chantier ou un devis', group: 'Production', description: 'Annulation avec motif (aucune suppression).', dangerous: true },
  'furniture.view': { label: 'Consulter l’atelier', group: 'Production', description: 'Commandes de meubles, modèles, coûts de revient et livraisons.' },
  'furniture.create': { label: 'Créer une commande d’atelier', group: 'Production', description: 'Commande d’un client ou fabrication pour le stock.' },
  'furniture.update': { label: 'Faire avancer une commande d’atelier', group: 'Production', description: 'Étapes, matières sorties du stock, chutes, équipe, dates et prix convenu.' },
  'furniture.models': { label: 'Gérer les modèles de meubles', group: 'Production', description: 'Fiches modèles du magasin et leur nomenclature de matières.' },
  'furniture.delete': { label: 'Annuler une commande d’atelier', group: 'Production', description: 'Annulation avec motif : les matières reviennent au stock.', dangerous: true },
  'brick.view': { label: 'Consulter les filiales de production', group: 'Production', description: 'Tableau de bord, productions, stock, commandes, ventes et rapports des filiales autorisées.' },
  'brick.create': { label: 'Créer une production ou une commande de filiale', group: 'Production', description: 'Lancer une fabrication, enregistrer une commande client.' },
  'brick.update': { label: 'Faire avancer une production ou une commande', group: 'Production', description: 'Étapes, quantités, pertes, équipe, dépenses rattachées ; statut, livraison et facturation des commandes.' },
  'brick.types': { label: 'Gérer les modèles et les clients partagés', group: 'Production', description: 'Modèles de production du magasin (produit qui porte leur prix et leur stock) et clients partagés avec une filiale.' },
  'brick.delete': { label: 'Annuler une production ou une commande de filiale', group: 'Production', description: 'Annulation avec motif : le stock de la production est repris.', dangerous: true },
  'brick.branches': { label: 'Gérer les filiales de production', group: 'Magasins', description: 'Créer, renommer, suspendre ou archiver une filiale (briqueterie, vitrerie, meubles…), régler ses étapes, ses numéros et ses comptes autorisés.', dangerous: true },

  'stores.view': { label: 'Voir ses magasins', group: 'Magasins', description: 'Fiche et indicateurs des magasins auxquels on est affecté.' },
  'stores.manage': { label: 'Gérer les magasins', group: 'Magasins', description: 'Créer, modifier, suspendre ou archiver un magasin, désigner son gérant.', dangerous: true },
  'stores.viewAll': { label: 'Vue consolidée tous magasins', group: 'Magasins', description: 'Consulter les opérations de tous les magasins, même sans affectation.', dangerous: true },
  /*
   * Demande client (4 octobre 2026) : seul l'administrateur change de magasin
   * d'office ; tout autre compte doit en recevoir le droit (surcharge « allow »).
   * Sans lui, le compte travaille dans son magasin principal (README §28.6).
   */
  'stores.switch': { label: 'Changer de magasin actif', group: 'Magasins', description: 'Passer d’un magasin à l’autre parmi ceux auxquels on est affecté. Sans ce droit, le compte reste dans son magasin principal (celui dont il est gérant, sinon sa première affectation).', dangerous: true },
  'transfers.view': { label: 'Consulter les transferts', group: 'Magasins', description: 'Transferts de stock entre magasins et leur historique.' },
  'transfers.create': { label: 'Demander un transfert', group: 'Magasins', description: 'Créer une demande de transfert vers ou depuis son magasin.' },
  'transfers.approve': { label: 'Valider un transfert', group: 'Magasins', description: 'Valider ou refuser une demande de transfert.', dangerous: true },
  'transfers.ship': { label: 'Expédier un transfert', group: 'Magasins', description: 'Sortir les quantités du stock source (mise en transit).' },
  'transfers.receive': { label: 'Réceptionner un transfert', group: 'Magasins', description: 'Réception totale ou partielle, signalement d’écart ou de litige.' },
  'inventory.view': { label: 'Consulter les inventaires', group: 'Magasins', description: 'Inventaires physiques et écarts constatés.' },
  'inventory.manage': { label: 'Préparer un inventaire', group: 'Magasins', description: 'Ouvrir un inventaire et saisir les comptages.' },
  'inventory.validate': { label: 'Valider un inventaire', group: 'Magasins', description: 'Appliquer les écarts au stock. Action sensible.', dangerous: true },

  'users.manage': { label: 'Gérer les utilisateurs', group: 'Administration', description: 'Créer des comptes, changer les rôles et les permissions, réinitialiser les mots de passe. Action sensible.', dangerous: true },
  'audit.view': { label: 'Consulter l’historique des actions', group: 'Administration', description: 'Journal de toutes les opérations sensibles.' },
  'settings.view': { label: 'Voir les paramètres', group: 'Administration', description: 'Consultation de la configuration de l’entreprise.' },
  'settings.update': { label: 'Modifier les paramètres', group: 'Administration', description: 'Identité, couleurs, devise, numérotation, TVA, alertes, rapports. Action sensible.', dangerous: true },
  'settings.critical': { label: 'Réinitialiser les données', group: 'Administration', description: 'Efface les données métier et permet le préremplissage. Action très sensible.', dangerous: true },
  'backup.manage': { label: 'Sauvegarder et restaurer', group: 'Administration', description: 'Télécharger une sauvegarde ou restaurer la base. Action très sensible.', dangerous: true },
  'sync.manage': { label: 'Gérer la synchronisation', group: 'Administration', description: 'Mode en ligne, appareils, conflits et export manuel.' },
};

/** Les actions d'un domaine, dans l'ordre de `ALL_ACTIONS`. */
export function actionsOfGroup(group: ActionGroup): Action[] {
  return ALL_ACTIONS.filter((action) => ACTION_META[action].group === group);
}

export function actionLabel(action: Action): string {
  return ACTION_META[action]?.label ?? action;
}

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && (ALL_ACTIONS as string[]).includes(value);
}

/** Surcharge explicite d'une permission, par rapport au rôle. */
export type PermissionOverride = {
  action: Action;
  /** `allow` accorde une action que le rôle n'a pas ; `deny` la retire. */
  effect: 'allow' | 'deny';
};

/**
 * Permissions effectives d'un utilisateur = **matrice du rôle**, puis
 * **surcharges par utilisateur** (demande explicite du client).
 *
 * Ordre de résolution :
 *  1. `admin` → **toutes** les permissions, et les surcharges sont ignorées.
 *     C'est délibéré : l'application ne doit pas pouvoir devenir
 *     inadministrable par un refus de permission. « Seul l'admin a droit à tout. »
 *  2. une surcharge **`deny`** retire l'action, même si le rôle l'accorde ;
 *  3. une surcharge **`allow`** accorde l'action, même si le rôle la refuse ;
 *  4. sinon, la matrice du rôle s'applique.
 */
export function resolvePermissions(
  user: PermissionUser,
  overrides: PermissionOverride[] = [],
): Action[] {
  const role = (user?.role ?? '') as Role;
  if (!ROLES.includes(role)) return [];

  // 1. Administrateur : tout, sans exception et sans restriction possible.
  if (role === 'admin') return [...ALL_ACTIONS];

  const granted = new Set<Action>(PERMISSIONS[role]);

  for (const override of overrides) {
    if (!isAction(override.action)) continue;
    if (override.effect === 'allow') granted.add(override.action);
    else granted.delete(override.action);
  }

  // On conserve l'ordre d'affichage, pas l'ordre d'insertion des surcharges.
  return ALL_ACTIONS.filter((action) => granted.has(action));
}

/**
 * `can(user, 'sales.cancel')` — vérifié côté serveur dans chaque Route Handler.
 *
 * @param permissions permissions **déjà résolues** (rôle + surcharges). Quand
 *   elles sont fournies, c'est la seule source consultée : c'est ce qui permet
 *   au serveur comme au navigateur d'appliquer exactement la même décision.
 *   Sans elles, la matrice du rôle sert de repli — utile tant que les
 *   permissions ne sont pas encore chargées.
 */
export function can(user: PermissionUser, action: Action, permissions?: Action[] | null): boolean {
  if (permissions && permissions.length > 0) return permissions.includes(action);
  if (permissions && permissions.length === 0) {
    // Liste résolue vide = aucun droit. On ne retombe PAS sur le rôle, sinon un
    // utilisateur dont toutes les permissions ont été retirées retrouverait
    // celles de son rôle.
    return false;
  }

  const role = (user?.role ?? '') as Role;
  if (!ROLES.includes(role)) return false;
  if (role === 'admin') return true;
  return PERMISSIONS[role].includes(action);
}

export function canAny(
  user: PermissionUser,
  actions: Action[],
  permissions?: Action[] | null,
): boolean {
  return actions.some((a) => can(user, a, permissions));
}

/** Permissions par défaut du rôle, **avant** surcharges. */
export function permissionsOf(user: PermissionUser): Action[] {
  const role = (user?.role ?? '') as Role;
  if (!ROLES.includes(role)) return [];
  if (role === 'admin') return [...ALL_ACTIONS];
  return [...PERMISSIONS[role]];
}

/** Levée utilisée par les Route Handlers pour répondre 403 proprement. */
export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(action: Action) {
    super(`Permission refusée : ${actionLabel(action)}`);
    this.name = 'ForbiddenError';
  }
}

/** Garde serveur : lève si l'utilisateur n'a pas la permission. */
export function requirePermission(
  user: PermissionUser,
  action: Action,
  permissions?: Action[] | null,
): void {
  if (!can(user, action, permissions)) throw new ForbiddenError(action);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}
