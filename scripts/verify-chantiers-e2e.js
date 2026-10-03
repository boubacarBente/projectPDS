/**
 * Recette de bout en bout des **prestations de chantier multi-magasins**
 * (cahier « Prestations de chantier », §30 — critères de recette).
 *
 * Trois sessions réelles : l'administrateur (vue consolidée), le gérant de
 * Kaloum et le gérant de Matoto. Le script prouve par l'API, pas par
 * l'interface (masquer n'est pas protéger) :
 *
 *   2  chaque magasin crée ses propres prestations ;
 *   3  une prestation de Kaloum n'apparaît pas dans le catalogue de Matoto ;
 *   4  deux magasins ont une prestation du même nom à des prix différents ;
 *   5  un devis de Kaloum refuse une prestation de Matoto ;
 *   6  un chantier de Kaloum ne se modifie pas depuis Matoto ;
 *   7  dépenses et paiements isolés par magasin ;
 *   8  l'administrateur voit la vue consolidée ;
 *  10  une requête API forgée vers un autre magasin est refusée ;
 *  11  modifier le catalogue ne change pas un devis ni un chantier existant ;
 *  + le montant facturé vient des prestations (marge non nulle), le retard se
 *    calcule, la conversion devis → chantier recopie les lignes.
 *
 * ⚠️ Écrit dans la base : à lancer sur une base de recette (README §28.4).
 * Prérequis : jeu de démonstration (`npm run demo:seed`).
 *
 * Usage : APP_URL=http://127.0.0.1:3100 node scripts/verify-chantiers-e2e.js
 */

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const ADMIN = { username: process.env.APP_USER ?? 'admin', password: process.env.APP_PASSWORD ?? 'admin1234' };
const KAL = { username: 'gerant.kaloum', password: process.env.DEMO_PASSWORD ?? 'demo1234' };
const MAT = { username: 'gerant.matoto', password: process.env.DEMO_PASSWORD ?? 'demo1234' };

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
const err = (r) => (r.body && r.body.error ? r.body.error : JSON.stringify(r.body)).slice(0, 140);
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function login(credentials) {
  const api = session();
  const r = await api('/api/auth/login', { method: 'POST', body: credentials });
  if (r.status !== 200) throw new Error(`Connexion impossible pour ${credentials.username} : ${err(r)}`);
  return { api, user: r.body.user, stores: r.body.stores };
}

async function main() {
  console.log(`\nRecette des prestations de chantier sur ${APP_URL}\n`);
  const admin = await login(ADMIN);
  const kal = await login(KAL);
  const mat = await login(MAT);
  const me = async (s) => (await s.api('/api/auth/me')).body;
  const kalStore = (await me(kal))?.storeId ?? kal.stores?.[0]?.id;
  const matStore = (await me(mat))?.storeId ?? mat.stores?.[0]?.id;
  console.log(`Magasins actifs : Kaloum #${kalStore}, Matoto #${matStore}`);
  check('Deux gérants travaillent dans deux magasins différents', kalStore && matStore && kalStore !== matStore);

  const customers = await kal.api('/api/clients?limit=1');
  const customerId = customers.body?.data?.[0]?.id;
  check('Un client existe (référentiel commun)', Boolean(customerId));
  const settings = (await kal.api('/api/parametres')).body;
  const category = settings?.jobCategories?.[0] ?? settings?.settings?.jobCategories?.[0] ?? 'Carrelage';
  const expenseCategory = settings?.expenseCategories?.[0] ?? settings?.settings?.expenseCategories?.[0] ?? 'Transport';
  const tag = Date.now().toString(36).toUpperCase();
  const name = `Pose de carrelage ${tag}`;

  console.log('\n— Catalogue local (critères 2, 3, 4, 10)');
  const sk = await kal.api('/api/prestations', { method: 'POST', body: { name, category, unit: 'm²', unitPrice: 25000 } });
  check('Kaloum crée sa prestation', sk.status === 201, sk.status === 201 ? `${sk.body.code} à 25 000` : err(sk));
  const sm = await mat.api('/api/prestations', { method: 'POST', body: { name, category, unit: 'm²', unitPrice: 30000 } });
  check('Matoto crée la même prestation à un autre prix', sm.status === 201, sm.status === 201 ? `${sm.body.code} à 30 000` : err(sm));
  const kalService = sk.body;
  const matService = sm.body;

  const matCatalog = await mat.api(`/api/prestations?limit=500&search=${encodeURIComponent(tag)}`);
  const ids = (matCatalog.body?.data ?? []).map((s) => s.id);
  check('Le catalogue de Matoto ne montre pas la prestation de Kaloum', !ids.includes(kalService.id) && ids.includes(matService.id));
  const forged = await mat.api(`/api/prestations/${kalService.id}`);
  check('Matoto ne lit pas la fiche de Kaloum par une URL forgée', forged.status === 403, `HTTP ${forged.status}`);
  const forgedEdit = await mat.api(`/api/prestations/${kalService.id}`, { method: 'PUT', body: { unitPrice: 1 } });
  check('Matoto ne modifie pas la prestation de Kaloum', forgedEdit.status >= 400, `HTTP ${forgedEdit.status}`);
  const scopeForged = await mat.api(`/api/prestations?store=${kalStore}`);
  check('Matoto ne peut pas demander le catalogue de Kaloum (?store=)', scopeForged.status === 403, `HTTP ${scopeForged.status}`);

  console.log('\n— Devis (critères 5, 11)');
  const badQuote = await kal.api('/api/devis', {
    method: 'POST',
    body: { customerId, category, items: [{ serviceId: matService.id, quantity: 10 }] },
  });
  check('Un devis de Kaloum refuse une prestation de Matoto', badQuote.status === 400, err(badQuote));
  const quote = await kal.api('/api/devis', {
    method: 'POST',
    body: {
      customerId,
      category,
      title: `Recette ${tag}`,
      siteAddress: 'Kaloum, Conakry',
      items: [{ serviceId: kalService.id, quantity: 20, discountPercent: 10 }],
    },
  });
  check('Kaloum établit un devis avec sa prestation', quote.status === 201, quote.status === 201 ? quote.body.reference : err(quote));
  check('Total du devis = 20 × 25 000 − 10 %', quote.body?.total === 450000, `${quote.body?.total}`);

  const priceChange = await kal.api(`/api/prestations/${kalService.id}`, { method: 'PUT', body: { unitPrice: 27000 } });
  check('Le prix du catalogue passe à 27 000', priceChange.status === 200 && priceChange.body.unitPrice === 27000);
  const quoteAfter = await kal.api(`/api/devis/${quote.body.id}`);
  check('Le devis garde son prix figé (450 000)', quoteAfter.body?.quote?.total === 450000, `${quoteAfter.body?.quote?.total}`);
  const detail = await kal.api(`/api/prestations/${kalService.id}`);
  check('L’historique des prix enregistre le changement', detail.body?.priceHistory?.[0]?.newPrice === 27000);

  const forgedQuote = await mat.api(`/api/devis/${quote.body.id}`);
  check('Matoto ne lit pas le devis de Kaloum', forgedQuote.status === 403, `HTTP ${forgedQuote.status}`);

  console.log('\n— Conversion en chantier');
  const early = await kal.api(`/api/devis/${quote.body.id}/convertir`, { method: 'POST', body: {} });
  check('Un devis non accepté ne se convertit pas', early.status === 409, err(early));
  await kal.api(`/api/devis/${quote.body.id}/statut`, { method: 'POST', body: { status: 'sent' } });
  const accepted = await kal.api(`/api/devis/${quote.body.id}/statut`, { method: 'POST', body: { status: 'accepted' } });
  check('Le devis est accepté', accepted.body?.status === 'accepted', err(accepted));
  const converted = await kal.api(`/api/devis/${quote.body.id}/convertir`, {
    method: 'POST',
    body: { startDate: today, endDate: today },
  });
  check('Le devis devient un chantier', converted.status === 201, converted.status === 201 ? converted.body.job.reference : err(converted));
  const job = converted.body?.job;
  check('Le chantier facture exactement le devis (450 000)', job?.total === 450000, `${job?.total}`);
  const twice = await kal.api(`/api/devis/${quote.body.id}/convertir`, { method: 'POST', body: {} });
  check('Un devis ne se convertit qu’une fois', twice.status === 409);

  console.log('\n— Cloisonnement du chantier (critères 6, 7, 10)');
  const forgedJob = await mat.api(`/api/chantiers/${job.id}`);
  check('Matoto ne lit pas le chantier de Kaloum', forgedJob.status === 403, `HTTP ${forgedJob.status}`);
  const forgedJobEdit = await mat.api(`/api/chantiers/${job.id}`, { method: 'PUT', body: { title: 'piraté' } });
  check('Matoto ne modifie pas le chantier de Kaloum', forgedJobEdit.status >= 400, `HTTP ${forgedJobEdit.status}`);
  const forgedItem = await mat.api(`/api/chantiers/${job.id}/prestations`, {
    method: 'POST',
    body: { serviceId: matService.id, quantity: 1 },
  });
  check('Matoto n’ajoute pas de prestation au chantier de Kaloum', forgedItem.status >= 400, `HTTP ${forgedItem.status}`);
  const kalForeignItem = await kal.api(`/api/chantiers/${job.id}/prestations`, {
    method: 'POST',
    body: { serviceId: matService.id, quantity: 1 },
  });
  check('Le chantier de Kaloum refuse une prestation de Matoto', kalForeignItem.status === 400, err(kalForeignItem));
  const forgedExpense = await mat.api('/api/depenses', {
    method: 'POST',
    body: { category: expenseCategory, amount: 1000, date: today, referenceType: 'service_job', referenceId: job.id },
  });
  check('Matoto ne rattache pas de dépense au chantier de Kaloum', forgedExpense.status === 400, err(forgedExpense));
  const forgedPayment = await mat.api('/api/paiements', {
    method: 'POST',
    body: { type: 'service_job', referenceId: job.id, amount: 1000, paymentMethod: 'Espèces', date: today },
  });
  check('Matoto n’encaisse pas sur le chantier de Kaloum', forgedPayment.status >= 400, `HTTP ${forgedPayment.status}`);

  console.log('\n— Coûts, paiements et rentabilité');
  const expense = await kal.api('/api/depenses', {
    method: 'POST',
    body: { category: expenseCategory, amount: 50000, date: today, referenceType: 'service_job', referenceId: job.id, description: 'Transport carreaux' },
  });
  check('Kaloum rattache une dépense à son chantier', expense.status === 201, err(expense));
  const payment = await kal.api('/api/paiements', {
    method: 'POST',
    body: { type: 'service_job', referenceId: job.id, amount: 200000, paymentMethod: 'Espèces', date: today },
  });
  check('Kaloum encaisse un acompte', payment.status === 201 || payment.status === 200, err(payment));
  const stage = await kal.api(`/api/chantiers/${job.id}/etapes`, {
    method: 'POST',
    body: { name: 'Préparation du support', progress: 50, serviceId: kalService.id },
  });
  check('Une étape s’ajoute avec son avancement', stage.status === 201 && stage.body.status === 'in_progress');
  const full = await kal.api(`/api/chantiers/${job.id}`);
  const costs = full.body?.costs;
  check('Rentabilité : facturé 450 000, encaissé 200 000', costs?.billed === 450000 && costs?.collected === 200000, JSON.stringify(costs && { billed: costs.billed, collected: costs.collected }));
  check('Les dépenses du chantier comptent dans le coût', costs?.expensesCost === 50000 && costs?.margin === 400000, `marge ${costs?.margin}`);
  check('L’avancement suit les étapes (50 %)', full.body?.job?.progress === 50, `${full.body?.job?.progress} %`);
  const lowered = await kal.api(`/api/chantiers/${job.id}/prestations?itemId=${full.body?.items?.[0]?.id}`, {
    method: 'PUT',
    body: { quantity: 1 },
  });
  check('Le montant ne descend pas sous ce qui est déjà payé', lowered.status === 409, err(lowered));

  console.log('\n— Retard calculé');
  const late = await kal.api('/api/chantiers', {
    method: 'POST',
    body: { customerId, category, title: `Retard ${tag}`, startDate: daysAgo(20), endDate: daysAgo(5), status: 'in_progress', amount: 100000 },
  });
  check('Un chantier en cours dont la fin est dépassée est « en retard »', late.body?.isLate === true, err(late));
  const lateList = await kal.api('/api/chantiers?late=1&limit=200');
  check('Le filtre « en retard » le retrouve', (lateList.body?.data ?? []).some((j) => j.id === late.body?.id));

  console.log('\n— Vue consolidée (critère 8)');
  const matJob = await mat.api('/api/chantiers', {
    method: 'POST',
    body: { customerId, category, title: `Matoto ${tag}`, items: [{ serviceId: matService.id, quantity: 10 }] },
  });
  check('Matoto ouvre un chantier avec sa propre prestation (10 × 30 000)', matJob.body?.total === 300000, err(matJob));
  const consolidated = await admin.api('/api/chantiers/pilotage?store=all');
  check('L’administrateur obtient le pilotage consolidé', consolidated.status === 200, err(consolidated));
  const stores = (consolidated.body?.byStore ?? []).map((s) => s.storeId);
  check('La comparaison couvre plusieurs magasins', stores.length >= 2, `${stores.length} magasins`);
  const kalOnly = await kal.api('/api/chantiers/pilotage?store=all');
  check('Le gérant de Kaloum ne voit que son magasin', (kalOnly.body?.byStore ?? []).every((s) => s.storeId === kalStore));

  console.log(`\n${passes} contrôle(s) réussi(s), ${failures} échec(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Recette interrompue :', error.message);
  process.exit(1);
});
