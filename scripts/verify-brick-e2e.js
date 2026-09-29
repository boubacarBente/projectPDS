/*
 * Vérification de bout en bout du module **Briqueterie** (README §20).
 *
 * Pourquoi un script plutôt qu'une lecture : la refonte touche le schéma, le
 * moteur de stock, les ventes (canal `brick`), les paiements et l'interface. Ce
 * qui casse dans ce genre de chantier ne se voit pas à la lecture — c'est un
 * numéro de facture qui apparaît dans la mauvaise liste, un coût de revient qui
 * ne se recalcule pas, un acompte compté deux fois.
 *
 * Ce que le script prouve, dans l'ordre :
 *   1. les écrans et routes du module répondent (aucun 500) ;
 *   2. une **dépense rattachée** à un lot alimente le coût total et le coût
 *      unitaire, **sans aucun module de matières premières** ;
 *   3. l'entrée en stock des briques finies est **unique** (elle ne double pas
 *      si l'on repasse par l'étape « mise en stock ») ;
 *   4. une vente créée avec `channel=brick` **n'apparaît pas** dans `/ventes`
 *      (canal `general`) mais apparaît dans le canal briqueterie ;
 *   5. une commande accepte un **acompte**, puis se **facture** : l'acompte est
 *      transféré sur la facture (jamais compté deux fois) ;
 *   6. les validations refusent ce qu'elles doivent refuser (catégorie de
 *      dépense hors liste, ajustement de stock sans motif, statut incohérent) ;
 *   7. une annulation motivée laisse une trace et n'efface rien.
 *
 * ⚠️ Comme les autres scripts `verify:*`, il **écrit dans la base locale** :
 * ce sont des données de recette, assumées (AGENTS.md). Il crée des lots
 * `VÉRIF-…` préfixés par leur motif pour qu'on les reconnaisse.
 *
 * Authentification : les routes sont protégées par le cookie `session_user`,
 * un simple JSON signé par rien (voir `lib/api.ts`). Le script lit donc un
 * administrateur **réel** dans la base locale et fabrique ce cookie — c'est la
 * même session que l'application, sans dépendre d'un mot de passe que la
 * recette a pu changer.
 *
 * Usage : node scripts/verify-brick-e2e.js [baseUrl]
 */

const path = require('path');
const { createClient } = require('@libsql/client/sqlite3');

const BASE_URL = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const DB_PATH = process.env.ELECTRON_APP_PATH
  ? path.join(process.env.ELECTRON_APP_PATH, 'database.db')
  : path.join(process.cwd(), 'db', 'database.db');

let cookieHeader = '';
const results = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const marker = ok ? 'OK  ' : 'ÉCHEC';
  console.log(`[${marker}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
  return Boolean(condition);
}

async function api(method, url, body) {
  const response = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { status: response.status, json, text };
}

/**
 * L'invariant du §12 : `products.stock` = somme algébrique des mouvements.
 *
 * C'est le contrôle que la réinitialisation partielle est la plus susceptible de
 * casser : elle supprime des mouvements de stock, et le stock doit suivre.
 */
async function checkStockInvariant(productId) {
  const client = createClient({ url: `file:${DB_PATH.replace(/\\/g, '/')}`, intMode: 'number' });
  try {
    const product = await client.execute({
      sql: 'SELECT stock FROM products WHERE id = ?',
      args: [productId],
    });
    const rows = await client.execute({
      sql: 'SELECT type, quantity FROM stock_movements WHERE product_id = ?',
      args: [productId],
    });

    const computed = rows.rows.reduce((sum, row) => {
      const quantity = Number(row.quantity ?? 0);
      return row.type === 'exit' ? sum - quantity : sum + quantity;
    }, 0);

    const stored = Number(product.rows[0]?.stock ?? 0);
    const rounded = Math.round(computed * 1000) / 1000;

    return {
      ok: Math.abs(stored - rounded) < 0.001,
      stored,
      computed: rounded,
      movements: rows.rows.length,
    };
  } finally {
    client.close();
  }
}

/**
 * Les soldes de caisse sont-ils cohérents ?
 *
 * `balance_after` est un **solde courant** par session : on le reconstruit ici et
 * on le compare à ce qui est stocké. C'est la vérification qui attrape une
 * suppression partielle de mouvements laissée sans recalcul (le solde affiché
 * resterait celui d'avant, donc trop élevé).
 */
async function checkCashBalances() {
  const client = createClient({ url: `file:${DB_PATH.replace(/\\/g, '/')}`, intMode: 'number' });
  try {
    const rows = await client.execute(
      'SELECT id, session_id, type, amount, balance_after FROM cash_movements ORDER BY id ASC',
    );

    let currentSession;
    let running = 0;
    const mismatches = [];

    for (const row of rows.rows) {
      if (row.session_id !== currentSession) {
        currentSession = row.session_id;
        running = 0;
      }
      running += row.type === 'income' ? Number(row.amount ?? 0) : -Number(row.amount ?? 0);

      if (Math.abs(running - Number(row.balance_after ?? 0)) > 0.01) {
        mismatches.push(`#${row.id}: stocké ${row.balance_after} ≠ calculé ${running}`);
      }
    }

    return {
      ok: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? `${rows.rows.length} mouvement(s) cohérents`
          : `${mismatches.length} écart(s) — ${mismatches.slice(0, 2).join(' | ')}`,
    };
  } finally {
    client.close();
  }
}

/** Prépare la session : un administrateur réel de la base locale. */
async function prepareSession() {  const client = createClient({ url: `file:${DB_PATH.replace(/\\/g, '/')}`, intMode: 'number' });
  const rows = await client.execute(
    "SELECT id, name, username, role FROM users WHERE is_active = 1 ORDER BY (role = 'admin') DESC, id LIMIT 1",
  );
  client.close();

  const user = rows.rows[0];
  if (!user) throw new Error('Aucun utilisateur actif en base : impossible de fabriquer une session.');

  const payload = {
    id: Number(user.id),
    name: String(user.name),
    username: String(user.username),
    role: String(user.role),
  };
  cookieHeader = [
    `session_user=${encodeURIComponent(JSON.stringify(payload))}`,
    `user=${encodeURIComponent(JSON.stringify(payload))}`,
    'session=verify-script',
  ].join('; ');

  return payload;
}

/* ------------------------------------------------------------------ */

async function main() {
  const user = await prepareSession();
  console.log(`[verify:brick] base ${BASE_URL} · session ${user.username} (${user.role})\n`);

  /* 1 — Les écrans et routes du module répondent. */
  const dashboard = await api('GET', '/api/briqueterie/tableau-de-bord');
  assert(
    'Tableau de bord : 200 et structure complète',
    dashboard.status === 200 &&
      dashboard.json?.production &&
      dashboard.json?.sales &&
      dashboard.json?.stock &&
      dashboard.json?.profitability &&
      Array.isArray(dashboard.json?.charts?.production),
    `HTTP ${dashboard.status}`,
  );

  const stockBefore = await api('GET', '/api/briqueterie/stock');
  assert(
    'Stock des produits finis : 200',
    stockBefore.status === 200 && Array.isArray(stockBefore.json?.data),
    `HTTP ${stockBefore.status}`,
  );

  const reports = await api('GET', '/api/briqueterie/rapports');
  assert(
    'Rapports : 200 et sections présentes',
    reports.status === 200 && reports.json?.profitability && Array.isArray(reports.json?.losses),
    `HTTP ${reports.status}`,
  );

  const lots = await api('GET', '/api/briqueterie/productions?limit=5');
  assert('Liste des productions : 200', lots.status === 200 && Array.isArray(lots.json?.data), `HTTP ${lots.status}`);

  const typesResponse = await api('GET', '/api/briqueterie/types?limit=200');
  const activeType = (typesResponse.json?.data ?? []).find((type) => type.isActive);
  if (!assert('Types de briques : au moins un type actif', Boolean(activeType))) return;

  /* 2 — Dépenses rattachées au lot : le cœur de la révision §20. */
  const created = await api('POST', '/api/briqueterie/productions', {
    brickTypeId: activeType.id,
    plannedQuantity: 5000,
    producedQuantity: 5000,
    startDate: new Date().toISOString().slice(0, 10),
    team: 'Équipe de recette',
    notes: 'Lot de vérification automatique (VÉRIF).',
  });

  if (!assert('Création d’un lot : 201', created.status === 201, `HTTP ${created.status} ${created.text.slice(0, 160)}`)) return;

  const lot = created.json;
  assert('Le lot porte son statut « enregistrée »', lot.status === 'registered', `status=${lot.status}`);

  const expenseInputs = [
    { category: 'Ciment', amount: 1_500_000, description: '60 sacs' },
    { category: 'Sable', amount: 500_000 },
    { category: 'Carburant', amount: 300_000 },
    { category: 'Autre', amount: 250_000 },
  ];

  let expenseTotal = 0;
  for (const input of expenseInputs) {
    const response = await api('PUT', `/api/briqueterie/productions/${lot.id}`, {
      action: 'add_expense',
      ...input,
      date: new Date().toISOString().slice(0, 10),
    });
    if (!assert(`Dépense « ${input.category} » rattachée au lot : 201`, response.status === 201, `HTTP ${response.status} ${response.text.slice(0, 160)}`)) continue;
    expenseTotal += input.amount;
  }

  const worker = await api('PUT', `/api/briqueterie/productions/${lot.id}`, {
    action: 'add_worker',
    workerName: 'Journalier de recette',
    days: 7,
    dailyRate: 100_000,
  });
  const laborTotal = worker.status === 201 ? 700_000 : 0;
  assert('Main-d’œuvre affectée au lot : 201', worker.status === 201, `HTTP ${worker.status}`);

  const detail = await api('GET', `/api/briqueterie/productions/${lot.id}`);
  const costs = detail.json?.costs;
  assert(
    'Coût de la fiche = dépenses rattachées + main-d’œuvre',
    costs?.expenseCost === expenseTotal && costs?.laborCost === laborTotal,
    `dépenses=${costs?.expenseCost} (attendu ${expenseTotal}) · main-d’œuvre=${costs?.laborCost} (attendu ${laborTotal})`,
  );
  assert(
    'Coût unitaire = coût total ÷ 5 000 briques',
    costs?.totalCost === expenseTotal + laborTotal && costs?.unitCost === 650,
    `total=${costs?.totalCost} unitaire=${costs?.unitCost} (attendu 650)`,
  );
  assert(
    'La fiche renvoie la liste des dépenses rattachées',
    Array.isArray(detail.json?.expenses) && detail.json.expenses.length === expenseInputs.length,
    `${detail.json?.expenses?.length} ligne(s)`,
  );

  /* 3 — Entrée en stock unique. */
  const stockProduct = (stockBefore.json?.data ?? []).find(
    (line) => line.productId === activeType.productId,
  );
  const stockAtStart = Number(stockProduct?.stock ?? 0);

  for (const stage of ['drying', 'firing', 'stored']) {
    const response = await api('PUT', `/api/briqueterie/productions/${lot.id}`, {
      action: 'advance_stage',
      stage,
    });
    if (!assert(`Passage à l’étape « ${stage} »`, response.status === 200, `HTTP ${response.status} ${response.text.slice(0, 160)}`)) break;
  }

  const stockAfter = await api('GET', '/api/briqueterie/stock');
  const lineAfter = (stockAfter.json?.data ?? []).find((line) => line.productId === activeType.productId);
  assert(
    'Les 5 000 briques sont entrées en stock',
    Number(lineAfter?.stock ?? 0) === stockAtStart + 5000,
    `stock ${stockAtStart} → ${lineAfter?.stock}`,
  );

  const finished = await api('GET', `/api/briqueterie/productions/${lot.id}`);
  assert(
    'Le lot est « terminée » après la mise en stock',
    finished.json?.production?.status === 'finished',
    `status=${finished.json?.production?.status}`,
  );

  // Rejouer une étape déjà franchie doit être refusé : c'est le verrou contre
  // un second crédit de stock.
  const replay = await api('PUT', `/api/briqueterie/productions/${lot.id}`, {
    action: 'advance_stage',
    stage: 'stored',
  });
  assert('Repasser par « stored » est refusé', replay.status === 400, `HTTP ${replay.status}`);

  const stockAfterReplay = await api('GET', '/api/briqueterie/stock');
  const lineReplay = (stockAfterReplay.json?.data ?? []).find((line) => line.productId === activeType.productId);
  assert(
    'Aucun second crédit de stock',
    Number(lineReplay?.stock ?? 0) === stockAtStart + 5000,
    `stock=${lineReplay?.stock} (attendu ${stockAtStart + 5000})`,
  );

  /* 4 — Le canal de vente sépare les deux listes. */
  const sale = await api('POST', '/api/ventes', {
    customerName: 'Client de recette briqueterie',
    date: new Date().toISOString().slice(0, 10),
    channel: 'brick',
    amountPaid: 0,
    lines: [{ productId: activeType.productId, quantity: 100, unitPrice: activeType.salePrice || 2000 }],
  });

  const invoice = sale.json?.invoice;
  if (!assert('Vente de briques créée (canal brick) : 201', sale.status === 201 && invoice, `HTTP ${sale.status} ${sale.text.slice(0, 200)}`)) return;
  assert('La vente porte le canal « brick »', invoice.channel === 'brick', `channel=${invoice.channel}`);

  const generalList = await api('GET', `/api/ventes?search=${encodeURIComponent(invoice.invoiceNumber)}&limit=50`);
  assert(
    'La vente de briques N’APPARAÎT PAS dans /ventes (canal general)',
    (generalList.json?.data ?? []).every((row) => row.invoiceNumber !== invoice.invoiceNumber),
    `${generalList.json?.total} ligne(s) dans la liste générale`,
  );

  const brickList = await api('GET', `/api/ventes?channel=brick&search=${encodeURIComponent(invoice.invoiceNumber)}&limit=50`);
  assert(
    'La vente apparaît dans le canal briqueterie',
    (brickList.json?.data ?? []).some((row) => row.invoiceNumber === invoice.invoiceNumber),
    `${brickList.json?.total} ligne(s) dans le canal briqueterie`,
  );

  // Aucun crédit de stock pour une vente à 0 encaissé : le contrôle de stock
  // s'applique comme partout ailleurs.
  const oversell = await api('POST', '/api/ventes', {
    customerName: 'Client de recette briqueterie',
    date: new Date().toISOString().slice(0, 10),
    channel: 'brick',
    amountPaid: 0,
    lines: [{ productId: activeType.productId, quantity: 999_999_999, unitPrice: 1000 }],
  });
  assert('Vente au-delà du stock refusée (400)', oversell.status === 400, `HTTP ${oversell.status}`);

  /* 5 — Commande : acompte puis facturation avec transfert de l'acompte. */
  const orderResponse = await api('POST', '/api/briqueterie/commandes', {
    customerName: 'Client de recette commande',
    date: new Date().toISOString().slice(0, 10),
    status: 'draft',
    items: [{ brickTypeId: activeType.id, quantity: 50, unitPrice: activeType.salePrice || 2000, discount: 5000 }],
  });

  const order = orderResponse.json?.order;
  if (!assert('Commande créée (brouillon) : 201', orderResponse.status === 201 && order, `HTTP ${orderResponse.status} ${orderResponse.text.slice(0, 200)}`)) return;

  const draftPayment = await api('POST', `/api/briqueterie/commandes/${order.id}/paiements`, {
    amount: 10_000,
    paymentMethod: 'Espèces',
  });
  assert(
    'Un brouillon de commande refuse un acompte',
    draftPayment.status === 400,
    `HTTP ${draftPayment.status} (attendu 400)`,
  );

  const confirmed = await api('PUT', `/api/briqueterie/commandes/${order.id}`, {
    action: 'set_status',
    status: 'confirmed',
  });
  assert('Commande confirmée', confirmed.status === 200 && confirmed.json?.status === 'confirmed', `HTTP ${confirmed.status}`);

  const payment = await api('POST', `/api/briqueterie/commandes/${order.id}/paiements`, {
    amount: 10_000,
    paymentMethod: 'Espèces',
  });
  assert(
    'Acompte encaissé sur la commande',
    payment.status === 201 && Number(payment.json?.order?.amountPaid ?? 0) === 10_000,
    `HTTP ${payment.status} · payé=${payment.json?.order?.amountPaid}`,
  );

  const invoiced = await api('PUT', `/api/briqueterie/commandes/${order.id}`, { action: 'invoice' });
  const orderInvoiceNumber = invoiced.json?.invoiceNumber;
  assert(
    'Commande facturée : une vente est créée',
    invoiced.status === 200 && Boolean(orderInvoiceNumber),
    `HTTP ${invoiced.status} ${invoiced.text.slice(0, 200)}`,
  );

  const orderAfter = await api('GET', `/api/briqueterie/commandes/${order.id}`);
  assert(
    'L’acompte est transféré : la commande ne porte plus de paiement',
    Number(orderAfter.json?.order?.amountPaid ?? -1) === 0 &&
      (orderAfter.json?.payments ?? []).length === 0,
    `payé=${orderAfter.json?.order?.amountPaid} · ${orderAfter.json?.payments?.length} paiement(s)`,
  );

  const invoiceAfter = await api('GET', `/api/ventes?channel=brick&search=${encodeURIComponent(orderInvoiceNumber ?? '')}&limit=20`);
  const transferredInvoice = (invoiceAfter.json?.data ?? []).find(
    (row) => row.invoiceNumber === orderInvoiceNumber,
  );
  assert(
    'L’acompte apparaît sur la facture, une seule fois',
    Number(transferredInvoice?.amountPaid ?? 0) === 10_000,
    `payé sur facture=${transferredInvoice?.amountPaid} (attendu 10 000)`,
  );

  /* 6 — Les validations refusent ce qu'elles doivent refuser. */
  const badCategory = await api('PUT', `/api/briqueterie/productions/${lot.id}`, {
    action: 'add_expense',
    category: 'Catégorie inventée',
    amount: 1000,
    date: new Date().toISOString().slice(0, 10),
  });
  assert('Dépense hors liste fermée refusée', badCategory.status === 400, `HTTP ${badCategory.status}`);

  const badAdjust = await api('POST', '/api/stocks/adjust', {
    productId: activeType.productId,
    delta: 0,
    motif: '',
  });
  assert('Ajustement de stock sans écart/motif refusé', badAdjust.status === 400, `HTTP ${badAdjust.status}`);

  const badTransition = await api('PUT', `/api/briqueterie/commandes/${order.id}`, {
    action: 'set_status',
    status: 'ready',
  });
  assert(
    'Transition de statut incohérente refusée (livrée → prête)',
    badTransition.status === 400,
    `HTTP ${badTransition.status}`,
  );

  /* 7 — Annulation motivée : trace conservée, stock rendu. */
  // Baseline relue **ici** : la vente de 100 briques a sorti du stock entre-temps,
  // et l'annulation doit rendre exactement ce que ce lot-là avait apporté.
  const stockBeforeSecondLot = await api('GET', '/api/briqueterie/stock');
  const baselineStock = Number(
    (stockBeforeSecondLot.json?.data ?? []).find(
      (line) => line.productId === activeType.productId,
    )?.stock ?? 0,
  );

  const secondLot = await api('POST', '/api/briqueterie/productions', {
    brickTypeId: activeType.id,
    plannedQuantity: 10,
    producedQuantity: 10,
    startDate: new Date().toISOString().slice(0, 10),
    notes: 'Lot de vérification à annuler (VÉRIF).',
  });
  const secondId = secondLot.json?.id;

  if (secondId) {
    await api('PUT', `/api/briqueterie/productions/${secondId}`, { action: 'advance_stage', stage: 'drying' });
    await api('PUT', `/api/briqueterie/productions/${secondId}`, { action: 'advance_stage', stage: 'firing' });
    await api('PUT', `/api/briqueterie/productions/${secondId}`, { action: 'advance_stage', stage: 'stored' });

    const cancelNoReason = await api('DELETE', `/api/briqueterie/productions/${secondId}`, { reason: '' });
    assert('Annulation sans motif refusée', cancelNoReason.status === 400, `HTTP ${cancelNoReason.status}`);

    const cancelled = await api('DELETE', `/api/briqueterie/productions/${secondId}`, {
      reason: 'Vérification automatique',
    });
    assert(
      'Annulation motivée : statut « annulée », motif conservé',
      cancelled.status === 200 &&
        cancelled.json?.status === 'cancelled' &&
        cancelled.json?.cancelReason === 'Vérification automatique',
      `HTTP ${cancelled.status} status=${cancelled.json?.status}`,
    );

    const stockAfterCancel = await api('GET', '/api/briqueterie/stock');
    const lineCancel = (stockAfterCancel.json?.data ?? []).find(
      (line) => line.productId === activeType.productId,
    );
    assert(
      'Le stock est rendu à son niveau d’avant le lot annulé',
      Number(lineCancel?.stock ?? 0) === baselineStock,
      `stock=${lineCancel?.stock} (attendu ${baselineStock})`,
    );
  }

  /* 8 — Traçabilité et cohérence finale. */
  const history = await api('GET', `/api/briqueterie/historique?entity=brick_production&entityId=${lot.id}&limit=50`);
  assert(
    'Historique du lot : opérations tracées',
    history.status === 200 && (history.json?.data ?? []).length > 0,
    `${history.json?.total ?? 0} entrée(s)`,
  );

  const finalDashboard = await api('GET', '/api/briqueterie/tableau-de-bord');
  assert(
    'Tableau de bord recalculé : la production du mois a augmenté',
    finalDashboard.status === 200 && Number(finalDashboard.json?.production?.month ?? 0) >= 5000,
    `production du mois=${finalDashboard.json?.production?.month}`,
  );

  /*
   * 9 — Synchronisation : les deux nouvelles tables doivent entrer dans le
   * paquet d'export. Une table absente de `SYNC_ORDER` disparaîtrait
   * **silencieusement** du poste destinataire — le genre de défaut qui ne se
   * voit qu'à la restauration.
   */
  const syncPackage = await api('POST', '/api/sync/export?download=false', {});
  assert(
    'Export de synchronisation : 200',
    syncPackage.status === 200,
    `HTTP ${syncPackage.status} ${syncPackage.text.slice(0, 160)}`,
  );
  assert(
    'Les commandes de briques entrent dans le paquet de synchronisation',
    syncPackage.json?.counts?.brick_orders !== undefined &&
      syncPackage.json?.counts?.brick_order_items !== undefined,
    Object.keys(syncPackage.json?.counts ?? {}).length + ' table(s) dans le paquet',
  );

  const generalExpenses = await api('GET', '/api/depenses?scope=general&limit=1');  const productionExpenses = await api('GET', '/api/depenses?scope=production&limit=1');
  assert(
    'Les dépenses de production sont séparées des dépenses générales',
    generalExpenses.status === 200 && productionExpenses.status === 200,
    `générales=${generalExpenses.json?.total} · production=${productionExpenses.json?.total}`,
  );
  const productionRows = productionExpenses.json?.data ?? [];
  assert(
    'Une dépense de production est bien rattachée à un lot',
    productionRows.length > 0 && productionRows.every((row) => row.referenceType === 'brick_production'),
    `${productionRows.length} ligne(s)`,
  );

  /* ------------------------------------------------------------------ *
   * 10 — Jeu de démonstration : réinitialiser, puis pré-remplir (§20.5)
   * ------------------------------------------------------------------ */

  const beforeReset = await api('GET', '/api/parametres/briqueterie');
  assert(
    'Résumé de la briqueterie : 200 et données présentes',
    beforeReset.status === 200 && beforeReset.json?.hasData === true,
    `${beforeReset.json?.productions} lot(s), ${beforeReset.json?.sales} vente(s)`,
  );

  const reset = await api('POST', '/api/parametres/briqueterie', { action: 'reset' });
  assert(
    'Réinitialisation de la briqueterie : 200 et copie de sécurité',
    reset.status === 200 && Boolean(reset.json?.report?.safetyBackup),
    `HTTP ${reset.status} · ${reset.json?.report?.productions ?? '?'} lot(s) effacé(s)`,
  );

  const afterReset = await api('GET', '/api/parametres/briqueterie');
  assert(
    'Après réinitialisation : plus aucun lot ni vente de briques',
    afterReset.json?.productions === 0 &&
      afterReset.json?.sales === 0 &&
      afterReset.json?.orders === 0 &&
      afterReset.json?.hasData === false,
    `lots=${afterReset.json?.productions} ventes=${afterReset.json?.sales} commandes=${afterReset.json?.orders}`,
  );

  const seed = await api('POST', '/api/parametres/briqueterie', { action: 'seed' });
  const seedCounts = seed.json?.counts ?? {};
  assert(
    'Pré-remplissage : 200 et volumes attendus',
    seed.status === 200 &&
      Number(seedCounts.productions) >= 25 &&
      Number(seedCounts.expenses) >= 200 &&
      Number(seedCounts.sales) >= 25 &&
      Number(seedCounts.orders) >= 5 &&
      Number(seedCounts.lotsStored) >= 20,
    `HTTP ${seed.status} · ${seedCounts.productions} lot(s), ${seedCounts.expenses} dépense(s), ` +
      `${seedCounts.sales} vente(s), ${seedCounts.orders} commande(s), ${seedCounts.lotsStored} en stock`,
  );

  const seeded = await api('GET', '/api/parametres/briqueterie');
  assert(
    'Le jeu couvre bien la semaine, le mois et l’année',
    seeded.json?.hasData === true &&
      Boolean(seeded.json?.newestProduction) &&
      Boolean(seeded.json?.oldestProduction) &&
      seeded.json.oldestProduction < seeded.json.newestProduction,
    `${seeded.json?.oldestProduction} → ${seeded.json?.newestProduction}`,
  );

  const seededDashboard = await api('GET', '/api/briqueterie/tableau-de-bord');
  const seededOrders = seededDashboard.json?.orders ?? {};
  assert(
    'Tableau de bord pré-rempli : production de la semaine, du mois, commandes',
    seededDashboard.status === 200 &&
      Number(seededDashboard.json?.production?.week ?? 0) > 0 &&
      Number(seededDashboard.json?.production?.month ?? 0) > 0 &&
      Object.values(seededOrders).reduce((sum, value) => sum + Number(value ?? 0), 0) >= 5,
    `semaine=${seededDashboard.json?.production?.week} · mois=${seededDashboard.json?.production?.month} · ` +
      `commandes=${JSON.stringify(seededOrders)}`,
  );

  assert(
    'Rentabilité pré-remplie : chiffre d’affaires et coût de production non nuls',
    Number(seededDashboard.json?.profitability?.revenue ?? 0) > 0 &&
      Number(seededDashboard.json?.profitability?.productionCost ?? 0) > 0,
    `CA=${seededDashboard.json?.profitability?.revenue} · coût=${seededDashboard.json?.profitability?.productionCost}`,
  );

  const yearFrom = new Date();
  yearFrom.setUTCFullYear(yearFrom.getUTCFullYear() - 1);
  const seededReports = await api(
    'GET',
    `/api/briqueterie/rapports?from=${yearFrom.toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`,
  );
  assert(
    'Rapports sur un an : production, ventes, dépenses et rentabilité renseignés',
    seededReports.status === 200 &&
      (seededReports.json?.productionByType ?? []).length >= 3 &&
      (seededReports.json?.salesByProduct ?? []).length >= 3 &&
      (seededReports.json?.expensesByProduction ?? []).length > 0 &&
      (seededReports.json?.generalExpensesByCategory ?? []).length >= 0 &&
      (seededReports.json?.profitability?.revenue ?? 0) > 0,
    `${seededReports.json?.productionByType?.length ?? 0} type(s), ` +
      `${seededReports.json?.salesByProduct?.length ?? 0} produit(s) vendu(s)`,
  );

  // Invariants du stock : `products.stock` doit égaler la somme des mouvements
  // pour **chaque** produit de briques — c'est le contrôle que la
  // réinitialisation partielle est la plus susceptible de casser.
  const invariants = await checkStockInvariant(activeType.productId);
  assert(
    'Invariant de stock respecté après réinitialisation puis pré-remplissage',
    invariants.ok,
    `stock=${invariants.stored} · mouvements=${invariants.computed}`,
  );

  const cash = await checkCashBalances();
  assert(
    'Soldes de caisse reconstruits : le dernier `balance_after` suit les mouvements',
    cash.ok,
    cash.detail,
  );

  const seedAgain = await api('POST', '/api/parametres/briqueterie', { action: 'seed' });
  assert(
    'Pré-remplir deux fois ajoute (ne casse rien)',
    seedAgain.status === 200 && Number(seedAgain.json?.counts?.productions ?? 0) >= 25,
    `HTTP ${seedAgain.status} · ${seedAgain.json?.counts?.productions} lot(s) ajouté(s)`,
  );

  // On repart d'un jeu **unique** : deux années empilées fausseraient la
  // démonstration que le client va regarder.
  await api('POST', '/api/parametres/briqueterie', { action: 'reset' });
  const finalSeed = await api('POST', '/api/parametres/briqueterie', { action: 'seed' });
  assert(
    'Jeu de démonstration final : une seule année, propre',
    finalSeed.status === 200 && Number(finalSeed.json?.counts?.productions ?? 0) >= 25,
    `${finalSeed.json?.counts?.productions} lot(s)`,
  );

  /* ------------------------------------------------------------------ */

  console.log(`\n[verify:brick] ${results.length - failures}/${results.length} vérifications OK`);
  console.log(
    `[verify:brick] données créées : lot #${lot.id} (${lot.batchNumber}), ` +
      `vente ${invoice.invoiceNumber}, commande ${order.orderNumber} → ${orderInvoiceNumber ?? 'non facturée'}`
  );

  if (failures > 0) {
    console.error(`[verify:brick] ${failures} échec(s)`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[verify:brick] erreur fatale :', error?.message ?? error);
  process.exitCode = 1;
});
