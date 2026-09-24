'use client';

/**
 * Écran `/synchronisation` (README §23.10).
 *
 * ⚠️ **La synchronisation est optionnelle et désactivée par défaut**, et le
 * service PostgreSQL en ligne **n'existe pas**. Cet écran ne prétend donc jamais
 * que des données sont parties : il montre l'**état réel** du poste — mode,
 * file d'attente locale, quarantaine, conflits, appareils connus — et propose
 * les actions qui fonctionnent réellement, dont l'**export / import manuel**
 * d'un paquet `.json` (transport par clé USB).
 *
 * L'application reste pleinement utilisable avec `sync_mode = 'off'` : rien ici
 * n'est un prérequis d'une opération métier.
 *
 * ⚠️ Aucun import runtime d'un module serveur (§11 bis) : les routes de
 * `lib/sync.ts` et `lib/sync-export.ts` ne sont atteintes que par `fetch`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Modal } from '@/components/modal';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Pagination } from '@/components/search-filter';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  InfoRow,
  MiniStat,
  PageSection,
  SkeletonCards,
  SkeletonTable,
} from '@/components/design-system';
import { useSettings } from '@/app/parametres/page';
import { formatDateShort, formatDateTime } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';

/* ------------------------------------------------------------------ *
 * Types — miroir de `GET /api/sync/status`
 * ------------------------------------------------------------------ */

type OutboxRow = {
  id: number;
  tableName: string;
  syncId: string;
  operation: string;
  attempts: number;
  lastAttemptAt: string | Date | null;
  lastError: string | null;
  createdAt: string | Date | null;
};

type QuarantineRow = {
  id: number;
  tableName: string;
  syncId: string;
  missingParent: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string | Date | null;
};

type DeviceRow = {
  deviceId: string;
  name: string;
  isCurrent: boolean;
  lastSeenAt: string | Date | null;
  lastPushAt: string | Date | null;
  lastPullAt: string | Date | null;
};

type StateRow = { key: string; value: string | null; updatedAt: string | Date | null };

type SyncStatus = {
  mode: 'off' | 'backup' | 'multi';
  online: boolean;
  pending: number;
  failed: number;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  pendingQuarantine: number;
  pendingPreview: QuarantineRow[];
  queued: number;
  oldestPendingAt: string | Date | null;
  deviceId: string;
  deviceName: string;
  apiUrl: string;
  intervalMinutes: number;
  numberBlockSize: number;
  outbox: OutboxRow[];
  devices: DeviceRow[];
  state: StateRow[];
  message: string;
};

type ConflictRow = {
  id: number;
  tableName: string;
  syncId: string;
  localPayload: string;
  remotePayload: string;
  resolution: string;
  resolvedAt: string | Date | null;
  resolvedBy: number | null;
  createdAt: string | Date | null;
};

type ImportReport = {
  tablesImported: number;
  rowsInserted: number;
  rowsUpdated: number;
  quarantined: number;
  conflicts: number;
  errors: string[];
  message?: string;
};

const VIEW_LIMIT = 10;

const MODE_LABELS: Record<string, string> = {
  off: 'Désactivée',
  backup: 'Mode A — Sauvegarde en ligne (unidirectionnel)',
  multi: 'Mode B — Multi-postes (bidirectionnel)',
};

const QUARANTINE_LIMIT = 10;
const CONFLICTS_LIMIT = 10;

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as any)?.error ?? 'Requête impossible');
  return payload as T;
}

/** Extrait lisible d'une charge utile JSON, pour comparer local et distant. */
function payloadSummary(raw: string): { label: string; value: string }[] {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([key]) => key !== 'id' && key !== 'sync_id')
      .slice(0, 12)
      .map(([key, value]) => ({
        label: key.replace(/_/g, ' '),
        value:
          value === null || value === undefined
            ? '—'
            : typeof value === 'object'
              ? JSON.stringify(value)
              : String(value),
      }));
  } catch {
    return [{ label: 'charge utile', value: raw.slice(0, 200) }];
  }
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function SynchronisationPage() {
  const { settings, updateSettings, refreshSettings } = useSettings();

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [conflictsLoading, setConflictsLoading] = useState(true);
  const [conflictsError, setConflictsError] = useState<string | null>(null);

  const [isSyncing, setIsSyncing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);
  const [isResolving, setIsResolving] = useState<number | null>(null);

  const [outboxPage, setOutboxPage] = useState(1);
  const [conflictPage, setConflictPage] = useState(1);

  const [lastReport, setLastReport] = useState<ImportReport | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  /* Modales : un état booléen chacune (§8.3). */
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [isDisableOpen, setIsDisableOpen] = useState(false);
  const [selectedConflict, setSelectedConflict] = useState<ConflictRow | null>(null);
  const [isConflictOpen, setIsConflictOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importRetryFirst, setImportRetryFirst] = useState(true);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/sync/status', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      setStatus(await readJson<SyncStatus>(response));
    } catch (caught) {
      if (caught instanceof Error && caught.name === 'AbortError') return;
      setStatus(null);
      setError(caught instanceof Error ? caught.message : 'État de synchronisation indisponible');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadConflicts = useCallback(async (signal?: AbortSignal) => {
    setConflictsLoading(true);
    setConflictsError(null);

    try {
      const response = await fetch('/api/sync/conflits?pendingOnly=false', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      const payload = await readJson<{ data: ConflictRow[] }>(response);
      setConflicts(Array.isArray(payload.data) ? payload.data : []);
    } catch (caught) {
      if (caught instanceof Error && caught.name === 'AbortError') return;
      setConflicts([]);
      setConflictsError(caught instanceof Error ? caught.message : 'Conflits indisponibles');
    } finally {
      setConflictsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    void loadConflicts(controller.signal);
    return () => controller.abort();
  }, [loadStatus, loadConflicts, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  /* ── Actions ─────────────────────────────────────────────────────── */

  const handleSyncNow = useCallback(async () => {
    setIsSyncing(true);
    setLastAction(null);

    try {
      const response = await fetch('/api/sync/now', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const payload = await readJson<any>(response);

      if (payload.skipped) {
        toast.info(payload.reason ?? 'Synchronisation désactivée');
        setLastAction(payload.message ?? payload.reason ?? null);
      } else if (payload.status === 'error') {
        toast.warning(payload.error ?? 'Synchronisation impossible');
        setLastAction(payload.message ?? payload.error ?? null);
      } else if (payload.status === 'ok') {
        toast.success('Synchronisation effectuée');
        setLastAction(payload.message ?? null);
      } else {
        toast.info(payload.message ?? 'Aucun envoi effectué');
        setLastAction(payload.message ?? null);
      }

      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Synchronisation impossible');
    } finally {
      setIsSyncing(false);
    }
  }, [refresh]);

  const handleTestConnection = useCallback(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    try {
      const response = await fetch('/api/sync/status', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Le service local ne répond pas');

      const payload = (await response.json()) as SyncStatus;

      if (payload.mode === 'off') {
        toast.info('Synchronisation désactivée : rien à tester, l’application travaille en local.');
        setLastAction(
          'Synchronisation désactivée — aucun service distant à tester. L’application reste pleinement utilisable.',
        );
      } else if (!payload.apiUrl?.trim()) {
        toast.warning('Aucune adresse d’API configurée.');
        setLastAction('Aucune adresse d’API configurée dans les paramètres.');
      } else {
        toast.warning(
          'Adresse configurée, mais aucun service de synchronisation n’est déployé : la connexion échoue.',
        );
        setLastAction(
          `Adresse configurée (${payload.apiUrl}) mais aucun service déployé. Utilisez l’export / import manuel.`,
        );
      }
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : 'Test de connexion impossible',
      );
      setLastAction('Le service local n’a pas répondu : l’application reste utilisable hors ligne.');
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setLastReport(null);

    try {
      const response = await fetch('/api/sync/export', {
        method: 'POST',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new Error(await readJson<any>(response).then((p) => p?.error ?? 'Export impossible'));
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `planete-deco-sync-${new Date().toISOString().slice(0, 10)}.json`;

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      toast.success(`Paquet exporté : ${filename}`);
      setLastAction(
        `Paquet « ${filename} » téléchargé. Transportez-le sur clé USB, puis importez-le sur l’autre poste.`,
      );
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Export impossible');
    } finally {
      setIsExporting(false);
    }
  }, [refresh]);

  const handleImport = useCallback(async () => {
    if (!importFile) return;

    setIsImporting(true);
    setLastReport(null);

    try {
      const form = new FormData();
      form.append('file', importFile);

      const response = await fetch(
        `/api/sync/import${importRetryFirst ? '?retryQuarantine=true' : ''}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          body: form,
        },
      );

      const payload = await readJson<ImportReport>(response);
      setLastReport(payload);
      setIsImportOpen(false);
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';

      toast.success(payload.message ?? 'Paquet importé.');
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Import impossible');
    } finally {
      setIsImporting(false);
    }
  }, [importFile, importRetryFirst, refresh]);

  const handleReset = useCallback(async () => {
    setIsResetting(true);

    try {
      const response = await fetch('/api/sync/reset', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const payload = await readJson<any>(response);

      toast.success(
        payload.message ?? 'Watermarks réinitialisés — aucune donnée supprimée.',
      );
      setLastAction(
        `${formatNumber(payload.outboxReset ?? 0)} ligne(s) de la file remises « à envoyer », ${payload.tables?.length ?? 0} watermarks réinitialisés, 0 suppression.`,
      );
      setIsResetOpen(false);
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Réinitialisation impossible');
    } finally {
      setIsResetting(false);
    }
  }, [refresh]);

  const handleDisable = useCallback(async () => {
    setIsDisabling(true);

    try {
      const saved = await updateSettings({ syncMode: 'off' }, { silent: true });
      if (!saved) throw new Error('Le mode n’a pas pu être enregistré');

      toast.success('Synchronisation désactivée : l’application continue en local.');
      setLastAction(
        'Synchronisation désactivée. Aucune donnée n’a été supprimée : la file d’attente et les conflits sont conservés.',
      );
      setIsDisableOpen(false);
      await refreshSettings();
      refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Désactivation impossible');
    } finally {
      setIsDisabling(false);
    }
  }, [refresh, refreshSettings, updateSettings]);

  const handleResolve = useCallback(
    async (conflict: ConflictRow, resolution: 'local' | 'remote') => {
      setIsResolving(conflict.id);

      try {
        const response = await fetch(`/api/sync/conflits/${conflict.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ resolution }),
        });
        const payload = await readJson<any>(response);

        toast.success(payload.message ?? 'Conflit tranché.');
        setIsConflictOpen(false);
        setSelectedConflict(null);
        refresh();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : 'Arbitrage impossible');
      } finally {
        setIsResolving(null);
      }
    },
    [refresh],
  );

  /* ── Colonnes ────────────────────────────────────────────────────── */

  const outboxColumns = useMemo<Column<OutboxRow>[]>(
    () => [
      {
        key: 'tableName',
        label: 'Table',
        primary: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-mono text-xs">{row.tableName}</div>
            <div className="truncate font-mono text-[11px] text-base-content/50">{row.syncId}</div>
          </div>
        ),
      },
      {
        key: 'operation',
        label: 'Opération',
        render: (row) => (
          <Badge
            tone={
              row.operation === 'insert' ? 'success' : row.operation === 'delete' ? 'error' : 'info'
            }
          >
            {row.operation === 'insert'
              ? 'Création'
              : row.operation === 'delete'
                ? 'Suppression'
                : 'Modification'}
          </Badge>
        ),
      },
      {
        key: 'attempts',
        label: 'Essais',
        className: 'text-right whitespace-nowrap',
        render: (row) => (
          <Badge tone={row.attempts >= 5 ? 'error' : row.attempts > 0 ? 'warning' : 'neutral'}>
            {formatNumber(row.attempts)}
          </Badge>
        ),
      },
      {
        key: 'lastAttemptAt',
        label: 'Dernier essai',
        hideOnMobile: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="tabular text-xs text-base-content/70">
            {row.lastAttemptAt ? formatDateTime(row.lastAttemptAt as string) : 'Jamais'}
          </span>
        ),
      },
      {
        key: 'lastError',
        label: 'Dernière erreur',
        hideOnMobile: true,
        render: (row) => (
          <span className="text-xs text-error">{row.lastError || <span className="text-base-content/40">—</span>}</span>
        ),
      },
    ],
    [],
  );

  const conflictColumns = useMemo<Column<ConflictRow>[]>(
    () => [
      {
        key: 'tableName',
        label: 'Table',
        primary: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-mono text-xs">{row.tableName}</div>
            <div className="truncate font-mono text-[11px] text-base-content/50">{row.syncId}</div>
          </div>
        ),
      },
      {
        key: 'resolution',
        label: 'État',
        render: (row) =>
          row.resolution === 'pending' ? (
            <Badge tone="warning">À trancher</Badge>
          ) : row.resolution === 'local' ? (
            <Badge tone="primary">Local conservé</Badge>
          ) : (
            <Badge tone="info">Distant appliqué</Badge>
          ),
      },
      {
        key: 'createdAt',
        label: 'Détecté le',
        hideOnMobile: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="tabular text-xs text-base-content/70">
            {row.createdAt ? formatDateTime(row.createdAt as string) : '—'}
          </span>
        ),
      },
      {
        key: 'resolvedAt',
        label: 'Tranché le',
        hideOnMobile: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="tabular text-xs text-base-content/70">
            {row.resolvedAt ? formatDateTime(row.resolvedAt as string) : '—'}
          </span>
        ),
      },
    ],
    [],
  );

  const deviceColumns = useMemo<Column<DeviceRow>[]>(
    () => [
      {
        key: 'name',
        label: 'Poste',
        primary: true,
        render: (row) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.name}</div>
            <div className="truncate font-mono text-[11px] text-base-content/50">{row.deviceId}</div>
          </div>
        ),
      },
      {
        key: 'current',
        label: 'Ce poste',
        render: (row) =>
          row.isCurrent ? <Badge tone="success">Poste courant</Badge> : <Badge tone="neutral">Distant</Badge>,
      },
      {
        key: 'lastSeenAt',
        label: 'Dernière activité',
        hideOnMobile: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="tabular text-xs text-base-content/70">
            {row.lastSeenAt ? formatDateTime(row.lastSeenAt as string) : '—'}
          </span>
        ),
      },
      {
        key: 'lastPushAt',
        label: 'Dernier envoi',
        hideOnMobile: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="tabular text-xs text-base-content/70">
            {row.lastPushAt ? formatDateTime(row.lastPushAt as string) : 'Jamais'}
          </span>
        ),
      },
      {
        key: 'lastPullAt',
        label: 'Dernière réception',
        hideOnMobile: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="tabular text-xs text-base-content/70">
            {row.lastPullAt ? formatDateTime(row.lastPullAt as string) : 'Jamais'}
          </span>
        ),
      },
    ],
    [],
  );

  const pendingConflicts = conflicts.filter((row) => row.resolution === 'pending');
  const conflictTotalPages = Math.max(1, Math.ceil(conflicts.length / CONFLICTS_LIMIT));
  const visibleConflicts = conflicts.slice(
    (conflictPage - 1) * CONFLICTS_LIMIT,
    conflictPage * CONFLICTS_LIMIT,
  );

  const outboxTotalPages = Math.max(1, Math.ceil((status?.outbox.length ?? 0) / VIEW_LIMIT));
  const visibleOutbox = (status?.outbox ?? []).slice(
    (outboxPage - 1) * VIEW_LIMIT,
    outboxPage * VIEW_LIMIT,
  );

  const mode = status?.mode ?? settings.syncMode;
  const isOff = mode === 'off';

  /* État affiché : Désactivé / Connecté / Hors ligne — toujours avec un libellé. */
  const connectionState = isOff
    ? { label: 'Désactivé', tone: 'neutral' as const, hint: 'L’application travaille en local, sans perte de fonctionnalité.' }
    : status?.online
      ? { label: 'Connecté', tone: 'success' as const, hint: 'Une adresse d’API est configurée.' }
      : { label: 'Hors ligne', tone: 'warning' as const, hint: 'Aucune adresse d’API configurée : rien ne peut être envoyé.' };

  const watermarkRows = (status?.state ?? []).filter((row) => row.key.startsWith('last_pulled_at:'));
  const lastExport = (status?.state ?? []).find((row) => row.key === 'last_export_at');
  const lastImport = (status?.state ?? []).find((row) => row.key === 'last_import_at');

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Administration"
        title="Synchronisation"
        description="Synchronisation PostgreSQL optionnelle, désactivée par défaut. Le poste reste la source de vérité : cet écran montre la file d'attente locale, les conflits et le dépannage par export / import manuel."
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost min-h-11 border border-base-300 sm:min-h-0"
              onClick={() => void handleTestConnection()}
            >
              Tester la connexion
            </button>
            <button
              type="button"
              className="btn btn-primary min-h-11 sm:min-h-0"
              onClick={() => void handleSyncNow()}
              disabled={isSyncing}
            >
              {isSyncing ? <span className="loading loading-spinner loading-sm" /> : 'Synchroniser maintenant'}
            </button>
          </>
        }
      />

      {/* 1 · État */}
      {isLoading && !status ? (
        <SkeletonCards count={6} />
      ) : error ? (
        <ErrorState title="État de synchronisation indisponible" description={error} onRetry={refresh} />
      ) : (
        <>
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">État</h2>
                <Badge tone={connectionState.tone}>{connectionState.label}</Badge>
                <Badge tone={isOff ? 'neutral' : 'info'}>{MODE_LABELS[mode] ?? mode}</Badge>
              </div>
              <span className="text-xs text-base-content/50">
                {isOff ? 'Aucune action requise.' : `Tentative toutes les ${status?.intervalMinutes ?? 15} minutes.`}
              </span>
            </div>

            <p
              className={`rounded-xl border px-3 py-2.5 text-sm ${
                connectionState.tone === 'success'
                  ? 'border-success/30 bg-success/10 text-success'
                  : connectionState.tone === 'warning'
                    ? 'border-warning/30 bg-warning/10 text-warning'
                    : 'border-base-200 bg-base-200/40 text-base-content/70'
              }`}
            >
              {status?.message ?? connectionState.hint}
            </p>

            {lastAction && (
              <p className="rounded-xl border border-info/30 bg-info/10 px-3 py-2.5 text-sm text-info">
                {lastAction}
              </p>
            )}
          </Card>

          {/* 2 · Cartes de synthèse */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            <MiniStat
              label="En attente d’envoi"
              tone={(status?.pending ?? 0) > 0 ? 'warning' : 'success'}
              value={formatNumber(status?.pending ?? 0)}
            />
            <MiniStat
              label="En échec (≥ 5 essais)"
              tone={(status?.failed ?? 0) > 0 ? 'error' : 'neutral'}
              value={formatNumber(status?.failed ?? 0)}
            />
            <MiniStat
              label="En quarantaine"
              tone={(status?.pendingQuarantine ?? 0) > 0 ? 'warning' : 'neutral'}
              value={formatNumber(status?.pendingQuarantine ?? 0)}
            />
            <MiniStat
              label="Conflits à trancher"
              tone={pendingConflicts.length > 0 ? 'error' : 'success'}
              value={formatNumber(pendingConflicts.length)}
            />
            <MiniStat
              label="Dernière synchronisation"
              tone="neutral"
              value={
                status?.lastSyncAt ? (
                  <span className="tabular text-xs">{formatDateTime(status.lastSyncAt)}</span>
                ) : (
                  <span className="text-xs">Jamais</span>
                )
              }
            />
            <MiniStat
              label="Postes connus"
              value={formatNumber(status?.devices.length ?? 0)}
              tone="neutral"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* 3 · Dernière synchronisation, par table */}
            <Card className="lg:col-span-2 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Dernière synchronisation</h2>
                <span className="text-xs text-base-content/50">
                  Watermarks par table (<code>sync_state</code>)
                </span>
              </div>

              <div className="divide-y divide-base-200/70">
                <InfoRow label="Appareil">
                  <span className="font-mono text-xs">{status?.deviceId ?? '—'}</span>
                </InfoRow>
                <InfoRow label="Nom du poste">{status?.deviceName ?? '—'}</InfoRow>
                <InfoRow label="Adresse d’API">
                  {status?.apiUrl?.trim() ? (
                    <span className="font-mono text-xs">{status.apiUrl}</span>
                  ) : (
                    <span className="font-normal text-base-content/50">Non configurée</span>
                  )}
                </InfoRow>
                <InfoRow label="Lignes envoyées / reçues">
                  <span className="tabular">
                    {formatNumber(status?.pending ?? 0)} en attente · {formatNumber(status?.pendingQuarantine ?? 0)} en quarantaine
                  </span>
                </InfoRow>
                <InfoRow label="Durée du dernier envoi">
                  <span className="font-normal text-base-content/50">
                    Non mesurable : aucun service distant n’est déployé.
                  </span>
                </InfoRow>
                <InfoRow label="Dernière erreur">
                  {status?.lastSyncError ? (
                    <span className="text-error">{status.lastSyncError}</span>
                  ) : (
                    <span className="font-normal text-base-content/50">Aucune</span>
                  )}
                </InfoRow>
                <InfoRow label="Dernier export manuel">
                  {lastExport?.value ? formatDateTime(lastExport.value) : 'Jamais'}
                </InfoRow>
                <InfoRow label="Dernier import manuel">
                  {lastImport?.value ? formatDateTime(lastImport.value) : 'Jamais'}
                </InfoRow>
              </div>

              {watermarkRows.length === 0 ? (
                <p className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2.5 text-xs text-base-content/60">
                  Aucun watermark enregistré : rien n’a encore été reçu depuis un service distant. C’est normal
                  tant que la synchronisation n’est pas déployée.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {watermarkRows.slice(0, 12).map((row) => (
                    <li
                      key={row.key}
                      className="rounded-lg border border-base-200 bg-base-200/40 px-2.5 py-1 font-mono text-[11px] text-base-content/70"
                    >
                      {row.key.replace('last_pulled_at:', '')} : {row.value ?? 'jamais'}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* 4 · Actions */}
            <Card className="space-y-3">
              <h2 className="text-base font-semibold">Actions</h2>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="btn btn-primary min-h-11 justify-start sm:min-h-0"
                  onClick={() => void handleSyncNow()}
                  disabled={isSyncing}
                >
                  {isSyncing ? <span className="loading loading-spinner loading-sm" /> : 'Synchroniser maintenant'}
                </button>

                <button
                  type="button"
                  className="btn btn-ghost min-h-11 justify-start border border-base-300 sm:min-h-0"
                  onClick={() => void handleTestConnection()}
                >
                  Tester la connexion
                </button>

                <button
                  type="button"
                  className="btn btn-ghost min-h-11 justify-start border border-base-300 sm:min-h-0"
                  onClick={() => setIsResetOpen(true)}
                  disabled={isResetting}
                >
                  Renvoyer tout
                </button>

                <button
                  type="button"
                  className="btn btn-ghost min-h-11 justify-start border border-base-300 sm:min-h-0"
                  onClick={() => setIsDisableOpen(true)}
                  disabled={isOff || isDisabling}
                >
                  Désactiver la synchronisation
                </button>
              </div>

              <p className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2.5 text-xs text-base-content/60">
                « Renvoyer tout » réinitialise les watermarks et remet les compteurs d’essais à zéro.
                <strong> Rien n’est supprimé</strong> : ni les données, ni la file d’attente, ni les conflits
                déjà tranchés.
              </p>
            </Card>
          </div>

          {/* 5 · File d'attente */}
          <PageSection
            title="File d’attente locale"
            subtitle="Chaque écriture d’une table synchronisée dépose une ligne dans sync_outbox. La file ne bloque jamais une opération métier."
          >
            {status && status.outbox.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucun élément en attente"
                  description="La file d’envoi est vide : soit rien n’a encore été écrit, soit tout a été traité. Elle se remplit automatiquement à chaque création, modification ou annulation."
                  action={
                    <button type="button" className="btn btn-primary min-h-11" onClick={refresh}>
                      Actualiser
                    </button>
                  }
                />
              </div>
            ) : (
              <>
                <ResponsiveTable
                  columns={outboxColumns}
                  data={visibleOutbox}
                  getRowKey={(row) => row.id}
                  tableClassName="table-sm"
                />
                <Pagination currentPage={outboxPage} totalPages={outboxTotalPages} onPageChange={setOutboxPage} />
                <p className="text-center text-xs text-base-content/50">
                  {formatNumber(status?.outbox.length ?? 0)} ligne(s) dans la file · page {outboxPage} sur{' '}
                  {outboxTotalPages}
                </p>
              </>
            )}

            {status && status.pendingPreview.length > 0 && (
              <Card className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">Quarantaine — référence parente manquante</h3>
                  <Badge tone="warning">{formatNumber(status.pendingQuarantine)}</Badge>
                </div>
                <p className="text-xs text-base-content/60">
                  Ces lignes ne sont pas perdues : elles seront rejouées dès que leur parent arrivera, ou
                  immédiatement après un import manuel.
                </p>
                <ul className="divide-y divide-base-200">
                  {status.pendingPreview.slice(0, QUARANTINE_LIMIT).map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="block font-mono text-xs">{row.tableName}</span>
                        <span className="block font-mono text-[11px] text-base-content/50">{row.syncId}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">Parent : {row.missingParent ?? 'inconnu'}</Badge>
                        <span className="text-xs text-base-content/50">{formatNumber(row.attempts)} essai(s)</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </PageSection>

          {/* 6 · Journal local des lots */}
          <PageSection
            title="Journal des envois"
            subtitle="Historique local des tentatives. Le service en ligne n’étant pas déployé, aucune ligne « envoyée » ne peut exister : l’écran ne prétend donc jamais qu’un lot est parti."
          >
            {status && status.outbox.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucun lot dans le journal"
                  description="Aucun lot n’a été constitué. Les écritures alimenteront la file d’attente et apparaîtront ici avec leur nombre d’essais et leur dernière erreur."
                />
              </div>
            ) : (
              <Card className="space-y-3">
                <div className="divide-y divide-base-200/70">
                  <InfoRow label="Dernier lot tenté">
                    {status?.lastSyncAt ? (
                      <span className="tabular">{formatDateTime(status.lastSyncAt)}</span>
                    ) : (
                      <span className="font-normal text-base-content/50">Aucun lot envoyé</span>
                    )}
                  </InfoRow>
                  <InfoRow label="Dernier résultat">
                    {status?.lastSyncError ? (
                      <span className="text-error">Échec — {status.lastSyncError}</span>
                    ) : (
                      <span className="font-normal text-base-content/50">Aucun envoi tenté</span>
                    )}
                  </InfoRow>
                  <InfoRow label="Lots réussis">
                    <span className="tabular">0</span>
                  </InfoRow>
                  <InfoRow label="Lignes en attente dans les lots">
                    <span className="tabular">{formatNumber(status?.outbox.length ?? 0)}</span>
                  </InfoRow>
                </div>

                <p className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2.5 text-xs text-base-content/60">
                  Chaque ligne ci-dessous est une écriture locale en attente, avec son nombre d’essais et sa
                  dernière erreur. Tant qu’aucun serveur n’est déployé, le journal ne peut contenir que des
                  tentatives — jamais un envoi réussi.
                </p>
              </Card>
            )}
          </PageSection>

          {/* 7 · Conflits */}          <PageSection
            title="Conflits à trancher"
            subtitle="Aucune écriture n’est écrasée sans arbitrage : la granularité est la ligne entière (README §23.7 et §23.12)."
          >
            {conflictsLoading ? (
              <SkeletonTable rows={3} cols={4} />
            ) : conflictsError ? (
              <ErrorState title="Conflits indisponibles" description={conflictsError} onRetry={refresh} />
            ) : conflicts.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucun conflit"
                  description="Aucune divergence n’a été détectée. Un conflit ne peut apparaître qu’après une réception de données modifiées localement — l’import manuel d’un paquet est le seul chemin possible aujourd’hui."
                  action={
                    <button type="button" className="btn btn-primary min-h-11" onClick={refresh}>
                      Actualiser
                    </button>
                  }
                />
              </div>
            ) : (
              <>
                <ResponsiveTable
                  columns={conflictColumns}
                  data={visibleConflicts}
                  getRowKey={(row) => row.id}
                  tableClassName="table-sm"
                  actions={(row) => (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm min-h-11 sm:min-h-0"
                      onClick={() => {
                        setSelectedConflict(row);
                        setIsConflictOpen(true);
                      }}
                    >
                      Comparer et trancher
                    </button>
                  )}
                />
                <Pagination
                  currentPage={conflictPage}
                  totalPages={conflictTotalPages}
                  onPageChange={setConflictPage}
                />
                <p className="text-center text-xs text-base-content/50">
                  {formatNumber(pendingConflicts.length)} conflit(s) en attente · {formatNumber(conflicts.length)}{' '}
                  au total
                </p>
              </>
            )}
          </PageSection>

          {/* 7 · Appareils */}
          <PageSection
            title="Appareils connus"
            subtitle="Postes enregistrés dans devices. Le poste courant est celui du navigateur utilisé."
          >
            {status && status.devices.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucun appareil enregistré"
                  description="Le poste courant s’enregistre dès que cet écran est consulté. Aucun autre poste ne s’est encore manifesté."
                />
              </div>
            ) : (
              <ResponsiveTable
                columns={deviceColumns}
                data={status?.devices ?? []}
                getRowKey={(row) => row.deviceId}
                tableClassName="table-sm"
              />
            )}
          </PageSection>

          {/* 8 · Dépannage sans réseau */}
          <PageSection
            title="Dépannage sans réseau — export / import manuel"
            subtitle="On exporte un paquet .json sur ce poste, on le transporte sur clé USB, on l’importe ailleurs. C’est la seule synchronisation réellement disponible tant que le service en ligne n’est pas déployé."
          >
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="space-y-3">
                <h3 className="text-sm font-semibold">1 — Exporter le paquet</h3>
                <p className="text-sm text-base-content/60">
                  Le fichier contient les 30 tables métier dans l’ordre topologique, avec leurs identifiants
                  globaux (<code>sync_id</code>), leur horodatage et leurs tombstones. Les identifiants locaux
                  (<code>id</code>) ne sont pas transportés : ils diffèrent d’un poste à l’autre.
                </p>
                <button
                  type="button"
                  className="btn btn-primary min-h-11 sm:min-h-0"
                  onClick={() => void handleExport()}
                  disabled={isExporting}
                >
                  {isExporting ? (
                    <span className="loading loading-spinner loading-sm" />
                  ) : (
                    'Exporter le paquet (.json)'
                  )}
                </button>
              </Card>

              <Card className="space-y-3">
                <h3 className="text-sm font-semibold">2 — Importer un paquet</h3>
                <p className="text-sm text-base-content/60">
                  Le paquet est validé (marqueur, version, tables connues) avant toute écriture. Une référence
                  parente manquante met la ligne en quarantaine au lieu de la perdre, et un conflit réel crée un
                  arbitrage au lieu d’écraser la donnée locale.
                </p>
                <button
                  type="button"
                  className="btn btn-primary min-h-11 sm:min-h-0"
                  onClick={() => {
                    setImportFile(null);
                    setImportRetryFirst(true);
                    setIsImportOpen(true);
                  }}
                >
                  Importer un paquet (.json)
                </button>

                {lastReport && (
                  <div className="space-y-2 rounded-xl border border-base-200 bg-base-200/40 p-3">
                    <p className="text-sm font-medium">Dernier import</p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <MiniStat label="Ajoutées" tone="success" value={formatNumber(lastReport.rowsInserted)} />
                      <MiniStat label="Mises à jour" tone="info" value={formatNumber(lastReport.rowsUpdated)} />
                      <MiniStat
                        label="Quarantaine"
                        tone={lastReport.quarantined > 0 ? 'warning' : 'neutral'}
                        value={formatNumber(lastReport.quarantined)}
                      />
                      <MiniStat
                        label="Conflits"
                        tone={lastReport.conflicts > 0 ? 'error' : 'success'}
                        value={formatNumber(lastReport.conflicts)}
                      />
                    </div>
                    {lastReport.errors.length > 0 && (
                      <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-error">
                        {lastReport.errors.slice(0, 8).map((message, index) => (
                          <li key={index}>{message}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </Card>
            </div>

            {lastExport?.value && (
              <p className="text-xs text-base-content/50">
                Dernier export : {formatDateShort(lastExport.value)}. Conservez le fichier : il n’est pas
                rejouable automatiquement.
              </p>
            )}
          </PageSection>
        </>
      )}

      {/* Modale : « Renvoyer tout » */}
      <ConfirmDialog
        isOpen={isResetOpen}
        onClose={() => {
          if (!isResetting) setIsResetOpen(false);
        }}
        onConfirm={() => void handleReset()}
        title="Renvoyer tout"
        tone="warning"
        confirmLabel="Réinitialiser les watermarks"
        isSubmitting={isResetting}
        message={
          <>
            Les watermarks de réception repassent à « jamais reçu » et les compteurs d’essais de la file
            repassent à zéro.
            <br />
            <span className="text-sm">
              <strong>Aucune donnée n’est supprimée</strong> : ni les 30 tables métier, ni une seule ligne de la
              file d’envoi, ni les conflits déjà tranchés. Il s’agit de « tout remettre à envoyer », pas
              d’effacer.
            </span>
          </>
        }
      />

      {/* Modale : désactivation */}
      <ConfirmDialog
        isOpen={isDisableOpen}
        onClose={() => {
          if (!isDisabling) setIsDisableOpen(false);
        }}
        onConfirm={() => void handleDisable()}
        title="Désactiver la synchronisation"
        tone="warning"
        confirmLabel="Désactiver"
        isSubmitting={isDisabling}
        message={
          <>
            Le mode passera à « Désactivée ». L’application reste <strong>pleinement utilisable</strong> : la
            synchronisation n’est jamais un prérequis.
            <br />
            <span className="text-sm">
              La file d’attente, la quarantaine et les conflits sont conservés : rien n’est perdu, et tout
              repartira si la synchronisation est réactivée.
            </span>
          </>
        }
      />

      {/* Modale : import d'un paquet */}
      <ModalImport
        isOpen={isImportOpen}
        onClose={() => {
          if (!isImporting) setIsImportOpen(false);
        }}
        file={importFile}
        onFileChange={setImportFile}
        retryFirst={importRetryFirst}
        onRetryFirstChange={setImportRetryFirst}
        isSubmitting={isImporting}
        onConfirm={() => void handleImport()}
        inputRef={fileInputRef}
      />

      {/* Modale : comparaison et arbitrage d'un conflit */}
      <ModalConflict
        isOpen={isConflictOpen}
        onClose={() => {
          if (isResolving === null) setIsConflictOpen(false);
        }}
        conflict={selectedConflict}
        isSubmitting={isResolving !== null}
        onResolve={(resolution) => {
          if (selectedConflict) void handleResolve(selectedConflict, resolution);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Modale d'import — isolée pour garder la page lisible
 * ------------------------------------------------------------------ */

function ModalImport({
  isOpen,
  onClose,
  file,
  onFileChange,
  retryFirst,
  onRetryFirstChange,
  isSubmitting,
  onConfirm,
  inputRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  file: File | null;
  onFileChange: (file: File | null) => void;
  retryFirst: boolean;
  onRetryFirstChange: (value: boolean) => void;
  isSubmitting: boolean;
  onConfirm: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Importer un paquet de synchronisation"
      size="lg"
      fullScreenMobile
    >
      <div className="space-y-4 pb-2">
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-3 py-2.5 text-sm text-base-content/70">
          Sélectionnez un fichier <code>.json</code> produit par « Exporter le paquet ». La structure est
          validée avant toute écriture ; les identifiants globaux (<code>sync_id</code>) font foi.
        </p>

        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <span className="sr-only">Fichier de paquet</span>
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="file-input file-input-bordered min-h-11 w-full sm:min-h-0"
            onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
            disabled={isSubmitting}
          />
        </label>

        {file && (
          <p className="text-xs text-base-content/60">
            Fichier sélectionné : <strong>{file.name}</strong> ({formatNumber(Math.round(file.size / 1024))} Ko)
          </p>
        )}

        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={retryFirst}
            onChange={(event) => onRetryFirstChange(event.target.checked)}
            disabled={isSubmitting}
          />
          <span className="text-sm">
            Rejouer d’abord la quarantaine locale
            <span className="block text-xs text-base-content/50">
              Les lignes dont le parent vient d’arriver sont appliquées avant l’import : un enfant bloqué est
              débloqué sans redemander le fichier.
            </span>
          </span>
        </label>

        <div className="sticky bottom-0 flex justify-end gap-3 border-t border-base-200 bg-base-100 pb-1 pt-4">
          <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn-primary min-h-11 sm:min-h-0"
            onClick={onConfirm}
            disabled={isSubmitting || !file}
          >
            {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : 'Importer le paquet'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Modale de conflit — comparaison local / distant lisible
 * ------------------------------------------------------------------ */

function ModalConflict({
  isOpen,
  onClose,
  conflict,
  isSubmitting,
  onResolve,
}: {
  isOpen: boolean;
  onClose: () => void;
  conflict: ConflictRow | null;
  isSubmitting: boolean;
  onResolve: (resolution: 'local' | 'remote') => void;
}) {
  const localFields = conflict ? payloadSummary(conflict.localPayload) : [];
  const remoteFields = conflict ? payloadSummary(conflict.remotePayload) : [];

  const keys = Array.from(new Set([...localFields.map((f) => f.label), ...remoteFields.map((f) => f.label)]));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Conflit — ${conflict?.tableName ?? ''}`}
      size="xl"
      fullScreenMobile
    >
      <div className="space-y-4 pb-2">
        {conflict && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="warning">À trancher</Badge>
              <span className="font-mono text-xs text-base-content/60">{conflict.syncId}</span>
            </div>

            <p className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
              La ligne a été modifiée <strong>localement</strong> et figure aussi dans le paquet reçu. Aucune
              version n’a été écrasée : choisissez celle qui fait foi. La version perdante reste archivée ici.
            </p>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Card className="space-y-2">
                <h3 className="text-sm font-semibold">Version locale (ce poste)</h3>
                <div className="divide-y divide-base-200/70">
                  {localFields.length === 0 ? (
                    <p className="py-2 text-sm text-base-content/50">Charge utile illisible.</p>
                  ) : (
                    localFields.map((field) => (
                      <InfoRow key={field.label} label={field.label}>
                        <span className="font-normal break-words">{field.value}</span>
                      </InfoRow>
                    ))
                  )}
                </div>
              </Card>

              <Card className="space-y-2">
                <h3 className="text-sm font-semibold">Version reçue (distante)</h3>
                <div className="divide-y divide-base-200/70">
                  {remoteFields.length === 0 ? (
                    <p className="py-2 text-sm text-base-content/50">Charge utile illisible.</p>
                  ) : (
                    remoteFields.map((field) => (
                      <InfoRow key={field.label} label={field.label}>
                        <span className="font-normal break-words">{field.value}</span>
                      </InfoRow>
                    ))
                  )}
                </div>
              </Card>
            </div>

            {keys.length > 0 && (
              <p className="text-xs text-base-content/50">
                La comparaison porte sur la <strong>ligne entière</strong> : deux postes qui modifient deux
                champs différents de la même ligne produisent bien un conflit (§23.12).
              </p>
            )}
          </>
        )}

        <div className="sticky bottom-0 flex flex-wrap justify-end gap-3 border-t border-base-200 bg-base-100 pb-1 pt-4">
          <button type="button" className="btn btn-ghost min-h-11 sm:min-h-0" onClick={onClose} disabled={isSubmitting}>
            Fermer
          </button>
          <button
            type="button"
            className="btn btn-outline min-h-11 sm:min-h-0"
            onClick={() => onResolve('local')}
            disabled={isSubmitting || conflict?.resolution !== 'pending'}
          >
            Garder la version locale
          </button>
          <button
            type="button"
            className="btn btn-primary min-h-11 sm:min-h-0"
            onClick={() => onResolve('remote')}
            disabled={isSubmitting || conflict?.resolution !== 'pending'}
          >
            {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : 'Garder la version distante'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
