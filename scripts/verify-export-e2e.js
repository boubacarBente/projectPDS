/**
 * Vérification de bout en bout de l'export de facture, dans un vrai navigateur.
 *
 * Pourquoi ce script existe : `html2canvas@1.4.1` ne sait pas lire les couleurs
 * `oklch()` / `color-mix()` que produisent Tailwind 4 et DaisyUI 5, ce qui
 * faisait échouer l'export PDF/image (« L'image n'a pas pu être générée »). La
 * correction réécrit les couleurs en sRGB sur le clone du document. Une
 * correction de rendu ne se valide **que** dans un moteur de rendu : ce script
 * pilote donc un navigateur réel via le protocole DevTools.
 *
 * Prérequis :
 *   1. le serveur de développement tourne sur http://127.0.0.1:3000 ;
 *   2. un navigateur a été lancé avec `--remote-debugging-port=9222` ;
 *   3. la base contient un administrateur (identifiants ci-dessous).
 *
 * Usage : `node scripts/verify-export-e2e.js [chemin-de-facture]`
 *   ex.  `node scripts/verify-export-e2e.js /ventes/11`
 */

const DEBUG_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const USERNAME = process.env.APP_USER ?? 'admin';
const PASSWORD = process.env.APP_PASSWORD ?? 'Admin2026!';

const invoicePath = process.argv[2] ?? null;

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
      `Erreur dans la page : ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
  return result.result?.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // 1. Trouver l'onglet à piloter.
  const targets = await (await fetch(`${DEBUG_URL}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('Aucun onglet trouvé : le navigateur est-il lancé avec --remote-debugging-port=9222 ?');

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
    ws.addEventListener('error', () => reject(new Error('Connexion au navigateur impossible')), { once: true });
  });

  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // 2. Ouvrir la page de connexion puis s'authentifier.
  await send(ws, 'Page.navigate', { url: `${APP_URL}/login` });
  await sleep(3500);

  const login = await evaluate(
    ws,
    `(async () => {
       const res = await fetch('/api/auth/login', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ username: ${JSON.stringify(USERNAME)}, password: ${JSON.stringify(PASSWORD)} }),
       });
       return res.status + ' ' + (await res.text()).slice(0, 80);
     })()`,
  );
  console.log(`Connexion : ${login}`);
  if (!login.startsWith('200')) throw new Error('Connexion refusée : vérifiez les identifiants ou la base.');

  // 3. Aller sur une facture.
  let target = invoicePath;
  if (!target) {
    // On prend la première vente de la liste.
    const list = await evaluate(
      ws,
      `(async () => {
         const res = await fetch('/api/ventes?limit=1', { cache: 'no-store' });
         const data = await res.json();
         return data?.data?.[0]?.id ?? null;
       })()`,
    );
    if (!list) throw new Error('Aucune vente en base : créez-en une ou passez un chemin en argument.');
    target = `/ventes/${list}`;
  }

  await send(ws, 'Page.navigate', { url: `${APP_URL}${target}` });
  await sleep(5000);

  const ready = await evaluate(
    ws,
    `(() => {
       const doc = document.getElementById('vente-invoice-document') || document.querySelector('[id$="-document"]');
       return doc ? doc.id : null;
     })()`,
  );
  console.log(`Document détecté : ${ready ?? 'AUCUN'}`);
  if (!ready) throw new Error("Le document de facture n'est pas présent dans la page.");

  // 5. Vérifier que la page contient bien des couleurs modernes — c'est la
  //    raison pour laquelle capturer la page affichée échouait, et donc la
  //    justification de l'approche par document HTML autonome.
  const modernColors = await evaluate(
    ws,
    `(() => {
       const root = document.getElementById(${JSON.stringify(ready)});
       const all = [root, ...root.querySelectorAll('*')];
       const found = new Set();
       for (const el of all) {
         const cs = getComputedStyle(el);
         for (const prop of ['color','background-color','border-top-color','border-bottom-color','background-image','box-shadow']) {
           const v = cs.getPropertyValue(prop);
           const m = v && v.match(/(oklch|oklab|lch|lab|color-mix)\\(/i);
           if (m) found.add(m[1].toLowerCase());
         }
       }
       return [...found];
     })()`,
  );
  console.log(
    `Couleurs modernes dans la page : ${modernColors.join(', ') || 'aucune'}` +
      (modernColors.length ? '  → la capture directe de la page est impossible' : ''),
  );

  /**
   * 6. Déclencher réellement les exports.
   *
   * Deux précautions apprises à l'exécution :
   *  - le menu est un menu déroulant : on ouvre d'abord le déclencheur, puis on
   *    clique l'entrée par son `title` (plus fiable que le texte affiché) ;
   *  - les toasts de `react-toastify` **disparaissent après ~4 s** : on les
   *    surveille en boucle au lieu de lire une seule fois après coup, sinon on
   *    conclut à tort qu'aucun message n'a été affiché.
   */
  const runExport = async (itemTitle) =>
    evaluate(
      ws,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const byTitle = (title) =>
           [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === title);

         const trigger = [...document.querySelectorAll('button')].find((b) =>
           /télécharger|exporter/i.test(b.textContent || ''),
         );
         if (!trigger) return { ok: false, reason: "déclencheur du menu d'export introuvable" };
         trigger.click();
         await sleep(800);

         const item = byTitle(${JSON.stringify(itemTitle)});
         if (!item) return { ok: false, reason: 'entrée « ${itemTitle} » introuvable dans le menu' };
         item.click();

         // Surveillance des messages : on garde le premier vu, avec sa nature.
         const seen = [];
         const started = Date.now();
         while (Date.now() - started < 40000) {
           for (const toast of document.querySelectorAll('.Toastify__toast')) {
             const text = (toast.textContent || '').trim();
             if (!text) continue;
             const error = /error/i.test(toast.className);
             if (!seen.some((s) => s.text === text)) seen.push({ text, error });
           }
           if (seen.length > 0) break;
           await sleep(250);
         }

         return { ok: true, toasts: seen, elapsedMs: Date.now() - started };
       })()`,
    );

  const results = [];
  for (const itemTitle of ['Exporter en image (PNG)', 'Exporter en PDF']) {
    // On recharge la page avant chaque export : sans cela, le toast du test
    // précédent peut encore être affiché et fausser la mesure.
    await send(ws, 'Page.navigate', { url: `${APP_URL}${target}` });
    await sleep(5000);

    console.log(`\n── ${itemTitle} ──`);
    const outcome = await runExport(itemTitle);

    if (!outcome.ok) {
      console.log(`  ✗ ${outcome.reason}`);
      results.push(false);
      continue;
    }

    if (!outcome.toasts?.length) {
      console.log(
        `  ✗ aucun message en ${outcome.elapsedMs ?? '?'} ms — l’export ne s’est pas terminé`,
      );
      results.push(false);
      continue;
    }

    for (const toast of outcome.toasts) {
      console.log(`  ${toast.error ? '✗' : '✓'} ${toast.text}  (en ${outcome.elapsedMs} ms)`);
    }

    const failed = outcome.toasts.some((t) => t.error);
    const succeeded = outcome.toasts.some((t) => !t.error && /généré/i.test(t.text));
    results.push(!failed && succeeded);
  }

  const success = results.every(Boolean);
  console.log(success ? '\nEXPORT VALIDÉ' : '\nEXPORT NON VALIDÉ');

  ws.close();
  process.exit(success ? 0 : 1);
}

main().catch((error) => {
  console.error(`Échec : ${error.message}`);
  process.exit(1);
});
