# AGENTS.md — repères pour un agent qui travaille sur ce dépôt

Ce fichier s'adresse aux assistants IA (et aux nouveaux développeurs) : ce qui ne se
déduit pas du code, les invariants à ne pas casser, et les pièges déjà payés.
**`README.md` reste la spécification de référence** : toute fonctionnalité livrée y est
décrite, et tout code non trivial y renvoie par `§`.

## Le projet

Application de gestion commerciale de **Planète Déco Sarlu (filiale Meubles)** —
quincaillerie, décoration, chantiers — en **réseau de plusieurs magasins** depuis la v2
(branche `multi-magasins`). Next.js 16 (App Router), React 19, TypeScript, Drizzle ORM
sur **SQLite local**, livrée en Electron. La briqueterie et l'atelier ont été retirés en v2.

Chaque **poste** a sa base SQLite et travaille hors ligne ; un serveur central
(`server/`, PostgreSQL) échange les changements entre postes. Un poste **autonome**
fonctionne sans serveur : aucune opération métier ne dépend du réseau.

**Avant toute tâche multi-magasins** : lire README §28 (état réel du chantier) et
`docs/GUIDE-MULTI-MAGASINS.md` (contrat de chaque page). Après chaque étape livrée,
**mettre à jour README §28.3 et le guide §2** : le travail peut être repris à tout moment
par une autre IA.

## Commandes

```bash
npm run dev            # serveur de développement sur 127.0.0.1:3000
npm run build          # build de production
npm run typecheck      # tsc --noEmit — LE garde-fou automatique disponible
npm run lint           # ⚠️ CASSÉ (pré-existant) : typescript-eslint ne supporte pas TS 7
npm run verify:routes  # découvre et appelle toutes les pages et routes d'API : aucun 500 toléré
npm run verify:draft   # politique du brouillon de vente (stock, caisse, sync, validation)
npm run verify:purchases
npm run verify:chantiers  # prestations de chantier : cloisonnement magasins, prix figés, rentabilité
npm run verify:export  # export PDF/image dans un vrai navigateur (CDP)
npm run verify:export-image # exporte de vrais documents en PNG (OUT=<dossier>) pour les regarder
npm run verify:ui          # ouvre chaque écran dans Chrome (CDP 9333) : rendu, console, 404, débordement
                           # WIDTH=400 pour le téléphone, SHOTS=<dossier> pour des captures (README §28.4)
npm run db:migrate         # applique les migrations sans démarrer Next (avant les verify:*)
npm run demo:seed          # base vierge → administrateur + réseau de démonstration (13 mois)
```

Les scripts `verify:*` interrogent une application **démarrée** et écrivent dans la base
locale (c'est assumé : ce sont des données de recette). `.cookies.txt` est gitignoré et
permet de reprendre une session quand le mot de passe de la base n'est pas connu.

### Vérifier par exécution, pas par lecture

Toute fonctionnalité d'interface ou d'export se vérifie **dans un vrai navigateur**
(CDP *Chrome DevTools Protocol*) : c'est ainsi qu'ont été trouvés les défauts d'export
(`oklch`, PDF de 13 Mo, bande blanche) que la lecture seule ne montrait pas.

> ⚠️ **Piège CDP** : le port `9222` peut être occupé par un Chrome résiduel d'une session
> précédente. Vos lancements se connecteraient alors à **ce** navigateur (profil, session
> et `sessionStorage` d'un autre essai) au lieu du vôtre. Utilisez un port dédié
> (`9333`) et un `--user-data-dir` unique par exécution.

## Invariants à ne pas casser

1. **Aucune suppression physique.** Annuler = statut `cancelled` + motif + auteur + date.
   Un brouillon « supprimé » est une annulation sans contrepartie.
2. **Aucun total stocké.** `amount_paid`, `remaining_amount`, `payment_status`, soldes
   clients et fournisseurs sont **recalculés à la lecture** (`payments`, factures).
3. **Le stock ne s'écrit que par `addStockMovement()`** — jamais `products.stock` en direct.
4. **Un brouillon de vente ne touche ni stock ni caisse** et n'est **jamais encaissable**
   (`createPayment` refuse un document non `active`). Il se valide par
   `POST /api/ventes/[id]/valider`, sans ressaisie.
5. **Les exports ne capturent jamais la page affichée.** On rend un **document HTML
   autonome** en couleurs **hexadécimales** (`lib/export-document.ts`), capturé dans un
   iframe invisible. Trois réglages sont fonctionnels, pas cosmétiques :
   `compress: true` sur jsPDF, cadre d'iframe à hauteur nulle puis mesuré, et le **même**
   document pour PDF, image et WhatsApp. Voir README §11.1.
   **Jamais** de html2canvas ni de jsPDF hors de `captureHtml` : c'est là que vit le
   correctif du texte décalé vers le bas (`installFontMetricsFix`, mesure des polices
   faussée par le `img { display: block }` de Tailwind). Un export se vérifie sur le
   **fichier produit** : `npm run verify:export-image`.
6. **Le front ne parle qu'à l'API.** Un composant client ne doit **jamais** importer une
   *valeur* depuis un module serveur (`lib/sales.ts`, `lib/payments.ts`, `lib/customers.ts`…
   importent `@/db`) : uniquement `import type`. Sinon `@libsql/client` et `fs` entrent
   dans le bundle navigateur.
7. **Dates et montants.** Dates métier `YYYY-MM-DD`, affichage via `lib/date-format.ts`,
   tout montant via `formatCurrency`, toute quantité via `formatQuantity`.
8. **Ordre des colonnes d'une liste : la date propre de la ligne est la première.**
   Les dates *dérivées* (« Dernier achat », « Dernière connexion », « Échéance la plus
   ancienne ») restent à leur place. Sur mobile, l'identifiant reste le titre de la carte.
9. **Code couleur des dus.** `MoneyText due` : **rouge dès qu'il reste quelque chose à
   payer, vert quand c'est soldé** — c'est la règle des **soldes** clients et fournisseurs
   (§7.2). `MoneyText colored` (négatif rouge / positif vert) **ne convient pas** à un dû :
   un reste dû est un montant positif, il apparaîtrait vert.
   Pour un **reste** (colonne « Reste », « Dette », « Reste dû », ou la même valeur en
   carte sur une fiche), utiliser **`MoneyText remaining`** : **rouge dès qu'il reste
   quelque chose, neutre à zéro** — un « 0 GNF » n'a pas à être vert. Lui passer
   l'expression « ce reste est-il payable ? » (`remaining={invoice.status === 'active'}`,
   `remaining={job.status !== 'cancelled'}`) : un document **annulé ou en brouillon**
   reste neutre même avec un reste non nul, sinon le rouge est un faux signal.
   Ne jamais remettre `colored` sur un montant dû : c'est le défaut corrigé partout
   (listes achats, ventes, clients, fournisseurs, chantiers, soldes, rapports, reçus,
   fiches et modales).
10. **Champs de saisie : ne jamais écrire « numéro » ni `jj/mm/aaaa` dans un placeholder
    ou un libellé de champ.** Chrome classe alors le champ en `CREDIT_CARD_NUMBER` /
    `CREDIT_CARD_EXP_*` (vérifié dans `chrome://autofill-internals`) et affiche
    « La saisie automatique des modes de paiement est désactivée… » sur une connexion
    non HTTPS. Utiliser « n° » et « jj mois aaaa ». `autocomplete="off"` ne suffit pas.
11. **Thème uniquement.** Aucune couleur figée (`text-emerald-500`, `#22c55e`) : jetons
    DaisyUI (`text-success`, `bg-error/10`…), sinon le thème choisi par le client est ignoré.
12. **Accessibilité.** Cible tactile ≥ 44 px sur mobile, `aria-label` sur chaque
    bouton-icône, et **jamais la couleur seule** pour porter une information.
13. **Une donnée financière sensible se garde côté serveur.** Coût et bénéfice d'une
    vente (`cost`, `profit`) ne sont renseignés que pour un utilisateur détenant
    `balances.view` (`canViewSalesProfit()` dans `lib/sales.ts`) : sinon ils valent
    `null` dans `GET /api/ventes` et `GET /api/ventes/[id]`, et l'interface masque la
    colonne / la statistique. Masquer un élément d'interface ne protège rien (§9).
    Depuis la refonte des rôles (README §17.2), **le vendeur n'a plus `balances.view`** :
    ni `/soldes` ni bénéfice. On le lui accorde au besoin dans sa fiche (domaine
    « Tableau de bord et rapports » → Gérer).
14. **La marge ne sort jamais d'un document client** : ni PDF, ni image, ni WhatsApp.
    Elle vit dans des zones `no-print` ou des écrans internes — jamais dans
    `InvoiceDocument`, `purchase-document` ni un gabarit d'export (`lib/export-document.ts`).
15. **Magasin actif.** Toute écriture va dans `user.storeId` (`requireActiveStore`),
    jamais dans un `storeId` reçu du navigateur. La lecture s'élargit par `?store=all|<id>`
    via `scopeFromRequest` (borné au périmètre, 403 sinon) ; un document d'un autre magasin
    passe par `assertStoreVisible`. Données centrales (catégories, comptes,
    magasins, paramètres d'entreprise) : `requireCentralEdit()` — siège uniquement.
    **Clients, fournisseurs, ouvriers et assortiment de produits sont propres à chaque
    magasin** (README §28.5) : toute liste de produits « du magasin » passe par
    `listedSql`, tout document vérifie son client / fournisseur par
    `assertCustomerInStore` / `assertSupplierInStore`. Un nouveau magasin part vide.
16. **Une carte d'indicateur = une infobulle en mots simples.** L'application vise un
    public non technicien : `StatCardDelta` reçoit `tooltip="…"` (ce que le chiffre
    représente, comment il est obtenu, à quelle date). Toute page est vérifiée à
    **1366 px et 400 px** (`npm run verify:ui`, `WIDTH=400`) : aucun débordement horizontal.
17. **Stock négatif : jamais implicite.** `addStockMovement` refuse un stock négatif ;
    `allowNegative` n'est utilisé que pour une dérogation **choisie par une personne
    habilitée** et journalisée (annulation d'achat déjà revendu : `allowNegativeStock`,
    permission `stock.adjust`). Ne pas réintroduire de dérogation automatique.
18. **Recette sur une base isolée.** Les essais qui écrivent (magasins, transferts…) se
    font sur une copie : `PDS_DB_PATH=<copie.db> NEXT_DIST_DIR=.next-recette next dev -p 3100`
    (README §28.4). Un magasin créé ne se supprime jamais : ne pas polluer la base de travail.
19. **Montant d'un chantier = ses lignes de prestations** (prix figés). Matériaux, équipe,
    sous-traitance et dépenses sont des **coûts** : ne jamais les réinjecter dans `total`
    (c'était le cas avant la v2 : la marge valait toujours zéro). Un devis, une demande ou
    un chantier n'utilise qu'une prestation **active de son magasin** (`assertServiceUsable`).
    Un document client (devis, facture de chantier) ne montre **aucun** coût interne.
20. **Liens entre documents synchronisés = clés étrangères déclarées.** La synchronisation
    ne traduit d'un poste à l'autre que les colonnes déclarées en `references()` ; un
    identifiant stocké en simple entier pointe vers une mauvaise ligne ailleurs. Le lien
    inverse se calcule à la lecture (devis → chantier : `service_jobs.quote_id`).
21. **Rôles = un niveau par domaine.** On ne modifie jamais la matrice `PERMISSIONS` à
    la main : on change `ROLE_LEVELS` (ou un niveau de `ACCESS_AREAS`) dans
    `lib/permissions.ts`. Toute nouvelle `Action` doit entrer dans **exactement un**
    niveau d'un domaine, sinon aucun écran ne permet de l'accorder. Un administrateur
    ne se désactive jamais (`assertNotAdministrator`).

## Organisation

| Sujet | Fichier |
|---|---|
| Navigation (et permission par entrée) | `lib/navigation.ts`, icônes `components/nav-icons.tsx` |
| Permissions (matrice par rôle + surcharges) | `lib/permissions.ts`, garde client `components/role-gate.tsx` |
| Authentification des Route Handlers | `requireAction('…')` de `lib/api.ts` dans chaque handler |
| Journal d'actions | `lib/audit.ts` (+ libellés *client-safe* dans `lib/audit-labels.ts`) |
| Design system (présentation pure) | `components/design-system.tsx` |
| **Bénéfice d'une période** (CA, COGS, marge, dépenses, main-d'œuvre) — source unique du tableau de bord, de `/soldes` et de `/rapports` | `lib/profit.ts` |
| **Magasins** (contexte, accès, indicateurs) | `lib/stores.ts`, `lib/api.ts` (portée), `lib/user-scope.ts` ; écrans `app/magasins/*`, `components/magasins/store-ui.tsx`, `components/store-scope.tsx` |
| **Prestations de chantier** (catalogue par magasin, demandes, devis, chantiers, pilotage) — README §19 | `lib/services.ts`, `lib/service-requests.ts`, `lib/quotes.ts`, `lib/jobs.ts`, `lib/jobs-dashboard.ts` ; écrans `app/prestations`, `app/chantiers/*`, `app/ouvriers`, `app/sous-traitants` ; composants `components/prestations/*`, `components/chantiers/*` ; démonstration `lib/seed-jobs.ts` |
| **Transferts / inventaires** | `lib/transfers.ts`, `lib/transfer-actions.ts`, `lib/inventories.ts` |
| **Synchronisation** (poste, push/pull, serveur) | `lib/device.ts`, `lib/sync-engine.ts`, `db/sync-registry.ts`, `db/triggers.ts`, `server/` |
| Listes (tableau desktop / cartes mobile) | `components/responsive-table.tsx` |
| État de vue des listes (filtres, page) | `lib/view-state.ts` — `sessionStorage`, par entrée d'historique |

## Conventions d'écriture

- **Français** partout : interface, commentaires, messages d'erreur, noms de domaine.
- Un commentaire explique **pourquoi**, pas ce que la ligne fait. Les décisions
  contre-intuitives (et les correctifs de recette) sont commentées là où elles vivent,
  avec le symptôme observé.
- Une fonctionnalité documentée = une mise à jour du README (section et tableaux de
  routes/pages si besoin).
- Ne pas ajouter de dépendance sans justification écrite (README §4.5).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
