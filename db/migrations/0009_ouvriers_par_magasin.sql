/*
 * Ouvriers « communs » (sans magasin) : rattachés au magasin où ils ont le
 * plus travaillé, sinon au siège (README §28.5). Un nouveau magasin part ainsi
 * sans ouvrier, comme sans client, fournisseur ni produit.
 */
UPDATE `workers` SET `store_id` = COALESCE(
  (SELECT j.store_id FROM service_job_workers sw JOIN service_jobs j ON j.id = sw.job_id
    WHERE sw.worker_id = workers.id AND j.store_id IS NOT NULL
    GROUP BY j.store_id ORDER BY COUNT(*) DESC, j.store_id ASC LIMIT 1),
  (SELECT id FROM stores ORDER BY (kind = 'headquarters') DESC, id ASC LIMIT 1)
) WHERE `store_id` IS NULL;
