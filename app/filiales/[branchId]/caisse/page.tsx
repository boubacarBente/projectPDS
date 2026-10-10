'use client';

/**
 * Caisse d'une filiale de production (README §31.8).
 *
 * Décision retenue (cahier des charges §13, option B) : **une caisse générale
 * par magasin, filtrée par filiale**. L'argent reste dans la caisse du magasin
 * (une seule session ouverte, une seule clôture) ; chaque mouvement porte la
 * filiale concernée — encaissement d'une vente ou d'une commande de la
 * filiale, décaissement d'une de ses dépenses. Cette page montre les entrées,
 * les sorties et le solde de la filiale, avec le détail par moyen et par
 * origine, et la liste des mouvements avec leur document source.
 *
 * Ouverture et clôture se font dans `/caisse` (droits `cash.*`).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { DatePicker } from '@/components/date-picker';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Badge, Card, EmptyState, ErrorState, MoneyText, SkeletonCards, SkeletonTable, StatCardDelta } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { BrickTabs, useBrickScope } from '@/components/briqueterie/brick-tabs';
import { useBranch } from '@/components/filiales/branch-context';
import { PageHeader } from '@/components/page-header';
import { readApiError } from '@/components/caisse/caisse-modals';
import type { BranchCashSummary, CashMovementRow } from '@/lib/caisse';
import { formatCurrency, formatNumber, today } from '@/lib/format';
import { BranchExportButton } from '@/components/filiales/branch-export';
import { useSettings } from '@/app/parametres/page';
import { exportCompanyFromSettings, exportFileName, type ExportDocumentInput } from '@/lib/export-document';
import { formatDateShort } from '@/lib/date-format';

const PAGE_SIZE = 20;

const TYPE_OPTIONS = [
  { value: 'income', label: 'Entrées' },
  { value: 'expense', label: 'Sorties' },
];

const ORIGIN_LABELS: Record<string, string> = {
  payment: 'Encaissements',
  sale: 'Ventes (contre-passations)',
  expense: 'Dépenses',
  manual: 'Mouvements manuels',
  purchase: 'Achats',
};

type Payload = { data: CashMovementRow[]; total: number; totalPages: number; summary: BranchCashSummary };

export default function BranchCashPage() {
  const { branch, api } = useBranch();
  const { settings } = useSettings();
  const canOpenCash = usePermission('cash.view');
  const { scope, setScope, withStore, showStore } = useBrickScope();
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (type) query.set('type', type);
      if (debounced) query.set('search', debounced);
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      const response = await fetch(withStore(api(`/caisse?${query}`)), { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(await readApiError(response, 'La caisse de la filiale n’a pas pu être chargée.'));
      setPayload(await response.json());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'La caisse de la filiale n’a pas pu être chargée.');
    } finally {
      setIsLoading(false);
    }
  }, [api, page, type, debounced, from, to, withStore]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  /** Relevé de caisse de la filiale (README §31.8) : mêmes filtres, jusqu'à 200 mouvements. */
  async function buildCashReport(): Promise<ExportDocumentInput | null> {
    const query = new URLSearchParams({ page: '1', limit: '200' });
    if (type) query.set('type', type);
    if (debounced) query.set('search', debounced);
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    const response = await fetch(withStore(api(`/caisse?${query}`)), { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(await readApiError(response, 'La caisse de la filiale n’a pas pu être lue.'));
    const data = (await response.json()) as Payload;
    const s = data.summary;
    const period = from || to ? `${from ? `du ${formatDateShort(from)}` : 'depuis le début'} ${to ? `au ${formatDateShort(to)}` : 'à ce jour'}` : 'toutes dates';
    return {
      documentTitle: 'Relevé de caisse',
      documentNumber: branch.name,
      documentDate: `Édité le ${formatDateShort(today())}`,
      company: exportCompanyFromSettings(settings),
      meta: [
        ['Filiale', branch.name],
        ['Période', period],
      ],
      blocks: [
        {
          kind: 'table',
          title: 'Par moyen de paiement',
          columns: [{ label: 'Moyen' }, { label: 'Entrées', align: 'right' }, { label: 'Sorties', align: 'right' }, { label: 'Net', align: 'right' }],
          numeric: [1, 2, 3],
          rows: s.byMethod.map((m) => [m.method, formatCurrency(m.income), formatCurrency(m.expense), formatCurrency(m.net)]),
        },
        {
          kind: 'table',
          title: 'Mouvements',
          columns: [{ label: 'Date' }, { label: 'Mouvement' }, { label: 'Moyen' }, { label: 'Entrée', align: 'right' }, { label: 'Sortie', align: 'right' }],
          numeric: [3, 4],
          rows: data.data.map((m) => [
            formatDateShort(m.date),
            m.motif,
            m.paymentMethod,
            m.type === 'income' ? formatCurrency(m.amount) : '',
            m.type === 'expense' ? formatCurrency(m.amount) : '',
          ]),
        },
        {
          kind: 'totals',
          rows: [
            { label: 'Entrées', value: formatCurrency(s.income), tone: 'success' },
            { label: 'Sorties', value: formatCurrency(s.expense), tone: 'danger' },
            { label: 'Net de la période', value: formatCurrency(s.net), tone: 'strong' },
            { label: 'Solde cumulé de la filiale', value: formatCurrency(s.balance), tone: 'strong' },
          ],
        },
      ],
      footer:
        data.total > data.data.length
          ? `${formatNumber(data.data.length)} mouvements sur ${formatNumber(data.total)} : resserrez la période pour tout imprimer.`
          : `${formatNumber(data.total)} mouvement(s). Caisse du magasin, mouvements marqués pour la filiale.`,
    };
  }

  const summary = payload?.summary;
  const rows = payload?.data ?? [];

  const columns: Column<CashMovementRow>[] = [
    { key: 'date', label: 'Date', render: (row) => formatDateShort(row.date) },
    {
      key: 'motif',
      label: 'Mouvement',
      primary: true,
      render: (row) => (
        <div className="min-w-0">
          <div className="max-w-[16rem] truncate font-medium xl:max-w-md" title={row.motif}>{row.motif}</div>
          <div className="truncate text-xs text-base-content/60">
            {row.userName ?? '—'}
            {showStore && row.storeName ? ` · ${row.storeName}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'type',
      label: 'Sens',
      render: (row) => (row.type === 'income' ? <Badge tone="success">Entrée</Badge> : <Badge tone="error">Sortie</Badge>),
    },
    { key: 'method', label: 'Moyen', hideOnMobile: true, render: (row) => row.paymentMethod },
    {
      key: 'amount',
      label: 'Montant',
      className: 'text-right',
      render: (row) => <MoneyText value={row.type === 'income' ? row.amount : -row.amount} colored bold />,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl 2xl:max-w-[100rem] space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow={branch.name}
        title="Caisse"
        description="L’argent de la filiale passe par la caisse du magasin ; chaque mouvement porte la filiale concernée. Ouverture et clôture de la journée se font dans la caisse du magasin."
        actions={
          <>
            <BranchExportButton build={buildCashReport} fileBase={exportFileName('caisse', branch.name)} what="le relevé de caisse" />
            {canOpenCash && (
          <Link href="/caisse" className="btn btn-ghost min-h-11 border border-base-300">
            Caisse du magasin
          </Link>
        )}
          </>
        }
      />
      <BrickTabs
        scope={scope}
        onScopeChange={(value) => {
          setScope(value);
          setPage(1);
        }}
      />
      {!summary ? (
        <SkeletonCards count={4} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCardDelta
            label="Entrées"
            tone="success"
            value={formatCurrency(summary.income)}
            tooltip="Argent entré dans la caisse pour la filiale sur la période : encaissements de ses ventes et acomptes de ses commandes, retours de dépenses annulées."
          />
          <StatCardDelta
            label="Sorties"
            tone="error"
            value={formatCurrency(summary.expense)}
            tooltip="Argent sorti de la caisse pour la filiale sur la période : dépenses décaissées, remboursements de ventes annulées."
          />
          <StatCardDelta
            label="Net de la période"
            tone={summary.net < 0 ? 'error' : 'info'}
            value={<MoneyText value={summary.net} colored />}
            tooltip="Entrées moins sorties de la filiale sur la période choisie."
          />
          <StatCardDelta
            label="Solde de la filiale"
            tone="primary"
            value={<MoneyText value={summary.balance} colored />}
            tooltip="Somme de tous les mouvements de caisse de la filiale depuis le premier, jusqu’à la fin de la période choisie (entrées moins sorties)."
          />
        </div>
      )}

      {summary && (summary.byMethod.length > 0 || summary.byOrigin.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 font-semibold">Par moyen de paiement</h2>
            <ul className="divide-y divide-base-200 text-sm">
              {summary.byMethod.map((line) => (
                <li key={line.method} className="flex items-center justify-between gap-3 py-2">
                  <span>{line.method}</span>
                  <span className="tabular text-right">
                    <span className="text-success">+{formatNumber(line.income)}</span> · <span className="text-error">−{formatNumber(line.expense)}</span> ·{' '}
                    <MoneyText value={line.net} colored bold />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <h2 className="mb-3 font-semibold">Par origine</h2>
            <ul className="divide-y divide-base-200 text-sm">
              {summary.byOrigin.map((line) => (
                <li key={line.origin} className="flex items-center justify-between gap-3 py-2">
                  <span>{ORIGIN_LABELS[line.origin] ?? line.origin}</span>
                  <span className="tabular text-right">
                    <span className="text-success">+{formatNumber(line.income)}</span> · <span className="text-error">−{formatNumber(line.expense)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un motif, un n° de reçu…"
        filters={
          <div className="w-full sm:w-44">
            <FilterSelect value={type} onChange={(v) => { setType(v); setPage(1); }} options={TYPE_OPTIONS} placeholder="Entrées et sorties" />
          </div>
        }
        secondaryFilters={
          <>
            <div className="w-full sm:w-44">
              <DatePicker value={from} onChange={(v) => { setFrom(v); setPage(1); }} placeholder="Du" />
            </div>
            <div className="w-full sm:w-44">
              <DatePicker value={to} onChange={(v) => { setTo(v); setPage(1); }} placeholder="Au" />
            </div>
          </>
        }
        secondaryCount={(from ? 1 : 0) + (to ? 1 : 0)}
      />

      {isLoading && !payload ? (
        <SkeletonTable rows={6} cols={5} />
      ) : error ? (
        <ErrorState title="Caisse indisponible" description={error} onRetry={() => setReload((n) => n + 1)} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Aucun mouvement"
          description="Aucun mouvement de caisse de la filiale ne correspond à ces filtres. Les encaissements de ses ventes et commandes et les décaissements de ses dépenses apparaissent ici."
        />
      ) : (
        <>
          <ResponsiveTable cardsBelow="xl" columns={columns} data={rows} getRowKey={(row) => row.id} />
          <Pagination currentPage={page} totalPages={payload?.totalPages ?? 1} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/60">{formatNumber(payload?.total ?? 0)} mouvement(s)</p>
        </>
      )}
    </div>
  );
}
