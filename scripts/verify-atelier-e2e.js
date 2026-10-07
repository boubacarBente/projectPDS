/**
 * Recette de bout en bout de l'**atelier de meubles par magasin** (README §29).
 *
 * Quatre sessions réelles : les gérants de Kaloum et de Matoto, le vendeur de
 * Kaloum et l'administrateur. Le script prouve **par l'API** (masquer n'est
 * pas protéger) :
 *
 *  - un modèle appartient à son magasin : invisible et non modifiable ailleurs ;
 *  - la création d'une commande ne touche pas le stock ; « Sortir les matières
 *    prévues » sort exactement la nomenclature × quantité, une seule fois ;
 *  - les chutes sortent du stock **et** comptent dans le coût ;
 *  - un stock insuffisant refuse la sortie sans rien écrire ;
 *  - encaissement : reçu, reste recalculé, refusé depuis un autre magasin, au-delà
 *    du reste, et sur une fabrication pour le stock ; le prix convenu ne descend
 *    pas sous ce qui est payé ;
 *  - les étapes ne se sautent pas ; une commande livrée ne s'annule pas ;
 *  - la fabrication pour le stock fait entrer le meuble fini une seule fois ;
 *  - l'annulation rend au stock les matières **et** leurs chutes ;
 *  - le vendeur ne voit ni coût ni marge et ne modifie rien ;
 *  - le chiffre d'affaires de `/soldes` compte la commande client.
 *
 * ⚠️ Écrit dans la base : à lancer sur une base de recette (README §28.4),
 * après `npm run demo:seed`.
 *
 * Usage : APP_URL=http://127.0.0.1:3100 npm run verify:atelier
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

/** Stock d'un produit dans le magasin actif de la session. */
async function stockOf({ api }, name) {
  const r = await api(`/api/stocks?limit=50&search=${encodeURIComponent(name)}`);
  const row = (r.body?.data ?? []).find((p) => p.name === name);
  if (!row) throw new Error(`Produit introuvable : ${name}`);
  return { id: Number(row.id), stock: Number(row.stock), purchasePrice: Number(row.purchasePrice) };
}

async function main() {
  console.log(`\nRecette de l'atelier de meubles sur ${APP_URL}\n`);
  const kal = await login({ username: 'gerant.kaloum', password: PASSWORD });
  const mat = await login({ username: 'gerant.matoto', password: PASSWORD });
  const seller = await login({ username: 'vendeur.kaloum', password: PASSWORD });
  const admin = await login(ADMIN);
  const tag = Date.now().toString(36).toUpperCase();

  const PLANCHE = 'Planche bois rouge 2,5 m';
  const CHARNIERE = 'Charnière invisible';
  const VERNIS = 'Vernis bois brillant 5 L';
  const CHAISE = 'Chaise bois massif';
  const planche0 = await stockOf(kal, PLANCHE);
  const charniere0 = await stockOf(kal, CHARNIERE);
  const vernis0 = await stockOf(kal, VERNIS);

  console.log('— Modèle et nomenclature, propres au magasin');
  const model = await kal.api('/api/atelier/modeles', {
    method: 'POST',
    body: {
      name: `Armoire recette ${tag}`,
      salePrice: 1500000,
      laborHours: 16,
      materials: [
        { productId: planche0.id, quantity: 3 },
        { productId: charniere0.id, quantity: 4 },
        { productId: vernis0.id, quantity: 1 },
      ],
    },
  });
  check('Kaloum crée un modèle avec sa nomenclature', model.status === 201, model.status === 201 ? model.body.code : err(model));
  const modelId = model.body?.id;
  const kalModels = await kal.api(`/api/atelier/modeles?search=${tag}`);
  check('Le modèle a 3 matières', kalModels.body?.data?.[0]?.materialCount === 3);
  const matModels = await mat.api(`/api/atelier/modeles?search=${tag}`);
  check('Matoto ne voit pas le modèle de Kaloum', (matModels.body?.data ?? []).length === 0);
  const forgedRead = await mat.api(`/api/atelier/modeles/${modelId}`);
  check('Matoto ne lit pas le modèle par une URL forgée', forgedRead.status === 403, `HTTP ${forgedRead.status}`);
  const forgedEdit = await mat.api(`/api/atelier/modeles/${modelId}`, { method: 'PUT', body: { salePrice: 1 } });
  check('Matoto ne modifie pas le modèle de Kaloum', forgedEdit.status >= 400, `HTTP ${forgedEdit.status}`);
  const sellerModel = await seller.api('/api/atelier/modeles', { method: 'POST', body: { name: `Interdit ${tag}` } });
  check('Le vendeur ne crée pas de modèle', sellerModel.status === 403, `HTTP ${sellerModel.status}`);

  console.log('\n— Commande client : création sans sortie de stock');
  const customers = await kal.api('/api/clients?limit=1');
  const customerId = customers.body?.data?.[0]?.id;
  const matCustomer = (await mat.api('/api/clients?limit=1')).body?.data?.[0]?.id;
  const crossCustomer = await kal.api('/api/atelier/commandes', {
    method: 'POST',
    body: { purpose: 'customer', customerId: matCustomer, modelId, quantity: 1, agreedPrice: 1 },
  });
  check('Une commande de Kaloum refuse un client de Matoto', crossCustomer.status === 400, err(crossCustomer));
  const order = await kal.api('/api/atelier/commandes', {
    method: 'POST',
    body: { purpose: 'customer', customerId, modelId, quantity: 2, agreedPrice: 3000000, promisedDate: '2099-12-31' },
  });
  check('Kaloum crée une commande de 2 armoires', order.status === 201, order.status === 201 ? order.body.orderNumber : err(order));
  const orderId = order.body?.id;
  check('Numéro au préfixe MEU', String(order.body?.orderNumber ?? '').startsWith('MEU'));
  check('Aucune matière ne sort à la création', near((await stockOf(kal, PLANCHE)).stock, planche0.stock));
  let detail = (await kal.api(`/api/atelier/commandes/${orderId}`)).body;
  const plancheNeed = detail?.requirements?.lines?.find((l) => l.productId === planche0.id);
  check('Besoins calculés : 2 × 3 planches = 6', plancheNeed?.requiredQuantity === 6 && plancheNeed?.toConsumeQuantity === 6);
  check('Aucune ligne de matière tant que rien n’est sorti', (detail?.materials ?? []).length === 0);

  console.log('\n— Sorties de matières, chutes, stock insuffisant');
  const consume = await kal.api(`/api/atelier/commandes/${orderId}`, { method: 'PUT', body: { action: 'consumePlanned' } });
  check('« Sortir les matières prévues » réussit', consume.status === 200, consume.status === 200 ? '' : err(consume));
  check('Planches : −6 dans le stock de Kaloum', near((await stockOf(kal, PLANCHE)).stock, planche0.stock - 6));
  check('Charnières : −8', near((await stockOf(kal, CHARNIERE)).stock, charniere0.stock - 8));
  const consumeAgain = await kal.api(`/api/atelier/commandes/${orderId}`, { method: 'PUT', body: { action: 'consumePlanned' } });
  check('Une seconde sortie des matières prévues est refusée', consumeAgain.status === 400, err(consumeAgain));

  const withWaste = await kal.api(`/api/atelier/commandes/${orderId}`, {
    method: 'PUT',
    body: { action: 'addMaterial', productId: planche0.id, quantity: 1, wastageQuantity: 0.5 },
  });
  check('Ajout d’une planche avec 0,5 de chute', withWaste.status === 200, withWaste.status === 200 ? '' : err(withWaste));
  check('Stock : quantité + chutes sorties (−1,5)', near((await stockOf(kal, PLANCHE)).stock, planche0.stock - 7.5));
  const wasteLine = withWaste.body?.materials?.find((m) => m.wastageQuantity > 0);
  check('Les chutes comptent dans le coût : 1,5 × prix', near(wasteLine?.amount, 1.5 * planche0.purchasePrice), `${wasteLine?.amount}`);

  const tooMuch = await kal.api(`/api/atelier/commandes/${orderId}`, {
    method: 'PUT',
    body: { action: 'addMaterial', productId: vernis0.id, quantity: 999999 },
  });
  check('Stock insuffisant : sortie refusée', tooMuch.status >= 400, err(tooMuch));
  check('… sans rien écrire', near((await stockOf(kal, VERNIS)).stock, vernis0.stock - 2));
  detail = (await kal.api(`/api/atelier/commandes/${orderId}`)).body;
  check('… ni ligne de matière fantôme', (detail?.materials ?? []).length === 4, `${detail?.materials?.length} lignes`);

  const worker = await kal.api(`/api/atelier/commandes/${orderId}`, {
    method: 'PUT',
    body: { action: 'addWorker', workerName: `Menuisier ${tag}`, days: 3, dailyRate: 50000 },
  });
  check('Affectation : 3 jours × 50 000', worker.status === 200 && near(worker.body?.costs?.laborCost, 150000));
  const fromMat = await mat.api(`/api/atelier/commandes/${orderId}`, { method: 'PUT', body: { action: 'addWorker', workerName: 'X', days: 1 } });
  check('Matoto ne modifie pas une commande de Kaloum', fromMat.status >= 400, `HTTP ${fromMat.status}`);

  console.log('\n— Coûts protégés (invariant 13)');
  const sellerView = await seller.api(`/api/atelier/commandes/${orderId}`);
  check('Le vendeur lit la commande', sellerView.status === 200);
  check('… sans coût ni marge', sellerView.body?.costs?.totalCost === null && sellerView.body?.order?.margin === null);
  const sellerEdit = await seller.api(`/api/atelier/commandes/${orderId}`, { method: 'PUT', body: { notes: 'x' } });
  check('… et ne la modifie pas', sellerEdit.status === 403, `HTTP ${sellerEdit.status}`);
  check('Le gérant voit la marge', typeof worker.body?.costs?.margin === 'number', `${worker.body?.costs?.margin}`);

  console.log('\n— Encaissements');
  const deposit = await kal.api('/api/paiements', { method: 'POST', body: { type: 'furniture_order', referenceId: orderId, amount: 1000000 } });
  check('Acompte de 1 000 000 avec reçu', deposit.status === 201 || deposit.status === 200, deposit.body?.receiptNumber ?? err(deposit));
  detail = (await kal.api(`/api/atelier/commandes/${orderId}`)).body;
  check('Reste recalculé : 2 000 000', near(detail?.order?.remainingAmount, 2000000), `${detail?.order?.remainingAmount}`);
  check('Le paiement figure sur la fiche', (detail?.payments ?? []).length === 1);
  const over = await kal.api('/api/paiements', { method: 'POST', body: { type: 'furniture_order', referenceId: orderId, amount: 2500000 } });
  check('Encaissement au-delà du reste refusé', over.status === 400, err(over));
  const otherStore = await mat.api('/api/paiements', { method: 'POST', body: { type: 'furniture_order', referenceId: orderId, amount: 1000 } });
  check('Matoto n’encaisse pas une commande de Kaloum', otherStore.status >= 400, err(otherStore));
  const lower = await kal.api(`/api/atelier/commandes/${orderId}`, { method: 'PUT', body: { agreedPrice: 500000 } });
  check('Le prix convenu ne descend pas sous l’encaissé', lower.status === 409, err(lower));

  console.log('\n— Étapes et livraison');
  const skip = await kal.api(`/api/atelier/commandes/${orderId}`, { method: 'PUT', body: { action: 'advance', stage: 'delivered' } });
  check('Sauter des étapes est refusé', skip.status === 400, err(skip));
  for (const stage of ['assembly', 'sanding', 'painting', 'finishing', 'delivered']) {
    const r = await kal.api(`/api/atelier/commandes/${orderId}`, { method: 'PUT', body: { action: 'advance', stage } });
    if (r.status !== 200) check(`Étape ${stage}`, false, err(r));
  }
  detail = (await kal.api(`/api/atelier/commandes/${orderId}`)).body;
  check('Commande livrée, à temps', detail?.order?.isDelivered && detail?.order?.isDeliveredOnTime && detail?.order?.deliveryDate);
  const cancelDelivered = await kal.api(`/api/atelier/commandes/${orderId}`, { method: 'DELETE', body: { reason: 'essai' } });
  check('Une commande livrée ne s’annule pas', cancelDelivered.status === 409, err(cancelDelivered));
  const lateMaterial = await kal.api(`/api/atelier/commandes/${orderId}`, { method: 'PUT', body: { action: 'addMaterial', productId: vernis0.id, quantity: 1 } });
  check('Plus de matière après la livraison', lateMaterial.status === 409, err(lateMaterial));

  console.log('\n— Fabrication pour le stock');
  const chaise0 = await stockOf(kal, CHAISE);
  const noProduct = await kal.api('/api/atelier/commandes', { method: 'POST', body: { purpose: 'stock', isCustom: true, dimensions: '45 × 45 × 90', quantity: 3 } });
  check('Une fabrication pour le stock exige le produit fini', noProduct.status === 400, err(noProduct));
  const stockOrder = await kal.api('/api/atelier/commandes', {
    method: 'POST',
    body: { purpose: 'stock', isCustom: true, dimensions: '45 × 45 × 90', quantity: 3, productId: chaise0.id },
  });
  check('Fabrication de 3 chaises pour le stock', stockOrder.status === 201, err(stockOrder));
  const stockOrderId = stockOrder.body?.id;
  const payStock = await kal.api('/api/paiements', { method: 'POST', body: { type: 'furniture_order', referenceId: stockOrderId, amount: 1000 } });
  check('Une fabrication pour le stock ne s’encaisse pas', payStock.status === 400, err(payStock));
  for (const stage of ['assembly', 'sanding', 'painting', 'finishing', 'delivered']) {
    await kal.api(`/api/atelier/commandes/${stockOrderId}`, { method: 'PUT', body: { action: 'advance', stage } });
  }
  check('Les 3 chaises entrent en stock', near((await stockOf(kal, CHAISE)).stock, chaise0.stock + 3));
  const again = await kal.api(`/api/atelier/commandes/${stockOrderId}`, { method: 'PUT', body: { action: 'advance', stage: 'delivered' } });
  check('… une seule fois', again.status >= 400 && near((await stockOf(kal, CHAISE)).stock, chaise0.stock + 3));

  console.log('\n— Annulation : matières et chutes rendues');
  const planche1 = (await stockOf(kal, PLANCHE)).stock;
  const toCancel = await kal.api('/api/atelier/commandes', {
    method: 'POST',
    body: { purpose: 'customer', customerName: `Passage ${tag}`, isCustom: true, dimensions: '120 × 60', quantity: 1, agreedPrice: 400000 },
  });
  const cancelId = toCancel.body?.id;
  await kal.api(`/api/atelier/commandes/${cancelId}`, { method: 'PUT', body: { action: 'addMaterial', productId: planche0.id, quantity: 2, wastageQuantity: 1 } });
  check('Sortie de 2 planches + 1 de chute', near((await stockOf(kal, PLANCHE)).stock, planche1 - 3));
  const noReason = await kal.api(`/api/atelier/commandes/${cancelId}`, { method: 'DELETE', body: { reason: ' ' } });
  check('Annulation sans motif refusée', noReason.status === 400, err(noReason));
  const sellerCancel = await seller.api(`/api/atelier/commandes/${cancelId}`, { method: 'DELETE', body: { reason: 'x' } });
  check('Le vendeur n’annule pas', sellerCancel.status === 403, `HTTP ${sellerCancel.status}`);
  const cancelled = await kal.api(`/api/atelier/commandes/${cancelId}`, { method: 'DELETE', body: { reason: `Client parti ${tag}` } });
  check('Annulation avec motif', cancelled.status === 200 && cancelled.body?.order?.status === 'cancelled', err(cancelled));
  check('Les 3 planches (chutes comprises) reviennent au stock', near((await stockOf(kal, PLANCHE)).stock, planche1));
  check('Motif, auteur et date conservés', cancelled.body?.order?.cancelReason?.includes(tag) && cancelled.body?.order?.cancelledByName);

  console.log('\n— Rentabilité et vue consolidée');
  const soldes = await kal.api('/api/soldes?period=year');
  check('/soldes compte la commande client dans le chiffre d’affaires', Number(soldes.body?.summary?.furnitureRevenue) >= 3000000, `${soldes.body?.summary?.furnitureRevenue}`);
  const consolidated = await admin.api(`/api/atelier/commandes?store=all&search=${tag}&includeCancelled=1`);
  check('L’administrateur voit les commandes en vue consolidée', (consolidated.body?.data ?? []).length >= 2, `${consolidated.body?.data?.length}`);
  const forgedScope = await mat.api(`/api/atelier/commandes?store=${order.body?.storeId}`);
  check('Matoto ne demande pas la liste de Kaloum (?store=)', forgedScope.status === 403, `HTTP ${forgedScope.status}`);

  console.log(`\n${passes} contrôle(s) réussi(s), ${failures} échec(s).\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
