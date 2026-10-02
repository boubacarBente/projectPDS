'use client';

/**
 * Liste des transferts entre magasins (cahier des charges §8 ; guide §6.15).
 *
 * Un transfert apparaît s'il **part de** ou **arrive dans** un magasin de la
 * portée affichée. Les quatre compteurs disent ce qui attend une action ; un
 * clic filtre la liste sur exactement les mêmes transferts.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Card, EmptyState, ErrorState, SkeletonCards, SkeletonTable, StatCardDelta } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { StoreScopeSelect, useStoreScope } from '@/components/store-scope';
import {
  TRANSFER_STATUS,
  TransferStatusBadge,
  readApiError,
  type TransferRecord,
} from '@/components/transferts/transfer-ui';
import { formatNumber, formatQuantity } from '@/lib/format';
import { formatDateShort } from '@/lib/date-format';

type Direction = 'all' | 'incoming' | 'outgoing';
type Counters = { toApprove: number; toShip: number; toReceive: number; disputed: number };

const PAGE_SIZE = 15;

const STATUS_OPTIONS = [
  { value: 'all', label: 'Tous les statuts' },
  ...Object.entries(TRANSFER_STATUS).map(([value, entry]) => ({ value, label: entry.label })),
  { value: 'approved,preparing', label: 'À expédier' },
  { value: 'in_transit,partially_received', label: 'À recevoir' },
];

const DIRECTIONS: { key: Direction; label: string }[] = [
  { key: 'all', label: 'Tous' },
  { key: 'incoming', label: 'Entrants' },
  { key: 'outgoing', label: 'Sortants' },
];

export default function TransfertsPage() {
  const router = useRouter();
  const canCreate = usePermission('transfers.create');
  const { scope, setScope, apply } = useStoreScope('transferts');

  const [direction, setDirection] = useState<Direction>('all');
  // « En cours » par défaut : ce qui demande encore une action.
  const [status, setStatus] = useState('open');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<TransferRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [counters, setCounters] = useState<Counters | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = apply(new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), direction, status }));
      if (search.trim()) params.set('search', search.trim());
      const [listResponse, countersResponse] = await Promise.all([
        fetch(`/api/transferts?${params}`, { cache: 'no-store', credentials: 'same-origin' }),
        fetch(`/api/transferts/compteurs?${apply(new URLSearchParams())}`, { cache: 'no-store', credentials: 'same-origin' }),
      ]);
      if (!listResponse.ok) throw new Error(await readApiError(listResponse, 'Les transferts n’ont pas pu être chargés.'));
      const payload = await listResponse.json();
      setRows(payload.data ?? []);
      setTotal(payload.total ?? 0);
      setTotalPages(payload.totalPages ?? 1);
      if (countersResponse.ok) setCounters(await countersResponse.json());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Les transferts n’ont pas pu être chargés.');
    } finally {
      setIsLoading(false);
    }
  }, [apply, page, direction, status, search]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  /** Applique le filtre d'un compteur : mêmes statuts et même sens que le décompte. */
  const focus = (nextStatus: string, nextDirection: Direction) => {
    setStatus(nextStatus);
    setDirection(nextDirection);
    setPage(1);
  };

  const columns: Column<TransferRecord>[] = [
    {
      key: 'date',
      label: 'Date',
      render: (t) => <span className="whitespace-nowrap tabular">{formatDateShort(t.createdAt)}</span>,
    },
    {
      key: 'reference',
      label: 'Référence',
      primary: true,
      render: (t) => (
        <span className="block min-w-0">
          <span className="block font-mono text-sm font-semibold">{t.reference}</span>
          {t.reason && <span className="block truncate text-xs text-base-content/55">{t.reason}</span>}
        </span>
      ),
    },
    {
      key: 'route',
      label: 'Trajet',
      render: (t) => (
        <span className="text-sm">
          {t.sourceStoreName} <span aria-hidden>→</span>
          <span className="sr-only"> vers </span> {t.destinationStoreName}
        </span>
      ),
    },
    { key: 'status', label: 'Statut', render: (t) => <TransferStatusBadge status={t.status} /> },
    {
      key: 'quantities',
      label: 'Demandé / expédié / reçu',
      className: 'text-right',
      render: (t) => (
        <span className="tabular whitespace-nowrap text-sm">
          {formatQuantity(t.totalRequested)} / {formatQuantity(t.totalShipped)} / {formatQuantity(t.totalReceived)}
          <span className="block text-xs text-base-content/50">{formatNumber(t.itemCount)} produit(s)</span>
        </span>
      ),
    },
    {
      key: 'requestedBy',
      label: 'Demandé par',
      hideOnMobile: true,
      render: (t) => <span className="text-sm">{t.requestedByName ?? '—'}</span>,
    },
  ];

  const counterCards = counters ? (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[
        {
          label: 'À valider',
          value: counters.toApprove,
          tone: 'warning' as const,
          tooltip:
            'Demandes de transfert envoyées qui attendent l’accord d’un gérant. Cliquez sur la carte pour les afficher.',
          onClick: () => focus('pending', 'all'),
        },
        {
          label: 'À expédier',
          value: counters.toShip,
          tone: 'info' as const,
          tooltip:
            'Transferts acceptés qui doivent partir d’un de vos magasins. La marchandise ne quitte le stock qu’au moment de l’expédition.',
          onClick: () => focus('approved,preparing', 'outgoing'),
        },
        {
          label: 'À recevoir',
          value: counters.toReceive,
          tone: 'primary' as const,
          tooltip:
            'Marchandise en route vers un de vos magasins. Elle entre dans votre stock quand vous enregistrez la réception.',
          onClick: () => focus('in_transit,partially_received', 'incoming'),
        },
        {
          label: 'En litige',
          value: counters.disputed,
          tone: 'error' as const,
          tooltip:
            'Transferts où la quantité reçue ne correspond pas à la quantité expédiée (perte, casse). Un gérant doit les clôturer.',
          onClick: () => focus('disputed', 'all'),
        },
      ].map((card) => (
        <button
          key={card.label}
          type="button"
          onClick={card.onClick}
          className="rounded-2xl text-left transition-transform focus-visible:outline-2 focus-visible:outline-primary active:scale-[0.99]"
          aria-label={`${card.label} : ${card.value}. Afficher ces transferts`}
        >
          <StatCardDelta
            label={card.label}
            value={formatNumber(card.value)}
            tone={card.value > 0 ? card.tone : 'neutral'}
            hint={card.value > 0 ? 'Cliquez pour les afficher' : 'Rien en attente'}
            tooltip={card.tooltip}
          />
        </button>
      ))}
    </div>
  ) : (
    <SkeletonCards count={4} />
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Gestion"
        title="Transferts"
        description="Envoi de marchandise d’un magasin à un autre : demande, validation, expédition, réception."
        actions={
          canCreate ? (
            <Link href="/transferts/nouveau" className="btn btn-primary min-h-11 sm:min-h-0">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Nouveau transfert
            </Link>
          ) : null
        }
      />

      {counterCards}

      <div role="tablist" className="tabs tabs-border">
        {DIRECTIONS.map((d) => (
          <button
            key={d.key}
            type="button"
            role="tab"
            aria-selected={direction === d.key}
            className={`tab min-h-11 ${direction === d.key ? 'tab-active' : ''}`}
            onClick={() => {
              setDirection(d.key);
              setPage(1);
            }}
          >
            {d.label}
          </button>
        ))}
      </div>

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher une référence ou un motif…"
        filters={
          <>
            <div className="w-full sm:w-56">
              <FilterSelect
                value={status === 'open' ? '' : status}
                onChange={(value) => {
                  setStatus(value || 'open');
                  setPage(1);
                }}
                options={STATUS_OPTIONS}
                placeholder="En cours"
              />
            </div>
            <StoreScopeSelect
              value={scope}
              onChange={(value) => {
                setScope(value);
                setPage(1);
              }}
              className="min-h-11 w-full sm:w-56"
            />
          </>
        }
        actions={<span className="text-sm text-base-content/50">{formatNumber(total)} transfert(s)</span>}
      />

      {error ? (
        <Card>
          <ErrorState description={error} onRetry={() => void load()} />
        </Card>
      ) : isLoading && rows.length === 0 ? (
        <SkeletonTable rows={5} cols={6} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title={status === 'open' ? 'Aucun transfert en cours' : 'Aucun transfert'}
            description="Un transfert déplace de la marchandise d’un magasin à un autre, sans vente."
            action={
              canCreate ? (
                <Link href="/transferts/nouveau" className="btn btn-primary min-h-11">
                  Demander un transfert
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <ResponsiveTable
          columns={columns}
          data={rows}
          getRowKey={(t) => t.id}
          onRowClick={(t) => router.push(`/transferts/${t.id}`)}
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
