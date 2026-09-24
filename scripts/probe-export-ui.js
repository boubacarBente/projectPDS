/**
 * Sonde de diagnostic : liste les boutons de la page et l'état du menu d'export.
 * Usage : `node scripts/probe-export-ui.js [/ventes/11]`
 */
const DEBUG_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:3000';

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
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await (await fetch(`${DEBUG_URL}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
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
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  await send(ws, 'Page.navigate', { url: `${APP_URL}${process.argv[2] ?? '/ventes/11'}` });
  await sleep(6000);

  console.log('URL courante :', await evaluate(ws, 'location.pathname'));

  const buttons = await evaluate(
    ws,
    `[...document.querySelectorAll('button')].map((b, i) => ({
       i,
       text: (b.textContent || '').trim().slice(0, 40),
       title: b.getAttribute('title') || '',
       cls: (b.className || '').slice(0, 60),
     }))`,
  );
  console.log(`\n${buttons.length} bouton(s) dans la page :`);
  for (const button of buttons) {
    console.log(`  [${button.i}] « ${button.text} »  title="${button.title}"`);
  }

  console.log('\n── Clic sur le déclencheur, puis inventaire du menu ──');
  const after = await evaluate(
    ws,
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const trigger = [...document.querySelectorAll('button')].find((b) =>
         /télécharger|exporter/i.test(b.textContent || ''));
       if (!trigger) return { trigger: null };
       trigger.click();
       await sleep(900);
       const items = [...document.querySelectorAll('button')]
         .filter((b) => b.getAttribute('title'))
         .map((b) => ({ title: b.getAttribute('title'), text: (b.textContent || '').trim(), visible: b.offsetParent !== null }));
       return { trigger: trigger.textContent.trim(), items };
     })()`,
  );

  console.log('déclencheur :', after.trigger);
  if (after.items) {
    console.log('entrées avec attribut title :');
    for (const item of after.items) {
      console.log(`  ${item.visible ? '●' : '○'} « ${item.text} » → title="${item.title}"`);
    }
  }

  console.log('\n── Erreurs éventuelles en console ──');
  const errors = await evaluate(
    ws,
    `window.__probeErrors ? window.__probeErrors.slice(-5) : '(pas de collecte)'`,
  );
  console.log(errors);

  ws.close();
}

main().catch((error) => {
  console.error(`Échec : ${error.message}`);
  process.exit(1);
});
