'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type SyncSummary = {
  mode: 'standalone' | 'hq' | 'store';
  connected: boolean;
  pending: number;
  conflicts: number;
  lastSuccessAt: string | null;
  hasError: boolean;
};

/**
 * Indicateur de synchronisation du pied de sidebar.
 *
 *  - gris  « Poste autonome » : aucune liaison au serveur central ;
 *  - vert  « Synchronisé »    : dernier échange réussi, rien en attente ;
 *  - orange « N en attente » / « Hors ligne » : des changements attendent
 *    le prochain échange (le travail continue normalement) ;
 *  - rouge « Conflits »       : un administrateur doit arbitrer.
 * Un clic ouvre /synchronisation.
 */
export function SyncIndicator({ collapsed = false }: { collapsed?: boolean }) {
  const [status, setStatus] = useState<SyncSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/sync/status', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as SyncSummary;
        if (!cancelled) setStatus(data);
      } catch {
        /* hors ligne : on garde le dernier état connu */
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const linked = Boolean(status && status.mode !== 'standalone' && status.connected);
  let label = 'Poste autonome';
  let dot = 'bg-base-content/30';
  let tone = 'text-base-content/50';
  if (linked && status) {
    if (status.conflicts > 0) {
      label = `${status.conflicts} conflit${status.conflicts > 1 ? 's' : ''} à arbitrer`;
      dot = 'bg-error';
      tone = 'text-error';
    } else if (status.hasError) {
      label = status.pending > 0 ? `Hors ligne · ${status.pending} en attente` : 'Hors ligne';
      dot = 'bg-warning';
      tone = 'text-warning';
    } else if (status.pending > 0) {
      label = `${status.pending} en attente d’envoi`;
      dot = 'bg-warning';
      tone = 'text-warning';
    } else {
      label = status.mode === 'hq' ? 'Synchronisé (siège)' : 'Synchronisé';
      dot = 'bg-success';
      tone = 'text-success';
    }
  }

  if (collapsed) {
    return (
      <Link href="/synchronisation" title={label} aria-label={label}>
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
      </Link>
    );
  }

  return (
    <Link
      href="/synchronisation"
      className="flex items-center gap-2 text-[11px] hover:underline"
      style={{ color: 'var(--sidebar-text-muted)' }}
      title={status?.lastSuccessAt ? `Dernier échange : ${new Date(status.lastSuccessAt).toLocaleString('fr-FR')}` : undefined}
    >
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span className={`truncate ${tone}`}>{label}</span>
    </Link>
  );
}
