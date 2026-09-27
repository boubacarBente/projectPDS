'use client';

/**
 * Registre des reçus (README §7.7).
 *
 * **Tous** les reçus du poste, toutes origines confondues — ventes, achats et
 * prestations — dans une seule liste paginée. Avant cette page, un reçu n'était
 * accessible qu'en passant par la fiche de son client (`/clients/[id]/paiements`),
 * de son fournisseur (`/fournisseurs/[id]/paiements`) ou du document réglé : il
 * n'existait aucun registre global.
 *
 * Données : `GET /api/recus` (`lib/payments.ts`, `listReceipts`) — le document
 * réglé et le tiers sont résolus côté serveur, `payments.reference_id` étant
 * polymorphe et sans clé étrangère. Chaque ligne ouvre le reçu imprimable
 * (`/recus/[id]`), qui reste la source du PDF, de l'image et du partage.
 *
 * Ordre des colonnes : la **date en premier**, comme dans tous les listings.
 * La recherche évite volontairement le mot « numéro », que la saisie
 * automatique de Chrome prend pour un champ de carte bancaire.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { DataToolbar, ToolbarButton } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { DatePicker } from '@/components/date-picker';
import { Tooltip } from '@/components/tooltip';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { IconAction, RowActions } from '@/components/row-actions';
import {
  Badge,
  EmptyState,
  ErrorState,
  MoneyText,
  SkeletonTable,
  type BadgeTone,
} from '@/components/design-system';
import { useSettings } from '@/app/parametres/page';
import {
  PAYMENT_LABEL_LABELS,
  readApiError,
  type PaymentRow,
} from '@/components/ventes/ventes-modals';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';

const PAGE_LIMIT = 15;
const VIEW_NAME = 'recus';
/** Moyens de repli si les paramètres n'en définissent aucun. */
const FALLBACK_METHODS = ['Espèces', 'Mobile Money', 'Virement', 'Crédit'];

/** Un reçu du registre : le paiement, plus le document réglé et son tiers. */
type ReceiptRecord = PaymentRow & {
  documentNumber: string | null;
  partyName: string | null;
};

type TypeFilter = 'all' | 'sale' | 'purchase' | 'service_job';

const TYPE_OPTIONS = [
  { value: 'all', label: 'Toutes les origines' },
  { value: 'sale', label: 'Ventes' },
  { value: 'purchase', label: 'Achats' },
  { value: 'service_job', label: 'Prestations' },
];

/** Origine du reçu — `payments.type` (§7.1). */
const DOCUMENT_TYPES: Record<string, { label: string; tone: BadgeTone }> = {
  sale: { label: 'Vente', tone: 'primary' },
  purchase: { label: 'Achat', tone: 'warning' },
  service_job: { label: 'Prestation', tone: 'info' },
};

/** Acompte / solde / intégral (§7). */
const LABEL_TONES: Record<string, BadgeTone> = {
  deposit: 'info',
  balance: 'success',
  full: 'primary',
};

type ViewState = {
  search: string;
  page: number;
  type: TypeFilter;
  paymentMethod: string;
  from: string;
  to: string;
};

function isTypeFilter(value: unknown): value is TypeFilter {
  return value === 'all' || value === 'sale' || value === 'purchase' || value === 'service_job';
}

export default function RecusPage() {
  const { settings } = useSettings();

  const [receipts, setReceipts] = useState<ReceiptRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);

  const rehydrated = useViewStateRehydration<ViewState>(VIEW_NAME, (saved) => {
    if (typeof saved.search === 'string') setSearch(saved.search);
    if (isTypeFilter(saved.type)) setType(saved.type);
    if (typeof saved.paymentMethod === 'string') setPaymentMethod(saved.paymentMethod);
    if (typeof saved.from === 'string') setFrom(saved.from);
    if (typeof saved.to === 'string') setTo(saved.to);
    if (typeof saved.page === 'number' && saved.page > 0) setPage(saved.page);
  });

  /* Recherche débouncée à 300 ms : la frappe ne déclenche pas une requête par touche. */
  useEffect(() => {
    if (!rehydrated) return;
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search, rehydrated]);

  /* Chargement de la liste. Le premier appel est **gaté** sur `rehydrated`,
     sinon la page chargerait la page 1 puis rechargerait la page restaurée. */
  useEffect(() => {
    if (!rehydrated) return;

    const controller = new AbortController();
    let active = true;

    void (async () => {
      setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (type !== 'all') params.set('type', type);
        if (paymentMethod) params.set('paymentMethod', paymentMethod);
        if (from) params.set('from', from);
        if (to) params.set('to', to);

        const response = await fetch(`/api/recus?${params.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (response.status === 403) {
          throw new Error(
            'Votre compte n’a pas la permission de consulter les reçus (payments.view).',
          );
        }

        if (!response.ok) {
          throw new Error(await readApiError(response, 'Les reçus n’ont pas pu être chargés.'));
        }

        const payload = (await response.json()) as {
          data?: unknown[];
          total?: number;
          totalPages?: number;
        };

        if (!active) return;

        const rows = Array.isArray(payload.data) ? (payload.data as ReceiptRecord[]) : [];
        const pages = Math.max(1, Number(payload.totalPages ?? 1));

        setReceipts(rows);
        setTotal(Number(payload.total ?? rows.length));
        setTotalPages(pages);

        // Une page restaurée devenue hors bornes (liste rétrécie) est corrigée.
        const clamped = clampPage(page, pages);
        if (clamped !== null) setPage(clamped);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setReceipts([]);
        setError(caught instanceof Error ? caught.message : 'Les reçus n’ont pas pu être chargés.');
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [rehydrated, debouncedSearch, type, paymentMethod, from, to, page, refreshToken]);

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState(VIEW_NAME, { search, page, type, paymentMethod, from, to });
  }, [rehydrated, search, page, type, paymentMethod, from, to]);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  const methodOptions = useMemo(() => {
    const configured = settings.paymentMethods?.filter((method) => Boolean(method?.trim())) ?? [];
    const methods = configured.length > 0 ? configured : FALLBACK_METHODS;
    return [
      { value: '', label: 'Tous les moyens' },
      ...methods.map((method) => ({ value: method, label: method })),
    ];
  }, [settings.paymentMethods]);

  const columns = [
    {
      key: 'date',
      label: 'Date',
      className: 'whitespace-nowrap',
      render: (receipt: ReceiptRecord) => (
        <span className="tabular text-base-content/70">{formatDateShort(receipt.date)}</span>
      ),
    },
    {
      key: 'receiptNumber',
      label: 'Reçu',
      primary: true,
      render: (receipt: ReceiptRecord) => (
        <Link
          href={`/recus/${receipt.id}`}
          className="font-semibold text-primary hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {receipt.receiptNumber}
        </Link>
      ),
    },
    {
      key: 'document',
      label: 'Document',
      render: (receipt: ReceiptRecord) => {
        const entry = DOCUMENT_TYPES[receipt.type] ?? { label: receipt.type, tone: 'neutral' as const };
        return (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge tone={entry.tone}>{entry.label}</Badge>
            <span className="tabular truncate text-base-content/70">
              {receipt.documentNumber || '—'}
            </span>
          </span>
        );
      },
    },
    {
      key: 'partyName',
      label: 'Tiers',
      render: (receipt: ReceiptRecord) => (
        <span className="block min-w-0 truncate">
          {receipt.partyName?.trim() ||
            (receipt.type === 'purchase' ? 'Fournisseur' : 'Client comptoir')}
        </span>
      ),
    },
    {
      key: 'paymentLabel',
      label: 'Type de règlement',
      hideOnMobile: true,
      render: (receipt: ReceiptRecord) => (
        <Badge tone={LABEL_TONES[receipt.paymentLabel] ?? 'neutral'}>
          {PAYMENT_LABEL_LABELS[receipt.paymentLabel] ?? receipt.paymentLabel}
        </Badge>
      ),
    },
    {
      key: 'paymentMethod',
      label: 'Moyen',
      render: (receipt: ReceiptRecord) => <span>{receipt.paymentMethod}</span>,
    },
    {
      key: 'amount',
      label: 'Montant',
      className: 'text-right whitespace-nowrap',
      render: (receipt: ReceiptRecord) => <MoneyText value={receipt.amount} bold />,
    },
  ] satisfies Column<ReceiptRecord>[];

  const hasFilters =
    Boolean(debouncedSearch) || type !== 'all' || Boolean(paymentMethod) || Boolean(from) || Boolean(to);

  const resetFilters = () => {
    setSearch('');
    setType('all');
    setPaymentMethod('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Finances"
        title="Reçus"
        description="Registre de tous les encaissements et décaissements, toutes origines confondues (ventes, achats, prestations), avec le reçu imprimable correspondant."
      />

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher un reçu, un document ou un client…"
        filters={
          <div className="w-full sm:w-52">
            <FilterSelect
              value={type}
              onChange={(value) => {
                setType(isTypeFilter(value) ? value : 'all');
                setPage(1);
              }}
              options={TYPE_OPTIONS}
              placeholder="Toutes les origines"
            />
          </div>
        }
        secondaryFilters={
          <>
            <label className="flex w-full flex-col gap-1 sm:w-48">
              <span className="text-xs text-base-content/60">Moyen de paiement</span>
              <select
                className="select select-bordered min-h-11 w-full sm:min-h-0"
                value={paymentMethod}
                onChange={(event) => {
                  setPaymentMethod(event.target.value);
                  setPage(1);
                }}
              >
                {methodOptions.map((option) => (
                  <option key={option.value || 'all'} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex w-full flex-col gap-1 sm:w-40">
              <span className="text-xs text-base-content/60">Du</span>
              <DatePicker
                value={from}
                onChange={(value) => {
                  setFrom(value);
                  setPage(1);
                }}
                placeholder="jj/mm/aaaa"
              />
            </div>

            <div className="flex w-full flex-col gap-1 sm:w-40">
              <span className="text-xs text-base-content/60">Au</span>
              <DatePicker
                value={to}
                onChange={(value) => {
                  setTo(value);
                  setPage(1);
                }}
                placeholder="jj/mm/aaaa"
              />
            </div>
          </>
        }
        secondaryCount={(paymentMethod ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0)}
        actions={
          <>
            {hasFilters && (
              <Tooltip label="Réinitialiser les filtres">
                <ToolbarButton onClick={resetFilters}>Réinitialiser</ToolbarButton>
              </Tooltip>
            )}
            <Tooltip label="Recharger la liste">
              <ToolbarButton onClick={refresh}>Actualiser</ToolbarButton>
            </Tooltip>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-base-content/60">
        <span>
          {isLoading
            ? 'Chargement…'
            : `${formatNumber(total)} reçu${total > 1 ? 's' : ''} ${
                total > 1 ? 'trouvés' : 'trouvé'
              }`}
        </span>
        {(from || to) && (
          <span className="tabular">
            Période : {from ? formatDateShort(from) : '—'} → {to ? formatDateShort(to) : '—'}
          </span>
        )}
      </div>

      {isLoading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState title="Impossible de charger les reçus" description={error} onRetry={refresh} />
        </div>
      ) : receipts.length === 0 ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <EmptyState
            title={hasFilters ? 'Aucun reçu ne correspond' : 'Aucun reçu enregistré'}
            description={
              hasFilters
                ? 'Élargissez la période, l’origine ou le moyen de paiement pour voir plus de reçus.'
                : 'Chaque encaissement d’une vente ou d’une prestation, et chaque règlement d’un achat, produit ici un reçu numéroté.'
            }
            action={
              hasFilters ? (
                <button
                  type="button"
                  className="btn btn-ghost min-h-11 sm:min-h-0"
                  onClick={resetFilters}
                >
                  Réinitialiser les filtres
                </button>
              ) : (
                <Link href="/ventes" className="btn btn-primary min-h-11 sm:min-h-0">
                  Voir les ventes
                </Link>
              )
            }
          />
        </div>
      ) : (
        <ResponsiveTable
          columns={columns}
          data={receipts}
          getRowKey={(receipt) => receipt.id}
          tableClassName="table-sm"
          actionsClassName="w-24"
          actions={(receipt) => (
            <RowActions>
              <IconAction
                icon="receipt"
                label="Ouvrir le reçu (impression, exports)"
                href={`/recus/${receipt.id}`}
              />
            </RowActions>
          )}
        />
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
