/**
 * Libellés français du journal d'actions — **module client-safe**.
 *
 * ⚠️ Ce fichier ne doit dépendre **d'aucun** module serveur (`@/db`, `fs`,
 * `next/headers`). Il est importé par `app/utilisateurs/historique/page.tsx`,
 * un composant client : importer `lib/audit.ts` directement y ferait entrer
 * `@libsql/client` et `fs` dans le bundle navigateur, ce que Turbopack refuse
 * (et ce que le README §26 interdit : le front ne parle qu'à l'API).
 *
 * `lib/audit.ts` ré-exporte ces symboles pour que le serveur n'ait qu'un seul
 * point d'entrée.
 */

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'cancel'
  | 'login'
  | 'logout'
  | 'payment'
  | 'stock_adjust'
  | 'restore'
  | 'backup'
  | 'settings'
  | 'reset'
  | 'seed';

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  create: 'Création',
  update: 'Modification',
  delete: 'Suppression',
  cancel: 'Annulation',
  login: 'Connexion',
  logout: 'Déconnexion',
  payment: 'Encaissement',
  stock_adjust: 'Ajustement de stock',
  restore: 'Restauration',
  backup: 'Sauvegarde',
  settings: 'Paramètres',
  reset: 'Réinitialisation',
  seed: 'Préremplissage',
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  sales_invoice: 'Facture de vente',
  purchase_invoice: "Facture d'achat",
  payment: 'Paiement',
  customer: 'Client',
  supplier: 'Fournisseur',
  product: 'Produit',
  category: 'Catégorie',
  stock: 'Stock',
  cash_session: 'Session de caisse',
  cash_movement: 'Mouvement de caisse',
  expense: 'Dépense',
  user: 'Utilisateur',
  user_permissions: 'Permissions utilisateur',
  settings: 'Paramètres',
  service_job: 'Chantier',
  brick_production: 'Fabrication de briques',
  brick_type: 'Type de brique',
  furniture_order: 'Commande de meuble',
  furniture_model: 'Modèle de meuble',
  worker: 'Ouvrier',
  report_deliveries: 'Rapport envoyé',
  sync: 'Synchronisation',
  database: 'Base de données',
};

/** Libellé lisible d'une action, avec repli sur la valeur brute. */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/** Libellé lisible d'une entité, avec repli lisible sur la valeur brute. */
export function auditEntityLabel(entity: string): string {
  return AUDIT_ENTITY_LABELS[entity] ?? entity.replace(/_/g, ' ');
}
