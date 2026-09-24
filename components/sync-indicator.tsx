'use client';

import { useEffect, useState } from 'react';

type SyncStatus = {
  mode: 'off' | 'backup' | 'multi';
  online: boolean;
  pending: number;
  failed: number;
  lastSyncAt: string | null;
};

/**
 * Indicateur d'état de synchronisation du pied de sidebar (README §5.4).
 *
 * La synchronisation est **optionnelle** (§26.14) : si l'API est absente ou si
 * la route n'est pas disponible, l'indicateur affiche simplement « Local » et
 * l'application n'en souffre pas. Aucun écran ne dépend de lui.
 */
export function SyncIndicator({ collapsed = false }: { collapsed?: boolean }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch('/api/sync/status', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as SyncStatus;
        if (!cancelled) setStatus(data);
      } catch {
        /* hors ligne ou route absente : on reste sur l'état local */
      }
    };

    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const mode = status?.mode ?? 'off';
  const isOff = mode === 'off';

  const label = isOff
    ? 'Local'
    : status?.online
      ? mode === 'multi'
        ? 'Synchronisé (multi-postes)'
        : 'Sauvegardé en ligne'
      : 'Hors ligne';

  const tone = isOff ? 'text-base-content/50' : status?.online ? 'text-success' : 'text-warning';

  if (collapsed) {
    return (
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ${
          isOff ? 'bg-base-content/30' : status?.online ? 'bg-success' : 'bg-warning'
        }`}
        title={label}
        aria-label={label}
      />
    );
  }

  return (
    <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--sidebar-text-muted)' }}>
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
          isOff ? 'bg-base-content/30' : status?.online ? 'bg-success' : 'bg-warning'
        }`}
        aria-hidden
      />
      <span className={`truncate ${tone}`}>{label}</span>
      {!isOff && (status?.pending ?? 0) > 0 && (
        <span className="tabular opacity-80">· {status?.pending} en attente</span>
      )}
    </div>
  );
}
