/**
 * Vérification de fumée de **toutes** les routes de l'application.
 *
 * Pourquoi ce script existe : la recette faite jusqu'ici était manuelle
 * (« 12 pages et 31 points d'API répondent 200 »). Le nombre de routes a
 * augmenté (module Achats, permissions par utilisateur) et une page qui
 * répond 500 se voit uniquement à l'usage. Ce script **découvre les routes
 * dans `app/`** : il n'y a aucune liste à tenir à jour, donc il ne peut pas
 * devenir obsolète.
 *
 * Ce qu'il vérifie :
 *   1. chaque écran (hors segment dynamique) répond 200, ou redirige vers la
 *      connexion (307/308) si la session n'est pas valide ;
 *   2. chaque écran à segment dynamique (`[id]`) ne produit **jamais** de 500 —
 *      un 404 est une réponse correcte pour un identifiant inexistant ;
 *   3. chaque route d'API en `GET` ne produit **jamais** de 500 (401, 403, 405
 *      et 404 sont des réponses attendues selon la permission et les données).
 *
 * Un 500 est le seul échec bloquant : c'est le signe d'une erreur serveur non
 * gérée, exactement ce qu'une recette manuelle laisse passer.
 *
 * Prérequis : serveur démarré (`npm run dev` ou `npm run start`) et une base
 * contenant un administrateur.
 *
 * Usage :
 *   node scripts/verify-routes-e2e.js
 *   APP_URL=http://127.0.0.1:3100 node scripts/verify-routes-e2e.js
 */

const fs = require('node:fs');
const path = require('node:path');

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const USERNAME = process.env.APP_USER ?? 'admin';
const PASSWORD = process.env.APP_PASSWORD ?? 'Admin2026!';

const APP_DIR = path.join(process.cwd(), 'app');

/** Identifiants factices pour les segments dynamiques : on cherche un 404 propre. */
const PARAM_VALUES = { id: '1' };

const jar = new Map();

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function request(pathname, options = {}) {
  const response = await fetch(`${APP_URL}${pathname}`, {
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

  return response;
}

/** Liste récursive des chemins `page.tsx` et `route.ts`, convertis en URL. */
function discover() {
  const pages = [];
  const apis = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const relative = path.relative(APP_DIR, full).split(path.sep).join('/');
      if (relative.endsWith('page.tsx')) {
        pages.push('/' + relative.slice(0, -'/page.tsx'.length));
      } else if (relative.endsWith('route.ts')) {
        apis.push('/' + relative.slice(0, -'/route.ts'.length));
      }
    }
  }

  walk(APP_DIR);
  return { pages: pages.sort(), apis: apis.sort() };
}

/** Remplace `[id]` par une valeur réelle dans l'URL. */
function materialize(route) {
  return route.replace(/\[([^\]]+)\]/g, (_, name) => PARAM_VALUES[name] ?? '1');
}

let passes = 0;
let failures = 0;
const warnings = [];

function check(label, condition, detail = '') {
  if (condition) {
    passes += 1;
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

async function main() {
  console.log(`── Serveur ${APP_URL} ──`);
  const health = await request('/login');
  check('le serveur répond', health.status < 500, `HTTP ${health.status}`);

  console.log('\n── Connexion ──');
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  check('authentification', login.status === 200, `HTTP ${login.status}`);

  const { pages, apis } = discover();
  console.log(`\n── Écrans (${pages.length} découverts dans app/) ──`);

  for (const route of pages) {
    const dynamic = route.includes('[');
    const response = await request(materialize(route));
    const status = response.status;
    const label = `page ${route}`;

    if (dynamic) {
      check(`${label} (1)`, status < 500, `HTTP ${status}`);
      if (status !== 200) warnings.push(`${route} → HTTP ${status} avec un identifiant inexistant`);
    } else {
      check(label, status === 200 || status === 307 || status === 308, `HTTP ${status}`);
    }
  }

  console.log(`\n── API (${apis.length} routes découvertes dans app/api/) ──`);

  for (const route of apis) {
    const url = materialize(route);
    const response = await request(url);
    const status = response.status;
    check(`GET ${route}`, status < 500, `HTTP ${status}`);
    if (status >= 400) warnings.push(`GET ${route} → HTTP ${status}`);
  }

  if (warnings.length) {
    console.log('\n── Réponses non 200 (attendu : permission, données ou méthode) ──');
    for (const warning of warnings) console.log(`  · ${warning}`);
  }

  console.log(`\n${passes} test(s) réussi(s), ${failures} échec(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nÉchec : ${error.message}`);
  process.exit(1);
});
