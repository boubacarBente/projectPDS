/**
 * Recette de bout en bout de la **briqueterie par magasin** (README §30),
 * devenue la filiale « Briqueterie » (README §31) : mêmes règles, routes
 * `/api/filiales/<id>/…` (non-régression de la généralisation).
 *
 * Sessions réelles : gérants de Kaloum et de Matoto, vendeur de Kaloum,
 * administrateur. Prouvé **par l'API** (masquer n'est pas protéger) :
 *
 *  - types, lots et commandes appartiennent à leur magasin (lecture et écriture
 *    refusées ailleurs, `?store=` forgé refusé, client d'un autre magasin refusé) ;
 *  - un lot ne crédite le stock qu'à l'étape « En stock », **une seule fois**,
 *    net des cassées ; les étapes ne reculent pas ;
 *  - une dépense de production suit le circuit des dépenses, avec les
 *    catégories de production ; son montant fait le coût du lot (jamais stocké) ;
 *  - les pertes après mise en stock sortent du stock ; l'annulation reprend le
 *    solde du lot ;
 *  - commande : brouillon non encaissable, acompte avec reçu, facture du canal
 *    briqueterie (stock sorti, acompte transféré une seule fois), plus
 *    d'encaissement sur la commande facturée ;
 *  - une vente de briques n'apparaît pas dans /ventes ; une vente de briques
 *    refuse un produit qui n'est pas une brique ;
 *  - le vendeur ne voit pas les coûts ni la rentabilité, et ne modifie rien ;
 *  - l'administrateur voit la vue consolidée ; `?store=` forgé refusé.
 *
 * ⚠️ Écrit dans la base : base de recette (README §28.4) après `npm run demo:seed`.
 * Usage : APP_URL=http://127.0.0.1:3100 npm run verify:briqueterie
 */

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo1234';
const ADMIN = { username: process.env.APP_USER ?? 'admin', password: process.env.APP_PASSWORD ?? 'admin1234' };

function session() {
  const jar = new Map();
  return async function api(path, options = {}) {
    const response = await fetch(`${APP_URL}${path}`, {
      ...options,
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
      headers: {
        'Content-Type': 'application/json',
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      redirect: 'manual',
    });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 200);
    }
    return { status: response.status, body };
  };
}

let failures = 0;
let passes = 0;
function check(label, condition, detail = '') {
  if (condition) passes += 1;
  else failures += 1;
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}
const err = (r) => (r.body && r.body.error ? r.body.error : JSON.stringify(r.body)).slice(0, 160);
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.001;

async function login(credentials) {
  const api = session();
  const r = await api('/api/auth/login', { method: 'POST', body: credentials });
  if (r.status !== 200) throw new Error(`Connexion impossible pour ${credentials.username} : ${err(r)}`);
  return { api };
}

async function stockOf({ api }, name) {
  const r = await api(`/api/stocks?limit=50&search=${encodeURIComponent(name)}`);
  const row = (r.body?.data ?? []).find((p) => p.name === name);
  return row ? Number(row.stock) : 0;
}

/** Racine de l'API de la filiale « Briqueterie » (README §31), lue après connexion. */
let F = '';

const put = (s, id, body) => s.api(`${F}/productions/${id}`, { method: 'PUT', body });

async function main() {
  console.log(`\nRecette de la briqueterie sur ${APP_URL}\n`);
  const kal = await login({ username: 'gerant.kaloum', password: PASSWORD });
  const mat = await login({ username: 'gerant.matoto', password: PASSWORD });
  const seller = await login({ username: 'vendeur.kaloum', password: PASSWORD });
  const admin = await login(ADMIN);
  const branches = (await admin.api('/api/filiales')).body?.data ?? [];
  const brickBranch = branches.find((b) => b.activity === 'bricks');
  if (!brickBranch) throw new Error('Filiale « Briqueterie » introuvable (migration 0015).');
  F = `/api/filiales/${brickBranch.id}`;
  const tag = Date.now().toString(36).toUpperCase();
  const BRICK = `Brique pleine 15 ${tag}`;

  console.log('— Type de brique, propre au magasin');
  const product = await kal.api('/api/produits', { method: 'POST', body: { name: BRICK, unit: 'pièce', salePrice: 3500, purchasePrice: 0 } });
  check('Kaloum crée le produit de la brique', product.status === 201 || product.status === 200, err(product));
  const productId = product.body?.id;
  const type = await kal.api(`${F}/modeles`, { method: 'POST', body: { productId, name: `Pleine 15 ${tag}`, shape: 'solid', dimensions: '15 × 20 × 40' } });
  check('Kaloum crée le type lié au produit', type.status === 201, err(type));
  const typeId = type.body?.id;
  const dupType = await kal.api(`${F}/modeles`, { method: 'POST', body: { productId, name: `Doublon ${tag}` } });
  check('Un produit ne porte qu’un type actif', dupType.status === 400, err(dupType));
  const matTypes = await mat.api(`${F}/modeles`);
  check('Matoto ne voit pas le type de Kaloum', !(matTypes.body?.data ?? []).some((t) => t.id === typeId));
  const forgedType = await mat.api(`${F}/modeles/${typeId}`);
  check('Matoto ne lit pas le type par une URL forgée', forgedType.status === 403, `HTTP ${forgedType.status}`);
  const sellerType = await seller.api(`${F}/modeles`, { method: 'POST', body: { productId, name: 'x' } });
  check('Le vendeur ne crée pas de type', sellerType.status === 403, `HTTP ${sellerType.status}`);

  console.log('\n— Lot : étapes, mise en stock unique, coût calculé');
  const stock0 = await stockOf(kal, BRICK);
  const lot = await kal.api(`${F}/productions`, { method: 'POST', body: { brickTypeId: typeId, plannedQuantity: 1000, team: 'Équipe A' } });
  check('Kaloum lance un lot', lot.status === 201, lot.status === 201 ? lot.body.batchNumber : err(lot));
  const lotId = lot.body?.id;
  check('Numéro au préfixe BRI', String(lot.body?.batchNumber ?? '').startsWith('BRI'));
  const matLot = await mat.api(`${F}/productions`, { method: 'POST', body: { brickTypeId: typeId, plannedQuantity: 10 } });
  check('Matoto ne lance pas de lot sur un type de Kaloum', matLot.status === 400, err(matLot));
  const matEdit = await put(mat, lotId, { producedQuantity: 1 });
  check('Matoto ne modifie pas le lot de Kaloum', matEdit.status >= 400, `HTTP ${matEdit.status}`);

  const badCategory = await put(kal, lotId, { action: 'add_expense', category: 'Loyer', amount: 1000 });
  check('Une dépense de lot refuse une catégorie hors production', badCategory.status === 400, err(badCategory));
  const expense = await put(kal, lotId, { action: 'add_expense', category: 'Ciment', amount: 600000, description: '20 sacs' });
  check('Dépense « Ciment » rattachée au lot', expense.status === 200, err(expense));
  const worker = await put(kal, lotId, { action: 'add_worker', workerName: `Mouleur ${tag}`, days: 4, dailyRate: 50000 });
  check('Équipe : 4 jours × 50 000', worker.status === 200, err(worker));
  const qty = await put(kal, lotId, { producedQuantity: 1000, brokenQuantity: 40 });
  check('Quantités : 1 000 produites, 40 cassées', qty.status === 200, err(qty));
  let detail = (await kal.api(`${F}/productions/${lotId}`)).body;
  check('Coût du lot = 600 000 + 200 000 (calculé)', near(detail?.costs?.totalCost, 800000), `${detail?.costs?.totalCost}`);
  check('Coût unitaire = 800 000 ÷ 960', near(detail?.costs?.unitCost, Math.round((800000 / 960) * 100) / 100), `${detail?.costs?.unitCost}`);
  const sellerView = await seller.api(`${F}/productions/${lotId}`);
  check('Le vendeur lit le lot sans son coût', sellerView.status === 200 && sellerView.body?.costs?.totalCost === null);
  const sellerEdit = await put(seller, lotId, { notes: 'x' });
  check('… et ne le modifie pas', sellerEdit.status === 403, `HTTP ${sellerEdit.status}`);

  const skip = await put(kal, lotId, { action: 'advance_stage', stage: 'firing' });
  check('Avancer de deux étapes d’un coup est permis (jamais en arrière)', skip.status === 200, err(skip));
  const back = await put(kal, lotId, { action: 'advance_stage', stage: 'drying' });
  check('Revenir en arrière est refusé', back.status === 400, err(back));
  check('Pas de stock avant « En stock »', near(await stockOf(kal, BRICK), stock0));
  const stored = await put(kal, lotId, { action: 'advance_stage', stage: 'stored' });
  check('Mise en stock du lot', stored.status === 200 && stored.body?.status === 'finished', err(stored));
  check('Stock : + 960 briques bonnes (1 000 − 40)', near(await stockOf(kal, BRICK), stock0 + 960));
  const again = await put(kal, lotId, { action: 'advance_stage', stage: 'stored' });
  check('Une seconde mise en stock est refusée', again.status === 400 && near(await stockOf(kal, BRICK), stock0 + 960), err(again));
  const lockedQty = await put(kal, lotId, { producedQuantity: 2000 });
  check('Quantités figées après la mise en stock', lockedQty.status === 409, err(lockedQty));
  const broken = await put(kal, lotId, { action: 'register_broken', brokenQuantity: 10, reason: 'Chute au déchargement' });
  check('Perte après mise en stock : sortie de 10', broken.status === 200 && near(await stockOf(kal, BRICK), stock0 + 950), err(broken));

  console.log('\n— Commande, acompte, facture du canal briqueterie');
  const kalCustomer = (await kal.api('/api/clients?limit=1')).body?.data?.[0]?.id;
  const matCustomer = (await mat.api('/api/clients?limit=1')).body?.data?.[0]?.id;
  const cross = await kal.api(`${F}/commandes`, { method: 'POST', body: { customerId: matCustomer, date: new Date().toISOString().slice(0, 10), items: [{ brickTypeId: typeId, quantity: 10, unitPrice: 3500 }] } });
  check('Une commande refuse un client de Matoto', cross.status === 400, err(cross));
  const order = await kal.api(`${F}/commandes`, {
    method: 'POST',
    body: { customerId: kalCustomer, date: new Date().toISOString().slice(0, 10), items: [{ brickTypeId: typeId, quantity: 300, unitPrice: 3500 }], discount: 50000 },
  });
  check('Commande de 300 briques, remise 50 000', order.status === 201 && near(order.body?.order?.total, 1000000), `${order.body?.order?.total ?? err(order)}`);
  const orderId = order.body?.order?.id;
  check('Numéro au préfixe BCM', String(order.body?.order?.orderNumber ?? '').startsWith('BCM'));
  const draftPay = await kal.api(`${F}/commandes/${orderId}/paiements`, { method: 'POST', body: { amount: 1000 } });
  check('Un brouillon ne s’encaisse pas', draftPay.status === 400, err(draftPay));
  const confirm = await kal.api(`${F}/commandes/${orderId}`, { method: 'PUT', body: { action: 'set_status', status: 'confirmed' } });
  check('Commande confirmée', confirm.status === 200, err(confirm));
  const jump = await kal.api(`${F}/commandes/${orderId}`, { method: 'PUT', body: { action: 'set_status', status: 'delivered' } });
  check('Transition interdite refusée (confirmée → livrée)', jump.status === 400, err(jump));
  const deposit = await kal.api(`${F}/commandes/${orderId}/paiements`, { method: 'POST', body: { amount: 400000 } });
  check('Acompte de 400 000 avec reçu', deposit.status === 201, deposit.body?.payment?.receiptNumber ?? err(deposit));
  const matPay = await mat.api(`${F}/commandes/${orderId}/paiements`, { method: 'POST', body: { amount: 1000 } });
  check('Matoto n’encaisse pas une commande de Kaloum', matPay.status >= 400, err(matPay));
  const before = await stockOf(kal, BRICK);
  const invoice = await kal.api(`${F}/commandes/${orderId}`, { method: 'PUT', body: { action: 'invoice' } });
  check('Facturation de la commande', invoice.status === 200 && invoice.body?.invoiceNumber, invoice.body?.invoiceNumber ?? err(invoice));
  check('La facture sort 300 briques du stock', near(await stockOf(kal, BRICK), before - 300));
  const sale = (await kal.api(`/api/ventes/${invoice.body?.invoiceId}`)).body;
  const saleInvoice = sale?.invoice ?? sale;
  check('Facture du canal briqueterie', saleInvoice?.channel === 'brick', `${saleInvoice?.channel}`);
  check('Acompte transféré : 400 000 payés sur la facture', near(saleInvoice?.amountPaid, 400000), `${saleInvoice?.amountPaid}`);
  const afterPay = await kal.api(`${F}/commandes/${orderId}/paiements`, { method: 'POST', body: { amount: 1000 } });
  check('Plus d’encaissement sur la commande facturée', afterPay.status === 400, err(afterPay));
  const twice = await kal.api(`${F}/commandes/${orderId}`, { method: 'PUT', body: { action: 'invoice' } });
  check('Une seconde facturation est refusée', twice.status === 409, err(twice));
  const general = await kal.api(`/api/ventes?search=${encodeURIComponent(invoice.body?.invoiceNumber ?? '')}`);
  check('La vente de briques n’apparaît pas dans /ventes', (general.body?.data ?? []).length === 0);
  const brickList = await kal.api(`/api/ventes?channel=brick&search=${encodeURIComponent(invoice.body?.invoiceNumber ?? '')}`);
  check('… mais dans les ventes de la briqueterie', (brickList.body?.data ?? []).length === 1);

  const otherProduct = (await kal.api('/api/stocks?limit=5')).body?.data?.find((p) => p.name !== BRICK && Number(p.stock) > 0);
  const wrongSale = await kal.api('/api/ventes', {
    method: 'POST',
    body: { channel: 'brick', productionBranchId: brickBranch.id, customerName: 'Comptoir', date: new Date().toISOString().slice(0, 10), lines: [{ productId: otherProduct?.id, quantity: 1, unitPrice: 1000 }] },
  });
  check('Une vente de briques refuse un autre produit', wrongSale.status === 400, err(wrongSale));

  console.log('\n— Annulation d’un lot');
  const lot2 = await kal.api(`${F}/productions`, { method: 'POST', body: { brickTypeId: typeId, plannedQuantity: 100, producedQuantity: 100 } });
  const lot2Id = lot2.body?.id;
  await put(kal, lot2Id, { action: 'advance_stage', stage: 'stored' });
  const s1 = await stockOf(kal, BRICK);
  const noReason = await kal.api(`${F}/productions/${lot2Id}`, { method: 'DELETE', body: { reason: '' } });
  check('Annulation sans motif refusée', noReason.status === 400, err(noReason));
  const cancel = await kal.api(`${F}/productions/${lot2Id}`, { method: 'DELETE', body: { reason: `Erreur de saisie ${tag}` } });
  check('Annulation avec motif', cancel.status === 200 && cancel.body?.status === 'cancelled', err(cancel));
  check('Les 100 briques du lot ressortent du stock', near(await stockOf(kal, BRICK), s1 - 100));
  const editCancelled = await put(kal, lot2Id, { notes: 'x' });
  check('Un lot annulé ne se modifie plus', editCancelled.status === 409, err(editCancelled));

  console.log('\n— Vue consolidée et bénéfice');
  const consolidated = await admin.api(`${F}/productions?store=all&search=${tag}`);
  check('L’administrateur voit le lot en vue consolidée', (consolidated.body?.data ?? []).some((p) => p.id === lotId));
  const forgedScope = await mat.api(`${F}/productions?store=${lot.body?.storeId}`);
  check('Matoto ne demande pas les lots de Kaloum (?store=)', forgedScope.status === 403, `HTTP ${forgedScope.status}`);
  const dashboard = await kal.api(`${F}/tableau-de-bord`);
  check('Tableau de bord de la briqueterie', dashboard.status === 200 && dashboard.body?.stock?.lines?.some((l) => l.brickTypeId === typeId), err(dashboard));
  const sellerDash = await seller.api(`${F}/tableau-de-bord`);
  check('… sans rentabilité pour le vendeur', sellerDash.status === 200 && sellerDash.body?.profitability === null);
  const reports = await kal.api(`${F}/rapports`);
  check('Rapport de la briqueterie', reports.status === 200 && Array.isArray(reports.body?.productionByType), err(reports));
  const sellerReports = await seller.api(`${F}/rapports`);
  check('Le vendeur n’a pas le rapport (rentabilité)', sellerReports.status === 403, `HTTP ${sellerReports.status}`);

  console.log(`\n${passes} contrôle(s) réussi(s), ${failures} échec(s).\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
