# AGENTS.md — repères pour un agent qui travaille sur ce dépôt

Ce fichier s'adresse aux assistants IA (et aux nouveaux développeurs) : ce qui ne se
déduit pas du code, les invariants à ne pas casser, et les pièges déjà payés.
**`README.md` reste la spécification de référence** : toute fonctionnalité livrée y est
décrite, et tout code non trivial y renvoie par `§`.

## Le projet

Application de gestion commerciale de **Planète Déco Sarlu (filiale Meubles)** —
quincaillerie, décoration, briqueterie, atelier, chantiers. Next.js 16 (App Router),
React 19, TypeScript, Drizzle ORM sur **SQLite local**, livrée en Electron.

Le **poste local est la source de vérité**. La synchronisation PostgreSQL est
optionnelle et inerte par défaut ; aucune opération métier ne doit en dépendre.

## Commandes

```bash
npm run dev            # serveur de développement sur 127.0.0.1:3000
npm run build          # build de production
npm run typecheck      # tsc --noEmit — LE garde-fou automatique disponible
npm run lint           # ⚠️ CASSÉ (pré-existant) : typescript-eslint ne supporte pas TS 7
npm run verify:routes  # découvre et appelle toutes les pages et routes d'API : aucun 500 toléré
npm run verify:draft   # politique du brouillon de vente (stock, caisse, sync, validation)
npm run verify:purchases
npm run verify:export  # export PDF/image dans un vrai navigateur (CDP)
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
   payer, vert quand c'est soldé** — c'est la règle des soldes clients (§7.2).
   `MoneyText colored` (négatif rouge / positif vert) **ne convient pas** à un dû : un
   reste dû est un montant positif, il apparaîtrait vert.
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
    ⚠️ Dans la matrice livrée, **Vendeur/Caissier détient déjà `balances.view`** (il voit
    `/soldes` et la marge) : il voit donc aussi le bénéfice. Pour le lui retirer, il faut
    changer la matrice ou passer par une surcharge `deny` par utilisateur.
14. **La marge ne sort jamais d'un document client** : ni PDF, ni image, ni WhatsApp.
    Elle vit dans des zones `no-print` ou des écrans internes — jamais dans
    `InvoiceDocument`, `purchase-document` ni un gabarit d'export (`lib/export-document.ts`).

## Organisation

| Sujet | Fichier |
|---|---|
| Navigation (et permission par entrée) | `lib/navigation.ts`, icônes `components/nav-icons.tsx` |
| Permissions (matrice par rôle + surcharges) | `lib/permissions.ts`, garde client `components/role-gate.tsx` |
| Authentification des Route Handlers | `requireAction('…')` de `lib/api.ts` dans chaque handler |
| Journal d'actions | `lib/audit.ts` (+ libellés *client-safe* dans `lib/audit-labels.ts`) |
| Design system (présentation pure) | `components/design-system.tsx` |
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
