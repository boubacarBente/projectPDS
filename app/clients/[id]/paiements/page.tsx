'use client';

/**
 * Historique des encaissements d'un client (README §7.2, §11, §15).
 *
 * `GET /api/paiements?customerId=<id>&page=&limit=` renvoie l'enveloppe
 * paginée standard ; chaque ligne ouvre le reçu correspondant
 * (`/recus/[paymentId]`, page produite par le module Ventes/Reçus).
 *
 * Le contexte client (nom, total facturé, total payé, solde) vient de
 * `GET /api/clients/[id]` : ces montants sont **calculés** à la lecture, jamais
 * stockés (README §15).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Pagination } from '@/components/search-filter';
import {
  Badge,
  EmptyState,
  ErrorState,
  MiniStat,
  MoneyText,
  PageSection,
  SkeletonCards,
  SkeletonTable,
  type BadgeTone,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import {
  PaymentModal,
  readApiError,
  type CustomerRecord,
  type CustomerStatsRecord,
} from '@/components/clients/clients-modals';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';

const PAGE_LIMIT = 10;

type PaymentRecord = {
  id: number;
  receiptNumber: string;
  type: string;
  referenceId: number;
  amount: number;
  paymentMethod: string;
  paymentLabel: string;
  date: string;
  notes: string | null;
  userName: string | null;
};

/** Libellés d'acompte : « deposit / balance / full » (§7). */
const PAYMENT_LABELS: Record<string, { label: string; tone: BadgeTone }> = {
  deposit: { label: 'Acompte', tone: 'info' },
  balance: { label: 'Solde', tone: 'success' },
  full: { label: 'Intégral', tone: 'primary' },
};

export default function ClientPaymentsPage() {
  const params = useParams<{ id: string }>();
  const customerId = Number(params?.id);

  const canPay = usePermission('payments.create');

  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [customer, setCustomer] = useState<CustomerRecord | null>(null);
  const [stats, setStats] = useState<CustomerStatsRecord | null>(null);
  const [isCustomerLoading, setIsCustomerLoading] = useState(true);

  const [reloadToken, setReloadToken] = useState(0);
  const [showPaymentModal, setShowPaymentModal] = useState(false);

  /* Contexte client : nom, total facturé, total payé, solde. */
  useEffect(() => {
    if (!Number.isInteger(customerId) || customerId <= 0) {
      setIsCustomerLoading(false);
      return;
    }

    const controller = new AbortController();
    let active = true;

    void (async () => {
      setIsCustomerLoading(true);
      try {
        const response = await fetch(`/api/clients/${customerId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('unavailable');
        const payload = (await response.json()) as CustomerStatsRecord;
        if (!active) return;
        setStats(payload);
        setCustomer(payload.customer);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        if (!active) return;
        setCustomer(null);
      } finally {
        if (active) setIsCustomerLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [customerId, reloadToken]);

  /* Liste paginée des encaissements. */
  useEffect(() => {
    if (!Number.isInteger(customerId) || customerId <= 0) {
      setError('Identifiant client invalide.');
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    let active = true;

    void (async () => {
      setIsLoading(true);
      setError(null);

      try {
        const query = new URLSearchParams({
          customerId: String(customerId),
          page: String(page),
          limit: String(PAGE_LIMIT),
        });

        const response = await fetch(`/api/paiements?${query.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(
            await readApiError(response, 'Les encaissements n’ont pas pu être chargés.'),
          );
        }

        const payload = (await response.json()) as {
          data?: PaymentRecord[];
          total?: number;
          totalPages?: number;
        };

        if (!active) return;

        const rows = Array.isArray(payload.data) ? payload.data : [];
        const pages = Math.max(1, Number(payload.totalPages ?? 1));

        setPayments(rows);
        setTotal(Number(payload.total ?? rows.length));
        setTotalPages(pages);
        if (page > pages) setPage(pages);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setPayments([]);
        setError(
          caught instanceof Error ? caught.message : 'Les encaissements n’ont pas pu être chargés.',
        );
      } finally {
        if (active) setIsLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [customerId, page, reloadToken]);

  const closePaymentModal = useCallback(() => setShowPaymentModal(false), []);

  const paymentColumns = [
    {
      key: 'receiptNumber',
      label: 'Reçu',
      primary: true,
      render: (payment: PaymentRecord) => (
        <Link
          href={`/recus/${payment.id}`}
          className="font-semibold text-primary hover:underline"
          title="Ouvrir le reçu"
        >
          {payment.receiptNumber}
        </Link>
      ),
    },
    {
      key: 'date',
      label: 'Date',
      className: 'whitespace-nowrap',
      render: (payment: PaymentRecord) => (
        <span className="tabular text-base-content/70">{formatDateShort(payment.date)}</span>
      ),
    },
    {
      key: 'amount',
      label: 'Montant',
      className: 'text-right whitespace-nowrap',
      render: (payment: PaymentRecord) => <MoneyText value={payment.amount} bold />,
    },
    {
      key: 'paymentMethod',
      label: 'Moyen',
      render: (payment: PaymentRecord) => <span>{payment.paymentMethod}</span>,
    },
    {
      key: 'paymentLabel',
      label: 'Type',
      hideOnMobile: true,
      render: (payment: PaymentRecord) => {
        const entry = PAYMENT_LABELS[payment.paymentLabel];
        return <Badge tone={entry?.tone ?? 'neutral'}>{entry?.label ?? payment.paymentLabel}</Badge>;
      },
    },
    {
      key: 'notes',
      label: 'Note',
      hideOnMobile: true,
      render: (payment: PaymentRecord) => (
        <span className="text-base-content/60">{payment.notes || '—'}</span>
      ),
    },
    {
      key: 'actions',
      label: 'Reçu',
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (payment: PaymentRecord) => (
        <Link
          href={`/recus/${payment.id}`}
          className="link link-primary text-sm font-medium"
          onClick={(event) => event.stopPropagation()}
        >
          Voir le reçu
        </Link>
      ),
    },
  ] satisfies Column<PaymentRecord>[];

  const balance = stats?.balance ?? 0;
  const hasDebt = balance > 0.001;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Encaissements"
        title={customer ? `Paiements — ${customer.name}` : 'Paiements du client'}
        description="Historique des règlements encaissés, avec le reçu correspondant."
        actions={
          <>
            <Link href={`/clients/${customerId}`} className="btn btn-ghost min-h-11 sm:min-h-0">
              Retour à la fiche
            </Link>
            {canPay && (
              <button
                type="button"
                className="btn btn-primary min-h-11 sm:min-h-0"
                onClick={() => setShowPaymentModal(true)}
                disabled={customer !== null && !hasDebt}
                title={!hasDebt ? 'Aucun solde à encaisser' : 'Enregistrer un paiement'}
              >
                Enregistrer un paiement
              </button>
            )}
          </>
        }
      />

      {isCustomerLoading ? (
        <SkeletonCards count={3} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MiniStat
            label="Total facturé"
            value={<MoneyText value={stats?.totalInvoiced ?? 0} />}
          />
          <MiniStat
            label="Total payé"
            tone="success"
            value={<MoneyText value={stats?.totalPaid ?? 0} />}
          />
          <MiniStat
            label="Solde restant"
            tone={hasDebt ? 'error' : 'success'}
            value={<MoneyText value={balance} colored bold />}
          />
        </div>
      )}

      <PageSection
        title="Historique des encaissements"
        subtitle={
          isLoading
            ? 'Chargement…'
            : `${formatNumber(total)} encaissement${total > 1 ? 's' : ''} enregistré${
                total > 1 ? 's' : ''
              }`
        }
      >
        {isLoading ? (
          <SkeletonTable rows={6} cols={5} />
        ) : error ? (
          <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
            <ErrorState
              title="Impossible de charger les encaissements"
              description={error}
              onRetry={() => setReloadToken((token) => token + 1)}
            />
          </div>
        ) : payments.length === 0 ? (
          <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
            <EmptyState
              title="Aucun paiement enregistré"
              description={
                hasDebt
                  ? 'Ce client présente un solde impayé : enregistrez un premier encaissement pour le lettrer.'
                  : 'Les règlements de ce client apparaîtront ici, avec un lien vers chaque reçu.'
              }
              action={
                canPay && hasDebt ? (
                  <button
                    type="button"
                    className="btn btn-primary min-h-11 sm:min-h-0"
                    onClick={() => setShowPaymentModal(true)}
                  >
                    Enregistrer un paiement
                  </button>
                ) : (
                  <Link href={`/clients/${customerId}`} className="btn btn-ghost min-h-11 sm:min-h-0">
                    Retour à la fiche client
                  </Link>
                )
              }
            />
          </div>
        ) : (
          <ResponsiveTable
            columns={paymentColumns}
            data={payments}
            getRowKey={(payment) => payment.id}
            tableClassName="table-sm"
            emptyMessage="Aucun encaissement pour ce client."
          />
        )}
      </PageSection>

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      {customer && (
        <PaymentModal
          isOpen={showPaymentModal}
          onClose={closePaymentModal}
          customer={{ id: customer.id, name: customer.name, balance }}
          onRecorded={(payment) => {
            toast.success(`Paiement enregistré — reçu ${payment.receiptNumber}.`);
            setReloadToken((token) => token + 1);
          }}
        />
      )}
    </div>
  );
}
