# Cahier des charges — Filiales de production intégrées

## 1. Décision client

Le client veut supprimer le module séparé **`/atelier`** et intégrer son fonctionnement dans le nouveau système de **filiales de production**.

La briqueterie, la vitrerie, les meubles et toute autre activité doivent devenir des filiales créées par l'administrateur. Chaque filiale apparaît directement dans la sidebar comme un vrai module de l'application : **Briqueterie**, **Meuble**, **Vitrerie**, etc.

Chaque filiale doit avoir son propre espace complet : tableau de bord, modèles, productions, stock, inventaire, commandes, ventes, nouvelles ventes, dépenses, caisse, rapports et paramètres.

Objectif : ne plus avoir un module briqueterie d'un côté et un module atelier meubles de l'autre. Tout doit être regroupé dans une seule logique claire : **Filiales de production**.

---

## 2. Objectifs fonctionnels

1. Supprimer l'accès direct au module `/atelier`.
2. Transformer l'atelier de meubles en une filiale de production nommée par exemple **Meuble** ou **Atelier Meuble**.
3. Transformer la briqueterie existante en une filiale nommée **Briqueterie**.
4. Permettre à l'administrateur de créer d'autres filiales : **Vitrerie**, **Menuiserie**, **Aluminium**, ou autre.
5. Afficher chaque filiale active directement dans la sidebar.
6. Permettre le partage des clients entre plusieurs filiales.
7. Donner à chaque filiale ses propres modèles, productions, commandes, ventes, stock, inventaires, dépenses, caisse et rapports.
8. Garder une vue consolidée pour la direction : toutes filiales, par magasin, par période, par client.
9. Respecter les règles existantes : stock par mouvements, paiements via caisse, aucune suppression physique, permissions, fonctionnement hors ligne et synchronisation.

---

## 3. Nouvelle organisation de l'application

### 3.1 Modules à supprimer ou remplacer

Le module séparé `/atelier` doit disparaître de la navigation et être remplacé par la filiale **Meuble**.

À supprimer ou rediriger :

- `/atelier` ;
- `/atelier/modeles` ;
- `/atelier/[id]` ;
- routes API atelier si elles deviennent redondantes ;
- liens sidebar « Commandes d'atelier » et « Modèles de meubles ».

Les anciennes données de l'atelier ne doivent pas être supprimées physiquement. Elles doivent être migrées ou rendues consultables depuis la filiale Meuble.

### 3.2 Modules à conserver dans le nouveau système

Chaque filiale possède ses propres onglets :

- Tableau de bord ;
- Modèles ;
- Productions ;
- Stock ;
- Inventaire ;
- Commandes ;
- Ventes ;
- Nouvelle vente ;
- Dépenses ;
- Caisse ;
- Rapports ;
- Clients ;
- Paramètres.

---

## 4. Sidebar dynamique

Chaque filiale active doit apparaître directement dans la sidebar.

Exemple : si l'administrateur crée trois filiales, la sidebar affiche :

- Briqueterie ;
- Meuble ;
- Vitrerie.

Règles :

- seules les filiales actives et autorisées à l'utilisateur apparaissent ;
- le nom affiché est le nom choisi par l'administrateur ;
- une filiale suspendue ou archivée ne s'affiche plus comme raccourci actif ;
- l'administrateur doit pouvoir choisir l'ordre d'affichage ;
- l'administrateur doit pouvoir choisir une icône adaptée : brique, meuble, vitrerie, usine, stock, etc. ;
- au clic sur une filiale, l'utilisateur arrive sur son tableau de bord.

Une page générale **Filiales** reste disponible pour administrer toutes les filiales et voir la synthèse globale.

---

## 5. Clients partagés entre filiales

Le client peut travailler avec plusieurs filiales.

Exemple : le même client peut acheter :

- des briques à la Briqueterie ;
- des meubles à la filiale Meuble ;
- des vitres à la Vitrerie.

Règles :

- un client peut être visible dans toutes les filiales ou seulement dans certaines ;
- une filiale peut avoir ses clients propres ;
- une vente, commande ou dette garde toujours sa filiale d'origine ;
- la fiche client doit afficher l'activité par filiale : commandes, ventes, paiements, dettes, documents ;
- les dettes peuvent être consultées par filiale ou globalement selon les droits.

Tableau attendu dans la fiche client :

| Filiale | Commandes | Ventes | Payé | Reste dû |
|---|---:|---:|---:|---:|
| Briqueterie | 3 | 12 000 000 GNF | 8 000 000 GNF | 4 000 000 GNF |
| Meuble | 1 | 5 000 000 GNF | 5 000 000 GNF | 0 GNF |

---

## 6. Modèles de production

L'ancien **type de brique** et l'ancien **modèle de meuble** deviennent tous les deux des **modèles de production**.

Exemples :

- Brique 15 creuse ;
- Brique 20 pleine ;
- Vitre claire 6 mm ;
- Miroir 80 × 120 ;
- Table basse ;
- Armoire 3 portes ;
- Lit deux places ;
- Porte aluminium.

Champs recommandés :

- filiale ;
- nom du modèle ;
- catégorie ;
- unité de production ;
- unité de vente ;
- dimensions : longueur, largeur, hauteur, épaisseur ;
- description ;
- prix de vente conseillé ;
- seuil d'alerte stock ;
- matières/composants nécessaires si applicable ;
- statut actif/inactif.

Pour la filiale Meuble, les nomenclatures de l'ancien atelier doivent être reprises : matières, chutes, main-d'œuvre et coût de fabrication.

---

## 7. Productions

Une production appartient toujours à une filiale.

Elle contient :

- date de début ;
- modèle produit ;
- quantité prévue ;
- quantité obtenue ;
- pertes, rebuts ou chutes ;
- ouvriers ou équipe ;
- dépenses rattachées ;
- matières consommées ;
- statut : brouillon, en cours, terminée, annulée ;
- observations.

Quand une production est validée :

- les matières consommées sortent du stock si elles sont suivies ;
- le produit fini entre dans le stock de la filiale ;
- le coût est calculé à partir des dépenses, matières et main-d'œuvre ;
- aucune modification directe du stock n'est autorisée.

---

## 8. Stock par filiale

Chaque filiale possède son propre stock.

Fonctions attendues :

- stock disponible par modèle ;
- mouvements d'entrée et sortie ;
- seuils d'alerte ;
- historique complet ;
- stock valorisé ;
- ajustement autorisé seulement aux utilisateurs habilités ;
- interdiction du stock négatif sauf dérogation autorisée et journalisée.

Mouvements possibles :

- entrée de production ;
- sortie vente ;
- sortie commande livrée ;
- sortie matière consommée ;
- perte, casse ou chute ;
- ajustement d'inventaire ;
- annulation de document.

Les transferts entre filiales ne sont pas prioritaires pour la première version. Ils peuvent être prévus plus tard.

---

## 9. Inventaire par filiale

Chaque filiale doit pouvoir faire son propre inventaire.

Fonctions attendues :

- créer un inventaire pour une filiale ;
- compter le stock réel par modèle ;
- comparer stock théorique et stock compté ;
- enregistrer les écarts ;
- demander une justification pour tout écart ;
- valider l'inventaire par un utilisateur habilité ;
- générer automatiquement les mouvements d'ajustement ;
- imprimer ou exporter le rapport d'inventaire.

Règles :

- un inventaire appartient à une filiale et à un magasin ;
- un inventaire validé ne se modifie plus ;
- une correction d'inventaire doit être visible dans l'historique ;
- l'inventaire ne doit pas masquer les pertes ou les vols : l'écart doit rester traçable.

---

## 10. Commandes

Une commande de filiale suit une demande client avant, pendant ou après production.

Statuts recommandés :

1. brouillon ;
2. confirmée ;
3. en production ;
4. prête ;
5. livrée ;
6. facturée ;
7. annulée.

Une commande contient :

- client ;
- filiale ;
- modèle(s) commandé(s) ;
- quantités ;
- prix figés ;
- acompte via paiement ;
- date prévue de livraison ;
- commentaires ;
- documents imprimables.

Une commande peut être transformée en vente ou facture de filiale sans ressaisie.

---

## 11. Ventes et nouvelles ventes

Chaque filiale doit avoir un bouton **Nouvelle vente**.

Une vente de filiale contient :

- filiale ;
- magasin ;
- client ;
- lignes vendues ;
- quantités ;
- prix unitaires figés ;
- remise éventuelle ;
- total ;
- paiement comptant ou partiel ;
- reste dû ;
- reçu et facture imprimables ;
- statut : brouillon, active, annulée.

Règles :

- une vente brouillon ne touche ni stock ni caisse ;
- une vente validée sort le stock de la filiale ;
- le paiement entre dans la caisse de la filiale ou dans la caisse générale selon le paramétrage ;
- les ventes de filiale restent visibles dans les rapports de la filiale ;
- les ventes générales `/ventes` et les ventes de filiale doivent être clairement séparées pour éviter les doublons.

Recommandation : garder les ventes de filiale dans l'espace de la filiale, puis proposer une vue consolidée direction.

---

## 12. Dépenses par filiale

Chaque filiale doit pouvoir enregistrer ses propres dépenses.

Types de dépenses :

- dépenses de production ;
- dépenses globales de la filiale ;
- matières premières ;
- main-d'œuvre ;
- transport ;
- entretien machines ;
- loyer ou charges rattachées ;
- achat d'outillage ;
- pertes exceptionnelles ;
- autres dépenses.

### 12.1 Dépenses de production

Une dépense de production est rattachée à une production précise.

Exemples :

- main-d'œuvre d'un lot de briques ;
- carburant du four ;
- colle pour meuble ;
- découpe de vitre.

Elle entre dans le coût de revient de la production.

### 12.2 Dépenses globales de filiale

Une dépense globale concerne toute la filiale, sans être rattachée à une production précise.

Exemples :

- loyer de l'atelier ;
- salaire mensuel du responsable ;
- entretien général ;
- transport administratif ;
- électricité globale ;
- achat d'un outil commun.

Elle doit apparaître dans les rapports de la filiale et diminuer le bénéfice de la période.

### 12.3 Règles de dépense

- une dépense appartient toujours à une filiale ;
- elle peut être rattachée ou non à une production ;
- elle peut être payée immédiatement ou rester à payer ;
- un décaissement passe par la caisse ;
- une dépense importante peut nécessiter approbation ;
- aucune suppression physique : annulation avec motif ;
- les coûts et bénéfices restent visibles seulement aux utilisateurs autorisés.

---

## 13. Caisse par filiale

Chaque filiale doit pouvoir suivre sa caisse.

Deux modes possibles doivent être décidés au développement :

### Option A — Caisse séparée par filiale

Chaque filiale a sa propre caisse :

- encaissements de ventes ;
- décaissements de dépenses ;
- solde de caisse ;
- ouverture et clôture ;
- historique des mouvements.

Avantage : lecture claire par activité.

Inconvénient : plus de caisses à contrôler.

### Option B — Caisse générale avec filtre filiale

Une seule caisse générale existe, mais chaque mouvement porte la filiale concernée.

Avantage : plus simple pour le siège.

Inconvénient : moins précis si les filiales ont des responsables séparés.

### Recommandation

Pour une excellente gestion, choisir **Option A** si chaque filiale a son responsable et son argent séparé. Choisir **Option B** si l'argent est géré au siège dans une seule caisse.

Dans les deux cas, chaque mouvement de caisse doit indiquer :

- filiale concernée ;
- type : entrée ou sortie ;
- origine : vente, paiement client, dépense, ajustement ;
- montant ;
- date ;
- utilisateur ;
- observation ;
- lien vers le document source.

---

## 14. Rapports

Rapports par filiale :

- tableau de bord ;
- ventes par période ;
- encaissements ;
- restes dus ;
- dépenses de production ;
- dépenses globales ;
- caisse ;
- inventaires ;
- stock disponible ;
- stock valorisé ;
- productions par modèle ;
- commandes en cours ;
- créances clients ;
- coût de revient ;
- marge et bénéfice selon permission.

Rapports consolidés :

- comparaison Briqueterie / Meuble / Vitrerie / autres ;
- chiffre d'affaires total ;
- dépenses totales ;
- solde caisse par filiale ;
- stock valorisé ;
- reste à encaisser ;
- bénéfice global.

Les exports PDF/image/WhatsApp doivent respecter les règles existantes : document autonome, aucune marge interne sur un document client, montants formatés en GNF.

---

## 15. Permissions

Droits à prévoir :

- voir filiale ;
- gérer les paramètres de filiale ;
- gérer les modèles ;
- créer/modifier/annuler une production ;
- valider une production ;
- voir le stock ;
- ajuster le stock ;
- faire un inventaire ;
- valider un inventaire ;
- créer/modifier/annuler une commande ;
- créer/valider/annuler une vente ;
- encaisser ;
- voir la caisse ;
- clôturer la caisse ;
- créer une dépense ;
- approuver une dépense ;
- décaisser une dépense ;
- voir rapports ;
- voir coûts et bénéfices ;
- partager ou retirer un client d'une filiale ;
- gérer les utilisateurs de la filiale.

Recommandation technique : éviter à terme les noms de droits `brick.*` pour ce module, car il ne concerne plus seulement les briques. Préférer un domaine générique comme `branches.*` ou `production.*`.

---

## 16. Données à créer ou adapter

Tables ou concepts probables :

- `production_branches` : filiales ;
- `production_models` : modèles fabriqués/vendus ;
- `production_batches` : productions/lots ;
- `production_batch_lines` si plusieurs modèles par production ;
- `production_expenses` : dépenses de production ;
- `branch_expenses` ou extension des dépenses existantes : dépenses globales de filiale ;
- `production_orders` : commandes ;
- `production_order_lines` ;
- `production_sales` ou ventes existantes avec canal/type filiale ;
- `production_stock_movements` ou extension des mouvements existants ;
- `branch_inventories` : inventaires par filiale ;
- `branch_inventory_items` : lignes d'inventaire ;
- `branch_cash_sessions` ou extension des sessions de caisse ;
- `branch_cash_movements` ou extension des mouvements de caisse ;
- `user_branch_access` : accès utilisateurs par filiale ;
- `customer_branch_access` : clients visibles/utilisables par filiale ;
- champs de navigation : affichage sidebar, ordre, icône, statut ;
- tables de synchronisation et références nécessaires.

Décision technique à prendre : réutiliser les tables existantes avec un champ `production_branch_id`, ou créer des tables spécialisées. La préférence fonctionnelle est de garder un modèle commun, mais sans mélanger les écrans si cela rend l'utilisation confuse.

---

## 17. Migration depuis l'existant

### 17.1 Briqueterie

La briqueterie devient une filiale initiale nommée **Briqueterie**.

À migrer :

- types de briques → modèles ;
- productions/lots → productions de filiale ;
- commandes → commandes de filiale ;
- ventes de briques → ventes de filiale ;
- dépenses et stock → filiale Briqueterie ;
- rapports → rapports de la filiale.

### 17.2 Atelier meubles

Le module `/atelier` devient une filiale initiale nommée **Meuble** ou **Atelier Meuble**.

À migrer :

- modèles de meubles → modèles de production ;
- nomenclatures matières → matières/composants des modèles ;
- commandes atelier → commandes de la filiale Meuble ;
- fabrications pour stock → productions de la filiale Meuble ;
- matières consommées et chutes → mouvements de stock ;
- paiements des commandes atelier → paiements/ventes de filiale ;
- rapports atelier → rapports de la filiale Meuble.

Règle importante : ne pas supprimer physiquement les anciennes données. Elles doivent être migrées, redirigées ou conservées en historique.

---

## 18. Organisation Git du travail

Le développement doit rester sur une branche dédiée, séparée de `main`.

Règles demandées :

- créer ou continuer une branche spécifique, par exemple `feature/filiales-production` ;
- ne pas développer directement sur `main` ;
- pousser la branche sur le dépôt distant ;
- le client testera ou relira le travail depuis cette branche ;
- si le résultat est satisfaisant, le client fusionnera manuellement dans `main` ;
- si le résultat n'est pas retenu, le client pourra supprimer la branche sans impacter `main`.

---

## 19. Lots de réalisation proposés

### Lot A — Décision et nettoyage

- Valider la suppression de `/atelier`.
- Valider le nom de la filiale initiale : Meuble ou Atelier Meuble.
- Décider caisse séparée par filiale ou caisse générale filtrée par filiale.
- Décider si les ventes de filiale apparaissent dans `/ventes` ou seulement dans l'espace filiale.

### Lot B — Socle filiales

- Tables filiales, accès utilisateurs et partage clients.
- Sidebar dynamique avec icône et ordre.
- Permissions génériques.
- Page d'administration des filiales.

### Lot C — Migration briqueterie et atelier

- Migrer Briqueterie vers filiale.
- Migrer `/atelier` vers filiale Meuble.
- Rediriger ou retirer les anciennes pages.
- Conserver l'historique.

### Lot D — Modèles, productions et stock

- Modèles génériques.
- Nomenclatures pour les filiales qui en ont besoin.
- Productions génériques.
- Stock par filiale.

### Lot E — Inventaires

- Inventaire par filiale.
- Comptage, écarts, validation.
- Mouvements d'ajustement.
- Rapport d'inventaire.

### Lot F — Commandes et ventes

- Commandes par filiale.
- Nouvelle vente par filiale.
- Paiements, reçus, factures.
- Annulations et retours.

### Lot G — Dépenses et caisse

- Dépenses de production.
- Dépenses globales de filiale.
- Approbation et décaissement.
- Caisse par filiale ou caisse filtrée.
- Clôture et historique.

### Lot H — Rapports et recette

- Tableau de bord par filiale.
- Vue consolidée direction.
- Rapports stock, inventaire, caisse, dépenses, ventes, bénéfice.
- Vérification permissions, synchronisation et multi-magasins.

---

## 20. Questions à valider avec le client

1. Le nom final doit-il être **Meuble** ou **Atelier Meuble** dans la sidebar ?
2. Les ventes de filiale doivent-elles apparaître dans `/ventes` ou seulement dans la filiale ?
3. Chaque filiale doit-elle avoir une caisse séparée ou une caisse générale avec filtre filiale ?
4. Les dépenses globales doivent-elles nécessiter approbation avant décaissement ?
5. Les clients partagés sont-ils visibles par toutes les filiales ou seulement par les filiales choisies ?
6. Les filiales sont-elles rattachées à un magasin, au siège, ou peuvent-elles couvrir plusieurs magasins ?
7. Les matières premières sont-elles obligatoires pour toutes les filiales ou seulement pour Meuble/Vitrerie ?
8. Faut-il gérer les transferts entre filiales dès la première version ou plus tard ?
9. Faut-il plusieurs unités pour le même modèle, par exemple production en m² et vente en pièce ?
10. Quels rapports sont prioritaires pour la première livraison ?
11. Qui peut voir les coûts, les marges et les bénéfices ?
12. Faut-il ouvrir et clôturer la caisse chaque jour par filiale ?

---

## 21. Critères d'acceptation

La fonctionnalité sera considérée acceptable si :

- `/atelier` n'apparaît plus dans la sidebar ;
- les anciennes données atelier sont accessibles depuis la filiale Meuble ou conservées en historique ;
- l'administrateur peut créer une filiale nommée librement ;
- les filiales actives comme Briqueterie, Meuble ou Vitrerie apparaissent directement dans la sidebar ;
- chaque filiale a son tableau de bord ;
- chaque filiale a ses modèles, productions, stock, inventaire, commandes, ventes, dépenses, caisse et rapports ;
- un client peut être partagé entre plusieurs filiales sans mélanger les documents ;
- une production validée augmente le stock du modèle ;
- une vente validée diminue le stock et peut être encaissée ;
- une dépense de filiale diminue le bénéfice de la période ;
- une dépense payée crée un mouvement de caisse ;
- une caisse de filiale ou un filtre filiale permet de connaître les entrées, sorties et soldes ;
- un inventaire validé crée les ajustements nécessaires et garde l'historique des écarts ;
- les bénéfices restent cachés aux utilisateurs non autorisés ;
- le fonctionnement reste possible sans Internet ;
- les actions importantes sont visibles dans le journal ;
- aucune donnée d'une filiale non autorisée n'est accessible par l'interface ou l'API.
