ALTER TABLE `users` ADD `is_super_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
/*
 * Super administrateur d'une base existante (README §17.2) : le plus ancien
 * administrateur actif, à défaut le plus ancien administrateur. Sur une base
 * neuve, c'est le compte créé par l'installation (`POST /api/auth/setup`).
 *
 * Un poste **magasin** ne désigne personne : il reçoit les comptes du siège,
 * drapeau compris. Désigner localement un autre compte que celui du siège
 * heurterait l'index unique à la première synchronisation.
 */
UPDATE `users` SET `is_super_admin` = 1
 WHERE `id` = (
   SELECT `id` FROM `users` WHERE `role` = 'admin'
    ORDER BY `is_active` DESC, `id` ASC LIMIT 1
 )
   AND NOT EXISTS (
     SELECT 1 FROM `sync_state` WHERE `key` = 'device_mode' AND `value` = 'store'
   );--> statement-breakpoint
CREATE UNIQUE INDEX `users_single_super_admin` ON `users` (`is_super_admin`) WHERE "users"."is_super_admin" = 1;
