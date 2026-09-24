/**
 * Moteur de restauration du scroll pour l'App Router de Next 16.
 *
 * ── Contraintes non négociables ─────────────────────────────────────────────
 * Ces règles découlent de la lecture de
 * `node_modules/next/dist/client/components/app-router.js` :
 *
 * 1. LECTURE SEULE sur l'historique.
 *    Next patche déjà `history.pushState` / `history.replaceState`
 *    (app-router.js:233-307) et force `window.location.reload()` quand
 *    `event.state.__NA` est absent au popstate (app-router.js:290-292).
 *    Créer une entrée d'historique nous-mêmes déclencherait donc un
 *    rechargement complet de l'application au retour arrière.
 *    → Ce module n'écrit JAMAIS dans `history`.
 *
 * 2. `preserveCustomHistoryState` vaut `false` sur une navigation normale
 *    (segment-cache/navigation.js:240 et :351), donc Next efface
 *    délibérément le state custom des entrées. Y stocker une clé est vain.
 *
 * 3. Déclenchement exclusivement sur `popstate` (back/forward).
 *    Aucun drapeau « est-ce un retour ? » : une navigation avant (push) ne
 *    produit pas de popstate, elle ne restaure donc jamais rien. L'invariant
 *    est structurel, pas heuristique. Corollaire : un F5 ne restaure rien,
 *    sans avoir besoin d'un drapeau « première navigation ».
 *
 * ── Clé d'entrée ────────────────────────────────────────────────────────────
 * Chromium (Electron, Chrome) expose `navigation.currentEntry.key` : une clé
 * unique par entrée d'historique. Deux visites successives de `/ventes` gardent
 * donc chacune leur position — un index par chemin, lui, les confondrait.
 * Firefox/Safari n'ont pas cette API : repli sur `pathname + search`, où seule
 * la dernière visite d'une URL est mémorisée.
 *
 * ── Limite connue ───────────────────────────────────────────────────────────
 * La restauration est déclenchée par le re-render de route (signal React), ce
 * qui évite de scroller sur le contenu de la page sortante. Deux entrées
 * d'historique partageant exactement la même URL (même pathname ET même search)
 * ne produisent pas de re-render et ne sont donc pas restaurées. Impossible
 * aujourd'hui dans l'application (aucune query string dans les URLs de page).
 * À revisiter si les filtres de liste passent un jour dans l'URL.
 */

export type ScrollSnapshot = {
  /** Position verticale, en pixels. */
  y: number;
  /** URL (`pathname` + `search`) sur laquelle la position a été relevée. */
  url: string;
  /** Horodatage, utilisé pour l'éviction LRU. */
  at: number;
};

type ScrollStore = Record<string, ScrollSnapshot>;

type NavigationApiLike = {
  currentEntry?: { key?: string; index?: number } | null;
};

/** Clé de stockage dans `sessionStorage`. */
const STORE_KEY = '__gaz_scroll_v1__';

/** Nombre maximum d'entrées conservées (éviction LRU sur `at`). */
const MAX_ENTRIES = 30;

/**
 * Durée maximale d'attente pour que le document devienne assez haut.
 * Les données sont servies en local (localhost en Electron) : si la cible
 * n'est pas atteignable après ce délai, c'est que le contenu est réellement
 * plus court (données réduites, entité supprimée, page vide) et non qu'il
 * charge encore.
 *
 * Volontairement PAS de règle « hauteur stable pendant N frames » ici : un
 * écran de chargement court et stable serait pris pour un contenu définitif et
 * plaquerait la page en haut — précisément le bug que ce moteur corrige.
 */
const REACH_TIMEOUT_MS = 700;

/**
 * Fenêtre de surveillance après application de la position.
 *
 * Plusieurs pages enchaînent plusieurs `fetch` (ex. `clients` charge la liste,
 * les stats et les types) et les graphiques Chart.js modifient la hauteur après
 * coup. Tant que la hauteur bouge dans cette fenêtre, la position est
 * réappliquée ; on ne relâche qu'une fois la mise en page stabilisée.
 */
const SETTLE_WINDOW_MS = 400;

/** Délai d'écriture du store dans `sessionStorage`. */
const PERSIST_DEBOUNCE_MS = 150;

/** Routes sur lesquelles on n'enregistre ni ne restaure quoi que ce soit. */
const EXCLUDED_PATHS = new Set(['/login', '/ventes/nouvelle']);

/** Événements qui signifient « l'utilisateur reprend la main ». */
const USER_INPUT_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;

// ── État du module ──────────────────────────────────────────────────────────

let initialized = false;

/** Store en mémoire : évite un JSON.parse à chaque frame de scroll. */
let memStore: ScrollStore | null = null;

/** Vrai pendant la restauration : empêche d'écraser le snapshot avec nos propres scrolls. */
let restoring = false;

// `number` et non `ReturnType<typeof setTimeout>` : avec @types/node installé,
// ce dernier résout vers le type Node (Timeout) alors que `window.setTimeout`
// renvoie bien un number côté DOM.
let persistTimer: number | null = null;

/** Restauration en attente du re-render de route. */
let pending: { y: number; url: string; at: number } | null = null;

/** Âge maximum d'une restauration en attente avant abandon (ms). */
const PENDING_MAX_AGE_MS = 1000;

/** Horodatage du dernier `popstate`, lu par `isTraverseNavigation()`. */
let traverseAt = 0;

/** Fenêtre pendant laquelle une navigation est considérée comme un retour/avance. */
const TRAVERSE_WINDOW_MS = 600;

// ── Utilitaires ─────────────────────────────────────────────────────────────

function getNavigationApi(): NavigationApiLike | null {
  if (typeof window === 'undefined') return null;
  const nav = (window as Window & { navigation?: NavigationApiLike }).navigation;
  return nav ?? null;
}

/** URL courante, au format `pathname + search`. */
function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Clé de l'entrée d'historique courante.
 * `n:` = clé native de l'API Navigation, `u:` = repli sur l'URL.
 *
 * Exposée pour que `lib/view-state.ts` indexe les états de vue sur la même
 * maille : une position de scroll et l'état de liste qui l'a produite doivent
 * appartenir à la même entrée d'historique.
 */
export function currentEntryKey(): string {
  const nav = getNavigationApi();
  const key = nav?.currentEntry?.key;
  if (typeof key === 'string' && key.length > 0) return `n:${key}`;
  return `u:${currentUrl()}`;
}

/**
 * Vrai si l'API Navigation est disponible (Chromium : Electron, Chrome).
 *
 * Sa présence change la règle de restauration de l'état de vue : avec une clé
 * unique par entrée, l'existence d'un snapshot suffit à prouver qu'on revient
 * sur une entrée déjà visitée. Sans elle (Firefox/Safari), la clé de repli est
 * l'URL, qu'une nouvelle navigation avant réutilise — il faut alors exiger en
 * plus une traversée d'historique.
 */
export function hasNavigationApi(): boolean {
  return getNavigationApi() !== null;
}

/**
 * Vrai si la navigation en cours est une traversée d'historique (retour/avance).
 *
 * Repose sur une fenêtre temporelle après `popstate` plutôt que sur un drapeau
 * consommé : cela évite toute dépendance à l'ordre entre l'effet de layout qui
 * réhydrate une page et l'effet du layout racine qui signale le rendu de route.
 * Utilisé uniquement en l'absence d'API Navigation.
 */
export function isTraverseNavigation(): boolean {
  return traverseAt > 0 && performance.now() - traverseAt < TRAVERSE_WINDOW_MS;
}

function isExcluded(url: string): boolean {
  const path = url.split('?')[0];
  return EXCLUDED_PATHS.has(path);
}

/**
 * Indique s'il existe une entrée précédente dans l'historique.
 *
 * Sert au bouton retour visible : l'application Electron est une BrowserWindow
 * nue sans chrome de navigateur (`electron/main.js` : `setMenuBarVisibility(false)`,
 * aucun toolbar), donc l'utilisateur n'a aucun bouton retour natif.
 *
 * SSR-safe : renvoie `false` hors navigateur.
 */
export function canGoBack(): boolean {
  if (typeof window === 'undefined') return false;

  // Chromium (Electron, Chrome) expose l'index dans l'historique de session.
  const index = getNavigationApi()?.currentEntry?.index;
  if (typeof index === 'number') return index > 0;

  // Firefox/Safari : pas d'index exposé. `history.length` inclut les entrées
  // créées par pushState dans ce document ; il vaut 1 au premier chargement.
  return window.history.length > 1;
}

// ── Persistance ─────────────────────────────────────────────────────────────

function prune(store: ScrollStore): ScrollStore {
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return store;

  keys.sort((a, b) => (store[a]?.at ?? 0) - (store[b]?.at ?? 0));

  const next: ScrollStore = {};
  for (let i = keys.length - MAX_ENTRIES; i < keys.length; i += 1) {
    next[keys[i]] = store[keys[i]];
  }
  memStore = next;
  return next;
}

function loadStore(): ScrollStore {
  if (memStore) return memStore;

  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    memStore =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as ScrollStore)
        : {};
  } catch {
    // Stockage indisponible ou corrompu : la mémoire suffit pour la session.
    memStore = {};
  }

  return memStore;
}

function persistStore(): void {
  try {
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(prune(loadStore())));
  } catch {
    // Quota dépassé ou stockage désactivé : sans gravité, on garde la mémoire.
  }
}

/**
 * Relève la position courante et l'affecte à l'entrée d'historique active.
 *
 * Le relevé est **synchrone** avec l'événement `scroll`, volontairement.
 * Le différer via `requestAnimationFrame` ouvrirait une course : si un
 * `pushState` survient entre l'événement et le callback (clic dans la même
 * frame qu'un scroll), `currentEntryKey()` désignerait déjà la page entrante et
 * on enregistrerait la position de la page sortante sous la mauvaise clé — donc
 * une position erronée restaurée au retour suivant.
 *
 * `loadStore()` étant mémoïsé, le coût par événement se limite à une écriture
 * d'objet ; seule la sérialisation est différée.
 */
function captureNow(): void {
  if (restoring) return;
  if (window.location.hash) return;

  const url = currentUrl();
  if (isExcluded(url)) return;

  loadStore()[currentEntryKey()] = {
    y: Math.round(window.scrollY),
    url,
    at: Date.now(),
  };
}

/** Relevé immédiat + écriture différée dans `sessionStorage`. */
function scheduleCapture(): void {
  captureNow();

  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistStore();
  }, PERSIST_DEBOUNCE_MS);
}

/** Relevé + écriture immédiate (déchargement de la page). */
function flushCapture(): void {
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  captureNow();
  persistStore();
}

// ── Restauration ────────────────────────────────────────────────────────────

function maxScrollY(): number {
  return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
}

function applyScroll(y: number): void {
  window.scrollTo(0, y);
}

/**
 * Applique la position cible dès que le document est assez haut pour l'atteindre,
 * puis surveille la mise en page le temps qu'elle se stabilise.
 *
 * Le point clé : sur ces pages, le contenu arrive par un ou plusieurs `fetch`
 * déclenchés dans des `useEffect`. Au moment du re-render de route, le document
 * fait souvent la hauteur d'un écran. Un `scrollTo` immédiat serait donc
 * silencieusement clampé à 0 — c'est exactement le bug que ce moteur corrige.
 */
function runRestore(targetY: number): void {
  restoring = true;

  const startedAt = performance.now();
  let settled = false;
  let settledAt = 0;
  let settledHeight = -1;
  let cancelled = false;
  let rafId = 0;

  const onUserInput = () => {
    cancelled = true;
  };

  for (const eventName of USER_INPUT_EVENTS) {
    window.addEventListener(eventName, onUserInput, { passive: true });
  }

  const release = () => {
    for (const eventName of USER_INPUT_EVENTS) {
      window.removeEventListener(eventName, onUserInput);
    }
    restoring = false;
  };

  const apply = (y: number) => {
    // On mémorise la hauteur au moment de l'application : c'est elle qui sert
    // de référence pour détecter les changements de mise en page ultérieurs.
    settledHeight = document.documentElement.scrollHeight;
    applyScroll(Math.min(y, maxScrollY()));
  };

  const tick = () => {
    if (cancelled) {
      release();
      return;
    }

    const now = performance.now();
    const height = document.documentElement.scrollHeight;

    if (!settled) {
      if (height >= targetY + window.innerHeight) {
        // Le document est assez haut : on applique à la première frame utile.
        settled = true;
        settledAt = now;
        apply(targetY);
      } else if (now - startedAt > REACH_TIMEOUT_MS) {
        // Le contenu a fini de charger sans jamais devenir assez haut : la
        // cible est hors d'atteinte. On clampe plutôt que de rester bloqué.
        settled = true;
        settledAt = now;
        apply(targetY);
      }
    } else if (height !== settledHeight) {
      // La mise en page a bougé après l'application (fetch suivant, graphique,
      // image) : on réapplique la cible sur la nouvelle hauteur.
      apply(targetY);
    } else if (now - settledAt > SETTLE_WINDOW_MS) {
      release();
      return;
    }

    rafId = window.requestAnimationFrame(tick);
  };

  rafId = window.requestAnimationFrame(tick);

  // Filet : si la boucle ne s'arrête jamais d'elle-même, on relâche.
  window.setTimeout(() => {
    if (restoring) {
      window.cancelAnimationFrame(rafId);
      release();
    }
  }, REACH_TIMEOUT_MS + SETTLE_WINDOW_MS + 500);
}

/**
 * Démarre la restauration en attente. Appelée par le composant une fois la
 * nouvelle route rendue : à cet instant le DOM de la page entrante est en
 * place, donc on ne risque plus de scroller sur le contenu de la page sortante.
 */
export function notifyRouteRendered(): void {
  const job = pending;
  if (!job) return;
  pending = null;

  // Restauration obsolète (navigation concurrente, rendu anormalement long).
  if (Date.now() - job.at > PENDING_MAX_AGE_MS) return;

  // Une navigation concurrente a pu changer la cible entre-temps.
  if (currentUrl() !== job.url) return;
  if (window.location.hash) return;

  runRestore(job.y);
}

function queueRestore(y: number, url: string): void {
  pending = { y, url, at: Date.now() };
}

function handlePopState(): void {
  traverseAt = performance.now();

  // Le navigateur gère nativement le scroll vers une ancre : on ne s'en mêle pas.
  if (window.location.hash) return;

  const url = currentUrl();
  if (isExcluded(url)) return;

  const snapshot = loadStore()[currentEntryKey()];

  // Pas de snapshot : soit l'entrée n'a jamais été scrollée (donc y valait 0),
  // soit on ne l'a jamais visitée. Dans les deux cas, le haut de page est juste.
  const y = snapshot && snapshot.url === url ? snapshot.y : 0;

  queueRestore(y, url);
}

/**
 * Restauration depuis le cache mémoire du navigateur (bfcache).
 *
 * Couvre le bouton « Recharger » de la sidebar : après `window.location.reload()`,
 * un retour arrière peut restaurer le document précédent depuis le bfcache. Comme
 * on a mis `history.scrollRestoration = 'manual'`, le navigateur ne repositionne
 * rien tout seul — on le fait, mais uniquement si un snapshot existe.
 */
function handlePageShow(event: PageTransitionEvent): void {
  if (!event.persisted) return;
  if (window.location.hash) return;

  const url = currentUrl();
  if (isExcluded(url)) return;

  const snapshot = loadStore()[currentEntryKey()];
  if (!snapshot || snapshot.url !== url) return;

  runRestore(snapshot.y);
}

// ── Cycle de vie ────────────────────────────────────────────────────────────

/**
 * Initialise le moteur et retourne sa fonction de nettoyage.
 * Idempotent : un second appel ne réinstalle rien.
 */
export function initScrollEngine(): () => void {
  if (typeof window === 'undefined') return () => {};

  if (initialized) return disposeScrollEngine;
  initialized = true;

  // Le navigateur ne doit pas restaurer de son côté : on prend la main.
  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual';
  }

  window.addEventListener('scroll', scheduleCapture, { passive: true });
  window.addEventListener('popstate', handlePopState);
  window.addEventListener('pageshow', handlePageShow as EventListener);
  window.addEventListener('pagehide', flushCapture);

  return disposeScrollEngine;
}

function disposeScrollEngine(): void {
  if (!initialized) return;
  initialized = false;

  window.removeEventListener('scroll', scheduleCapture);
  window.removeEventListener('popstate', handlePopState);
  window.removeEventListener('pageshow', handlePageShow as EventListener);
  window.removeEventListener('pagehide', flushCapture);

  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }

  pending = null;
  restoring = false;
  flushCapture();
}
