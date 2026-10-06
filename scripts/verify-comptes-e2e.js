/**
 * Recette de bout en bout de la **gestion des comptes** (README §17.2) :
 * super administrateur et périmètre des gérants.
 *
 * Prouve par l'API (masquer un bouton ne protège rien) :
 *
 *  - le compte créé par l'installation est le super administrateur, et il
 *    n'y en a qu'un ;
 *  - lui seul attribue le rôle Administrateur, désactive ou rétrograde un
 *    administrateur ; personne ne le désactive ni ne touche à son compte ;
 *  - un administrateur ne désactive pas un autre administrateur ;
 *  - un gérant ne s'accorde aucun droit, ne se nomme pas administrateur,
 *    n'accorde pas les droits réservés (vue consolidée, gestion des comptes…),
 *    et ne réinitialise pas le mot de passe d'un compte mieux doté que lui
 *    (affecté à un autre magasin, ou avec la vue consolidée) — les failles
 *    de la revue de sécurité du 4 octobre 2026.
 *
 * Sur une base **vierge**, le script fait lui-même l'installation. Sur une base
 * existante, il lui faut le super administrateur (APP_USER / APP_PASSWORD).
 *
 * ⚠️ Écrit dans la base (comptes, magasin) : base de recette uniquement
 * (README §28.4) — un magasin créé ne se supprime jamais.
 *
 * Usage : APP_URL=http://127.0.0.1:3100 node scripts/verify-comptes-e2e.js
 */

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const SUPER = { username: process.env.APP_USER ?? 'super', password: process.env.APP_PASSWORD ?? 'super1234' };
const PASSWORD = 'recette1234';
const RUN = Date.now().toString(36).slice(-5);

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
/** Refus attendu : 403 (périmètre) ou 409 (règle métier), jamais un succès. */
const refused = (r) => r.status === 403 || r.status === 409;

async function login(credentials) {
  const api = session();
  const r = await api('/api/auth/login', { method: 'POST', body: credentials });
  if (r.status !== 200) throw new Error(`Connexion impossible pour ${credentials.username} : ${err(r)}`);
  const me = await api('/api/auth/me');
  return { api, me: me.body };
}

async function main() {
  console.log(`\nRecette des comptes sur ${APP_URL}\n`);

  const setup = await session()('/api/auth/setup');
  if (setup.body?.needsSetup) {
    const r = await session()('/api/auth/setup', {
      method: 'POST',
      body: { name: 'Super Recette', username: SUPER.username, password: SUPER.password, storeName: 'Magasin A', storeCode: 'MAGA' },
    });
    check('installation : premier compte créé', r.status === 201, err(r));
  }

  console.log('Super administrateur');
  const sup = await login(SUPER);
  check('le compte de l’installation est super administrateur', sup.me.user?.isSuperAdmin === true);
  const again = await session()('/api/auth/setup', { method: 'POST', body: { name: 'x', username: 'autre.super', password: 'x123456' } });
  check('une seconde installation est refusée', again.status === 400, err(again));

  const storeA = sup.me.activeStoreId;
  const storeB = await sup.api('/api/magasins', { method: 'POST', body: { code: `B${RUN}`.toUpperCase(), name: `Magasin B ${RUN}` } });
  check('magasin B créé', storeB.status === 201, err(storeB));
  const idB = storeB.body?.id;

  const create = (who, body) =>
    who.api('/api/users', { method: 'POST', body: { password: PASSWORD, ...body, username: `${body.username}.${RUN}` } });

  const admin2 = await create(sup, { name: 'Admin Deux', username: 'admin2', role: 'admin' });
  const admin3 = await create(sup, { name: 'Admin Trois', username: 'admin3', role: 'admin' });
  check('le super administrateur crée des administrateurs', admin2.status === 201 && admin3.status === 201, err(admin2));
  check('un administrateur créé n’est pas super administrateur', admin2.body?.isSuperAdmin === false);

  const manager = await create(sup, { name: 'Gérant A', username: 'gerant.a', role: 'manager', stores: [{ storeId: storeA, isManager: true }] });
  const seller = await create(sup, { name: 'Vendeur A', username: 'vendeur.a', role: 'seller', stores: [{ storeId: storeA }] });
  const sellerAB = await create(sup, { name: 'Vendeur AB', username: 'vendeur.ab', role: 'seller', stores: [{ storeId: storeA }, { storeId: idB }] });
  const accountant = await create(sup, { name: 'Comptable', username: 'comptable', role: 'seller', stores: [{ storeId: storeA }] });
  check('comptes de recette créés', [manager, seller, sellerAB, accountant].every((r) => r.status === 201), err(manager));
  const grantAll = await sup.api(`/api/users/${accountant.body.id}/permissions`, {
    method: 'PUT',
    body: { overrides: [{ action: 'stores.viewAll', effect: 'allow' }] },
  });
  check('un administrateur accorde la vue consolidée', grantAll.status === 200, err(grantAll));

  console.log('\nGérant de magasin (failles de la revue du 4 octobre 2026)');
  const ger = await login({ username: `gerant.a.${RUN}`, password: PASSWORD });
  const managerId = ger.me.user.id;
  let r = await ger.api(`/api/users/${managerId}/permissions`, {
    method: 'PUT',
    body: { overrides: [{ action: 'stores.viewAll', effect: 'allow' }] },
  });
  check('il ne s’accorde pas la vue consolidée', refused(r), `${r.status} ${err(r)}`);
  r = await ger.api(`/api/users/${managerId}`, { method: 'PUT', body: { role: 'admin' } });
  check('il ne se nomme pas administrateur', refused(r), `${r.status} ${err(r)}`);
  r = await ger.api(`/api/users/${managerId}/magasins`, { method: 'PUT', body: { stores: [{ storeId: storeA }, { storeId: idB }] } });
  check('il ne s’affecte pas un autre magasin', refused(r), `${r.status} ${err(r)}`);
  r = await ger.api(`/api/users/${managerId}`, { method: 'PUT', body: { name: 'Gérant A (modifié)', role: 'manager' } });
  check('il modifie son nom (rôle renvoyé inchangé)', r.status === 200, err(r));
  r = await ger.api(`/api/users/${managerId}/password`, { method: 'PUT', body: { password: PASSWORD } });
  check('il change son propre mot de passe', r.status === 200, err(r));

  for (const action of ['stores.viewAll', 'users.manage', 'settings.critical', 'backup.manage']) {
    r = await ger.api(`/api/users/${seller.body.id}/permissions`, { method: 'PUT', body: { overrides: [{ action, effect: 'allow' }] } });
    check(`il n’accorde pas « ${action} » à un vendeur`, refused(r), `${r.status} ${err(r)}`);
  }
  const sellerRights = (await sup.api(`/api/users/${seller.body.id}/permissions`)).body;
  const sellerHas = new Set(sellerRights?.effective ?? sellerRights?.permissions ?? []);
  const reserved = new Set(['stores.viewAll', 'stores.manage', 'users.manage', 'settings.critical', 'backup.manage', 'sync.manage']);
  const grantable = (ger.me.permissions ?? []).find((a) => !reserved.has(a) && !sellerHas.has(a));
  if (grantable) {
    r = await ger.api(`/api/users/${seller.body.id}/permissions`, { method: 'PUT', body: { overrides: [{ action: grantable, effect: 'allow' }] } });
    check(`il accorde à son vendeur un droit qu’il détient (« ${grantable} »)`, r.status === 200, err(r));
  }
  r = await ger.api(`/api/users/${sellerAB.body.id}/password`, { method: 'PUT', body: { password: 'pirate1234' } });
  check('il ne réinitialise pas un compte affecté aussi à un autre magasin', refused(r), `${r.status} ${err(r)}`);
  r = await ger.api(`/api/users/${accountant.body.id}/password`, { method: 'PUT', body: { password: 'pirate1234' } });
  check('il ne réinitialise pas un compte qui a la vue consolidée', refused(r), `${r.status} ${err(r)}`);
  r = await ger.api(`/api/users/${seller.body.id}/password`, { method: 'PUT', body: { password: PASSWORD } });
  check('il réinitialise le mot de passe de son vendeur', r.status === 200, err(r));
  r = await create(ger, { name: 'Pirate', username: 'pirate', role: 'admin', stores: [{ storeId: storeA }] });
  check('il ne crée pas d’administrateur', refused(r), `${r.status} ${err(r)}`);
  const after = await ger.api('/api/auth/me');
  check('il n’a toujours pas la vue consolidée', after.body?.allStores === false && after.body?.user?.role === 'manager');

  console.log('\nAdministrateur (non super)');
  const adm = await login({ username: `admin2.${RUN}`, password: PASSWORD });
  const superId = sup.me.user.id;
  r = await adm.api(`/api/users/${superId}`, { method: 'DELETE' });
  check('il ne désactive pas le super administrateur', refused(r), `${r.status} ${err(r)}`);
  r = await adm.api(`/api/users/${superId}/password`, { method: 'PUT', body: { password: 'pirate1234' } });
  check('il ne réinitialise pas le super administrateur', refused(r), `${r.status} ${err(r)}`);
  r = await adm.api(`/api/users/${superId}`, { method: 'PUT', body: { role: 'manager' } });
  check('il ne rétrograde pas le super administrateur', refused(r), `${r.status} ${err(r)}`);
  r = await adm.api(`/api/users/${admin3.body.id}`, { method: 'DELETE' });
  check('il ne désactive pas un autre administrateur', refused(r), `${r.status} ${err(r)}`);
  r = await adm.api(`/api/users/${admin3.body.id}`, { method: 'PUT', body: { role: 'seller' } });
  check('il ne rétrograde pas un autre administrateur', refused(r), `${r.status} ${err(r)}`);
  r = await create(adm, { name: 'Admin Quatre', username: 'admin4', role: 'admin' });
  check('il ne crée pas d’administrateur', refused(r), `${r.status} ${err(r)}`);
  r = await adm.api(`/api/users/${seller.body.id}/password`, { method: 'PUT', body: { password: PASSWORD } });
  check('il gère les comptes non administrateurs', r.status === 200, err(r));

  console.log('\nCe que seul le super administrateur peut faire');
  r = await sup.api(`/api/users/${admin3.body.id}`, { method: 'DELETE' });
  check('il désactive un administrateur', r.status === 200, err(r));
  r = await sup.api(`/api/users/${admin3.body.id}?reactivate=true`, { method: 'DELETE' });
  check('il le réactive', r.status === 200, err(r));
  r = await sup.api(`/api/users/${admin3.body.id}`, { method: 'PUT', body: { role: 'manager' } });
  check('il rétrograde un administrateur', r.status === 200, err(r));
  r = await sup.api(`/api/users/${superId}`, { method: 'PUT', body: { role: 'manager' } });
  check('il reste administrateur (rétrogradation refusée)', refused(r), `${r.status} ${err(r)}`);
  r = await sup.api(`/api/users/${superId}`, { method: 'DELETE' });
  check('il ne peut pas désactiver son propre compte', r.status === 400 || refused(r), `${r.status} ${err(r)}`);
  const list = await sup.api('/api/users?includeInactive=true&limit=200');
  const supers = (list.body?.data ?? []).filter((u) => u.isSuperAdmin);
  check('un seul super administrateur', supers.length === 1 && supers[0].id === superId, `trouvés : ${supers.length}`);

  console.log(`\n${passes} vérification(s) réussie(s), ${failures} échec(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
