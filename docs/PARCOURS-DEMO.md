# Parcours de démonstration — chantiers, briqueterie, atelier

Guide de prise en main des **trois modules de fabrication** avec les données de
démonstration : quoi regarder, dans quel ordre, et ce que chaque action produit
ailleurs dans l'application.

> Ce guide suppose que les données de démonstration ont été générées (§ 1).
> Les écrans cités sont ceux de l'application : chaque titre d'écran est suivi de
> son adresse, pour la retrouver directement.

---

## 1. Générer les données

| Étape | Où | Quoi |
|---|---|---|
| 1 | **Paramètres** (`/parametres`), section **Zone dangereuse** | Bouton **« Préremplir les données de démonstration »** |
| 2 | Modale de confirmation | Bouton **« Préremplir »** |
| 3 | — | La page se recharge : les trois modules sont remplis |

- La carte « Zone dangereuse » est **masquée en production et dans l'application
  de bureau** : c'est un outil de développement.
- **Rien n'est écrasé.** Si le catalogue (produits, clients, fournisseurs,
  ventes, achats) existe déjà, seuls les trois modules sont complétés. Un second
  clic ne duplique **rien** : les modules déjà remplis sont laissés tels quels.
- Pour repartir d'un catalogue neuf, il faut d'abord **« Réinitialiser les
  données »** (irréversible : ventes, achats, clients, produits, caisse).

### Ce que le jeu de démonstration contient

| Module | Objets créés | États couverts |
|---|---|---|
| **Chantiers** | 3 prestations (`CHA-2026-000001` à `000003`) avec 7 lignes de matériaux, 4 affectations, 3 encaissements | Devis envoyé · En cours (acompte 40 %) · Terminé et payé |
| **Briqueterie** | 3 lots (`BRI-2026-000001` à `000003`) avec 10 matières premières et 7 affectations | Moulage · Cuisson (320 cassées) · En stock (1 850 blocs vendables, 150 cassées) |
| **Atelier** | 3 commandes (`MEU-2026-000001` à `000003`) avec 13 lignes de matières et 7 affectations | Découpe · Peinture/vernis · Livré (et payé) |

Tout est construit à partir de ce qui existe déjà : les clients, les ouvriers
(`Sékou Touré`, `Mamadou Bah`, `Aïssatou Barry`…), les produits du catalogue, les
types de briques et les modèles de meubles avec leur nomenclature.

---

## 2. Parcours conseillé — Chantiers (`/chantiers`)

Une prestation est un **document facturable autonome** : son devis, son suivi,
ses matériaux, son équipe et ses encaissements vivent sur la même fiche. Elle ne
génère **jamais** de facture de vente — le chiffre d'affaires n'est pas compté
deux fois.

### 2.1 La liste

| À regarder | Pourquoi |
|---|---|
| Cartes **Chantiers / CA des prestations / Coût de revient / Marge / Encaissé / Reste à encaisser** | La synthèse des prestations sur la période filtrée |
| Colonnes **Statut**, **Devis**, badge de **paiement** | Les trois informations se lisent ensemble : avancement, acceptation du devis, règlement |
| Filtres **Catégorie / Statut / Devis / Du-Au** | La période s'appuie sur la date de début (ou la date de création pour un devis) |

**À tester :** ouvrir `CHA-2026-000002` (le chantier en cours) depuis la liste.

### 2.2 La fiche d'un chantier (`/chantiers/[id]`)

| Ordre | Écran | Ce que ça signifie |
|---|---|---|
| 1 | Rail **Avancement** : Devis → En attente → En cours → Terminé | Un chantier ne recule jamais. « En attente » existe pour un devis accepté dont les travaux n'ont pas commencé |
| 2 | Badge **Devis : Envoyé / Accepté / Refusé** | Le statut d'acceptation, indépendant de l'avancement |
| 3 | Carte **Facturation** : Total / Payé / Reste à payer | Recalculés depuis les **paiements réels**, jamais saisis à la main |
| 4 | Onglet **Matériaux** | Chaque ligne **a déduit le stock** par un mouvement « sortie » motivé |
| 5 | Onglet **Équipe** | Main-d'œuvre = `jours × tarif journalier`. Un journalier ponctuel peut être saisi à la volée |
| 6 | Cartes **Coûts et marge** et **Paiements** | Coût de revient calculé à la lecture ; reçus numérotés |

**À tester, dans cet ordre :**

1. **« Ajouter un matériau »** → choisir un produit et une quantité. Le stock du
   produit baisse immédiatement (le mouvement est visible dans `/stocks`), et le
   total du chantier est recalculé.
2. **« Affecter un ouvrier »** → jours + tarif : la main-d'œuvre entre dans le
   coût total.
3. **« Encaisser »** → un acompte (ex. 30 %). Un reçu `REC-…` est émis, la caisse
   est créditée, le reste à payer baisse.
4. **« Passer en cours »** puis **« Terminer »** → « Terminer » renseigne la date
   de fin si elle manque.
5. **Onglet Matériaux → « Retirer »** sur une ligne → la matière **retourne en
   stock** (mouvement « entrée ») : corriger une saisie ne laisse pas de stock
   fantôme.
6. **« Voir le devis »** (`/chantiers/devis/[id]`) → document imprimable, avec
   les boutons **« Marquer “Envoyé” »**, **« Marquer “Accepté” »**,
   **« Marquer “Refusé” »**. Un devis **accepté** fait passer un chantier encore
   au stade « Devis » en « En attente ».

> **Le devis et le réalisé.** Tant qu'aucun matériau ni ouvrier n'est
> enregistré, `quote_materials` / `quote_labor` sont l'estimation saisie à la
> main (c'est le cas de `CHA-2026-000001`). **Dès la première ligne**, les totaux
> sont réalignés sur le réalisé : le devis ne peut pas diverger de ce qui est
> réellement sorti du stock et payé.

---

## 3. Parcours conseillé — Briqueterie (`/briqueterie`)

Un lot traverse **toujours** les mêmes étapes, dans cet ordre, sans retour en
arrière : **Moulage → Séchage → Cuisson → Mise en stock**.

### 3.1 La liste

| À regarder | Pourquoi |
|---|---|
| Cartes **Lots / Briques fabriquées / cassées / Coût de revient total / Coût unitaire moyen / Briques vendues** | « Vendues » se lit dans les **factures de vente actives** : c'est la seule source de vérité du stock de briques finies |
| Tableau **Fabriquées, cassées et vendues par type** | Le rendement par type de brique |
| Colonne **Étape** + actions rapides | On peut faire avancer un lot directement depuis la liste |

### 3.2 La fiche d'un lot (`/briqueterie/[id]`)

| Ordre | Écran | Ce que ça signifie |
|---|---|---|
| 1 | Rail **Avancement de la fabrication** | Les quatre étapes, avec le badge **« Stock crédité »** ou **« Pas encore en stock »** |
| 2 | **Matières premières consommées** | Chaque ligne a produit un mouvement `exit` (`reference_type = brick_production`) |
| 3 | **Équipe affectée** | `jours × tarif journalier` |
| 4 | **Coût de revient détaillé** | Coût unitaire = coût total ÷ (production − cassées). **Calculé, jamais stocké** |

**À tester :**

1. Ouvrir `BRI-2026-000001` (moulage) puis **« Ajouter une matière »** : le stock
   de la matière première baisse tout de suite.
2. Cliquer **« Étape suivante : Séchage au soleil »**, puis **« Cuisson au four »** :
   les briques finies n'entrent **pas encore** en stock.
3. **« Étape suivante : Mise en stock »** : c'est **la seule** opération qui
   crédite le stock des briques finies — une fois, jamais deux.
   Ouvrir alors `/stocks` : le produit lié au type de brique a augmenté de
   `production − cassées`.
4. **« Enregistrer une casse »** sur un lot **en stock** → mouvement « sortie »
   immédiat, motif « briques cassées lot BRI-… ». Sur un lot **pas encore en
   stock** (`BRI-2026-000002`), seule la quantité cassée augmente : la sortie
   partira avec la mise en stock, sinon le stock deviendrait négatif.
5. **« Annuler le lot »** (avec motif) → le lot n'est **pas supprimé** : il
   disparaît des listes, et le stock est réversé (briques finies sorties,
   matières premières rendues).

> `BRI-2026-000003` montre le cycle complet : 2 000 blocs produits, 150 cassés,
> **1 850 blocs vendables** crédités en stock, et un coût de revient unitaire de
> **4 643,24 GNF** calculé par l'application.

---

## 4. Parcours conseillé — Atelier (`/atelier`)

Une commande standard se construit depuis un **modèle** : sa nomenclature fournit
les matières à consommer, le besoin est **calculé**, jamais ressaisi.

Étapes : **Découpe → Assemblage → Ponçage → Peinture/vernis → Finition → Livré**.

| Écran | À regarder |
|---|---|
| `/atelier` (liste) | Cartes **En cours / Livrés / Livrés à temps / En retard / Chiffre d'affaires / Marge** ; badges « En retard », « Livré à temps », « Délai dépassé » |
| `/atelier/modeles` | Les modèles (`MOD-ARM2`, `MOD-LIT2`, `MOD-TAB6`, `MOD-SAL7`), leur **nomenclature**, le **coût matière estimé** et les **besoins** pour N unités (avec le manquant à acheter) |
| `/atelier/[id]` (fiche) | Avancement + **« Étape suivante »**, matières consommées (avec les chutes), équipe, coût de revient et marge |

**À tester :**

1. **« Nouvelle commande »** : choisir un client, un modèle, une quantité, une
   date promise → les lignes de matières sont **préremplies depuis la
   nomenclature** (quantité du modèle × nombre d'unités), **sans mouvement de
   stock** : rien n'est encore consommé.
2. Sur la fiche, **« Ajouter une matière »** → c'est **là** que le stock baisse :
   un `exit` pour la consommation réelle, et un `exit` **distinct** pour les
   chutes éventuelles (motif « chutes de bois — commande MEU-… »), lisibles tous
   les deux dans `/stocks`.
3. **« Affecter un ouvrier »** → la main-d'œuvre entre dans le coût de revient.
4. **« Étape suivante »** jusqu'à **« Livré »** : le meuble fini entre en stock
   **une seule fois** (mouvement « entrée ») et la date de livraison est posée si
   elle manquait. « Livré à temps » compare la date de livraison à la date
   promise.
5. **« Annuler la commande »** (avec motif) : les matières déjà consommées sont
   **rendues au stock** ; la commande n'est jamais supprimée.

> `MEU-2026-000003` (ensemble salon) est livré et payé : le produit
> « Ensemble salon complet » est passé de 1 à 2 en stock à la livraison.

---

## 5. Ce que chaque opération produit ailleurs

C'est la partie qui fait comprendre la logique de l'application : **un seul
moteur de stock**, **une seule caisse**, **les documents ne se suppriment pas**.

| Opération | Stock (`/stocks`) | Caisse (`/caisse`) | Dettes (`/soldes`, fiches clients) | Rapports (`/rapports`) |
|---|---|---|---|---|
| Matériau de chantier | `exit` motivé, stock du produit − quantité | — | — | Coût de revient du chantier |
| Ouvrier affecté | — | — | — | Main-d'œuvre et marge du chantier |
| Encaisser un chantier | — | **Entrée** de caisse (sauf règlement « Crédit ») | Reste à payer du chantier ; fiche client | Encaissements, CA des prestations |
| Chantier terminé | — | — | — | Date de fin, marge |
| Annuler un chantier | **`entry`** : matériaux rendus | — | Reste à payer recalculé | Chantier sorti du CA |
| Matière première de briqueterie | `exit` motivé (`brick_production`) | — | — | Coût matière du lot |
| Mise en stock d'un lot | **`entry`** de `production` **+ `exit`** des cassées | — | — | Briques fabriquées / cassées / coût unitaire |
| Casse sur un lot en stock | `exit` immédiat | — | — | Taux de casse |
| Vente de briques | `exit` (vente) | Entrée de caisse | Créances client | « Briques vendues » de `/briqueterie` |
| Matière d'atelier | `exit` (+ `exit` séparé pour les chutes) | — | — | Coût matière et marge de la commande |
| Commande d'atelier **livrée** | **`entry`** du meuble fini | — | — | Fabriqués / en cours / livrés |
| Vente ou achat | `exit` / `entry` | Entrée / sortie | Créances / dettes | CA, marges, trésorerie |
| Dépense | — | Sortie de caisse | — | Dépenses par catégorie |
| Inventaire (produits) | `adjustment` : **écart signé** | — | — | Valorisation du stock |

Deux règles à retenir :

- **`products.stock` = somme algébrique des mouvements.** Il n'est jamais
  modifié à la main : chaque entrée, sortie, casse, chute ou livraison est un
  mouvement, et le stock en découle.
- **Un document ne se supprime pas.** Un chantier, un lot ou une commande
  s'annule avec un motif, et l'annulation réverse les mouvements de stock.

---

## 6. Les pièges à éviter

| Piège | À faire à la place |
|---|---|
| Modifier le stock « à la main » dans la fiche produit | Passer par un mouvement : vente, achat, consommation, ou **inventaire** (écart signé) |
| Supprimer une vente, un chantier, un lot ou une commande | **Annuler** avec un motif : le document reste consultable et le stock est réversé |
| Chercher une facture de vente pour une prestation | Un chantier est facturable **tout seul** : il a son numéro `CHA-…` et ses reçus |
| Saisir le devis **après** avoir ajouté des matériaux | Le devis est réaligné sur le réalisé dès la première ligne : saisir l'estimation d'abord |
| S'attendre à une marge sur un chantier saisi en lignes | Le total facturé est réaligné sur les coûts (matières + main-d'œuvre) : la marge vient de l'estimation du devis |
| Modifier les quantités d'un lot déjà **en stock** | C'est refusé : enregistrer une **casse** (« Enregistrer une casse ») |
| Faire reculer un lot ou une commande d'étape | Impossible : les transitions sont strictement croissantes |
| Compter sur la casse d'un lot **non stocké** pour sortir du stock | La sortie part avec la **mise en stock** (sinon le stock deviendrait négatif) |
| Encaisser un acompte d'atelier en attendant un reçu | Le champ « Payé » de la commande d'atelier ne crée ni reçu ni mouvement de caisse : la caisse ne suit que les ventes, les achats et les prestations |
| Chercher les briques vendues dans la briqueterie | Elles se vendent comme n'importe quel produit : `/ventes/nouvelle`. Le rapport les compte depuis les factures actives |
| Cliquer deux fois sur « Préremplir » en espérant plus de données | Le second appel ne crée **rien** : les modules déjà remplis sont laissés tels quels |
| Utiliser le préremplissage en production ou dans l'app de bureau | La carte est **masquée** dans ces deux contextes : c'est un outil de développement |

---

## 7. Vérifier que tout est cohérent

| Contrôle | Où |
|---|---|
| Stock = somme des mouvements | `/stocks` : le journal des mouvements, produit par produit |
| Soldes clients / fournisseurs | `/soldes` |
| Caisse : entrées, sorties, solde théorique | `/caisse` |
| Historique des actions | `/utilisateurs/historique` |
| Rapports (CA, marges, dépenses, encaissements) | `/rapports` |
