'use client';

/**
 * Écran `/synchronisation` — multi-magasins, option B (README §23).
 *
 * Chaque poste garde sa propre base SQLite (source de vérité locale) ; le
 * serveur central ne fait que relayer les changements entre postes. Cet écran
 * montre l'état **réel** du poste et propose les seules actions qui existent :
 *  - inscrire un poste autonome (siège : clé maîtresse ; magasin : code) ;
 *  - synchroniser maintenant, déconnecter ;
 *  - au siège : générer les codes d'inscription des magasins, voir et révoquer
 *    les postes connectés ;
 *  - arbitrer les conflits, consulter la quarantaine.
 *
 * ⚠️ Aucun import runtime d'un module serveur (`lib/sync-engine.ts`,
 * `lib/device.ts` importent `@/db`) : uniquement des `import type`.
 *
 * `GET /api/sync/status` renvoie un **résumé** aux utilisateurs sans
 * `sync.manage` (pas de bloc `device`) : l'écran se réduit alors à l'état.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Badge,
  Card,
  ErrorState,
  FormField,
  InfoRow,
  MiniStat,
  PageSection,
  SkeletonCards,
  type BadgeTone,
} from '@/components/design-system';
import { useAuth } from '@/components/auth-provider';
import { formatDateTime } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';
import type { SyncResult, SyncStatus } from '@/lib/sync-engine';
import type { DeviceMode } from '@/lib/device';

/* ------------------------------------------------------------------ *
 * Types — miroir des routes `app/api/sync/**`
 * ------------------------------------------------------------------ */

type ConflictRow = {
  id: number;
  tableName: string;
  syncId: string;
  localPayload: Record<string, unknown> | null;
  remotePayload: Record<string, unknown> | null;
  resolution: string;
  createdAt: string | null;
};

type QuarantineRow = {
  id: number;
  tableName: string;
  syncId: string;
  missingParent: string | null;
  attempts: number;
  createdAt: string | null;
};

/** Résumé renvoyé à tout utilisateur connecté. */
type StatusSummary = {
  mode: DeviceMode;
  connected: boolean;
  pending: number;
  conflicts: number;
  lastSuccessAt: string | null;
  hasError: boolean;
};

/** Détail réservé à `sync.manage`. */
type StatusFull = SyncStatus &
  StatusSummary & {
    conflictsList: ConflictRow[];
    quarantineList: QuarantineRow[];
  };

type StatusResponse = StatusSummary | StatusFull;

function isFull(status: StatusResponse | null): status is StatusFull {
  return Boolean(status && 'device' in status);
}

/** Poste tel que listé par le serveur central (`GET /api/admin/devices`). */
type ServerDevice = {
  id: string;
  name: string;
  mode: 'hq' | 'store';
  storeSyncId: string | null;
  storeName: string | null;
  deviceCode: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
  revokedAt: string | null;
  isCurrent: boolean;
};

type StoreOption = { id: number; syncId: string; code: string; name: string; kind: string; status: string };

type EnrollKind = 'hq' | 'store';

/* ------------------------------------------------------------------ *
 * Libellés
 * ------------------------------------------------------------------ */

const MODE_LABELS: Record<DeviceMode, string> = {
  standalone: 'Autonome',
  hq: 'Siège',
  store: 'Magasin',
};

const MODE_TONES: Record<DeviceMode, BadgeTone> = {
  standalone: 'neutral',
  hq: 'primary',
  store: 'info',
};

/** Tables synchronisées → libellé lisible (les noms techniques restent en repli). */
const TABLE_LABELS: Record<string, string> = {
  stores: 'Magasins',
  users: 'Utilisateurs',
  settings: 'Paramètres',
  categories: 'Catégories',
  products: 'Produits',
  product_store_stock: 'Stock par magasin',
  store_prices: 'Prix locaux',
  customers: 'Clients',
  suppliers: 'Fournisseurs',
  sales_invoices: 'Ventes',
  sales_invoice_items: 'Lignes de vente',
  purchase_invoices: 'Achats',
  purchase_invoice_items: 'Lignes d’achat',
  payments: 'Paiements',
  expenses: 'Dépenses',
  stock_movements: 'Mouvements de stock',
  stock_transfers: 'Transferts',
  stock_transfer_items: 'Lignes de transfert',
  inventories: 'Inventaires',
  inventory_items: 'Lignes d’inventaire',
  cash_sessions: 'Sessions de caisse',
  cash_movements: 'Mouvements de caisse',
  workers: 'Ouvriers',
  service_jobs: 'Chantiers',
};

function tableLabel(name: string): string {
  return TABLE_LABELS[name] ?? name;
}

/** Champs techniques ignorés dans la comparaison local / serveur. */
const TECHNICAL_FIELDS = new Set(['id', 'sync_id', 'syncId', 'updated_at', 'updatedAt', 'created_at', 'createdAt']);

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Champs qui diffèrent entre la version locale et celle du serveur. */
function diffFields(local: unknown, remote: unknown): { key: string; local: string; remote: string }[] {
  const l = (local && typeof local === 'object' ? local : {}) as Record<string, unknown>;
  const r = (remote && typeof remote === 'object' ? remote : {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(l), ...Object.keys(r)])).filter((k) => !TECHNICAL_FIELDS.has(k));
  return keys
    .filter((k) => JSON.stringify(l[k] ?? null) !== JSON.stringify(r[k] ?? null))
    .map((k) => ({ key: k, local: formatValue(l[k]), remote: formatValue(r[k]) }));
}

/** Désignation lisible d'un enregistrement (nom, référence…) quand le contenu en porte une. */
function recordLabel(row: ConflictRow): string {
  const source = (row.localPayload ?? row.remotePayload ?? {}) as Record<string, unknown>;
  for (const key of ['name', 'reference', 'invoice_number', 'receipt_number', 'username', 'code', 'key']) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return row.syncId.slice(0, 8);
}

async function readError(res: Response, fallback: string): Promise<string> {
  const payload = await res.json().catch(() => ({}));
  return (payload as { error?: string })?.error ?? fallback;
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function SynchronisationPage() {
  const { can, stores: authStores, permissions, isLoading: authLoading } = useAuth();
  const canManage = can('sync.manage');
  const canManageStores = can('stores.manage');
  const canViewStores = can('stores.view');

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const [storeOptions, setStoreOptions] = useState<StoreOption[]>([]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sync/status', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(await readError(res, 'Chargement de l’état impossible'));
      setStatus((await res.json()) as StatusResponse);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Chargement de l’état impossible');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    // Un cycle automatique peut tourner en arrière-plan : on rafraîchit l'état.
    const timer = setInterval(() => void loadStatus(), 30_000);
    return () => clearInterval(timer);
  }, [loadStatus]);

  const mode: DeviceMode = status?.mode ?? 'standalone';
  const linked = Boolean(status && status.mode !== 'standalone' && status.connected);

  // Magasins : nom du magasin du poste et choix du magasin pour un code.
  useEffect(() => {
    if (authLoading || permissions === null || !canViewStores || mode === 'standalone') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/magasins', { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) return;
        const payload = await res.json();
        if (!cancelled) setStoreOptions(Array.isArray(payload.data) ? payload.data : []);
      } catch {
        /* le nom du magasin restera « — » */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, permissions, canViewStores, mode]);

  const deviceStoreName = useMemo(() => {
    if (!isFull(status)) return null;
    const { storeId, storeSyncId } = status.device;
    const byId = storeId ? authStores.find((s) => s.id === storeId) : null;
    if (byId) return byId.name;
    const bySync = storeSyncId ? storeOptions.find((s) => s.syncId === storeSyncId) : null;
    return bySync?.name ?? null;
  }, [status, authStores, storeOptions]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/sync/now', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) throw new Error(await readError(res, 'Synchronisation impossible'));
      const result = (await res.json()) as SyncResult;
      setLastResult(result);
      if (result.ok) {
        toast.success(
          `Synchronisation terminée : ${formatNumber(result.sent)} envoyé(s), ${formatNumber(result.received)} reçu(s)`,
        );
      } else {
        toast.error(result.error ?? 'Synchronisation impossible', { autoClose: 10000 });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Synchronisation impossible', { autoClose: 10000 });
    } finally {
      setSyncing(false);
      void loadStatus();
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Administration" title="Synchronisation" description="État de la liaison de ce poste avec le serveur central." />
        <SkeletonCards count={4} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Synchronisation"
        description="Chaque poste travaille sur sa propre base, même sans Internet ; le serveur central échange les opérations entre le siège et les magasins."
        actions={
          linked ? (
            <button type="button" className="btn btn-primary" disabled={syncing} onClick={() => void syncNow()}>
              {syncing ? <span className="loading loading-spinner loading-sm" /> : 'Synchroniser maintenant'}
            </button>
          ) : undefined
        }
      />

      {loadError && !status ? (
        <Card>
          <ErrorState title="État de la synchronisation indisponible" description={loadError} onRetry={() => void loadStatus()} />
        </Card>
      ) : (
        <>
          <DeviceCard status={status} storeName={deviceStoreName} lastResult={lastResult} />

          {!canManage && (
            <div className="alert border border-info/30 bg-info/10 text-sm">
              <span>
                La configuration de la synchronisation (inscription du poste, conflits, postes connectés) est réservée
                aux comptes disposant du droit <strong>« Gérer la synchronisation »</strong>.
              </span>
            </div>
          )}

          {canManage && isFull(status) && (
            <>
              {mode === 'standalone' && <EnrollSection onEnrolled={() => void loadStatus()} />}

              {mode !== 'standalone' && (
                <UnenrollSection mode={mode} pending={status.pending} onDone={() => void loadStatus()} />
              )}

              {mode === 'hq' && linked && (
                <>
                  {canManageStores && <EnrollmentCodesSection stores={storeOptions} />}
                  <ServerDevicesSection />
                </>
              )}

              <ConflictsSection conflicts={status.conflictsList ?? []} onResolved={() => void loadStatus()} />
              <QuarantineSection rows={status.quarantineList ?? []} total={status.quarantined} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 1. Carte « Ce poste »
 * ------------------------------------------------------------------ */

function DeviceCard({
  status,
  storeName,
  lastResult,
}: {
  status: StatusResponse | null;
  storeName: string | null;
  lastResult: SyncResult | null;
}) {
  if (!status) return null;
  const mode = status.mode;
  const full = isFull(status) ? status : null;
  const linked = mode !== 'standalone' && status.connected;

  return (
    <PageSection title="Ce poste">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={MODE_TONES[mode]}>{MODE_LABELS[mode]}</Badge>
          {mode === 'store' && storeName && <span className="text-sm font-medium">{storeName}</span>}
          {mode !== 'standalone' && (
            <Badge tone={linked ? (status.hasError ? 'warning' : 'success') : 'error'}>
              {linked ? (status.hasError ? 'Hors ligne' : 'Relié au serveur') : 'Liaison incomplète'}
            </Badge>
          )}
        </div>

        {mode === 'standalone' && (
          <p className="mt-3 text-sm text-base-content/60">
            Ce poste fonctionne seul : toutes les opérations restent sur cet ordinateur. Reliez-le au serveur central
            pour partager le catalogue et les opérations entre le siège et les magasins.
          </p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MiniStat label="Changements en attente" value={formatNumber(status.pending)} tone={status.pending > 0 ? 'warning' : 'neutral'} />
          {full && (
            <MiniStat label="En quarantaine" value={formatNumber(full.quarantined)} tone={full.quarantined > 0 ? 'warning' : 'neutral'} />
          )}
          <MiniStat label="Conflits" value={formatNumber(status.conflicts)} tone={status.conflicts > 0 ? 'error' : 'neutral'} />
          <MiniStat label="Dernier échange réussi" value={status.lastSuccessAt ? formatDateTime(status.lastSuccessAt) : 'Jamais'} />
        </div>

        {full && (
          <div className="mt-4 grid gap-x-8 border-t border-base-200 pt-3 sm:grid-cols-2">
            <InfoRow label="Mode">
              {MODE_LABELS[mode]}
              {mode === 'store' && storeName ? ` — ${storeName}` : ''}
            </InfoRow>
            <InfoRow label="Nom du poste">{full.device.deviceName ?? '—'}</InfoRow>
            <InfoRow label="Code poste">{full.device.deviceCode ?? '—'}</InfoRow>
            <InfoRow label="Adresse du serveur">
              <span className="break-all font-mono text-xs">{full.device.serverUrl ?? '—'}</span>
            </InfoRow>
            <InfoRow label="Dernier envoi">{full.lastPushAt ? formatDateTime(full.lastPushAt) : '—'}</InfoRow>
            <InfoRow label="Dernière réception">{full.lastPullAt ? formatDateTime(full.lastPullAt) : '—'}</InfoRow>
            {full.failed > 0 && (
              <InfoRow label="Envois en échec (réessayés)">{formatNumber(full.failed)}</InfoRow>
            )}
            {full.running && <InfoRow label="Cycle en cours">Oui</InfoRow>}
          </div>
        )}

        {full?.lastError ? (
          <div className="mt-4 rounded-xl border border-error/30 bg-error/10 p-3 text-sm">
            <strong>Dernière erreur :</strong> {full.lastError}
            <p className="mt-1 text-xs text-base-content/60">
              Les opérations restent enregistrées sur ce poste et partiront au prochain échange réussi.
            </p>
          </div>
        ) : !full && status.hasError ? (
          <div className="mt-4 rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm">
            Le dernier échange avec le serveur a échoué. Les opérations restent enregistrées sur ce poste.
          </div>
        ) : null}

        {lastResult && (
          <div
            className={`mt-4 rounded-xl border p-3 text-sm ${
              lastResult.ok ? 'border-success/30 bg-success/10' : 'border-error/30 bg-error/10'
            }`}
          >
            {lastResult.ok ? (
              <>
                <strong>Synchronisation réussie</strong> ({formatDateTime(lastResult.at)}) :{' '}
                {formatNumber(lastResult.sent)} envoyé(s), {formatNumber(lastResult.received)} reçu(s),{' '}
                {formatNumber(lastResult.applied)} appliqué(s)
                {lastResult.rejected > 0 ? `, ${formatNumber(lastResult.rejected)} refusé(s) par le serveur` : ''}.
              </>
            ) : (
              <>
                <strong>Échec de la synchronisation :</strong> {lastResult.error ?? 'erreur inconnue'}
              </>
            )}
          </div>
        )}
      </Card>
    </PageSection>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Inscription d'un poste autonome
 * ------------------------------------------------------------------ */

function EnrollSection({ onEnrolled }: { onEnrolled: () => void }) {
  const { refreshUser } = useAuth();
  const [serverUrl, setServerUrl] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [kind, setKind] = useState<EnrollKind>('hq');
  const [secret, setSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!/^https?:\/\//i.test(serverUrl.trim())) {
      setError('Saisissez l’adresse complète du serveur, par exemple https://sync.exemple.com');
      return;
    }
    if (!secret.trim()) {
      setError(kind === 'hq' ? 'Saisissez la clé maîtresse du serveur' : 'Saisissez le code d’inscription');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/sync/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          serverUrl: serverUrl.trim(),
          deviceName: deviceName.trim(),
          ...(kind === 'hq' ? { masterKey: secret.trim() } : { code: secret.trim() }),
        }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Inscription impossible'));
      const payload = (await res.json()) as { firstSync?: SyncResult };
      toast.success('Poste relié au serveur central');
      if (payload.firstSync && !payload.firstSync.ok) {
        toast.warning(
          `Premier échange non abouti : ${payload.firstSync.error ?? 'erreur inconnue'}. Il sera retenté automatiquement.`,
          { autoClose: 10000 },
        );
      }
      setSecret('');
      await refreshUser();
      onEnrolled();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inscription impossible');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageSection
      title="Relier ce poste au serveur central"
      subtitle="Une fois relié, ce poste envoie et reçoit les opérations automatiquement dès qu’Internet est disponible."
    >
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Adresse du serveur" required hint="Fournie par la personne qui a installé le serveur central.">
            <input
              className="input input-bordered field-rounded w-full"
              placeholder="https://sync.exemple.com"
              value={serverUrl}
              disabled={submitting}
              onChange={(e) => setServerUrl(e.target.value)}
            />
          </FormField>
          <FormField label="Nom du poste" hint="Pour le reconnaître dans la liste des postes (ex. « Caisse Kaloum »).">
            <input
              className="input input-bordered field-rounded w-full"
              placeholder="Poste"
              value={deviceName}
              disabled={submitting}
              onChange={(e) => setDeviceName(e.target.value)}
            />
          </FormField>

          <FormField label="Type d’inscription" className="sm:col-span-2">
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['hq', 'Poste du siège (clé maîtresse)', 'Accès à tous les magasins, gère le catalogue, les comptes et les paramètres.'],
                  ['store', 'Poste de magasin (code d’inscription)', 'Accès à un seul magasin, avec le code généré par le siège.'],
                ] as [EnrollKind, string, string][]
              ).map(([value, label, help]) => (
                <label
                  key={value}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                    kind === value ? 'border-primary bg-primary/5' : 'border-base-200'
                  }`}
                >
                  <input
                    type="radio"
                    name="enroll-kind"
                    className="radio radio-primary radio-sm mt-0.5"
                    checked={kind === value}
                    disabled={submitting}
                    onChange={() => {
                      setKind(value);
                      setSecret('');
                    }}
                  />
                  <span>
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="block text-xs text-base-content/60">{help}</span>
                  </span>
                </label>
              ))}
            </div>
          </FormField>

          <FormField
            label={kind === 'hq' ? 'Clé maîtresse du serveur' : 'Code d’inscription'}
            required
            hint={
              kind === 'hq'
                ? 'Clé définie lors de l’installation du serveur central.'
                : 'Code à usage unique généré au siège (page Synchronisation du poste du siège).'
            }
            className="sm:col-span-2"
          >
            <input
              type={kind === 'hq' ? 'password' : 'text'}
              autoComplete="off"
              className="input input-bordered field-rounded w-full font-mono"
              value={secret}
              disabled={submitting}
              onChange={(e) => setSecret(kind === 'store' ? e.target.value.toUpperCase() : e.target.value)}
            />
          </FormField>
        </div>

        <div className="mt-4 space-y-2 rounded-xl border border-base-200 bg-base-200/40 p-3 text-xs text-base-content/70">
          {kind === 'hq' ? (
            <p>
              <strong>Poste du siège :</strong> si ce poste contient déjà des données (produits, clients, ventes…), elles
              seront <strong>toutes envoyées au serveur</strong> lors du premier échange. Cela peut prendre quelques
              minutes ; le travail peut continuer pendant ce temps.
            </p>
          ) : (
            <p>
              <strong>Poste de magasin :</strong> l’inscription n’est possible que sur une <strong>installation neuve</strong>{' '}
              (aucun compte créé). Si ce poste contient déjà des données, l’inscription sera refusée : réinstallez
              l’application sur le poste du magasin et utilisez « Rejoindre le serveur » sur l’écran de première
              installation.
            </p>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-error/30 bg-error/10 p-3 text-sm" role="alert">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end border-t border-base-200 pt-4">
          <button type="button" className="btn btn-primary" disabled={submitting} onClick={() => void submit()}>
            {submitting ? <span className="loading loading-spinner loading-sm" /> : 'Relier ce poste'}
          </button>
        </div>
      </Card>
    </PageSection>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Déconnexion
 * ------------------------------------------------------------------ */

function UnenrollSection({ mode, pending, onDone }: { mode: DeviceMode; pending: number; onDone: () => void }) {
  const { refreshUser } = useAuth();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const confirm = async () => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/sync/enroll', { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok) throw new Error(await readError(res, 'Déconnexion impossible'));
      toast.success('Poste déconnecté du serveur central');
      setOpen(false);
      await refreshUser();
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Déconnexion impossible', { autoClose: 8000 });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageSection title="Liaison au serveur">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-base-content/70">
            Déconnecter ce poste arrête les échanges avec le serveur central. Les données déjà présentes sur ce poste
            sont conservées.
          </p>
          <button type="button" className="btn btn-outline btn-error" onClick={() => setOpen(true)}>
            Déconnecter ce poste
          </button>
        </div>
      </Card>

      <ConfirmDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        onConfirm={() => void confirm()}
        title="Déconnecter ce poste"
        tone="error"
        confirmLabel="Déconnecter"
        isSubmitting={submitting}
        message={
          <div className="space-y-2">
            <p>
              Le poste repasse en mode <strong>autonome</strong> : il n’envoie plus ses opérations et ne reçoit plus
              celles {mode === 'hq' ? 'des magasins' : 'du siège'}. Les données locales sont conservées.
            </p>
            {pending > 0 && (
              <p className="text-error">
                <strong>{formatNumber(pending)} changement(s) en attente</strong> n’ont pas encore été envoyés :
                synchronisez avant de déconnecter, sinon ils ne parviendront pas au serveur.
              </p>
            )}
            <p>
              Pour le relier à nouveau, il faudra une nouvelle inscription
              {mode === 'store' ? ' (un poste de magasin ne peut être réinscrit que sur une installation neuve)' : ''}.
            </p>
          </div>
        }
      />
    </PageSection>
  );
}

/* ------------------------------------------------------------------ *
 * 4a. Codes d'inscription (siège)
 * ------------------------------------------------------------------ */

function EnrollmentCodesSection({ stores }: { stores: StoreOption[] }) {
  const candidates = stores.filter((s) => s.kind !== 'headquarters' && s.status === 'active');
  const [storeId, setStoreId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [generated, setGenerated] = useState<{ code: string; expiresAt: string; storeName: string } | null>(null);

  const generate = async () => {
    if (!storeId) {
      toast.error('Choisissez le magasin du poste à inscrire');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/sync/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ storeId: Number(storeId) }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Génération du code impossible'));
      const payload = (await res.json()) as { code: string; expiresAt: string };
      const store = candidates.find((s) => String(s.id) === storeId);
      setGenerated({ ...payload, storeName: store?.name ?? '' });
      toast.success('Code d’inscription généré');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Génération du code impossible', { autoClose: 8000 });
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated.code);
      toast.success('Code copié');
    } catch {
      toast.error('Copie impossible : recopiez le code à la main');
    }
  };

  return (
    <PageSection
      title="Codes d’inscription"
      subtitle="Un code permet d’inscrire un seul poste de magasin. Il ne sert qu’une fois et expire."
    >
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Magasin du poste" className="max-w-sm">
            <select
              className="select select-bordered field-rounded w-full"
              value={storeId}
              disabled={submitting}
              onChange={(e) => setStoreId(e.target.value)}
            >
              <option value="">Choisir un magasin…</option>
              {candidates.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </FormField>
          <button type="button" className="btn btn-primary" disabled={submitting || !storeId} onClick={() => void generate()}>
            {submitting ? <span className="loading loading-spinner loading-sm" /> : 'Générer un code'}
          </button>
        </div>

        {candidates.length === 0 && (
          <p className="mt-3 text-sm text-base-content/60">
            Aucun magasin actif. Créez d’abord le magasin dans{' '}
            <Link href="/magasins" className="link link-primary">
              Magasins
            </Link>
            , puis générez son code.
          </p>
        )}

        {generated && (
          <div className="mt-4 rounded-xl border border-success/30 bg-success/10 p-4">
            <p className="text-sm">
              Code pour <strong>{generated.storeName}</strong> :
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span className="select-all rounded-lg border border-base-300 bg-base-100 px-4 py-2 font-mono text-xl font-semibold tracking-widest">
                {generated.code}
              </span>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void copy()}>
                Copier
              </button>
            </div>
            <p className="mt-2 text-xs text-base-content/70">
              Expire le {formatDateTime(generated.expiresAt)}. Sur le poste du magasin (installation neuve), choisissez
              « Rejoindre le serveur » à l’écran de première installation et saisissez ce code.
            </p>
          </div>
        )}
      </Card>
    </PageSection>
  );
}

/* ------------------------------------------------------------------ *
 * 4b. Postes connectés (siège)
 * ------------------------------------------------------------------ */

function ServerDevicesSection() {
  const [devices, setDevices] = useState<ServerDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<ServerDevice | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sync/devices', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(await readError(res, 'Liste des postes indisponible'));
      const payload = (await res.json()) as { data?: ServerDevice[] };
      setDevices(Array.isArray(payload.data) ? payload.data : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Liste des postes indisponible');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async () => {
    if (!toRevoke) return;
    setRevoking(true);
    try {
      const res = await fetch(`/api/sync/devices/${encodeURIComponent(toRevoke.id)}/revoke`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(await readError(res, 'Révocation impossible'));
      toast.success(`Poste « ${toRevoke.name} » révoqué`);
      setToRevoke(null);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Révocation impossible', { autoClose: 8000 });
    } finally {
      setRevoking(false);
    }
  };

  const columns: Column<ServerDevice>[] = [
    {
      key: 'name',
      label: 'Poste',
      primary: true,
      render: (d) => (
        <span className="font-medium">
          {d.name}
          {d.isCurrent && <span className="ml-2 text-xs font-normal text-base-content/50">(ce poste)</span>}
        </span>
      ),
    },
    { key: 'store', label: 'Magasin', render: (d) => (d.mode === 'hq' ? 'Tous (siège)' : d.storeName ?? '—') },
    { key: 'mode', label: 'Mode', render: (d) => <Badge tone={MODE_TONES[d.mode]}>{MODE_LABELS[d.mode]}</Badge> },
    { key: 'code', label: 'Code poste', hideOnMobile: true, render: (d) => <span className="font-mono">{d.deviceCode}</span> },
    { key: 'seen', label: 'Dernière connexion', render: (d) => (d.lastSeenAt ? formatDateTime(d.lastSeenAt) : 'Jamais') },
    {
      key: 'status',
      label: 'Statut',
      render: (d) =>
        d.revokedAt ? (
          <Badge tone="error">Révoqué le {formatDateTime(d.revokedAt)}</Badge>
        ) : (
          <Badge tone="success">Actif</Badge>
        ),
    },
  ];

  return (
    <PageSection
      title="Postes connectés"
      subtitle="Tous les postes inscrits au serveur central. Révoquez un poste perdu, volé ou remplacé : il ne pourra plus échanger."
      actions={
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void load()}>
          Actualiser
        </button>
      }
    >
      <Card padded={false} className="p-3 sm:p-4">
        {error ? (
          <ErrorState title="Liste des postes indisponible" description={error} onRetry={() => void load()} />
        ) : loading ? (
          <div className="flex justify-center p-6">
            <span className="loading loading-spinner" />
          </div>
        ) : (
          <ResponsiveTable
            columns={columns}
            data={devices}
            getRowKey={(d) => d.id}
            emptyMessage="Aucun poste inscrit."
            actions={(d) =>
              !d.revokedAt && !d.isCurrent ? (
                <button type="button" className="btn btn-ghost btn-sm text-error" onClick={() => setToRevoke(d)}>
                  Révoquer
                </button>
              ) : null
            }
          />
        )}
      </Card>

      <ConfirmDialog
        isOpen={toRevoke !== null}
        onClose={() => setToRevoke(null)}
        onConfirm={() => void revoke()}
        title="Révoquer ce poste"
        tone="error"
        confirmLabel="Révoquer"
        isSubmitting={revoking}
        message={
          <>
            Le poste <strong>{toRevoke?.name}</strong>
            {toRevoke?.storeName ? ` (${toRevoke.storeName})` : ''} ne pourra plus envoyer ni recevoir d’opérations. Les
            opérations qu’il n’a pas encore envoyées resteront bloquées sur lui. Cette action est définitive : pour
            remettre ce poste en service, il faudra le réinstaller et l’inscrire avec un nouveau code.
          </>
        }
      />
    </PageSection>
  );
}

/* ------------------------------------------------------------------ *
 * 5a. Conflits
 * ------------------------------------------------------------------ */

function ConflictsSection({ conflicts, onResolved }: { conflicts: ConflictRow[]; onResolved: () => void }) {
  const [pending, setPending] = useState<{ row: ConflictRow; resolution: 'local' | 'remote' } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const resolve = async () => {
    if (!pending) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sync/conflits/${pending.row.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ resolution: pending.resolution }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Arbitrage impossible'));
      toast.success(
        pending.resolution === 'remote'
          ? 'Version du serveur retenue : elle sera réappliquée au prochain échange'
          : 'Version locale retenue : elle sera renvoyée au prochain échange',
      );
      setPending(null);
      onResolved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Arbitrage impossible', { autoClose: 8000 });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageSection
      title="Conflits"
      subtitle="Un même enregistrement modifié à la fois sur ce poste et ailleurs. Choisissez la version à garder."
    >
      {conflicts.length === 0 ? (
        <Card>
          <p className="text-sm text-base-content/60">Aucun conflit à arbitrer.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {conflicts.map((row) => {
            const diffs = diffFields(row.localPayload, row.remotePayload);
            return (
              <Card key={row.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-base-content/50">{row.createdAt ? formatDateTime(row.createdAt) : '—'}</p>
                    <p className="font-medium">
                      {tableLabel(row.tableName)} — {recordLabel(row)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => setPending({ row, resolution: 'remote' })}
                    >
                      Garder la version du serveur
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => setPending({ row, resolution: 'local' })}
                    >
                      Garder la version locale
                    </button>
                  </div>
                </div>

                <div className="mt-3 overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th>Champ</th>
                        <th>Version locale</th>
                        <th>Version du serveur</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffs.length === 0 ? (
                        <tr>
                          <td colSpan={3} className="text-base-content/60">
                            {row.localPayload === null
                              ? 'Supprimé sur ce poste'
                              : row.remotePayload === null
                                ? 'Supprimé sur le serveur'
                                : 'Aucune différence visible hors champs techniques.'}
                          </td>
                        </tr>
                      ) : (
                        diffs.map((d) => (
                          <tr key={d.key}>
                            <td className="font-mono text-xs">{d.key}</td>
                            <td className="max-w-xs break-all text-sm">{d.local}</td>
                            <td className="max-w-xs break-all text-sm">{d.remote}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => void resolve()}
        title={pending?.resolution === 'remote' ? 'Garder la version du serveur' : 'Garder la version locale'}
        tone="warning"
        confirmLabel="Confirmer"
        isSubmitting={submitting}
        message={
          pending?.resolution === 'remote'
            ? 'La version du serveur remplacera celle de ce poste au prochain échange. Les modifications locales de cet enregistrement seront perdues.'
            : 'La version de ce poste sera renvoyée au serveur au prochain échange et remplacera celle des autres postes.'
        }
      />
    </PageSection>
  );
}

/* ------------------------------------------------------------------ *
 * 5b. Quarantaine (lecture)
 * ------------------------------------------------------------------ */

function QuarantineSection({ rows, total }: { rows: QuarantineRow[]; total: number }) {
  const columns: Column<QuarantineRow>[] = [
    { key: 'date', label: 'Reçu le', render: (r) => (r.createdAt ? formatDateTime(r.createdAt) : '—') },
    { key: 'table', label: 'Type', primary: true, render: (r) => tableLabel(r.tableName) },
    { key: 'record', label: 'Enregistrement', render: (r) => <span className="font-mono text-xs">{r.syncId.slice(0, 8)}</span> },
    { key: 'parent', label: 'En attente de', render: (r) => r.missingParent ?? '—' },
    { key: 'attempts', label: 'Tentatives', render: (r) => formatNumber(r.attempts) },
  ];

  return (
    <PageSection
      title="Quarantaine"
      subtitle="Opérations reçues avant l’enregistrement dont elles dépendent (ex. une ligne de vente avant sa vente). Elles s’appliquent d’elles-mêmes dès que celui-ci arrive."
    >
      <Card padded={false} className="p-3 sm:p-4">
        <ResponsiveTable columns={columns} data={rows} getRowKey={(r) => r.id} emptyMessage="Aucune opération en quarantaine." />
        {total > rows.length && (
          <p className="mt-2 text-xs text-base-content/50">
            {formatNumber(rows.length)} affichées sur {formatNumber(total)}.
          </p>
        )}
      </Card>
    </PageSection>
  );
}
