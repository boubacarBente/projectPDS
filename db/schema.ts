import { sqliteTable, text, integer, real, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';

/**
 * Schéma cible Planète Déco Sarlu — 30 tables métier + 5 tables de
 * synchronisation (README §6.3 et §6.7).
 *
 * Conventions (README §6.1) :
 *  - nommage anglais, `snake_case`, tables au pluriel ;
 *  - `id` entier = clé primaire **locale** ; `sync_id` (UUID) = identité **globale** ;
 *  - `date` est une date métier `YYYY-MM-DD` (seul champ filtré) ;
 *  - `created_at` est un horodatage de traçabilité ;
 *  - montants et quantités en `real` (le m² et le kg ne sont pas entiers).
 *
 * Chaque table métier porte les quatre colonnes de synchronisation dès le
 * lot 0, même si la synchronisation reste désactivée (§6.7) : les ajouter plus
 * tard obligerait à migrer 30 tables sur des postes déjà en production.
 */
const syncCols = () => ({
  syncId: text('sync_id')
    .notNull()
    .unique()
    .$defaultFn(() => crypto.randomUUID()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  originDeviceId: text('origin_device_id'),
});

const createdAt = () =>
  integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date());

/* ------------------------------------------------------------------ *
 * 1. Utilisateurs et traçabilité
 * ------------------------------------------------------------------ */

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /** admin (administrateur général) | manager (gérant) | seller | storekeeper */
  role: text('role').notNull().default('seller'),
  phone: text('phone'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
  createdAt: createdAt(),
  ...syncCols(),
});

/** Journal des actions importantes (§12, §14, README §17.3). */
export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').references(() => users.id),
  userName: text('user_name').notNull(),
  /** Magasin concerné (null = action centrale). */
  storeId: integer('store_id'),
  /** create | update | delete | cancel | login | logout | payment | stock_adjust | restore | backup | settings */
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: integer('entity_id'),
  /** JSON sérialisé : avant / après, motif, contexte */
  details: text('details'),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('audit_logs_created_idx').on(t.createdAt),
  index('audit_logs_store_idx').on(t.storeId),
  index('audit_logs_entity_idx').on(t.entity, t.entityId),
]);

/**
 * **Surcharges de permissions par utilisateur** (demande explicite du client).
 *
 * Le rôle donne un jeu de permissions par défaut (`lib/permissions.ts`). Cette
 * table permet à l'administrateur de déroger au rôle, **utilisateur par
 * utilisateur et action par action** :
 *   - `effect = 'allow'` → accorde une action que le rôle n'accorde pas ;
 *   - `effect = 'deny'`  → retire une action que le rôle accorde.
 *
 * **Aucune ligne = héritage du rôle.** Une surcharge prime toujours sur la
 * matrice du rôle, dans les deux sens.
 *
 * Le rôle `admin` n'est **jamais** restreint : il a toutes les permissions par
 * construction. C'est ce qui garantit qu'on ne peut pas se verrouiller hors de
 * sa propre application en refusant la dernière permission d'administration.
 *
 * La table porte les colonnes de synchronisation comme les autres : une
 * permission modifiée se réplique donc naturellement en multi-postes.
 */
export const userPermissions = sqliteTable(
  'user_permissions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Identifiant d'action de `lib/permissions.ts` (ex. `sales.cancel`). */
    action: text('action').notNull(),
    effect: text('effect', { enum: ['allow', 'deny'] }).notNull(),
    /** Qui a accordé ou retiré : traçabilité de la décision. */
    grantedBy: integer('granted_by').references(() => users.id),
    note: text('note'),
    createdAt: createdAt(),
    ...syncCols(),
  },
  (table) => [uniqueIndex('user_permissions_user_action_unique').on(table.userId, table.action)],
);


/* ------------------------------------------------------------------ *
 * 1 bis. Magasins (cahier des charges multi-magasins §4, §5, §17)
 * ------------------------------------------------------------------ */

/**
 * Un établissement. `kind = 'headquarters'` désigne le siège : il porte les
 * charges centrales et sert de point de pilotage, mais il fonctionne comme un
 * magasin (caisse, dépenses, stock éventuel).
 *
 * Jamais de suppression physique d'un magasin ayant des opérations : on
 * l'archive (`status = 'archived'`).
 */
export const stores = sqliteTable('stores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Code court, unique, en majuscules — entre dans les numéros de pièces (FAC-KAL1-…). */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['store', 'headquarters'] }).notNull().default('store'),
  address: text('address'),
  phone: text('phone'),
  email: text('email'),
  /** Gérant principal. */
  managerUserId: integer('manager_user_id').references(() => users.id),
  openingDate: text('opening_date'),
  /** active | suspended (plus de nouvelle opération) | archived */
  status: text('status', { enum: ['active', 'suspended', 'archived'] }).notNull().default('active'),
  openingHours: text('opening_hours'),
  /** Mentions affichées en pied de facture / reçu pour ce magasin. */
  receiptFooter: text('receipt_footer'),
  /** Paramètres locaux (JSON) : remplacent les paramètres globaux autorisés. */
  settings: text('settings'),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
});

/** Affectation explicite d'un utilisateur à un magasin (§5). */
export const userStores = sqliteTable(
  'user_stores',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    /** Gérant de ce magasin (délégation possible, tracée dans l'audit). */
    isManager: integer('is_manager', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    startsAt: text('starts_at'),
    endsAt: text('ends_at'),
    createdAt: createdAt(),
    ...syncCols(),
  },
  (table) => [uniqueIndex('user_stores_user_store_unique').on(table.userId, table.storeId)],
);

/* ------------------------------------------------------------------ *
 * 2. Partenaires
 * ------------------------------------------------------------------ */

export const customers = sqliteTable('customers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  phone: text('phone'),
  address: text('address'),
  notes: text('notes'),
  /** Plafond de crédit (§2). Q18 : avertir en V1, jamais bloquer silencieusement. */
  creditLimit: real('credit_limit').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  ...syncCols(),
});

export const suppliers = sqliteTable('suppliers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  phone: text('phone'),
  address: text('address'),
  notes: text('notes'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  ...syncCols(),
});

/* ------------------------------------------------------------------ *
 * 3. Produits et stock
 * ------------------------------------------------------------------ */

export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  /** finished | raw_material | service — le type est porté par la catégorie */
  kind: text('kind').notNull().default('finished'),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  ...syncCols(),
});

export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    categoryId: integer('category_id').references(() => categories.id),
    /** pièce, ensemble, carton, m², kg, sac, litre — liste fermée dans settings */
    unit: text('unit').notNull().default('pièce'),
    /** Prix d'achat — base du calcul de marge (ex-`unit_price` de Gaz, renommé). */
    purchasePrice: real('purchase_price').notNull().default(0),
    salePrice: real('sale_price').notNull().default(0),
    /** Seuil d'alerte par défaut — chaque magasin peut le remplacer (`product_stocks.stock_min`). */
    stockMin: real('stock_min').notNull().default(0),
    /** Code-barres éventuel (§7). */
    barcode: text('barcode'),
    description: text('description'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
    ...syncCols(),
  },
  (table) => [
    /*
     * **Le nom d'un produit est unique** (demande client) — insensible à la
     * casse et aux espaces de bord, sinon « Ciment 50 kg » et « ciment 50 kg »
     * passeraient pour deux produits.
     *
     * La règle est ici **et** dans `lib/products.ts` : la base garantit qu'aucun
     * import, script de reprise ou synchronisation ne peut créer un doublon.
     */
    uniqueIndex('products_name_unique').on(sql`lower(trim(${table.name}))`),
  ],
);


/**
 * **Stock par magasin** (§7). Une ligne par couple magasin × produit.
 *
 * Invariant : `quantity` = somme algébrique des `stock_movements` du magasin
 * pour ce produit. La synchronisation recalcule `quantity` depuis les
 * mouvements après chaque réception de données : deux postes hors ligne ne
 * peuvent donc jamais « perdre » une vente en écrasant le stock l'un de l'autre.
 */
export const productStocks = sqliteTable(
  'product_stocks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    quantity: real('quantity').notNull().default(0),
    /** Seuil d'alerte propre au magasin (null = celui du produit). */
    stockMin: real('stock_min'),
    /** Prix de vente local (null = prix du catalogue). */
    salePrice: real('sale_price'),
    createdAt: createdAt(),
    ...syncCols(),
  },
  (table) => [
    uniqueIndex('product_stocks_store_product_unique').on(table.storeId, table.productId),
    index('product_stocks_product_idx').on(table.productId),
  ],
);

/**
 * Journal unique du stock (§4).
 * Invariant : `product_stocks.quantity` = somme algébrique des mouvements du magasin.
 * `adjustment` stocke un **écart signé**, jamais une valeur absolue (§6.1).
 */
export const stockMovements = sqliteTable('stock_movements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storeId: integer('store_id').references(() => stores.id),
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  /** entry | exit | adjustment */
  type: text('type', { enum: ['entry', 'exit', 'adjustment'] }).notNull(),
  quantity: real('quantity').notNull(),
  motif: text('motif').notNull(),
  stockBefore: real('stock_before').notNull(),
  stockAfter: real('stock_after').notNull(),
  /** sale | purchase | service_job | inventory | transfer | adjustment */
  referenceType: text('reference_type'),
  referenceId: integer('reference_id'),
  userId: integer('user_id').references(() => users.id),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('stock_movements_store_product_idx').on(t.storeId, t.productId),
  index('stock_movements_reference_idx').on(t.referenceType, t.referenceId),
]);

/* ------------------------------------------------------------------ *
 * 4. Ventes, achats, paiements
 * ------------------------------------------------------------------ */

export const salesInvoices = sqliteTable('sales_invoices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storeId: integer('store_id').references(() => stores.id),
  invoiceNumber: text('invoice_number').notNull().unique(),
  /** `null` = vente comptoir (§10.5) */
  customerId: integer('customer_id').references(() => customers.id),
  customerName: text('customer_name').notNull(),
  userId: integer('user_id').references(() => users.id),
  /** Date métier YYYY-MM-DD */
  date: text('date').notNull(),
  /** Échéance en cas de crédit (§7) */
  dueDate: text('due_date'),
  subTotal: real('sub_total').notNull().default(0),
  discount: real('discount').notNull().default(0),
  /** sub_total − discount */
  totalHt: real('total_ht').notNull().default(0),
  taxRate: real('tax_rate').notNull().default(0),
  taxAmount: real('tax_amount').notNull().default(0),
  /** total_ht + tax_amount */
  total: real('total').notNull().default(0),
  amountPaid: real('amount_paid').notNull().default(0),
  remainingAmount: real('remaining_amount').notNull().default(0),
  /** paid | partial | unpaid */
  paymentStatus: text('payment_status').notNull().default('unpaid'),
  paymentMethod: text('payment_method').notNull().default('Espèces'),
  /** draft | active | cancelled */
  status: text('status', { enum: ['draft', 'active', 'cancelled'] }).notNull().default('active'),
  /** Canal de vente (conservé pour compatibilité ; `general` uniquement). */
  channel: text('channel', { enum: ['general', 'brick'] }).notNull().default('general'),
  cancelReason: text('cancel_reason'),
  cancelledBy: integer('cancelled_by').references(() => users.id),
  cancelledAt: integer('cancelled_at', { mode: 'timestamp' }),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('sales_invoices_store_date_idx').on(t.storeId, t.date),
  index('sales_invoices_customer_idx').on(t.customerId),
]);

/**
 * Lignes de facture de vente.
 * Instantané volontaire de `product_name` / `unit` : une facture de 2026 doit
 * rester imprimable même si le produit est renommé.
 */
export const salesInvoiceItems = sqliteTable('sales_invoice_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  invoiceId: integer('invoice_id')
    .notNull()
    .references(() => salesInvoices.id, { onDelete: 'cascade' }),
  productId: integer('product_id').references(() => products.id),
  productName: text('product_name').notNull(),
  unit: text('unit').notNull().default('pièce'),
  quantity: real('quantity').notNull(),
  unitPrice: real('unit_price').notNull(),
  discount: real('discount').notNull().default(0),
  amount: real('amount').notNull(),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('sales_invoice_items_invoice_idx').on(t.invoiceId),
  index('sales_invoice_items_product_idx').on(t.productId),
]);

export const purchaseInvoices = sqliteTable('purchase_invoices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storeId: integer('store_id').references(() => stores.id),
  /** Notre numéro ACH-… */
  reference: text('reference').notNull().unique(),
  /** Numéro de facture du fournisseur */
  supplierReference: text('supplier_reference'),
  supplierId: integer('supplier_id').references(() => suppliers.id),
  userId: integer('user_id').references(() => users.id),
  date: text('date').notNull(),
  dueDate: text('due_date'),
  total: real('total').notNull().default(0),
  amountPaid: real('amount_paid').notNull().default(0),
  remainingAmount: real('remaining_amount').notNull().default(0),
  paymentStatus: text('payment_status').notNull().default('unpaid'),
  paymentMethod: text('payment_method').notNull().default('Espèces'),
  status: text('status', { enum: ['active', 'cancelled'] }).notNull().default('active'),
  cancelReason: text('cancel_reason'),
  cancelledBy: integer('cancelled_by').references(() => users.id),
  cancelledAt: integer('cancelled_at', { mode: 'timestamp' }),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('purchase_invoices_store_date_idx').on(t.storeId, t.date),
  index('purchase_invoices_supplier_idx').on(t.supplierId),
]);

export const purchaseInvoiceItems = sqliteTable('purchase_invoice_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  invoiceId: integer('invoice_id')
    .notNull()
    .references(() => purchaseInvoices.id, { onDelete: 'cascade' }),
  productId: integer('product_id').references(() => products.id),
  productName: text('product_name').notNull(),
  unit: text('unit').notNull().default('pièce'),
  quantity: real('quantity').notNull(),
  unitPrice: real('unit_price').notNull(),
  amount: real('amount').notNull(),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('purchase_invoice_items_invoice_idx').on(t.invoiceId),
]);

/**
 * Paiements polymorphes — un seul mécanisme d'acompte, de solde et de reçu
 * pour les ventes, les achats et les prestations (§6.1).
 *
 * ⚠️ `reference_id` n'est **pas** une clé étrangère : l'intégrité est garantie
 * par `lib/payments.ts`, jamais par la base.
 */
export const payments = sqliteTable('payments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storeId: integer('store_id').references(() => stores.id),
  receiptNumber: text('receipt_number').notNull().unique(),
  /** sale | purchase | service_job (`brick_order` : historique de l'ancienne briqueterie) */
  type: text('type', { enum: ['sale', 'purchase', 'service_job', 'brick_order'] }).notNull(),
  referenceId: integer('reference_id').notNull(),
  amount: real('amount').notNull(),
  paymentMethod: text('payment_method').notNull().default('Espèces'),
  /** deposit | balance | full — acompte / solde / intégral (§7) */
  paymentLabel: text('payment_label', { enum: ['deposit', 'balance', 'full'] })
    .notNull()
    .default('full'),
  /** Date métier YYYY-MM-DD */
  date: text('date').notNull(),
  notes: text('notes'),
  userId: integer('user_id').references(() => users.id),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('payments_reference_idx').on(t.type, t.referenceId),
  index('payments_store_date_idx').on(t.storeId, t.date),
]);

/* ------------------------------------------------------------------ *
 * 5. Caisse et dépenses
 * ------------------------------------------------------------------ */

export const cashSessions = sqliteTable('cash_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storeId: integer('store_id').references(() => stores.id),
  /** open | closed — une seule session `open` à la fois */
  status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  openedAt: integer('opened_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  openedBy: integer('opened_by').references(() => users.id),
  openingAmount: real('opening_amount').notNull().default(0),
  closedAt: integer('closed_at', { mode: 'timestamp' }),
  closedBy: integer('closed_by').references(() => users.id),
  theoreticalAmount: real('theoretical_amount'),
  countedAmount: real('counted_amount'),
  /** counted_amount − theoretical_amount (écart de clôture, §8) */
  difference: real('difference'),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('cash_sessions_store_status_idx').on(t.storeId, t.status),
]);

export const cashMovements = sqliteTable('cash_movements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storeId: integer('store_id').references(() => stores.id),
  /** income | expense */
  type: text('type', { enum: ['income', 'expense'] }).notNull(),
  amount: real('amount').notNull(),
  /** Espèces / Mobile Money (§8) */
  paymentMethod: text('payment_method').notNull().default('Espèces'),
  motif: text('motif').notNull(),
  /** sale | payment | purchase | expense | manual */
  referenceType: text('reference_type'),
  referenceId: integer('reference_id'),
  sessionId: integer('session_id').references(() => cashSessions.id),
  balanceAfter: real('balance_after').notNull().default(0),
  /** Date métier YYYY-MM-DD */
  date: text('date').notNull(),
  userId: integer('user_id').references(() => users.id),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('cash_movements_store_date_idx').on(t.storeId, t.date),
  index('cash_movements_session_idx').on(t.sessionId),
]);

/** Une dépense sort de la caisse et n'affecte jamais le stock (§9, §14). */
export const expenses = sqliteTable('expenses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storeId: integer('store_id').references(() => stores.id),
  /** Liste fermée issue de `settings.expense_categories` */
  category: text('category').notNull(),
  amount: real('amount').notNull(),
  description: text('description'),
  paymentMethod: text('payment_method').notNull().default('Espèces'),
  referenceType: text('reference_type'),
  referenceId: integer('reference_id'),
  beneficiary: text('beneficiary'),
  /** approved (décaissée) | pending (en attente) | to_pay (approuvée, à décaisser) | rejected — §12 */
  approvalStatus: text('approval_status', { enum: ['approved', 'pending', 'to_pay', 'rejected'] })
    .notNull()
    .default('approved'),
  approvedBy: integer('approved_by').references(() => users.id),
  approvedAt: integer('approved_at', { mode: 'timestamp' }),
  /** Date métier YYYY-MM-DD */
  date: text('date').notNull(),
  userId: integer('user_id').references(() => users.id),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('expenses_store_date_idx').on(t.storeId, t.date),
]);

/* ------------------------------------------------------------------ *
 * 6. Prestations et main-d'œuvre
 * ------------------------------------------------------------------ */

/** Une seule table de main-d'œuvre pour les 3 modules (§6.1). */
export const workers = sqliteTable('workers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  phone: text('phone'),
  /** foreman | worker | apprentice */
  role: text('role', { enum: ['foreman', 'worker', 'apprentice'] })
    .notNull()
    .default('worker'),
  specialty: text('specialty'),
  dailyRate: real('daily_rate').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  ...syncCols(),
});

/**
 * Prestations de service (chantiers, §16).
 * Document facturable **autonome** : son propre numéro, ses propres totaux et
 * ses propres paiements — il ne génère pas de facture de vente, ce qui évite
 * tout double comptage du chiffre d'affaires (§15).
 */
export const serviceJobs = sqliteTable('service_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storeId: integer('store_id').references(() => stores.id),
  reference: text('reference').notNull().unique(),
  customerId: integer('customer_id')
    .notNull()
    .references(() => customers.id),
  /** alucobond | staff | placo | furniture | painting */
  // Type de prestation : libellé de la liste `settings.jobCategories` (anciens codes traduits par lib/jobs.ts).
  category: text('category')
    .notNull()
    .default('placo'),
  title: text('title'),
  siteAddress: text('site_address'),
  description: text('description'),
  startDate: text('start_date'),
  endDate: text('end_date'),
  /** quote | pending | in_progress | completed | cancelled */
  status: text('status', {
    enum: ['quote', 'pending', 'in_progress', 'completed', 'cancelled'],
  })
    .notNull()
    .default('quote'),
  /** draft | sent | accepted | refused */
  quoteStatus: text('quote_status', {
    enum: ['draft', 'sent', 'accepted', 'refused'],
  })
    .notNull()
    .default('draft'),
  quoteMaterials: real('quote_materials').notNull().default(0),
  quoteLabor: real('quote_labor').notNull().default(0),
  quoteTotal: real('quote_total').notNull().default(0),
  total: real('total').notNull().default(0),
  amountPaid: real('amount_paid').notNull().default(0),
  remainingAmount: real('remaining_amount').notNull().default(0),
  paymentStatus: text('payment_status').notNull().default('unpaid'),
  userId: integer('user_id').references(() => users.id),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('service_jobs_store_idx').on(t.storeId),
  index('service_jobs_customer_idx').on(t.customerId),
]);

export const serviceJobMaterials = sqliteTable('service_job_materials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id')
    .notNull()
    .references(() => serviceJobs.id, { onDelete: 'cascade' }),
  productId: integer('product_id').references(() => products.id),
  productName: text('product_name').notNull(),
  unit: text('unit').notNull().default('pièce'),
  quantity: real('quantity').notNull(),
  unitCost: real('unit_cost').notNull().default(0),
  amount: real('amount').notNull().default(0),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('service_job_materials_job_idx').on(t.jobId),
]);

export const serviceJobWorkers = sqliteTable('service_job_workers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id')
    .notNull()
    .references(() => serviceJobs.id, { onDelete: 'cascade' }),
  workerId: integer('worker_id').references(() => workers.id),
  /** Saisissable à la volée pour un journalier non enregistré (§17). */
  workerName: text('worker_name').notNull(),
  role: text('role'),
  days: real('days').notNull().default(0),
  dailyRate: real('daily_rate').notNull().default(0),
  amount: real('amount').notNull().default(0),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('service_job_workers_job_idx').on(t.jobId),
]);


/* ------------------------------------------------------------------ *
 * 8. Transferts intermagasins et inventaires (§7, §8)
 * ------------------------------------------------------------------ */

export const TRANSFER_STATUSES = [
  'draft',
  'pending',
  'approved',
  'preparing',
  'in_transit',
  'partially_received',
  'received',
  'disputed',
  'refused',
  'cancelled',
] as const;

export const stockTransfers = sqliteTable('stock_transfers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reference: text('reference').notNull().unique(),
  sourceStoreId: integer('source_store_id')
    .notNull()
    .references(() => stores.id),
  destinationStoreId: integer('destination_store_id')
    .notNull()
    .references(() => stores.id),
  status: text('status', { enum: TRANSFER_STATUSES }).notNull().default('draft'),
  reason: text('reason'),
  requestedDate: text('requested_date'),
  requestedBy: integer('requested_by').references(() => users.id),
  approvedBy: integer('approved_by').references(() => users.id),
  approvedAt: integer('approved_at', { mode: 'timestamp' }),
  shippedBy: integer('shipped_by').references(() => users.id),
  shippedAt: integer('shipped_at', { mode: 'timestamp' }),
  receivedBy: integer('received_by').references(() => users.id),
  receivedAt: integer('received_at', { mode: 'timestamp' }),
  closedAt: integer('closed_at', { mode: 'timestamp' }),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('stock_transfers_source_idx').on(t.sourceStoreId, t.status),
  index('stock_transfers_destination_idx').on(t.destinationStoreId, t.status),
]);

export const stockTransferItems = sqliteTable('stock_transfer_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  transferId: integer('transfer_id')
    .notNull()
    .references(() => stockTransfers.id, { onDelete: 'cascade' }),
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  productName: text('product_name').notNull(),
  unit: text('unit').notNull().default('pièce'),
  quantityRequested: real('quantity_requested').notNull(),
  quantityShipped: real('quantity_shipped').notNull().default(0),
  quantityReceived: real('quantity_received').notNull().default(0),
  /** Écart, dommage ou litige signalé à la réception. */
  discrepancyNote: text('discrepancy_note'),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('stock_transfer_items_transfer_idx').on(t.transferId),
]);

/** Historique immuable d'un transfert : qui, quand, quel changement. */
export const stockTransferEvents = sqliteTable('stock_transfer_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  transferId: integer('transfer_id')
    .notNull()
    .references(() => stockTransfers.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  storeId: integer('store_id').references(() => stores.id),
  userId: integer('user_id').references(() => users.id),
  userName: text('user_name'),
  note: text('note'),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('stock_transfer_events_transfer_idx').on(t.transferId),
]);

export const inventories = sqliteTable('inventories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reference: text('reference').notNull().unique(),
  storeId: integer('store_id')
    .notNull()
    .references(() => stores.id),
  /** open (comptage en cours) | validated (écarts appliqués) | cancelled */
  status: text('status', { enum: ['open', 'validated', 'cancelled'] }).notNull().default('open'),
  /** Catégorie inventoriée (null = tout le catalogue). */
  categoryId: integer('category_id').references(() => categories.id),
  openedBy: integer('opened_by').references(() => users.id),
  validatedBy: integer('validated_by').references(() => users.id),
  validatedAt: integer('validated_at', { mode: 'timestamp' }),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('inventories_store_idx').on(t.storeId, t.status),
]);

export const inventoryItems = sqliteTable('inventory_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  inventoryId: integer('inventory_id')
    .notNull()
    .references(() => inventories.id, { onDelete: 'cascade' }),
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  productName: text('product_name').notNull(),
  unit: text('unit').notNull().default('pièce'),
  /** Stock théorique au moment du comptage. */
  expectedQuantity: real('expected_quantity').notNull().default(0),
  countedQuantity: real('counted_quantity'),
  justification: text('justification'),
  createdAt: createdAt(),
  ...syncCols(),
}, (t) => [
  index('inventory_items_inventory_idx').on(t.inventoryId),
]);

/* ------------------------------------------------------------------ *
 * 9. Rapports et paramètres
 * ------------------------------------------------------------------ */

export const reportDeliveries = sqliteTable('report_deliveries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storeId: integer('store_id').references(() => stores.id),
  /** day | week | month */
  period: text('period', { enum: ['day', 'week', 'month'] }).notNull().default('day'),
  fromDate: text('from_date').notNull(),
  toDate: text('to_date').notNull(),
  /** sms | whatsapp */
  channel: text('channel', { enum: ['sms', 'whatsapp'] }).notNull().default('whatsapp'),
  recipients: text('recipients').notNull(),
  content: text('content').notNull(),
  /** sent | failed */
  status: text('status', { enum: ['sent', 'failed'] }).notNull().default('sent'),
  error: text('error'),
  /** auto | manual */
  triggeredBy: text('triggered_by', { enum: ['auto', 'manual'] }).notNull().default('manual'),
  userId: integer('user_id').references(() => users.id),
  sentAt: integer('sent_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  createdAt: createdAt(),
  ...syncCols(),
});

/**
 * Paramètres clé/valeur + couche typée `lib/settings.ts`.
 * Ajouter un réglage ne demande **aucune migration** (§6.1).
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
  syncId: text('sync_id')
    .notNull()
    .unique()
    .$defaultFn(() => crypto.randomUUID()),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  originDeviceId: text('origin_device_id'),
});

/* ------------------------------------------------------------------ *
 * 10. Tables locales de synchronisation (§23.13) — jamais synchronisées
 * ------------------------------------------------------------------ */

/** Appareils connus. */
export const devices = sqliteTable('devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  deviceId: text('device_id').notNull().unique(),
  name: text('name').notNull(),
  isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  lastPushAt: integer('last_push_at', { mode: 'timestamp' }),
  lastPullAt: integer('last_pull_at', { mode: 'timestamp' }),
  createdAt: createdAt(),
});

/** Watermarks par table + état runtime de la synchronisation. */
export const syncState = sqliteTable('sync_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  value: text('value'),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * **Journal des changements à envoyer** (alimenté par des triggers SQLite,
 * voir `lib/sync-triggers.ts`) : une ligne par enregistrement modifié depuis
 * le dernier envoi. Les triggers garantissent qu'aucune écriture — Drizzle ou
 * SQL brut — n'échappe à la synchronisation.
 */
export const syncChanges = sqliteTable(
  'sync_changes',
  {
    tableName: text('table_name').notNull(),
    syncId: text('sync_id').notNull(),
    deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
    /** Compteur monotone : permet d'acquitter un envoi sans perdre une modification survenue pendant. */
    changeSeq: integer('change_seq').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [primaryKey({ columns: [table.tableName, table.syncId] })],
);

/**
 * Sessions de connexion (§5, §19.3) — locales au poste, jamais synchronisées.
 * Le cookie ne contient qu'un jeton aléatoire ; seul son SHA-256 est stocké.
 */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  /** Magasin actif choisi après connexion (vérifié à chaque requête). */
  storeId: integer('store_id'),
  createdAt: createdAt(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
});

/** Compteurs de numérotation, locaux au poste (jamais synchronisés). */
export const docSequences = sqliteTable('doc_sequences', {
  key: text('key').primaryKey(),
  value: integer('value').notNull().default(0),
});

/** Tentatives de connexion échouées (protection contre les essais répétés). */
export const loginAttempts = sqliteTable('login_attempts', {
  username: text('username').primaryKey(),
  failures: integer('failures').notNull().default(0),
  lockedUntil: integer('locked_until', { mode: 'timestamp' }),
  lastFailureAt: integer('last_failure_at', { mode: 'timestamp' }),
});

/** Lignes reçues en quarantaine (référence parente manquante, §23.4). */
export const syncPending = sqliteTable('sync_pending', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tableName: text('table_name').notNull(),
  syncId: text('sync_id').notNull(),
  payload: text('payload').notNull(),
  missingParent: text('missing_parent'),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp' }),
  lastError: text('last_error'),
  createdAt: createdAt(),
});

/** Conflits à trancher par un humain (§23.7). */
export const syncConflicts = sqliteTable('sync_conflicts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tableName: text('table_name').notNull(),
  syncId: text('sync_id').notNull(),
  localPayload: text('local_payload').notNull(),
  remotePayload: text('remote_payload').notNull(),
  /** pending | local | remote */
  resolution: text('resolution', { enum: ['pending', 'local', 'remote'] })
    .notNull()
    .default('pending'),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  resolvedBy: integer('resolved_by').references(() => users.id),
  createdAt: createdAt(),
});

/* ------------------------------------------------------------------ *
 * Relations Drizzle (§6.4)
 * ------------------------------------------------------------------ */

export const categoryRelations = relations(categories, ({ many }) => ({
  products: many(products),
}));

export const productRelations = relations(products, ({ one, many }) => ({
  category: one(categories, {
    fields: [products.categoryId],
    references: [categories.id],
  }),
  stockMovements: many(stockMovements),
}));

export const stockMovementRelations = relations(stockMovements, ({ one }) => ({
  product: one(products, {
    fields: [stockMovements.productId],
    references: [products.id],
  }),
  user: one(users, {
    fields: [stockMovements.userId],
    references: [users.id],
  }),
}));

export const customerRelations = relations(customers, ({ many }) => ({
  salesInvoices: many(salesInvoices),
  serviceJobs: many(serviceJobs),
}));

export const supplierRelations = relations(suppliers, ({ many }) => ({
  purchaseInvoices: many(purchaseInvoices),
}));

export const salesInvoiceRelations = relations(salesInvoices, ({ one, many }) => ({
  customer: one(customers, {
    fields: [salesInvoices.customerId],
    references: [customers.id],
  }),
  user: one(users, {
    fields: [salesInvoices.userId],
    references: [users.id],
  }),
  items: many(salesInvoiceItems),
}));

export const salesInvoiceItemRelations = relations(salesInvoiceItems, ({ one }) => ({
  invoice: one(salesInvoices, {
    fields: [salesInvoiceItems.invoiceId],
    references: [salesInvoices.id],
  }),
  product: one(products, {
    fields: [salesInvoiceItems.productId],
    references: [products.id],
  }),
}));

export const purchaseInvoiceRelations = relations(purchaseInvoices, ({ one, many }) => ({
  supplier: one(suppliers, {
    fields: [purchaseInvoices.supplierId],
    references: [suppliers.id],
  }),
  user: one(users, {
    fields: [purchaseInvoices.userId],
    references: [users.id],
  }),
  items: many(purchaseInvoiceItems),
}));

export const purchaseInvoiceItemRelations = relations(purchaseInvoiceItems, ({ one }) => ({
  invoice: one(purchaseInvoices, {
    fields: [purchaseInvoiceItems.invoiceId],
    references: [purchaseInvoices.id],
  }),
  product: one(products, {
    fields: [purchaseInvoiceItems.productId],
    references: [products.id],
  }),
}));

export const cashSessionRelations = relations(cashSessions, ({ many }) => ({
  movements: many(cashMovements),
}));

export const cashMovementRelations = relations(cashMovements, ({ one }) => ({
  store: one(stores, {
    fields: [cashMovements.storeId],
    references: [stores.id],
  }),
  session: one(cashSessions, {
    fields: [cashMovements.sessionId],
    references: [cashSessions.id],
  }),
  user: one(users, {
    fields: [cashMovements.userId],
    references: [users.id],
  }),
}));

export const serviceJobRelations = relations(serviceJobs, ({ one, many }) => ({
  customer: one(customers, {
    fields: [serviceJobs.customerId],
    references: [customers.id],
  }),
  materials: many(serviceJobMaterials),
  workers: many(serviceJobWorkers),
}));

export const serviceJobMaterialRelations = relations(serviceJobMaterials, ({ one }) => ({
  job: one(serviceJobs, {
    fields: [serviceJobMaterials.jobId],
    references: [serviceJobs.id],
  }),
  product: one(products, {
    fields: [serviceJobMaterials.productId],
    references: [products.id],
  }),
}));

export const serviceJobWorkerRelations = relations(serviceJobWorkers, ({ one }) => ({
  job: one(serviceJobs, {
    fields: [serviceJobWorkers.jobId],
    references: [serviceJobs.id],
  }),
  worker: one(workers, {
    fields: [serviceJobWorkers.workerId],
    references: [workers.id],
  }),
}));

export const workerRelations = relations(workers, ({ many }) => ({
  jobAssignments: many(serviceJobWorkers),
}));

export const auditLogRelations = relations(auditLogs, ({ one }) => ({
  user: one(users, {
    fields: [auditLogs.userId],
    references: [users.id],
  }),
}));

/* ------------------------------------------------------------------ *
 * Types TypeScript inférés
 * ------------------------------------------------------------------ */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type StockMovement = typeof stockMovements.$inferSelect;
export type NewStockMovement = typeof stockMovements.$inferInsert;
export type SalesInvoice = typeof salesInvoices.$inferSelect;
export type NewSalesInvoice = typeof salesInvoices.$inferInsert;
export type SalesInvoiceItem = typeof salesInvoiceItems.$inferSelect;
export type NewSalesInvoiceItem = typeof salesInvoiceItems.$inferInsert;
export type PurchaseInvoice = typeof purchaseInvoices.$inferSelect;
export type NewPurchaseInvoice = typeof purchaseInvoices.$inferInsert;
export type PurchaseInvoiceItem = typeof purchaseInvoiceItems.$inferSelect;
export type NewPurchaseInvoiceItem = typeof purchaseInvoiceItems.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type CashSession = typeof cashSessions.$inferSelect;
export type NewCashSession = typeof cashSessions.$inferInsert;
export type CashMovement = typeof cashMovements.$inferSelect;
export type NewCashMovement = typeof cashMovements.$inferInsert;
export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
export type Worker = typeof workers.$inferSelect;
export type NewWorker = typeof workers.$inferInsert;
export type ServiceJob = typeof serviceJobs.$inferSelect;
export type NewServiceJob = typeof serviceJobs.$inferInsert;
export type ServiceJobMaterial = typeof serviceJobMaterials.$inferSelect;
export type NewServiceJobMaterial = typeof serviceJobMaterials.$inferInsert;
export type ServiceJobWorker = typeof serviceJobWorkers.$inferSelect;
export type NewServiceJobWorker = typeof serviceJobWorkers.$inferInsert;
export type ReportDelivery = typeof reportDeliveries.$inferSelect;
export type NewReportDelivery = typeof reportDeliveries.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
export type SyncChangeRow = typeof syncChanges.$inferSelect;
export type Store = typeof stores.$inferSelect;
export type UserStore = typeof userStores.$inferSelect;
export type ProductStock = typeof productStocks.$inferSelect;
export type StockTransfer = typeof stockTransfers.$inferSelect;
export type StockTransferItem = typeof stockTransferItems.$inferSelect;
export type Inventory = typeof inventories.$inferSelect;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type SyncPendingRow = typeof syncPending.$inferSelect;
export type SyncConflictRow = typeof syncConflicts.$inferSelect;
