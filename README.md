# Planète Déco Sarlu — Filiale Meubles

## Système de gestion commerciale, ventes et stocks

Application de gestion complète pour **Planète Déco Sarlu (filiale Meubles)** : ventes, achats, stocks, caisse, dépenses, dettes, bénéfices, rapports, prestations de chantier, briqueterie et atelier de meubles.

> **Statut : ✅ LOT 0 À 4 CONSTRUITS — v1.3.0**
> Ce fichier reste le **contrat de conception**, mais il n'est plus seulement un
> document : l'application est **développée, vérifiée et empaquetée**.
>
> | Livré | État |
> |---|---|
> | Lot 0 — Socle (DB, design system, auth, rôles, paramètres, Electron) | ✅ |
> | Lot 1 — Cœur commercial (dashboard, clients, fournisseurs, produits, stocks, achats, ventes, factures, reçus) | ✅ |
> | Lot 2 — Gestion financière (caisse, dépenses, soldes, rapports, utilisateurs, audit, sauvegarde/restauration) | ✅ |
> | Lot 3 — Chantiers + briqueterie | ✅ |
> | Lot 4 — Atelier de meubles | ✅ |
> | Installateur Windows (`release/Planete-Deco-Setup-1.3.0.exe`) | ✅ testé au démarrage |
> | Lot 5 — Évolutions (scanner, ticket thermique, multi-magasins) | ⏳ backlog |
> | Lot 6 — Service de synchronisation PostgreSQL en ligne | ⏳ option ; l'écran, la file d'attente et l'export/import manuel sont livrés, **le serveur en ligne ne l'est pas** |
>
> **Ajouts demandés par le client après la v1.3** :
> - **permissions par utilisateur** (§17.4) — l'administrateur accorde ou retire
>   chaque action, utilisateur par utilisateur ; *seul l'administrateur a droit à
>   tout*, et son propre accès ne peut pas être restreint ;
> - **module Achats complet** (§7.5, §14) — le lien « Achats » du menu menait à
>   une page 404 : le module est désormais livré (`/achats`, `/achats/nouvelle`,
>   `/achats/[id]`, numérotation `ACH-…`, entrée de stock, sortie de caisse,
>   dette fournisseur, reçu imprimable).
>
> **Vérifications passées** : `tsc --noEmit` sans erreur ; `next build` réussi
> **avec le contrôle des types activé** — 107 entrées de route, soit **34 pages
> et 71 routes d'API** ; `npm run verify:routes` (107/107, aucune erreur 500) ;
> `npm run verify:purchases` (21/21 : numérotation, total, paiement partiel,
> dette fournisseur, variation de stock, sortie de caisse, mouvement tracé) ;
> `npm run verify:export` (image et PDF générés dans un vrai navigateur) ;
> parcours de vente vérifié de bout en bout (numérotation, TVA, stock décimal,
> acompte, solde, reçu, caisse, journal).
>
> Voir la section [24. Points à valider](#24-points-à-valider--questions-ouvertes)
> pour les décisions qui attendent encore une réponse du client.

**Historique du document**

| Version | Contenu |
|---|---|
| 1.0 | Première conception : héritage du projet Gaz, modales, paramètres, création de ventes, 18 chapitres du cahier des charges, lots de livraison |
| **1.1** | **Intégration du schéma de base de données fourni par le client** (`Schema_BDD_Planete_Deco_Sarlu.pdf`). Le schéma client est conservé et corrigé sur **9 points bloquants** (§6.2) : TVA et total HT, échéance de crédit, matières premières de la briqueterie, types et dimensions des briques reliés au stock, fiche modèle et nomenclature des meubles, journal des actions, moyen de paiement et origine sur la caisse, écart de clôture, traçabilité des annulations. Nommage **anglais** (réutilisation du code Gaz) et paramètres **clé/valeur** typés. Schéma cible : **30 tables** (§6.3), avec la liste explicite de ce qu'on refuse de créer (§6.6) |
| **1.2** | **Synchronisation avec PostgreSQL en ligne, en option** (§23). Deux modes : **A** sauvegarde unidirectionnelle, **B** multi-postes bidirectionnel. Colonnes `sync_id` / `updated_at` / `deleted_at` / `origin_device_id` sur les 30 tables métier + 5 tables locales (§6.7). Traite l'identité globale (UUID), les références entre tables, l'idempotence, les conflits et la **numérotation des factures en multi-postes** (§23.8) |
| **1.3** | **Design system et responsive** (§5.3 à §5.5) : jetons de design, règle « aucune couleur en dur », 5 états obligatoires par écran, bibliothèque de composants, **sidebar à 6 groupes et repliable**, contrat responsive par page et **matrice de recette** à 5 colonnes. **Politique de versions** (§4) : installation de la **dernière version stable** de chaque bibliothèque, avec relevé des versions publiées et nommage explicite des écarts de majeure à re-vérifier au lot 0 |

![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=flat&logo=next.js)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat&logo=react)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat&logo=sqlite)
![Drizzle ORM](https://img.shields.io/badge/Drizzle-ORM-FFFFFF?style=flat&logo=drizzle)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38BDF8?style=flat&logo=tailwind-css)
![DaisyUI](https://img.shields.io/badge/DaisyUI-5.5-5B23E0?style=flat&logo=daisyui)
![Electron](https://img.shields.io/badge/Electron-42-47848F?style=flat&logo=electron)

---

## Table des matières

1. [Contexte et objectif](#1-contexte-et-objectif)
2. [Couverture du cahier des charges](#2-couverture-du-cahier-des-charges)
3. [Héritage du projet Gaz](#3-héritage-du-projet-gaz--ce-quon-reprend-et-pourquoi)
4. [Stack technique](#4-stack-technique)
5. [Architecture et structure du projet](#5-architecture-et-structure-du-projet)
6. [Base de données](#6-base-de-données)
7. [Modules fonctionnels](#7-modules-fonctionnels)
8. [La manière d'utiliser les modales](#8-la-manière-dutiliser-les-modales)
9. [Les paramètres](#9-les-paramètres)
10. [La création de ventes](#10-la-création-de-ventes)
11. [Factures, reçus, impressions et exports](#11-factures-reçus-impressions-et-exports)
12. [Stock et inventaire](#12-stock-et-inventaire)
13. [Caisse et solde](#13-caisse-et-solde)
14. [Achats et dépenses](#14-achats-et-dépenses)
15. [Soldes, dettes et bénéfices](#15-soldes-dettes-et-bénéfices)
16. [Rapports et envoi SMS / WhatsApp](#16-rapports-et-envoi-sms--whatsapp)
17. [Utilisateurs, rôles et historique des actions](#17-utilisateurs-rôles-et-historique-des-actions)
18. [Sauvegarde, restauration et sécurité](#18-sauvegarde-restauration-et-sécurité)
19. [Prestations de services (chantiers)](#19-prestations-de-services-chantiers)
20. [Gestion de la briqueterie](#20-gestion-de-la-briqueterie)
21. [Gestion de l'atelier de meubles](#21-gestion-de-latelier-de-meubles)
22. [Application desktop (Electron)](#22-application-desktop-electron)
23. [Synchronisation avec PostgreSQL (option en ligne)](#23-synchronisation-avec-postgresql-option-en-ligne)
24. [Points à valider / questions ouvertes](#24-points-à-valider--questions-ouvertes)
25. [Lots de livraison](#25-lots-de-livraison)
26. [Conventions de code](#26-conventions-de-code)
27. [Annexes : pages, API REST, scripts](#27-annexes--pages-api-rest-scripts)

---

## 1. Contexte et objectif

**Client** : Planète Déco Sarlu — filiale Meubles.
**Devise** : GNF (Franc Guinéen).
**Documents sources** :
- `CCahier_des_charges_Planete_Deco_Sarlu-6.pdf` — 18 chapitres (cahier des charges validé côté client).
- Projet de référence : `C:\laragon\www\projectgaz` — application de distribution de bouteilles de gaz, **déjà en production**, dont on reprend l'architecture, les bibliothèques et les patrons d'interface.

**Objectif** : un logiciel de gestion installable sur Windows, fonctionnant **localement sans Internet**, avec interface simple, impression et PDF, couvrant les 18 chapitres du cahier des charges.

**Principe directeur** : *ne rien réinventer*. Toute brique déjà éprouvée dans le projet Gaz (modales, paramètres, création de vente, moteur de stock, exports, retour arrière, desktop Electron) est reprise **à l'identique**, puis étendue aux besoins propres à Planète Déco.

---

## 2. Couverture du cahier des charges

| # | Chapitre du cahier des charges | Module de l'application | Lot |
|---|---|---|---|
| 1 | Tableau de bord | `/` — Dashboard | **1** |
| 2 | Clients | `/clients` | **1** |
| 3 | Fournisseurs | `/fournisseurs` | **1** |
| 4 | Produits et stocks | `/produits`, `/stocks` | **1** |
| 5 | Achats | `/achats` | **1** |
| 6 | Ventes | `/ventes`, `/ventes/nouvelle` | **1** |
| 7 | Factures et reçus | `/ventes/[id]`, `/recus/[id]` | **1** |
| 8 | Caisse et solde | `/caisse` | **2** |
| 9 | Dépenses | `/depenses` | **2** |
| 10 | Soldes, dettes et bénéfices | `/soldes` | **2** |
| 11 | Rapports (+ SMS/WhatsApp) | `/rapports` | **2** |
| 12 | Utilisateurs | `/utilisateurs` | **2** |
| 13 | Paramètres | `/parametres` | **1 → 2** |
| 14 | Sauvegarde et sécurité | `/parametres` (sauvegarde/restauration) | **2** |
| 15 | Livraison et évolutions | Electron + backlog | **1 → 4** |
| 16 | Prestations de services (chantiers) | `/chantiers` | **3** |
| 17 | Gestion de la briqueterie | `/briqueterie` | **3** |
| 18 | Gestion de l'atelier de meubles | `/atelier` | **4** |

**Total : 18/18 chapitres couverts.** Les chapitres 1 à 15 (le cœur commercial) constituent les lots 1 et 2 ; les chapitres 16 à 18 (métiers spécifiques) sont les lots 3 et 4.

---

## 3. Héritage du projet Gaz — ce qu'on reprend, et pourquoi

### 3.1 Repris **tel quel** (copie de fichier, zéro modification)

| Fichier du projet Gaz | Rôle | Pourquoi on le garde tel quel |
|---|---|---|
| `components/modal.tsx` | Modale animée (framer-motion) | API stable et complète : `size`, `fullScreenMobile`, overlay cliquable |
| `components/app-shell.tsx` | Sidebar + drawer mobile + carte utilisateur | Structure conservée, **enrichie** : navigation à 6 groupes, sidebar **repliable**, filtrage par rôle, indicateur de synchronisation ([§5.4](#54-le-sidebar-et-la-navigation)) |
| `components/page-header.tsx` | En-tête de page + bouton retour | Utilisé par 17 pages dans Gaz |
| `components/back-button.tsx` | `router.back()` (vraie traversée d'historique) | Indispensable en desktop : aucune barre d'outils Electron |
| `components/responsive-table.tsx` | Tableau desktop ⇄ cards mobile | Évite tout `overflow-x-auto` |
| `components/search-filter.tsx` | `useSearchFilter`, `SearchBar`, `FilterSelect`, `Pagination` | Recherche + filtre + pagination uniformes |
| `components/surface-card.tsx` | Carte de contenu générique | Vocabulaire visuel homogène |
| `components/metric-card.tsx` | Carte d'indicateur | Utilisé par le dashboard |
| `components/date-picker.tsx` | `react-datepicker` en français (jj/mm/aaaa) | Format local, popper géré |
| `components/theme-provider.tsx` + `theme-toggle.tsx` | Thème clair/sombre | Contexte + bascule |
| `components/auth-provider.tsx` | Contexte d'authentification | `useAuth()` : user, login, logout, isLoading |
| `components/scroll-restoration.tsx` | Signal « route rendue » pour le retour arrière | Monté 1 fois dans `layout.tsx` |
| `lib/scroll-engine.ts` | Position de scroll par entrée d'historique | Le retour arrière restaure la position exacte |
| `lib/view-state.ts` | État de vue des listes (page, recherche, filtres) | Restauration exacte de la liste au retour |
| `lib/colors.ts` | Couleurs configurables en OKLCH | Personnalisation temps réel sans rebuild |
| `lib/date-format.ts` | `formatDateShort`, `formatDateLong`, `formatDateTime`… | Affichage français homogène |
| `lib/invoice-export.ts` | Capture HTML → PDF / PNG | Export factures et rapports |
| `components/export-dropdown.tsx` | Dropdown PDF / Image / WhatsApp + `generateInvoiceBlob`, `shareOnWhatsApp` | Un seul composant pour tous les exports |
| `proxy.ts` | Protection des routes + jeton d'accès desktop | Sécurité desktop (voir §18) |
| `db/index.ts` | Connexion libSQL + migrations + helpers SQL bruts | Verrou de migration, WAL, journalisation |
| `electron/main.js`, `electron/preload.js` | Application desktop + auto-update | Jeton, port libre, `electron-updater` |
| `.github/workflows/release.yml` | Build Windows/macOS/Linux sur tag `v*` | Publication automatique |
| `scripts/copy-standalone.js`, `after-pack.js`, `release.js` | Packaging et release | Flux de livraison éprouvé |

### 3.2 Repris et **adapté** au métier Planète Déco

| Élément du projet Gaz | Adaptation Planète Déco |
|---|---|
| Table `products.capacity` (« 3 kg », « 6 kg ») | Remplacé par **catégorie + unité** (pièce, ensemble, carton, m²) et une **quantité décimale** (le m² n'est pas entier) |
| Table `products` = bouteilles uniquement | `categories.kind` : `finished` (produit fini vendable), `raw_material` (matière première), `service` (prestation). **Un seul moteur de stock** pour tout |
| `products.unit_price` (prix d'achat, nom ambigu) | Renommé **`purchase_price`** — le nom `unit_price` reste réservé au prix unitaire de vente des lignes de facture |
| `depenses` = factures d'achat fournisseur | Séparation nette : **`/achats`** (marchandises, met à jour le stock) et **`/depenses`** (transport, loyer, salaire, carburant, électricité — ne touche pas le stock, sort de caisse) |
| Facture de vente : total simple | Ajout **remise**, **TVA**, **total HT**, **échéancier de crédit** et **reçus de paiement** (`payments`) |
| `wallet_transactions` (portefeuille) | Devient la **Caisse** avec **ouverture / clôture journalière** (`cash_sessions`) et **séparation Espèces / Mobile Money** |
| Table `settings` à une ligne typée | Devient **clé/valeur** (`key`, `value`) **+ couche typée** `lib/settings.ts` : ajouter un réglage ne demande plus de migration |
| Rôles `admin` / `user` | **6 rôles** : admin, gérant, vendeur/caissier, magasinier, menuisier, briquetier + **journal d'actions** (`audit_logs`) |
| Hachage SHA-256 sans sel | **scrypt** (`node:crypto`), salé — sans dépendance supplémentaire |
| Sauvegarde = téléchargement du `.db` | Ajout de la **restauration** d'une sauvegarde (voir §24, question Q6) |
| Aucun envoi de rapport | Module d'envoi **SMS / WhatsApp** + table `report_deliveries` |
| `lib/stock.ts`, `lib/products.ts`, `lib/operations.ts` | **Logique réutilisée**, colonnes réalignées : `stock`, `stock_min`, `code`, `sale_price`, `payment_status`, `is_active` gardent les noms de Gaz |
| — | Nouveaux modules : **chantiers**, **briqueterie**, **atelier meubles** |

### 3.3 Le schéma de base de données fourni par le client

Le document `Schema_BDD_Planete_Deco_Sarlu.pdf` (24 tables en français) sert de **base de départ**. Décision retenue :

- **Structure conservée** : un seul journal de stock (`mouvements_stock`), une seule table de paiements polymorphe (`paiements`), le type porté par la catégorie, la caisse avec clôture, les 6 rôles. Ces choix sont bons et sont repris.
- **Nommage traduit en anglais** et aligné sur les conventions exactes du projet Gaz (`snake_case`, tables au pluriel) — c'est ce qui permet de réutiliser le code existant au lieu de le réécrire. L'interface reste intégralement en français.
- **9 correctifs obligatoires** appliqués, parce que sans eux des fonctionnalités du cahier des charges sont impossibles : TVA et total HT (§7), échéance de crédit (§7), matières premières de la briqueterie (§17), types et dimensions des briques reliés au stock (§17), fiche modèle et nomenclature des meubles (§18), journal des actions (§12, §14), moyen de paiement et origine sur la caisse (§8), montant théorique et écart de clôture (§8), traçabilité des annulations (§6).
- **Une incohérence corrigée** : la main-d'œuvre était modélisée de 3 façons différentes selon le module. Elle passe par une **seule table `workers`**.

Le détail complet (correspondance table par table, schéma cible de 30 tables métier, colonnes de synchronisation et ce qu'on refuse de créer) est en [§6](#6-base-de-données).

### 3.4 Ce qu'on ne reprend **PAS** du projet Gaz (dette technique identifiée)

| Élément | Décision | Raison |
|---|---|---|
| **Backdoor admin en dur** dans `app/api/auth/login/route.ts` (`boubacar` / `1265`) | ❌ **Supprimé** | Faille de sécurité : un compte connu contourne la base. À retirer également du projet Gaz. |
| `db/helpers.ts` (`findPurchaseInvoices`) | ❌ **Non repris** | Code mort, importé nulle part dans Gaz |
| `db/database.db-shm`, `-wal`, `db-error.log`, `tmp-libsql-test.db` | ❌ **Non repris** | Fichiers de travail, à ignorer via `.gitignore` |
| `next.config.ts` → `typescript.ignoreBuildErrors: true` | ✅ **Retiré** | La proposition était de le garder au lot 1 puis de le retirer au lot 2. C'est fait : `tsc --noEmit` passe **sans aucune erreur** sur tout le projet, donc `npm run build` échoue désormais si un type est faux — le build redevient une vraie barrière |
| `/portefeuille` (nom générique) | Renommé **`/caisse`** | Vocabulaire du cahier des charges (§8) |
| Textes dupliqués « Especes » / « Espèces » | Un seul libellé normalisé | Uniformité des libellés en base |

---

## 4. Stack technique

**Politique de versions : on installe la dernière version stable disponible de chaque bibliothèque**, et non les versions figées du projet Gaz. Les versions ci-dessous sont celles **publiées sur le registre npm au moment de la rédaction** (relevé direct via `npm view <paquet> version`). Elles seront **re-résolues à l'installation** et figées exactement dans `package-lock.json`.

> **Pourquoi c'est un vrai choix, et pas un détail.** Le projet Gaz sert de référence de code : passer d'une majeure à l'autre peut casser des composants repris tels quels. La colonne « Écart » ci-dessous nomme **exactement** ce qu'il faudra re-vérifier au lot 0. Le principe retenu : **dernière version + vérification ciblée**, plutôt que versions anciennes + dette qui s'accumule.

### 4.1 Dépendances de production

| Paquet | Dernière version | Version Gaz | Écart | Usage |
|---|---|---|---|---|
| `next` | `16.3.6` | `16.2.1` | mineure | Framework (App Router, `proxy.ts`) |
| `react` / `react-dom` | `19.3.0` | `19.2.4` | mineure | Interface |
| `@libsql/client` | `0.18.0` | `0.17.4` | **mineure — à vérifier** | Driver SQLite local. ⚠️ **Contrôler que le sous-chemin `@libsql/client/sqlite3` existe toujours** : `db/index.ts` en dépend |
| `drizzle-orm` | `0.45.3` | `0.45.2` | patch | ORM + relations + migrator |
| `daisyui` | `5.7.43` | `5.5.19` | mineure | Composants (thèmes `light`, `dark`) |
| `tailwindcss` | `4.3.3` | `4.2.2` | mineure | Styles utilitaires |
| `chart.js` / `react-chartjs-2` | `4.5.1` / `5.3.1` | identique | — | Graphiques du dashboard et des rapports |
| `framer-motion` | `13.4.1` | `12.38.0` | **MAJEURE** | Animations. ⚠️ **Re-tester `modal.tsx`, `app-shell.tsx` (drawer) et les transitions de page** |
| `react-toastify` | `11.1.0` | `11.0.5` | mineure | Notifications (`toast.success` / `toast.error`) |
| `react-datepicker` | `9.1.0` | identique | — | Sélecteur de date français |
| `html2canvas` | `1.4.1` | identique | — | Capture HTML → PNG |
| `jspdf` | `4.2.1` | identique | — | Génération PDF |
| `sharp` | `0.35.4` | `0.35.3` | patch | Optimisation des images Next |
| `electron-updater` | `6.8.9` | identique | — | Mise à jour automatique desktop |
| `postgres` *(serveur, §23)* | `3.4.9` | — | nouveau | Client PostgreSQL |
| `fastify` *(serveur, §23)* | `5.12.5` | — | nouveau | API de synchronisation |
| `zod` *(serveur, §23)* | `4.6.5` | — | nouveau | Validation des payloads (API v4) |

### 4.2 Dépendances de développement

| Paquet | Dernière version | Version Gaz | Écart | Usage |
|---|---|---|---|---|
| `electron` | `44.4.4` | `42.4.1` | **MAJEURE** | Application desktop. ⚠️ Re-tester `electron/main.js` (fork, `webRequest`, auto-update) |
| `electron-builder` | `26.15.3` | identique | — | Installateurs Windows/macOS/Linux |
| `drizzle-kit` | `0.31.11` | `0.31.10` | patch | `db:generate`, `db:push`, `db:studio` |
| `typescript` | `7.0.2` | `^5` | **MAJEURE** | ⚠️ **Le plus gros risque du lot 0** : TypeScript 7 est une réécriture. Vérifier la compatibilité de `eslint-config-next`, `drizzle-kit` et du plugin Next. **Repli documenté : TypeScript 5.9 LTS si l'outillage casse** |
| `eslint` / `eslint-config-next` | `10.11.0` / `16.3.6` | `^9` / `16.2.1` | **MAJEURE** | ⚠️ Vérifier les *peer dependencies* entre ESLint 10 et `eslint-config-next` |
| `@tailwindcss/postcss` | `4.3.3` | `4.2.2` | mineure | Pipeline CSS |
| `concurrently` / `wait-on` | `10.0.5` / `9.1.0` | `^9.2.1` / `^8.0.4` | **majeure** / mineure | Mode `dev:desktop` |
| `@types/node` | `26.6.2` | `^20` | **MAJEURE** | Typage Node — aligner sur la version de Node utilisée |
| `@types/react` / `@types/react-dom` | `19.3.0` | `^19` | mineure | Typage React |
| `@types/react-datepicker` | `7.0.0` | `^6.2.0` | **incohérent** | ⚠️ **Version de types en avance sur `react-datepicker@9`** : probablement inutile (les types sont désormais fournis par le paquet). **À tester sans**, sinon conflit de types |
| `@zxing/browser` | `0.2.1` | — | lot 5 | Lecture code-barres |

### 4.3 Ajouts envisagés (à valider — voir Q9)

| Besoin | Option proposée | Décision |
|---|---|---|
| Envoi WhatsApp automatique | API WhatsApp Cloud (Meta) via `fetch` | À valider |
| Envoi SMS | Passerelle opérateur (Orange Guinée / Nexah) ou Twilio | À valider |
| Génération Excel | **CSV natif** (sans dépendance) ou `xlsx` | **CSV** — voir l'avertissement ci-dessous |
| Export Word éventuel | `docx` | Non retenu en lot 1 |
| Lecture code-barres (backlog §15) | `@zxing/browser` | Lot 5 |

> ⚠️ **`xlsx` n'est pas retenu.** La dernière version publiée sur npm est `0.18.5`, **ancienne et porteuse de vulnérabilités connues** (SheetJS publie désormais hors npm). Le besoin « export Excel » du §11 est couvert par un **export CSV** (avec séparateur `;` et BOM UTF-8 pour qu'Excel l'ouvre correctement en français, sans aucune dépendance).

### 4.4 Dépendances du service de synchronisation (côté serveur uniquement)

La synchronisation PostgreSQL ([§23](#23-synchronisation-avec-postgresql-option-en-ligne)) ajoute des dépendances **exclusivement au service en ligne**, jamais au poste de travail : le poste utilise `fetch`, déjà présent.

| Paquet | Dernière version | Usage |
|---|---|---|
| `postgres` (postgres.js) | `3.4.9` | Client PostgreSQL |
| `drizzle-orm/postgres-js` | `0.45.3` | ORM côté serveur (le même Drizzle, une seconde cible) |
| `fastify` (ou `node:http` nu) | `5.12.5` | Service HTTP de synchronisation |
| `zod` | `4.6.5` | Validation des payloads entrants (API v4) |

> Aucune dépendance de synchronisation n'est embarquée dans l'application desktop : si le serveur évolue, les postes n'ont pas besoin d'être reconstruits.

### 4.5 Politique de versions et procédure d'installation

| Règle | Détail |
|---|---|
| **Dernière version stable** | Chaque paquet est installé avec `npm install <paquet>@latest`. On n'installe **pas** les versions du projet Gaz |
| **Versions figées** | `package-lock.json` est **versionné** : les versions exactes résolues sont figées, les installations suivantes sont reproductibles. Pas de `^`/`~` dans `package.json` |
| **Contrôle avant chaque lot** | `npx npm-check-updates` puis `npm outdated` : on sait ce qui a bougé avant de coder |
| **Repli documenté** | Si une majeure casse l'outillage, on **redescend d'une majeure** et on l'inscrit ici. Aucun `--force`, aucun `--legacy-peer-deps` silencieux |
| **Node.js** | Version **LTS** courante. Electron embarque son propre Node : la cible du poste est celle d'Electron, pas celle du serveur |
| **Une dépendance = une justification** | Toute nouvelle bibliothèque doit apparaître dans ce chapitre **avant** d'être installée. Aucune bibliothèque « au cas où » |

**Vérifications à faire au lot 0** (les écarts de majeure sont nommés dans les tableaux §4.1 et §4.2) :

1. `@libsql/client/sqlite3` exporte toujours le sous-chemin → sinon `db/index.ts` ne démarre pas.
2. `modal.tsx`, `app-shell.tsx` (drawer) et les transitions s'animent correctement avec **framer-motion 13**.
3. `electron/main.js` fonctionne avec **Electron 44** (`fork`, `webRequest.onBeforeSendHeaders`, `electron-updater`).
4. `tsc --noEmit --incremental false` passe avec **TypeScript 7** ; sinon repli TypeScript 5.9.
5. `eslint-config-next` est compatible **ESLint 10** ; `react-datepicker` fournit ses propres types (retirer `@types/react-datepicker`).
6. `npm audit` ne remonte aucune vulnérabilité critique.

> **Principe** : toute nouvelle dépendance doit être justifiée ici avant installation. Aucune bibliothèque « au cas où ».

---

## 5. Architecture et structure du projet

### 5.1 Architecture d'exécution

```
┌──────────────────────────────────────────────────────┐
│  Electron (fenêtre desktop native, hors ligne)       │
│  └── Next.js (serveur local 127.0.0.1, port libre)   │
│       └── Planète Déco (React + API Routes + SQLite) │
│            ├── db/database.db  (%APPDATA%)  ← source │
│            │                                  de vérité
│            └── electron-updater → GitHub Releases    │
└───────────────────────┬──────────────────────────────┘
                        │  optionnel, §23
                        ▼
        ┌──────────────────────────────────────┐
        │  API de synchronisation (HTTPS)      │
        │   └── PostgreSQL en ligne            │
        │        (mode A : sauvegarde          │
        │         mode B : multi-postes)       │
        └──────────────────────────────────────┘
```

- Le serveur n'écoute que sur **`127.0.0.1`** (jamais exposé au réseau).
- Un **jeton d'accès** régénéré à chaque lancement est injecté par Electron dans chaque requête ; sans lui, le serveur répond **404** (voir §18).
- En mode navigateur (`npm run dev`), le jeton est absent → contrôle désactivé (mode débogage).
- **Aucune connexion Internet n'est requise** pour travailler. La synchronisation PostgreSQL est **strictement optionnelle** ([§23](#23-synchronisation-avec-postgresql-option-en-ligne)) et se désactive à tout moment.
- La **source de vérité reste le SQLite local** : PostgreSQL est un miroir, jamais un prérequis. Une panne du serveur ou d'Internet ne bloque aucune vente.

### 5.2 Structure des dossiers

```
projetPDS/
├── app/
│   ├── api/                        # Route Handlers REST (voir §27)
│   │   ├── auth/                   #   login, logout, me, setup
│   │   ├── clients/                #   CRUD clients + types + paiements
│   │   ├── fournisseurs/           #   CRUD fournisseurs + stats
│   │   ├── produits/               #   CRUD produits, catégories, unités
│   │   ├── stocks/                 #   mouvements, ajustement, résumé
│   │   ├── achats/                 #   factures d'achat fournisseur
│   │   ├── ventes/                 #   factures de vente + stats
│   │   ├── paiements/              #   encaissements (reçus)
│   │   ├── depenses/               #   dépenses + catégories
│   │   ├── caisse/                 #   mouvements, sessions, résumé
│   │   ├── chantiers/              #   prestations (lot 3)
│   │   ├── briqueterie/            #   productions (lot 3)
│   │   ├── atelier/                #   commandes meubles (lot 4)
│   │   ├── rapports/               #   données analytiques + export
│   │   ├── operations/snapshot/    #   dashboard
│   │   ├── users/                  #   utilisateurs + rôles
│   │   ├── audit/                  #   journal des actions
│   │   └── parametres/             #   settings, seed, reset, backup, restore,
│   │                               #   sync (statut, now, conflits) — §23
│   ├── layout.tsx                  # Providers + AppShell + toasts
│   ├── page.tsx                    # Tableau de bord (§1)
│   ├── login/, clients/, fournisseurs/, produits/, stocks/, achats/,
│   │   ventes/, depenses/, caisse/, soldes/, rapports/, chantiers/,
│   │   briqueterie/, atelier/, utilisateurs/, parametres/,
│   │   synchronisation/            # écran de synchronisation (§23.10)
├── components/
│   ├── app-shell.tsx, modal.tsx, page-header.tsx, back-button.tsx,
│   │   responsive-table.tsx, search-filter.tsx, surface-card.tsx,
│   │   metric-card.tsx, date-picker.tsx, export-dropdown.tsx,
│   │   theme-provider.tsx, theme-toggle.tsx, auth-provider.tsx,
│   │   scroll-restoration.tsx, update-status.tsx
│   ├── ventes/                     # table, modales, stats, graphiques
│   ├── rapports/                   # résumé, comparaison, dettes, stock, marges
│   └── <module>/                   # un sous-dossier par module métier
├── db/
│   ├── schema.ts                   # Tables + relations Drizzle (§6)
│   ├── index.ts                    # Connexion libSQL + migrations + helpers
│   └── migrations/                 # Migrations versionnées (embarquées)
├── lib/
│   ├── auth.ts, colors.ts, date-format.ts, invoice-export.ts,
│   │   operations.ts, products.ts, stock.ts, seed-data.ts,
│   │   scroll-engine.ts, view-state.ts, settings.ts, payments.ts,
│   │   permissions.ts, audit.ts,
│   │   report-sender.ts, cost-calculator.ts, rapports-types.ts,
│   │   ventes-types.ts, caisse.ts, chantiers.ts, briqueterie.ts, atelier.ts
│   └── sync/                       # Synchronisation PostgreSQL (option, §23)
│       ├── sync-client.ts          #   push : file d'attente, lots, idempotence
│       ├── sync-apply.ts           #   pull : ordre topologique, refs, quarantaine
│       ├── sync-payload.ts         #   sérialisation UUID + résolution des références
│       └── sync-config.ts          #   état, watermarks, appareil
├── server/                         # Service de synchronisation (déployé en ligne)
│   ├── src/index.ts                #   API HTTPS (3 points d'entrée)
│   ├── src/db/schema.pg.ts         #   Schéma PostgreSQL + tenant_id
│   ├── src/routes/push.ts, pull.ts, health.ts
│   └── drizzle.config.pg.ts
├── electron/main.js, electron/preload.js
├── scripts/copy-standalone.js, after-pack.js, release.js
├── types/electron-api.d.ts
├── .github/workflows/release.yml
├── proxy.ts
├── next.config.ts, drizzle.config.ts, postcss.config.mjs, tsconfig.json
└── package.json
```

> **`app/parametres/page.tsx` exporte `SettingsProvider` et `useSettings`** (comme dans Gaz). Point d'attention : ce fichier est un composant client exportant un contexte global — le garder tel quel pour rester compatible avec `app-shell.tsx`.

### 5.3 Design system — une identité d'entreprise, cohérente sur toutes les pages

Objectif : l'application doit **ressembler à un logiciel d'entreprise**, pas à un formulaire. Sobre, dense juste ce qu'il faut pour lire des chiffres, identique d'un écran à l'autre. Aucune page « spéciale » qui rompt le langage visuel.

#### Jetons de design (source unique de vérité)

| Catégorie | Jeton | Valeur | Règle |
|---|---|---|---|
| Couleur | `--color-primary` | configuration client, défaut `#1e40af` | Actions, accents, éléments actifs, graphiques |
| Couleur | `--sidebar-color` | `#1e293b` | Fond de la barre latérale |
| Couleur | `--sidebar-text` / `--sidebar-text-muted` | calculé | **Contraste automatique** : un sidebar jaune ou blanc reste lisible |
| Couleur | `info` / `success` / `warning` / `error` | `#0ea5e9` / `#10b981` / `#f59e0b` / `#ef4444` | **Fixes** : leur sens ne doit pas dépendre de la couleur choisie |
| Couleur | `base-100/200/300`, `base-content` | clair / sombre | Fonds, filets, textes |
| Typographie | famille | **une seule** (`--font-sans`) | Aucune police décorative, aucun dégradé de texte |
| Typographie | échelle | 28–32 / 24–28 / 18 / 14 / 11–12 px | Titre de page, section, sous-titre, corps, légende |
| Typographie | **chiffres** | `tabular-nums` | **Obligatoire** sur tous les montants, quantités et dates en tableau : les colonnes s'alignent, la lecture est comptable |
| Espacement | échelle | 4 / 8 / 12 / 16 / 24 / 32 px | Interdit : marges arbitraires (`mt-7`, `p-[13px]`) |
| Rayons | carte / champ / badge | 16 / 12 / pilule | Cohérents sur **toutes** les pages |
| Ombres | cartes | `shadow-sm`, `shadow-md shadow-black/5` | **Uniquement** des ombres légères. Jamais d'ombre lourde, jamais de `backdrop-blur` sur un en-tête |
| Mouvement | durée | 150–250 ms, `ease-out` | Spring réservé aux modales et au drawer |
| Mouvement | accessibilité | `prefers-reduced-motion` | **À ajouter** : Gaz ne gère pas la réduction des animations |

> 🚫 **Règle d'or : aucune couleur en dur.** Le projet Gaz contient des `bg-sky-700`, `text-sky-600`, `border-amber-200` (ex. `app/ventes/nouvelle/page.tsx`) qui **ignorent la couleur choisie par le client** dans les paramètres. Dans ce projet, tout passe par `btn-primary`, `text-primary`, `border-base-200`, `bg-base-100`. **Une couleur Tailwind figée dans une page est un défaut, pas un détail.**

#### Les 5 états obligatoires de chaque écran

| État | Rendu | Composant |
|---|---|---|
| **Nominal** | Données affichées | `ResponsiveTable`, cartes |
| **Vide** | Icône + phrase explicative + **action** (« Créer la première vente ») | `EmptyState` |
| **Chargement** | **Squelette** épousant la forme du contenu (pas un spinner plein écran) | `Skeleton` |
| **Erreur** | Message lisible + bouton « Réessayer » (jamais un écran blanc) | `ErrorState` |
| **Feedback** | Confirmation d'action | `toast` (react-toastify) |

> Une page livrée avec seulement l'état nominal **n'est pas terminée**.

#### Bibliothèque de composants

| Origine | Composants |
|---|---|
| **Repris de Gaz** | `AppShell`, `PageHeader`, `BackButton`, `SurfaceCard`, `MetricCard`, `ResponsiveTable`, `SearchBar`, `FilterSelect`, `Pagination`, `Modal`, `ExportDropdown`, `DatePicker`, `ThemeToggle`, `UpdateStatus` |
| **À créer pour Planète Déco** | `StatusBadge` (Payée / Partiel / Impayée / Annulée) · `MoneyText` (montant + devise + `tabular-nums`) · `EmptyState` · `ErrorState` · `Skeleton` · `PageSection` · `FormField` (label + aide + erreur) · `ConfirmDialog` (enveloppe de `Modal`) · `StatCardDelta` (valeur + variation vs période précédente) · `StageTracker` (moulage → stock, découpe → livré) · `DataToolbar` (recherche + filtres + période + export sur une seule barre) · `RoleGate` (masque un bloc selon la permission) |

### 5.4 Le sidebar et la navigation

```
┌──────────────────────────────┐
│  ▣  Planète Déco             │  ← identité : logo + nom + filiale
│     Filiale Meubles          │
├──────────────────────────────┤
│  PILOTAGE                    │
│   ▦  Tableau de bord         │
│   ▤  Rapports                │
│   ⚖  Soldes                  │
│  COMMERCIAL                  │
│  ▐▧  Ventes                  │  ← actif : bord accentué + fond teinté
│   ◍  Clients                 │
│   ▨  Achats                  │
│   ◍  Fournisseurs            │
│  GESTION                     │
│   ▥  Produits                │
│   ▤  Stocks                  │
│  PRODUCTION                  │
│   ⚒  Chantiers               │
│   ▩  Briqueterie             │
│   ▬  Atelier                 │
│  FINANCES                    │
│   ▭  Caisse                  │
│   ▫  Dépenses                │
│  ADMINISTRATION              │
│   ♟  Utilisateurs            │
│   ⚙  Paramètres              │
│   ⟳  Synchronisation         │
├──────────────────────────────┤
│  (B) Boubacar · Administrateur│
│  Version 1.3.0   ● Synchronisé│
│  Thème ⇄            ⚙         │
│  Déconnexion                 │
└──────────────────────────────┘
```

| Règle | Détail |
|---|---|
| Largeur | **288 px (`w-72`) déployée**, **80 px (`w-20`) repliée** en icônes seules avec infobulles. Le repli est une **amélioration par rapport à Gaz** (qui ne l'a pas) et son état est mémorisé dans les réglages **locaux** — donc **pas synchronisés** (§23.9) |
| Groupes | **6 groupes** avec intitulés en petites majuscules (`text-[11px] uppercase tracking-wider`) : indispensable avec 18 modules, un menu à plat serait illisible |
| Élément actif | **Deux indices visuels simultanés** : bord gauche de 3 px dans la couleur primaire **et** fond teinté `color-mix(in srgb, var(--sidebar-text) 20%, transparent)`. Jamais la couleur seule (daltonisme) |
| Accessibilité | `aria-current="page"` sur l'élément actif, anneau de focus visible, navigation clavier complète, `aria-label` sur chaque bouton-icône, contraste **AA minimum** — y compris quand le client choisit une couleur de sidebar exotique |
| Filtrage par rôle | Le menu est **filtré par permission** (`lib/permissions.ts`) : un vendeur ne voit ni *Utilisateurs*, ni *Paramètres*, ni *Synchronisation*. Masquer n'est pas protéger : les API vérifient aussi |
| Mobile | Sidebar en `hidden lg:flex` ; en dessous : header fixe `h-16` (logo, thème, recharger, hamburger) + **drawer coulissant depuis la droite** (spring, overlay `bg-black/50`) |
| Pied de sidebar | Carte utilisateur : initiale, nom, rôle, **version de l'application**, **état de synchronisation**, bascule de thème, accès Paramètres, déconnexion |
| Bouton recharger | Hérité de Gaz : en desktop il n'existe aucune barre d'outils, donc aucun moyen de rafraîchir autrement |

### 5.5 Responsive — la règle des 5 largeurs

Exigence : **n'importe quelle page doit être utilisable de 360 px à 2560 px**, sans défilement horizontal, sans élément tronqué, sans bouton inaccessible.

| Largeur | Navigation | Listes | Formulaires | Modales |
|---|---|---|---|---|
| **360–639** (mobile) | Header + drawer | Cartes empilées (`ResponsiveTable`) | 1 colonne, cibles ≥ 44 px | Plein écran, bottom sheet |
| **640–1023** (tablette) | Header + drawer | Cartes puis tableau à partir de `sm` | 2 colonnes | Centrée |
| **1024–1279** (desktop) | **Sidebar** 288 px | Tableau | 2–3 colonnes | Centrée |
| **1280–1535** | Sidebar 288 px | Tableau | 3 colonnes | Centrée |
| **≥ 1536** (grand écran) | Sidebar 288 px | Tableau | 3 colonnes | Centrée, **contenu centré** (`max-w-7xl`) et non étiré sur 2560 px |

**Contrat par page — vérifié à la livraison :**

1. **Aucun défilement horizontal** à 360 px, hors tableau de saisie explicitement balisé comme tel.
2. **`ResponsiveTable` obligatoire** pour toute liste : `primary: true` (titre de la carte mobile), `hideOnMobile` pour les colonnes techniques, actions en **pied de carte**.
3. **Formulaires** : une colonne sous `sm`, `sm:grid-cols-2`, `lg:grid-cols-3`. Aucun champ tactile de moins de 44 px de haut.
4. **Modales** : `fullScreenMobile` → bottom sheet sous `sm`, `max-h-[90vh]` scrollable, et **pied d'actions collant** (le bouton « Enregistrer » doit rester atteignable sur un long formulaire mobile — Gaz ne le fait pas).
5. **Graphiques** : `h-56 sm:h-64`, légende déplacée **sous** le graphe sur mobile, graduations allégées.
6. **Barres de filtres et de périodes** : `flex-wrap` systématique ; sur mobile les filtres secondaires se replient derrière un bouton **« Filtres (2) »**.
7. **Pagination** : complète sur desktop, compacte sur mobile (« ‹ 3 / 12 › »).
8. **Tableaux chiffrés** : montants alignés à droite avec `tabular-nums`, jamais de retour à la ligne d'un montant.
9. **Impression** : `print:` masque la sidebar, l'en-tête et les boutons ; les factures restent en `max-w-4xl`.
10. **Desktop Electron** : fenêtre **minimum 1024 × 700** (`minWidth` / `minHeight`) ; en dessous, la sidebar se replie automatiquement.

> **Défilement horizontal — vérifié dans un navigateur réel (24/09/2026).**
> Les **32 écrans** ont été ouverts à **360, 768, 1024 et 1366 px** :
> `document.documentElement.scrollWidth ≤ window.innerWidth` partout, soit
> **0 page en débordement sur 128 mesures**. Les **25 modales** recensées ne
> débordent pas non plus (0 sur 25, contre 5 avant correction).
> Les quatre causes — références de grille sans `min-w-0`, tableau large sans
> conteneur de défilement, texte d'aide insécable, montant insécable — et la
> façon de les corriger sont décrites dans
> [CONVENTIONS §8](docs/CONVENTIONS.md#aucune-page-ne-défile-horizontalement--les-4-causes-à-connaître).
> Le défilement horizontal des **tableaux** reste, lui, volontaire : il est
> contenu dans la carte du tableau, jamais dans la page (et il est explicite
> pour les tableaux de saisie, `data-entry-table`).

**Matrice de recette — une page non cochée n'est pas terminée**

| Page | 360 px | 768 px | 1440 px | 5 états (§5.3) | Aucune couleur en dur |
|---|:--:|:--:|:--:|:--:|:--:|
| `/` Dashboard | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/ventes` · `/ventes/nouvelle` · `/ventes/[id]` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/recus/[id]` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/clients` · `/clients/[id]` · `/clients/[id]/paiements` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/fournisseurs` · `/fournisseurs/[id]/paiements` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/produits` · `/produits/categories` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/stocks` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/achats` · `/achats/[id]` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/caisse` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/depenses` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/soldes` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/rapports` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/utilisateurs` · `/utilisateurs/historique` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/parametres` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/synchronisation` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/chantiers` · `/chantiers/[id]` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/briqueterie` · `/briqueterie/[id]` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/atelier` · `/atelier/modeles` · `/atelier/[id]` | ☐ | ☐ | ☐ | ☐ | ☐ |
| `/login` | ☐ | ☐ | ☐ | ☐ | ☐ |

> **Definition of done d'une page** : elle est terminée quand les **5 colonnes** sont cochées. Une page qui fonctionne mais qui déborde à 360 px, n'a pas d'état vide, ou code une couleur en dur, est une page **non livrée**.

---

## 6. Base de données

**SQLite** via `@libsql/client/sqlite3` + **Drizzle ORM**, fichier unique (`db/database.db` en développement, `%APPDATA%/planete-deco/database.db` en desktop), journalisation **WAL**, verrou de migration et migrations automatiques au démarrage (`db/index.ts`).

> **Le schéma de cette section part du document `Schema_BDD_Planete_Deco_Sarlu.pdf` fourni par le client.**
> Ce document annonce « 18 tables » : il en contient en réalité **24**. Quatre fonctionnalités exigées par le cahier des charges y sont impossibles en l'état (§7 TVA/HT et échéancier, §17 matières premières et dimensions des briques, §18 fiche modèle et nomenclature, §12/§14 journal des actions). Le schéma client est donc **conservé dans sa structure**, corrigé sur **9 points** et aligné sur les conventions de nommage du projet Gaz → **30 tables métier**, plus les **colonnes de synchronisation** (§6.7) et **5 tables locales de synchronisation** ([§23](#23-synchronisation-avec-postgresql-option-en-ligne)).

### 6.1 Décisions structurantes (v1.2)

| Décision | Choix retenu | Conséquence |
|---|---|---|
| **Nommage** | **Anglais**, `snake_case` pour les colonnes, tables au pluriel — conventions exactes du projet Gaz | Le code de Gaz est réutilisable presque littéralement. Le vocabulaire français reste dans l'interface |
| **Paramètres** | Table `settings` **clé/valeur** (`key` PK, `value`) + **couche typée** `lib/settings.ts` (`Settings`, `DEFAULT_SETTINGS`, `getSettings()`, `updateSettings()`) | Ajouter un réglage = **aucune migration**. Le front reprend `SettingsProvider` / `useSettings()` et la page paramètres de Gaz sans modification |
| **Paiements** | **Une seule table `payments` polymorphe** (`type` + `reference_id`, vente / achat / prestation) | Un seul mécanisme d'acompte, de solde et de reçu pour §5, §6, §7 et §16. ⚠️ **Aucune intégrité référentielle** sur `reference_id` : l'intégrité est garantie par `lib/payments.ts`, jamais par la base |
| **Prestations** | **Document facturable autonome** : une prestation a son propre numéro, ses propres totaux et ses propres paiements — elle **ne génère pas** de facture de vente | Évite tout double comptage du chiffre d'affaires. Le CA = `sales_invoices` **+** `service_jobs`. §16 est satisfait |
| **Correction de stock** | `stock_movements.type = 'adjustment'` stocke un **écart (+/−)**, pas la valeur absolue | Garantit l'invariant « somme des mouvements = stock courant ». Conforme à §4 « inventaire et correction de stock » |
| **Dates** | `date` = `YYYY-MM-DD` (date métier, **seule filtrée**) + `created_at` = horodatage (traçabilité seule) | Évite le bug de comparaison de chaînes décrit en §6.5 |
| **Main-d'œuvre** | **Une seule table `workers`**, référencée par les 3 modules (chantiers, briqueterie, atelier) | Corrige une incohérence du schéma client, qui modélisait le même réel de 3 façons différentes |
| **Synchronisation en ligne** | **Option désactivée par défaut** : PostgreSQL distant, en **deux modes** (A sauvegarde unidirectionnelle, B multi-postes). Colonnes `sync_id` (UUID), `updated_at`, `deleted_at`, `origin_device_id` sur les 30 tables métier + 5 tables locales | Rend la synchronisation possible **sans réécrire** le modèle. Le mode A est un prérequis du mode B. Détail complet en [§23](#23-synchronisation-avec-postgresql-option-en-ligne) |

### 6.2 Correspondance schéma client → schéma cible

| Schéma client | Schéma cible | Nature du changement |
|---|---|---|
| `utilisateurs` | `users` | 6 rôles conservés · + `updated_at` · hachage **scrypt** au lieu de SHA-256 nu |
| `clients` / `fournisseurs` | `customers` / `suppliers` | + `is_active`, `credit_limit` (clients), `updated_at` |
| `categories` | `categories` | + `updated_at` |
| `produits` | `products` | + `is_active` · `unite` (texte) au lieu d'une table `units` · `prix_achat` → **`purchase_price`** (renommage pour lever l'ambiguïté avec le prix unitaire des lignes) · pas de code produit : **le nom est l'identifiant** (unique) |
| `mouvements_stock` | `stock_movements` | + `stock_before` / `stock_after` (traçabilité) · `correction` = **écart** · `type` à 3 valeurs |
| `ventes` | `sales_invoices` | ⚠️ **+ `total_ht`, `tax_rate`, `tax_amount`** (§7) · **+ `due_date`** (§7) · + `remaining_amount`, `notes`, `status`, **`cancel_reason` / `cancelled_by` / `cancelled_at`** (§6) |
| `vente_lignes` | `sales_invoice_items` | ⚠️ **+ `product_name`, `unit`** (instantané : une facture ancienne doit rester lisible même si le produit est renommé ou désactivé) |
| `achats` | `purchase_invoices` | + `supplier_reference` (n° de facture du fournisseur), `due_date`, `notes`, `remaining_amount`, `user_id` |
| `achat_lignes` | `purchase_invoice_items` | ⚠️ **+ `product_name`, `unit`** |
| `paiements` | `payments` | ⚠️ **+ `receipt_number` (unique)** pour §7 · + `notes`, `payment_label`, `created_at` |
| `caisse_mouvements` | `cash_movements` | ⚠️ **+ `payment_method`** (§8 espèces / Mobile Money) · **+ `reference_type` / `reference_id`** (rapprochement avec la vente ou la dépense d'origine) · + `balance_after`, `session_id` |
| `caisse_clotures` | `cash_sessions` | ⚠️ **+ `theoretical_amount`, `difference`, `status`** · séparation `opened_by` / `closed_by` · `opened_at` / `closed_at` (§8) |
| `depenses` | `expenses` | + `reference_type` / `reference_id`, `created_at` · `category` reste du texte, mais **choisie dans une liste fermée** des paramètres (pas de saisie libre) |
| — | **`audit_logs`** | ⚠️ **Table manquante** : §12 « historique des actions importantes » et §14 « historique des opérations » |
| — | **`workers`** | ⚠️ **Table manquante** : une seule table au lieu de 3 modélisations divergentes |
| `prestations` | `service_jobs` | ⚠️ + `statut` `pending` (§16 « en attente ») · + `quote_status` (`draft` / `sent` / `accepted` / `refused`) au lieu d'une table de devis · + `reference`, `created_at` |
| `prestation_materiaux` | `service_job_materials` | + `unit_cost` (aujourd'hui un `montant` global : impossible d'analyser la marge matière) · + instantané `product_name` |
| `prestation_equipe` | `service_job_workers` | ⚠️ + **`days`, `daily_rate`, `amount`** (sans quoi la main-d'œuvre reste un chiffre saisi à la main) |
| `production_briques` | `brick_productions` | ⚠️ **`type_brique` (texte) → `brick_type_id`** · **+ `brick_type` relié à un `products.id`** (sinon le stock de briques finies est impossible) · + `end_date`, `material_cost`, `labor_cost`, `total_cost`, `user_id` |
| — | **`brick_types`** | ⚠️ **Table manquante** : §17 « chaque type de brique **avec ses dimensions** » |
| — | **`brick_production_materials`** | ⚠️ **Table manquante** : §17 argile, ciment, sable, eau, **bois de chauffe** — sans elle, aucune matière première ne sort du stock (asymétrie visible avec les meubles) |
| `production_briques_ouvriers` | `brick_production_workers` | + `days`, `daily_rate`, `worker_id` |
| `production_meubles` | `furniture_orders` | + `model_id` (FK) · `modele` (texte) → **`furniture_models`** · + `material_cost`, `labor_cost`, `total_cost`, `agreed_price`, `amount_paid`, `product_id` (meuble fini), `user_id` |
| `production_meubles_materiaux` | `furniture_order_materials` | ⚠️ **+ `wastage_quantity`** (§18 « suivi des chutes de bois et pertes de matière ») · + `unit_cost`, `amount` |
| `production_meubles_equipe` | `furniture_order_workers` | + `days`, `daily_rate`, `amount`, `worker_name` |
| — | **`furniture_models` + `furniture_model_materials`** | ⚠️ **Tables manquantes** : §18 « fiche de chaque modèle **avec les matériaux nécessaires pour la fabriquer** » |
| `rapports_envoyes` | `report_deliveries` | + `from_date` / `to_date` (quelle période a été envoyée), `triggered_by` (`auto` / `manual`), `error`, `user_id` |
| `parametres` (clé/valeur) | `settings` (clé/valeur) | Structure conservée · + `updated_at` · + couche typée `lib/settings.ts` |

### 6.3 Tables cibles métier (30)

#### Utilisateurs et traçabilité

**`users`**
| Colonne | Type | Note |
|---|---|---|
| `id` | integer PK | |
| `name` | text | Nom affiché |
| `username` | text, unique | Identifiant de connexion |
| `password_hash` | text | **scrypt** (`node:crypto`), salé — le SHA-256 nu de Gaz n'est pas reconduit |
| `role` | text | `admin` \| `manager` \| `seller` \| `storekeeper` \| `carpenter` \| `brickmaker` *(gérant, vendeur/caissier, magasinier, menuisier, briquetier)* |
| `is_active` | boolean | Défaut `true` |
| `created_at`, `updated_at` | timestamp | |

**`audit_logs`** — historique des actions (§12, §14)
`id`, `user_id`, `user_name`, `action` (`create` \| `update` \| `delete` \| `cancel` \| `login` \| `logout` \| `payment` \| `stock_adjust` \| `restore`…), `entity`, `entity_id`, `details` (JSON texte), `created_at`

#### Partenaires

**`customers`**
`id`, `name`, `phone`, `address`, `notes`, `credit_limit` (real, §2 ventes à crédit), `is_active`, `created_at`, `updated_at`

**`suppliers`**
`id`, `name`, `phone`, `address`, `notes`, `is_active`, `created_at`, `updated_at`

> Pas de table `customer_types` : §2 ne demande pas de typologie client. Les totaux d'achat et les soldes sont **calculés**, jamais stockés.

#### Produits et stock

**`categories`**
`id`, `name` (Meuble, Brique, Alucobond, Staff, Placo, Peinture, Bois, Quincaillerie, Matière première…), `kind` (`finished` \| `raw_material` \| `service`), `created_at`, `updated_at`
> Le type est porté par la **catégorie**, pas par le produit : un seul endroit à paramétrer, et une catégorie homogène. Choix conservé du schéma client.

**`products`**
| Colonne | Type | Note |
|---|---|---|
| `id` | integer PK | |
| `name` | text | **Identifiant du produit** : unique, insensible à la casse et aux espaces de bord (`lower(trim(name))`) |
| `category_id` | FK → `categories` | |
| `unit` | text | pièce, ensemble, carton, m², kg, sac, litre — **liste fermée dans les paramètres** |
| `purchase_price` | real | Prix d'achat (base du calcul de marge) |
| `sale_price` | real | Prix de vente |
| `stock` | **real** | Gaz utilisait `integer` : le m² et le kg exigent du décimal |
| `stock_min` | real | Seuil d'alerte (§4) |
| `is_active` | boolean | |
| `created_at`, `updated_at` | timestamp | |

**`stock_movements`** — journal unique du stock (§4)
`id`, `product_id`, `type` (`entry` \| `exit` \| `adjustment`), `quantity` (real), `motif` (`"vente FAC-2026-000012"`, `"achat ACH-2026-0004"`, `"production briques lot #3"`, `"inventaire"`…), `stock_before`, `stock_after`, `reference_type` (`sale` \| `purchase` \| `brick_production` \| `furniture_order` \| `service_job` \| `inventory`), `reference_id`, `user_id`, `created_at`
> **Invariant** : `products.stock` = somme des mouvements. `adjustment` stocke un **écart**, pas une valeur absolue. Les briques cassées (§17) et les chutes de bois (§18) sont des `exit` avec un motif explicite — pas de type `loss` supplémentaire.

#### Ventes, achats, paiements

**`sales_invoices`**
| Colonne | Type | Note |
|---|---|---|
| `id` | integer PK | |
| `invoice_number` | text, unique | `{préfixe}-{année}-{000001}` (voir Q1) |
| `customer_id` | FK → `customers`, **nullable** | `null` = **vente comptoir** |
| `customer_name` | text | Nom figé sur la facture |
| `user_id` | FK → `users` | Qui a vendu |
| `date` | text | `YYYY-MM-DD` — **date métier** |
| `due_date` | text | **Échéance** en cas de crédit (§7) |
| `sub_total` | real | Sous-total |
| `discount` | real | Remise globale |
| `total_ht` | real | **`sub_total − discount`** (§7) |
| `tax_rate` | real | **Taux de TVA** (§7) |
| `tax_amount` | real | **`total_ht × tax_rate / 100`** (§7) |
| `total` | real | **Total à payer** `total_ht + tax_amount` |
| `amount_paid`, `remaining_amount` | real | |
| `payment_status` | text | `paid` \| `partial` \| `unpaid` |
| `payment_method` | text | Moyen **principal** — le détail est dans `payments` |
| `status` | text | `active` \| `cancelled` (§6 annulation selon autorisation) |
| `cancel_reason`, `cancelled_by`, `cancelled_at` | text / int / timestamp | Traçabilité de l'annulation |
| `notes` | text | |
| `created_at`, `updated_at` | timestamp | |

**`sales_invoice_items`**
`id`, `invoice_id`, `product_id`, `product_name`, `unit`, `quantity` (real), `unit_price`, `amount`
> **Instantané volontaire** de `product_name` / `unit` : une facture de 2026 doit rester lisible et imprimable même si le produit est renommé, son unité changée ou le produit désactivé.

**`purchase_invoices`** (achats, §5)
`id`, `reference` (unique, notre numéro `ACH-…`), `supplier_reference` (n° de facture du fournisseur), `supplier_id`, `user_id`, `date`, `due_date`, `total`, `amount_paid`, `remaining_amount`, `payment_status`, `notes`, `created_at`, `updated_at`

**`purchase_invoice_items`**
`id`, `invoice_id`, `product_id`, `product_name`, `unit`, `quantity` (real), `unit_price`, `amount`

**`payments`** — encaissements, décaissements et reçus (§7)
`id`, `receipt_number` (**unique**, préfixe configurable), `type` (`sale` \| `purchase` \| `service_job`), `reference_id`, `amount`, `payment_method`, `payment_label` (`deposit` \| `balance` \| `full` — acompte / solde / intégral, §7), `date`, `notes`, `user_id`, `created_at`
> Alimente l'**échéancier de crédit** et permet la **réimpression du reçu** après chaque paiement. ⚠️ `reference_id` n'est pas une clé étrangère : l'intégrité est assurée dans `lib/payments.ts`.

#### Caisse et dépenses

**`cash_movements`** (§8)
`id`, `type` (`income` \| `expense`), `amount`, **`payment_method`** (Espèces / Mobile Money), `motif`, `reference_type` (`sale` \| `payment` \| `purchase` \| `expense` \| `manual`), `reference_id`, `session_id`, `balance_after`, `date`, `user_id`, `created_at`

**`cash_sessions`** — ouverture / clôture journalière (§8)
`id`, `status` (`open` \| `closed`), `opened_at`, `opened_by`, `opening_amount`, `closed_at`, `closed_by`, **`theoretical_amount`**, **`counted_amount`**, **`difference`** (`counted_amount − theoretical_amount`), `notes`
> **Une seule session `open` à la fois.** Le solde disponible = dernier `balance_after` de la session ouverte.

**`expenses`** (§9)
`id`, `category` (transport, loyer, salaire, carburant, électricité… — **liste fermée** dans les paramètres), `amount`, `description`, `payment_method`, `reference_type` / `reference_id`, `date`, `user_id`, `created_at`
> Une dépense **sort de la caisse** (`cash_movements`) et **n'affecte pas le stock** — contrairement à un achat (§5).

#### Prestations et main-d'œuvre

**`workers`** — **une seule table pour les 3 modules**
`id`, `name`, `phone`, `role` (`foreman` \| `worker` \| `apprentice`), `daily_rate`, `is_active`, `created_at`
> Corrige l'incohérence du schéma client. `worker_name` reste saisissable dans les tables de liaison, pour un journalier ponctuel qui n'est pas enregistré (§17 « ouvriers journaliers »).

**`service_jobs`** (§16)
`id`, `reference` (unique), `customer_id` (**not null**), `category` (`alucobond` \| `staff` \| `placo` \| `furniture` \| `painting`), `site_address`, `description`, `start_date`, `end_date`, `status` (`quote` \| `pending` \| `in_progress` \| `completed` \| `cancelled`), `quote_status` (`draft` \| `sent` \| `accepted` \| `refused`), `quote_materials`, `quote_labor`, `quote_total`, `total`, `amount_paid`, `remaining_amount`, `payment_status`, `notes`, `created_at`, `updated_at`
> Le devis et le suivi d'avancement vivent dans **la même table** : `quote_*` pour le devis, `status` pour l'avancement, `quote_status` pour l'acceptation. Une table de devis versionnée séparée serait sur-modélisée (§25 : on la néglige).

**`service_job_materials`**
`id`, `job_id`, `product_id`, `product_name`, `unit`, `quantity` (real), `unit_cost`, `amount`
> Déduits du stock par un mouvement `exit` / `reference_type = 'service_job'`.

**`service_job_workers`**
`id`, `job_id`, `worker_id` (nullable), `worker_name`, `role`, `days`, `daily_rate`, `amount`

#### Briqueterie (§17)

**`brick_types`**
`id`, `product_id` (FK → `products` : **c'est lui qui porte le stock et le prix de vente**), `name`, `shape` (`solid` \| `hollow` \| `block`), `dimensions`, `is_active`

**`brick_productions`**
`id`, `batch_number` (unique), `brick_type_id`, `planned_quantity`, `produced_quantity`, `broken_quantity`, `start_date`, `end_date`, `stage` (`molding` \| `drying` \| `firing` \| `stored`), `material_cost`, `labor_cost`, `total_cost`, `user_id`, `notes`, `created_at`
> **Coût de revient unitaire** = `total_cost ÷ (produced_quantity − broken_quantity)` — calculé par `lib/cost-calculator.ts`, jamais stocké.

**`brick_production_materials`** — **la table qui manquait**
`id`, `production_id`, `product_id` (argile, ciment, sable, eau, **bois de chauffe**), `quantity`, `unit_cost`, `amount`

**`brick_production_workers`**
`id`, `production_id`, `worker_id` (nullable), `worker_name`, `days`, `daily_rate`, `amount`

#### Atelier de meubles (§18)

**`furniture_models`** — fiche modèle
`id`, `code`, `name`, `description`, `standard_dimensions`, `labor_hours`, `sale_price`, `is_active`, `created_at`

**`furniture_model_materials`** — nomenclature (BOM)
`id`, `model_id`, `product_id`, `quantity`
> Base du calcul automatique des besoins en matières pour une commande standard.

**`furniture_orders`**
`id`, `order_number` (unique), `customer_id`, `model_id` (nullable), `model_name`, `is_custom`, `dimensions`, `finish`, `start_date`, `promised_date`, `delivery_date`, `stage` (`cutting` \| `assembly` \| `sanding` \| `painting` \| `finishing` \| `delivered`), `material_cost`, `labor_cost`, `total_cost`, `agreed_price`, `amount_paid`, `product_id` (meuble fini → entrée en stock), `user_id`, `notes`, `created_at`, `updated_at`
> « Livré à temps » = `delivery_date <= promised_date` (§18).

**`furniture_order_materials`**
`id`, `order_id`, `product_id`, `quantity`, `wastage_quantity`, `unit_cost`, `amount`
> `wastage_quantity` = **chutes de bois et pertes de matière** (§18).

**`furniture_order_workers`**
`id`, `order_id`, `worker_id` (nullable), `worker_name`, `role`, `days`, `daily_rate`, `amount`

#### Rapports et paramètres

**`report_deliveries`** (§11)
`id`, `period` (`day` \| `week` \| `month`), `from_date`, `to_date`, `channel` (`sms` \| `whatsapp`), `recipients`, `content`, `status` (`sent` \| `failed`), `error`, `triggered_by` (`auto` \| `manual`), `user_id`, `sent_at`

**`settings`** — clé/valeur
`key` (text, PK), `value` (text, not null), `updated_at`
> Typée par `lib/settings.ts`. Clés : `company_name`, `company_branch`, `company_address`, `company_phone`, `company_email`, `company_logo`, `company_tax_id`, `currency`, `currency_symbol`, `date_format`, `invoice_prefix`, `invoice_number_format`, `purchase_prefix`, `receipt_prefix`, `default_tax_rate`, `payment_methods`, `units`, `expense_categories`, `theme`, `primary_color`, `sidebar_color`, `low_stock_alert`, `default_stock_min`, `report_channels`, `report_recipients`, `report_frequency`, `report_send_time`, `report_provider_config`.
> Les valeurs par défaut sont écrites au premier lancement (seed de `DEFAULT_SETTINGS`).

### 6.4 Relations Drizzle

Comme dans Gaz, les relations sont déclarées dans `db/schema.ts` et les requêtes utilisent `db.query...with(...)` pour des **JOIN automatiques** (pas de `SELECT` avec colonnes en dur). Le mapping vers les types applicatifs est centralisé dans des fonctions `mapXxxRow()` de `lib/operations.ts`.

- `customers → sales_invoices`, `customers → service_jobs`, `customers → furniture_orders` (1-N)
- `suppliers → purchase_invoices` (1-N)
- `categories → products` (1-N) · `products → stock_movements` (1-N)
- `sales_invoices → customers` (1-1), `sales_invoices → sales_invoice_items` (1-N)
- `purchase_invoices → suppliers` (1-1), `purchase_invoices → purchase_invoice_items` (1-N)
- `cash_sessions → cash_movements` (1-N)
- `service_jobs → customers` (1-1) + `service_job_materials` / `service_job_workers` (1-N)
- `workers → service_job_workers` / `brick_production_workers` / `furniture_order_workers` (1-N)
- `brick_types → products` (1-1), `brick_productions → brick_types` (1-1) + `brick_production_materials` / `brick_production_workers` (1-N)
- `furniture_orders → furniture_models` / `customers` (1-1) + `furniture_order_materials` / `furniture_order_workers` (1-N)
- `furniture_models → furniture_model_materials` (1-N)

### 6.5 Règles de données

1. **Montants** en `real`, en GNF, jamais arrondis avant l'affichage. Affichage : `new Intl.NumberFormat('fr-FR')` + suffixe `GNF`.
2. **Dates — règle unique et non négociable** : `date` est une date métier au format `YYYY-MM-DD` et c'est **le seul champ filtré** ; `created_at` est un horodatage réservé à la traçabilité. *Le mélange des deux formats est un bug garanti* : `CURRENT_TIMESTAMP` produit `"2026-01-15 09:32:11"` alors qu'un `<input type="date">` produit `"2026-01-15"`, et `BETWEEN '2026-01-15' AND '2026-01-15'` renvoie alors **zéro ligne**. Toute période se compare donc sur `date`, bornes inclusives.
3. **Invariant de stock** : `products.stock` = somme algébrique de `stock_movements`. Toute correction passe par `adjustStock()`.
4. **Aucune suppression silencieuse** : une facture validée s'**annule** (`status = 'cancelled'`, avec motif, auteur et date) et se réverse — mouvements de stock inversés, caisse contre-passée. Jamais de `DELETE` sur une pièce comptable.
5. **Paiement polymorphe** : `payments.reference_id` n'est pas une clé étrangère. L'intégrité est vérifiée dans `lib/payments.ts` ; un paiement orphelin est un bug applicatif, pas une impossibilité de la base.
6. **Instantanés** : les lignes de facture figent `product_name` et `unit`.
7. **Migrations** : tout changement de schéma passe par `db/schema.ts` + `npm run db:generate`. Les migrations sont embarquées dans l'app packagée et exécutées au démarrage.
8. **SQL brut** : uniquement `rawGet()`, `rawAll()`, `rawRun()`, `withRawTransaction()` de `db/index.ts` (le driver libSQL est asynchrone).

### 6.6 Ce que l'on ne crée **pas** (choix assumé)

| Non créé | Raison |
|---|---|
| Table `units` | §13 demande des unités configurables : une **liste dans `settings`** suffit — 1 table et 1 CRUD en moins |
| Table `expense_categories` | Idem, liste dans `settings`. Mais **liste fermée** : jamais de saisie libre, sinon les rapports par catégorie deviennent faux (« Transport » ≠ « transport ») |
| Table `customer_types` | Non demandée par §2 |
| Fusion `customers` + `suppliers` en `tiers` | Séduisant mais ambigu pour les requêtes, pour zéro gain |
| `products.kind` (le type reste sur `categories`) | Un seul endroit à paramétrer |
| `stock_movements.type = 'loss'` | `exit` + motif explicite suffit ; 3 types au lieu de 5 |
| Table de devis versionnée séparée | `service_jobs.quote_*` + `quote_status` couvrent §16 |
| Avoirs et retours marchandise | Hors cahier des charges |
| Soft-delete généralisé | `is_active` pour les référentiels, annulation pour les pièces comptables |
| Index explicites | Base locale de quelques milliers de lignes : aucun gain mesurable |
| Multi-magasin, lots/séries, scanner, imprimante thermique | Backlog lot 5 (§15 « évolutions ») |

### 6.7 Colonnes de synchronisation (option PostgreSQL)

Chaque table métier reçoit **quatre colonnes** dès le lot 0, même si la synchronisation reste désactivée : les ajouter plus tard obligerait à migrer 30 tables sur des postes déjà en production.

| Colonne | Type | Rôle |
|---|---|---|
| `sync_id` | text, **unique** | Identité **globale** (UUID v4). Le `id` entier reste la clé primaire **locale** |
| `updated_at` | timestamp | Détection des changements et arbitrage des conflits |
| `deleted_at` | timestamp, nullable | **Tombstone** : aucune suppression physique sur une table synchronisée |
| `origin_device_id` | text | Quel poste a écrit la ligne |

Plus **cinq tables locales** (`devices`, `sync_state`, `sync_outbox`, `sync_pending`, `sync_conflicts`) → **35 tables** au total côté poste.
Le mode A (sauvegarde unidirectionnelle) et le mode B (multi-postes) sont décrits en [§23](#23-synchronisation-avec-postgresql-option-en-ligne).

---

## 7. Modules fonctionnels

### 7.1 Tableau de bord (§1)
Ventes du jour / semaine / mois · Chiffre d'affaires et **bénéfice estimé** · **Montant disponible en caisse** · **Clients débiteurs** et **dettes fournisseurs** · Produits en **stock faible ou en rupture** · Produits les plus vendus · Dernières opérations.
Reprise du composant `MetricCard` + graphiques Chart.js de Gaz, avec filtres de période `aujourd'hui / semaine / mois / année / total` (comme `/rapports`).

### 7.2 Clients (§2)
Ajouter, modifier, rechercher · Nom, téléphone, adresse, informations utiles · **Historique complet des achats** · **Montant payé et restant à payer** · **Ventes à crédit** · **Enregistrement des paiements** · **Liste des clients débiteurs**.
Reprend `/clients` de Gaz (liste + modales CRUD + modale de détail avec statistiques + `/clients/[id]/paiements`), en ajoutant l'encours et le plafond de crédit.

### 7.3 Fournisseurs (§3)
Ajouter, modifier · Contacts et coordonnées · Historique des achats · Suivi des paiements · Montants restant à payer et dettes.
Structure identique à `/fournisseurs` de Gaz.

### 7.4 Produits et stocks (§4)
Produits : Alucobond, Staff, Placo, Meubles, Peinture, **vente de briques avec ses différents types**, etc. · **Catégories et unités** (pièce, ensemble, carton, m²) · **Prix d'achat et prix de vente** · Stock en temps réel · Entrées après achat / sorties après vente · **Historique des mouvements** · **Inventaire et correction de stock** · **Alertes de stock faible et rupture**.
Reprise du moteur `lib/stock.ts` de Gaz (`addStockMovement`, `updateProductStock`, `listStockProducts`, `listStockMovements`, `getStockSummary`, `adjustStock`) et de la page `/stocks`.

### 7.5 Achats (§5)
Marchandises achetées · Choix du fournisseur · Produits, quantités, prix d'achat · **Calcul automatique du total** · Paiement **comptant, partiel ou à crédit** · **Mise à jour automatique du stock** · **Suivi des dettes fournisseurs**.
Reprise de `createPurchaseInvoice()` + page `/factures-usine` de Gaz, renommée `/achats`.

### 7.6 Ventes (§6)
Vente rapide · **Client ou vente comptant** · Plusieurs produits · **Total et remises automatiques** · Comptant / partiel / crédit · Espèces, Mobile Money, virement, autres · **Déduction automatique du stock** · Historique, correction et **annulation selon autorisation**.
→ Détaillé en [§10](#10-la-création-de-ventes).

### 7.7 Factures et reçus (§7)
Numéro unique **compatible avec le format actuel de Planète Déco Sarlu** (voir Q1) · Produits, quantités, prix unitaire, montant (GNF) · **Informations client et entreprise avec logo** · **Sous-total, remise, total HT, TVA, total à payer** · Statut payée / partiellement payée / impayée · **Statut de paiement (intégral, acompte, solde) et échéancier en cas de crédit** · **Impression et génération PDF** · **Réimpression des anciennes factures** · **Reçu après chaque paiement**.

### 7.8 Caisse et solde (§8)
Ouverture avec montant initial · Entrées et sorties · **Calcul du solde** · Gestion **Espèces / Mobile Money** · **Clôture journalière** · Historique des mouvements.
Base : le `wallet_transactions` et la page `/portefeuille` de Gaz, renommés **`cash_movements`** et `/caisse`, augmentés du **moyen de paiement**, de l'**origine** du mouvement et des **sessions** `cash_sessions`.

### 7.9 Dépenses (§9)
Transport, loyer, salaire, carburant, électricité et autres · **Catégories personnalisables** · Montant, date, description · Historique et **rapports par période**.
Nouveau module — voir §14.

### 7.10 Soldes, dettes et bénéfices (§10)
Solde de chaque client · **Total des créances clients** · Solde de chaque fournisseur · **Total des dettes fournisseurs** · Chiffre d'affaires · **Marge et bénéfice brut** · **Bénéfice net après dépenses** · Produits les plus rentables.
Calculs hérités de `calculateSalesProfitMetrics()` et `getRapportData()` de Gaz, enrichis de la prise en compte des dépenses.

### 7.11 Rapports (§11)
Ventes par période · Achats · Produits vendus · Stock disponible · Ruptures · Clients débiteurs · Dettes fournisseurs · Caisse et dépenses · CA et bénéfices · **Export PDF et Excel** · **Envoi SMS / WhatsApp** (configurable, programmé ou manuel, avec historique).
→ Détaillé en [§16](#16-rapports-et-envoi-sms--whatsapp).

### 7.12 Utilisateurs (§12) · 7.13 Paramètres (§13) · 7.14 Sauvegarde et sécurité (§14)
→ Voir [§17](#17-utilisateurs-rôles-et-historique-des-actions), [§9](#9-les-paramètres), [§18](#18-sauvegarde-restauration-et-sécurité).

### 7.15 Livraison et évolutions (§15)
Windows ✓ · local sans Internet ✓ · interface simple ✓ · impression et PDF ✓ · **évolutions** : multi-postes, version web/mobile, multi-magasins, scanner code-barres, imprimante thermique, devis et commandes → **backlog lot 5**, hors périmètre de la V1.

### 7.16 Prestations, briqueterie, atelier
→ Voir [§19](#19-prestations-de-services-chantiers), [§20](#20-gestion-de-la-briqueterie), [§21](#21-gestion-de-latelier-de-meubles).

---

## 8. La manière d'utiliser les modales

Toute création, modification, confirmation ou consultation passe par **le composant `Modal` unique**, identique à celui du projet Gaz. Il n'existe **aucun** `window.confirm`, `alert` ou `prompt` dans l'application, et aucune modale codée à la main.

### 8.1 Le composant (`components/modal.tsx`) — repris tel quel

```tsx
interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string | React.ReactNode;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';   // max-w-sm | lg | 2xl | 4xl
  /** Force le plein écran sur mobile (style bottom sheet). Défaut false. */
  fullScreenMobile?: boolean;
}
```

Caractéristiques : overlay `bg-black/50 backdrop-blur-sm` cliquable pour fermer · animation `framer-motion` (spring, entrée depuis le bas sur mobile) · `max-h-[90vh] overflow-y-auto` · bouton `✕` en haut à droite · `AnimatePresence` pour l'animation de sortie · en-tête séparé par un filet (`border-b`).

### 8.2 Les 4 familles de modales

| Famille | `size` | `fullScreenMobile` | Contenu type |
|---|---|---|---|
| **Confirmation** | `sm` | `false` | Icône + phrase de conséquence + `Annuler` / `Confirmer` |
| **Formulaire** (créer / modifier) | `md`, `lg`, `xl` | `true` | Champs, `Annuler` / `Enregistrer` (spinner pendant l'envoi) |
| **Détail** (fiche, facture) | `lg`, `xl` | `true` | Grille de stats + lignes + actions |
| **Sélection rapide** (choisir un produit, un client) | `lg` | `true` | Recherche + liste cliquable |

### 8.3 Conventions obligatoires

1. **Un état booléen par modale**, nommé `showXxxModal` (`showResetModal`, `showSeedModal`, `showPaymentModal`…). Jamais de modale « générique » pilotée par une chaîne.
2. **`onClose` ne ferme jamais pendant une opération en cours** — garde explicite :
   ```tsx
   onClose={() => { if (!isSubmitting) setShowXxxModal(false); }}
   ```
3. **Le bouton de confirmation est désactivé pendant l'envoi** et affiche `<span className="loading loading-spinner loading-sm" />`.
4. **Icône d'avertissement colorée** dans l'en-tête du corps (`bg-error/10 text-error` pour destructif, `bg-success/10` pour création, `bg-warning/10` pour un effet de bord).
5. **Pied de modale systématique** : `flex justify-end gap-3 pt-4 border-t border-base-200` avec `Annuler` (`btn-ghost`) puis l'action.
6. **Feedback par toast** (`toast.success` / `toast.error` de `react-toastify`) — jamais de message d'erreur silencieux. Les erreurs longues (stock insuffisant) utilisent `{ autoClose: 8000 }`.
7. **Modales imbriquées évitées** : pour un enchaînement (ex. « annuler une vente » → « saisir le motif »), on ferme la première puis on ouvre la seconde.
8. **Formulaires en colonne sur mobile** : `grid-cols-1 sm:grid-cols-2` (ou `sm:grid-cols-3` pour les stats), jamais de tableau large dans une modale.

### 8.4 Modèle de référence — confirmation destructive

```tsx
<Modal
  isOpen={showDeleteModal}
  onClose={() => { if (!isDeleting) setShowDeleteModal(false); }}
  title="Confirmer la suppression"
  size="sm"
>
  <div className="py-2">
    <div className="flex items-center gap-3 mb-4">
      <div className="bg-error/10 p-3 rounded-full">
        {/* icône d'avertissement */}
      </div>
      <p className="text-base-content/70">
        Voulez-vous vraiment supprimer <strong>{item?.name}</strong> ?
        <br />
        <span className="text-sm">Cette action est définitive.</span>
      </p>
    </div>
    <div className="flex justify-end gap-3 pt-4 border-t border-base-200">
      <button type="button" onClick={() => setShowDeleteModal(false)} disabled={isDeleting} className="btn btn-ghost">
        Annuler
      </button>
      <button type="button" onClick={handleDelete} disabled={isDeleting} className="btn btn-error">
        {isDeleting ? <span className="loading loading-spinner loading-sm" /> : 'Confirmer'}
      </button>
    </div>
  </div>
</Modal>
```

### 8.5 Modales prévues, module par module

| Module | Modales |
|---|---|
| Clients | Créer / modifier · Détail (stats) · Enregistrer un paiement · Supprimer · Créer un type de client |
| Fournisseurs | Créer / modifier · Détail + historique · Payer une dette · Supprimer |
| Produits | Créer / modifier · Ajuster le stock · Catégories · Unités · Supprimer |
| Achats | Nouvelle facture d'achat · Détail · Payer un reste · Supprimer |
| Ventes | **Paiement / acompte** · Détail de facture · **Annulation (avec motif)** · Supprimer un brouillon |
| Caisse | Ouvrir la caisse · Clôturer la caisse · Nouvelle entrée / sortie |
| Dépenses | Créer / modifier · Catégories |
| Utilisateurs | Créer / modifier · Désactiver · Supprimer |
| Paramètres | Réinitialiser la base · Préremplir les données · **Restaurer une sauvegarde** · Envoyer un rapport de test |
| Chantiers | Nouveau devis · Nouvelle prestation · Affecter équipe / ouvriers · Matériaux · Facturer |
| Briqueterie | Nouvelle fabrication · Étapes du lot · Matières premières · Ouvriers · Pertes |
| Atelier | Nouvelle commande · Fiche modèle · Matériaux · Ouvriers · Livraison |

---

## 9. Les paramètres

Architecture reprise **à l'identique** de Gaz : un **contexte global** `SettingsProvider` + `useSettings()` dans `app/parametres/page.tsx`, qui charge les paramètres **une seule fois** après authentification, les expose à toute l'application (`app-shell.tsx` les utilise pour le nom d'entreprise et les couleurs) et applique les couleurs en temps réel.

**Stockage** : contrairement à Gaz (une ligne typée), les paramètres sont stockés en **clé/valeur** dans la table `settings` (`key`, `value`). Une **couche typée** `lib/settings.ts` (`Settings`, `DEFAULT_SETTINGS`, `getSettings()`, `updateSettings()`) rétablit le typage et les valeurs par défaut, ce qui permet de **reprendre le front de Gaz sans modification** tout en ajoutant un réglage **sans migration**.

### 9.1 Comportement (identique à Gaz)

- Chargement via `GET /api/parametres` (`cache: 'no-store'`, `credentials: 'same-origin'`), fusion avec `defaultSettings`, **protection contre les réponses obsolètes** par `requestIdRef`.
- `updateSettings(updates, { silent })` → `PUT /api/parametres` ; `silent: true` évite le double toast quand la page gère déjà le message.
- **Application immédiate** des couleurs pendant la saisie (avant même l'enregistrement) via `applyThemeColors()`.
- `applyThemeColors(primary, sidebar, isDark)` écrit les variables CSS DaisyUI v5 (`--color-primary`, `--color-secondary`, `--color-accent`, `--color-base-*`, `--sidebar-color`, `--sidebar-text`) en **OKLCH** — conversion depuis l'hexadécimal dans `lib/colors.ts`. Le contraste du texte est calculé automatiquement (`getContrastOklch`).
- Les couleurs sémantiques (`info`, `success`, `warning`, `error`) restent **fixes** pour ne pas perdre leur sens.

### 9.2 Clés de la table `settings`

Structure : `key` (text, PK) · `value` (text, not null) · `updated_at`. Les valeurs par défaut sont écrites au premier lancement (`DEFAULT_SETTINGS`).

| Clé | Défaut | Section |
|---|---|---|
| `company_name` | `Planète Déco Sarlu` | Entreprise |
| `company_branch` | `Filiale Meubles` | Entreprise |
| `company_address`, `company_phone`, `company_email` | — | Entreprise |
| `company_logo` | — | Entreprise : logo sur les factures (§7, §13) |
| `company_tax_id` (NIF) | — | Entreprise |
| `currency` / `currency_symbol` | `GNF` / `GNF` | Devise |
| `date_format` | `DD/MM/YYYY` | Format |
| `invoice_prefix` | `FAC` | Numérotation |
| `invoice_number_format` | `{PREFIX}-{YYYY}-{NNNNNN}` | Numérotation (voir Q1) |
| `purchase_prefix` | `ACH` | Numérotation |
| `receipt_prefix` | `REC` | Numérotation |
| `default_tax_rate` | `0` | TVA (voir Q2) |
| `payment_methods` | `Espèces, Mobile Money, Virement, Crédit` | Paiements |
| `units` | `pièce, ensemble, carton, m², kg, sac, litre` | Référentiels (§13) — **liste fermée**, pas de table |
| `expense_categories` | `Transport, Loyer, Salaire, Carburant, Électricité, Autre` | Référentiels (§9, §13) — **liste fermée**, pas de table |
| `theme` | `light` | Apparence |
| `primary_color` | `#1e40af` | Apparence |
| `sidebar_color` | `#1e293b` | Apparence |
| `low_stock_alert` | `true` | Alertes |
| `default_stock_min` | `0` | Alertes |
| `report_channels` | `whatsapp` | Rapports |
| `report_recipients` | — | Rapports |
| `report_frequency` | `manual` (`day` \| `week` \| `month`) | Rapports |
| `report_send_time` | `20:00` | Rapports |
| `report_provider_config` | — | Rapports (clé API, expéditeur — JSON) |

### 9.3 Sections de la page Paramètres

Reprise du patron `SettingsCard` (titre + icône colorée + corps) de Gaz :

1. **Informations de l'entreprise** — nom, filiale, téléphone, email, adresse, **logo (upload)**, NIF.
2. **Apparence** — couleur principale, couleur du sidebar (sélecteur couleur + saisie hexadécimale + pastille de prévisualisation).
3. **Devise et format** — devise, symbole, format de date.
4. **Préfixes et numérotation** — préfixe facture / achat / reçu, gabarit du numéro, **taux de TVA par défaut**.
5. **Paiements** — moyens de paiement actifs.
6. **Stock** — activation des alertes, seuil par défaut.
7. **Rapports SMS / WhatsApp** — canal, destinataires, fréquence, heure, configuration de la passerelle, **bouton « Envoyer un rapport de test »**.
8. **Application** — version + `electron-updater` (`UpdateStatus`).
9. **Zone dangereuse** — réinitialiser les données · préremplir les données de démonstration.
10. **Sauvegarde** — télécharger la base `.db` · **restaurer une sauvegarde**.

> Les cartes **Zone dangereuse** et **Préremplir** restent **masquées en production et dans l'app desktop** (`hideDatabaseActions`), comme dans Gaz — outils de développement uniquement.

---

## 10. La création de ventes

Flux repris du projet Gaz, étape par étape, étendu aux remises, à la TVA, au crédit et aux reçus.

### 10.1 Parcours utilisateur

```
/ventes  ──[+ Nouvelle vente]──▶  /ventes/nouvelle  ──▶  POST /api/ventes  ──▶  /ventes (liste)
                                                                    │
                                                                    ├─▶ mouvement de stock (sortie)
                                                                    ├─▶ caisse (entrée si encaissement)
                                                                    └─▶ journal d'actions
```

### 10.2 Page `/ventes/nouvelle` — état du formulaire

Reprise exacte de la structure de `app/ventes/nouvelle/page.tsx` de Gaz :

```tsx
const [products, setProducts] = useState<Product[]>([]);
const [customerName, setCustomerName] = useState('');      // vente comptoir possible
const [customerId, setCustomerId] = useState('');          // si client existant
const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
const [paymentMethod, setPaymentMethod] = useState('Espèces');
const [amountPaid, setAmountPaid] = useState('');
const [discountAmount, setDiscountAmount] = useState('');  // nouveau (remise)
const [taxRate, setTaxRate] = useState(defaultTaxRate);     // nouveau (TVA)
const [notes, setNotes] = useState('');
const [lines, setLines] = useState<Line[]>([{ productId: '', quantity: '1', unitPrice: '', discount: '' }]);
const [isSubmitting, setIsSubmitting] = useState(false);
```

- Les produits sont chargés via `GET /api/produits?all=true&limit=100` avec `AbortController` (annulation propre au démontage).
- La première ligne est **préremplie** avec le premier produit et son prix de vente ; le montant encaissé suit.
- `handleProductChange()` repose automatiquement le **prix de vente du produit** dans la ligne (modifiable pour refléter une remise négociée).
- Ajout / suppression de lignes : bouton « Ajouter » en haut à droite, icône poubelle par ligne, **suppression désactivée quand il ne reste qu'une ligne**.
- Tableau de saisie `table table-xs` : Produit · Qté · Prix unit. · Remise · Total · (supprimer) ; pied de tableau avec **Total général**.

### 10.3 Calculs affichés en direct

```
totalLigne   = quantité × prix unitaire − remise ligne
sousTotal    = Σ totalLigne
totalHT      = sousTotal − remise globale
montantTVA   = totalHT × (taux TVA / 100)
totalAPayer  = totalHT + montantTVA
resteÀPayer  = max(totalAPayer − montantEncaissé, 0)
```

### 10.4 Statut de paiement (règle reprise de Gaz)

```
montantEncaissé ≤ 0            → "En attente"      (crédit total)
resteÀPayer > 0                → "Partiel"         (acompte)
resteÀPayer = 0                → "Payée"
```

### 10.5 Chaîne d'enregistrement (côté serveur)

`POST /api/ventes` → validation → `createSalesInvoice()` de `lib/operations.ts` :

1. **Vérification du stock** (`buildSalesItems`) — reprise exacte de Gaz : si la quantité demandée dépasse `product.stock`, l'erreur liste **tous** les produits en rupture et remonte en **HTTP 400** :
   > `Stock insuffisant pour créer la vente : • Placo BA13 : stock insuffisant (disponible: 10, demandé: 15)`
   Le front l'affiche en toast `autoClose: 8000`.
2. **Numérotation** — `invoiceNumber` généré depuis `invoice_prefix` + année + compteur sur 6 chiffres (`FAC-2026-000001`), sans trou. Voir Q1 pour le format exact attendu par Planète Déco.
3. **Insertion** de la facture puis de ses lignes.
4. **Rattachement du client** : si le nom saisi correspond à une fiche existante, `customer_id` est renseigné sur la facture (la vente comptoir peut donc être rattachée a posteriori). Les totaux d'achat et les soldes clients **ne sont pas stockés** : ils sont calculés depuis les factures et les paiements.
5. **Mouvements de stock** : un `exit` par ligne dans `stock_movements`, avec `reference_type = 'sale'` et `reference_id` = identifiant de la facture.
6. **Caisse** : si `amountPaid > 0`, une entrée est créée dans `cash_movements` avec `payment_method` (Espèces / Mobile Money), `reference_type = 'sale'` et la **session de caisse ouverte** (`session_id`).
7. **Reçu** : un enregistrement `payments` est créé pour l'encaissement initial, avec un **`receipt_number` unique** → reçu imprimable (§7).
8. **Journal d'actions** : `audit_logs` (`action = create`, `entity = sales_invoice`).
9. Retour `201` avec la facture créée → redirection vers `/ventes`.

### 10.6 Modification, annulation, correction (§6)

- **Modification** : `updateSalesInvoice()` recalcule les totaux, **reverse** les anciens mouvements de stock et applique les nouveaux (différence par différence, comme Gaz via `areQuantityMapsEqual`).
- **Annulation** : réservée aux rôles **admin** et **gérant** (`lib/permissions.ts`). La facture passe en `cancelled` avec **motif obligatoire**, les mouvements de stock sont **inversés**, l'entrée de caisse **contre-passée**. Aucun `DELETE`.
- **Brouillon** (`status = draft`) : une vente préparée mais non validée **ne touche ni le stock ni la caisse**.

### 10.7 Paiements ultérieurs d'une vente à crédit

Depuis `/ventes/[id]` ou `/clients/[id]/paiements` : modale **« Enregistrer un paiement »** → date, montant, moyen, note → `POST /api/paiements` → insertion dans `payments` (`type = 'sale'`, `receipt_number` généré), recalcul de `amount_paid` / `remaining_amount` / `payment_status`, entrée de `cash_movements`, **reçu imprimable**, journal d'actions.

---

## 11. Factures, reçus, impressions et exports

- **En-tête** : logo (depuis `settings`), nom d'entreprise, filiale, adresse, téléphone, email, NIF.
- **Bloc client** : nom, téléphone, adresse ; mention « Client comptoir » sinon.
- **Corps** : `#`, code, désignation, quantité, unité, prix unitaire, remise, montant.
- **Pied** : sous-total, remise, **total HT**, TVA (taux + montant), **total à payer**, montant payé, **reste à payer**, statut.
- **Numéro et date** en évidence, éventuellement l'échéance si crédit.
- **Impression** : styles `print:` (masquage sidebar / boutons), comme la page `app/ventes/[id]` de Gaz.
- **Export PDF / Image** : `ExportDropdown` + `lib/export-document.ts`.
- **Partage WhatsApp** : `shareOnWhatsApp(html, message, fileName)` — Web Share API sur mobile, repli WhatsApp Web sur desktop, avec le message pré-formaté (numéro, client, total, reste à payer).
- **Réimpression** : toute facture reste consultable et réimprimable indéfiniment (`GET /api/ventes/[id]`).
- **Reçu de paiement** : document court (n° de reçu, facture liée, montant reçu, reste dû, moyen de paiement, caissier).

### 11.1 Comment l'export fonctionne — et pourquoi ainsi

> **Correction d'un défaut bloquant constaté en recette.** L'export PDF et image
> échouait avec « L'image n'a pas pu être générée. »

**La cause.** `html2canvas@1.4.1` ne sait analyser que `rgb()`, `rgba()`, `hsl()`,
`hsla()` et les couleurs nommées — les chaînes `oklch`, `oklab`, `lab` et `lch`
n'apparaissent **pas une seule fois** dans son code. Or Tailwind 4 et DaisyUI 5
n'émettent plus que des `oklch()`, et une simple opacité comme `border-primary/70`
produit un `color-mix()`. Capturer la page affichée était donc impossible.

**Ce qui ne marche pas.** Convertir les couleurs juste avant la capture. Vérifié
dans un vrai navigateur : `ctx.fillStyle = 'oklch(45% .24 277)'` renvoie
`oklch(0.45 0.24 277.023)` — le navigateur **normalise** la couleur sans la
convertir en sRGB. Réimplémenter les maths OKLab/CIE Lab à la main aurait été
long et risqué pour un document comptable, où une couleur fausse est pire qu'une
erreur visible.

**La solution retenue — celle du projet Gaz.** On ne capture jamais la page : on
écrit un **document HTML autonome** (`renderExportDocument`), avec sa propre
feuille de styles et des **couleurs hexadécimales uniquement** (y compris la
couleur principale du client, `settings.primaryColor`, qui est un hexadécimal),
dans un **iframe invisible**, puis on capture `iframeDoc.body`.

| Avant | Après |
|---|---|
| Capture de la page affichée (`oklch` → échec) | Document HTML autonome en hexadécimal |
| Partage WhatsApp de `element.outerHTML` (classes Tailwind **sans** leur feuille de styles → image non stylée) | Le **même** document HTML pour PDF, image **et** WhatsApp |
| Image étirée sur une page A4 (facture déformée) | Proportions conservées, **pagination** si le document dépasse une page |
| `catch { toast.error("L'image n'a pas pu être générée.") }` — cause masquée | `toast.error(error?.message ?? …)` — la cause réelle remonte |

**Vérification automatisée** : `npm run verify:export` pilote un vrai navigateur
via le protocole DevTools, ouvre une facture, déclenche réellement les deux
exports et lit les messages affichés. Dernier passage : *« Image générée. »
(302 ms) et « PDF généré. » (879 ms)*.

> La bibliothèque reste `html2canvas` (celle de Gaz) : dès lors que le document
> exporté ne contient que des hexadécimaux, la version 1.4.1 suffit. Aucune
> dépendance supplémentaire n'a donc été ajoutée (README §4.5).

---

## 12. Stock et inventaire

Moteur repris de `lib/stock.ts` (Gaz), inchangé dans son principe :

| Fonction | Rôle |
|---|---|
| `addStockMovement(productId, type, quantity, {referenceType, referenceId, motif})` | Insère le mouvement **et** met à jour `products.stock`, en conservant `stock_before` / `stock_after` |
| `updateProductStock(productId)` | Recalcule le stock depuis le journal (réparation / audit) |
| `listStockProducts({ search, lowStockOnly })` | Liste avec `stock_value`, `is_low` |
| `listStockMovements({ productId, page, limit })` | Historique paginé |
| `getStockSummary()` | Total produits, stock total, valeur d'achat, valeur de vente, alertes, ruptures |
| `adjustStock(productId, delta, motif)` | **Inventaire / correction** : enregistre un **écart** (`adjustment`), jamais une valeur absolue |

Types de mouvements : **`entry`** (achat, mise en stock d'une production), **`exit`** (vente, matériaux de chantier, matières premières consommées, meuble livré), **`adjustment`** (inventaire — **écart signé**).
> Les **briques cassées** (§17) et les **chutes de bois** (§18) sont des `exit` avec un motif explicite, pas un type dédié : trois types suffisent et le journal reste simple.

Règles : quantité **décimale** (real) ; `stock` ne descend jamais sous 0 ; **rupture bloquante** à la vente ; alerte dès `stock ≤ stock_min` ; **invariant** `products.stock` = somme algébrique des mouvements.

---

## 13. Caisse et solde

| Fonction du cahier des charges | Mise en œuvre |
|---|---|
| Ouverture avec montant initial | Modale « Ouvrir la caisse » → `cash_sessions` (`opening_amount`, `opened_by`, `status = 'open'`) |
| Entrées et sorties d'argent | `cash_movements` (`income` / `expense`), alimentées automatiquement par les ventes, les encaissements clients, les achats payés, les dépenses, et manuellement |
| Calcul du solde | `balance_after` recalculé à chaque mouvement + `GET /api/caisse/summary` |
| Espèces et Mobile Money | Colonne **`payment_method`** sur chaque mouvement + répartition dans le résumé |
| **Clôture journalière** | Modale « Clôturer la caisse » → `counted_amount` saisi, **`theoretical_amount`** calculé, **`difference`** (`counted − theoretical`), note, `status = 'closed'` |
| Historique des mouvements | Table paginée + filtres (type, moyen de paiement, période, session) |

Règles : **une seule session `open` à la fois** ; tant qu'elle est fermée, toute vente encaissée propose d'abord l'ouverture ; chaque mouvement porte son **origine** (`reference_type` / `reference_id`) pour permettre le rapprochement caisse ↔ vente ↔ dépense.

---

## 14. Achats et dépenses

Deux modules **distincts**, conformément au cahier des charges :

| | **Achats** (§5) | **Dépenses** (§9) |
|---|---|---|
| Nature | Marchandises revendues | Frais de fonctionnement |
| Exemples | Alucobond, Placo, briques, bois | Transport, loyer, salaire, carburant, électricité |
| Fournisseur | Obligatoire | Optionnel |
| Lignes produits | Oui (quantités, prix d'achat) | Non (montant global) |
| **Stock** | **Mis à jour** (entrées) | **Non touché** |
| **Caisse** | Sortie si payé / acompte | **Sortie systématique** |
| Dettes | Dette fournisseur suivie | — |
| Catégories | Catégories produits | `expense_categories` personnalisables |
| Route | `/achats` | `/depenses` |

Les deux alimentent le **bénéfice net** (§10) et les **rapports par période** (§11).

---

## 15. Soldes, dettes et bénéfices

| Indicateur | Calcul |
|---|---|
| Solde d'un client | Σ `sales_invoices.total` − Σ `payments` de ses factures |
| **Total créances clients** | Σ `remaining_amount` des factures non annulées (`status = 'active'`) |
| Solde d'un fournisseur | Σ `purchase_invoices.total` − Σ `payments` |
| **Total dettes fournisseurs** | Σ `remaining_amount` des achats non soldés |
| **Chiffre d'affaires** | Σ `sales_invoices.total_ht` (ventes actives) **+** Σ `service_jobs.total` (prestations, §16) — les deux sont **des documents facturables autonomes**, jamais comptés deux fois |
| **Marge brute** | Σ (`unit_price` − `products.purchase_price`) × quantité |
| **Bénéfice brut** | CA − coût des marchandises vendues |
| **Bénéfice net** | Bénéfice brut **− `expenses`** de la période − main-d'œuvre des chantiers et des fabrications |
| Produits les plus rentables | Tri par marge unitaire et par marge cumulée |

> **Aucun de ces montants n'est stocké** : ils sont tous calculés à la lecture, depuis les factures, les paiements et les dépenses. C'est ce qui garantit qu'un solde ne peut jamais « dériver ». Le prix d'achat utilisé pour la marge est celui **du jour de la vente** (lu sur `products.purchase_price`), et non celui du jour de l'édition du rapport.

Reprise de `calculateSalesProfitMetrics()` (Gaz) et de la structure `RapportData` (`lib/rapports-types.ts`) : `summary`, `comparison`, `monthlyData`, `soldByProduct`, `productMargins`, `topCustomers`, `receivables`, `payables`, `stockInsights`, `decisionSummary` — complétés par `expenses`, `netProfit` et `jobCosts`.

---

## 16. Rapports et envoi SMS / WhatsApp

### 16.1 Rapports affichés et exportés (§11)
Ventes par période · Achats · Produits vendus · Stock disponible · Ruptures · Clients débiteurs · Dettes fournisseurs · Caisse et dépenses · CA et bénéfices.
**Export PDF** (jsPDF + html2canvas) et **export CSV** (compatible Excel, sans dépendance externe). Page `/rapports` reprise de Gaz : période personnalisée, filtres produit / client / fournisseur / statut de paiement, résumé décisionnel et comparaison avec la période précédente.

### 16.2 Envoi automatique des rapports (§11)

| Fonction attendue | Mise en œuvre proposée |
|---|---|
| Envoi du rapport du jour / semaine / mois | Message texte synthétique généré depuis `getRapportData()` |
| Destinataires configurables (gérant, propriétaire, responsable) | `settings.report_recipients` (liste) |
| Résumé : ventes, CA, bénéfice, caisse, dettes | Gabarit dans `lib/report-sender.ts` |
| Envoi **manuel** à la demande | Bouton « Envoyer le rapport » sur `/rapports` et `/parametres` |
| Envoi **programmé** (chaque soir / fin de semaine / fin de mois) | Vérification au démarrage et à intervalle régulier tant que l'application est ouverte (voir Q8) |
| **Historique des rapports envoyés** | Table `report_deliveries` + écran de consultation |

### 16.3 Canaux

| Canal | Mode | Remarque |
|---|---|---|
| **WhatsApp** | Lien `wa.me` pré-rempli (mode manuel/semi-automatique) ou **WhatsApp Cloud API** (mode automatique, nécessite un jeton Meta et Internet) | À trancher en Q9 |
| **SMS** | Passerelle opérateur / agrégateur (à choisir) | Nécessite un compte et Internet |

> ⚠️ **Contrainte à valider** : le logiciel fonctionne **sans Internet**. Un envoi réellement automatique par SMS/WhatsApp exige une connexion au moment de l'envoi. Le mode « semi-automatique » (le logiciel prépare le message et ouvre WhatsApp/SMS au moment programmé, l'utilisateur confirme) fonctionne hors ligne. Le mode « automatique » s'active dès qu'une connexion est disponible.

---

## 17. Utilisateurs, rôles et historique des actions

### 17.1 Authentification
Système **repris de Gaz** : hachage **SHA-256** (`crypto.subtle.digest`), cookies `session`, `session_user` (httpOnly) et `user`, protection de toutes les routes par **`proxy.ts`** (Next 16 : `middleware.ts` n'existe plus), setup du premier administrateur via `/api/auth/setup`.
➡️ **Le compte administrateur codé en dur du projet Gaz est supprimé** (voir §3.4).

### 17.2 Rôles et permissions

| Action | Admin | Gérant | Vendeur / Caissier | Magasinier |
|---|:--:|:--:|:--:|:--:|
| Tableau de bord | ✅ | ✅ | ✅ | ✅ |
| Créer une vente | ✅ | ✅ | ✅ | ❌ |
| Modifier une vente | ✅ | ✅ | ✅ (du jour) | ❌ |
| **Annuler une vente** | ✅ | ✅ | ❌ | ❌ |
| Clients / fournisseurs | ✅ | ✅ | consultation + création | consultation |
| Produits / prix d'achat | ✅ | ✅ | consultation | consultation |
| Achats | ✅ | ✅ | ❌ | ✅ (réception) |
| Stock / inventaire | ✅ | ✅ | ❌ | ✅ |
| Caisse : ouvrir/clôturer | ✅ | ✅ | ✅ | ❌ |
| Dépenses | ✅ | ✅ | saisie | ❌ |
| Rapports | ✅ | ✅ | limité (jour) | ❌ |
| Paramètres | ✅ | partiel | ❌ | ❌ |
| Utilisateurs | ✅ | ❌ | ❌ | ❌ |
| Sauvegarde / restauration | ✅ | ❌ | ❌ | ❌ |

Implémentation : `lib/permissions.ts` (`can(user, 'sales.cancel')`) — **vérifié côté serveur** dans chaque Route Handler, jamais uniquement dans l'interface.

### 17.3 Historique des actions
`lib/audit.ts` → `writeAudit({ user, action, entity, entityId, details })`, appelé pour : connexion/déconnexion, création/modification/**annulation** de vente, encaissement, modification de prix, ajustement de stock, dépense, opérations sur les paramètres, sauvegarde/restauration, gestion des utilisateurs. Écran `/utilisateurs` → onglet **Historique** (filtres par utilisateur, action, date).

### 17.4 Permissions par utilisateur — *ajout demandé par le client (v2)*

> Le tableau §17.2 donne la permission **par défaut** de chaque rôle. Il ne
> suffit pas dans la pratique : le client veut pouvoir dire « ce vendeur-là, et
> pas les autres, peut annuler une vente » ou « ce caissier ne voit pas les
> bénéfices ». Cette section ajoute donc une **couche de surcharge par
> utilisateur**, sans renoncer à la simplicité du rôle.

**Les 57 actions** de l'application sont nommées et décrites dans
`lib/permissions.ts` (`Action`, `ALL_ACTIONS`, `ACTION_META`), regroupées en
9 domaines : Pilotage, Ventes, Clients et fournisseurs, Catalogue et stock,
Achats, Caisse et dépenses, Paiements, Production, Administration. Chaque action
porte un **libellé français** et une **phrase d'explication** — un
administrateur doit comprendre ce qu'il accorde.

**Trois états par action, et par utilisateur :**

| État | Effet |
|---|---|
| **Hérité** (aucune ligne en base) | la matrice du rôle s'applique |
| **Autorisé** (`allow`) | accordé **même si** le rôle le refuse |
| **Refusé** (`deny`) | retiré **même si** le rôle l'accorde |

**Ordre de résolution** (`resolvePermissions()`, `lib/permissions.ts`) :

1. `admin` → **toutes** les permissions, et les surcharges sont **ignorées**.
   C'est délibéré : *seul l'admin a droit à tout*, et l'application ne peut pas
   devenir inadministrable par un refus de permission. Une tentative de
   restriction est refusée avec un message explicite ;
2. surcharge `deny` → l'action est retirée ;
3. surcharge `allow` → l'action est accordée ;
4. sinon → matrice du rôle.

**Stockage** : table `user_permissions` (`user_id`, `action`, `effect`
`allow`/`deny`, `granted_by`, `note`) avec **unicité `(user_id, action)`** et les
quatre colonnes de synchronisation. C'est la **31ᵉ table métier** (le schéma
cible du §6.3 en comptait 30) ; le total côté poste passe donc à **36 tables**
(31 + 5 tables locales de synchronisation).

**Application — le point qui compte.** La décision est prise **par le serveur**
sur chaque appel d'API : `requireAction()` (`lib/api.ts`) résout les permissions
effectives via `getEffectivePermissions()` (`lib/user-permissions.ts`) avant de
répondre. Le navigateur reçoit la même liste par `GET /api/auth/me`
(`permissions`) et s'en sert pour **filtrer le menu et masquer les boutons** —
mais ce n'est qu'un confort : *masquer n'est pas protéger*. Un appel direct à
l'API avec un droit retiré reçoit **403**.

**Cache** : les permissions sont mises en cache 5 secondes par utilisateur
(une page déclenche plusieurs appels d'API) et le cache est **invalidé à chaque
écriture** — une décision ne peut pas être servie périmée.

**Écran** : `/utilisateurs` → bouton **« Permissions »** sur chaque ligne (sauf
administrateur) → modale listant les 57 actions par domaine, avec recherche,
raccourcis « Tout autoriser », « Tout refuser », « Réinitialiser (rôle) », et un
marqueur **« Sensible »** sur les actions à conséquence lourde (annulation de
vente, clôture de caisse, ajustement de stock, réinitialisation des données…).
Chaque changement est journalisé dans `audit_logs`.

**Ce que cela ne fait pas** : aucune notion de permission par **objet** (un
vendeur ne peut pas être limité à *ses* clients). La granularité est l'action,
pas la donnée — c'est le périmètre retenu, et il couvre le besoin exprimé.

---

## 18. Sauvegarde, restauration et sécurité

| Exigence (§14) | Mise en œuvre |
|---|---|
| Connexion sécurisée | Cookie httpOnly + SHA-256 ; **aucun compte en dur** |
| Accès limité selon les responsabilités | 4 rôles + `lib/permissions.ts` vérifié côté serveur |
| **Sauvegarde des données** | `GET /api/parametres/backup` → téléchargement du fichier SQLite complet (repris de Gaz) + bouton « Sauvegarder maintenant » |
| **Restauration d'une sauvegarde** | `POST /api/parametres/restore` : upload du `.db` → validation → **copie de sécurité automatique de la base courante** → remplacement → redémarrage (voir Q6) |
| **Confirmation des opérations sensibles** | Modale de confirmation obligatoire (intervalle, suppression, annulation de vente, réinitialisation, restauration) |
| **Historique des opérations** | `audit_logs` (§17.3) |
| Protection de l'accès desktop | **Jeton `x-app-token`** (404 sans jeton) + serveur lié à `127.0.0.1` |

**Sauvegarde automatique proposée** : une copie datée au premier lancement de chaque journée, conservée 30 jours, dans `%APPDATA%/planete-deco/backups/`. À valider (Q7).

---

## 19. Prestations de services (chantiers)

| Exigence (§16) | Mise en œuvre |
|---|---|
| Prestations par catégorie : Alucobond, Staff, Placo, Meuble, Peinture | `service_jobs.category` (`alucobond` \| `staff` \| `placo` \| `furniture` \| `painting`), page `/chantiers` filtrable |
| **Devis** (matériaux + main-d'œuvre) | `quote_materials` / `quote_labor` / `quote_total` + `quote_status` (brouillon / envoyé / accepté / refusé), générable en PDF |
| Informations du chantier : client, adresse, date de début | `customer_id`, `site_address`, `start_date`, `end_date` de `service_jobs` |
| **Suivi de l'avancement** (en attente, en cours, terminé) | `status` (`quote` \| `pending` \| `in_progress` \| `completed` \| `cancelled`) + avancement visuel, filtres |
| **Affectation d'une équipe / d'un ouvrier** | Table unique `workers` + `service_job_workers` (`days` × `daily_rate` = `amount`) |
| **Matériaux déduits du stock** | `service_job_materials` → mouvements `exit` (`reference_type = 'service_job'`) |
| **Facturation** (main-d'œuvre + matériaux) | La prestation est **un document facturable autonome** : son propre `reference`, son PDF, ses propres `payments` (`type = 'service_job'`). Elle ne génère **pas** de facture de vente → aucun double comptage du CA (§15) |
| Paiement comptant / partiel / crédit | `service_jobs.total` / `amount_paid` / `remaining_amount` / `payment_status` + `payments` (acompte, solde), reçus imprimables |
| Historique par client | Fiche client → onglet Chantiers |

**Coût de revient d'un chantier** = matériaux (prix d'achat) + main-d'œuvre (jours × tarif) ; **marge** = facturé − coût.

---

## 20. Gestion de la briqueterie

| Exigence (§17) | Mise en œuvre |
|---|---|
| Stock des matières premières : argile/terre, ciment, sable, eau, **bois de chauffe** | Produits dont la catégorie porte `kind = 'raw_material'` — **un seul moteur de stock** |
| Chaque type de brique + dimensions | `brick_types` (`shape`, `dimensions`) + `products` lié par `product_id` : c'est le produit qui porte le **prix de vente et le stock** |
| **Lancement d'une fabrication** : date, quantité prévue, ouvriers affectés | `brick_productions` + `brick_production_workers` |
| **Étapes** : moulage → séchage au soleil → cuisson au four → mise en stock | `stage` (`molding` \| `drying` \| `firing` \| `stored`) avec avancement visuel |
| **Main-d'œuvre** (ouvriers journaliers, apprentis) par production | `brick_production_workers` (`days` × `daily_rate` = `amount`), ouvrier pris dans `workers` ou saisi à la volée |
| **Matières premières consommées déduites du stock** | `brick_production_materials` → mouvements `exit` (`reference_type = 'brick_production'`) |
| **Briques cassées / ratées** | `broken_quantity` + un mouvement `exit` avec motif explicite (`"briques cassées lot #3"`) |
| **Coût de revient d'une brique** | `lib/cost-calculator.ts` : (`material_cost` + `labor_cost`) ÷ (`produced_quantity` − `broken_quantity`) — calculé, jamais stocké |
| **Stock de briques prêtes à vendre, par type** | Mouvement `entry` sur `products.stock` à l'étape `stored` |
| Rapport jour / semaine / mois : fabriquées, cassées, vendues | Section dédiée dans `/briqueterie` + `/rapports` |

---

## 21. Gestion de l'atelier de meubles

| Exigence (§18) | Mise en œuvre |
|---|---|
| Matières premières : bois (planches, chevrons), mousse, tissu, vernis, peinture, clous, colle, quincaillerie | Produits dont la catégorie porte `kind = 'raw_material'` |
| **Fiche de chaque modèle** + matériaux nécessaires | `furniture_models` + `furniture_model_materials` (nomenclature / BOM) : les besoins en matières d'une commande standard se calculent automatiquement |
| **Commandes** : meuble standard ou **sur mesure** (dimensions, goût du client) | `furniture_orders` (`is_custom`, `dimensions`, `finish`, `model_id` nullable) |
| **Suivi du travail** : découpe → assemblage → ponçage → peinture/vernis → finition | `stage` (`cutting` \| `assembly` \| `sanding` \| `painting` \| `finishing` \| `delivered`) + avancement |
| **Affectation** chef menuisier, ouvriers, apprentis | Table unique `workers` + `furniture_order_workers` (`role`, `days` × `daily_rate` = `amount`) |
| **Délai promis et respect de la livraison** | `promised_date` vs `delivery_date` → indicateur « livré à temps » |
| **Coût de revient** (bois et matériaux + main-d'œuvre) | `lib/cost-calculator.ts` → `material_cost` + `labor_cost` = `total_cost` |
| **Suivi des chutes de bois et pertes** | `furniture_order_materials.wastage_quantity` par matériau + mouvements `exit` motivés |
| **Stock de meubles finis** | `furniture_orders.product_id` → mouvement `entry` sur le produit fini à la livraison |
| Rapport hebdo / mensuel : fabriqués, en cours, livrés | Section dédiée dans `/atelier` + `/rapports` |

---

## 22. Application desktop (Electron)

Reprise **intégrale** de la chaîne desktop du projet Gaz :

| Élément | Détail |
|---|---|
| `electron/main.js` | Lance le serveur Next en `fork`, port libre (`findFreePort`), `HOSTNAME: '127.0.0.1'`, génère le jeton `crypto.randomBytes(32)`, l'injecte via `session.defaultSession.webRequest.onBeforeSendHeaders` **avant** `loadURL`, masque la barre de menu |
| `electron/preload.js` | Bridge IPC sécurisé (`contextIsolation`), expose `window.electronAPI` |
| `types/electron-api.d.ts` | Typage du bridge côté React |
| `db/index.ts` | En desktop, base dans `%APPDATA%/planete-deco/database.db` (`ELECTRON_APP_PATH`) |
| **Auto-update** | `electron-updater` : vérification au lancement, téléchargement automatique, confirmation de redémarrage. `UpdateStatus` dans `/parametres` |
| `.github/workflows/release.yml` | Sur tag `v*` : build Windows / macOS / Linux + Release GitHub avec `latest.yml` et blockmap |
| `scripts/copy-standalone.js` | Copie `.next/standalone` + `public/` + `db/migrations` |
| `scripts/release.js` | Commit, bump de version, tag, push |

Configuration `package.json` cible :
- `name: "gestion-planete-deco"`, `productName: "Planète Déco"`, `appId: "com.planetedeco.gestion"`
- `publish` : `provider: github` (dépôt à créer — voir Q10)
- Installeur Windows **NSIS** `Planète-Deco-Setup-${version}.exe`
- **Distribuer l'installateur**, jamais le dossier `win-unpacked`

Commandes : `npm run dev:desktop` · `build:desktop:win` · `build:desktop:mac` · `build:desktop:linux` · `release`.

---

## 23. Synchronisation avec PostgreSQL (option en ligne)

> **Option, jamais une obligation.** L'application reste **100 % fonctionnelle sans Internet** (§15). La synchronisation s'active et se désactive dans les paramètres ; son absence ne change **rien** au fonctionnement quotidien. Si le réseau tombe, le travail continue et la file d'attente se vide au retour de la connexion.

### 23.1 Deux modes, deux niveaux d'ambition

| Mode | Sens | Usage | Effort |
|---|---|---|---|
| **A — Sauvegarde en ligne** | Poste → PostgreSQL (**unidirectionnel**) | Un seul poste. PostgreSQL est une copie de sécurité **consultable à distance** : le gérant ou le propriétaire consulte l'activité sans être devant le poste. Aucun conflit possible | ~2 à 3 jours |
| **B — Multi-postes** | Poste ⇄ PostgreSQL (**bidirectionnel**) | Plusieurs ordinateurs partagent les **mêmes** données : boutique + magasin + atelier. Répond à §15 « évolution vers plusieurs ordinateurs » et « multi-magasins » | ~1 à 2 semaines |

Le mode A est le **prérequis technique** du mode B : les deux partagent le client de synchronisation, le format de payload et le schéma du serveur. **On livre donc le mode A d'abord**, et le mode B s'active par un réglage — pas par une réécriture.

### 23.2 Architecture

```
   POSTE 1 (Electron + SQLite)                                  ┌──────────────────────┐
   ┌───────────────────────────┐                                │   PostgreSQL (en ligne)│
   │ app Next.js locale        │       HTTPS + jeton appareil   │   30 tables métier    │
   │  └── lib/sync-client.ts ──┼───────────────────────────────▶│   + devices           │
   │  └── lib/sync-apply.ts    │◀───────────────────────────────┤   + sync_batches      │
   │  └── SQLite (source de    │       lots JSON idempotents    │   + sync_conflicts    │
   │      vérité locale)       │                                └──────────────────────┘
   └───────────────────────────┘
   POSTE 2, 3… (même schéma, ids globaux par UUID)
```

**Pourquoi une API de synchronisation et pas une connexion directe à PostgreSQL :**

| Connexion directe depuis chaque poste | API de synchronisation (retenue) |
|---|---|
| Les identifiants PostgreSQL sont **embarqués dans chaque poste** — un poste volé donne accès à toute la base | Le poste ne détient qu'un **jeton d'appareil révocable** |
| La base est exposée à Internet (port 5432) | Seuls 3 points d'entrée HTTPS sont exposés, validés par `zod` |
| Aucune trace de qui a envoyé quoi | Journal serveur (`sync_batches`) : appareil, horodatage, nombre de lignes |
| Le schéma devient un contrat public | Le serveur peut refuser une ligne incohérente |
| Une montée de version du schéma casse les postes non mis à jour | Le serveur gère la compatibilité de version de protocole |

> Une connexion directe reste **techniquement possible** pour un déploiement mono-poste (mode A minimal), et sera documentée comme telle, mais elle est **déconseillée** : le mode A se fait aussi simplement via l'API, sans exposer la base.

### 23.3 Colonnes de synchronisation — obligatoires

Chaque table métier reçoit **quatre colonnes** (c'est le coût réel de la synchronisation, et il est non négociable) :

| Colonne | Type | Rôle |
|---|---|---|
| `sync_id` | text, **unique** | **Identité globale (UUID v4)**. Indispensable : les `id` auto-incrémentés **se collisionnent** entre postes — le poste A crée la vente n° 12, le poste B crée aussi la vente n° 12, ce sont deux ventes différentes |
| `updated_at` | timestamp | Détection des changements et arbitrage des conflits |
| `deleted_at` | timestamp, nullable | **Tombstone**. Sans lui, une ligne supprimée sur un poste **ressusciterait** au prochain pull. Aucune suppression physique sur une table synchronisée |
| `origin_device_id` | text | Traçabilité : quel poste a écrit cette ligne |

> Le `id` entier **reste la clé primaire locale** (aucune réécriture des 30 tables ni de l'interface) ; `sync_id` est la clé **globale**. Une table locale `sync_refs` sert de cache de correspondance `sync_id ⇄ id`.

**Bonne nouvelle structurelle** : la quasi-totalité du schéma est **append-only** — `stock_movements`, `payments`, `audit_logs`, `report_deliveries`. Ces tables ne peuvent **pas** entrer en conflit : il n'y a rien à arbitrer. Les seules tables réellement conflictuelles sont les documents modifiables (`sales_invoices`, `purchase_invoices`, `products`, `customers`, `service_jobs`, `furniture_orders`, `brick_productions`, `cash_sessions`) — une dizaine sur trente.

### 23.4 Les références entre tables — le point difficile

Un payload ne peut **pas** transporter `customer_id: 12` : le client n° 12 du poste B n'est pas celui du poste A. **Toute référence circule donc par `sync_id`.**

Chaque ligne synchronisée est un objet :

```json
{
  "table": "sales_invoices",
  "sync_id": "8f14e45f-ea0d-4c1b-9f2a-77c1d3a90b12",
  "updated_at": "2026-03-04T18:22:07.000Z",
  "deleted_at": null,
  "origin_device_id": "poste-boutique",
  "fields": { "invoice_number": "FAC-2026-000012", "total": 1250000, "date": "2026-03-04" },
  "refs": { "customer": "c1a2...-...", "user": "9b3e...-..." }
}
```

À la réception, l'application suit un **ordre topologique** obligatoire (un enfant ne peut pas être écrit avant son parent) :

```
categories → products → customers / suppliers / workers
   → sales_invoices → sales_invoice_items → payments
   → purchase_invoices → purchase_invoice_items
   → cash_sessions → cash_movements
   → stock_movements → expenses → audit_logs
   → service_jobs → service_job_materials / service_job_workers
   → brick_types → brick_productions → brick_production_materials / workers
   → furniture_models → furniture_model_materials → furniture_orders → furniture_order_materials / workers
   → settings (dernier)
```

Si un parent n'est pas encore arrivé, la ligne n'est **jamais perdue** : elle part en quarantaine dans `sync_pending` et est rejouée au lot suivant. C'est ce qui rend la synchronisation tolérante à une coupure réseau au milieu d'un lot.

### 23.5 Envoi (push)

- `sync_outbox` reçoit une entrée à chaque écriture d'une table synchronisée (via `lib/sync-client.ts` appelé par les fonctions de `lib/` — **jamais** par des triggers SQLite, pour rester lisible et testable).
- Les lignes sont envoyées par **lots** (100 lignes par défaut) avec un `batch_id` (UUID).
- **Idempotence** : le serveur fait un `INSERT … ON CONFLICT (sync_id) DO UPDATE`. Renvoyer deux fois le même lot ne crée **aucun doublon** — indispensable avec une connexion instable.
- En cas d'échec (réseau, 5xx), le lot reste en file et sera renvoyé ; un compteur d'essais et un délai croissant évitent de marteler le serveur.
- **Mode A** : envoi par **instantané complet** de chaque table (quelques milliers de lignes : trivial), ce qui évite les watermarks, les tombstones et toute la complexité du delta. Simple et robuste.
- **Mode B** : envoi par **delta** depuis `sync_outbox`, tombstones inclus.

### 23.6 Réception (pull)

- Watermark par table : `last_pulled_at` dans `sync_state` ; requête `WHERE updated_at > watermark ORDER BY updated_at, sync_id LIMIT n`.
- Pagination jusqu'à épuisement, horodatage du lot appliqué **seulement** après commit local réussi.
- Application en **transaction locale** : soit tout le lot passe, soit rien.
- Le pull est refusé si la table de destination a une écriture locale non encore poussée sur la même ligne : cet écart devient un **conflit** (§23.7) plutôt qu'un écrasement silencieux.

### 23.7 Conflits

| Cas | Arbitrage |
|---|---|
| Tables append-only (`stock_movements`, `payments`, `audit_logs`) | **Aucun conflit possible** — les lignes s'additionnent |
| Même ligne modifiée sur un poste ET sur le serveur | **Dernière écriture gagnante**, arbitrée sur `updated_at`, avec l'horloge **du serveur** |
| Ligne supprimée sur un poste, modifiée sur un autre | Le tombstone gagne ; la modification est conservée dans `sync_conflicts` |
| Conflit « dur » : deux postes ont modifié la **même facture validée** | **Aucun écrasement** : la version distante est conservée, la version locale est archivée dans `sync_conflicts`, et l'écran `/synchronisation` demande une résolution **humaine** |

> ⚠️ **L'arbitrage utilise l'horloge du serveur, jamais celle du poste.** Un poste avec une horloge déréglée (fréquent) écraserait sinon toutes les écritures des autres.

### 23.8 Numérotation des factures en multi-postes — point critique

Deux postes hors ligne génèrent chacun `FAC-2026-000012`. C'est **le** problème à trancher, et il conditionne directement **Q1**.

| Solution | Fonctionne hors ligne | Qualité du numéro | Retenu |
|---|---|---|---|
| **Blocs réservés par poste** : le poste réserve 100 numéros d'avance, les consomme hors ligne | ✅ | Excellente | ✅ **Recommandé** |
| Numéro attribué par le serveur à chaque vente | ❌ (réseau requis pour vendre) | Excellente | ❌ Éliminé : viole §15 |
| Suffixe d'appareil systématique (`FAC-2026-000012-M2`) | ✅ | Moyenne (moins propre pour le client) | Repli d'urgence uniquement |

**En mode A (mono-poste)** : numérotation locale classique, **aucun changement**.
**En mode B** : blocs réservés ; si un poste épuise son bloc sans réseau, il bascule sur le suffixe d'appareil et le numéro est signalé dans le journal de synchronisation. Compte tenu du volume réel (quelques dizaines de factures par jour), un bloc de 500 numéros suffit largement et n'est épuisé qu'après plusieurs mois d'utilisation hors ligne.

### 23.9 Paramètres et périmètre de synchronisation

Clés ajoutées à `settings` :

| Clé | Valeurs | Note |
|---|---|---|
| `sync_mode` | `off` \| `backup` (A) \| `multi` (B) | Défaut `off` |
| `sync_api_url` | URL HTTPS | — |
| `sync_device_id` | UUID | Généré à la première activation |
| `sync_device_token` | jeton | **Jamais synchronisé**, jamais journalisé |
| `sync_interval_minutes` | `15` | Fréquence de la tentative |
| `sync_number_block_size` | `500` | Mode B (Q1) |

**Périmètre** : toutes les tables métier sont synchronisées, **sauf** — et c'est volontaire :

| Non synchronisé | Raison |
|---|---|
| `sync_device_token`, `sync_api_url`, `sync_device_id`, `sync_mode` | Propres au poste ; les synchroniser provoquerait une boucle ou une panne générale |
| `theme`, `primary_color`, `sidebar_color` | Préférence d'affichage locale, pas une donnée d'entreprise |
| `sync_outbox`, `sync_pending`, `sync_state`, `sync_conflicts`, `devices` | Tables techniques locales |
| `report_provider_config` | Contient des secrets de passerelle SMS ; à stocker côté serveur à terme |

Toutes les autres clés de `settings` (identité de l'entreprise, logo, NIF, préfixes, TVA, unités, catégories de dépenses, destinataires de rapports) **sont** partagées.

### 23.10 Écran `/synchronisation`

| Élément | Contenu |
|---|---|
| État | Connecté / Hors ligne / Désactivé · mode actif A ou B |
| Dernière synchronisation | Date, durée, nombre de lignes envoyées et reçues, par table |
| File d'attente | Nombre d'éléments en attente d'envoi et en quarantaine |
| Actions | **Synchroniser maintenant** · Tester la connexion · **Renvoyer tout** (réinitialise les watermarks, ne supprime rien) · Désactiver la synchronisation |
| Journal | Derniers lots (`batch_id`, appareil, lignes, résultat) |
| Conflits | Liste des conflits à trancher, avec comparaison locale / distante et choix « garder local » ou « garder distant » |
| Appareils | Postes connus, dernière activité, **révocation d'un jeton** |
| Dépannage sans réseau | **Export / import manuel d'un paquet `.json`** : on exporte sur le poste, on transporte le fichier sur clé USB, on l'importe sur un autre poste ou on l'envoie au serveur plus tard |

### 23.11 Sécurité

| Exigence | Mise en œuvre |
|---|---|
| Transport | **HTTPS obligatoire** ; l'API refuse toute connexion non chiffrée |
| Authentification | **Jeton d'appareil** révocable par appareil (même logique que le `x-app-token` de l'application desktop) |
| Base de données | `sslmode=require` ; **jamais** exposée à Internet ; accessible seulement par l'API |
| Secrets | Côté serveur (variables d'environnement) ; **aucun identifiant PostgreSQL dans le poste** |
| Chiffrement au repos | Assuré par l'hébergeur managé |
| Sauvegarde serveur | `pg_dump` planifié + conservation, en plus des sauvegardes locales |
| Séparation | Un poste ne peut lire que les données de **sa** société (colonne `tenant_id` sur le serveur, prête pour plusieurs entreprises) |
| Consentement | ⚠️ Les données commerciales **quittent le poste** : cet envoi doit être explicitement validé par le client |

### 23.12 Ce que la synchronisation ne fait **pas**

- Pas de **temps réel** : une donnée saisie sur le poste A n'apparaît pas instantanément sur le poste B (intervalle configurable).
- Pas de **verrouillage de ligne** ni d'édition collaborative simultanée.
- Pas de **fusion au niveau du champ** : la granularité est la **ligne entière**. Deux postes qui modifient deux champs différents de la même facture produisent un conflit.
- Pas de résolution automatique des **conflits sémantiques** (ex. deux ventes créditées du même stock) : c'est un arbitrage humain.
- Pas de synchronisation des **fichiers binaires** hors logo (stocké en base64 dans `settings`).
- La synchronisation **ne remplace pas la sauvegarde locale** : les deux sont conservées.

### 23.13 Tables, dépendances et scripts ajoutés

**Tables locales (SQLite) — 30 tables métier + 5 tables de synchronisation = 35**

| Table | Rôle |
|---|---|
| `devices` | Appareils connus (id, nom, dernière activité) |
| `sync_state` | Watermarks par table + état runtime |
| `sync_outbox` | File d'envoi (table, sync_id, opération, payload, essais, dernier essai) |
| `sync_pending` | Lignes reçues en **quarantaine** (référence parente manquante) |
| `sync_conflicts` | Conflits à trancher (table, sync_id, version locale, version distante, résolu le) |

**Tables PostgreSQL (serveur) — 30 tables métier + 3 tables techniques = 33**
Table `devices`, `sync_batches` (journal des lots), `sync_conflicts`. Les tables métier sont **identiques** (mêmes noms, mêmes colonnes, `sync_id` en clé primaire, `id` local non significatif côté serveur) + `tenant_id`.

**Dépendances ajoutées** (uniquement côté serveur — **le poste n'ajoute aucune dépendance**, il utilise `fetch`) :

| Paquet | Usage |
|---|---|
| `postgres` (postgres.js) | Client PostgreSQL |
| `drizzle-orm/postgres-js` | ORM côté serveur |
| `drizzle-kit` (déjà présent) | Second fichier de config `drizzle.config.pg.ts` |
| `fastify` (ou `node:http` nu) | Service HTTP de synchronisation |
| `zod` | Validation des payloads entrants |

**Scripts npm ajoutés**

> ⚠️ Ces quatre scripts **ne sont pas encore dans `package.json`** : ils
> appartiennent au service en ligne (lot 6), qui n'est pas livré (§25.1). Les
> déclarer maintenant donnerait des commandes qui échouent.

```bash
npm run db:pg:generate   # Générer les migrations PostgreSQL
npm run db:pg:push       # Pousser le schéma vers PostgreSQL
npm run sync:dev         # Lancer l'API de synchronisation en développement
npm run sync:build       # Construire l'API de synchronisation
```

**Hébergement proposé** : PostgreSQL managé (Neon, Supabase ou Railway) + l'API sur un petit service Node (Railway, Render ou Fly.io), en **région Europe** pour la latence depuis la Guinée. Alternative : un VPS unique hébergeant PostgreSQL + l'API.

---

## 24. Points à valider / questions ouvertes

### Décisions déjà prises

| # | Décision | Retenu |
|---|---|---|
| **D1** | Nommage des tables et colonnes | **Anglais**, conventions du projet Gaz → code existant réutilisable (§3.3) |
| **D2** | Stockage des paramètres | **Clé/valeur** + couche typée `lib/settings.ts` (§9) |
| **D3** | Schéma de base de données | **Schéma client conservé et corrigé** : 9 correctifs, 30 tables (§6) |
| **D4** | Synchronisation PostgreSQL | **Optionnelle, désactivée par défaut**, en deux modes A (sauvegarde) et B (multi-postes) ; le SQLite local reste la source de vérité (§23) |

### Questions ouvertes

> Ces questions doivent être tranchées **avant le lot concerné**. Chaque réponse modifie le présent document.

| # | Question | Proposition par défaut |
|---|---|---|
| **Q1** | **Format exact de numérotation des factures** utilisé aujourd'hui par Planète Déco Sarlu (§7 : « compatible avec le format de facturation actuel »). Un exemple réel de facture actuelle suffit. | `FAC-2026-000001`, gabarit configurable `{PREFIX}-{YYYY}-{NNNNNN}` |
| **Q2** | **TVA** : Planète Déco facture-t-elle la TVA ? À quel taux (18 % ?) ? Certaines ventes sont-elles exonérées ? *(bloquant pour le lot 1)* | Taux par défaut **0 %** (facturation sans TVA), champ TVA présent et configurable par facture |
| **Q3** | **Unités et catégories réelles** à préremplir : pièce, ensemble, carton, m², kg, sac, litre — liste définitive ? Catégories : Alucobond, Staff, Placo, Meuble, Peinture, Brique, Bois, Quincaillerie, Matière première ? | Liste ci-dessus, modifiable depuis les paramètres |
| **Q4** | **Logo de l'entreprise** : fichier fourni (PNG haute résolution) ? | Sans logo, un bloc texte prend sa place |
| **Q5** | **Moyens de paiement** réels : Espèces, Mobile Money (Orange Money ? MTN ?), Virement, crédit ? | Les quatre + possibilité d'en ajouter |
| **Q6** | **Restauration de sauvegarde** : accepte-t-on un remplacement complet du fichier avec redémarrage de l'application, ou faut-il un import table par table (plus risqué, sans redémarrage) ? | **Remplacement + redémarrage**, avec copie de sécurité automatique avant écrasement |
| **Q7** | **Sauvegardes automatiques** : fréquence et durée de conservation souhaitées ? | 1 copie par jour au premier lancement, conservation 30 jours |
| **Q8** | **Envoi programmé des rapports** : le logiciel est installé localement et peut être fermé le soir. Accepte-t-on que l'envoi automatique se déclenche **à l'ouverture de l'application** (rattrapage) si elle était fermée à l'heure prévue ? | Oui : rattrapage à l'ouverture + envoi réellement automatique uniquement si l'app est ouverte et connectée |
| **Q9** | **Passerelle SMS / WhatsApp** : liaison manuelle (`wa.me`, gratuit, hors ligne) ou API officielle (automatique, payante, jeton et Internet requis) ? | **Lien manuel en V1**, API en option lot 5 |
| **Q10** | **Dépôt GitHub** pour les releases et l'auto-update : nom du dépôt, propriétaire, dépôt privé ou public ? | À créer — `boubacarBente/planeteDeco`. **Retenu depuis : `boubacarBente/projectPDS`** (dépôt existant, `build.publish` pointe dessus) |
| **Q11** | **Utilisateurs réels et rôles** au démarrage : combien de postes, qui est admin ? Les **6 rôles** du schéma client (admin, gérant, vendeur, magasinier, menuisier, briquetier) sont-ils tous utilisés dès la V1 ? | 1 admin + 1 gérant + vendeurs ; menuisier et briquetier activés aux lots 3 et 4 |
| **Q12** | **Données de démarrage** : préremplir le catalogue (produits, prix d'achat et de vente réels) ou démarrer vide ? | Démarrer vide + un catalogue de démonstration optionnel en développement |
| **Q13** | **Prix d'achat** : sont-ils connus et saisis par produit (nécessaire au calcul de marge) ? | Oui, obligatoires pour les produits dont la catégorie est `finished` ou `raw_material` |
| **Q14** | **Rapports « Excel »** : un export **CSV** ouvrable dans Excel suffit-il, ou faut-il un vrai `.xlsx` ? | CSV (aucune dépendance, suffisant pour Excel) |
| **Q15** | **Périmètre V1** : confirme-t-on que les lots 3 et 4 (chantiers, briqueterie, atelier) viennent après la mise en service du cœur commercial (lots 1 et 2) ? | Oui — lots 1 et 2 d'abord |
| **Q16** | **Impression thermique** (ticket 58/80 mm) : utile dès la V1 pour les reçus ? | Non, lot 5 (ticket A4/A5 en V1) |
| **Q17** | **Multi-magasins** : un seul magasin en V1 ? | Oui, un seul magasin |
| **Q18** | **Plafond de crédit client** (`customers.credit_limit`) : faut-il **bloquer** une vente à crédit qui dépasse le plafond, ou seulement **avertir** ? | **Avertir** en V1, blocage activable dans les paramètres |
| **Q19** | **Prestations autonomes** : une prestation de chantier est facturée avec **son propre document** (pas de facture de vente liée). Cela convient-il, ou faut-il une vraie facture de vente générée depuis le chantier ? | Document autonome — évite le double comptage du CA (§15) |
| **Q20** | **Prix d'achat et marge** : la marge est calculée avec le prix d'achat **courant** du produit. Faut-il mémoriser le prix d'achat **au moment de la vente** pour figer les marges historiques ? | Prix courant en V1 ; instantané du coût ajouté si les marges historiques doivent être exactes |
| **Q21** | **Synchronisation en ligne** : confirme-t-on qu'elle est **optionnelle et désactivée par défaut**, et que le SQLite local reste la source de vérité ? | Oui — l'application doit rester utilisable **sans Internet** (§15) |
| **Q22** | **Périmètre** : commence-t-on par le **mode A** (sauvegarde unidirectionnelle, 1 poste, ~2-3 jours) avant le **mode B** (multi-postes, ~1-2 semaines) ? | Oui — mode A d'abord, mode B ensuite |
| **Q23** | **Combien de postes** utiliseront réellement la synchronisation, et pour quoi faire : sauvegarde/consultation à distance, ou travail simultané sur les mêmes données ? | Si c'est de la sauvegarde → le mode A suffit et coûte 5 fois moins cher |
| **Q24** | **Numérotation en multi-postes** (§23.8) : accepte-t-on des **blocs de numéros réservés par poste** (le plus propre), ou faut-il un suffixe d'appareil sur les factures ? | Blocs réservés (500 numéros), repli avec suffixe d'appareil si le bloc s'épuise hors ligne |
| **Q25** | **Hébergement** : qui paie et administre PostgreSQL en ligne (Neon / Supabase / Railway, région Europe) et le petit service Node ? | À trancher avant le lot 6 ; solution managée pour éviter toute administration de serveur |
| **Q26** | **Données hors du poste** : le client accepte-t-il explicitement que ses données commerciales soient envoyées vers un serveur en ligne ? | Nécessaire — sans accord écrit, la synchronisation reste `off` |

---

## 25. Lots de livraison

> **État réel au 24/09/2026.** La colonne « État » dit ce qui est **livré et
> vérifié**, et ce qui reste. Les lots 0 à 4 sont construits ; le lot 6 n'est
> livré qu'en partie (l'écran et la file d'attente, **pas** le service en ligne).

| Lot | Contenu | Chapitres | Livrable | État |
|---|---|---|---|---|
| **Lot 0 — Socle** | Projet Next.js + Electron, **design system** (jetons, composants, sidebar à 6 groupes et repliable, responsive, 5 états), **dépendances installées en dernière version** avec les 6 vérifications de compatibilité du §4.5, DB + migrations **incluant les colonnes de synchronisation** (`sync_id`, `updated_at`, `deleted_at`, `origin_device_id` — les ajouter plus tard obligerait à migrer 30 tables en production, §6.7), authentification, rôles, AppShell, modales, paramètres, thème, retour arrière, exports | 12, 13, 14 (partie) | Application installable, vide mais navigable **et déjà à la charte** | ✅ **livré** |
| **Lot 1 — Cœur commercial** | Dashboard, clients, fournisseurs, produits/catégories, stocks, achats, ventes, factures/reçus, caisse de base | 1 → 7 | **Utilisable au quotidien** | ✅ **livré** |
| **Lot 2 — Gestion financière** | Caisse complète (ouverture/clôture), dépenses, soldes/dettes/bénéfices, rapports + export, envoi SMS/WhatsApp, utilisateurs + audit, sauvegarde/restauration | 8 → 14 | **Version 1.0 livrable** | ✅ **livré** |
| **Lot 3 — Prestations et briqueterie** | Chantiers (devis, suivi, équipes, facturation), briqueterie (matières, lots, étapes, coût de revient, pertes) | 16, 17 | Version 1.1 | ✅ **livré** |
| **Lot 4 — Atelier de meubles** | Modèles + nomenclature, commandes standard/sur mesure, suivi d'atelier, coût de revient, chutes, stock de meubles finis | 18 | Version 1.2 | ✅ **livré** |
| **Lot 5 — Évolutions** | Multi-postes, version web/mobile, multi-magasins, scanner code-barres, imprimante thermique, devis et commandes clients | 15 (évolutions) | Sur demande | ⏳ **non commencé** — hors périmètre V1 |
| **Lot 6 — Synchronisation en ligne** | **Option** (§23). *6a — Mode A* : API de synchronisation, PostgreSQL, écran `/synchronisation`, sauvegarde unidirectionnelle, export/import manuel. *6b — Mode B* : multi-postes, tombstones, résolution des conflits, blocs de numérotation. **Indépendant des lots 1 à 4 : peut être livré à tout moment après le lot 2** | 15 (« multi-postes »), 14 (sécurité) | Version 1.3 | ⚠️ **partiel** — l'écran, la file d'attente, les conflits et l'export/import manuel sont livrés ; **le service PostgreSQL en ligne et le dossier `server/` ne le sont pas** |

### 25.1 Ce qui reste ouvert

| Élément | Pourquoi ce n'est pas fait | Ce qu'il faut |
|---|---|---|
| **Questions Q1 à Q26** (§24) | Ce sont des **décisions client**, pas du développement. Les propositions par défaut sont implémentées | Vos réponses. Q1 (numérotation) et Q2 (TVA) sont les plus urgentes : elles changent les documents déjà émis |
| **Service de synchronisation en ligne** (lot 6a/6b) | Il suppose une décision d'hébergement et un accord écrit sur la sortie des données (§23.11, Q25, Q26) | Votre accord + un hébergement PostgreSQL |
| **Matrice de recette** (§5.5, 155 cases) | Elles se cochent **en cliquant** dans un navigateur à 360, 768 et 1440 px, écran par écran. La vérification faite est technique (34 pages et 71 routes d'API découvertes et appelées par `npm run verify:routes` : **aucune erreur 500**, build vert), **pas** visuelle page par page | Une passe de recette avec vous |
| **Lot 5 — évolutions** | Explicitement hors périmètre V1 | Une commande |
| **`npm run lint`** | `typescript-eslint@8` refuse TypeScript 7.0 (incompatibilité d'outillage, pas du code). `npm run typecheck` et `next build` couvrent le contrôle des types | Attendre le support de TS 7 par typescript-eslint, ou redescendre à TypeScript 5.9 (§4.5) |
| **Signature de code Windows** | L'installateur n'est pas signé : Windows affichera un avertissement SmartScreen au premier lancement | Un certificat de signature de code |
| **Dépôt de publication** | `package.json` → `build.publish` vise `boubacarBente/projectPDS` ; la mise à jour automatique ne fonctionnera qu'à partir de la **première release GitHub publiée** (tag `v*`) | Publier une release (workflow déjà en place) |


---

## 26. Conventions de code

1. **Français** pour les libellés métier, les commentaires et les messages d'erreur affichés ; anglais pour le code (variables, fonctions, tables).
2. **Un seul composant `Modal`** — jamais de `alert` / `confirm` / modale maison (§8).
3. **Un seul toast par action** ; `silent: true` sur `updateSettings` quand la page affiche déjà le message.
4. **Design et responsive obligatoires** : jetons du [design system](#53-design-system--une-identité-dentreprise-cohérente-sur-toutes-les-pages), **aucune couleur en dur** (tout passe par `primary` / `base-*`), `ResponsiveTable` pour toute liste, les **5 états** de chaque écran, et la **matrice de recette** cochée sur ses 5 colonnes. Détail du contrat en [§5.5](#55-responsive--la-règle-des-5-largeurs).
5. **Toute écriture passe par une fonction de `lib/`** — les Route Handlers restent minces : parsing, contrôle de permission, appel de la fonction, réponse HTTP.
6. **Requêtes via Drizzle + relations** (`db.query...with`) ; SQL brut uniquement par `rawGet` / `rawAll` / `rawRun` / `withRawTransaction`.
7. **Server Actions** conservées pour les formulaires simples (`app/*/actions.ts`), comme dans Gaz (clients, produits, ventes).
8. **Toute routine d'affichage monétaire** passe par un utilitaire commun (`formatCurrency`) avec `Intl.NumberFormat('fr-FR')` + `GNF`.
9. **Toute date affichée** passe par `lib/date-format.ts` ; toute date stockée est `YYYY-MM-DD`.
10. **Restauration d'état** : toute page de liste utilise `useViewStateRehydration` + `writeViewState` + `clampPage` (§3.1). Le fetch est **gaté** sur `rehydrated`.
11. **Migrations** : jamais de modification manuelle de la base ; `db/schema.ts` + `npm run db:generate`.
12. **Pas de secret en dur** — aucune exception (voir §3.4).
13. **Synchronisation ([§23](#23-synchronisation-avec-postgresql-option-en-ligne))** :
    - Toute table métier porte `sync_id` (UUID), `updated_at`, `deleted_at`, `origin_device_id` — **dès le lot 0**, même synchronisation désactivée.
    - **Toute écriture passe par une fonction de `lib/`** (règle 5) : c'est ce qui garantit que `sync_outbox` reçoit chaque changement. Une écriture Drizzle directe dans une Route Handler **casserait la synchronisation silencieusement**.
    - **Jamais de suppression physique** sur une table synchronisée : `deleted_at` (tombstone) ou `is_active`. Un `DELETE` ferait ressusciter la ligne au prochain pull.
    - **Jamais de référence par `id` local dans un payload** : uniquement par `sync_id`.
    - Le code de synchronisation **ne doit jamais bloquer** une opération métier : si l'API est injoignable, l'écriture locale réussit et la file d'attente se remplit.
14. **Aucune fonctionnalité ne dépend de la synchronisation.** Elle est optionnelle : tout écran doit être pleinement utilisable avec `sync_mode = 'off'`.

---

## 27. Annexes : pages, API REST, scripts

### 27.1 Pages

| Route | Description | Lot |
|---|---|---|
| `/` | Tableau de bord | 1 |
| `/ventes` · `/ventes/nouvelle` · `/ventes/[id]` | Ventes : liste, création, détail + impression | 1 |
| `/recus/[id]` | Reçu de paiement | 1 |
| `/clients` · `/clients/[id]` · `/clients/[id]/paiements` | Clients, fiche, historique et soldes | 1 |
| `/fournisseurs` · `/fournisseurs/[id]` · `/fournisseurs/[id]/paiements` | Fournisseurs, fiche et règlements | 1 |
| `/produits` · `/produits/categories` | Catalogue (les **unités** sont une liste dans les paramètres, pas un écran dédié) | 1 |
| `/stocks` | Stock, mouvements, inventaire, alertes | 1 |
| `/achats` · `/achats/nouvelle` · `/achats/[id]` | Achats fournisseur : liste, saisie, détail + document imprimable | 1 |
| `/caisse` | Ouverture/clôture, entrées/sorties, solde | 2 |
| `/depenses` | Dépenses (les **catégories** sont une liste dans les paramètres) | 2 |
| `/soldes` | Soldes clients/fournisseurs, créances, dettes, bénéfices | 2 |
| `/rapports` | Rapports, exports, envoi SMS/WhatsApp | 2 |
| `/utilisateurs` · `/utilisateurs/historique` | Utilisateurs, rôles, journal | 2 |
| `/parametres` | Paramètres, sauvegarde, restauration | 1 → 2 |
| `/login` | Connexion / premier administrateur | 0 |
| `/chantiers` · `/chantiers/[id]` · `/chantiers/devis/[id]` | Prestations | 3 |
| `/briqueterie` · `/briqueterie/[id]` | Fabrication de briques | 3 |
| `/atelier` · `/atelier/modeles` · `/atelier/[id]` | Atelier de meubles | 4 |
| `/synchronisation` | État, journal, conflits, appareils, export/import manuel ([§23.10](#2310-écran-synchronisation)) | 6 |

### 27.2 API REST

> **Toutes les routes de liste sont paginées côté serveur** : `?page=1&limit=10&search=...` → `{ data, total, page, limit, totalPages }` (format repris de Gaz).
>
> **Tri** : par défaut, une liste affiche **la dernière insertion en premier**
> (`created_at DESC, id DESC` — l'`id` départage deux lignes créées dans la même
> seconde). Les tris explicites sont `?sort=recent` (défaut), `?sort=name`
> (alphabétique : clients, fournisseurs, produits, catégories, ouvriers,
> utilisateurs, types de briques, modèles d'atelier, stock), `?sort=balance`
> (solde ou dette décroissant : clients et fournisseurs) et `?sort=promised`
> (planning d'atelier, date promise la plus proche d'abord : commandes). Le tri
> est fait **en SQL** : un tri côté navigateur ne trierait que la page affichée.
> Règle détaillée et utilitaire commun : `lib/list-sort.ts`
> et [CONVENTIONS §5](docs/CONVENTIONS.md#tri-des-listes--la-dernière-insertion-dabord).

| Domaine | Routes |
|---|---|
| Auth | `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` · `GET|POST /api/auth/setup` |
| Clients | `GET|POST /api/clients` · `GET|PUT|DELETE /api/clients/[id]` · `GET /api/clients/stats` |
| Fournisseurs | `GET|POST /api/fournisseurs` · `GET|PUT|DELETE /api/fournisseurs/[id]` · `GET /api/fournisseurs/[id]/paiements` · `GET /api/fournisseurs/stats` |
| Produits | `GET|POST /api/produits` · `GET|PUT|DELETE /api/produits/[id]` · `GET|POST /api/produits/categories` · `GET|PUT|DELETE /api/produits/categories/[id]` · `GET /api/produits/stats` |
| Ouvriers | `GET|POST /api/workers` · `GET|PUT|DELETE /api/workers/[id]` — **table unique** partagée par les chantiers, la briqueterie et l'atelier |
| Stocks | `GET /api/stocks` · `GET /api/stocks/mouvements` · `POST /api/stocks/adjust` · `GET /api/stocks/summary` |
| Achats | `GET|POST /api/achats` · `GET|PUT|DELETE /api/achats/[id]` · `GET /api/achats/stats` (`?supplierId=` pour la fiche fournisseur) |
| Ventes | `GET|POST /api/ventes` · `GET|PUT|DELETE /api/ventes/[id]` · `POST /api/ventes/[id]/annuler` · `GET /api/ventes/stats` |
| Paiements | `GET|POST /api/paiements` · `GET /api/paiements/[id]` (reçu) |
| Dépenses | `GET|POST /api/depenses` · `GET|PUT|DELETE /api/depenses/[id]` · `GET /api/depenses/stats` |
| Caisse | `GET|POST /api/caisse` (mouvements + résumé, mouvement manuel) · `GET /api/caisse/sessions` (session ouverte, historique, résumé) · `POST /api/caisse/sessions` (ouverture) · `PUT /api/caisse/sessions` (clôture) |
| Chantiers | `GET|POST /api/chantiers` · `GET|PUT|DELETE /api/chantiers/[id]` · `PUT /api/chantiers/[id]/devis` · `GET|POST|DELETE /api/chantiers/[id]/materiaux` · `GET|POST|DELETE /api/chantiers/[id]/ouvriers` |
| Briqueterie | `GET|POST /api/briqueterie/types` · `GET|PUT|DELETE /api/briqueterie/types/[id]` · `GET|POST /api/briqueterie/productions` · `GET|PUT|DELETE /api/briqueterie/productions/[id]` (étape, pertes) |
| Atelier | `GET|POST /api/atelier/modeles` · `GET|PUT|DELETE /api/atelier/modeles/[id]` · `GET|POST /api/atelier/commandes` · `GET|PUT|DELETE /api/atelier/commandes/[id]` |
| Rapports | `GET /api/rapports` (`from`, `to`, `previousFrom`, `previousTo`, `productId`, `customerId`, `supplierId`, `paymentStatus`) · `POST /api/rapports/envoyer` · `GET /api/rapports/envois` |
| Dashboard | `GET /api/operations/snapshot` |
| Utilisateurs | `GET|POST /api/users` · `GET|PUT|DELETE /api/users/[id]` · `PUT /api/users/[id]/password` · `GET|PUT|DELETE /api/users/[id]/permissions` (§17.4) · `GET /api/audit` |
| Paramètres | `GET|PUT|POST /api/parametres` · `POST /api/parametres/seed-data` · `POST /api/parametres/reset-data` · `GET /api/parametres/backup` · `POST /api/parametres/restore` |
| Soldes | `GET /api/soldes` (créances clients, dettes fournisseurs, bénéfices) |
| Synchronisation *(poste)* | `GET /api/sync/status` · `POST /api/sync/now` · `GET /api/sync/conflits` · `POST /api/sync/conflits/[id]` · `GET|POST /api/sync/export` · `POST /api/sync/import` · `POST /api/sync/reset` |
| Synchronisation *(service en ligne)* | `GET /health` · `POST /push` (lots idempotents) · `POST /pull` (watermark) · `POST /devices` (enregistrement / révocation) |

### 27.3 Scripts npm

```bash
npm run dev                # Serveur de développement (navigateur)
npm run dev:desktop        # Next.js + Electron en mode développement
npm run start              # Serveur de production (après `npm run build`)
npm run build              # Build Next.js de production
npm run build:desktop:win  # Installeur Windows (.exe NSIS)
npm run build:desktop:mac  # macOS (.dmg)
npm run build:desktop:linux# Linux (.AppImage, .deb)
npm run copy:standalone    # Copie le build standalone pour Electron
npm run icons              # Régénère les icônes (ICO, PNG, favicon) depuis public/logo.jpg
npm run typecheck          # tsc --noEmit
npm run lint               # ESLint (⚠️ inutilisable avec TypeScript 7 : typescript-eslint 8 le refuse)
npm run release            # Commit, bump de version, tag et push
npm run release:patch      # Release patch explicite
npm run release:minor      # Release mineure
npm run release:major      # Release majeure
npm run db:generate        # Générer les migrations Drizzle
npm run db:push            # Pousser le schéma vers la base
npm run db:studio          # Ouvrir Drizzle Studio
```

**Scripts de vérification** — ils interrogent une application **démarrée**
(`npm run dev` ou `npm run start`) et une base contenant un administrateur
(`APP_USER` / `APP_PASSWORD` pour changer les identifiants) :

```bash
npm run verify:routes      # Découvre et appelle les 34 pages et les 71 routes d'API : aucune erreur 500 tolérée
npm run verify:purchases   # Parcours d'achat de bout en bout (21 contrôles) : stock, caisse, dette, numérotation
npm run verify:export      # Export PDF / image / WhatsApp dans un navigateur réel (CDP sur le port 9222)
```

**Scripts prévus au lot 6** — ils appartiennent au **service de synchronisation
en ligne**, qui n'est pas livré : ils ne sont donc **pas** dans `package.json`
(voir §23.13 et §25.1).

```bash
npm run db:pg:generate     # Générer les migrations PostgreSQL (service en ligne)
npm run db:pg:push         # Pousser le schéma vers PostgreSQL
npm run sync:dev           # Lancer l'API de synchronisation en développement
npm run sync:build         # Construire l'API de synchronisation
```

---

## Validation

Ce document a été validé et les **lots 0 à 4 sont construits** (statut en tête de
fichier). Il reste donc à valider non plus la conception, mais trois points :

1. **Les réponses aux 26 questions** de la section [24](#24-points-à-valider--questions-ouvertes) — **Q1** (format de numérotation des factures) et **Q2** (TVA) d'abord : elles changent le contenu des documents déjà émis.
2. **La recette visuelle** (§5.5, 155 cases) : une passe ensemble, écran par écran, à 360, 768 et 1440 px. La vérification technique est faite et reproductible (`npm run verify:routes`), la vérification *visuelle* ne l'est pas.
3. **Le lot 6** (service de synchronisation en ligne) : il attend une décision d'hébergement et votre accord écrit sur la sortie des données (§23.11, Q25, Q26).

Toute correction demandée sur ce document est appliquée et le document vous est
resoumis.

---

*Planète Déco Sarlu — « Construisons ensemble la solidité de vos projets ! »*

*Document de conception — projet `projetPDS`. Version 1.3.0 — lots 0 à 4
construits et vérifiés, en attente des décisions client (§24).*
