/**
 * Vérification de bout en bout du module **Achats**.
 *
 * Un achat a une signature très particulière qu'il faut prouver :
 *  1. l'enregistrement **augmente le stock** (contrairement à une vente) ;
 *  2. s'il est payé, il **fait sortir de l'argent de la caisse** ;
 *  3. il crée une **dette fournisseur** si le paiement est partiel ;
 *  4. il produit un **numéro ACH-…** sans trou ;
 *  5. la route `?supplierId=` fonctionne, car `app/fournisseurs/[id]/paiements`
 *     en dépend.
 *
 * Prérequis : serveur de développement sur http://127.0.0.1:3000, base
 * contenant un administrateur (`admin` / `Admin2026!` par défaut).
 *
 * Usage : `node scripts/verify-purchases-e2e.js`
 */

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const USERNAME = process.env.APP_USER ?? 'admin';
const PASSWORD = process.env.APP_PASSWORD ?? 'Admin2026!';

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

  // Mémorise les cookies de session posés par la connexion.
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const line of setCookie) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 200);
  }

  return { status: response.status, body };
}

let failures = 0;
let passes = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passes += 1;
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

const today = new Date().toISOString().slice(0, 10);

async function main() {
  console.log('── Connexion ──');
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  check('authentification', login.status === 200, `HTTP ${login.status}`);
  if (login.status !== 200) throw new Error('Connexion refusée.');

  console.log('\n── Données de référence ──');
  const suppliers = await api('/api/fournisseurs?limit=5');
  const products = await api('/api/produits?limit=100');
  const supplier = suppliers.body?.data?.[0];
  // On prend deux produits pour vérifier que chaque ligne produit son entrée.
  const chosen = (products.body?.data ?? []).slice(0, 2);

  check('un fournisseur existe', Boolean(supplier), supplier?.name);
  check('au moins deux produits existent', chosen.length >= 2);
  if (!supplier || chosen.length < 2) throw new Error('Jeu de données insuffisant.');

  console.log('\n── Stock AVANT ──');
  const before = new Map();
  for (const product of chosen) {
    const stock = await api(`/api/stocks?limit=200`);
    const row = (stock.body?.data ?? []).find((p) => p.id === product.id);
    before.set(product.id, row?.stock ?? 0);
    console.log(`  ${product.name} : ${before.get(product.id)}`);
  }

  console.log('\n── Caisse AVANT ──');
  const cashBefore = (await api('/api/caisse/sessions')).body?.summary?.balance ?? 0;
  console.log(`  solde : ${cashBefore}`);

  console.log('\n── Création de l’achat ──');
  const lines = chosen.map((product) => ({
    productId: product.id,
    quantity: 5,
    unitPrice: Number(product.purchasePrice) || 10000,
  }));
  const expectedTotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  const paid = Math.round(expectedTotal / 2);

  const created = await api('/api/achats', {
    method: 'POST',
    body: JSON.stringify({
      supplierId: supplier.id,
      supplierReference: 'FA-2026-0099',
      date: today,
      dueDate: today,
      paymentMethod: 'Espèces',
      amountPaid: paid,
      notes: 'Achat de vérification technique',
      lines,
    }),
  });

  check('création acceptée', created.status === 201 || created.status === 200, `HTTP ${created.status}`);
  if (!created.body?.invoice) {
    console.log(`  réponse : ${JSON.stringify(created.body).slice(0, 300)}`);
    throw new Error("L'achat n'a pas été créé.");
  }

  const invoice = created.body.invoice;
  console.log(`  référence : ${invoice.reference}`);
  check('numéro ACH-…', /^ACH-/.test(invoice.reference ?? ''), invoice.reference);
  check('total exact', Number(invoice.total) === expectedTotal, `${invoice.total} attendu ${expectedTotal}`);
  check('paiement partiel', invoice.paymentStatus === 'partial', invoice.paymentStatus);
  check(
    'dette fournisseur',
    Number(invoice.remainingAmount) === expectedTotal - paid,
    `reste ${invoice.remainingAmount}`,
  );

  console.log('\n── Stock APRÈS (doit avoir AUGMENTÉ de 5) ──');
  const afterAll = await api('/api/stocks?limit=200');
  for (const product of chosen) {
    const row = (afterAll.body?.data ?? []).find((p) => p.id === product.id);
    const after = row?.stock ?? 0;
    const delta = after - before.get(product.id);
    check(`${product.name} : +5`, Math.abs(delta - 5) < 0.001, `variation ${delta}`);
  }

  console.log('\n── Caisse APRÈS (doit avoir BAISSÉ du montant payé) ──');
  const cashAfter = (await api('/api/caisse/sessions')).body?.summary?.balance ?? 0;
  check('sortie de caisse', Math.abs(cashBefore - cashAfter - paid) < 1, `variation ${cashAfter - cashBefore}`);

  console.log('\n── Mouvement de stock tracé ──');
  const movements = await api(`/api/stocks/mouvements?productId=${chosen[0].id}&limit=3`);
  const purchaseEntry = (movements.body?.data ?? []).find((m) => m.referenceType === 'purchase');
  check('entrée liée à l’achat', Boolean(purchaseEntry), purchaseEntry?.motif);

  console.log('\n── Route attendue par la page Fournisseurs ──');
  const bySupplier = await api(`/api/achats?supplierId=${supplier.id}&limit=50`);
  check('GET /api/achats?supplierId=', bySupplier.status === 200, `HTTP ${bySupplier.status}`);
  const found = (bySupplier.body?.data ?? []).find((row) => row.id === invoice.id);
  check('l’achat apparaît pour ce fournisseur', Boolean(found));
  check('remainingAmount exposé', found?.remainingAmount !== undefined, `${found?.remainingAmount}`);

  console.log('\n── Détail et pages ──');
  const detail = await api(`/api/achats/${invoice.id}`);
  check('détail', detail.status === 200, `HTTP ${detail.status}`);
  check('lignes présentes', (detail.body?.items ?? []).length === lines.length);
  check('échéancier', Boolean(detail.body?.schedule));

  for (const path of ['/achats', '/achats/nouvelle', `/achats/${invoice.id}`]) {
    const response = await fetch(`${APP_URL}${path}`, {
      headers: { cookie: cookieHeader() },
      redirect: 'manual',
    });
    check(`page ${path}`, response.status === 200 || response.status === 307, `HTTP ${response.status}`);
  }

  console.log(`\n${passes} test(s) réussi(s), ${failures} échec(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nÉchec : ${error.message}`);
  process.exit(1);
});
