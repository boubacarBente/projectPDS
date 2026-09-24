'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/search-filter';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Badge,
  EmptyState,
  ErrorState,
  MoneyText,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
} from '@/components/design-system';
import { RoleGate, usePermission } from '@/components/role-gate';
import {
  PAYMENT_LABELS,
  PaySupplierDebtModal,
  type SupplierStatsRecord,
} from '@/components/fournisseurs/fournisseurs-modals';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';
import { clampPage, useViewStateRehydration, writeViewState } from '@/lib/view-state';

/**
 * Règlements d'un fournisseur (README §7.3 « suivi des paiements »).
 *
 * L'historique vient de `GET /api/fournisseurs/[id]/paiements` (les `payments`
 * de type `purchase` rattachés aux factures de ce fournisseur) ; la modale
 * « Payer une dette » poste sur `POST /api/paiements` avec `type: 'purchase'`.
 */

const PAGE_LIMIT = 20;

type SupplierPaymentRecord = {
  id: number;
  receiptNumber: string;
  referenceId: number;
  amount: number;
  paymentMethod: string;
  paymentLabel: string;
  date: string;
  notes: string | null;
  userName: string | null;
};

type ViewState = { page: number };

const PAYMENT_TONES: Record<string, 'success' | 'warning' | 'info' | 'neutral'> = {
  full: 'success',
  balance: 'info',
  deposit: 'warning',
};

export default function FournisseurPaiementsPage() {
  const params = useParams<{ id: string }>();
  const rawId = Array.isArray(params?.id) ? params?.id[0] : params?.id;
  const supplierId = Number(rawId);
  const isValidId = Number.isInteger(supplierId) && supplierId > 0;

  const [page, setPage] = useState(1);

  const [payments, setPayments] = useState<SupplierPaymentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stats, setStats] = useState<SupplierStatsRecord | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Une modale = un état booléen (§5.3).
  const [isPayOpen, setIsPayOpen] = useState(false);

  const canPay = usePermission('payments.create');

  const rehydrated = useViewStateRehydration<ViewState>('fournisseurs-paiements', (saved) => {
    if (saved.page) setPage(saved.page);
  });

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  /* ── Historique des règlements ──────────────────────────────────── */

  const load = useCallback(
    async (signal: AbortSignal) => {
      setIsLoading(true);
      setError(null);
      let clampedAway = false;

      try {
        const params = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
        const response = await fetch(
          `/api/fournisseurs/${supplierId}/paiements?${params.toString()}`,
          { cache: 'no-store', credentials: 'same-origin', signal },
        );

        if (response.status === 404) throw new Error('Fournisseur introuvable.');
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error ?? 'Chargement des règlements impossible');
        }

        const payload = await response.json();
        const nextTotalPages = Math.max(1, Number(payload.totalPages ?? 1));

        // Page restaurée devenue hors bornes après des annulations : on corrige
        // au lieu d'afficher une liste vide (`clampPage`, §5).
        const clamped = clampPage(page, nextTotalPages);
        if (clamped !== null) {
          clampedAway = true;
          setPage(clamped);
          return;
        }

        setPayments(Array.isArray(payload.data) ? payload.data : []);
        setTotal(Number(payload.total ?? 0));
        setTotalPages(nextTotalPages);
      } catch (caught: any) {
        if (caught?.name === 'AbortError') return;
        setError(caught?.message ?? 'Chargement des règlements impossible');
      } finally {
        if (!clampedAway) setIsLoading(false);
      }
    },
    [page, supplierId],
  );

  useEffect(() => {
    if (!rehydrated || !isValidId) {
      if (rehydrated && !isValidId) {
        setIsLoading(false);
        setError('Identifiant de fournisseur invalide.');
      }
      return;
    }

    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [rehydrated, isValidId, load, reloadToken]);

  /* ── Fiche du fournisseur (en-tête et synthèse) ─────────────────── */

  useEffect(() => {
    if (!rehydrated || !isValidId) return;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/fournisseurs/${supplierId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) return; // L'en-tête dégrade proprement, la liste reste utile.
        setStats(await response.json());
      } catch (caught: any) {
        if (caught?.name !== 'AbortError') setStats(null);
      }
    })();

    return () => controller.abort();
  }, [rehydrated, isValidId, supplierId, reloadToken]);

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState<ViewState>('fournisseurs-paiements', { page });
  }, [rehydrated, page]);

  const columns: Column<SupplierPaymentRecord>[] = [
    {
      key: 'receiptNumber',
      label: 'Reçu',
      primary: true,
      render: (payment) => <span className="font-medium">{payment.receiptNumber}</span>,
    },
    {
      key: 'date',
      label: 'Date',
      render: (payment) => formatDateShort(payment.date),
    },
    {
      key: 'amount',
      label: 'Montant',
      render: (payment) => <MoneyText value={payment.amount} bold />,
    },
    {
      key: 'paymentMethod',
      label: 'Moyen',
      render: (payment) => payment.paymentMethod,
    },
    {
      key: 'paymentLabel',
      label: 'Type',
      render: (payment) => (
        <Badge tone={PAYMENT_TONES[payment.paymentLabel] ?? 'neutral'}>
          {PAYMENT_LABELS[payment.paymentLabel] ?? payment.paymentLabel}
        </Badge>
      ),
    },
    {
      key: 'userName',
      label: 'Saisi par',
      hideOnMobile: true,
      render: (payment) => payment.userName || '—',
    },
    {
      key: 'notes',
      label: 'Notes',
      hideOnMobile: true,
      render: (payment) => payment.notes || '—',
    },
  ];

  const supplier = stats?.supplier ?? null;
  const balance = supplier?.balance ?? 0;
  const hasDebt = balance > 0.001;

  if (error && payments.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Commercial"
          title="Règlements fournisseur"
          description="Historique des paiements et dettes restantes."
        />
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState title="Règlements indisponibles" description={error} onRetry={refresh} />
          <div className="flex justify-center pb-6">
            <Link href="/fournisseurs" className="btn btn-ghost min-h-11">
              Retour à la liste des fournisseurs
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Commercial"
        title={supplier ? `Règlements — ${supplier.name}` : 'Règlements fournisseur'}
        description="Historique des règlements et suivi de la dette restante."
        actions={
          <>
            <Link href={`/fournisseurs/${supplierId}`} className="btn btn-ghost min-h-11">
              Fiche fournisseur
            </Link>
            <RoleGate action="payments.create">
              <button
                type="button"
                onClick={() => setIsPayOpen(true)}
                className="btn btn-primary min-h-11"
              >
                Payer une dette
              </button>
            </RoleGate>
          </>
        }
      />

      {!stats ? (
        <SkeletonCards count={3} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCardDelta
            label="Total acheté"
            value={<MoneyText value={stats.totalPurchased} />}
            hint={`${formatNumber(stats.purchaseCount)} facture(s) d'achat`}
            tone="primary"
          />
          <StatCardDelta
            label="Total réglé"
            value={<MoneyText value={stats.totalPaid} />}
            hint={`${formatNumber(total)} règlement(s) enregistré(s)`}
            tone="success"
          />
          <StatCardDelta
            label="Dette restante"
            value={<MoneyText value={balance} />}
            hint={hasDebt ? 'Reste à régler aux fournisseurs' : 'Aucune dette en cours'}
            tone={hasDebt ? 'error' : 'success'}
          />
        </div>
      )}

      {isLoading && payments.length === 0 ? (
        <SkeletonTable rows={6} cols={5} />
      ) : payments.length === 0 ? (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <EmptyState
            title="Aucun règlement enregistré"
            description={
              hasDebt
                ? 'Enregistrez un premier règlement pour réduire la dette de ce fournisseur.'
                : "Aucun paiement n'a encore été enregistré pour ce fournisseur."
            }
            action={
              canPay ? (
                <button
                  type="button"
                  onClick={() => setIsPayOpen(true)}
                  className="btn btn-primary min-h-11"
                >
                  Payer une dette
                </button>
              ) : (
                <Link href={`/fournisseurs/${supplierId}`} className="btn btn-ghost min-h-11">
                  Voir la fiche fournisseur
                </Link>
              )
            }
          />
        </div>
      ) : (
        <div className={isLoading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
            <ResponsiveTable
              columns={columns}
              data={payments}
              getRowKey={(payment) => payment.id}
              emptyMessage="Aucun règlement."
            />
          </div>
        </div>
      )}

      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

      <PaySupplierDebtModal
        isOpen={isPayOpen}
        onClose={() => setIsPayOpen(false)}
        supplierId={isValidId ? supplierId : null}
        supplierName={supplier?.name}
        onPaid={refresh}
      />
    </div>
  );
}
