'use client';

/**
 * Fiche client (README §7.2).
 *
 * `GET /api/clients/[id]` renvoie `customer`, les agrégats (`invoiceCount`,
 * `totalInvoiced`, `totalPaid`, `balance`, `averageBasket`), les bornes d'achat,
 * `creditLimitExceeded`, `topProducts` et `recentInvoices`. Aucun total n'est
 * stocké : tout est calculé à la lecture (README §15).
 *
 * Les 5 états sont couverts : squelette au chargement, `ErrorState` avec
 * « Réessayer », état vide explicite pour les factures et les produits, état
 * nominal, et toast pour le retour d'action.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  InfoRow,
  MiniStat,
  MoneyText,
  PageSection,
  QuantityText,
  SkeletonCards,
  SkeletonTable,
  StatusBadge,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import {
  PaymentModal,
  readApiError,
  type CustomerStatsRecord,
} from '@/components/clients/clients-modals';
import { formatDateShort } from '@/lib/date-format';
import { formatNumber } from '@/lib/format';

type InvoiceRow = CustomerStatsRecord['recentInvoices'][number];
type TopProductRow = CustomerStatsRecord['topProducts'][number];

export default function ClientDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const customerId = Number(params?.id);

  const canPay = usePermission('payments.create');

  const [stats, setStats] = useState<CustomerStatsRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  /* Un état booléen par modale (§8.3 règle 1). */
  const [showPaymentModal, setShowPaymentModal] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!Number.isInteger(customerId) || customerId <= 0) {
        setError('Identifiant client invalide.');
        setStatus(400);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/clients/${customerId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        });
        setStatus(response.status);

        if (!response.ok) {
          throw new Error(await readApiError(response, 'La fiche du client n’a pas pu être chargée.'));
        }

        setStats((await response.json()) as CustomerStatsRecord);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setStats(null);
        setError(
          caught instanceof Error ? caught.message : 'La fiche du client n’a pas pu être chargée.',
        );
      } finally {
        setIsLoading(false);
      }
    },
    [customerId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  const closePaymentModal = useCallback(() => setShowPaymentModal(false), []);

  const invoiceColumns = [
    {
      key: 'invoiceNumber',
      label: 'Facture',
      primary: true,
      render: (invoice: InvoiceRow) => (
        <Link
          href={`/ventes/${invoice.id}`}
          className="font-semibold text-primary hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {invoice.invoiceNumber}
        </Link>
      ),
    },
    {
      key: 'date',
      label: 'Date',
      className: 'whitespace-nowrap',
      render: (invoice: InvoiceRow) => (
        <span className="tabular text-base-content/70">{formatDateShort(invoice.date)}</span>
      ),
    },
    {
      key: 'total',
      label: 'Total',
      className: 'text-right whitespace-nowrap',
      render: (invoice: InvoiceRow) => <MoneyText value={invoice.total} bold />,
    },
    {
      key: 'amountPaid',
      label: 'Payé',
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (invoice: InvoiceRow) => <MoneyText value={invoice.amountPaid} />,
    },
    {
      key: 'remainingAmount',
      label: 'Reste',
      className: 'text-right whitespace-nowrap',
      render: (invoice: InvoiceRow) => (
        <MoneyText value={invoice.remainingAmount} colored bold={invoice.remainingAmount > 0.001} />
      ),
    },
    {
      key: 'paymentStatus',
      label: 'Statut',
      render: (invoice: InvoiceRow) => <StatusBadge status={invoice.paymentStatus} kind="payment" />,
    },
  ] satisfies Column<InvoiceRow>[];

  const topProductColumns = [
    {
      key: 'productName',
      label: 'Produit',
      primary: true,
      render: (product: TopProductRow) => <span className="font-medium">{product.productName}</span>,
    },
    {
      key: 'quantity',
      label: 'Quantité',
      className: 'text-right whitespace-nowrap',
      render: (product: TopProductRow) => <QuantityText value={product.quantity} />,
    },
    {
      key: 'amount',
      label: 'Montant',
      className: 'text-right whitespace-nowrap',
      render: (product: TopProductRow) => <MoneyText value={product.amount} />,
    },
  ] satisfies Column<TopProductRow>[];

  const customer = stats?.customer ?? null;
  const notFound = status === 404;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow="Fiche client"
        title={customer?.name ?? (isLoading ? 'Chargement…' : 'Client')}
        description={
          customer
            ? customer.phone || customer.address
              ? [customer.phone, customer.address].filter(Boolean).join(' · ')
              : 'Coordonnées non renseignées.'
            : 'Détail du client, encours, historique des achats et encaissements.'
        }
        actions={
          <>
            <Link href="/clients" className="btn btn-ghost min-h-11 sm:min-h-0">
              Retour à la liste
            </Link>
            {customer && (
              <Link
                href={`/clients/${customer.id}/paiements`}
                className="btn btn-outline min-h-11 sm:min-h-0"
              >
                Historique des paiements
              </Link>
            )}
            {canPay && customer && stats && stats.balance > 0.001 && (
              <button
                type="button"
                className="btn btn-primary min-h-11 sm:min-h-0"
                onClick={() => setShowPaymentModal(true)}
              >
                Enregistrer un paiement
              </button>
            )}
          </>
        }
      />

      {isLoading && (
        <>
          <SkeletonCards count={4} />
          <SkeletonTable rows={5} cols={5} />
        </>
      )}

      {!isLoading && error && (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          {notFound ? (
            <EmptyState
              title="Client introuvable"
              description="Cette fiche n’existe pas ou a été désactivée. Revenez à la liste pour choisir un autre client."
              action={
                <Link href="/clients" className="btn btn-primary min-h-11 sm:min-h-0">
                  Retour à la liste des clients
                </Link>
              }
            />
          ) : (
            <ErrorState
              title="Impossible de charger la fiche client"
              description={error}
              onRetry={() => setReloadToken((token) => token + 1)}
            />
          )}
        </div>
      )}

      {!isLoading && !error && stats && customer && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <MiniStat
              label="Solde à payer"
              tone={stats.balance > 0.001 ? 'error' : 'success'}
              value={<MoneyText value={stats.balance} colored bold />}
            />
            <MiniStat label="Total facturé" value={<MoneyText value={stats.totalInvoiced} />} />
            <MiniStat label="Total payé" value={<MoneyText value={stats.totalPaid} />} />
            <MiniStat label="Panier moyen" value={<MoneyText value={stats.averageBasket} />} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">Informations</h2>
                {customer.isActive ? (
                  <Badge tone="success">Actif</Badge>
                ) : (
                  <Badge tone="neutral">Inactif</Badge>
                )}
                {stats.creditLimitExceeded && <Badge tone="warning">Plafond dépassé</Badge>}
              </div>

              <div className="mt-2 divide-y divide-base-200/70">
                <InfoRow label="Téléphone">
                  {customer.phone ? (
                    <span className="tabular">{customer.phone}</span>
                  ) : (
                    <span className="font-normal text-base-content/50">Non renseigné</span>
                  )}
                </InfoRow>
                <InfoRow label="Adresse">
                  {customer.address || (
                    <span className="font-normal text-base-content/50">Non renseignée</span>
                  )}
                </InfoRow>
                <InfoRow label="Plafond de crédit">
                  {customer.creditLimit > 0 ? (
                    <MoneyText value={customer.creditLimit} />
                  ) : (
                    <span className="font-normal text-base-content/50">Aucun plafond</span>
                  )}
                </InfoRow>
                <InfoRow label="Nombre de factures">
                  <span className="tabular">{formatNumber(stats.invoiceCount)}</span>
                </InfoRow>
                <InfoRow label="Premier achat">{formatDateShort(stats.firstPurchaseDate)}</InfoRow>
                <InfoRow label="Dernier achat">{formatDateShort(stats.lastPurchaseDate)}</InfoRow>
                <InfoRow label="Fiche créée le">{formatDateShort(customer.createdAt)}</InfoRow>
                <InfoRow label="Informations utiles">
                  <span className="font-normal text-base-content/70">
                    {customer.notes || '—'}
                  </span>
                </InfoRow>
              </div>
            </Card>

            <Card className="space-y-3">
              <h2 className="text-base font-semibold">Encours</h2>
              <div className="space-y-1">
                <InfoRow label="Total facturé">
                  <MoneyText value={stats.totalInvoiced} />
                </InfoRow>
                <InfoRow label="Total encaissé">
                  <MoneyText value={stats.totalPaid} />
                </InfoRow>
                <InfoRow label="Reste à payer">
                  <MoneyText value={stats.balance} colored bold />
                </InfoRow>
              </div>

              {stats.creditLimitExceeded ? (
                <p className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                  Le solde dépasse le plafond de crédit de{' '}
                  <MoneyText value={customer.creditLimit} />. L&apos;application avertit, elle ne
                  bloque pas la vente.
                </p>
              ) : (
                <p className="rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                  Encours dans le plafond autorisé.
                </p>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <Link
                  href={`/clients/${customer.id}/paiements`}
                  className="btn btn-ghost min-h-11 border border-base-300 sm:min-h-0"
                >
                  Voir les encaissements
                </Link>
                {canPay && stats.balance > 0.001 && (
                  <button
                    type="button"
                    className="btn btn-primary min-h-11 sm:min-h-0"
                    onClick={() => setShowPaymentModal(true)}
                  >
                    Enregistrer un paiement
                  </button>
                )}
              </div>
            </Card>
          </div>

          <PageSection
            title="Dernières factures"
            subtitle="Cliquez sur une ligne pour ouvrir la facture."
          >
            {stats.recentInvoices.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucune facture"
                  description="Ce client n’a pas encore d’achat enregistré. Créez une vente depuis le module Ventes pour alimenter son historique."
                  action={
                    <Link href="/ventes" className="btn btn-primary min-h-11 sm:min-h-0">
                      Aller aux ventes
                    </Link>
                  }
                />
              </div>
            ) : (
              <ResponsiveTable
                columns={invoiceColumns}
                data={stats.recentInvoices}
                getRowKey={(invoice) => invoice.id}
                tableClassName="table-sm"
                onRowClick={(invoice) => router.push(`/ventes/${invoice.id}`)}
              />
            )}
          </PageSection>

          <PageSection
            title="Produits les plus achetés"
            subtitle="Cinq produits les plus achetés par ce client, par montant cumulé."
          >
            {stats.topProducts.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucun produit acheté"
                  description="Les produits apparaîtront ici dès la première vente enregistrée pour ce client."
                />
              </div>
            ) : (
              <ResponsiveTable
                columns={topProductColumns}
                data={stats.topProducts}
                getRowKey={(product) => product.productName}
                tableClassName="table-sm"
              />
            )}
          </PageSection>
        </>
      )}

      {customer && (
        <PaymentModal
          isOpen={showPaymentModal}
          onClose={closePaymentModal}
          customer={{ id: customer.id, name: customer.name, balance: stats?.balance ?? 0 }}
          onRecorded={(payment) => {
            toast.success(`Paiement enregistré — reçu ${payment.receiptNumber}.`);
            setReloadToken((token) => token + 1);
          }}
        />
      )}
    </div>
  );
}
