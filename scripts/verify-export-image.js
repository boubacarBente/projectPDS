/*
 * Exporte en **image** des documents réels (facture, reçu, bon d'achat, devis)
 * par le vrai parcours utilisateur — bouton « Télécharger » puis « Image » — et
 * enregistre les PNG produits, pour les regarder.
 *
 * Pourquoi : un défaut de rendu d'export (texte décalé dans une pastille,
 * couleur illisible, bande blanche…) ne se voit que dans le fichier produit par
 * `html2canvas`, pas à l'écran (AGENTS.md, invariant 5). Constaté en recette :
 * le badge « Partiellement payée » débordait sous sa pastille dans l'image.
 *
 * Usage :
 *   APP_URL=http://127.0.0.1:3100 APP_PASSWORD=… OUT=./exports \
 *     node scripts/verify-export-image.js /ventes/12 /recus/3 /achats/4
 *
 * Variables : APP_URL, APP_USER (défaut admin), APP_PASSWORD, OUT (dossier des
 * PNG, défaut ./tmp-exports), CHROME, CDP_PORT (défaut 9334).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const USERNAME = process.env.APP_USER ?? 'admin';
const PASSWORD = process.env.APP_PASSWORD ?? '';
const PORT = Number(process.env.CDP_PORT ?? 9334);
const OUT = path.resolve(process.env.OUT ?? 'tmp-exports');
const CHROME =
  process.env.CHROME ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((candidate) => fs.existsSync(candidate));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 1;
const pending = new Map();

function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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

async function main() {
  if (!CHROME) throw new Error('Navigateur introuvable : renseignez CHROME.');
  if (!PASSWORD) throw new Error('Renseignez APP_PASSWORD.');
  const documents = process.argv.slice(2);
  if (documents.length === 0) throw new Error('Indiquez au moins un document, ex. /ventes/12');
  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-export-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1366,900',
      // Conteneur Linux lancé en root (recette en ligne) : sans cela Chrome refuse de démarrer.
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let failures = 0;
  try {
    let version;
    for (let i = 0; i < 50 && !version; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      } catch {
        await sleep(200);
      }
    }
    if (!version) throw new Error('Chrome ne répond pas.');
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

    const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
    const page = (method, params) => send(ws, method, params, sessionId);
    const evaluate = async (expression) => {
      const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result?.value;
    };
    await page('Page.enable');
    await page('Runtime.enable');
    // Les téléchargements partent dans OUT (navigateur entier).
    await send(ws, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT });

    await page('Page.navigate', { url: `${APP_URL}/login` });
    await sleep(1500);
    const login = await evaluate(
      `fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(${JSON.stringify({ username: USERNAME, password: PASSWORD })}) }).then((r) => r.status)`,
    );
    if (login !== 200) throw new Error(`Connexion refusée (${login})`);

    for (const doc of documents) {
      const before = new Set(fs.readdirSync(OUT));
      await page('Page.navigate', { url: `${APP_URL}${doc}` });
      // Attendre que la page soit chargée (bouton d'export présent).
      let ready = false;
      for (let i = 0; i < 60 && !ready; i += 1) {
        await sleep(500);
        ready = await evaluate(`Boolean([...document.querySelectorAll('button')].find((b) => /Télécharger|Exporter/.test(b.getAttribute('aria-label') || b.textContent || '')))`);
      }
      if (!ready) {
        failures += 1;
        console.log(`[ÉCHEC] ${doc} — bouton d'export introuvable`);
        continue;
      }
      // Données encore en chargement (squelettes) : l'export serait ignoré (document vide).
      for (let i = 0; i < 60; i += 1) {
        const busy = await evaluate(`document.querySelectorAll('.animate-pulse, .loading').length`);
        if (busy === 0) break;
        await sleep(500);
      }
      await sleep(500);
      await evaluate(`[...document.querySelectorAll('button')].find((b) => /Télécharger|Exporter/.test(b.getAttribute('aria-label') || b.textContent || '')).click()`);
      await sleep(400);
      const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Image'); if (b) b.click(); return Boolean(b); })()`);
      if (!clicked) {
        failures += 1;
        console.log(`[ÉCHEC] ${doc} — entrée « Image » introuvable`);
        continue;
      }
      let file = null;
      for (let i = 0; i < 60 && !file; i += 1) {
        await sleep(500);
        file = fs.readdirSync(OUT).find((f) => !before.has(f) && f.endsWith('.png'));
      }
      if (!file) {
        failures += 1;
        console.log(`[ÉCHEC] ${doc} — aucune image produite`);
        continue;
      }
      const size = fs.statSync(path.join(OUT, file)).size;
      console.log(`[OK   ] ${doc} → ${path.join(OUT, file)} (${Math.round(size / 1024)} Ko)`);
    }
    ws.close();
  } finally {
    chrome.kill();
    await sleep(500);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* profil verrouillé un instant */
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[verify:export-image] ${error.message}`);
  process.exit(1);
});
