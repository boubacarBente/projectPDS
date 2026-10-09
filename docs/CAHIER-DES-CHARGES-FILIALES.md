# Cahier des charges — Filiales de production génériques

## 1. Demande client

Le client veut transformer le module « Briqueterie » en un système générique de **filiales de production**. L'administrateur doit pouvoir créer une filiale et choisir son nom : **Briqueterie**, **Vitrerie**, **Meuble**, ou tout autre métier. Chaque filiale possède son propre espace de travail : tableau de bord, productions, stock, commandes, ventes, rapports et création rapide de nouvelles ventes.

Objectif : ne plus coder un module figé pour la seule briqueterie. Le logiciel doit gérer plusieurs activités de production avec les mêmes règles de gestion, tout en gardant les particularités nécessaires par métier.

---

## 2. Objectifs fonctionnels

1. Permettre au super administrateur ou à l'administrateur autorisé de créer plusieurs filiales.
2. Donner à chaque filiale un nom libre, un type d'activité, un magasin ou périmètre, des clients partagés, des utilisateurs autorisés et des droits.
3. Remplacer « types de briques » par un catalogue de **modèles de production** : modèle de brique, modèle de vitre, modèle de meuble, ou tout autre produit fabriqué.
4. Isoler les données par filiale : une production, un stock, une commande ou une vente appartient toujours à une filiale.
5. Garder une lecture consolidée pour la direction : ventes totales, stock global, bénéfice, dépenses et rapports par filiale ou toutes filiales.
6. Respecter les règles existantes du projet : stock par mouvements, paiements via caisse, aucune suppression physique, permissions par utilisateur, fonctionnement local hors ligne et synchronisation multi-postes.

---

## 3. Vocabulaire cible

| Ancien terme briqueterie | Nouveau terme générique | Exemple briqueterie | Exemple vitrerie | Exemple meubles |
|---|---|---|---|---|
| Briqueterie | Filiale de production | Briqueterie Kankan | Vitrerie Centre | Atelier Meubles |
| Type de brique | Modèle de production | Brique 15 pleine | Vitre claire 6 mm | Armoire 3 portes |
| Lot de production | Production / lot | Lot cuisson n°15 | Découpe lot n°8 | Fabrication commande n°12 |
| Stock de briques | Stock de produits fabriqués | 5 000 briques | 80 vitres | 12 meubles |
| Commande de briques | Commande de filiale | Commande chantier | Commande vitres | Commande salon |
| Vente de briques | Vente de filiale | Vente briques | Vente vitres | Vente meuble |

---

## 4. Gestion des filiales

### 4.1 Création d'une filiale

Un administrateur autorisé peut créer une filiale avec :

- nom affiché : « Briqueterie », « Vitrerie », « Meuble », etc. ;
- type d'activité indicatif : briques, vitrerie, meubles, autre ;
- magasin ou siège propriétaire ;
- statut : active, suspendue, archivée ;
- logo ou couleur d'identification si nécessaire ;
- unités principales : pièce, m², m³, paquet, lot, kg, sac, planche, etc. ;
- règles de stock : unité vendue, unité produite, seuil d'alerte ;
- numérotation des documents : production, commande, facture, reçu ;
- clients accessibles à la filiale : clients propres, clients partagés ou tous les clients autorisés ;
- utilisateurs autorisés et niveau d'accès.

### 4.2 Tableau de bord par filiale

Chaque filiale dispose d'un tableau de bord montrant au minimum :

- chiffre d'affaires de la période ;
- montant encaissé ;
- reste à encaisser ;
- dépenses de production ;
- coût de main-d'œuvre ;
- marge ou bénéfice si l'utilisateur a la permission de voir les soldes ;
- nombre de productions en cours, terminées, annulées ;
- stock disponible par modèle ;
- commandes en attente, en production, livrées, facturées ;
- alertes : stock bas, commande en retard, paiement restant, production déficitaire.

La direction peut voir un tableau de bord consolidé avec filtre : une filiale, plusieurs filiales, tous magasins, période.

---

## 5. Modèles de production

### 5.1 Principe

La demande « ajout de types briques devient nouveau modèle » signifie que l'ancien écran de types de briques devient un écran **Modèles**.

Un modèle représente ce que la filiale fabrique ou vend :

- brique 15 creuse ;
- brique 20 pleine ;
- vitre claire 6 mm ;
- miroir 80 × 120 ;
- table basse ;
- armoire 3 portes ;
- tout autre produit fabriqué.

### 5.2 Champs d'un modèle

Chaque modèle contient :

- filiale concernée ;
- nom du modèle ;
- catégorie ;
- unité de production ;
- unité de vente ;
- dimensions facultatives : longueur, largeur, hauteur, épaisseur ;
- description ;
- prix de vente conseillé ;
- seuil d'alerte stock ;
- matières ou composants nécessaires si la filiale les utilise ;
- statut actif/inactif.

### 5.3 Règle importante

Un modèle inactif ne peut plus être utilisé pour une nouvelle production ou une nouvelle commande, mais reste visible dans l'historique et les anciens documents.

---

## 6. Productions

### 6.1 Création d'une production

Une production appartient toujours à une filiale et contient :

- date de début ;
- modèle produit ;
- quantité prévue ;
- quantité réellement obtenue ;
- pertes ou rebuts ;
- équipe ou ouvriers ;
- dépenses rattachées ;
- matières consommées si applicable ;
- statut : brouillon, en cours, terminée, annulée ;
- observations.

### 6.2 Coût de production

Le coût d'une production ne doit pas être saisi comme un total libre si le système peut le calculer. Il est recalculé à partir de :

- dépenses validées ;
- main-d'œuvre ;
- matières consommées ;
- frais rattachés ;
- pertes ou rebuts si valorisés.

Cette règle reprend l'esprit actuel de la briqueterie : ne pas stocker un coût global opaque, mais garder les lignes qui l'expliquent.

### 6.3 Entrée en stock

Quand une production est terminée et validée, le stock du modèle augmente par un mouvement de stock. Le stock ne doit jamais être modifié directement.

---

## 7. Stock par filiale

Chaque filiale possède son stock propre, filtrable par magasin et modèle.

Fonctions attendues :

- stock disponible ;
- mouvements d'entrée et sortie ;
- ajustement autorisé uniquement aux utilisateurs habilités ;
- inventaire ;
- seuils d'alerte ;
- historique complet ;
- interdiction du stock négatif sauf dérogation autorisée et journalisée.

Les mouvements possibles :

- entrée de production ;
- sortie vente ;
- sortie commande livrée ;
- casse/perte ;
- ajustement d'inventaire ;
- annulation de document ;
- transfert éventuel entre magasins ou filiales si autorisé.

---

## 8. Commandes

Une commande de filiale sert à suivre une demande client avant ou pendant la production.

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
- prix figés au moment de la commande ;
- acompte éventuel via paiement ;
- échéance ou date de livraison ;
- commentaires ;
- documents imprimables.

Une commande facturée crée ou alimente une vente de filiale, selon la règle choisie au développement.

---

## 9. Ventes et nouvelles ventes

Chaque filiale doit avoir un bouton ou écran **Nouvelle vente**.

Une vente de filiale contient :

- filiale ;
- magasin ;
- client ;
- lignes de modèles vendus ;
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
- une vente validée sort le stock ;
- un paiement passe par le module de paiement/caisse ;
- les ventes de filiale sont visibles dans les rapports de la filiale ;
- la direction peut décider si elles apparaissent aussi dans les ventes commerciales générales ou restent séparées par canal.

---

## 10. Rapports

Rapports par filiale :

- ventes par période ;
- production par modèle ;
- stock disponible ;
- commandes en cours ;
- créances clients ;
- dépenses de production ;
- coût de revient ;
- marge et bénéfice selon permission ;
- performance par magasin ;
- performance par utilisateur ou équipe.

Rapports consolidés :

- comparaison Briqueterie / Vitrerie / Meuble / autres ;
- chiffre d'affaires total ;
- dépenses totales ;
- stock valorisé ;
- reste à encaisser ;
- bénéfice global.

Les exports PDF/image/WhatsApp doivent respecter les règles existantes : document autonome, aucune marge interne sur un document client, montants formatés en GNF.

---

## 11. Clients partagés, utilisateurs et permissions

Le client demande que **les clients se partagent entre les filiales**. Cela signifie :

- un même client peut acheter auprès de plusieurs filiales, par exemple Briqueterie et Meuble ;
- la fiche client doit pouvoir afficher son historique par filiale : commandes, ventes, paiements, dettes et documents ;
- une filiale peut avoir des clients propres, mais l'administrateur peut aussi rendre un client visible et utilisable dans plusieurs filiales ;
- une commande ou une vente garde toujours la filiale concernée, même si le client est partagé ;
- les dettes et restes à payer peuvent être consultés par client, par filiale, ou tous dossiers confondus selon les droits ;
- les utilisateurs restent soumis à leurs permissions : un vendeur peut créer des ventes sans voir les bénéfices, un responsable production peut gérer productions et stock, et le super administrateur garde la maîtrise totale.

### 11.1 Domaines de droits à prévoir

- Voir filiale ;
- gérer les paramètres de filiale ;
- gérer les modèles ;
- créer/modifier/annuler une production ;
- valider une production ;
- voir le stock ;
- ajuster le stock ;
- créer/modifier/annuler une commande ;
- créer/valider/annuler une vente ;
- encaisser ;
- voir rapports ;
- voir coûts et bénéfices ;
- gérer les utilisateurs de la filiale ;
- partager ou retirer un client d'une filiale ;
- voir l'historique complet d'un client partagé.

---

## 12. Écrans à prévoir

### 12.1 Administration

- Liste des filiales ;
- création/modification d'une filiale ;
- affectation des clients aux filiales ;
- affectation des utilisateurs ;
- paramètres de numérotation ;
- unités et catégories ;
- règles de stock.

### 12.2 Espace filiale

Pour chaque filiale :

- tableau de bord ;
- modèles ;
- productions ;
- stock ;
- commandes ;
- ventes ;
- nouvelle vente ;
- dépenses ;
- rapports ;
- paramètres si autorisé.

### 12.3 Navigation et sidebar

Chaque filiale active doit pouvoir apparaître comme un lien direct dans la sidebar, exactement comme les autres modules de l'application.

Exemple attendu : si l'administrateur crée deux filiales nommées **Briqueterie** et **Meuble**, la sidebar affiche directement :

- Briqueterie ;
- Meuble.

Au clic sur « Briqueterie », l'utilisateur arrive sur le tableau de bord de la filiale Briqueterie. Au clic sur « Meuble », il arrive sur le tableau de bord de la filiale Meuble.

Règles de navigation :

- seules les filiales actives et autorisées pour l'utilisateur connecté apparaissent dans la sidebar ;
- le nom affiché dans la sidebar est le nom choisi par l'administrateur ;
- une filiale suspendue ou archivée ne doit plus apparaître comme raccourci actif ;
- l'ordre d'affichage peut être réglé par l'administrateur ou suivre l'ordre de création ;
- chaque lien de filiale ouvre son espace avec onglets internes : Tableau de bord, Modèles, Productions, Stock, Commandes, Ventes, Nouvelle vente, Rapports ;
- une page générale « Filiales » peut rester disponible pour administrer ou retrouver toutes les filiales, mais les filiales principales doivent être accessibles directement depuis la sidebar.

---

## 13. Données à créer ou adapter

Tables ou concepts probables :

- `production_branches` : filiales ;
- `production_models` : modèles fabriqués/vendus ;
- `production_batches` : productions/lots ;
- `production_batch_lines` si plusieurs modèles par production ;
- `production_expenses` ou rattachement aux dépenses existantes ;
- `production_orders` : commandes ;
- `production_order_lines` ;
- `production_sales` ou ventes existantes avec canal/type filiale ;
- `production_stock_movements` ou extension des mouvements existants ;
- `user_branch_access` : accès utilisateurs par filiale ;
- `customer_branch_access` : clients visibles/utilisables par filiale ;
- champs de navigation : affichage sidebar, ordre, icône, statut ;
- tables de sync et références nécessaires.

Décision technique à prendre avant développement : réutiliser les ventes/produits existants avec un champ filiale, ou créer des tables de ventes spécialisées. La préférence fonctionnelle est de garder un modèle commun, mais sans mélanger les écrans si cela complique la lecture pour l'utilisateur.

---

## 14. Règles de compatibilité avec le projet actuel

1. Fonctionnement hors ligne obligatoire.
2. Synchronisation compatible multi-postes et multi-magasins.
3. Toute écriture doit utiliser le magasin actif de l'utilisateur, pas un magasin envoyé par le navigateur.
4. Les clients, fournisseurs, produits et assortiments restent cloisonnés selon les règles multi-magasins existantes.
5. Aucune suppression physique : on annule ou désactive.
6. Aucun total financier sensible ne doit être accepté sans recalcul ou justification.
7. Le stock passe par les mouvements de stock.
8. Les bénéfices, coûts et marges sont visibles seulement avec permission.
9. Toute nouvelle table synchronisée doit être déclarée dans le registre de synchronisation.
10. Toute action importante doit être journalisée.

---

## 15. Migration depuis la briqueterie actuelle

La briqueterie devient une filiale initiale nommée « Briqueterie ».

Migration souhaitée :

- créer automatiquement une filiale Briqueterie ;
- transformer les types de briques en modèles ;
- rattacher les productions/lots à cette filiale ;
- rattacher commandes, ventes, dépenses et stock à cette filiale ;
- conserver les anciens identifiants en historique si utile ;
- garder les documents existants consultables.

Si certaines anciennes tables sont des archives v1, ne pas les rattacher sans analyse : le projet précise déjà que des tables `*_v1` ne doivent pas être reconnectées aux nouveaux lots ou commandes.

---

## 16. Organisation Git du travail

Le développement de ce module doit se faire sur une **nouvelle branche dédiée**, séparée de `main`.

Règles demandées :

- créer une branche spécifique avant de commencer le développement, par exemple `feature/filiales-production` ;
- ne pas développer directement sur `main` ;
- pousser cette branche sur le dépôt distant ;
- le client testera ou relira le travail depuis cette branche ;
- si le résultat est satisfaisant, le client fusionnera manuellement la branche dans `main` ;
- si le résultat n'est pas retenu, le client pourra supprimer la branche sans impacter `main`.

---

## 17. Lots de réalisation proposés

### Lot A — Conception validée

- Valider ce cahier des charges avec le client.
- Choisir les noms finaux dans l'interface : filiale, modèle, production, commande.
- Décider si les ventes de filiale apparaissent dans `/ventes` ou seulement dans l'espace filiale.

### Lot B — Socle filiales

- Tables filiales, accès utilisateurs et partage des clients.
- Écran administration des filiales.
- Navigation dynamique avec liens directs dans la sidebar.
- Permissions.

### Lot C — Modèles et stock

- Remplacer types de briques par modèles.
- Gérer unités, dimensions, prix, seuils.
- Stock par filiale et mouvements.

### Lot D — Productions

- Productions/lots génériques.
- Main-d'œuvre, dépenses, matières.
- Validation et entrée en stock.

### Lot E — Commandes et ventes

- Commandes par filiale.
- Nouvelle vente par filiale.
- Paiements, reçus, factures.
- Annulations et retours.

### Lot F — Rapports et consolidation

- Tableaux de bord par filiale.
- Rapports par filiale.
- Vue consolidée direction.
- Exports.

### Lot G — Migration et recette

- Migration briqueterie → filiale.
- Tests de non-régression multi-magasins.
- Vérification stock, caisse, paiements, permissions, synchronisation.

---

## 18. Questions à valider avec le client

1. Les filiales sont-elles rattachées à un magasin, au siège, ou peuvent-elles couvrir plusieurs magasins ?
2. Une vente de filiale doit-elle apparaître dans la liste générale des ventes ?
3. Les modèles doivent-ils gérer des nomenclatures détaillées pour toutes les filiales, ou seulement pour meubles/vitrerie ?
4. Les matières premières doivent-elles être obligatoires ?
5. Les clients partagés sont-ils visibles par toutes les filiales ou seulement par les filiales choisies ?
6. Les utilisateurs ont-ils des droits par filiale ou seulement par magasin ?
7. La direction veut-elle un stock commun ou strictement séparé par filiale ?
8. Les documents imprimés doivent-ils porter le nom de la filiale ou celui de Planète Déco seulement ?
9. Faut-il gérer les transferts entre filiales ?
10. Faut-il gérer plusieurs unités pour le même modèle, par exemple production en m² et vente en pièce ?
11. Quels rapports sont prioritaires pour la première livraison ?
12. Faut-il permettre à l'administrateur de choisir l'ordre et l'icône des filiales dans la sidebar ?

---

## 19. Critères d'acceptation

La fonctionnalité sera considérée acceptable si :

- l'administrateur crée une filiale nommée librement ;
- un utilisateur autorisé voit seulement les filiales auxquelles il a accès ;
- les filiales actives comme Briqueterie ou Meuble apparaissent directement dans la sidebar ;
- chaque filiale a son tableau de bord ;
- l'ancien type de brique est remplacé par un modèle ;
- une production validée augmente le stock du modèle ;
- une vente validée diminue le stock et peut être encaissée ;
- une commande peut être suivie jusqu'à livraison/facturation ;
- un client peut être partagé entre plusieurs filiales sans mélanger les documents ;
- les rapports affichent les données par filiale ;
- les bénéfices restent cachés aux utilisateurs non autorisés ;
- le fonctionnement reste possible sans Internet ;
- les actions importantes sont visibles dans le journal ;
- aucune donnée d'une filiale non autorisée n'est accessible par l'interface ou l'API.
