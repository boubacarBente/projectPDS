/*
 * Vérification **dans un vrai navigateur** des écrans de l'application
 * (multi-magasins compris).
 *
 * Pourquoi : une page Next peut répondre 200 et rester blanche (erreur de
 * rendu, import client d'un module serveur, composant qui lève au montage).
 * La lecture du code ne le montre pas (AGENTS.md : « vérifier par exécution »).
 * Le script lance son **propre** Chrome sans interface (port CDP dédié, profil
 * jetable — voir le piège du port 9222 dans AGENTS.md), se connecte par le vrai
 * formulaire d'API (`POST /api/auth/login`, cookie de session réel), puis
 * ouvre chaque écran et relève :
 *  - les textes attendus ;
 *  - les erreurs de console et exceptions ;
 *  - les écrans d'erreur (« Une erreur est survenue », « Application error »).
 *
 * Usage :
 *   APP_USER=admin APP_PASSWORD=… node scripts/verify-ui.js
 *   APP_URL=http://127.0.0.1:3100 SHOTS=./captures node scripts/verify-ui.js /magasins /transferts
 *
 * Variables : APP_URL (défaut http://127.0.0.1:3000), APP_USER, APP_PASSWORD,
 * CHROME (chemin du navigateur), CDP_PORT (défaut 9333), SHOTS (dossier de
 * captures PNG, facultatif), WIDTH (défaut 1366 ; 400 pour le rendu mobile).
 * Arguments : chemins à vérifier (défaut : la liste SCREENS ci-dessous).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const USERNAME = process.env.APP_USER ?? 'admin';
const PASSWORD = process.env.APP_PASSWORD ?? '';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
const WIDTH = Number(process.env.WIDTH ?? 1366);
const CHROME =
  process.env.CHROME ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((candidate) => fs.existsSync(candidate));

/** Écrans vérifiés par défaut, avec un texte qui prouve que le rendu a abouti. */
const SCREENS = [
  { path: '/', expect: ['Tableau de bord'] },
  { path: '/magasins', expect: ['Magasins', 'Chiffre d’affaires'] },
  { path: '/transferts', expect: ['Transferts'] },
  { path: '/transferts/nouveau', expect: ['Nouveau transfert'] },
  { path: '/inventaires', expect: ['Inventaires'] },
  { path: '/ventes', expect: ['Ventes'] },
  { path: '/achats', expect: ['Achats'] },
  { path: '/caisse', expect: ['Caisse'] },
  { path: '/depenses', expect: ['Dépenses'] },
  { path: '/stocks', expect: ['Stocks'] },
  { path: '/produits', expect: ['Produits'] },
  { path: '/clients', expect: ['Clients'] },
  { path: '/fournisseurs', expect: ['Fournisseurs'] },
  { path: '/chantiers', expect: ['Chantiers'] },
  // Filiales de production (README §31) : filiale 1 = Briqueterie (migration 0015),
  // 2 = Meuble (migration 0016, ex-atelier), 3 = Vitrerie (démonstration).
  { path: '/atelier', expect: ['Atelier — historique'] },
  { path: '/filiales/2/atelier/1', expect: ['Commande'] },
  { path: '/filiales/2', expect: ['Meuble'] },
  { path: '/filiales/2/modeles', expect: ['Modèles'] },
  { path: '/filiales/2/productions', expect: ['MBL-'] },
  { path: '/filiales/2/inventaire', expect: ['Inventaire'] },
  { path: '/filiales/2/depenses', expect: ['Dépenses', 'Dépenses globales'] },
  { path: '/filiales/2/caisse', expect: ['Caisse', 'Solde de la filiale'] },
  { path: '/filiales/2/parametres', expect: ['Paramètres', 'Étapes'] },
  { path: '/filiales', expect: ['Filiales de production', 'Vue consolidée'] },
  { path: '/filiales/1', expect: ['Briqueterie'] },
  { path: '/filiales/1/modeles', expect: ['Modèles'] },
  { path: '/filiales/1/productions', expect: ['Productions'] },
  { path: '/filiales/1/productions/1', expect: ['BRI-'] },
  { path: '/filiales/1/stock', expect: ['Stock'] },
  { path: '/filiales/1/commandes', expect: ['Commandes'] },
  { path: '/filiales/1/commandes/1', expect: ['BCM-'] },
  { path: '/filiales/1/ventes', expect: ['Ventes'] },
  { path: '/filiales/1/clients', expect: ['Clients de la filiale'] },
  { path: '/filiales/1/rapports', expect: ['Rapports'] },
  { path: '/filiales/3', expect: ['Vitrerie'] },
  { path: '/filiales/3/productions', expect: ['VIT-'] },
  { path: '/ventes/nouvelle?filiale=1', expect: ['Ventes de la filiale'] },
  { path: '/soldes', expect: ['Soldes'] },
  { path: '/rapports', expect: ['Rapports'] },
  { path: '/recus', expect: ['Reçus'] },
  { path: '/utilisateurs', expect: ['Utilisateurs'] },
  { path: '/utilisateurs/historique', expect: ['Historique'] },
  { path: '/parametres', expect: ['Paramètres', 'Règles multi-magasins'] },
  { path: '/synchronisation', expect: ['Synchronisation'] },
];

const ERROR_MARKERS = [
  'Une erreur est survenue',
  'Application error',
  'Unhandled Runtime Error',
  'This page could not be found',
  'Page introuvable',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * Client CDP minimal (WebSocket natif de Node ≥ 22)
 * ------------------------------------------------------------------ */

let nextId = 1;
const pending = new Map();
const listeners = new Set();

function send(ws, method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Délai dépassé pour ${method}`));
      }
    }, 60_000);
  });
}

async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitForCdp() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {
      /* pas encore prêt */
    }
    await sleep(200);
  }
  throw new Error(`Chrome ne répond pas sur le port ${PORT}`);
}

/** Attend que la page ait fini de charger ses données (plus de squelette, texte stable). */
async function waitForRender(ws) {
  let previous = '';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(400);
    const text = await evaluate(ws, 'document.body ? document.body.innerText : ""');
    const busy = await evaluate(ws, `document.querySelectorAll('.skeleton, .loading, .animate-pulse').length`);
    if (text === previous && text.length > 40 && busy === 0) return text;
    previous = text;
  }
  return previous;
}

async function main() {
  if (!CHROME) throw new Error('Navigateur introuvable : renseignez la variable CHROME.');
  if (!PASSWORD) throw new Error('Renseignez APP_PASSWORD (mot de passe de APP_USER).');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-verify-ui-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},900`,
      '--no-first-run',
      '--no-default-browser-check',
      // Conteneur Linux lancé en root (recette en ligne) : sans cela Chrome refuse de démarrer.
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let failures = 0;
  const check = (label, ok, detail = '') => {
    if (!ok) failures += 1;
    console.log(`[${ok ? 'OK   ' : 'ÉCHEC'}] ${label}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    await waitForCdp();
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('Aucun onglet à piloter.');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('Connexion au navigateur impossible')), { once: true });
    });

    await send(ws, 'Runtime.enable');
    await send(ws, 'Page.enable');
    await send(ws, 'Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: 900,
      deviceScaleFactor: 1,
      mobile: WIDTH < 640,
    });

    // Connexion réelle : la réponse pose le cookie de session dans ce profil.
    await send(ws, 'Page.navigate', { url: `${APP_URL}/login` });
    await sleep(1500);
    const login = await evaluate(
      ws,
      `fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
         credentials: 'same-origin', body: JSON.stringify(${JSON.stringify({ username: USERNAME, password: PASSWORD })}) })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))`,
    );
    if (login.status !== 200) throw new Error(`Connexion refusée (${login.status}) : ${login.body?.error ?? ''}`);
    console.log(`[verify:ui] connecté en ${USERNAME} sur ${APP_URL} (largeur ${WIDTH}px)\n`);

    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

    const requested = process.argv.slice(2);
    const screens = requested.length
      ? requested.map((p) => SCREENS.find((s) => s.path === p) ?? { path: p, expect: [] })
      : SCREENS;

    for (const screen of screens) {
      const errors = [];
      const listener = (message) => {
        if (message.method === 'Runtime.exceptionThrown') {
          errors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text);
        }
        if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
          errors.push((message.params.args ?? []).map((a) => a.value ?? a.description).join(' '));
        }
      };
      listeners.add(listener);
      await send(ws, 'Page.navigate', { url: `${APP_URL}${screen.path}` });
      const text = await waitForRender(ws);
      listeners.delete(listener);

      const missing = screen.expect.filter((label) => !text.includes(label));
      const broken = ERROR_MARKERS.filter((label) => text.includes(label));
      // Le bruit de développement (HMR, React DevTools) n'est pas une erreur de l'écran.
      const realErrors = errors.filter((e) => e && !/Download the React DevTools|\[HMR\]|\[Fast Refresh\]/.test(e));
      const overflow = await evaluate(ws, 'document.documentElement.scrollWidth - window.innerWidth');
      /*
       * Un tableau dans un conteneur `overflow-x-auto` ne fait pas déborder la
       * page, mais ses dernières colonnes (souvent les actions) sont cachées.
       * Constaté sur /utilisateurs : en largeur ordinateur, c'est un défaut.
       */
      const hiddenColumns =
        WIDTH >= 1024
          ? await evaluate(
              ws,
              `Math.max(0, ...[...document.querySelectorAll('table')].map((t) => t.parentElement)
                 .map((c) => (c ? c.scrollWidth - c.clientWidth : 0)))`,
            )
          : 0;

      check(
        screen.path,
        missing.length === 0 && broken.length === 0 && realErrors.length === 0 && overflow <= 1 && hiddenColumns <= 1,
        [
          missing.length ? `texte manquant : ${missing.join(', ')}` : '',
          broken.length ? `écran d'erreur : ${broken.join(', ')}` : '',
          realErrors.length ? `console : ${realErrors.slice(0, 3).join(' | ').slice(0, 400)}` : '',
          overflow > 1 ? `débordement horizontal de ${overflow}px` : '',
          hiddenColumns > 1 ? `tableau trop large de ${hiddenColumns}px : colonnes cachées à droite` : '',
        ]
          .filter(Boolean)
          .join(' ; ') || `${text.length} caractères`,
      );

      if (SHOTS) {
        const shot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        const name = screen.path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'accueil';
        fs.writeFileSync(path.join(SHOTS, `${name}-${WIDTH}.png`), Buffer.from(shot.data, 'base64'));
      }
    }

    ws.close();
  } finally {
    chrome.kill();
    await sleep(500);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* profil verrouillé un instant par Chrome : sans conséquence */
    }
  }

  console.log(`\n[verify:ui] ${failures === 0 ? 'tout est conforme' : `${failures} échec(s)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[verify:ui] ${error.message}`);
  process.exit(1);
});
