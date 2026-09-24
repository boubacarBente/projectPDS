/**
 * Rôles, permissions et filtrage de la navigation (README §5.4 et §17.2).
 *
 * Principe non négociable : **masquer n'est pas protéger**. Cette table sert à
 * la fois à filtrer le menu et à vérifier les droits **côté serveur** dans
 * chaque Route Handler.
 */

export type Role = 'admin' | 'manager' | 'seller' | 'storekeeper' | 'carpenter' | 'brickmaker';

export const ROLES: Role[] = [
  'admin',
  'manager',
  'seller',
  'storekeeper',
  'carpenter',
  'brickmaker',
];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrateur',
  manager: 'Gérant',
  seller: 'Vendeur / Caissier',
  storekeeper: 'Magasinier',
  carpenter: 'Menuisier',
  brickmaker: 'Briquetier',
};

export const ROLE_LABELS_PLURAL: Record<Role, string> = {
  admin: 'Administrateurs',
  manager: 'Gérants',
  seller: 'Vendeurs / Caissiers',
  storekeeper: 'Magasiniers',
  carpenter: 'Menuisiers',
  brickmaker: 'Briquetiers',
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
  /* Paiements */
  | 'payments.view'
  | 'payments.create'
  /* Production */
  | 'workers.manage'
  | 'jobs.view'
  | 'jobs.create'
  | 'jobs.update'
  | 'jobs.delete'
  | 'brick.view'
  | 'brick.create'
  | 'brick.update'
  | 'brick.delete'
  | 'furniture.view'
  | 'furniture.create'
  | 'furniture.update'
  | 'furniture.delete'
  /* Administration */
  | 'users.manage'
  | 'audit.view'
  | 'settings.view'
  | 'settings.update'
  | 'settings.critical'
  | 'backup.manage'
  | 'sync.manage';

/**
 * Matrice des permissions (README §17.2).
 * Toute action absente d'un rôle est refusée.
 */
const PERMISSIONS: Record<Role, Action[]> = {
  admin: [
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
    'payments.view',
    'payments.create',
    'workers.manage',
    'jobs.view',
    'jobs.create',
    'jobs.update',
    'jobs.delete',
    'brick.view',
    'brick.create',
    'brick.update',
    'brick.delete',
    'furniture.view',
    'furniture.create',
    'furniture.update',
    'furniture.delete',
    'users.manage',
    'audit.view',
    'settings.view',
    'settings.update',
    'settings.critical',
    'backup.manage',
    'sync.manage',
  ],
  manager: [
    'dashboard.view',
    'reports.view',
    'reports.viewAll',
    'balances.view',
    'sales.view',
    'sales.create',
    'sales.update',
    'sales.cancel',
    'customers.view',
    'customers.create',
    'customers.update',
    'suppliers.view',
    'suppliers.create',
    'suppliers.update',
    'products.view',
    'products.create',
    'products.update',
    'purchases.view',
    'purchases.create',
    'purchases.update',
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
    'payments.view',
    'payments.create',
    'workers.manage',
    'jobs.view',
    'jobs.create',
    'jobs.update',
    'brick.view',
    'brick.create',
    'brick.update',
    'furniture.view',
    'furniture.create',
    'furniture.update',
    'audit.view',
    'settings.view',
    'settings.update',
  ],
  seller: [
    'dashboard.view',
    'reports.view',
    'balances.view',
    'sales.view',
    'sales.create',
    'sales.update',
    'customers.view',
    'customers.create',
    'suppliers.view',
    'suppliers.create',
    'products.view',
    'stock.view',
    'cash.view',
    'cash.open',
    'cash.close',
    'cash.manual',
    'expenses.view',
    'expenses.create',
    'payments.view',
    'payments.create',
    'jobs.view',
    'settings.view',
  ],
  storekeeper: [
    'dashboard.view',
    'sales.view',
    'customers.view',
    'suppliers.view',
    'products.view',
    'products.create',
    'products.update',
    'purchases.view',
    'purchases.create',
    'purchases.update',
    'stock.view',
    'stock.adjust',
    'workers.manage',
    'jobs.view',
    'brick.view',
    'brick.create',
    'brick.update',
    'furniture.view',
    'furniture.create',
    'furniture.update',
    'settings.view',
  ],
  carpenter: [
    'dashboard.view',
    'customers.view',
    'products.view',
    'stock.view',
    'workers.manage',
    'furniture.view',
    'furniture.create',
    'furniture.update',
    'settings.view',
  ],
  brickmaker: [
    'dashboard.view',
    'customers.view',
    'products.view',
    'stock.view',
    'workers.manage',
    'brick.view',
    'brick.create',
    'brick.update',
    'settings.view',
  ],
};

export type PermissionUser = { role?: string | null } | null | undefined;

/**
 * Les 57 actions de l'application, dans leur ordre d'affichage.
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
  'payments.view',
  'payments.create',
  'workers.manage',
  'jobs.view',
  'jobs.create',
  'jobs.update',
  'jobs.delete',
  'brick.view',
  'brick.create',
  'brick.update',
  'brick.delete',
  'furniture.view',
  'furniture.create',
  'furniture.update',
  'furniture.delete',
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
  'expenses.delete': { label: 'Annuler une dépense', group: 'Caisse et dépenses', description: 'Annulation avec motif, contre-passation de la caisse.', dangerous: true },

  'payments.view': { label: 'Consulter les paiements', group: 'Paiements', description: 'Historique des encaissements et réimpression des reçus.' },
  'payments.create': { label: 'Encaisser un paiement', group: 'Paiements', description: 'Enregistrer un acompte ou un solde, générer le reçu.' },

  'workers.manage': { label: 'Gérer les ouvriers', group: 'Production', description: 'Chefs d’équipe, ouvriers et apprentis, avec leur tarif journalier.' },
  'jobs.view': { label: 'Consulter les chantiers', group: 'Production', description: 'Devis, avancement, matériaux et paiements.' },
  'jobs.create': { label: 'Créer un chantier ou un devis', group: 'Production', description: 'Nouvelle prestation, avec ses matériaux et sa main-d’œuvre.' },
  'jobs.update': { label: 'Modifier un chantier', group: 'Production', description: 'Avancement, devis, matériaux et équipe.' },
  'jobs.delete': { label: 'Annuler un chantier', group: 'Production', description: 'Annulation avec motif (aucune suppression).', dangerous: true },
  'brick.view': { label: 'Consulter la briqueterie', group: 'Production', description: 'Lots, étapes, types de briques et coûts de revient.' },
  'brick.create': { label: 'Lancer une fabrication', group: 'Production', description: 'Nouveau lot, avec matières premières et équipe.' },
  'brick.update': { label: 'Suivre une fabrication', group: 'Production', description: 'Avancer les étapes, saisir les pertes et les coûts.' },
  'brick.delete': { label: 'Annuler une fabrication', group: 'Production', description: 'Annulation avec motif (aucune suppression).', dangerous: true },
  'furniture.view': { label: 'Consulter l’atelier', group: 'Production', description: 'Modèles, commandes, suivi et coûts.' },
  'furniture.create': { label: 'Créer une commande de meuble', group: 'Production', description: 'Commande standard ou sur mesure, avec sa nomenclature.' },
  'furniture.update': { label: 'Suivre une commande', group: 'Production', description: 'Étapes d’atelier, matériaux, chutes et équipe.' },
  'furniture.delete': { label: 'Annuler une commande', group: 'Production', description: 'Annulation avec motif (aucune suppression).', dangerous: true },

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
