# Guide multi-magasins — procédure complète, page par page

> **À qui s'adresse ce document ?** Au développeur du projet PDS **et à toute IA**
> qui reprendrait le travail. Il explique ce qui a été construit, ce qui reste à
> faire, et pour **chaque page** : son but, chaque bouton, l'action déclenchée,
> l'API appelée, la permission exigée et les erreurs à afficher.
>
> **Référence fonctionnelle :** cahier des charges « Évolution de PDS vers une
> gestion multi-magasins centralisée » (option B retenue).
>
> **Règle d'or pour une IA :** ne jamais deviner un contrat d'API. Chaque route
> documente son contrat dans le commentaire en tête de `app/api/**/route.ts`.
> Lisez-le avant d'écrire l'écran correspondant.

---

## Sommaire

1. [Architecture retenue (option B)](#1-architecture-retenue-option-b)
2. [État d'avancement : fait / reste à faire](#2-état-davancement)
3. [Règles métier à ne jamais casser](#3-règles-métier-à-ne-jamais-casser)
4. [Conventions techniques pour écrire une page](#4-conventions-techniques-pour-écrire-une-page)
5. [Rôles et permissions](#5-rôles-et-permissions)
6. [Pages, une par une](#6-pages-une-par-une) (connexion, coquille, tableau de bord… synchronisation)
7. [Serveur central : installation sur VPS](#7-serveur-central--installation-sur-vps)
8. [Mise en service d'un réseau de magasins (procédure terrain)](#8-mise-en-service-dun-réseau-de-magasins)
9. [Vérifications et tests à exécuter](#9-vérifications-et-tests)
10. [Ordre de travail recommandé pour terminer](#10-ordre-de-travail-recommandé-pour-terminer)

---

## 1. Architecture retenue (option B)

```
          ┌────────────────────────────── VPS ──────────────────────────────┐
          │  Caddy (HTTPS)  →  serveur de synchro (server/index.mjs, Node)  │
          │                       └── PostgreSQL 16 (table sync_rows)       │
          └─────────────────────────────────────────────────────────────────┘
                 ▲ push / pull (HTTPS, jeton de poste)      ▲
                 │                                           │
   ┌─────────────┴──────────┐                  ┌─────────────┴──────────┐
   │ Poste SIÈGE (mode hq)  │                  │ Poste MAGASIN (store)  │
   │ Electron + Next.js     │                  │ Electron + Next.js     │
   │ SQLite locale complète │                  │ SQLite locale : son    │
   │ (tous les magasins)    │                  │ magasin + référentiel  │
   └────────────────────────┘                  └────────────────────────┘
```

- **Chaque poste a sa propre base SQLite** et fonctionne **sans Internet**.
- Les écritures locales sont capturées par des **triggers SQLite** (`db/triggers.ts`)
  dans la table `sync_changes`, puis envoyées au serveur (push) ; le poste reçoit
  les changements des autres (pull). Moteur : `lib/sync-engine.ts`.
- **Trois modes de poste** (`lib/device.ts`, stockés dans `sync_state`) :
  - `standalone` : autonome, pas de serveur (installation d'un seul magasin) ;
  - `hq` : poste du **siège**, inscrit avec la clé maîtresse du serveur ; il voit tous
    les magasins, mais **n'écrit que dans le magasin de type « siège »** (les autres
    magasins sont en lecture seule depuis ce poste) ;
  - `store` : poste d'un **magasin**, inscrit avec un code à usage unique généré au siège.
- **Données centrales** (`hqOnly` dans `db/sync-registry.ts`) : utilisateurs, magasins,
  affectations, permissions, paramètres, catégories. Elles ne se modifient
  **qu'au siège** (ou en autonome). Sur un poste magasin, l'API renvoie 403
  (`requireCentralEdit()` dans `lib/api.ts`).
- **Catalogue commun, assortiment par magasin** (README §28.5) : le produit est unique,
  mais chaque magasin ne voit que **ses** produits (`product_stocks.is_listed`) ; il en
  crée ou en reprend du catalogue. Ligne `product_stocks` : stock, seuil local, prix local.
- **Clients, fournisseurs, ouvriers propres à chaque magasin** ; un nouveau magasin part
  vide (README §28.5).
- **Stock = somme des mouvements** (`stock_movements`, par magasin). Jamais écrit en dur.
- **Numérotation par magasin et par poste** : `FAC-{STORE}{POSTE}-AAAA-NNNNNN`
  (ex. `FAC-KAL1-2026-000042`) — deux postes hors ligne ne produisent jamais le même numéro.

### Fichiers clés

| Domaine | Fichiers |
|---|---|
| Schéma / migrations | `db/schema.ts`, `db/migrations/0004_*.sql` (retrait briqueterie/atelier), `0005_multi_magasins.sql` |
| Tables synchronisées | `db/sync-registry.ts`, `db/triggers.ts` |
| Transactions | `db/index.ts` (`withTransaction`, `db` bascule automatiquement dans la transaction en cours) |
| Session / contexte magasin | `lib/session.ts`, `lib/api.ts` (`SessionUser`, `requireActiveStore`, `scopeFromRequest`, `assertStoreVisible`, `requireCentralEdit`) |
| Magasins | `lib/stores.ts` |
| Stock | `lib/stock.ts` |
| Transferts | `lib/transfers.ts`, `lib/transfer-actions.ts` |
| Inventaires | `lib/inventories.ts` |
| Dépenses (approbation) | `lib/expenses.ts` |
| Synchronisation | `lib/sync-engine.ts`, `lib/device.ts`, `server/index.mjs` |
| Tâches planifiées | `lib/scheduler.ts`, `instrumentation.ts` (sauvegarde, synchro auto, rapports) |
| Interface commune | `components/auth-provider.tsx`, `components/store-switcher.tsx`, `components/store-scope.tsx`, `components/sync-indicator.tsx` |

---

## 2. État d'avancement

### ✅ Fait

- **Refonte des comptes** (README §17.2) : rôles = un niveau par domaine, rôle Comptable,
  administrateur jamais désactivable ; `/utilisateurs` refait, assistant de création,
  page `/utilisateurs/[id]`. **Catégories** : seulement celles du magasin, un magasin
  peut en créer (README §28.5).
- **Changer de magasin actif** (README §28.6) : permission `stores.switch`, administrateur
  d'office ; sans elle, le compte reste dans son magasin principal. Case « Peut changer de
  magasin » dans « Nouvel utilisateur » et dans la fenêtre « Magasins ».
- **Données propres à chaque magasin** (README §28.5) : clients, fournisseurs, ouvriers,
  assortiment de produits ; nouveau magasin vide ; `/produits` : « Nouveau produit »
  pour tout magasin, « Ajouter du catalogue », « Retirer de ce magasin » ; formulaire de
  magasin : « Produits de départ ». Listes clients / fournisseurs : magasin sous le nom
  en vue « tous les magasins ».

- Retrait complet de **briqueterie** et **atelier** (pages, API, tables, permissions, rôles).
  Les **chantiers** sont conservés.
- Corrections de sécurité :
  - sessions en base (cookie `pd_session`, jeton haché, expiration 12 h d'inactivité, révocation) ;
  - verrouillage après 5 échecs de connexion ;
  - DevTools fermés en production, liste blanche des liens externes ;
  - transactions réelles.
- Base multi-magasins, migration des données existantes vers un magasin « PRINC ».
- Toute la couche métier `lib/` avec le magasin, et **toutes les routes d'API** listées au §6.
- Moteur de synchronisation complet + serveur PostgreSQL + fichiers Docker (`server/`).
- Interface commune :
  - contexte magasin dans `useAuth()` ;
  - **sélecteur de magasin actif** dans la barre latérale ;
  - liste « portée » réutilisable (`StoreScopeSelect`) ;
  - indicateur de synchro ;
  - **écran de connexion** : première installation (nouveau réseau / rejoindre un serveur) et choix du magasin.
- Page **/synchronisation** réécrite (à relire, voir §6.17).
- `components/magasins/store-ui.tsx` : badges de statut/type + modale de création/édition de magasin.
- **`/parametres`** (§6.18) : ancienne synchro retirée (`tsc` à zéro erreur), préfixes
  transfert/inventaire, aperçu exact du numéro (`renderDocumentNumber` déplacé dans
  `lib/settings-schema.ts`, importable côté client), carte « Règles multi-magasins »,
  sauvegarde automatique du poste avec date de la dernière copie, verrouillage des
  réglages d'entreprise sur un poste magasin.
- **`/magasins`** et **`/magasins/[id]`** (§6.14) : voir la fiche. Ajouts au contrat :
  `GET /api/audit?central=false` (activité d'un magasin sans les actions centrales) et
  `useStoreScope` qui lit `?store=<id>|all` dans l'URL (raccourcis de la fiche magasin).
- **Infobulles** : `StatCardDelta` accepte `tooltip` ; chaque carte d'indicateur explique
  son chiffre en mots simples (règle pour toutes les pages).
- **`/utilisateurs`** et **historique** (§6.19) : voir la fiche. Composant
  `components/utilisateurs/store-assignments.tsx` (éditeur + modale d'affectations).
  Correctif serveur : `GET /api/users?stats=true` est borné au périmètre du gérant.
- **Sélecteur de magasin actif** (barre latérale) : texte blanc sur fond blanc corrigé.
- **Transferts** (§6.15) : les trois écrans, composant `components/transferts/transfer-ui.tsx`
  (libellés recopiés de `lib/transfers.ts`). Cycle vérifié de bout en bout par l'API
  (demande, validation, expédition, réception partielle, litige, clôture, stocks).
- **Jeu de démonstration** étendu (13 mois, tous les statuts) + `npm run demo:seed`.
- **Règle corrigée** : annuler un achat déjà revendu est refusé par défaut ; dérogation
  explicite (`allowNegativeStock`, permission `stock.adjust`) proposée par la modale
  d'annulation et journalisée.
- **Inventaires** (§6.16) : les deux écrans, `components/inventaires/inventory-ui.tsx`.
  Règles corrigées dans `lib/inventories.ts` : justification **obligatoire** de chaque
  écart à la validation ; théorique affiché = stock actuel pour une ligne non comptée.
- **Dépenses** (§6.7) : circuit d'approbation à l'écran. Règles corrigées dans
  `lib/expenses.ts` / `app/api/depenses` : dispense réservée au rôle `admin` (avant :
  toute personne ayant `expenses.approve`, donc un gérant s'approuvait lui-même) ;
  auto-approbation interdite ; hausse au-delà du seuil → `pending` (ou refus si
  décaissée). Champs de date : `jj/mm/aaaa` remplacé par « jj mois aaaa » sur 5 écrans
  (AGENTS.md n° 10).
- **Produits** (§6.9) : `ProductRow.localStockMin` ajouté ; la modale préremplit le
  prix et le seuil **du catalogue** (`catalogSalePrice`, `catalogStockMin`) et non les
  valeurs effectives ; `localPricesAllowed = false` ignore les prix locaux partout
  (`productColumns`, `salePriceExpr`, `getEffectiveSalePrice`) sans les effacer.
- **Ventes** (§6.4) et **en-têtes de documents** : faits (voir README §28.3). Règle
  commune des listes : `StoreScopeSelect` + `StoreTag` (nom du magasin sous
  l'identifiant) ; `scopeShowsStore(scope)` dit quand l'afficher.
- **Exports** : voir README §11.1 (troisième piège, règles pour tout futur export).
- **Chantiers** (§6.11) : types de prestation configurables (`settings.jobCategories`,
  `lib/job-categories.ts`, `validateJobCategory`), portée magasin, colonnes resserrées.
- **Prestations de chantier** (cahier dédié, README §19) : catalogue **local au magasin**
  (`services`), demandes, devis distincts convertibles en chantier, lignes facturées
  (`service_job_items` : le montant ne vient plus des coûts), étapes, équipes,
  sous-traitance payée par dépenses rattachées, pilotage consolidé, planning. Écrans
  `/prestations`, `/chantiers/*`, `/ouvriers`, `/sous-traitants`. Recette :
  `npm run verify:chantiers`. Reste hors périmètre : photos et documents joints.
- **Clients / Fournisseurs** : portée sur la liste et les cartes ; la **fiche** porte
  sur tous les magasins de l'utilisateur (`?store=all` si plusieurs) avec un détail
  `byStore` (`getCustomerStats`, `getSupplierStats`). Un tiers est commun au réseau :
  sa dette ne doit jamais paraître soldée parce qu'on regarde depuis un autre magasin.
- **Outils** : `npm run verify:ui` (rendu réel, console, 404, débordement, `WIDTH=400`),
  base de recette isolée `PDS_DB_PATH` + `NEXT_DIST_DIR` (README §28.4).

### ⏳ Reste à faire (interface)

| Page | Travail | Section |
|---|---|---|
| `/` tableau de bord | filtre magasin, comparaison, alertes | §6.3 |
| `/soldes`, `/rapports`, `/recus` | ajouter `StoreScopeSelect`, nom du magasin sous l’identifiant (`StoreTag`) en vue consolidée, cas particuliers décrits. Tableaux trop larges en 1366 px à resserrer : rapports, reçus | §6.4 → §6.13 |
| Factures / reçus imprimés | en-tête avec les coordonnées **du magasin** | §6.4 |
| README.md / AGENTS.md | §28 du README et AGENTS.md à jour ; réécrire les anciennes sections §20, §21, §23 du README en fin de chantier | — |
| Vérifications | `tsc`, `next build`, migration d'une ancienne base, test de synchro réel | §9 |

---

## 3. Règles métier à ne jamais casser

1. **Toute écriture se fait dans le magasin actif** de la session (`user.storeId`).
   Les routes l'obtiennent par `requireActiveStore(user)`, qui vérifie aussi que le
   magasin est actif et modifiable depuis ce poste. **Ne jamais** accepter un
   `storeId` venant du navigateur pour une écriture.
2. **La lecture peut être élargie** par `?store=all` ou `?store=<id>` ; la route
   appelle `scopeFromRequest(user, request)` qui borne toujours au périmètre de
   l'utilisateur (403 sinon).
3. **Un document d'un autre magasin** (facture, dépense…) : `assertStoreVisible(user, doc.storeId)`.
4. **Le stock n'est jamais écrit directement** : `addStockMovement()` / `adjustStock()`.
5. **Aucune suppression physique** : annulation = statut + motif + auteur + date.
6. **Données centrales** : `requireCentralEdit()` avant toute écriture sur produits,
   catégories, utilisateurs, magasins, paramètres d'entreprise.
7. **Poste siège** : il ne peut écrire que dans le magasin de type `headquarters`
   (règle dans `assertStoreWritable`). Les autres magasins sont consultables.
8. **Transferts** : la sortie de stock se fait au magasin **source** à l'expédition,
   l'entrée au magasin **destinataire** à la réception. Entre les deux, la marchandise
   est « en transit » (visible dans le stock).
9. **Dépenses** : au-delà du seuil `expenseApprovalThreshold`, une dépense est
   `pending` → approuvée (`to_pay`) → décaissée (`approved`), ou `rejected`. Seules
   les dépenses `approved` comptent dans les résultats.
10. **Masquer n'est pas protéger** : l'interface cache les boutons, mais chaque API
    revérifie la permission.

---

## 4. Conventions techniques pour écrire une page

- Next.js 16 App Router, pages client (`'use client'`), React 19, DaisyUI/Tailwind.
- **Modèles à copier** : `app/clients/page.tsx` (liste), `app/clients/[id]/page.tsx`
  (fiche), `app/ventes/nouvelle/page.tsx` (formulaire avec lignes).
- Composants : `components/design-system.tsx` (MoneyText, QuantityText, Badge,
  StatusBadge, EmptyState, ErrorState, SkeletonTable, PageSection, FormField,
  InfoRow, StageTracker, Card, MiniStat), `PageHeader`, `Modal`, `ResponsiveTable`,
  `ConfirmDialog`, `Combobox`, `RoleGate` / `usePermission`.
- Toasts : `import { toast } from 'react-toastify'` (pas `react-hot-toast`).
- Appels : `fetch(url, { cache: 'no-store', credentials: 'same-origin' })` ; en cas
  d'erreur, lire `{ error }` du corps JSON et l'afficher tel quel (messages déjà en français).
- **Contexte magasin** :
  ```tsx
  const { stores, activeStoreId, activeStore, allStores, device, can, switchStore } = useAuth();
  ```
- **Portée de consultation** :
  ```tsx
  const { scope, setScope, apply, isConsolidated } = useStoreScope('ventes');
  const params = apply(new URLSearchParams({ page: '1' }));   // ajoute store=… si besoin
  // …
  <StoreScopeSelect value={scope} onChange={setScope} />
  ```
  En vue consolidée (`isConsolidated`), afficher la colonne **Magasin** (`storeName`).
- **Poste magasin** (`device?.mode === 'store'`) : désactiver les boutons de création
  de produits, catégories, utilisateurs, magasins, paramètres d'entreprise et afficher
  un bandeau « Ces données sont gérées au siège ».
- **Poste siège sur un autre magasin** : `device?.mode === 'hq' && activeStore?.kind !== 'headquarters'`
  → mode consultation : masquer les boutons d'écriture (le serveur refuse de toute façon).
- Vérification : `npx tsc --noEmit -p .` doit être à zéro erreur.

---

## 5. Rôles et permissions

| Rôle | Libellé | Portée |
|---|---|---|
| `admin` | Administrateur général | tous les magasins, tout |
| `manager` | Gérant de magasin | ses magasins ; approuve dépenses et transferts ; gère les comptes de ses magasins (au siège) |
| `seller` | Vendeur | ventes, clients, encaissements de son magasin |
| `storekeeper` | Magasinier | stock, réceptions, expéditions, inventaires |

Nouvelles permissions (groupe « Magasins ») :

| Permission | Autorise |
|---|---|
| `stores.view` | voir les magasins et leur fiche |
| `stores.manage` | créer, modifier, suspendre, archiver un magasin |
| `stores.viewAll` | voir tous les magasins (vue consolidée) sans y être affecté |
| `transfers.view / create / approve / ship / receive` | consulter, demander, valider/refuser, expédier, réceptionner |
| `inventory.view / manage / validate` | consulter, ouvrir/compter/annuler, valider (ajustements) |
| `expenses.approve` | approuver / rejeter une dépense au-dessus du seuil |

Les permissions peuvent être surchargées par utilisateur (`/utilisateurs` → Permissions).
Côté interface : `can('transfers.ship')`. Côté serveur : `requireAction('transfers.ship')`.

---
## 6. Pages, une par une

Format de chaque fiche :

- **But** : à quoi sert la page.
- **Permission** : ce qu'il faut pour l'ouvrir.
- **Boutons et champs** : pour chacun, ce qu'il fait, l'API appelée, la permission, les erreurs.
- **À faire** : le travail restant sur la page.

---

### 6.1 `/login` — Connexion, première installation, choix du magasin ✅

**But :** entrer dans l'application ; à la toute première ouverture, installer le poste.

Au chargement, la page appelle `GET /api/auth/setup` → `{ needsSetup }`. Elle affiche
alors l'un des trois écrans ci-dessous.

#### A. Première installation (`needsSetup = true`)

Deux onglets :

| Élément | Action |
|---|---|
| Onglet **Nouvelle installation** | Formulaire de création du premier administrateur et du premier magasin. |
| Champ **Premier magasin** (nom) / **Code** (2 à 10 caractères, majuscules) | Nom et code du magasin créé avec l'administrateur. Défaut : « Magasin principal » / `PRINC`. |
| Liste **Type** | « Siège » (poste central qui pilotera un réseau, à inscrire ensuite au serveur avec la clé maîtresse) ou « Magasin unique » (installation autonome). |
| Champs **Nom affiché, Identifiant, Mot de passe, Confirmer** | Compte administrateur. Identifiant : minuscules, chiffres, `.` `_` `-`, 3 caractères minimum ; mot de passe ≥ 6. |
| Bouton **Créer le compte administrateur** | `POST /api/auth/setup` `{ name, username, password, storeName, storeCode, storeKind }` → crée l'admin, les paramètres par défaut, le magasin, l'affectation, ouvre la session, redirige vers `/`. Erreurs : « Un administrateur existe déjà » (400), identifiant invalide, mot de passe trop court. |
| Onglet **Rejoindre le serveur** | Installation d'un **poste de magasin** sur une base vide. |
| Champ **Adresse du serveur central** | Ex. `https://sync.mon-entreprise.com`. |
| Champ **Code d'inscription** | Code à usage unique, valable 7 jours, généré au siège (page Synchronisation → Codes d'inscription). Il désigne déjà le magasin. |
| Champ **Nom de ce poste** | Ex. « Caisse 1 — Kaloum ». |
| Bouton **Inscrire ce poste** | `POST /api/auth/join` `{ serverUrl, code, deviceName }`. Le poste s'inscrit, puis fait une première synchronisation (comptes, catalogue, données du magasin). Succès : message « Poste inscrit… Connectez-vous », puis retour à l'écran de connexion. Erreurs : « Ce poste est déjà configuré » (403, la base contient déjà des comptes), code invalide ou expiré, serveur injoignable, « aucun compte reçu » (le siège n'a pas encore synchronisé). |

#### B. Connexion

| Élément | Action |
|---|---|
| **Identifiant** | Insensible à la casse. |
| **Mot de passe** | — |
| Bouton **Se connecter** | `POST /api/auth/login` `{ username, password }`. Réponse : cookie de session + `{ stores, needsStoreChoice }`. Un seul magasin : redirection vers `/`. Plusieurs : écran C. Erreurs : « Identifiant ou mot de passe incorrect » (401), « Trop de tentatives. Réessayez dans N minutes » (429, après 5 échecs), « Ce compte est désactivé » (403), « Aucun magasin ne vous est affecté sur ce poste » (403). |

#### C. Choix du magasin (comptes multi-magasins)

| Élément | Action |
|---|---|
| Un **bouton par magasin** (nom + code ou « Siège ») | `POST /api/auth/store` `{ storeId }` → le magasin devient le magasin actif de la session, puis redirection vers `/`. Erreur 403 si le magasin n'est pas dans le périmètre. |

---

### 6.2 Coquille de l'application (barre latérale) ✅

Fichiers : `components/app-shell.tsx`, `store-switcher.tsx`, `sync-indicator.tsx`.

| Élément | Action |
|---|---|
| **Logo / nom de l'entreprise** | Lien vers `/`. |
| Bloc **Magasin actif** | Un seul magasin : simple étiquette. Plusieurs : liste déroulante. Choisir un magasin appelle `POST /api/auth/store` `{ storeId }` puis **recharge la page** : toutes les opérations suivantes (vente, achat, caisse, dépense, stock…) sont enregistrées dans ce magasin. Mentions : « Consultation seule depuis le poste du siège » (poste siège sur un autre magasin), « Magasin suspendu : aucune opération possible ». Une modification est journalisée (`session_store`). |
| **Menu** groupé | Filtré par permission (`lib/navigation.ts`) : Pilotage (Tableau de bord, Rapports, Soldes), Commercial (Ventes, Clients, Achats, Fournisseurs), Gestion (Produits, Stocks, **Transferts**, **Inventaires**), Production (Chantiers), Finances (Caisse, Reçus, Dépenses), Administration (**Magasins**, Utilisateurs, Paramètres, Synchronisation). |
| **Indicateur de synchro** | `GET /api/sync/status` toutes les 30 s. Pastille grise « Poste autonome », verte « Synchronisé », orange « N en attente d'envoi » / « Hors ligne », rouge « N conflits à arbitrer ». Clic → `/synchronisation`. |
| **Thème**, **version**, **Paramètres**, **Déconnexion** | Inchangés. Déconnexion : `POST /api/auth/logout` (la session est révoquée en base). |
| Bouton **replier la barre** | Mémorisé localement. |

---

### 6.3 `/` — Tableau de bord ⏳

- **But :** situation du magasin actif, ou du réseau en vue consolidée.
- **Permission :** `dashboard.view`.
- **API :** `GET /api/operations/snapshot?period=day|week|month|year|total&store=all|<id>`
  (`lib/dashboard.ts`, type `DashboardSnapshot` : ventes, encaissements, dépenses,
  bénéfice, **comparaison par magasin**, **alertes** — transferts à traiter, dépenses
  en attente, caisses ouvertes, inventaires en cours —, activité récente).

| Élément | Action |
|---|---|
| Sélecteur **période** (existant) | Recharge le snapshot. |
| **StoreScopeSelect** (à ajouter, visible si plusieurs magasins) | « Magasin actif » / « Tous les magasins » / un magasin → paramètre `store`. |
| Cartes indicateurs (existantes) | Valeurs du périmètre choisi. |
| **Tableau « Comparaison des magasins »** (à ajouter, vue consolidée) | Une ligne par magasin : CA, ventes, panier moyen, dépenses, bénéfice, créances, valeur du stock. Clic sur une ligne → `/magasins/[id]`. |
| **Bloc « Alertes »** (à ajouter) | Une ligne par alerte avec un lien : « N transferts à valider / expédier / recevoir » → `/transferts?status=open`, « N dépenses en attente d'approbation » → `/depenses?approval=pending`, « Caisse ouverte depuis hier » → `/caisse`, « Inventaire en cours » → `/inventaires`, ruptures de stock → `/stocks?outOfStockOnly=true`. |

**À faire :** brancher le paramètre `store`, afficher la comparaison et les alertes (lire les champs exacts dans `lib/dashboard.ts`).

---

### 6.4 `/ventes`, `/ventes/nouvelle`, `/ventes/[id]` ✅

- **Permissions :** `sales.view`, `sales.create`, `sales.update`, `sales.cancel`.
- **API :**
  - `GET /api/ventes?store=…&search=&from=&to=&paymentStatus=&status=` ;
  - `POST /api/ventes` (toujours dans le magasin actif) ;
  - `GET/PUT /api/ventes/[id]` ;
  - `POST /api/ventes/[id]/valider` ;
  - `POST /api/ventes/[id]/annuler` `{ reason }` ;
  - `GET /api/ventes/stats?period=&store=`.

| Élément | Action / à faire |
|---|---|
| **StoreScopeSelect** dans la barre d'outils | Ajoute `store=` à la liste et aux stats. En vue consolidée, colonne **Magasin** (`storeName`). |
| **Nouvelle vente** | Inchangé. Le catalogue affiche le **stock du magasin actif** et le **prix effectif** (prix local s'il existe). Bouton masqué si le poste est en consultation seule. |
| **Valider / Annuler / Encaisser** (fiche) | Inchangés. Une facture d'un autre magasin s'affiche en lecture (le serveur renvoie 403 pour une écriture). |
| **Imprimer / Exporter** la facture | ✅ L'en-tête affiche le magasin de la facture : `GET /api/ventes/[id]` renvoie `store` (`getStoreLetterhead`), appliqué par `applyStoreLetterhead(settings, store)` avant `companyFromSettings` et `exportCompanyFromSettings` (même chose pour reçus, bons d'achat, devis). |
| Numéro de facture | Généré par le serveur : `{PREFIX}-{STORE}{POSTE}-{AAAA}-{NNNNNN}` (format modifiable dans Paramètres). |

### 6.5 `/achats` ✅

- **Permissions :** `purchases.*`.
- **API :** `GET /api/achats?store=…`, `POST /api/achats`, `GET/PUT /api/achats/[id]`, `GET /api/achats/stats?store=`.

L'entrée en stock se fait dans le magasin actif. À ajouter : StoreScopeSelect + colonne Magasin.

### 6.6 `/caisse` ✅

- **But :** une caisse par magasin.
- **Permissions :** `cash.view`, `cash.open`, `cash.close`, `cash.manual`.
- **API :**
  - `GET /api/caisse?store=…` (solde, résumé, mouvements) ;
  - `POST /api/caisse` `{ type: 'income'|'expense', amount, paymentMethod, motif, date }` (mouvement manuel, magasin actif) ;
  - `GET/POST /api/caisse/sessions` (ouverture/clôture de la session du magasin actif).

| Élément | Action |
|---|---|
| **Ouvrir la caisse** | Ouvre la session **du magasin actif**. Erreur si une session est déjà ouverte dans ce magasin. |
| **Clôturer** | Montant compté → écart calculé. |
| **Mouvement manuel** | Entrée / sortie hors document (`cash.manual`). |
| **StoreScopeSelect** (à ajouter) | En vue consolidée : solde de chaque magasin (lecture seule) ; les boutons d'ouverture, de clôture et de mouvement restent liés au magasin actif. |

### 6.7 `/depenses` ✅

- **Permissions :** `expenses.view/create/update/delete`, **`expenses.approve`**.
- **API :**
  - `GET /api/depenses?store=…&approvalStatus=pending|to_pay|approved|rejected|all` ;
  - `POST /api/depenses` → statut `pending` si montant > `expenseApprovalThreshold` et que l'auteur n'a pas `expenses.approve`, sinon `approved` (décaissée) ;
  - `POST /api/depenses/[id]/approbation` `{ decision: 'approve'|'reject', reason?, payNow? }` ;
  - `POST /api/depenses/[id]/decaisser` (dépense `to_pay` → sortie de caisse du magasin actif) ;
  - `GET /api/depenses/stats?store=` → `pendingCount`, `pendingAmount`, `byStore`.

| Élément | Action |
|---|---|
| Onglets / filtre **Statut** | Toutes · **En attente** · À décaisser · Décaissées · Rejetées. |
| Colonne **Statut d'approbation** (badge) | En attente (orange), À décaisser (bleu), Décaissée (vert), Rejetée (rouge). |
| Carte **« En attente d'approbation »** | `pendingCount` / `pendingAmount`. Clic → filtre « En attente ». |
| Bouton **Approuver** (ligne en attente, `expenses.approve`, **jamais sur sa propre dépense**) | Confirmation avec case « Décaisser tout de suite » (`payNow`, proposée seulement si l'approbateur travaille dans le magasin de la dépense). |
| Bouton **Rejeter** | Motif obligatoire → `decision: 'reject'`. |
| Bouton **Décaisser** (ligne « À décaisser ») | `POST …/decaisser`, depuis le magasin de la dépense. |
| **Nouvelle dépense** | Inchangé ; avertir « au-delà de X GNF, la dépense devra être approuvée » (seuil lu dans `useSettings()`). |

### 6.8 `/stocks` ✅

- **Permissions :** `stock.view`, `stock.adjust`.
- **API :**
  - `GET /api/stocks?store=…&detail=true` (en vue consolidée, chaque ligne détaille le stock par magasin et la quantité **en transit**) ;
  - `GET /api/stocks/summary?store=` ;
  - `GET /api/stocks/mouvements?store=…` ;
  - `POST /api/stocks/adjust` `{ productId, delta, motif }` (magasin actif uniquement).

| Élément | Action |
|---|---|
| **StoreScopeSelect** | Vue « Tous les magasins » : colonne par magasin (ou détail dépliable) + total. |
| **Ajuster** (ligne) | Écart signé + motif obligatoire. Refusé si le stock deviendrait négatif. Pour un comptage complet, préférer **Inventaires**. |
| Lien **Demander un transfert** (à ajouter, ligne en alerte) | Ouvre `/transferts/nouveau?productId=…`. |

### 6.9 `/produits` ✅

- **Permissions :** `products.view/create/update/delete`.
- **API :**
  - `GET /api/produits?store=…` (stock, seuil et prix du périmètre) ;
  - `POST /api/produits` (siège uniquement ; stock initial éventuel dans le magasin actif) ;
  - `PUT /api/produits/[id]` (`localSalePrice`, `localStockMin` = réglages du magasin actif) ;
  - `DELETE /api/produits/[id]` (désactivation, siège uniquement) ;
  - `GET /api/produits/stats?store=`.

| Élément | Action |
|---|---|
| **Nouveau produit**, **Modifier** (nom, catégorie, prix catalogue, code-barres…), **Désactiver** | Siège / autonome seulement. Sur un poste magasin, masqués, avec un bandeau « Catalogue géré au siège » ; le serveur renvoie sinon « Ces données sont gérées au siège… » (403) ou « Le catalogue est géré au siège : seuls le prix local, le seuil local et le stock du magasin sont modifiables ». |
| **Prix local** / **Seuil local** (à ajouter dans la modale d'édition) | Vide = valeur du catalogue. Le prix local n'est proposé que si `localPricesAllowed` ; sinon erreur « Les prix locaux sont désactivés dans les paramètres ». |
| Colonne **Prix** | Afficher le prix effectif et une mention « local » quand `localSalePrice` est défini. |
| Champ **Code-barres** | Nouveau champ `barcode`. |

### 6.10 `/clients`, `/fournisseurs` ⏳

Référentiel **commun** à tous les magasins. Les soldes et statistiques dépendent du
périmètre : `GET /api/clients?store=…`, `GET /api/clients/[id]?store=…`,
`GET /api/clients/stats?store=…` (idem fournisseurs, plus `GET /api/fournisseurs/[id]/paiements`).
À ajouter : StoreScopeSelect ; sur la fiche, tableau « par magasin » (`byStore`) et
colonne Magasin dans les dernières factures.

### 6.11 `/chantiers` ✅

Chaque chantier appartient à un magasin. API : `/api/chantiers?store=…`, `[id]`,
`[id]/devis`, `[id]/materiaux` (sortie de stock du magasin du chantier), `[id]/ouvriers`.
À ajouter : StoreScopeSelect et colonne Magasin. Les modifications ne sont possibles
que depuis le magasin du chantier.

### 6.12 `/soldes`, `/rapports` ⏳

- `/soldes` : `GET /api/soldes?store=…`. À ajouter : StoreScopeSelect.
- `/rapports` :
  - `GET /api/rapports?from=&to=&store=all|<id>` → `RapportData` avec `stores { ids, label }`,
    **`byStore`** (comparaison, avec `allocatedCentralCharges` selon `centralChargesAllocation`),
    **`transfers`**, **`inventories`** ;
  - `POST /api/rapports/envoyer` `{ period, channel, recipients, test, store }` ;
  - `GET /api/rapports/envois`.

  À ajouter :
  - StoreScopeSelect ;
  - section « Comparaison des magasins » (tableau + export CSV/PDF) ;
  - sections Transferts et Inventaires ;
  - le libellé du périmètre dans le titre et les exports.

  Les sections briqueterie/atelier ont été retirées.

### 6.13 `/recus` (paiements) ⏳

- `GET /api/recus?store=…`, `GET /api/paiements?store=…`, `POST /api/paiements` (magasin actif ;
  refusé si le document appartient à un autre magasin).
- Le reçu imprimé doit porter l'en-tête **du magasin**.
- À ajouter : StoreScopeSelect et colonne Magasin.

---
### 6.14 `/magasins` et `/magasins/[id]` — Gestion des magasins ✅

- **Permission :** `stores.view` pour lire, `stores.manage` pour écrire (siège seulement).
- **Composants prêts** dans `components/magasins/store-ui.tsx` : `StoreStatusBadge`, `StoreKindBadge`, `StoreFormModal`.

#### Liste `/magasins`

**API :** `GET /api/magasins?indicators=true&period=day|week|month|year&includeArchived=true`
→ `{ data: [StoreRow + indicators], period }`.

| Élément | Action |
|---|---|
| Bouton **Nouveau magasin** (`stores.manage`, masqué sur poste magasin) | Ouvre `StoreFormModal` : code (unique, 2-10 caractères), nom, type (Magasin / Siège), adresse, téléphone, e-mail, gérant (liste `GET /api/users?options=true`), date d'ouverture, horaires, pied de ticket, notes. **Enregistrer** → `POST /api/magasins`. Le magasin part **sans produit** ; champ « Produits de départ » pour recopier la liste d'un magasin existant (`copyAssortmentFrom`). Erreurs : « Ce code de magasin est déjà utilisé », « Le nom du magasin est obligatoire », 403 sur poste magasin. |
| Sélecteur **Période** | Aujourd'hui / Semaine / Mois / Année → recharge les indicateurs. |
| Case **Afficher les archivés** (admin) | `includeArchived=true`. |
| **Cartes** | Magasins actifs, CA de la période, créances, valeur du stock — chacune avec son infobulle. |
| **Tableau comparatif** | Magasin (code, nom, type, gérant), statut, CA, nb ventes, dépenses, créances, valeur du stock, alertes stock (panier moyen et équipe sont sur la fiche, pour tenir sans débordement). Clic sur une ligne → fiche. Ligne de **total réseau** en bas. |

#### Fiche `/magasins/[id]`

**API :** `GET /api/magasins/[id]` → `{ store, users, indicators, period }`.

| Élément | Action |
|---|---|
| Bouton **Modifier** | `StoreFormModal` prérempli → `PUT /api/magasins/[id]` (seuls les champs envoyés changent). |
| Bouton **Suspendre** | Confirmation + motif → `POST /api/magasins/[id]/statut` `{ status: 'suspended', reason }`. Le magasin reste consultable, mais plus aucune opération n'y est acceptée. |
| Bouton **Réactiver** | `{ status: 'active' }`. |
| Bouton **Archiver** | Confirmation → `{ status: 'archived', reason }`. Refusé avec message tant qu'une caisse est ouverte (« Clôturez la caisse du magasin avant de l'archiver ») ou qu'un transfert est en cours. |
| Onglet **Vue d'ensemble** | Cartes indicateurs. Sélecteur de dates → `GET /api/magasins/[id]/indicateurs?from=&to=`. |
| Onglet **Informations** | Coordonnées, gérant, horaires, pied de ticket. |
| Onglet **Équipe** | `users` : nom, rôle, gérant oui/non, période. Lien « Gérer les affectations » → `/utilisateurs?storeId=<id>`. |
| Onglet **Activité** (`audit.view`) | `GET /api/audit?store=<id>&central=false&limit=30` ; lien « Journal complet » → `/utilisateurs/historique?store=<id>`. |
| Bouton **Travailler dans ce magasin** | Visible si le magasin est dans `useAuth().stores` et n'est pas le magasin actif → `switchStore(id)`. |
| Raccourcis | Liens vers `/ventes`, `/stocks`, `/caisse`, `/transferts` avec `?store=<id>`. |

---

### 6.15 Transferts entre magasins ✅

**Cycle de vie** (statuts) :

```
brouillon ─soumettre─▶ en attente ─valider─▶ validé ─préparer─▶ en préparation ─expédier─▶ en transit
                           │ refuser                                               │
                           ▼                                         réceptionner (total)  ─▶ reçu
                        refusé          annuler (avant expédition) ─▶ annulé      réception partielle ─▶ partiellement reçu
                                                                                  clôture avec écart  ─▶ en litige ─clôturer─▶ reçu
```

- Si le paramètre **« Validation des transferts »** est désactivé, « soumettre » mène directement à « validé ».
- **Sortie de stock** à l'expédition (magasin source), **entrée** à la réception (destination).
- Libellés : `TRANSFER_STATUS_LABELS` / `TRANSFER_EVENT_LABELS` dans `lib/transfers.ts`. Ce module touche la base : **recopier** les libellés dans un fichier client (ex. `components/transferts/labels.ts`).
- Couleurs suggérées :
  - brouillon : gris ;
  - en attente : orange ;
  - validé et en préparation : bleu ;
  - en transit : violet ;
  - partiellement reçu : jaune ;
  - reçu : vert ;
  - litige et refusé : rouge ;
  - annulé : gris barré.

#### Liste `/transferts` (`transfers.view`)

**API :**
- `GET /api/transferts?store=&direction=incoming|outgoing|all&status=open|<statut>|all&search=&page=&limit=` ;
- `GET /api/transferts/compteurs?store=` → `{ toApprove, toShip, toReceive, disputed }`.

| Élément | Action |
|---|---|
| 4 **cartes compteurs** | À valider, À expédier, À recevoir, En litige (infobulle sur chacune). Un clic filtre la liste sur les mêmes transferts : `status=pending` ; `status=approved,preparing&direction=outgoing` ; `status=in_transit,partially_received&direction=incoming` ; `status=disputed`. `status` accepte une liste séparée par des virgules. |
| Onglets **Tous / Entrants / Sortants** | Paramètre `direction`. |
| Filtre **Statut** | Défaut « En cours » (`open`). |
| **Recherche** | Référence ou motif. |
| **StoreScopeSelect** | Paramètre `store`. |
| Tableau | Référence, date, source → destination, statut, nb lignes, quantités demandée / expédiée / reçue, demandeur. Clic → fiche. |
| Bouton **Nouveau transfert** (`transfers.create`) | → `/transferts/nouveau`. |

#### Création `/transferts/nouveau` (`transfers.create`)

| Élément | Action |
|---|---|
| **Magasin source** | Liste `GET /api/transferts/magasins` (annuaire des magasins actifs : `GET /api/magasins` ne renvoie à un gérant que ses magasins, or la source est le plus souvent un autre magasin). C'est le magasin qui **donne** la marchandise. Par défaut : le siège. |
| **Magasin destinataire** | Défaut : magasin actif. Doit être différent de la source. L'utilisateur doit appartenir à l'un des deux magasins. |
| **Motif**, **Date souhaitée**, **Notes** | Facultatifs. |
| **Lignes produits** | Catalogue de la source chargé une fois : `GET /api/transferts/disponible?source=<id>` → `[{ id, name, unit, barcode, available }]` (ni prix ni valeur ; `/api/stocks?store=<source>` serait refusé à un gérant du magasin destinataire). Quantité, **disponible à la source** affiché, avertissement si dépassé ; le blocage réel se fait à l'expédition. `?productId=` préremplit une ligne. |
| **Modifier** (brouillon / en attente) | Même page : `/transferts/nouveau?edit=<id>` → `POST /api/transferts/[id]` `{ action:'edit', … }` ; les magasins ne changent pas. |
| Bouton **Enregistrer le brouillon** | `POST /api/transferts` `{ sourceStoreId, destinationStoreId, reason, requestedDate, notes, items:[{productId, quantity}], submit:false }` → redirige vers la fiche. |
| Bouton **Soumettre la demande** | Même appel avec `submit: true`. |
| Erreurs | « Choisissez le magasin source et le magasin destinataire », « … doivent être différents », « Vous devez être affecté au magasin source ou au magasin destinataire », « Le magasin X n'accepte pas de nouvelles opérations », « Un transfert doit contenir au moins un produit », « Ligne N : la quantité doit être supérieure à zéro ». |

#### Fiche `/transferts/[id]`

**API :**
- `GET /api/transferts/[id]` → `{ transfer, items, events, actions }` ;
- `POST /api/transferts/[id]` `{ action, … }`.

> **N'afficher que les boutons présents dans `actions`** (calculés par
> `lib/transfer-actions.ts` selon le statut, les permissions et le **magasin actif**).

| Bouton (`action`) | Qui / où | Corps envoyé | Effet |
|---|---|---|---|
| **Modifier** (`edit`) | `transfers.create`, brouillon ou en attente | `{ action:'edit', reason?, requestedDate?, notes?, items? }` | Remplace les lignes. |
| **Soumettre** (`submit`) | brouillon | `{ action:'submit' }` | → en attente (ou validé si la validation est désactivée). |
| **Valider** (`approve`) | `transfers.approve`, depuis le magasin source ou compte multi-magasins | `{ action:'approve', note? }` | → validé. |
| **Refuser** (`refuse`) | idem | `{ action:'refuse', note }` (motif **obligatoire**) | → refusé. |
| **Préparer** (`prepare`) | `transfers.ship`, magasin actif = source | `{ action:'prepare' }` | → en préparation. |
| **Expédier** (`ship`) | `transfers.ship`, magasin actif = source | `{ action:'ship', quantities:{ [itemId]: qté }, note? }` — modale préremplie à la quantité demandée | Sortie du stock source → en transit. Erreurs : stock insuffisant, quantité > demandée, « Aucune quantité à expédier ». |
| **Réceptionner** (`receive`) | `transfers.receive`, magasin actif = destination | `{ action:'receive', quantities:{[itemId]: qté}, discrepancies:{[itemId]: 'texte'}, close: bool, note? }` — modale préremplie au reste en transit, commentaire d'écart par ligne, case « Clôturer la réception » | Entrée en stock. Tout reçu sans écart → reçu ; reste à recevoir → partiellement reçu ; `close` avec écart → **en litige**. |
| **Clôturer le litige** (`resolve`) | `transfers.approve` | `{ action:'resolve', note }` (obligatoire) | → reçu ; l'écart est constaté (perte / casse). |
| **Annuler** (`cancel`) | avant expédition | `{ action:'cancel', reason }` (obligatoire) | → annulé, aucun mouvement de stock. |

Autres zones de la fiche :

- **StageTracker** : Demande → Validation → Préparation → Transit → Réception.
- **Lignes** : demandé, expédié, reçu, en transit, commentaire d'écart.
- **Historique** (`events`) : date, étape, magasin, utilisateur, note.
- **Aide quand `actions` est vide** : par exemple « En attente d'expédition par *Magasin X*. La sortie de stock se fait depuis le magasin source : changez de magasin actif si vous y êtes affecté. »

---

### 6.16 Inventaires ✅

#### Liste `/inventaires` (`inventory.view`)

**API :** `GET /api/inventaires?store=&status=open|validated|cancelled|all`.

| Élément | Action |
|---|---|
| **StoreScopeSelect**, filtre **Statut** | — |
| Tableau | Référence, magasin, date, catégorie, statut, produits comptés / total, nb écarts, valeur des écarts (prix d'achat). |
| Bouton **Nouvel inventaire** (`inventory.manage`) | Modale : catégorie (facultative, `GET /api/produits/categories`), notes → `POST /api/inventaires` `{ categoryId?, notes? }`. L'inventaire s'ouvre **dans le magasin actif** et relève le stock théorique de chaque produit. Erreur : « Un inventaire est déjà en cours dans ce magasin (INV-…) ». |

#### Feuille de comptage `/inventaires/[id]`

**API :** `GET /api/inventaires/[id]` → `{ inventory, items, actions }`.

| Élément | Action |
|---|---|
| Tableau | Produit, stock théorique, **quantité comptée** (saisie ; vide = non compté), écart (vert +, rouge −), valeur de l'écart, justification. |
| Recherche + filtres | « Non comptés » / « Avec écart ». |
| Bouton **Enregistrer les comptages** (`count`) | `POST /api/inventaires/[id]` `{ action:'count', counts:[{ itemId, countedQuantity|null, justification? }] }`. Plusieurs passages possibles. |
| Bouton **Valider l'inventaire** (`validate`, `inventory.validate`) | Enregistre d'abord la saisie en cours, puis confirmation : nombre d'écarts et perte / surplus estimé. → `{ action:'validate' }` → réponse `result { adjustments, value }`. Erreurs : « Aucun comptage saisi », « Cet inventaire est déjà clôturé », « Justifiez chaque écart avant de valider… » (la justification est obligatoire pour tout écart). |
| Bouton **Annuler l'inventaire** (`cancel`) | Motif obligatoire → `{ action:'cancel', reason }` ; le stock n'est pas modifié. |
| Lecture seule | Si statut ≠ ouvert, ou si le magasin actif n'est pas celui de l'inventaire (message « Cet inventaire appartient à un autre magasin »). |

---

### 6.17 `/synchronisation` ✅ (réécrite, à relire et tester)

- **Permission :** `sync.manage` pour tout. Sans cette permission, la page n'affiche que l'état résumé.
- **API :**
  - `GET /api/sync/status` ;
  - `POST /api/sync/now` ;
  - `POST /api/sync/enroll` / `DELETE /api/sync/enroll` ;
  - `POST /api/sync/codes` ;
  - `GET /api/sync/devices`, `POST /api/sync/devices/[id]/revoke` ;
  - `GET /api/sync/conflits`, `POST /api/sync/conflits/[id]`.

| Élément | Action |
|---|---|
| Carte **Ce poste** | Mode (Autonome / Siège / Magasin + nom), nom et code du poste, serveur, dernier échange réussi, en attente, en quarantaine, conflits, dernière erreur. |
| Bouton **Synchroniser maintenant** (poste inscrit) | `POST /api/sync/now` → nombre de changements envoyés et reçus. Un seul cycle à la fois. La synchro automatique tourne aussi toutes les N minutes (`auto_sync_minutes`, défaut 5). |
| Formulaire **Relier ce poste au serveur** (poste autonome) | Adresse du serveur, nom du poste, type : **Poste du siège** (clé maîtresse = `ENROLL_MASTER_KEY` du serveur) ou **Poste de magasin** (code). → `POST /api/sync/enroll` `{ serverUrl, deviceName, masterKey? , code? }`. Un poste siège qui a déjà des données les envoie toutes au serveur. Un poste magasin ne peut être inscrit que sur une **base vide** (sinon passer par « Rejoindre le serveur » à la première installation). |
| Bouton **Déconnecter ce poste** | Confirmation → `DELETE /api/sync/enroll`. Le poste redevient autonome et garde ses données. |
| Section **Codes d'inscription** (siège) | Choisir le magasin → **Générer un code** → `POST /api/sync/codes` `{ storeId }` → code + expiration (7 jours), bouton **Copier**. À donner au responsable du poste magasin. |
| Section **Postes connectés** (siège) | `GET /api/sync/devices` : nom, magasin, mode, dernière connexion. Bouton **Révoquer** (confirmation) → `POST /api/sync/devices/[id]/revoke` : le poste ne peut plus synchroniser (poste volé, remplacé…). |
| Section **Conflits** | Même enregistrement modifié des deux côtés : valeur locale ↔ valeur serveur. Boutons **Garder la version du serveur** (`{ resolution:'remote' }`) / **Garder la version locale** (`{ resolution:'local' }`) → `POST /api/sync/conflits/[id]`. |
| Section **Quarantaine** | Lignes reçues dont le parent n'est pas encore arrivé. Elles sont rejouées automatiquement à chaque synchro. Lecture seule. |

---

### 6.18 `/parametres` ✅

| Section | À faire |
|---|---|
| Ancienne carte **Synchronisation** (`syncMode`, `syncApiUrl`, `syncIntervalMinutes`, `syncNumberBlockSize`) | **Supprimer** (c'est la cause des erreurs `tsc` actuelles). La remplacer par un lien « Gérer la synchronisation » → `/synchronisation`. |
| **Numérotation** | Ajouter `transferPrefix` (TRF), `inventoryPrefix` (INV), `invoiceNumberFormat` (défaut `{PREFIX}-{STORE}-{YYYY}-{NNNNNN}` ; aide : jetons `{PREFIX}` `{STORE}` `{YYYY}` `{NNNNNN}` ; `{STORE}` est ajouté automatiquement s'il manque). |
| **Multi-magasins** (nouvelle carte) | `expenseApprovalThreshold` (montant ; 0 = jamais d'approbation), `transferApprovalRequired` (case), `centralChargesAllocation` (« Au prorata du CA » / « À parts égales » / « Ne pas répartir » : dépenses du siège réparties sur les magasins dans la comparaison des rapports), `localPricesAllowed` (case). |
| **Sauvegarde automatique** | `autoBackupEnabled`, `backupExternalDir` (clé USB, disque réseau, dossier Drive synchronisé), `backupRetentionDays` ; afficher `storage.lastBackupAt`. La sauvegarde est vérifiée chaque heure par `lib/scheduler.ts`. |
| **Sauvegarde / Restauration / Réinitialisation** (existantes) | `GET /api/parametres/backup`, `POST /api/parametres/restore` (garde l'identité du poste), `POST /api/parametres/reset-data` (**refusée** sur un poste relié au serveur). |
| Poste magasin | Bandeau « Paramètres de l'entreprise gérés au siège ». Désactiver tous les champs sauf `LOCAL_ONLY_SETTINGS_KEYS` (thème, couleurs, barre latérale, passerelle de rapport, sauvegarde). Sinon le serveur renvoie 403. |
| Textes | Retirer toute mention de briqueterie, atelier, menuisiers, briquetiers. |

Enregistrement : `PUT /api/parametres` (`settings.update`).

---

### 6.19 `/utilisateurs` et `/utilisateurs/historique` ✅

- **Permission :** `users.manage` (lecture comprise) ; `audit.view` pour l'historique.
- **Règles serveur** (`lib/user-scope.ts`) :
  - un **gérant** ne voit et ne modifie que les comptes affectés à ses magasins ;
  - il ne peut ni créer ni modifier un administrateur ;
  - il n'affecte qu'à ses magasins ;
  - toute écriture sur les comptes se fait **au siège** (403 sur poste magasin).

| Élément | Action |
|---|---|
| Filtre **Magasin** | `GET /api/users?storeId=<id>` ; prérempli par `/utilisateurs?storeId=<id>` (lien de la fiche magasin). |
| Colonne **Magasins** | Badges des codes de magasins (`stores`), mention « gérant ». L'identifiant est affiché sous le nom ; la colonne Téléphone a été retirée pour que les 5 actions restent visibles. |
| Bouton **Magasins** (icône magasin, ligne) | Ouvre `StoreAssignmentsModal`. Masqué sur un poste magasin, et sur les comptes administrateurs pour un gérant. |
| **Nouvel utilisateur** | Ajouter la section **Magasins affectés** : une case par magasin + case « gérant ». Rôle « Administrateur » masqué si `!allStores`. → `POST /api/users` `{ name, username, password, role, phone, stores:[{storeId, isManager}] }`. Erreurs : « Affectez ce compte à au moins un magasin », « Seul un administrateur général peut attribuer le rôle Administrateur », « Vous ne pouvez affecter un compte qu'à vos propres magasins ». |
| Onglet **Magasins** de la fiche | `GET /api/users/[id]/magasins` puis **Enregistrer** → `PUT /api/users/[id]/magasins` `{ stores:[{storeId, isManager, startsAt?, endsAt?}] }`. Prévenir : « Les sessions ouvertes de ce compte seront fermées. » |
| **Modifier / Désactiver / Mot de passe / Permissions** (existants) | `PUT/DELETE /api/users/[id]`, `PUT /api/users/[id]/password`, `PUT/DELETE /api/users/[id]/permissions`. Changer le rôle, désactiver le compte ou changer le mot de passe ferme ses sessions. On ne peut pas désactiver son propre compte. La matrice affiche le nouveau groupe « Magasins ». |
| **Historique** | Ajouter StoreScopeSelect (`GET /api/audit?store=…`) et une colonne **Magasin** (`storeName`). Nouvelles actions journalisées : approve, reject, sync, changement de magasin actif. |

---

## 7. Serveur central : installation sur VPS

Dossier `server/` (Node 20+, `pg`). Fichiers : `index.mjs`, `Dockerfile`, `docker-compose.yml` (PostgreSQL 16, serveur de synchro, Caddy pour HTTPS automatique, sauvegarde `pg_dump` quotidienne), `Caddyfile`, `.env.example`.

1. Louer un VPS (Ubuntu 22/24, 1 vCPU, 1-2 Go de RAM suffisent) et installer Docker.
2. Créer un enregistrement DNS `A` : `sync.mon-domaine.com` → IP du VPS.
3. Copier le dossier `server/` sur le VPS, puis `cp .env.example .env` et remplir :
   - `SYNC_DOMAIN=sync.mon-domaine.com` ;
   - `POSTGRES_PASSWORD=<long mot de passe aléatoire>` ;
   - `ENROLL_MASTER_KEY=<clé secrète du siège>`.
4. `docker compose up -d`, puis vérifier `https://sync.mon-domaine.com/api/health` → `{ ok: true }`.
5. Routes du serveur :
   - `/api/health` ;
   - `POST /api/devices/enroll` ;
   - `POST /api/sync/push` ;
   - `GET /api/sync/pull` ;
   - `GET /api/sync/status` ;
   - `POST /api/admin/enroll-codes` ;
   - `GET /api/admin/devices` ;
   - `POST /api/admin/devices/:id/revoke`.

   Les tables sont créées automatiquement au démarrage (`migrate`).

## 8. Mise en service d'un réseau de magasins

1. **Poste du siège** (le PC actuel, avec ses données) :
   - mettre à jour l'application ; la migration crée le magasin `PRINC` avec tout l'historique ;
   - dans `/magasins`, modifier `PRINC` (nom, code), ou créer un magasin de type **Siège** ;
   - créer les autres magasins (ex. `KAL` Kaloum, `MAT` Matoto) ;
   - dans `/utilisateurs`, créer les comptes et les affecter ;
   - dans `/synchronisation` → **Relier ce poste au serveur** : adresse + **clé maîtresse**. Toutes les données partent vers le serveur.
2. **Pour chaque poste de magasin** :
   - au siège, `/synchronisation` → **Codes d'inscription** → choisir le magasin → **Générer un code** ;
   - sur le nouveau PC, installer l'application → écran de première installation → **Rejoindre le serveur** → adresse + code + nom du poste → **Inscrire ce poste** ;
   - se connecter avec un compte affecté à ce magasin.
3. Au quotidien, chaque poste travaille hors ligne et synchronise automatiquement toutes les 5 minutes, ou à la demande avec **Synchroniser maintenant**. Le siège voit tous les magasins via « Tous les magasins ».

## 9. Vérifications et tests

À exécuter dans l'ordre :

1. `npx tsc --noEmit -p .` → 0 erreur.
2. `npm run build`.
3. **Migration d'une ancienne base** : copier une `database.db` de la version précédente, démarrer, puis vérifier :
   - copie de sécurité « avant-migration » dans `backups/` ;
   - magasin `PRINC` ;
   - stocks identiques (`product_stocks` = somme des mouvements) ;
   - factures rattachées.
4. **Démonstration** : sur une base vierge, `npm run demo:seed` (ou Paramètres → données de démonstration en développement) : magasins SIEGE / KAL / MAT ; comptes `gerant.kaloum`, `vendeur.kaloum`, `gerant.matoto`, `vendeur.matoto`, `magasinier.siege`, mot de passe `demo1234` ; 13 mois d'activité, tous les statuts.
5. **Cloisonnement** :
   - connecté en `vendeur.kaloum`, `GET /api/ventes?store=<id MAT>` doit renvoyer 403 ;
   - une vente créée doit avoir `store_id` = KAL.
6. **Synchronisation réelle** : lancer le serveur avec un PostgreSQL local et deux bases clientes (siège + magasin), puis vérifier :
   - une vente faite au magasin apparaît au siège ;
   - un produit créé au siège apparaît au magasin ;
   - un transfert SIEGE → KAL va de bout en bout (expédition au siège, réception à KAL) ;
   - deux ventes hors ligne simultanées ne produisent pas le même numéro.
7. `npm run verify:routes` (aucune erreur 500). Les scripts `verify:brick*` ont été supprimés : retirer leurs entrées de `package.json` si elles y sont encore.

## 10. Ordre de travail recommandé pour terminer

1. **Paramètres** (§6.18) : débloque `tsc` et `next build`.
2. **Magasins** (§6.14) : nécessaire pour créer le réseau.
3. **Utilisateurs** (§6.19) : affectations.
4. **Transferts** (§6.15) puis **Inventaires** (§6.16).
5. **Dépenses** (approbation, §6.7) et **Produits** (prix local, §6.9).
6. `StoreScopeSelect` + colonne Magasin sur toutes les listes (§6.3 à §6.13), **en-têtes de factures et reçus** par magasin.
7. Tableau de bord et rapports consolidés.
8. README / AGENTS, vérifications du §9, puis commit.

> **Consigne pour une IA qui reprend :** une page à la fois. Après chaque page,
> `npx tsc --noEmit -p .`, puis test dans le navigateur (`npm run dev`) avec deux
> comptes de magasins différents. Ne modifiez `lib/` ou `app/api/` que si un
> contrat manque, et documentez-le alors dans le commentaire de la route.
