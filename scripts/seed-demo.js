/*
 * Crée le **réseau de démonstration** sur une application démarrée.
 *
 *  1. Base vierge : installe le premier administrateur et le magasin « SIEGE »
 *     (type siège) par l'écran de première installation (`POST /api/auth/setup`).
 *  2. Se connecte puis appelle `POST /api/parametres/seed-data` : magasins
 *     SIEGE / KAL / MAT, comptes (mot de passe « demo1234 »), catalogue et
 *     13 mois d'activité dans tous les statuts (voir `lib/seed-data.ts`).
 *
 * À lancer sur une **base de recette**, jamais sur la base de travail : rien de
 * ce qui est créé ne se supprime (README §28.4).
 *
 *   PDS_DB_PATH=demo.db NEXT_DIST_DIR=.next-recette npx next dev -H 127.0.0.1 -p 3100
 *   APP_URL=http://127.0.0.1:3100 npm run demo:seed
 *
 * Variables : APP_URL (défaut http://127.0.0.1:3100), APP_USER (défaut admin),
 * APP_PASSWORD (défaut admin1234 — utilisé aussi pour créer l'administrateur).
 */

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const USERNAME = process.env.APP_USER ?? 'admin';
const PASSWORD = process.env.APP_PASSWORD ?? 'admin1234';

async function main() {
  const setup = await (await fetch(`${APP_URL}/api/auth/setup`)).json();
  if (setup.needsSetup) {
    const res = await fetch(`${APP_URL}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Administrateur',
        username: USERNAME,
        password: PASSWORD,
        storeName: 'Siège — Entrepôt central',
        storeCode: 'SIEGE',
        storeKind: 'headquarters',
      }),
    });
    if (!res.ok) throw new Error(`Installation refusée (${res.status}) : ${await res.text()}`);
    console.log(`[demo] administrateur « ${USERNAME} » et magasin SIEGE créés`);
  }

  const login = await fetch(`${APP_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`Connexion refusée (${login.status}) : ${await login.text()}`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

  console.log('[demo] création de la démonstration (environ une minute)…');
  const started = Date.now();
  const res = await fetch(`${APP_URL}/api/parametres/seed-data`, { method: 'POST', headers: { cookie } });
  const report = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Démonstration refusée (${res.status}) : ${report.error ?? ''}`);
  console.log(`[demo] ${report.message} (${Math.round((Date.now() - started) / 1000)} s)`);
}

main().catch((error) => {
  console.error(`[demo] ${error.message}`);
  process.exit(1);
});
