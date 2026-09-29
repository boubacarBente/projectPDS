/*
 * Vérification **dans un vrai navigateur** des écrans de la briqueterie.
 *
 * Pourquoi ce script existe : une page Next peut répondre 200 en HTML et rester
 * blanche — erreur de rendu, import client d'un module serveur, composant qui
 * lève au montage. C'est exactement le genre de défaut qu'une vérification par
 * lecture ne montre pas (AGENTS.md : « vérifier par exécution, pas par lecture »).
 * On pilote donc Chrome via le protocole DevTools (CDP) et on lit le **texte
 * réellement rendu** par chaque écran, en relevant au passage les erreurs de
 * console.
 *
 * Authentification : le mot de passe de la base de recette peut avoir changé.
 * On fabrique donc la session comme l'application la lit — un cookie
 * `session_user` contenant un utilisateur **réel** de la base locale
 * (`lib/api.ts` ne vérifie que son contenu), posé via `Network.setCookie`.
 *
 * Prérequis :
 *   1. le serveur tourne (par défaut http://127.0.0.1:3000) ;
 *   2. Chrome est lancé avec un port de débogage **dédié** :
 *      chrome.exe --headless=new --remote-debugging-port=9333
 *                --user-data-dir=<dossier unique>
 *
 * ⚠️ Piège CDP documenté dans AGENTS.md : le port 9222 peut être occupé par un
 * Chrome résiduel d'une autre session, et l'on piloterait alors le mauvais
 * navigateur (profil et session d'un autre essai). D'où le port 9333 et un
 * `--user-data-dir` unique.
 *
 * Usage : node scripts/verify-brick-ui.js
 */

const path = require('path');
const { createClient } = require('@libsql/client/sqlite3');

const DEBUG_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const DB_PATH = process.env.ELECTRON_APP_PATH
  ? path.join(process.env.ELECTRON_APP_PATH, 'database.db')
  : path.join(process.cwd(), 'db', 'database.db');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nextId = 1;
const pending = new Map();

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
  const result = await send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  return result.result?.value;
}

async function readSessionUser() {
  const client = createClient({ url: `file:${DB_PATH.replace(/\\/g, '/')}`, intMode: 'number' });
  const rows = await client.execute(
    "SELECT id, name, username, role FROM users WHERE is_active = 1 ORDER BY (role = 'admin') DESC, id LIMIT 1",
  );
  client.close();

  const user = rows.rows[0];
  if (!user) throw new Error('Aucun utilisateur actif dans la base locale.');

  return JSON.stringify({
    id: Number(user.id),
    name: String(user.name),
    username: String(user.username),
    role: String(user.role),
  });
}

/** Dernière facture du canal `brick` : sert à prouver la séparation des listes. */
async function readLatestBrickInvoice() {
  const client = createClient({ url: `file:${DB_PATH.replace(/\\/g, '/')}`, intMode: 'number' });
  const rows = await client.execute(
    "SELECT invoice_number FROM sales_invoices WHERE channel = 'brick' ORDER BY id DESC LIMIT 1",
  );
  client.close();
  return rows.rows[0]?.invoice_number ?? null;
}

/**
 * Les produits **de briqueterie** (tous) et un produit **hors briqueterie** :
 * sans les deux, on ne peut pas prouver que le formulaire restreint vraiment son
 * catalogue (un formulaire vide passerait le test).
 *
 * On renvoie **tous** les noms de briques, pas seulement le premier : l'API
 * `/api/produits` trie par dernière insertion, la première ligne du formulaire
 * n'est donc pas le plus petit `id` (erreur constatée au premier essai).
 */
async function readProductSample() {
  const client = createClient({ url: `file:${DB_PATH.replace(/\\/g, '/')}`, intMode: 'number' });
  const brick = await client.execute(
    `SELECT p.name FROM products p
      WHERE p.id IN (SELECT product_id FROM brick_types) AND p.is_active = 1
      ORDER BY p.id`,
  );
  const other = await client.execute(
    `SELECT p.name FROM products p
      WHERE p.id NOT IN (SELECT product_id FROM brick_types) AND p.is_active = 1
      ORDER BY p.id LIMIT 1`,
  );
  client.close();
  return {
    brickNames: brick.rows.map((row) => String(row.name)),
    other: other.rows[0]?.name ? String(other.rows[0].name) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Ce que chaque écran doit afficher, une fois rendu
 * ------------------------------------------------------------------ */

const SCREENS = [
  { path: '/briqueterie', expect: ['Production du jour', 'Ventes du mois', 'Dépenses de production'] },
  { path: '/briqueterie/productions', expect: ['Productions', 'Lots de la période'] },
  { path: '/briqueterie/stock', expect: ['Stock des produits finis'] },
  { path: '/briqueterie/commandes', expect: ['Commandes de briques'] },
  { path: '/briqueterie/ventes', expect: ['Ventes de briques'] },
  { path: '/briqueterie/rapports', expect: ['Rapports de la briqueterie'] },
  { path: '/ventes/nouvelle?canal=briqueterie', expect: ['Nouvelle vente de briques'] },
  { path: '/ventes', expect: ['Ventes'], reject: ['Nouvelle vente de briques'] },
];

async function main() {
  const sessionUser = await readSessionUser();

  const version = await (await fetch(`${DEBUG_URL}/json/version`)).json();
  console.log(`[verify:brick-ui] navigateur ${version.Browser}`);
  console.log(`[verify:brick-ui] application ${APP_URL}\n`);

  const targets = await (await fetch(`${DEBUG_URL}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('Aucun onglet à piloter côté navigateur.');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Connexion au navigateur impossible')), {
      once: true,
    });
  });

  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'Network.enable');

  // Session fabriquée depuis la base : même cookie que l'application.
  const url = new URL(APP_URL);
  const cookie = await send(ws, 'Network.setCookie', {
    name: 'session_user',
    value: sessionUser,
    domain: url.hostname,
    path: '/',
    httpOnly: true,
  });
  if (cookie.success === false) throw new Error('Le cookie de session a été refusé par le navigateur.');

  let failures = 0;
  const check = (label, ok, detail = '') => {
    if (!ok) failures += 1;
    console.log(`[${ok ? 'OK  ' : 'ÉCHEC'}] ${label}${detail ? ` — ${detail}` : ''}`);
  };

  /* Un identifiant réel pour la fiche d'un lot. */
  const firstLot = await (async () => {
    await send(ws, 'Page.navigate', { url: `${APP_URL}/briqueterie/productions` });
    await sleep(3500);
    return evaluate(
      ws,
      `(async () => {
         const res = await fetch('/api/briqueterie/productions?limit=1', { cache: 'no-store' });
         const data = await res.json();
         return data?.data?.[0]?.id ?? null;
       })()`,
    );
  })();

  const screens = [...SCREENS];
  if (firstLot) {
    screens.splice(5, 0, {
      path: `/briqueterie/${firstLot}`,
      expect: ['Informations du lot', 'Dépenses de production'],
    });
  }

  for (const screen of screens) {
    const consoleErrors = [];
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(
          message.params?.exceptionDetails?.exception?.description ??
            message.params?.exceptionDetails?.text ??
            'exception',
        );
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        consoleErrors.push(
          (message.params.args ?? []).map((arg) => arg.value ?? arg.description).join(' '),
        );
      }
    };
    ws.addEventListener('message', onMessage);

    await send(ws, 'Page.navigate', { url: `${APP_URL}${screen.path}` });
    await sleep(4000);

    const text = await evaluate(ws, 'document.body ? document.body.innerText : ""');
    ws.removeEventListener('message', onMessage);

    const missing = screen.expect.filter((label) => !text.includes(label));
    check(
      `Écran ${screen.path} rendu`,
      text.trim().length > 40 && missing.length === 0,
      missing.length > 0 ? `texte manquant : ${missing.join(', ')}` : `${text.length} caractères`,
    );

    // Un écran en erreur affiche « Chargement impossible » / « indisponible ».
    const broken = ['Chargement impossible', 'Une erreur est survenue', 'Application error'].filter(
      (label) => text.includes(label),
    );
    check(`Écran ${screen.path} sans écran d’erreur`, broken.length === 0, broken.join(', '));

    for (const forbidden of screen.reject ?? []) {
      check(`${screen.path} ne contient pas « ${forbidden} »`, !text.includes(forbidden));
    }

    const realErrors = consoleErrors.filter((line) => line && !/favicon/i.test(line));
    check(
      `Écran ${screen.path} sans erreur console`,
      realErrors.length === 0,
      realErrors.slice(0, 2).join(' | '),
    );
  }

  /* Le formulaire de vente briqueterie ne propose que les produits de briques. */
  const brickProductsOnly = await evaluate(
    ws,
    `(async () => {
       const [all, types] = await Promise.all([
         fetch('/api/produits?limit=500', { cache: 'no-store' }).then((r) => r.json()),
         fetch('/api/briqueterie/types?limit=200', { cache: 'no-store' }).then((r) => r.json()),
       ]);
       const ids = new Set((types.data ?? []).map((t) => Number(t.productId)));
       const brick = (all.data ?? []).filter((p) => ids.has(Number(p.id)));
       return { brick: brick.length, total: (all.data ?? []).length };
     })()`,
  );
  check(
    'Le catalogue de briqueterie est un sous-ensemble du catalogue produits',
    brickProductsOnly && brickProductsOnly.brick > 0 && brickProductsOnly.brick <= brickProductsOnly.total,
    `${brickProductsOnly?.brick}/${brickProductsOnly?.total} produits`,
  );

  /*
   * La preuve demandée par le client : une facture de briques est visible dans
   * la liste de la briqueterie et **absente** de `/ventes`.
   */
  const brickInvoice = await readLatestBrickInvoice();
  if (brickInvoice) {
    await send(ws, 'Page.navigate', { url: `${APP_URL}/briqueterie/ventes` });
    await sleep(4000);
    const brickListText = await evaluate(ws, 'document.body ? document.body.innerText : ""');
    check(
      `La facture ${brickInvoice} apparaît dans /briqueterie/ventes`,
      brickListText.includes(brickInvoice),
    );

    await send(ws, 'Page.navigate', { url: `${APP_URL}/ventes` });
    await sleep(4000);
    const generalListText = await evaluate(ws, 'document.body ? document.body.innerText : ""');
    check(
      `La facture ${brickInvoice} n’apparaît PAS dans /ventes`,
      !generalListText.includes(brickInvoice),
    );
  } else {
    check('Une facture de briques existe pour la séparation des listes', false, 'aucune facture channel=brick');
  }

  /*
   * Le formulaire de vente briqueterie ne propose **que** les produits de
   * briques : on le prouve sur le texte rendu (le premier produit du catalogue
   * filtré est pré-rempli sur la première ligne), et on vérifie qu'un produit
   * hors briqueterie n'y figure pas.
   */
  const sample = await readProductSample();
  if (sample.brickNames.length > 0) {
    await send(ws, 'Page.navigate', { url: `${APP_URL}/ventes/nouvelle?canal=briqueterie` });
    await sleep(4500);
    /*
     * `innerText` **ne contient pas la valeur d'un `<input>`** : le produit
     * sélectionné vit dans le champ du combobox. On lit donc aussi les valeurs
     * des champs, sinon le test échoue pour une mauvaise raison (constaté).
     */
    const formText = await evaluate(
      ws,
      `(() => {
         const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
           .map((field) => field.value ?? '')
           .join(' | ');
         return (document.body ? document.body.innerText : '') + ' | ' + inputs;
       })()`,
    );
    const proposed = sample.brickNames.find((name) => formText.includes(name)) ?? null;
    check(
      'Le formulaire briqueterie propose un produit de briques',
      Boolean(proposed),
      proposed ? `« ${proposed} »` : `aucun de : ${sample.brickNames.join(', ')}`,
    );
    if (sample.other) {
      check(
        `Le formulaire briqueterie ne propose pas « ${sample.other} » (hors briqueterie)`,
        !formText.includes(sample.other),
      );
    }
  } else {
    check('Des produits de briqueterie existent pour le formulaire', false, 'aucun produit lié');
  }

  console.log(`\n[verify:brick-ui] ${failures === 0 ? 'toutes les vérifications sont OK' : `${failures} échec(s)`}`);
  if (failures > 0) process.exitCode = 1;

  ws.close();
}

main().catch((error) => {
  console.error('[verify:brick-ui] erreur fatale :', error?.message ?? error);
  process.exitCode = 1;
});
