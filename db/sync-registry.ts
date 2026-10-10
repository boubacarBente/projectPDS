/**
 * Registre des tables synchronisées (option B : base locale par magasin +
 * serveur central PostgreSQL).
 *
 * Fichier **sans dépendance** (pas d'import de `@/db`) : il est lu par les
 * triggers de capture (`db/triggers.ts`), par le moteur de synchronisation
 * (`lib/sync-engine.ts`), par la sauvegarde et par les scripts de test.
 *
 * Chaque table déclare sa **portée** — c'est elle qui décide quels postes
 * reçoivent la ligne :
 *  - `global`   : référentiel partagé (catalogue, utilisateurs, magasins…),
 *                 reçu par tous les postes ;
 *  - `store`    : opération d'un magasin (colonne `store_id`), reçue par les
 *                 postes de ce magasin et par le siège ;
 *  - `child`    : ligne rattachée à un document parent ; elle hérite de la
 *                 portée du parent ;
 *  - `transfer` : transfert intermagasins, reçu par **les deux** magasins.
 *
 * `hqOnly` : la table ne peut être modifiée que depuis un poste « siège »
 * (ou une installation autonome). Un poste de magasin ne la pousse jamais :
 * c'est ce qui garantit un catalogue, des comptes et des paramètres centraux.
 *
 * L'ordre du tableau est l'ordre d'application : les parents avant les enfants.
 */

export type SyncScope =
  | { kind: 'global' }
  | { kind: 'store'; column: string }
  | { kind: 'child'; parentTable: string; parentColumn: string }
  | { kind: 'transfer' };

export type SyncedTable = {
  name: string;
  scope: SyncScope;
  hqOnly?: boolean;
  /**
   * Clé naturelle : si une ligne reçue n'existe pas localement par `sync_id`
   * mais qu'une ligne locale porte la même clé naturelle (créée hors ligne sur
   * ce poste), on **fusionne** : la ligne locale adopte l'identité reçue.
   * Évite les doublons sur les contraintes d'unicité.
   */
  naturalKey?: string[];
  /**
   * Références polymorphes (`type` + `reference_id`) : colonne de type,
   * colonne d'identifiant, et table cible selon la valeur du type.
   */
  polymorphic?: { typeColumn: string; idColumn: string; targets: Record<string, string> }[];
};

export const SYNCED_TABLES: SyncedTable[] = [
  { name: 'users', scope: { kind: 'global' }, hqOnly: true, naturalKey: ['username'] },
  { name: 'stores', scope: { kind: 'global' }, hqOnly: true, naturalKey: ['code'] },
  { name: 'user_stores', scope: { kind: 'global' }, hqOnly: true, naturalKey: ['user_id', 'store_id'] },
  { name: 'user_permissions', scope: { kind: 'global' }, hqOnly: true, naturalKey: ['user_id', 'action'] },
  { name: 'settings', scope: { kind: 'global' }, hqOnly: true, naturalKey: ['key'] },
  // Liste commune ; un poste magasin peut y ajouter une catégorie (README §28.5).
  { name: 'categories', scope: { kind: 'global' }, naturalKey: ['name'] },
  /*
   * Catalogue commun, mais **un magasin peut créer ses produits** (assortiment
   * par magasin, README §28.5) : la table n'est plus `hqOnly`. Qui peut
   * modifier quelle fiche est décidé côté serveur (`canEditProductCatalog`).
   * Clé naturelle : deux magasins qui créent hors ligne le même nom exact
   * obtiennent un seul produit.
   */
  { name: 'products', scope: { kind: 'global' }, naturalKey: ['name'] },
  /*
   * Clients et fournisseurs **propres à chaque magasin** (README §28.5) : un
   * poste ne reçoit que ceux de son magasin, le siège les reçoit tous.
   */
  { name: 'customers', scope: { kind: 'store', column: 'store_id' } },
  { name: 'suppliers', scope: { kind: 'store', column: 'store_id' } },
  // Ouvriers propres à chaque magasin (README §28.5).
  { name: 'workers', scope: { kind: 'store', column: 'store_id' } },
  { name: 'product_stocks', scope: { kind: 'store', column: 'store_id' }, naturalKey: ['store_id', 'product_id'] },
  { name: 'sales_invoices', scope: { kind: 'store', column: 'store_id' } },
  {
    name: 'sales_invoice_items',
    scope: { kind: 'child', parentTable: 'sales_invoices', parentColumn: 'invoice_id' },
  },
  { name: 'purchase_invoices', scope: { kind: 'store', column: 'store_id' } },
  {
    name: 'purchase_invoice_items',
    scope: { kind: 'child', parentTable: 'purchase_invoices', parentColumn: 'invoice_id' },
  },
  /*
   * Prestations de chantier : le catalogue est **local au magasin** (portée
   * store, pas hqOnly). Demandes et devis passent **avant** les chantiers, qui
   * les référencent (devis d'origine, demande d'origine).
   */
  { name: 'services', scope: { kind: 'store', column: 'store_id' }, naturalKey: ['store_id', 'code'] },
  {
    name: 'service_price_history',
    scope: { kind: 'child', parentTable: 'services', parentColumn: 'service_id' },
  },
  { name: 'service_requests', scope: { kind: 'store', column: 'store_id' } },
  {
    name: 'service_request_items',
    scope: { kind: 'child', parentTable: 'service_requests', parentColumn: 'request_id' },
  },
  { name: 'quotes', scope: { kind: 'store', column: 'store_id' } },
  {
    name: 'quote_items',
    scope: { kind: 'child', parentTable: 'quotes', parentColumn: 'quote_id' },
  },
  { name: 'service_jobs', scope: { kind: 'store', column: 'store_id' } },
  {
    name: 'service_job_materials',
    scope: { kind: 'child', parentTable: 'service_jobs', parentColumn: 'job_id' },
  },
  {
    name: 'service_job_workers',
    scope: { kind: 'child', parentTable: 'service_jobs', parentColumn: 'job_id' },
  },
  {
    name: 'service_job_items',
    scope: { kind: 'child', parentTable: 'service_jobs', parentColumn: 'job_id' },
  },
  {
    name: 'job_stages',
    scope: { kind: 'child', parentTable: 'service_jobs', parentColumn: 'job_id' },
  },
  {
    name: 'job_subcontracts',
    scope: { kind: 'child', parentTable: 'service_jobs', parentColumn: 'job_id' },
  },
  /*
   * Atelier de meubles (README §29) : modèles et commandes **du magasin**.
   * Les modèles passent avant les commandes et les nomenclatures, qui les
   * référencent.
   */
  { name: 'furniture_models', scope: { kind: 'store', column: 'store_id' }, naturalKey: ['store_id', 'code'] },
  {
    name: 'furniture_model_materials',
    scope: { kind: 'child', parentTable: 'furniture_models', parentColumn: 'model_id' },
  },
  { name: 'furniture_orders', scope: { kind: 'store', column: 'store_id' } },
  {
    name: 'furniture_order_materials',
    scope: { kind: 'child', parentTable: 'furniture_orders', parentColumn: 'order_id' },
  },
  {
    name: 'furniture_order_workers',
    scope: { kind: 'child', parentTable: 'furniture_orders', parentColumn: 'order_id' },
  },
  /*
   * Briqueterie (README §30) : types, lots et commandes **du magasin**. Les
   * commandes passent après `sales_invoices` (facture née de la commande).
   */
  /*
   * Filiales de production (README §31) : la filiale et ses comptes autorisés
   * sont centraux (créés au siège, comme les magasins) ; un client partagé
   * avec une filiale suit la portée de son client (magasin).
   */
  { name: 'production_branches', scope: { kind: 'global' }, hqOnly: true, naturalKey: ['name'] },
  {
    name: 'production_branch_users',
    scope: { kind: 'global' },
    hqOnly: true,
    naturalKey: ['branch_id', 'user_id'],
  },
  {
    name: 'production_branch_customers',
    scope: { kind: 'child', parentTable: 'customers', parentColumn: 'customer_id' },
    naturalKey: ['branch_id', 'customer_id'],
  },
  { name: 'brick_types', scope: { kind: 'store', column: 'store_id' } },
  { name: 'brick_productions', scope: { kind: 'store', column: 'store_id' } },
  {
    name: 'brick_production_workers',
    scope: { kind: 'child', parentTable: 'brick_productions', parentColumn: 'production_id' },
  },
  { name: 'brick_orders', scope: { kind: 'store', column: 'store_id' } },
  {
    name: 'brick_order_items',
    scope: { kind: 'child', parentTable: 'brick_orders', parentColumn: 'order_id' },
  },
  { name: 'stock_transfers', scope: { kind: 'transfer' } },
  {
    name: 'stock_transfer_items',
    scope: { kind: 'child', parentTable: 'stock_transfers', parentColumn: 'transfer_id' },
  },
  {
    name: 'stock_transfer_events',
    scope: { kind: 'child', parentTable: 'stock_transfers', parentColumn: 'transfer_id' },
  },
  { name: 'inventories', scope: { kind: 'store', column: 'store_id' } },
  {
    name: 'inventory_items',
    scope: { kind: 'child', parentTable: 'inventories', parentColumn: 'inventory_id' },
  },
  {
    name: 'payments',
    scope: { kind: 'store', column: 'store_id' },
    polymorphic: [
      {
        typeColumn: 'type',
        idColumn: 'reference_id',
        targets: {
          sale: 'sales_invoices',
          purchase: 'purchase_invoices',
          service_job: 'service_jobs',
          furniture_order: 'furniture_orders',
          brick_order: 'brick_orders',
        },
      },
    ],
  },
  { name: 'cash_sessions', scope: { kind: 'store', column: 'store_id' } },
  {
    name: 'cash_movements',
    scope: { kind: 'store', column: 'store_id' },
    polymorphic: [
      {
        typeColumn: 'reference_type',
        idColumn: 'reference_id',
        targets: {
          sale: 'sales_invoices',
          purchase: 'purchase_invoices',
          payment: 'payments',
          expense: 'expenses',
          service_job: 'service_jobs',
          furniture_order: 'furniture_orders',
          brick_order: 'brick_orders',
        },
      },
    ],
  },
  {
    name: 'stock_movements',
    scope: { kind: 'store', column: 'store_id' },
    polymorphic: [
      {
        typeColumn: 'reference_type',
        idColumn: 'reference_id',
        targets: {
          sale: 'sales_invoices',
          purchase: 'purchase_invoices',
          service_job: 'service_jobs',
          inventory: 'inventories',
          transfer: 'stock_transfers',
        },
      },
    ],
  },
  {
    name: 'expenses',
    scope: { kind: 'store', column: 'store_id' },
    polymorphic: [
      {
        typeColumn: 'reference_type',
        idColumn: 'reference_id',
        targets: { service_job: 'service_jobs', job_subcontract: 'job_subcontracts' },
      },
    ],
  },
  { name: 'report_deliveries', scope: { kind: 'store', column: 'store_id' } },
  { name: 'audit_logs', scope: { kind: 'store', column: 'store_id' } },
];

export const SYNCED_TABLE_NAMES = SYNCED_TABLES.map((t) => t.name);

export function syncedTable(name: string): SyncedTable | undefined {
  return SYNCED_TABLES.find((t) => t.name === name);
}

/**
 * Tables purement locales, jamais synchronisées : sessions, compteurs,
 * file d'envoi, quarantaine, conflits, état de synchronisation.
 */
export const LOCAL_TABLES = [
  'sessions',
  'doc_sequences',
  'login_attempts',
  'devices',
  'sync_state',
  'sync_changes',
  'sync_pending',
  'sync_conflicts',
];
