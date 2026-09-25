# Conventions de développement — Planète Déco

> Document **opérationnel** destiné à tout développeur (ou agent) qui ajoute un
> module. Il traduit en règles concrètes le contrat de conception `README.md`.
> **En cas de contradiction, le `README.md` fait foi.**

---

## 1. Le projet en une page

Application de gestion commerciale **hors ligne** pour Planète Déco Sarlu
(filiale Meubles, Guinée, devise **GNF**).

- **Next.js 16** (App Router) + **React 19** + **Tailwind 4** + **DaisyUI 5**
- **SQLite** locale via `@libsql/client/sqlite3` + **Drizzle ORM** — c'est la
  **source de vérité**, aucune connexion Internet n'est requise
- **Electron 44** pour la version bureau Windows installable
- Synchronisation PostgreSQL **optionnelle et désactivée par défaut**
- Interface **intégralement en français** ; code, tables et colonnes en **anglais**

---

## 2. Structure et propriété des fichiers

```
app/
  api/<domaine>/route.ts          Route Handlers (minces)
  api/<domaine>/[id]/route.ts
  <domaine>/page.tsx              Page (composant client)
components/
  <domaine>/                      Composants propres au domaine
  design-system.tsx               Bibliothèque partagée (ne pas dupliquer)
lib/
  <domaine>.ts                    TOUTE la logique métier
db/
  schema.ts                       Schéma (30 tables métier + 5 sync)
```

**Règle de propriété** : un module possède `lib/<module>.ts`,
`app/api/<module>/**`, `app/<module>/**`, `components/<module>/**`.
Il **ne modifie jamais** un fichier partagé (`lib/api.ts`, `db/schema.ts`,
`components/design-system.tsx`, `lib/permissions.ts`…) — il demande.

---

## 3. Règle d'or : toute écriture passe par `lib/`

Un Route Handler reste **mince** : parsing → permission → appel `lib/` → réponse.
Jamais de requête Drizzle directement dans un Route Handler.

```ts
// ✅ app/api/clients/route.ts
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('customers.create');   // 1. permission
    const body = await readJson<any>(request);              // 2. parsing
    const customer = await createCustomer({ ... });         // 3. logique dans lib/
    await writeAudit({ user, action: 'create', entity: 'customer', entityId: customer.id });
    return ok(customer, 201);                               // 4. réponse
  } catch (error) {
    return fail(error);                                     // 5. erreur traduite
  }
}
```

Un handler fait **toujours** ces 5 étapes, dans cet ordre. `fail()` traduit
`UnauthorizedError` (401), `ForbiddenError` (403), `ValidationError` (400),
`NotFoundError` (404), `ConflictError` (409) et `InsufficientStockError` (400).

---

## 4. Le patron de `lib/<module>.ts`

Reprendre **exactement** la forme de `lib/customers.ts` :

- des **types exportés** explicites (`CustomerRow`, `CustomerInput`) ;
- une fonction `list<Module>s({ search, page, limit, … })` qui renvoie
  `{ data, total, page, limit, totalPages }` ;
- `get<Module>(id)` qui renvoie la ligne enrichie **ou `null`** ;
- `create<Module>(input)`, `update<Module>(id, patch)` ;
- `deactivate<Module>(id)` — **jamais** `DELETE` (voir §7) ;
- des agrégats **calculés**, jamais stockés (§6) ;
- un `enqueueSyncWrite(table, syncId, operation, payload)` après chaque écriture.

### Enveloppe paginée — format imposé

```ts
{ data: T[], total: number, page: number, limit: number, totalPages: number }
```

### Tri des listes — la dernière insertion d'abord

Règle de produit : **sans tri demandé, une liste montre ce qui vient d'être
enregistré en premier** (le client qu'on vient de créer, la vente qu'on vient
de saisir, le produit qu'on vient d'ajouter).

- L'ordre par défaut est `created_at DESC, id DESC` — l'`id` départage deux
  lignes créées dans la même seconde, sinon l'ordre change d'un affichage à
  l'autre. Utilitaire commun : `lib/list-sort.ts`.
- Les autres tris (`name` alphabétique, `balance` décroissant, `promised` =
  planning d'atelier) sont **explicites** : `?sort=name`, `?sort=balance`,
  `?sort=promised`. Une valeur inconnue retombe sur `recent`, jamais sur une
  erreur 400.
- ⚠️ **Le tri se fait en SQL, côté serveur.** Trier dans la page ne trie que la
  page courante : sur trois pages de clients, « solde décroissant » afficherait
  le plus gros solde de la page 1 au lieu de celui de la base. C'est le défaut
  qui existait sur `/clients` — corrigé, et à ne pas réintroduire.
- Exception assumée : les listes qui alimentent un **menu déroulant de noms**
  (filtre « utilisateur » de l'historique) restent alphabétiques.

---

## 5. Le patron de page (`app/<module>/page.tsx`)

`'use client'`, et **dans cet ordre** :

1. `PageHeader` (eyebrow, titre, description, bouton d'action principal)
2. Cartes de synthèse (`StatCardDelta` ou `Card` + `MiniStat`)
3. `DataToolbar` (recherche + filtres + export)
4. `ResponsiveTable` pour la liste — **obligatoire**, jamais un `<table>` nu
5. `Pagination`
6. Les modales (`Modal` / `ConfirmDialog`), une par état booléen

### Les 5 états obligatoires — une page sans eux n'est PAS terminée

| État | Ce qu'on rend |
|---|---|
| **Chargement** | `SkeletonTable` / `SkeletonCards` — jamais un spinner plein écran |
| **Vide** | `EmptyState` avec icône + phrase + **action** (« Créer le premier client ») |
| **Erreur** | `ErrorState` avec bouton « Réessayer » — jamais un écran blanc |
| **Nominal** | `ResponsiveTable` + données |
| **Feedback** | `toast.success` / `toast.error` (react-toastify) |

### Restauration d'état au retour arrière — obligatoire sur toute liste

```tsx
const rehydrated = useViewStateRehydration<{ search: string; page: number }>(
  'clients',
  (saved) => {
    if (saved.search !== undefined) setSearch(saved.search);
    if (saved.page) setPage(saved.page);
  },
);

useEffect(() => {
  if (!rehydrated) return;                    // ⚠️ gater le premier fetch
  void load();
}, [rehydrated, search, page, filter]);

useEffect(() => {
  if (!rehydrated) return;
  writeViewState('clients', { search, page, filter });
}, [rehydrated, search, page, filter]);
```

Sans le gate `rehydrated`, la page charge la page 1 puis recharge la page 3.

### Recherche : débounce + `AbortController`

```tsx
useEffect(() => {
  const timer = setTimeout(() => { void load(); }, 300);
  return () => clearTimeout(timer);
}, [search]);
```
Toute requête annulable doit l'être (`AbortController`) — pas de « réponse du
passé » qui écrase une saisie plus récente.

---

## 6. Base de données — règles non négociables

1. **Nommage** : tables au pluriel, colonnes `snake_case`, en anglais.
2. **Dates** : `date` = `YYYY-MM-DD` (date métier, **le seul champ filtré**) ;
   `created_at` = horodatage, traçabilité seule. Ne jamais mélanger les deux :
   `BETWEEN '2026-01-15' AND '2026-01-15'` sur un horodatage renvoie **zéro ligne**.
3. **Montants et quantités en `real`** — le m² et le kg ne sont pas entiers.
4. **Invariant de stock** : `products.stock` = somme algébrique des
   `stock_movements`. Un `adjustment` porte un **écart signé**, jamais une valeur
   absolue. Toute correction passe par `adjustStock()`.
5. **Instantanés** : les lignes de facture figent `product_code`,
   `product_name`, `unit` — une facture de 2026 doit rester imprimable même si le
   produit est renommé.
6. **Aucun total stocké** : soldes, créances, marges, bénéfices sont **calculés à
   la lecture** depuis les factures, paiements et dépenses.
7. **4 colonnes de synchronisation** sur toute table métier : `sync_id` (UUID),
   `updated_at`, `deleted_at`, `origin_device_id`.

---

## 7. Interdictions absolues

| ❌ Interdit | ✅ À la place |
|---|---|
| `window.confirm`, `alert`, `prompt` | `ConfirmDialog` / `Modal` |
| Suppression physique (`DELETE`) sur une table synchronisée | `deactivatedAt` / `is_active` ou `status = 'cancelled'` |
| Couleur Tailwind figée (`bg-sky-700`, `text-blue-600`) | `btn-primary`, `text-primary`, `bg-base-100`, `border-base-200` |
| `<table>` écrit à la main dans une page | `ResponsiveTable` |
| `overflow-x-auto` sur une page | `ResponsiveTable` (cartes sur mobile) |
| Secret ou identifiant en dur | Base de données + `settings` |
| Requête Drizzle dans un Route Handler | Fonction de `lib/` |
| Modification manuelle de la base | `db/schema.ts` + `npm run db:generate` |
| Montant affiché sans `tabular-nums` | `MoneyText` / classe `tabular` |
| Modale pilotée par une chaîne (« mode ») | Un état booléen par modale |
| Supprimer un encaissement sans avertir | `status = 'cancelled'` + motif + audit |

---

## 8. Design system — composants disponibles

`components/design-system.tsx` :

| Composant | Usage |
|---|---|
| `MoneyText` | **Tout** montant (`value`, `currency`, `colored`, `bold`) |
| `QuantityText` | Toute quantité (`value`, `unit`) |
| `StatusBadge` | Statut de paiement (`kind="payment"`) ou de document (`kind="invoice"`) |
| `Badge` | Libellé libre avec `tone` |
| `EmptyState` | État vide, **avec action** |
| `ErrorState` | État d'erreur, avec « Réessayer » |
| `Skeleton` / `SkeletonCards` / `SkeletonTable` | État de chargement |
| `PageSection` | Section titrée avec actions |
| `FormField` | label + aide + erreur |
| `InfoRow` | Ligne « libellé : valeur » |
| `StatCardDelta` | Valeur + variation vs période précédente |
| `StageTracker` | Avancement (`{ key, label }[]` + `current`) |
| `Card`, `MiniStat` | Conteneurs |

Autres : `Modal` (`components/modal.tsx`), `ConfirmDialog`,
`RoleGate` + `usePermission`, `DataToolbar` + `ToolbarButton`,
`PageHeader`, `BackButton`, `ExportDropdown`, `DatePicker`, `SearchBar`,
`FilterSelect`, `Pagination`, `ResponsiveTable`, `SurfaceCard`, `MetricCard`,
`ColorField` (nuancier natif + code hexadécimal éditable),
`PasswordInput` (mot de passe + icône afficher/masquer).

> **Tout mot de passe passe par `PasswordInput`.** L'icône « œil » vivait
> uniquement sur l'écran de connexion ; ailleurs les champs étaient soit
> définitifs, soit révélés par une case à cocher **globale** qui dévoilait les
> deux champs d'un coup. `PasswordInput` porte son propre état : on affiche le
> champ qu'on veut, quand on veut, et le bouton est un vrai
> `<button type="button">` (il ne soumet jamais le formulaire), avec
> `aria-label` et `aria-pressed` qui décrivent l'action. Ne pas réécrire un
> `<input type="password">` à la main.

> **Champ contrôlé = `value` + `onChange`.** Un `<input value={x}>` sans
> `onChange` déclenche un avertissement React **et devient réellement
> `readOnly`** : le champ est inutilisable à la saisie. C'est le défaut qui
> existait sur le code hexadécimal de la barre latérale (`/parametres`) —
> corrigé par `ColorField`, qui garde la frappe dans un brouillon local et
> n'enregistre qu'à la fin (blur ou `Entrée`), avec retour à la valeur
> enregistrée si le code est incomplet. Si un champ doit rester en lecture
> seule, écrire `readOnly` **explicitement**, jamais l'omettre.

### Contrat responsive (règle des 5 largeurs)

- **360 px** : pas de défilement horizontal ; cibles tactiles ≥ 44 px ;
  formulaires sur 1 colonne ; modales plein écran (bottom sheet).
- **640 px** : `sm:grid-cols-2`, tableaux qui apparaissent.
- **1024 px** : sidebar 288 px.
- **≥1536 px** : contenu centré (`max-w-7xl`), jamais étiré.
- Barres de filtres : `flex-wrap` ; filtres secondaires repliés derrière
  « Filtres (n) » sur mobile (fourni par `DataToolbar`).
- Impressions : `print:` masque la sidebar et les boutons.

### Aucune page ne défile horizontalement — les 4 causes à connaître

Une barre de défilement horizontale en bas de la fenêtre, avec le contenu coupé
à droite, vient toujours de l'une de ces quatre causes. Mesuré et corrigé sur
les 32 écrans aux largeurs 360 / 768 / 1024 / 1366 px :

1. **Référence de grille ou de flex sans `min-width: 0`.** Un enfant de `grid`
   ou de `flex` a `min-width: auto` : il **refuse** de rétrécir sous la largeur
   minimale de son contenu, et pousse toute la page. D'où `min-w-0` sur `main`
   (`app-shell`), sur `PageSection` et sur toute section de grille.
2. **Tableau large sans conteneur de défilement.** Le défilement horizontal
   appartient au **tableau**, jamais à la page : `ResponsiveTable` enveloppe sa
   vue tableau dans `overflow-x-auto`, donc la carte défile et les en-têtes de
   page restent en place.
3. **Texte insécable dans un champ ou une carte.** DaisyUI met `.label` en
   `white-space: nowrap` : un texte d'aide ne passait pas à la ligne et prenait
   la largeur de sa phrase. Les aides (`FormField`) et les lignes de total
   (`flex-wrap` + `min-w-0`) doivent se replier.
4. **`whitespace-nowrap` sur un montant ou une référence** dans une colonne
   étroite : passer la ligne en `flex-wrap`, ou réduire le nombre de colonnes
   avant `xl` (voir `/rapports`, panneau « Bénéfice net »).

**Contrôle avant de livrer un écran** : ouvrir la page à 360 px et vérifier
qu'il n'y a **aucune** barre horizontale. `document.documentElement.scrollWidth`
doit être **inférieur ou égal** à `window.innerWidth`.

---

## 9. Permissions

`lib/permissions.ts` — **masquer n'est pas protéger**.

- Côté serveur : `await requireAction('sales.cancel')` **en première ligne** de
  chaque handler. `requireAction()` résout les permissions **effectives** (rôle
  **puis** surcharges par utilisateur) avant de décider.
- Côté client : `<RoleGate action="sales.cancel">…</RoleGate>` ou
  `usePermission('sales.cancel')`. Ces deux helpers lisent le contexte
  d'authentification (`useAuth().can`), donc les permissions effectives.
- Rôles : `admin`, `manager`, `seller`, `storekeeper`, `carpenter`, `brickmaker`.
- Le menu (`lib/navigation.ts`) est filtré par `action` ; un groupe vide disparaît.

### 9.1 Permissions par utilisateur (surcharges)

En plus de la matrice du rôle, l'administrateur peut accorder ou retirer une
action **à un utilisateur précis** (`user_permissions`, `lib/user-permissions.ts`).

- **Trois états par action** : *Hérité* (aucune ligne) · *Autorisé* (`allow`) ·
  *Refusé* (`deny`). Une surcharge prime toujours sur le rôle.
- **`admin` n'est jamais restreint** : il a tout, et une tentative de
  restriction est refusée. C'est ce qui empêche de bloquer l'application.
- La règle vit dans **une seule fonction** : `resolvePermissions(role, overrides)`
  de `lib/permissions.ts`. Ne pas la dupliquer.
- Ne jamais décider sur le seul rôle côté serveur : passer par
  `getEffectivePermissions()` (via `requireAction`), sinon un droit retiré à la
  main resterait honoré par l'API.
- Les 57 actions sont décrites dans `ACTION_META` (libellé français +
  explication + marqueur `dangerous`). **Ajouter une action oblige à l'ajouter
  à `Action`, `ALL_ACTIONS`, `ACTION_META` et à la matrice `PERMISSIONS`** —
  TypeScript le signalera, ne pas contourner avec un cast.
- Toute modification de permissions est journalisée (`writeAudit`) et
  synchronisée (`enqueueSyncWrite` sur `user_permissions`).

---

## 10. Formatage

Tout passe par `lib/format.ts` :

```ts
formatCurrency(1250000)        // « 1 250 000 GNF »
formatCurrencyCompact(1250000) // « 1,2 M GNF » (graphiques)
formatQuantity(12.5, 'm²')     // « 12,5 m² »
formatPercent(12.4)            // « 12,4 % »
formatDelta(-3.1)              // « −3,1 % »
today()                        // « 2026-09-23 » (fuseau local)
previousPeriod(from, to)       // bornes de la période précédente
```

Dates affichées : `lib/date-format.ts` (`formatDateShort`, `formatDateLong`,
`formatDateTime`). **Jamais** `date.toLocaleDateString()` directement.

---

## 11. Synchronisation — 4 règles à respecter sans exception

1. Toute écriture appelle `enqueueSyncWrite(table, syncId, op, payload)`.
2. Jamais de suppression physique (tombstone `deleted_at` ou `is_active`).
3. Jamais de référence par `id` local dans un payload — uniquement par `sync_id`.
4. Le code de synchronisation **ne bloque jamais** une opération métier : si
   l'API est injoignable, l'écriture locale réussit et la file se remplit.

---

## 11 bis. ⚠️ Séparation serveur / navigateur — la faute qui casse le build

C'est **l'erreur la plus coûteuse du projet** : elle ne se voit pas en
développement, elle fait échouer `npm run build` avec une dizaine d'erreurs
Turbopack incompréhensibles (`Module not found: Can't resolve 'fs'`,
`non-ecmascript placeable asset`, `next/headers … Pages Router`).

**Règle** : un composant client (`'use client'`) ne doit **jamais** importer à
l'exécution un module de `lib/` qui touche la base.

| Module | Client-safe ? |
|---|---|
| `lib/permissions.ts`, `lib/navigation.ts`, `lib/format.ts`, `lib/date-format.ts`, `lib/view-state.ts`, `lib/constants.ts`, `lib/settings-schema.ts`, `lib/audit-labels.ts`, `lib/colors.ts` | ✅ **oui** |
| `lib/customers.ts`, `lib/products.ts`, `lib/sales.ts`, `lib/users.ts`, `lib/audit.ts`, `lib/caisse.ts`, `lib/payments.ts`, `lib/stock.ts`, `lib/api.ts`, `lib/settings.ts`, `lib/backup.ts`, `lib/dashboard.ts`, `lib/sync.ts`, `lib/expenses.ts`… | ❌ **non** (ils importent `@/db`, `fs`, `next/headers`) |

**Ce qu'il faut faire :**

1. Pour un **type** : `import type { X } from '@/lib/module'` — effacé à la
   compilation, donc sans danger.
2. Pour une **constante ou un libellé** : l'extraire dans un module client-safe
   (`lib/constants.ts`, `lib/audit-labels.ts`, `lib/settings-schema.ts`) et faire
   ré-exporter le module serveur. Ne jamais dupliquer la valeur.
3. Pour de la **donnée** : passer par l'API (`fetch('/api/...')`).

**Contrôle avant de livrer** — cette commande doit ne rien retourner :

```bash
# imports RUNTIME (non `import type`) de modules serveur depuis app/ ou components/
grep -rnE "^\s*import\s+(?!type\s)[^;]*from '@/(lib/(audit|users|customers|suppliers|products|stock|sales|purchases|payments|caisse|expenses|backup|settings|dashboard|sync|api|seed-data)|db)" \
  app components | grep -v '/api/'
```

---

## 11 ter. Logo et icônes

- **Logo d'affichage** : `public/logo.jpg`, référencé par `/logo.jpg` dans
  l'interface (sidebar, en-tête mobile, drawer, page de connexion).
- **Logo des documents** (facture, reçu, rapport, devis) : `settings.companyLogo`
  s'il a été téléversé, sinon `DEFAULT_COMPANY_LOGO` de `lib/settings-schema.ts`.
  Ne jamais laisser un document sans logo : le client en a fourni un.
- **Icônes** : `scripts/generate-icons.js` (`npm run icons`) les **dérive** du
  logo — `public/icon.png` (fenêtre Electron, macOS, Linux), `build/icon.png`,
  `app/icon.png` (favicon) et `build/icon.ico` (Windows, 7 tailles de 16 à
  256 px, entrées PNG, écrites à la main car `sharp` ne produit pas d'ICO).

> **Changer de logo = 2 étapes** : déposer le nouveau fichier dans `public/`,
> puis `npm run icons`, puis rejouer `npm run build:desktop:win`. Sans la
> deuxième étape, l'installateur et le raccourci du bureau afficheraient encore
> l'ancienne image — l'icône Windows n'est pas lue depuis `public/`.

---

## 11 quater. Export de documents (PDF, image, WhatsApp)

**Règle : on n'exporte jamais la page affichée.**

`lib/export-document.ts` est le moteur unique. Il construit un **document HTML
autonome** (`renderExportDocument`), avec sa propre feuille de styles et des
**couleurs hexadécimales uniquement**, l'écrit dans un **iframe invisible**, puis
capture `iframeDoc.body` avec `html2canvas` — c'est l'approche du projet Gaz, et
la seule qui fonctionne :

- `html2canvas@1.4.1` ne lit que `rgb()`, `rgba()`, `hsl()`, `hsla()` et les
  couleurs nommées. Les chaînes `oklch`, `oklab`, `lab`, `lch` n'y apparaissent
  **pas une seule fois** ;
- Tailwind 4 et DaisyUI 5 n'émettent que des `oklch()`, et une opacité comme
  `border-primary/70` produit un `color-mix()`. Capturer la page échoue donc
  (« L'image n'a pas pu être générée ») ;
- **aucune conversion côté navigateur n'est possible** : vérifié à l'exécution,
  `ctx.fillStyle = 'oklch(45% .24 277)'` renvoie `oklch(0.45 0.24 277.023)` — le
  navigateur normalise sans convertir en sRGB.

**Ce qu'il faut faire :**

```ts
const html = renderExportDocument({
  documentTitle: 'Facture',
  documentNumber: invoice.invoiceNumber,
  company: exportCompanyFromSettings(settings),   // logo + couleur principale
  meta: [['Client', invoice.customerName]],
  blocks: [
    { kind: 'table', columns: [...], rows: [...], numeric: [3, 5, 6] },
    { kind: 'totals', rows: [{ label: 'Total', value: formatCurrency(invoice.total), tone: 'strong' }] },
  ],
  notes: invoice.notes,
});

await exportDocumentAsPDF(html, fileBase);
await exportDocumentAsImage(html, fileBase);
await shareOnWhatsApp(html, message, `${fileBase}.png`, 'Facture');
```

**Interdits :**

| ❌ | ✅ |
|---|---|
| `captureElementAsImage('mon-document')` sur la page | `renderExportDocument(...)` puis `exportDocumentAs*` |
| `shareOnWhatsApp(element.outerHTML, …)` | `shareOnWhatsApp(htmlDuDocument, …)` |
| Une couleur `oklch()`, `color-mix()` ou `var(--color-…)` dans un gabarit d'export | Un hexadécimal (`#1e293b`) ou `exportCompanyFromSettings().primaryColor` |
| Un message d'erreur générique dans le `catch` | `toast.error(error?.message ?? '…')` — un échec muet est indiagnosticable |
| Étirer l'image sur une page A4 | Laisser `exportDocumentAsPDF` conserver les proportions et paginer |

**Vérification** : `npm run verify:export` (ou `node scripts/verify-export-e2e.js /ventes/<id>`
pour viser une facture précise) pilote un vrai navigateur (protocole DevTools) et
déclenche réellement les exports. Sans argument, le script prend la première vente
de la liste. Le script `scripts/probe-export-ui.js` sert à inspecter les boutons si
un sélecteur casse.

---

## 12. Liste de contrôle avant de déclarer un module terminé

- [ ] `npx tsc --noEmit` passe sur les fichiers du module
- [ ] `npm run verify:routes` (serveur démarré) : la nouvelle page et ses routes API ne produisent **aucune erreur 500**
- [ ] **Aucun import runtime d'un module serveur dans un composant client** (§11 bis)
- [ ] Les 5 états sont présents (chargement, vide, erreur, nominal, feedback)
- [ ] Aucune couleur Tailwind figée (`grep -E "bg-(sky|blue|red|green|amber|slate)-[0-9]"`)
- [ ] `ResponsiveTable` utilisé pour la liste
- [ ] Restauration d'état (`useViewStateRehydration` + `writeViewState`)
- [ ] Chaque handler commence par `requireAction(...)` puis finit par `fail(error)`
- [ ] Toute écriture passe par `lib/` et appelle `enqueueSyncWrite`
- [ ] Aucun `window.confirm` / `alert` / `prompt`
- [ ] Aucun `DELETE` physique
- [ ] Montants rendus par `MoneyText` (ou classe `tabular`)
- [ ] Libellés en français, code en anglais

### Commandes utiles

```bash
npm run dev          # serveur de développement (navigateur, 127.0.0.1:3000)
npm run typecheck    # tsc --noEmit
npm run build        # build de production Next.js
npm run db:generate  # régénérer les migrations après un changement de schéma
```

### Vérifications de bout en bout

Elles interrogent une application **démarrée** (`npm run dev` ou `npm run start`) ;
`verify:export` demande en plus un navigateur lancé avec
`--remote-debugging-port=9222`.

```bash
npm run verify:routes     # découvre et appelle toutes les pages et routes API : aucune erreur 500 tolérée
npm run verify:purchases  # parcours d'achat complet : stock, caisse, dette fournisseur, numérotation
npm run verify:export     # export PDF / image / WhatsApp dans un vrai navigateur
```
