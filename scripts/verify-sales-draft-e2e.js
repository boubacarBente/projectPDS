/**
 * Vérification de bout en bout de la **politique du brouillon de vente** (§10.6).
 *
 * Ce que ce script prouve, sur une vraie instance en marche :
 *  1. un brouillon **ne touche pas le stock** ;
 *  2. un brouillon **ne peut pas être encaissé** (`POST /api/paiements` → 400) ;
 *  3. un brouillon **ne part pas en synchronisation** (absent du paquet d'export) ;
 *  4. `POST /api/ventes/[id]/valider` le rend définitif : stock sorti, statut
 *     `active`, journal d'actions `validate` ;
 *  5. la validation est **idempotente par refus** : une seconde tentative répond
 *     400 « déjà validée » (jamais un double mouvement de stock) ;
 *  6. une vente validée reste encaissable, puis **annulable** (stock rendu,
 *     caisse contre-passée) — les gardes n'ont rien cassé sur le chemin normal ;
 *  7. après validation, la facture **repart bien en `active`** dans le paquet de
 *     synchronisation ;
 *  8. un **brouillon hérité** (encaissé avant la mise en place de la garde, cas
 *     présent dans les données de recette) reste cohérent : validé, il conserve
 *     l'encaissement ; annulé, il **contre-passe la caisse** sans rendre de
 *     stock. Ces deux états sont fabriqués par insertion directe, puisqu'ils ne
 *     sont plus productibles par l'application.
 *
 * Le test laisse une trace volontairement minimale et cohérente : des ventes
 * annulées (le stock est rendu) et des reçus, comme le font les autres scripts
 * `verify-*`. Il écrit dans la base **locale** du poste (fixtures) : à n'exécuter
 * que sur une base de recette.
 *
 * Prérequis : serveur de développement sur http://127.0.0.1:3000 et une session
 * administrateur. Le script se connecte avec `APP_USER` / `APP_PASSWORD`
 * (`admin` / `Admin2026!` par défaut) ; si la connexion échoue — mot de passe
 * changé sur cette base — il reprend le cookie `session_user` du fichier local
 * `.cookies.txt` (gitignoré), qu'un `curl` de recette a laissé derrière lui.
 * Ce repli évite d'avoir à redemander un mot de passe pour une vérification de
 * développement, et il est annoncé explicitement dans la sortie.
 *
 * Usage : `node scripts/verify-sales-draft-e2e.js`
 */

const fs = require('node:fs');
const path = require('node:path');

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const USERNAME = process.env.APP_USER ?? 'admin';
const PASSWORD = process.env.APP_PASSWORD ?? 'Admin2026!';

/** Prix unitaire volontairement hors catalogue : il sert de signature de ligne. */
const SENTINEL_PRICE = 133337;

const jar = new Map();

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function api(path, options = {}) {
  const response = await fetch(`${APP_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...(options.headers ?? {}),
    },
    redirect: 'manual',
  });

  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 300);
  }

  return { status: response.status, body, text };
}

let failures = 0;
let passes = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passes += 1;
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Reprend le cookie `session_user` d'un `.cookies.txt` local (format Netscape).
 *
 * Repli de développement uniquement : il n'est utilisé que si la connexion par
 * identifiants échoue, et il est signalé dans la sortie du script.
 */
function reuseLocalSession() {
  const file = path.join(process.cwd(), '.cookies.txt');
  if (!fs.existsSync(file)) return false;

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;

    const name = parts[5];
    const value = parts[6];
    if (!name || !value) continue;
    jar.set(name, value);
  }

  return jar.has('session_user');
}

/**
 * Connexion directe à la base **locale** du poste, pour les fixtures seulement.
 *
 * Elle sert uniquement à fabriquer un état que l'application ne peut plus
 * produire (un brouillon encaissé, possible avant la garde de `createPayment`).
 * Le chemin est celui de `getDbPath()` : `database.db` à côté du binaire en
 * desktop (`ELECTRON_APP_PATH`), sous `db/` en développement.
 */
function openDatabase() {
  const { createClient } = require('@libsql/client/sqlite3');
  const base = process.env.ELECTRON_APP_PATH || process.cwd();
  /*
   * `PDS_DB_PATH` d’abord, comme l’application (README §28.4) : sans lui, une
   * recette lancée contre l'instance de recette (port 3100) écrivait ses
   * fixtures dans la base de TRAVAIL — paiements et mouvements de caisse
   * orphelins constatés le 4 octobre 2026.
   */
  const file = process.env.PDS_DB_PATH
    ? path.resolve(process.env.PDS_DB_PATH)
    : process.env.ELECTRON_APP_PATH
      ? path.join(base, 'database.db')
      : path.join(base, 'db', 'database.db');

  return createClient({ url: `file:${file.replace(/\\/g, '/')}` });
}

/** Stock courant d'un produit, lu par l'API (source applicative). */
async function currentStock(productId) {
  const response = await api(`/api/produits/${productId}`);
  return Number(response.body?.stock ?? -1);
}

/** Nombre de lignes de vente contenues dans un paquet de synchronisation. */
function packageCounts(pkg) {
  return {
    invoices: (pkg?.tables?.sales_invoices ?? []).length,
    items: (pkg?.tables?.sales_invoice_items ?? []).length,
  };
}

/**
 * Fabrique un « brouillon hérité » : créé proprement par l'API (donc sans stock
 * ni caisse), puis encaissé **directement en base** — exactement l'état que
 * produisaient les versions antérieures à la garde.
 *
 * Trois écritures, comme le ferait `createPayment()` : le paiement, le
 * mouvement de caisse (l'argent est réellement entré) et le recalcul des
 * montants de la facture.
 */
async function seedLegacyDraft(db, product, quantity, unitPrice, paidAmount) {
  const created = await api('/api/ventes', {
    method: 'POST',
    body: JSON.stringify({
      customerName: 'TEST BROUILLON HÉRITÉ — vérification automatique',
      date: new Date().toISOString().slice(0, 10),
      paymentMethod: 'Espèces',
      amountPaid: 0,
      discount: 0,
      status: 'draft',
      lines: [{ productId: product.id, quantity, unitPrice, discount: 0 }],
    }),
  });

  if (created.status !== 201 || !created.body?.invoice?.id) {
    throw new Error(`Fixture : création du brouillon refusée (${created.status})`);
  }

  const invoice = created.body.invoice;
  const stamp = Math.floor(Date.now() / 1000);
  const uuid = () => require('node:crypto').randomUUID();

  await db.execute({
    sql: `INSERT INTO payments
            (receipt_number, type, reference_id, amount, payment_method, payment_label,
             date, notes, user_id, created_at, sync_id, updated_at)
          VALUES (?, 'sale', ?, ?, 'Espèces', 'deposit', ?, ?, 1, ?, ?, ?)`,
    args: [
      `REC-HERITE-${invoice.id}-${stamp}`,
      invoice.id,
      paidAmount,
      invoice.date,
      'Fixture : encaissement antérieur à la garde',
      stamp,
      uuid(),
      stamp,
    ],
  });

  await db.execute({
    sql: `INSERT INTO cash_movements
            (type, amount, payment_method, motif, reference_type, reference_id,
             balance_after, date, user_id, created_at, sync_id, updated_at)
          VALUES ('income', ?, 'Espèces', ?, 'sale', ?, 0, ?, 1, ?, ?, ?)`,
    args: [
      paidAmount,
      `Fixture : encaissement brouillon ${invoice.invoiceNumber}`,
      invoice.id,
      invoice.date,
      stamp,
      uuid(),
      stamp,
    ],
  });

  await db.execute({
    sql: `UPDATE sales_invoices
          SET amount_paid = ?, remaining_amount = ?, payment_status = ?
          WHERE id = ?`,
    args: [paidAmount, Number(invoice.total) - paidAmount, 'partial', invoice.id],
  });

  return invoice;
}

async function main() {
  console.log(`\n=== Politique du brouillon de vente — ${APP_URL} ===\n`);

  /* ------------------------------ Connexion ------------------------------ */
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });

  if (login.status === 200) {
    console.log('1. Session ouverte avec les identifiants fournis.\n');
  } else {
    const reused = reuseLocalSession();
    if (!reused) {
      console.error(
        `Connexion impossible (${login.status}) et aucun cookie exploitable dans .cookies.txt. Arrêt.`,
      );
      process.exit(1);
    }
    const me = await api('/api/auth/me');
    if (me.status !== 200 || !me.body?.user) {
      console.error('Le cookie repris de .cookies.txt est refusé (session expirée). Arrêt.');
      process.exit(1);
    }
    console.log(
      `1. Connexion refusée (${login.status}) : session reprise de .cookies.txt ` +
        `(${me.body.user.username}, rôle ${me.body.user.role}).\n`,
    );
  }

  /* ---------------------- Produit support du scénario -------------------- */
  /* Référence du paquet de synchronisation AVANT toute écriture de ce test :
     elle sert à prouver, par différence, qu'un brouillon n'y ajoute rien. */
  const baselineCounts = packageCounts((await api('/api/sync/export')).body);

  const products = await api('/api/produits?limit=200');
  const rows = Array.isArray(products.body?.data) ? products.body.data : [];
  const product = rows.find((row) => Number(row.stock) >= 1 && row.isActive !== false);

  if (!product) {
    console.error('Aucun produit en stock : impossible de jouer le scénario. Arrêt.');
    process.exit(1);
  }

  const stockBefore = Number(product.stock);
  console.log(
    `2. Produit support : #${product.id} « ${product.name} » — stock ${stockBefore}.\n`,
  );

  /* --------------------------- Création du brouillon --------------------- */
  const draftRes = await api('/api/ventes', {
    method: 'POST',
    body: JSON.stringify({
      customerName: 'TEST BROUILLON — vérification automatique',
      date: new Date().toISOString().slice(0, 10),
      paymentMethod: 'Espèces',
      amountPaid: 0,
      discount: 0,
      status: 'draft',
      lines: [{ productId: product.id, quantity: 1, unitPrice: SENTINEL_PRICE, discount: 0 }],
    }),
  });

  if (draftRes.status !== 201 || !draftRes.body?.invoice?.id) {
    console.error(`Création du brouillon refusée (${draftRes.status}):`, draftRes.body);
    process.exit(1);
  }

  const draft = draftRes.body.invoice;
  const draftId = Number(draft.id);
  const invoiceNumber = draft.invoiceNumber;
  console.log(`3. Brouillon créé : ${invoiceNumber} (id ${draftId}).\n`);

  /* 1. Statut et montants ------------------------------------------------ */
  console.log('4. État du brouillon');
  check('statut « draft »', draft.status === 'draft', `reçu : ${draft.status}`);
  check('aucun encaissement porté', Number(draft.amountPaid) === 0);
  check('statut de paiement « unpaid »', draft.paymentStatus === 'unpaid');

  /* 2. Stock inchangé ---------------------------------------------------- */
  const afterDraft = await api(`/api/produits/${product.id}`);
  const stockAfterDraft = Number(afterDraft.body?.stock ?? -1);
  console.log('\n5. Le brouillon ne touche pas le stock');
  check(
    `stock inchangé (${stockBefore} attendu)`,
    stockAfterDraft === stockBefore,
    `reçu : ${stockAfterDraft}`,
  );

  /* 3. Encaissement refusé ----------------------------------------------- */
  console.log('\n6. Un brouillon n’est pas encaissable');
  const payOnDraft = await api('/api/paiements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'sale',
      referenceId: draftId,
      amount: 1000,
      paymentMethod: 'Espèces',
    }),
  });
  check('POST /api/paiements → 400', payOnDraft.status === 400, `reçu : ${payOnDraft.status}`);
  check(
    'le message nomme le brouillon',
    String(payOnDraft.body?.error ?? '').toLowerCase().includes('brouillon'),
    `reçu : ${payOnDraft.body?.error ?? ''}`,
  );

  /* 4. Absent de la synchronisation -------------------------------------- */
  console.log('\n7. Un brouillon ne part pas en synchronisation');
  const exportDraft = await api('/api/sync/export');
  const pkgDraft = exportDraft.body ?? {};
  const draftCounts = packageCounts(pkgDraft);

  // Mesure de **delta** : à elle seule, la création du brouillon ne doit ajouter
  // aucune ligne au paquet (ni facture, ni ligne de détail). Un prix sentinelle
  // ne suffirait pas : les factures annulées d'essais précédents sont, elles,
  // légitimement exportées.
  check(
    'aucune facture ajoutée au paquet',
    draftCounts.invoices === baselineCounts.invoices,
    `${baselineCounts.invoices} → ${draftCounts.invoices}`,
  );
  check(
    'aucune ligne de détail ajoutée au paquet',
    draftCounts.items === baselineCounts.items,
    `${baselineCounts.items} → ${draftCounts.items}`,
  );

  const exportedDrafts = (pkgDraft?.tables?.sales_invoices ?? []).filter(
    (row) => row?.fields?.status === 'draft',
  );
  check(
    'aucune vente en brouillon dans le paquet',
    exportedDrafts.length === 0,
    `${exportedDrafts.length} trouvée(s)`,
  );
  check(
    'le brouillon est absent du paquet',
    !(pkgDraft?.tables?.sales_invoices ?? []).some(
      (row) => row?.fields?.invoice_number === invoiceNumber,
    ),
  );

  /* 5. Validation -------------------------------------------------------- */
  console.log('\n8. Validation du brouillon');
  const validate = await api(`/api/ventes/${draftId}/valider`, { method: 'POST' });
  check('POST /api/ventes/[id]/valider → 200', validate.status === 200, `reçu : ${validate.status}`);
  check(
    'la facture passe « active »',
    validate.body?.invoice?.status === 'active',
    `reçu : ${validate.body?.invoice?.status}`,
  );
  check(
    'le numéro de facture ne change pas',
    validate.body?.invoice?.invoiceNumber === invoiceNumber,
  );

  const afterValidate = await api(`/api/produits/${product.id}`);
  const stockAfterValidate = Number(afterValidate.body?.stock ?? -1);
  console.log('\n9. La validation fait sortir le stock');
  check(
    `stock ${stockBefore} → ${stockBefore - 1}`,
    stockAfterValidate === stockBefore - 1,
    `reçu : ${stockAfterValidate}`,
  );

  /* 6. Double validation refusée ----------------------------------------- */
  console.log('\n10. Pas de double validation (donc pas de double sortie de stock)');
  const validateAgain = await api(`/api/ventes/${draftId}/valider`, { method: 'POST' });
  check('seconde validation → 400', validateAgain.status === 400, `reçu : ${validateAgain.status}`);
  const afterSecondAttempt = await api(`/api/produits/${product.id}`);
  check(
    'le stock n’a pas rebougé',
    Number(afterSecondAttempt.body?.stock ?? -1) === stockBefore - 1,
  );

  /* 7. Journal d'actions -------------------------------------------------- */
  const audit = await api('/api/audit?entity=sales_invoice&limit=50');
  const auditRows = Array.isArray(audit.body?.data) ? audit.body.data : [];
  const validateLog = auditRows.find(
    (row) => row.action === 'validate' && Number(row.entityId) === draftId,
  );
  console.log('\n11. Traçabilité');
  check('journal d’actions : action « validate »', Boolean(validateLog));
  const createLog = auditRows.find(
    (row) => row.action === 'create' && Number(row.entityId) === draftId,
  );
  check('journal d’actions : création du brouillon tracée', Boolean(createLog));

  /* 8. Encaissement d'une vente validée ---------------------------------- */
  console.log('\n12. Une vente validée reste encaissable');
  const payOnActive = await api('/api/paiements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'sale',
      referenceId: draftId,
      amount: SENTINEL_PRICE,
      paymentMethod: 'Espèces',
    }),
  });
  check('POST /api/paiements → 201', payOnActive.status === 201, `reçu : ${payOnActive.status}`);
  check('un reçu est émis', Boolean(payOnActive.body?.receiptNumber));

  /* 9. Synchronisation après validation ---------------------------------- */
  const exportActive = await api('/api/sync/export');
  const pkgActive = exportActive.body ?? {};
  const exportedActive = (pkgActive?.tables?.sales_invoices ?? []).filter(
    (row) => row?.fields?.invoice_number === invoiceNumber,
  );
  console.log('\n13. Après validation, la facture repart en synchronisation');
  check('la facture est présente dans le paquet', exportedActive.length === 1);
  check(
    'elle y est en « active »',
    exportedActive[0]?.fields?.status === 'active',
    `reçu : ${exportedActive[0]?.fields?.status}`,
  );
  const activeCounts = packageCounts(pkgActive);
  check(
    'le paquet gagne exactement une facture',
    activeCounts.invoices === baselineCounts.invoices + 1,
    `${baselineCounts.invoices} → ${activeCounts.invoices}`,
  );
  check(
    'le paquet gagne exactement une ligne de détail',
    activeCounts.items === baselineCounts.items + 1,
    `${baselineCounts.items} → ${activeCounts.items}`,
  );

  /* 10. Annulation (nettoyage du scénario) -------------------------------- */
  console.log('\n14. Annulation : gardes intactes, stock rendu');
  const cancel = await api(`/api/ventes/${draftId}`, {
    method: 'DELETE',
    body: JSON.stringify({ reason: 'Vérification automatique de la politique du brouillon' }),
  });
  check('DELETE /api/ventes/[id] → 200', cancel.status === 200, `reçu : ${cancel.status}`);

  const finalStock = await api(`/api/produits/${product.id}`);
  check(
    `stock rendu (${stockBefore})`,
    Number(finalStock.body?.stock ?? -1) === stockBefore,
    `reçu : ${finalStock.body?.stock}`,
  );

  const payAfterCancel = await api('/api/paiements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'sale',
      referenceId: draftId,
      amount: 100,
      paymentMethod: 'Espèces',
    }),
  });
  check(
    'une vente annulée reste non encaissable',
    payAfterCancel.status === 400,
    `reçu : ${payAfterCancel.status}`,
  );

  /* 11. Brouillons hérités : encaissés AVANT la garde --------------------- */
  console.log('\n15. Brouillons hérités (encaissés avant la mise en place de la garde)');
  console.log('    Fixtures insérées en base : état que la garde rend désormais impossible.\n');

  const db = openDatabase();

  try {
    /* A. Un brouillon hérité encaissé, puis **validé** : le paiement doit être
       conservé (l'argent est réellement en caisse) et le stock sortir. */
    const legacyValidate = await seedLegacyDraft(db, product, 1, SENTINEL_PRICE, 5000);
    const stockBeforeLegacyValidate = await currentStock(product.id);

    const validateLegacyRes = await api(`/api/ventes/${legacyValidate.id}/valider`, {
      method: 'POST',
    });
    check(
      'brouillon hérité : validation → 200',
      validateLegacyRes.status === 200,
      `reçu : ${validateLegacyRes.status}`,
    );
    check(
      'brouillon hérité : l’encaissement est conservé (5 000)',
      Number(validateLegacyRes.body?.invoice?.amountPaid) === 5000,
      `reçu : ${validateLegacyRes.body?.invoice?.amountPaid}`,
    );
    check(
      'brouillon hérité : reste à payer recalculé',
      Number(validateLegacyRes.body?.invoice?.remainingAmount) === SENTINEL_PRICE - 5000,
      `reçu : ${validateLegacyRes.body?.invoice?.remainingAmount}`,
    );
    check(
      'brouillon hérité : le stock sort',
      (await currentStock(product.id)) === stockBeforeLegacyValidate - 1,
    );

    /* B. Un brouillon hérité encaissé, puis **annulé** : la caisse doit être
       contre-passée, mais **aucun stock** ne doit être rendu (il n'est jamais
       sorti). */
    const legacyCancel = await seedLegacyDraft(db, product, 1, SENTINEL_PRICE, 3000);
    const stockBeforeLegacyCancel = await currentStock(product.id);

    const cancelLegacyRes = await api(`/api/ventes/${legacyCancel.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Fixture brouillon hérité encaissé' }),
    });
    check(
      'brouillon hérité encaissé : annulation → 200',
      cancelLegacyRes.status === 200,
      `reçu : ${cancelLegacyRes.status}`,
    );
    check(
      'brouillon hérité encaissé : le stock n’est PAS rendu',
      (await currentStock(product.id)) === stockBeforeLegacyCancel,
      `avant ${stockBeforeLegacyCancel} / après ${await currentStock(product.id)}`,
    );

    const refund = await db.execute({
      sql: `SELECT type, amount, motif FROM cash_movements
            WHERE reference_type = 'sale' AND reference_id = ? AND type = 'expense'
            ORDER BY id DESC LIMIT 1`,
      args: [legacyCancel.id],
    });
    check(
      'brouillon hérité encaissé : la caisse est contre-passée (3 000)',
      refund.rows.length === 1 && Number(refund.rows[0].amount) === 3000,
      `lignes : ${JSON.stringify(refund.rows)}`,
    );

    const cancelLog = (await api('/api/audit?entity=sales_invoice&limit=50')).body?.data?.find(
      (row) => row.action === 'cancel' && Number(row.entityId) === legacyCancel.id,
    );
    check('brouillon hérité encaissé : annulation journalisée', Boolean(cancelLog));
    check(
      'brouillon hérité encaissé : aucun stock inversé dans le journal',
      Boolean(cancelLog) && JSON.parse(cancelLog.details || '{}').reversedStock === false,
      cancelLog?.details ?? '',
    );

    /* Nettoyage du scénario A (le B est déjà annulé). */
    await api(`/api/ventes/${legacyValidate.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Nettoyage fixture brouillon hérité' }),
    });
    check(
      'nettoyage : stock revenu à son niveau initial',
      (await currentStock(product.id)) === stockBeforeLegacyValidate,
    );
  } finally {
    db.close();
  }

  console.log(`\n=== ${passes} OK · ${failures} échec(s) ===\n`);
  if (failures > 0) {
    console.log(`Facture de test (annulée) : ${invoiceNumber}\n`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('\nErreur inattendue :', error);
  process.exit(1);
});
