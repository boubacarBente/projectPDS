'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { DatePicker } from '@/components/date-picker';
import { FilterSelect } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Pagination } from '@/components/search-filter';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  SkeletonTable,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
// ⚠️ Les libellés viennent de `lib/audit-labels.ts`, et non de `lib/audit.ts` :
// ce dernier est un module **serveur** (il importe `@/db`). L'importer dans un
// composant client ferait entrer `@libsql/client` et `fs` dans le bundle
// navigateur, ce que Turbopack refuse.
import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS } from '@/lib/audit-labels';
import { formatDateTime } from '@/lib/date-format';
import { formatNumber, truncate } from '@/lib/format';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';

/** Clé de restauration d'état de cette liste (§5, obligatoire). */
const VIEW_STATE_KEY = 'utilisateurs-historique';
const PAGE_SIZE = 20;

/** Une ligne du journal, telle que sérialisée par `GET /api/audit`. */
type AuditRow = {
  id: number;
  userId: number | null;
  userName: string;
  action: string;
  entity: string;
  entityId: number | null;
  details: string | null;
  createdAt: string | null;
};

type AuditListResponse = {
  data: AuditRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type UserOption = { id: number; name: string; username: string };

/**
 * Libellés français des clés de `details` rencontrées dans le journal.
 * Le détail est un JSON libre : ce dictionnaire l'embellit quand la clé est
 * connue, et la clé brute est affichée sinon (jamais du JSON illisible).
 */
const DETAIL_KEY_LABELS: Record<string, string> = {
  name: 'Nom',
  username: 'Identifiant',
  role: 'Rôle',
  phone: 'Téléphone',
  isActive: 'Actif',
  is_active: 'Actif',
  reactivated: 'Réactivé',
  deactivated: 'Désactivé',
  field: 'Champ',
  message: 'Message',
  target: 'Compte',
  raison: 'Motif',
  reason: 'Motif',
  before: 'Avant',
  after: 'Après',
  amount: 'Montant',
  total: 'Total',
  quantity: 'Quantité',
  reference: 'Référence',
  date: 'Date',
  status: 'Statut',
  deleted_at: 'Désactivé le',
  productId: 'Produit',
  customerId: 'Client',
  supplierId: 'Fournisseur',
  invoiceNumber: 'Facture',
  table: 'Table',
  email: 'E-mail',
  address: 'Adresse',
  notes: 'Notes',
  motif: 'Motif',
};

function labelForKey(key: string): string {
  return DETAIL_KEY_LABELS[key] ?? key.replace(/_/g, ' ');
}

/** Une valeur de `details` rendue lisible : jamais du JSON brut. */
function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'oui' : 'non';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDateTime(value);
    return value.length > 80 ? truncate(value, 80) : value;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((item) => formatDetailValue(item)).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${labelForKey(key)} : ${formatDetailValue(nested)}`)
      .join(' · ');
  }
  return String(value);
}

/**
 * Restitution du `details` (JSON texte) sous forme de liste « clé : valeur ».
 * Un JSON brut dans une cellule est illisible : on l'ouvre ici.
 */
function DetailsCell({ details }: { details: string | null }) {
  const entries = useMemo<[string, string][]>(() => {
    if (!details) return [];

    const text = details.trim();
    if (!text) return [];

    // Détail écrit en clair (ancien format) : on l'affiche tel quel.
    if (!text.startsWith('{') && !text.startsWith('[')) return [['Détail', text]];

    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
          labelForKey(key),
          formatDetailValue(value),
        ]);
      }
      if (Array.isArray(parsed)) return [['Détail', formatDetailValue(parsed)]];
      return [['Détail', formatDetailValue(parsed)]];
    } catch {
      return [['Détail', text.length > 120 ? truncate(text, 120) : text]];
    }
  }, [details]);

  if (entries.length === 0) return <span className="text-base-content/40">—</span>;

  return (
    <ul className="space-y-0.5 text-xs leading-5">
      {entries.map(([label, value], index) => (
        <li key={`${label}-${index}`} className="text-base-content/70">
          <span className="text-base-content/45">{label} :</span>{' '}
          <span className="font-medium text-base-content/85">{value}</span>
        </li>
      ))}
    </ul>
  );
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    return payload?.error ?? `Erreur ${response.status}`;
  } catch {
    return `Erreur ${response.status}`;
  }
}

/**
 * Historique des actions (README §17.3) — `GET /api/audit`.
 *
 * Journal en **lecture seule** : on n'y modifie rien. Permission `audit.view`
 * (administrateur et gérant, §17.2).
 */
export default function HistoriquePage() {
  const allowed = usePermission('audit.view');

  if (!allowed) {
    return (
      <div className="space-y-5">
        <PageHeader
          eyebrow="Administration"
          title="Historique des actions"
          description="Journal des opérations sensibles : qui a fait quoi, quand."
        />
        <Card>
          <EmptyState
            title="Accès non autorisé"
            description="La consultation du journal des actions est réservée aux rôles Administrateur et Gérant (README §17.2)."
          />
        </Card>
      </div>
    );
  }

  return <HistoriqueContent />;
}

function HistoriqueContent() {
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);

  const [search, setSearch] = useState('');
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const rehydrated = useViewStateRehydration<{
    search: string;
    userId: string;
    action: string;
    entity: string;
    from: string;
    to: string;
    page: number;
  }>(VIEW_STATE_KEY, (saved) => {
    if (saved.search !== undefined) setSearch(saved.search);
    if (saved.userId !== undefined) setUserId(saved.userId);
    if (saved.action !== undefined) setAction(saved.action);
    if (saved.entity !== undefined) setEntity(saved.entity);
    if (saved.from !== undefined) setFrom(saved.from);
    if (saved.to !== undefined) setTo(saved.to);
    if (saved.page) setPage(saved.page);
  });

  const reload = useCallback(() => setRefreshToken((value) => value + 1), []);

  /** Filtre « utilisateur » : liste réduite via `GET /api/users?options=true`. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    fetch('/api/users?options=true', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return [] as UserOption[];
        return (await response.json()) as UserOption[];
      })
      .then((payload) => setUserOptions(Array.isArray(payload) ? payload : []))
      .catch(() => setUserOptions([]));

    return () => controller.abort();
  }, [rehydrated]);

  /** Journal : recherche débouncée + `AbortController`. */
  useEffect(() => {
    if (!rehydrated) return;

    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search.trim()) params.set('search', search.trim());
      if (userId) params.set('userId', userId);
      if (action) params.set('action', action);
      if (entity) params.set('entity', entity);
      if (from) params.set('from', from);
      if (to) params.set('to', to);

      setIsLoading(true);
      setLoadError(null);

      fetch(`/api/audit?${params.toString()}`, { signal: controller.signal, cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error(await readError(response));
          return (await response.json()) as AuditListResponse;
        })
        .then((payload) => {
          setLogs(payload.data);
          setTotal(payload.total);
          setTotalPages(payload.totalPages);

          const clamped = clampPage(page, payload.totalPages);
          if (clamped !== null) setPage(clamped);

          setIsLoading(false);
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === 'AbortError') return;
          setLoadError(error instanceof Error ? error.message : 'Chargement impossible');
          setIsLoading(false);
        });
    }, 300);

    return () => clearTimeout(timer);
  }, [rehydrated, search, userId, action, entity, from, to, page, refreshToken]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_STATE_KEY, { search, userId, action, entity, from, to, page });
  }, [rehydrated, search, userId, action, entity, from, to, page]);

  const actionOptions = useMemo(
    () =>
      Object.entries(AUDIT_ACTION_LABELS)
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr')),
    [],
  );

  const entityOptions = useMemo(
    () =>
      Object.entries(AUDIT_ENTITY_LABELS)
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr')),
    [],
  );

  const userFilterOptions = useMemo(
    () =>
      userOptions
        .map((option) => ({ value: String(option.id), label: `${option.name} (${option.username})` }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr')),
    [userOptions],
  );

  const columns: Column<AuditRow>[] = [
    {
      key: 'createdAt',
      label: 'Date et heure',
      primary: true,
      render: (log) => (
        <span className="whitespace-nowrap text-sm font-semibold">{formatDateTime(log.createdAt)}</span>
      ),
    },
    {
      key: 'userName',
      label: 'Utilisateur',
      render: (log) => <span className="text-sm">{log.userName}</span>,
    },
    {
      key: 'action',
      label: 'Action',
      render: (log) => (
        <Badge tone={log.action === 'delete' || log.action === 'cancel' ? 'error' : 'neutral'}>
          {AUDIT_ACTION_LABELS[log.action] ?? log.action}
        </Badge>
      ),
    },
    {
      key: 'entity',
      label: 'Entité',
      render: (log) => (
        <span className="text-sm">
          {AUDIT_ENTITY_LABELS[log.entity] ?? log.entity}
          {log.entityId ? <span className="text-base-content/45"> #{log.entityId}</span> : null}
        </span>
      ),
    },
    {
      key: 'details',
      label: 'Détail',
      hideOnMobile: true,
      render: (log) => <DetailsCell details={log.details} />,
    },
  ];

  const hasFilters =
    Boolean(search.trim()) || Boolean(userId) || Boolean(action) || Boolean(entity) || Boolean(from) || Boolean(to);
  const isEmpty = !isLoading && !loadError && logs.length === 0;

  const resetFilters = () => {
    setSearch('');
    setUserId('');
    setAction('');
    setEntity('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Administration"
        title="Historique des actions"
        description="Qui a fait quoi, et quand : création, modification, désactivation, encaissement, ajustement de stock, paramètres. Le journal est en lecture seule et ne peut pas être modifié depuis l’application."
        actions={
          <Link href="/utilisateurs" className="btn btn-ghost min-h-11">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
            Gérer les utilisateurs
          </Link>
        }
      />

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un utilisateur, une entité, un détail…"
        filters={
          <>
            <div className="w-full sm:w-64">
              <FilterSelect
                value={userId}
                onChange={(value) => {
                  setUserId(value);
                  setPage(1);
                }}
                options={userFilterOptions}
                placeholder="Tous les utilisateurs"
              />
            </div>
            <div className="w-full sm:w-52">
              <FilterSelect
                value={action}
                onChange={(value) => {
                  setAction(value);
                  setPage(1);
                }}
                options={actionOptions}
                placeholder="Toutes les actions"
              />
            </div>
          </>
        }
        secondaryFilters={
          <>
            <div className="w-full sm:w-56">
              <FilterSelect
                value={entity}
                onChange={(value) => {
                  setEntity(value);
                  setPage(1);
                }}
                options={entityOptions}
                placeholder="Toutes les entités"
              />
            </div>
            <div className="w-full sm:w-44">
              <label className="mb-1 block text-xs font-medium text-base-content/60">Du</label>
              <DatePicker
                value={from}
                onChange={(value) => {
                  setFrom(value);
                  setPage(1);
                }}
                placeholder="Date de début"
              />
            </div>
            <div className="w-full sm:w-44">
              <label className="mb-1 block text-xs font-medium text-base-content/60">Au</label>
              <DatePicker
                value={to}
                onChange={(value) => {
                  setTo(value);
                  setPage(1);
                }}
                placeholder="Date de fin"
              />
            </div>
          </>
        }
        secondaryCount={[entity, from, to].filter(Boolean).length}
        actions={
          <span className="text-sm text-base-content/50">{formatNumber(total)} action(s)</span>
        }
      />

      {isLoading ? (
        <SkeletonTable rows={8} cols={5} />
      ) : loadError ? (
        <Card>
          <ErrorState
            title="Impossible de charger l’historique"
            description={loadError}
            onRetry={reload}
          />
        </Card>
      ) : isEmpty ? (
        <Card>
          <EmptyState
            title={hasFilters ? 'Aucune action ne correspond' : 'Aucune action enregistrée'}
            description={
              hasFilters
                ? 'Élargissez la période ou retirez un filtre.'
                : 'Le journal se remplira dès la première opération (connexion, vente, modification…).'
            }
            action={
              hasFilters ? (
                <button type="button" className="btn btn-primary min-h-11" onClick={resetFilters}>
                  Réinitialiser les filtres
                </button>
              ) : (
                <Link href="/utilisateurs" className="btn btn-primary min-h-11">
                  Retour aux utilisateurs
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <ResponsiveTable
          columns={columns}
          data={logs}
          getRowKey={(log) => log.id}
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
