'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  InfoRow,
  MoneyText,
  PageSection,
  SkeletonCards,
  SkeletonTable,
  StatCardDelta,
  StatusBadge,
} from '@/components/design-system';
import { RoleGate, usePermission } from '@/components/role-gate';
import {
  PaySupplierDebtModal,
  SupplierFormModal,
  type SupplierPurchaseEntry,
  type SupplierRecord,
  type SupplierStatsRecord,
} from '@/components/fournisseurs/fournisseurs-modals';
import { formatDateShort } from '@/lib/date-format';
import { formatCurrency, formatNumber } from '@/lib/format';
import { useViewStateRehydration, writeViewState } from '@/lib/view-state';

/**
 * Fiche fournisseur (README §7.3) : coordonnées, statistiques, dernières
 * factures d'achat et produits les plus achetés.
 *
 * Les agrégats (`totalPurchased`, `totalPaid`, `balance`, panier moyen)
 * viennent calculés du serveur : rien n'est additionné en JavaScript ici.
 */

type ViewState = {
  /** Les factures annulées sont masquables — choix mémorisé au retour arrière. */
  showCancelled: boolean;
};

type TopProduct = { productName: string; quantity: number; amount: number };

export default function FournisseurDetailPage() {
  const params = useParams<{ id: string }>();
  const rawId = Array.isArray(params?.id) ? params?.id[0] : params?.id;
  const supplierId = Number(rawId);
  const isValidId = Number.isInteger(supplierId) && supplierId > 0;

  const [stats, setStats] = useState<SupplierStatsRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [showCancelled, setShowCancelled] = useState(true);

  // Une modale = un état booléen (§5.3).
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isPayOpen, setIsPayOpen] = useState(false);
  const [isStatusDialogOpen, setIsStatusDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canUpdate = usePermission('suppliers.update');
  const canDelete = usePermission('suppliers.delete');
  const canPay = usePermission('payments.create');

  const rehydrated = useViewStateRehydration<ViewState>('fournisseur-detail', (saved) => {
    if (saved.showCancelled !== undefined) setShowCancelled(saved.showCancelled);
  });

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!rehydrated) return;

    if (!isValidId) {
      setIsLoading(false);
      setError('Identifiant de fournisseur invalide.');
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(`/api/fournisseurs/${supplierId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (response.status === 404) throw new Error('Fournisseur introuvable.');
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error ?? 'Chargement de la fiche impossible');
        }

        setStats(await response.json());
      } catch (caught: any) {
        if (caught?.name === 'AbortError') return;
        setError(caught?.message ?? 'Chargement de la fiche impossible');
      } finally {
        setIsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [rehydrated, isValidId, supplierId, reloadToken]);

  useEffect(() => {
    if (!rehydrated) return;
    writeViewState<ViewState>('fournisseur-detail', { showCancelled });
  }, [rehydrated, showCancelled]);

  const handleToggleStatus = async () => {
    if (!stats) return;
    const reactivate = !stats.supplier.isActive;
    setIsSubmitting(true);

    try {
      const response = await fetch(
        `/api/fournisseurs/${stats.supplier.id}${reactivate ? '?reactivate=true' : ''}`,
        { method: 'DELETE', credentials: 'same-origin' },
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Opération impossible');
      }

      toast.success(reactivate ? 'Fournisseur réactivé' : 'Fournisseur désactivé');
      setIsStatusDialogOpen(false);
      refresh();
    } catch (caught: any) {
      toast.error(caught?.message ?? 'Opération impossible');
    } finally {
      setIsSubmitting(false);
    }
  };

  const purchaseColumns: Column<SupplierPurchaseEntry>[] = [
    {
      key: 'reference',
      label: 'N° facture',
      primary: true,
      render: (purchase) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{purchase.reference}</span>
          {purchase.status === 'cancelled' && <Badge tone="error">Annulée</Badge>}
        </div>
      ),
    },
    {
      key: 'supplierReference',
      label: 'Réf. fournisseur',
      hideOnMobile: true,
      render: (purchase) => purchase.supplierReference || '—',
    },
    {
      key: 'date',
      label: 'Date',
      render: (purchase) => formatDateShort(purchase.date),
    },
    {
      key: 'dueDate',
      label: 'Échéance',
      hideOnMobile: true,
      render: (purchase) => formatDateShort(purchase.dueDate),
    },
    {
      key: 'total',
      label: 'Total',
      render: (purchase) => <MoneyText value={purchase.total} />,
    },
    {
      key: 'amountPaid',
      label: 'Payé',
      render: (purchase) => <MoneyText value={purchase.amountPaid} />,
    },
    {
      key: 'remainingAmount',
      label: 'Reste',
      render: (purchase) => <MoneyText value={purchase.remainingAmount} colored bold />,
    },
    {
      key: 'paymentStatus',
      label: 'Statut',
      render: (purchase) => <StatusBadge status={purchase.paymentStatus} kind="payment" />,
    },
  ];

  const productColumns: Column<TopProduct>[] = [
    {
      key: 'productName',
      label: 'Produit',
      primary: true,
      render: (product) => product.productName,
    },
    {
      key: 'quantity',
      label: 'Quantité',
      render: (product) => (
        <span className="tabular">{formatNumber(product.quantity, 2)}</span>
      ),
    },
    {
      key: 'amount',
      label: 'Montant',
      render: (product) => <MoneyText value={product.amount} />,
    },
  ];

  const supplier: SupplierRecord | null = stats?.supplier ?? null;
  const purchases = stats
    ? showCancelled
      ? stats.recentPurchases
      : stats.recentPurchases.filter((purchase) => purchase.status !== 'cancelled')
    : [];

  if (error && !stats) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Commercial"
          title="Fiche fournisseur"
          description="Coordonnées, achats et dettes."
        />
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          <ErrorState title="Fiche indisponible" description={error} onRetry={refresh} />
          <div className="flex justify-center pb-6">
            <Link href="/fournisseurs" className="btn btn-ghost min-h-11">
              Retour à la liste des fournisseurs
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || !stats || !supplier) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Commercial"
          title="Fiche fournisseur"
          description="Coordonnées, achats et dettes."
        />
        <SkeletonCards count={4} />
        <SkeletonTable rows={5} cols={5} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Commercial"
        title={supplier.name}
        description={
          [supplier.phone, supplier.address].filter(Boolean).join(' · ') ||
          'Aucune coordonnée enregistrée.'
        }
        actions={
          <>
            {canUpdate && (
              <button
                type="button"
                onClick={() => setIsFormOpen(true)}
                className="btn btn-ghost min-h-11 border border-base-300"
              >
                Modifier
              </button>
            )}
            {canPay && supplier.balance > 0.001 && (
              <button
                type="button"
                onClick={() => setIsPayOpen(true)}
                className="btn btn-primary min-h-11"
              >
                Payer une dette
              </button>
            )}
            {canDelete &&
              (supplier.isActive ? (
                <button
                  type="button"
                  onClick={() => setIsStatusDialogOpen(true)}
                  className="btn btn-ghost min-h-11 text-error"
                >
                  Désactiver
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsStatusDialogOpen(true)}
                  className="btn btn-ghost min-h-11"
                >
                  Réactiver
                </button>
              ))}
            <Link href={`/fournisseurs/${supplier.id}/paiements`} className="btn btn-ghost min-h-11">
              Règlements
            </Link>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {supplier.isActive ? (
          <Badge tone="success">Fournisseur actif</Badge>
        ) : (
          <Badge tone="neutral">Fournisseur désactivé</Badge>
        )}
        <Badge tone={supplier.balance > 0.001 ? 'warning' : 'success'}>
          {supplier.balance > 0.001 ? 'Dette en cours' : 'À jour'}
        </Badge>
      </div>

      {/* Rafraîchissement en échec : on garde la fiche affichée et on prévient. */}
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          <span>{error}</span>
          <button type="button" onClick={refresh} className="btn btn-ghost btn-sm min-h-11">
            Réessayer
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCardDelta
          label="Achats"
          value={formatNumber(stats.purchaseCount)}
          hint={`Panier moyen : ${formatCurrency(stats.averageBasket)}`}
          tone="info"
        />
        <StatCardDelta
          label="Total acheté"
          value={<MoneyText value={stats.totalPurchased} />}
          hint={`Premier achat : ${formatDateShort(stats.firstPurchaseDate)}`}
          tone="primary"
        />
        <StatCardDelta
          label="Total payé"
          value={<MoneyText value={stats.totalPaid} />}
          hint={`Dernier achat : ${formatDateShort(stats.lastPurchaseDate)}`}
          tone="success"
        />
        <StatCardDelta
          label="Dette restante"
          value={<MoneyText value={stats.balance} />}
          hint="Calculée depuis les factures d'achat"
          tone={stats.balance > 0.001 ? 'error' : 'success'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <h2 className="text-base font-semibold">Coordonnées</h2>
          <div className="mt-2 divide-y divide-base-200">
            <InfoRow label="Téléphone">{supplier.phone || '—'}</InfoRow>
            <InfoRow label="Adresse">{supplier.address || '—'}</InfoRow>
            <InfoRow label="Premier achat">{formatDateShort(stats.firstPurchaseDate)}</InfoRow>
            <InfoRow label="Dernier achat">{formatDateShort(stats.lastPurchaseDate)}</InfoRow>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="text-base font-semibold">Notes</h2>
          <p className="mt-2 text-sm leading-6 whitespace-pre-line text-base-content/70">
            {supplier.notes || 'Aucune note enregistrée pour ce fournisseur.'}
          </p>
        </Card>
      </div>

      <PageSection
        title="Dernières factures d'achat"
        subtitle="Les 10 achats les plus récents, toutes situations confondues."
        actions={
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={showCancelled}
              onChange={(event) => setShowCancelled(event.target.checked)}
            />
            Afficher les factures annulées
          </label>
        }
      >
        {purchases.length === 0 ? (
          <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
            <EmptyState
              title="Aucune facture d'achat"
              description={
                showCancelled
                  ? "Aucun achat n'est encore rattaché à ce fournisseur."
                  : 'Aucune facture active : décochez le filtre pour voir les factures annulées.'
              }
              action={
                <Link href="/achats" className="btn btn-primary min-h-11">
                  Enregistrer un achat
                </Link>
              }
            />
          </div>
        ) : (
          <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
            <ResponsiveTable
              columns={purchaseColumns}
              data={purchases}
              getRowKey={(purchase) => purchase.id}
              emptyMessage="Aucune facture d'achat."
            />
          </div>
        )}
      </PageSection>

      <PageSection
        title="Produits les plus achetés"
        subtitle="Classement par montant cumulé chez ce fournisseur."
      >
        {stats.topProducts.length === 0 ? (
          <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
            <EmptyState
              title="Aucun produit"
              description="Les produits achetés chez ce fournisseur apparaîtront ici."
            />
          </div>
        ) : (
          <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
            <ResponsiveTable
              columns={productColumns}
              data={stats.topProducts}
              getRowKey={(product) => product.productName}
              emptyMessage="Aucun produit."
            />
          </div>
        )}
      </PageSection>

      {/* Modales — une par état booléen */}
      <SupplierFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        supplier={supplier}
        onSaved={refresh}
      />

      <PaySupplierDebtModal
        isOpen={isPayOpen}
        onClose={() => setIsPayOpen(false)}
        supplierId={supplier.id}
        supplierName={supplier.name}
        onPaid={refresh}
      />

      <ConfirmDialog
        isOpen={isStatusDialogOpen}
        onClose={() => setIsStatusDialogOpen(false)}
        onConfirm={handleToggleStatus}
        isSubmitting={isSubmitting}
        tone={supplier.isActive ? 'error' : 'success'}
        title={supplier.isActive ? 'Désactiver le fournisseur' : 'Réactiver le fournisseur'}
        confirmLabel={supplier.isActive ? 'Désactiver' : 'Réactiver'}
        message={
          supplier.isActive ? (
            <>
              <strong>{supplier.name}</strong> ne sera plus proposé dans les nouveaux achats. La
              fiche n&apos;est <strong>pas supprimée</strong> : son historique et ses dettes
              restent consultables.
            </>
          ) : (
            <>
              <strong>{supplier.name}</strong> redeviendra disponible dans les nouveaux achats.
            </>
          )
        }
      />
    </div>
  );
}
