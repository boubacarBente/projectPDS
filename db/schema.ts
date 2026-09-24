import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

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
  /** admin | manager | seller | storekeeper | carpenter | brickmaker */
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
  /** create | update | delete | cancel | login | logout | payment | stock_adjust | restore | backup | settings */
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: integer('entity_id'),
  /** JSON sérialisé : avant / après, motif, contexte */
  details: text('details'),
  createdAt: createdAt(),
  ...syncCols(),
});

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

export const products = sqliteTable('products', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  categoryId: integer('category_id').references(() => categories.id),
  /** pièce, ensemble, carton, m², kg, sac, litre — liste fermée dans settings */
  unit: text('unit').notNull().default('pièce'),
  /** Prix d'achat — base du calcul de marge (ex-`unit_price` de Gaz, renommé). */
  purchasePrice: real('purchase_price').notNull().default(0),
  salePrice: real('sale_price').notNull().default(0),
  /** real : le m² et le kg exigent du décimal (Gaz utilisait integer). */
  stock: real('stock').notNull().default(0),
  stockMin: real('stock_min').notNull().default(0),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  ...syncCols(),
});

/**
 * Journal unique du stock (§4).
 * Invariant : `products.stock` = somme algébrique des mouvements.
 * `adjustment` stocke un **écart signé**, jamais une valeur absolue (§6.1).
 */
export const stockMovements = sqliteTable('stock_movements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  /** entry | exit | adjustment */
  type: text('type', { enum: ['entry', 'exit', 'adjustment'] }).notNull(),
  quantity: real('quantity').notNull(),
  motif: text('motif').notNull(),
  stockBefore: real('stock_before').notNull(),
  stockAfter: real('stock_after').notNull(),
  /** sale | purchase | brick_production | furniture_order | service_job | inventory */
  referenceType: text('reference_type'),
  referenceId: integer('reference_id'),
  userId: integer('user_id').references(() => users.id),
  createdAt: createdAt(),
  ...syncCols(),
});

/* ------------------------------------------------------------------ *
 * 4. Ventes, achats, paiements
 * ------------------------------------------------------------------ */

export const salesInvoices = sqliteTable('sales_invoices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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
  cancelReason: text('cancel_reason'),
  cancelledBy: integer('cancelled_by').references(() => users.id),
  cancelledAt: integer('cancelled_at', { mode: 'timestamp' }),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
});

/**
 * Lignes de facture de vente.
 * Instantané volontaire de `product_code` / `product_name` / `unit` : une
 * facture de 2026 doit rester imprimable même si le produit est renommé.
 */
export const salesInvoiceItems = sqliteTable('sales_invoice_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  invoiceId: integer('invoice_id')
    .notNull()
    .references(() => salesInvoices.id, { onDelete: 'cascade' }),
  productId: integer('product_id').references(() => products.id),
  productCode: text('product_code').notNull(),
  productName: text('product_name').notNull(),
  unit: text('unit').notNull().default('pièce'),
  quantity: real('quantity').notNull(),
  unitPrice: real('unit_price').notNull(),
  discount: real('discount').notNull().default(0),
  amount: real('amount').notNull(),
  createdAt: createdAt(),
  ...syncCols(),
});

export const purchaseInvoices = sqliteTable('purchase_invoices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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
});

export const purchaseInvoiceItems = sqliteTable('purchase_invoice_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  invoiceId: integer('invoice_id')
    .notNull()
    .references(() => purchaseInvoices.id, { onDelete: 'cascade' }),
  productId: integer('product_id').references(() => products.id),
  productCode: text('product_code').notNull(),
  productName: text('product_name').notNull(),
  unit: text('unit').notNull().default('pièce'),
  quantity: real('quantity').notNull(),
  unitPrice: real('unit_price').notNull(),
  amount: real('amount').notNull(),
  createdAt: createdAt(),
  ...syncCols(),
});

/**
 * Paiements polymorphes — un seul mécanisme d'acompte, de solde et de reçu
 * pour les ventes, les achats et les prestations (§6.1).
 *
 * ⚠️ `reference_id` n'est **pas** une clé étrangère : l'intégrité est garantie
 * par `lib/payments.ts`, jamais par la base.
 */
export const payments = sqliteTable('payments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  receiptNumber: text('receipt_number').notNull().unique(),
  /** sale | purchase | service_job */
  type: text('type', { enum: ['sale', 'purchase', 'service_job'] }).notNull(),
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
});

/* ------------------------------------------------------------------ *
 * 5. Caisse et dépenses
 * ------------------------------------------------------------------ */

export const cashSessions = sqliteTable('cash_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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
});

export const cashMovements = sqliteTable('cash_movements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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
});

/** Une dépense sort de la caisse et n'affecte jamais le stock (§9, §14). */
export const expenses = sqliteTable('expenses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Liste fermée issue de `settings.expense_categories` */
  category: text('category').notNull(),
  amount: real('amount').notNull(),
  description: text('description'),
  paymentMethod: text('payment_method').notNull().default('Espèces'),
  referenceType: text('reference_type'),
  referenceId: integer('reference_id'),
  beneficiary: text('beneficiary'),
  /** Date métier YYYY-MM-DD */
  date: text('date').notNull(),
  userId: integer('user_id').references(() => users.id),
  createdAt: createdAt(),
  ...syncCols(),
});

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
  reference: text('reference').notNull().unique(),
  customerId: integer('customer_id')
    .notNull()
    .references(() => customers.id),
  /** alucobond | staff | placo | furniture | painting */
  category: text('category', { enum: ['alucobond', 'staff', 'placo', 'furniture', 'painting'] })
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
});

export const serviceJobMaterials = sqliteTable('service_job_materials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id')
    .notNull()
    .references(() => serviceJobs.id, { onDelete: 'cascade' }),
  productId: integer('product_id').references(() => products.id),
  productCode: text('product_code').notNull(),
  productName: text('product_name').notNull(),
  unit: text('unit').notNull().default('pièce'),
  quantity: real('quantity').notNull(),
  unitCost: real('unit_cost').notNull().default(0),
  amount: real('amount').notNull().default(0),
  createdAt: createdAt(),
  ...syncCols(),
});

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
});

/* ------------------------------------------------------------------ *
 * 7. Briqueterie (§17)
 * ------------------------------------------------------------------ */

/** Le produit lié porte le stock et le prix de vente. */
export const brickTypes = sqliteTable('brick_types', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  name: text('name').notNull(),
  /** solid | hollow | block */
  shape: text('shape', { enum: ['solid', 'hollow', 'block'] }).notNull().default('solid'),
  dimensions: text('dimensions'),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  ...syncCols(),
});

export const brickProductions = sqliteTable('brick_productions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  batchNumber: text('batch_number').notNull().unique(),
  brickTypeId: integer('brick_type_id')
    .notNull()
    .references(() => brickTypes.id),
  plannedQuantity: real('planned_quantity').notNull().default(0),
  producedQuantity: real('produced_quantity').notNull().default(0),
  brokenQuantity: real('broken_quantity').notNull().default(0),
  startDate: text('start_date'),
  endDate: text('end_date'),
  /** molding | drying | firing | stored */
  stage: text('stage', { enum: ['molding', 'drying', 'firing', 'stored'] })
    .notNull()
    .default('molding'),
  materialCost: real('material_cost').notNull().default(0),
  laborCost: real('labor_cost').notNull().default(0),
  totalCost: real('total_cost').notNull().default(0),
  userId: integer('user_id').references(() => users.id),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
});

/** La table qui manquait au schéma client : sans elle, aucune matière première ne sort du stock. */
export const brickProductionMaterials = sqliteTable('brick_production_materials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  productionId: integer('production_id')
    .notNull()
    .references(() => brickProductions.id, { onDelete: 'cascade' }),
  productId: integer('product_id').references(() => products.id),
  productCode: text('product_code').notNull(),
  productName: text('product_name').notNull(),
  unit: text('unit').notNull().default('kg'),
  quantity: real('quantity').notNull(),
  unitCost: real('unit_cost').notNull().default(0),
  amount: real('amount').notNull().default(0),
  createdAt: createdAt(),
  ...syncCols(),
});

export const brickProductionWorkers = sqliteTable('brick_production_workers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  productionId: integer('production_id')
    .notNull()
    .references(() => brickProductions.id, { onDelete: 'cascade' }),
  workerId: integer('worker_id').references(() => workers.id),
  workerName: text('worker_name').notNull(),
  role: text('role'),
  days: real('days').notNull().default(0),
  dailyRate: real('daily_rate').notNull().default(0),
  amount: real('amount').notNull().default(0),
  createdAt: createdAt(),
  ...syncCols(),
});

/* ------------------------------------------------------------------ *
 * 8. Atelier de meubles (§18)
 * ------------------------------------------------------------------ */

export const furnitureModels = sqliteTable('furniture_models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  standardDimensions: text('standard_dimensions'),
  laborHours: real('labor_hours').notNull().default(0),
  salePrice: real('sale_price').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
  ...syncCols(),
});

/** Nomenclature (BOM) : base du calcul automatique des besoins en matières. */
export const furnitureModelMaterials = sqliteTable('furniture_model_materials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  modelId: integer('model_id')
    .notNull()
    .references(() => furnitureModels.id, { onDelete: 'cascade' }),
  productId: integer('product_id')
    .notNull()
    .references(() => products.id),
  quantity: real('quantity').notNull().default(0),
  unit: text('unit').notNull().default('pièce'),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
});

export const furnitureOrders = sqliteTable('furniture_orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderNumber: text('order_number').notNull().unique(),
  customerId: integer('customer_id').references(() => customers.id),
  customerName: text('customer_name'),
  modelId: integer('model_id').references(() => furnitureModels.id),
  modelName: text('model_name'),
  isCustom: integer('is_custom', { mode: 'boolean' }).notNull().default(false),
  dimensions: text('dimensions'),
  finish: text('finish'),
  quantity: real('quantity').notNull().default(1),
  startDate: text('start_date'),
  promisedDate: text('promised_date'),
  deliveryDate: text('delivery_date'),
  /** cutting | assembly | sanding | painting | finishing | delivered */
  stage: text('stage', {
    enum: ['cutting', 'assembly', 'sanding', 'painting', 'finishing', 'delivered'],
  })
    .notNull()
    .default('cutting'),
  materialCost: real('material_cost').notNull().default(0),
  laborCost: real('labor_cost').notNull().default(0),
  totalCost: real('total_cost').notNull().default(0),
  agreedPrice: real('agreed_price').notNull().default(0),
  amountPaid: real('amount_paid').notNull().default(0),
  /** Meuble fini → entrée en stock à la livraison */
  productId: integer('product_id').references(() => products.id),
  userId: integer('user_id').references(() => users.id),
  notes: text('notes'),
  createdAt: createdAt(),
  ...syncCols(),
});

export const furnitureOrderMaterials = sqliteTable('furniture_order_materials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: integer('order_id')
    .notNull()
    .references(() => furnitureOrders.id, { onDelete: 'cascade' }),
  productId: integer('product_id').references(() => products.id),
  productCode: text('product_code').notNull(),
  productName: text('product_name').notNull(),
  unit: text('unit').notNull().default('pièce'),
  quantity: real('quantity').notNull(),
  /** Chutes de bois et pertes de matière (§18) */
  wastageQuantity: real('wastage_quantity').notNull().default(0),
  unitCost: real('unit_cost').notNull().default(0),
  amount: real('amount').notNull().default(0),
  createdAt: createdAt(),
  ...syncCols(),
});

export const furnitureOrderWorkers = sqliteTable('furniture_order_workers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: integer('order_id')
    .notNull()
    .references(() => furnitureOrders.id, { onDelete: 'cascade' }),
  workerId: integer('worker_id').references(() => workers.id),
  workerName: text('worker_name').notNull(),
  role: text('role'),
  days: real('days').notNull().default(0),
  dailyRate: real('daily_rate').notNull().default(0),
  amount: real('amount').notNull().default(0),
  createdAt: createdAt(),
  ...syncCols(),
});

/* ------------------------------------------------------------------ *
 * 9. Rapports et paramètres
 * ------------------------------------------------------------------ */

export const reportDeliveries = sqliteTable('report_deliveries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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

/** File d'envoi : une entrée par écriture d'une table synchronisée. */
export const syncOutbox = sqliteTable('sync_outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tableName: text('table_name').notNull(),
  syncId: text('sync_id').notNull(),
  /** insert | update | delete */
  operation: text('operation', { enum: ['insert', 'update', 'delete'] }).notNull(),
  payload: text('payload').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp' }),
  lastError: text('last_error'),
  createdAt: createdAt(),
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
  furnitureOrders: many(furnitureOrders),
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
  brickAssignments: many(brickProductionWorkers),
  furnitureAssignments: many(furnitureOrderWorkers),
}));

export const brickTypeRelations = relations(brickTypes, ({ one, many }) => ({
  product: one(products, {
    fields: [brickTypes.productId],
    references: [products.id],
  }),
  productions: many(brickProductions),
}));

export const brickProductionRelations = relations(brickProductions, ({ one, many }) => ({
  brickType: one(brickTypes, {
    fields: [brickProductions.brickTypeId],
    references: [brickTypes.id],
  }),
  materials: many(brickProductionMaterials),
  workers: many(brickProductionWorkers),
}));

export const brickProductionMaterialRelations = relations(
  brickProductionMaterials,
  ({ one }) => ({
    production: one(brickProductions, {
      fields: [brickProductionMaterials.productionId],
      references: [brickProductions.id],
    }),
    product: one(products, {
      fields: [brickProductionMaterials.productId],
      references: [products.id],
    }),
  }),
);

export const brickProductionWorkerRelations = relations(brickProductionWorkers, ({ one }) => ({
  production: one(brickProductions, {
    fields: [brickProductionWorkers.productionId],
    references: [brickProductions.id],
  }),
  worker: one(workers, {
    fields: [brickProductionWorkers.workerId],
    references: [workers.id],
  }),
}));

export const furnitureModelRelations = relations(furnitureModels, ({ many }) => ({
  materials: many(furnitureModelMaterials),
  orders: many(furnitureOrders),
}));

export const furnitureModelMaterialRelations = relations(
  furnitureModelMaterials,
  ({ one }) => ({
    model: one(furnitureModels, {
      fields: [furnitureModelMaterials.modelId],
      references: [furnitureModels.id],
    }),
    product: one(products, {
      fields: [furnitureModelMaterials.productId],
      references: [products.id],
    }),
  }),
);

export const furnitureOrderRelations = relations(furnitureOrders, ({ one, many }) => ({
  customer: one(customers, {
    fields: [furnitureOrders.customerId],
    references: [customers.id],
  }),
  model: one(furnitureModels, {
    fields: [furnitureOrders.modelId],
    references: [furnitureModels.id],
  }),
  product: one(products, {
    fields: [furnitureOrders.productId],
    references: [products.id],
  }),
  materials: many(furnitureOrderMaterials),
  workers: many(furnitureOrderWorkers),
}));

export const furnitureOrderMaterialRelations = relations(
  furnitureOrderMaterials,
  ({ one }) => ({
    order: one(furnitureOrders, {
      fields: [furnitureOrderMaterials.orderId],
      references: [furnitureOrders.id],
    }),
    product: one(products, {
      fields: [furnitureOrderMaterials.productId],
      references: [products.id],
    }),
  }),
);

export const furnitureOrderWorkerRelations = relations(furnitureOrderWorkers, ({ one }) => ({
  order: one(furnitureOrders, {
    fields: [furnitureOrderWorkers.orderId],
    references: [furnitureOrders.id],
  }),
  worker: one(workers, {
    fields: [furnitureOrderWorkers.workerId],
    references: [workers.id],
  }),
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
export type BrickType = typeof brickTypes.$inferSelect;
export type NewBrickType = typeof brickTypes.$inferInsert;
export type BrickProduction = typeof brickProductions.$inferSelect;
export type NewBrickProduction = typeof brickProductions.$inferInsert;
export type BrickProductionMaterial = typeof brickProductionMaterials.$inferSelect;
export type NewBrickProductionMaterial = typeof brickProductionMaterials.$inferInsert;
export type BrickProductionWorker = typeof brickProductionWorkers.$inferSelect;
export type NewBrickProductionWorker = typeof brickProductionWorkers.$inferInsert;
export type FurnitureModel = typeof furnitureModels.$inferSelect;
export type NewFurnitureModel = typeof furnitureModels.$inferInsert;
export type FurnitureModelMaterial = typeof furnitureModelMaterials.$inferSelect;
export type NewFurnitureModelMaterial = typeof furnitureModelMaterials.$inferInsert;
export type FurnitureOrder = typeof furnitureOrders.$inferSelect;
export type NewFurnitureOrder = typeof furnitureOrders.$inferInsert;
export type FurnitureOrderMaterial = typeof furnitureOrderMaterials.$inferSelect;
export type NewFurnitureOrderMaterial = typeof furnitureOrderMaterials.$inferInsert;
export type FurnitureOrderWorker = typeof furnitureOrderWorkers.$inferSelect;
export type NewFurnitureOrderWorker = typeof furnitureOrderWorkers.$inferInsert;
export type ReportDelivery = typeof reportDeliveries.$inferSelect;
export type NewReportDelivery = typeof reportDeliveries.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
export type SyncOutboxRow = typeof syncOutbox.$inferSelect;
export type SyncPendingRow = typeof syncPending.$inferSelect;
export type SyncConflictRow = typeof syncConflicts.$inferSelect;
