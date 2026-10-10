/**
 * Recette de bout en bout des **filiales de production complètes** (README §31,
 * cahier des charges `docs/CAHIER-DES-CHARGES-FILIALES.md` §21).
 *
 * Sessions réelles : gérant de Kaloum, gérant de Matoto, vendeur de Kaloum,
 * administrateur. Prouvé **par l'API** (masquer n'est pas protéger) :
 *
 *  - `/atelier` a disparu du menu et redirige vers la filiale Meuble ; les
 *    anciennes commandes restent lisibles, aucune nouvelle n'est acceptée ;
 *  - l'administrateur crée une filiale nommée librement, avec icône et ordre,
 *    qui apparaît dans le menu ; suspendue, elle en sort ;
 *  - nomenclature d'un modèle → besoins d'une production → sortie « tout ou
 *    rien » des matières prévues, chutes sorties et coûtées, retrait rendu au
 *    stock, production en stock qui augmente le stock du modèle ;
 *  - dépense globale de filiale : circuit des dépenses, mouvement de caisse
 *    portant la filiale, bénéfice de la période diminué ;
 *  - caisse de filiale : entrées, sorties, solde ;
 *  - inventaire de filiale : ses modèles, écart justifié obligatoire,
 *    validation qui ajuste le stock, un seul inventaire ouvert par magasin ;
 *  - coûts masqués au vendeur ; filiale restreinte inaccessible (API) et ses
 *    dépenses absentes de /depenses.
 *
 * ⚠️ Écrit dans la base : base de recette (README §28.4) après `npm run demo:seed`.
 * Usage : APP_URL=http://127.0.0.1:3100 npm run verify:filiales
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
    return { status: response.status, body, headers: response.headers, raw: text };
  };
}

let failures = 0;
let passes = 0;
function check(label, condition, detail = '') {
  if (condition) passes += 1;
  else failures += 1;
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}
const err = (r) => (r.body && r.body.error ? r.body.error : JSON.stringify(r.body)).slice(0, 180);
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

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

async function main() {
  console.log(`\nRecette des filiales de production sur ${APP_URL}\n`);
  const kal = await login({ username: 'gerant.kaloum', password: PASSWORD });
  const mat = await login({ username: 'gerant.matoto', password: PASSWORD });
  const seller = await login({ username: 'vendeur.kaloum', password: PASSWORD });
  const admin = await login(ADMIN);
  const tag = Date.now().toString(36).toUpperCase();

  const branches = (await admin.api('/api/filiales')).body?.data ?? [];
  const meuble = branches.find((b) => b.activity === 'furniture');
  const brick = branches.find((b) => b.activity === 'bricks');
  check('La filiale Meuble existe (reprise de l’atelier, migration 0016)', Boolean(meuble), meuble?.name ?? '');
  if (!meuble || !brick) throw new Error('Filiales de démonstration introuvables.');
  const M = `/api/filiales/${meuble.id}`;

  console.log('\n— Suppression de /atelier');
  const nav = (await kal.api('/api/filiales/navigation')).body?.data ?? [];
  check('Meuble a son lien dans le menu, avec son icône', nav.some((l) => l.id === meuble.id && l.icon === 'furniture'));
  // Redirection d'un composant serveur : 307 direct, ou redirection diffusée dans la page (NEXT_REDIRECT).
  const redirect = await kal.api('/atelier');
  const target = `/filiales/${meuble.id}/atelier`;
  check(
    '/atelier redirige vers l’historique de la filiale Meuble',
    String(redirect.headers.get('location') ?? '').includes(target) || String(redirect.raw ?? '').includes(`NEXT_REDIRECT;replace;${target};`),
    `HTTP ${redirect.status}`,
  );
  const oldOrders = await kal.api('/api/atelier/commandes?limit=5');
  check('Les anciennes commandes d’atelier restent lisibles', oldOrders.status === 200 && (oldOrders.body?.data ?? []).length > 0, `HTTP ${oldOrders.status}`);
  // Une commande d'atelier en cours s'achève toujours (étape suivante, encaissement).
  const STAGES = ['cutting', 'assembly', 'sanding', 'painting', 'finishing', 'delivered'];
  const inProgress = ((await kal.api('/api/atelier/commandes?limit=100')).body?.data ?? []).find(
    (o) => !o.isCancelled && o.stage !== 'delivered' && o.purpose === 'customer',
  );
  if (inProgress) {
    const nextStage = STAGES[STAGES.indexOf(inProgress.stage) + 1];
    const advanced = await kal.api(`/api/atelier/commandes/${inProgress.id}`, { method: 'PUT', body: { action: 'advance', stage: nextStage } });
    check(`Commande d’atelier en cours : étape suivante (${nextStage})`, advanced.status === 200, err(advanced));
    const fresh = (await kal.api(`/api/atelier/commandes/${inProgress.id}`)).body;
    const remaining = Number(fresh?.order?.remainingAmount ?? 0);
    if (remaining > 0) {
      const pay = await kal.api('/api/paiements', { method: 'POST', body: { type: 'furniture_order', referenceId: inProgress.id, amount: Math.min(1000, remaining), paymentMethod: 'Espèces' } });
      check('… et son encaissement (reçu, caisse de la filiale Meuble)', pay.status === 201 || pay.status === 200, err(pay));
    }
    const sellerAdvance = await seller.api(`/api/atelier/commandes/${inProgress.id}`, { method: 'PUT', body: { action: 'advance', stage: STAGES[STAGES.indexOf(nextStage) + 1] } });
    check('Le vendeur ne fait pas avancer une commande d’atelier', sellerAdvance.status === 403, `HTTP ${sellerAdvance.status}`);
  } else {
    check('Une commande d’atelier en cours existe dans la démonstration', false);
  }
  const newOrder = await kal.api('/api/atelier/commandes', { method: 'POST', body: { purpose: 'customer', modelName: 'x', agreedPrice: 1 } });
  check('Plus de nouvelle commande d’atelier (409)', newOrder.status === 409, err(newOrder));

  console.log('\n— Filiale créée par l’administrateur, menu');
  const created = await admin.api('/api/filiales', {
    method: 'POST',
    body: { name: `Aluminium ${tag}`, activity: 'other', icon: 'door', color: 'accent', sortOrder: 0, stages: ['Découpe', 'Montage'], batchPrefix: 'ALU', orderPrefix: 'ALC' },
  });
  check('Création d’une filiale au nom libre', created.status === 201 || created.status === 200, err(created));
  const alu = created.body;
  const nav2 = (await admin.api('/api/filiales/navigation')).body?.data ?? [];
  check('Elle apparaît dans le menu avec l’icône choisie, en tête (ordre 0)', nav2[0]?.id === alu?.id && nav2[0]?.icon === 'door', JSON.stringify(nav2[0] ?? {}).slice(0, 80));
  const suspended = await admin.api(`/api/filiales/${alu?.id}`, { method: 'PUT', body: { action: 'set_status', status: 'suspended', reason: 'Essai' } });
  const nav3 = (await admin.api('/api/filiales/navigation')).body?.data ?? [];
  check('Suspendue, elle quitte le menu', suspended.status === 200 && !nav3.some((l) => l.id === alu?.id), err(suspended));

  console.log('\n— Nomenclature, besoins, matières et chutes');
  const PLANK = 'Planche bois rouge 2,5 m';
  const HINGE = 'Charnière invisible';
  const products = (await kal.api(`/api/produits?limit=500`)).body?.data ?? [];
  const plank = products.find((p) => p.name === PLANK);
  const hinge = products.find((p) => p.name === HINGE);
  const finished = await kal.api('/api/produits', { method: 'POST', body: { name: `Buffet ${tag}`, unit: 'pièce', salePrice: 900000, purchasePrice: 0 } });
  const model = await kal.api(`${M}/modeles`, { method: 'POST', body: { productId: finished.body?.id, name: `Buffet ${tag}`, category: 'Rangement' } });
  check('Kaloum crée un modèle de meuble', model.status === 201, err(model));
  const bom = await kal.api(`${M}/modeles/${model.body?.id}/nomenclature`, {
    method: 'PUT',
    body: { materials: [{ productId: plank?.id, quantity: 3 }, { productId: hinge?.id, quantity: 4 }] },
  });
  check('Nomenclature : 3 planches + 4 charnières par buffet', bom.status === 200 && bom.body?.length === 2, err(bom));
  const matBom = await mat.api(`${M}/modeles/${model.body?.id}/nomenclature`, { method: 'PUT', body: { materials: [] } });
  check('Matoto ne modifie pas la nomenclature de Kaloum', matBom.status >= 400, `HTTP ${matBom.status}`);

  const plank0 = await stockOf(kal, PLANK);
  const hinge0 = await stockOf(kal, HINGE);
  const prod = await kal.api(`${M}/productions`, { method: 'POST', body: { brickTypeId: model.body?.id, plannedQuantity: 2 } });
  check('Production de 2 buffets (préfixe de la filiale)', prod.status === 201 && String(prod.body?.batchNumber ?? '').startsWith(meuble.batchPrefix), err(prod));
  const P = `${M}/productions/${prod.body?.id}`;
  let detail = (await kal.api(P)).body;
  const plankNeed = detail?.requirements?.lines?.find((l) => l.productId === plank?.id);
  check('Besoins = nomenclature × 2 (6 planches)', near(plankNeed?.requiredQuantity, 6), JSON.stringify(plankNeed ?? {}).slice(0, 120));
  check('Aucune matière sortie à la création', (await stockOf(kal, PLANK)) === plank0);

  const consume = await kal.api(P, { method: 'PUT', body: { action: 'consume_planned' } });
  check('Sortie des matières prévues', consume.status === 200, err(consume));
  check('Stock des planches −6, charnières −8', near(await stockOf(kal, PLANK), plank0 - 6) && near(await stockOf(kal, HINGE), hinge0 - 8));
  const again = await kal.api(P, { method: 'PUT', body: { action: 'consume_planned' } });
  check('Rien à sortir une seconde fois', again.status === 400, err(again));
  const waste = await kal.api(P, { method: 'PUT', body: { action: 'add_material', productId: plank?.id, quantity: 1, wastageQuantity: 1, unitCost: 50000 } });
  check('Matière ajoutée avec chutes', waste.status === 200, err(waste));
  check('Chutes sorties du stock (−2 de plus)', near(await stockOf(kal, PLANK), plank0 - 8));
  detail = (await kal.api(P)).body;
  const wasteLine = (detail?.materials ?? []).find((m) => m.wastageQuantity > 0);
  check('Chutes comptées dans le coût : (1 + 1) × 50 000', near(wasteLine?.amount, 100000), `${wasteLine?.amount}`);
  const materialSum = (detail?.materials ?? []).reduce((s, m) => s + Number(m.amount ?? 0), 0);
  check('Coût matières de la production = somme des lignes (jamais stocké)', near(detail?.costs?.materialCost, materialSum) && near(detail?.production?.totalCost, materialSum), `${detail?.costs?.materialCost}`);
  const sellerDetail = (await seller.api(P)).body;
  check('Le vendeur ne voit aucun coût de matière', sellerDetail?.costs?.totalCost === null && (sellerDetail?.materials ?? []).every((m) => m.amount === null));
  const removed = await kal.api(P, { method: 'PUT', body: { action: 'remove_material', materialId: wasteLine?.id } });
  check('Retrait : la matière revient au stock avec ses chutes', removed.status === 200 && near(await stockOf(kal, PLANK), plank0 - 6), err(removed));

  const stockBuffet0 = await stockOf(kal, `Buffet ${tag}`);
  await kal.api(P, { method: 'PUT', body: { producedQuantity: 2 } });
  for (const stage of meuble.flow.slice(1)) {
    await kal.api(P, { method: 'PUT', body: { action: 'advance_stage', stage: stage.key } });
  }
  check('Production en stock : +2 buffets', near(await stockOf(kal, `Buffet ${tag}`), stockBuffet0 + 2));
  const late = await kal.api(P, { method: 'PUT', body: { action: 'add_material', productId: plank?.id, quantity: 1 } });
  check('Plus de matière une fois en stock', late.status === 409, err(late));

  console.log('\n— Dépense globale, caisse et bénéfice de la filiale');
  const cash0 = (await kal.api(`${M}/caisse`)).body?.summary;
  const dash0 = (await kal.api(`${M}/tableau-de-bord`)).body;
  const badCat = await kal.api(`${M}/depenses`, { method: 'POST', body: { category: 'Ciment', amount: 1000 } });
  check('Une dépense globale refuse une catégorie hors liste', badCat.status === 400, err(badCat));
  const exp = await kal.api(`${M}/depenses`, { method: 'POST', body: { category: 'Loyer et charges', amount: 250000, description: `Loyer ${tag}` } });
  check('Dépense globale « Loyer et charges » enregistrée', exp.status === 201, err(exp));
  const decaissee = exp.body?.approvalStatus === 'approved';
  const cash1 = (await kal.api(`${M}/caisse`)).body?.summary;
  if (decaissee) {
    check('Décaissée : sortie de caisse portant la filiale (+250 000 de sorties)', near(cash1?.expense - cash0?.expense, 250000), `${cash0?.expense} → ${cash1?.expense}`);
    check('Solde de la filiale diminué de 250 000', near(cash0?.balance - cash1?.balance, 250000));
    const dash1 = (await kal.api(`${M}/tableau-de-bord`)).body;
    check('Dépenses globales du mois du tableau de bord +250 000', near(dash1?.expenses?.generalMonth - dash0?.expenses?.generalMonth, 250000), `${dash0?.expenses?.generalMonth} → ${dash1?.expenses?.generalMonth}`);
  } else {
    check('Au-delà du seuil : en attente, aucune sortie de caisse', near(cash1?.expense, cash0?.expense));
  }
  const listExp = (await kal.api(`${M}/depenses?kind=global`)).body;
  check('Elle figure dans les dépenses globales de la filiale', (listExp?.data ?? []).some((e) => e.id === exp.body?.id));
  const brickExp = (await kal.api(`/api/filiales/${brick.id}/depenses?kind=global&limit=200`)).body;
  check('… et pas dans celles de la Briqueterie', !(brickExp?.data ?? []).some((e) => e.id === exp.body?.id));
  const cancel = await kal.api(`${M}/depenses/${exp.body?.id}`, { method: 'DELETE', body: { reason: 'Essai de recette' } });
  check('Annulation motivée de la dépense', cancel.status === 200, err(cancel));
  const cash2 = (await kal.api(`${M}/caisse`)).body?.summary;
  check('L’argent revient dans la caisse de la filiale', near(cash2?.balance, cash0?.balance), `${cash0?.balance} → ${cash2?.balance}`);

  console.log('\n— Inventaire de filiale');
  const open = (await kal.api('/api/inventaires?status=open&limit=5')).body?.data ?? [];
  for (const inv of open) await kal.api(`/api/inventaires/${inv.id}`, { method: 'POST', body: { action: 'cancel', reason: 'Recette filiales' } });
  const inv = await kal.api(`${M}/inventaires`, { method: 'POST', body: { notes: 'Recette' } });
  check('Inventaire de la filiale ouvert', inv.status === 201, err(inv));
  const items = inv.body?.items ?? [];
  const buffetItem = items.find((i) => i.productName === `Buffet ${tag}`);
  check('Il porte les modèles de la filiale et leurs matières', Boolean(buffetItem) && items.some((i) => i.productName === PLANK), `${items.length} lignes`);
  check('… et pas les briques', !items.some((i) => /brique/i.test(i.productName)));
  const second = await kal.api(`/api/filiales/${brick.id}/inventaires`, { method: 'POST', body: {} });
  check('Un seul inventaire ouvert par magasin', second.status === 400, err(second));
  const invId = inv.body?.inventory?.id;
  await kal.api(`/api/inventaires/${invId}`, { method: 'POST', body: { action: 'count', counts: [{ itemId: buffetItem?.id, countedQuantity: 1 }] } });
  const unjust = await kal.api(`/api/inventaires/${invId}`, { method: 'POST', body: { action: 'validate' } });
  check('Validation refusée tant que l’écart n’est pas justifié', unjust.status === 400, err(unjust));
  await kal.api(`/api/inventaires/${invId}`, { method: 'POST', body: { action: 'count', counts: [{ itemId: buffetItem?.id, countedQuantity: 1, justification: 'Buffet abîmé au transport' }] } });
  const valid = await kal.api(`/api/inventaires/${invId}`, { method: 'POST', body: { action: 'validate' } });
  check('Validation : ajustement créé', valid.status === 200 && valid.body?.result?.adjustments === 1, err(valid));
  check('Stock du buffet ajusté à 1', near(await stockOf(kal, `Buffet ${tag}`), 1));
  const branchInv = (await kal.api(`${M}/inventaires`)).body?.data ?? [];
  check('L’inventaire validé reste dans l’historique de la filiale', branchInv.some((i) => i.id === invId && i.status === 'validated'));

  console.log('\n— Cloisonnement d’une filiale restreinte');
  const restricted = await admin.api('/api/filiales', { method: 'POST', body: { name: `Privée ${tag}`, activity: 'other', stages: ['Fabrication'], batchPrefix: 'PRV', orderPrefix: 'PRC', accessMode: 'restricted' } });
  const R = `/api/filiales/${restricted.body?.id}`;
  await admin.api(`${R}/utilisateurs`, { method: 'PUT', body: { users: [] } });
  const sellerR = await seller.api(R);
  check('Le vendeur n’ouvre pas une filiale restreinte (API)', sellerR.status === 403, `HTTP ${sellerR.status}`);
  const sellerNav = (await seller.api('/api/filiales/navigation')).body?.data ?? [];
  check('… ni dans son menu', !sellerNav.some((l) => l.id === restricted.body?.id));
  const kalR = await kal.api(R);
  check('Le gérant non autorisé non plus', kalR.status === 403, `HTTP ${kalR.status}`);

  console.log(`\n${passes} contrôle(s) réussi(s), ${failures} échec(s).\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nÉchec : ${error.message}`);
  process.exit(1);
});
