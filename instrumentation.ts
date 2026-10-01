/**
 * Tâches de fond du poste (Next.js `register()`, exécuté au démarrage du
 * serveur local, jamais dans le navigateur).
 *
 * Toutes les minutes, le planificateur vérifie :
 *  - la **sauvegarde quotidienne** (une par jour, copie externe incluse) ;
 *  - la **synchronisation automatique** avec le serveur central (toutes les
 *    `auto_sync_minutes`, 5 par défaut) quand le poste est inscrit ;
 *  - l'**envoi automatique des rapports** (SMS / WhatsApp) selon les
 *    paramètres.
 *
 * Aucune de ces tâches ne bloque l'application : une erreur est journalisée et
 * la tâche est retentée au tour suivant.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Pas de tâche de fond pendant `next build`.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.PD_DISABLE_SCHEDULER === '1') return;

  const { startScheduler } = await import('./lib/scheduler');
  startScheduler();
}
