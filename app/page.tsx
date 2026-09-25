'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import {
  Card,
  EmptyState,
  ErrorState,
  MiniStat,
  MoneyText,
  PageSection,
  QuantityText,
  Skeleton,
  SkeletonCards,
  StatCardDelta,
  StatusBadge,
  Badge,
} from '@/components/design-system';
import {
  MonthlyEvolutionChart,
  TopProductsChart,
} from '@/components/dashboard/dashboard-charts';
import { RoleGate } from '@/components/role-gate';
import { formatDateShort, formatDateTime } from '@/lib/date-format';
import { formatPercent } from '@/lib/format';
import type { DashboardSnapshot, PeriodKey } from '@/lib/dashboard';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'day', label: "Aujourd'hui" },
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'year', label: 'Année' },
  { key: 'total', label: 'Total' },
];

export default function DashboardPage() {
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/operations/snapshot?period=${period}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Chargement du tableau de bord impossible');
      }
      setSnapshot((await res.json()) as DashboardSnapshot);
    } catch (err: any) {
      setError(err?.message ?? 'Chargement impossible');
    } finally {
      setIsLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  /* -------------------------------- Erreur -------------------------------- */
  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Pilotage"
          title="Tableau de bord"
          description="Vue d’ensemble de l’activité commerciale."
        />
        <Card>
          <ErrorState
            title="Tableau de bord indisponible"
            description={error}
            onRetry={() => void load()}
          />
        </Card>
      </div>
    );
  }

  /* ------------------------------- Chargement ------------------------------ */
  if (isLoading && !snapshot) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Pilotage"
          title="Tableau de bord"
          description="Vue d’ensemble de l’activité commerciale."
        />
        <SkeletonCards count={5} />
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const data = snapshot;
  const isEmpty =
    data != null &&
    data.sales.count === 0 &&
    data.jobs.count === 0 &&
    data.recentSales.length === 0 &&
    data.stock.purchaseValue === 0;

  const periodLabel = data?.period.label ?? '';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pilotage"
        title="Tableau de bord"
        description={`Activité commerciale, caisse, dettes et stock — ${periodLabel.toLowerCase()}.`}
        actions={
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-base-200 bg-base-200/40 p-1">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPeriod(p.key)}
                className={`btn btn-sm ${period === p.key ? 'btn-primary' : 'btn-ghost'}`}
                aria-pressed={period === p.key}
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      />

      {/* État vide : on propose une action, jamais une page muette. */}
      {isEmpty ? (
        <Card>
          <EmptyState
            title="Aucune activité enregistrée"
            description="Commencez par créer vos produits et vos clients, puis enregistrez votre première vente. Le tableau de bord se remplira automatiquement."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link href="/produits" className="btn btn-primary">
                  Créer mes produits
                </Link>
                <Link href="/ventes/nouvelle" className="btn btn-outline">
                  Nouvelle vente
                </Link>
              </div>
            }
          />
        </Card>
      ) : (
        <>
          {/* ---------------------------- Indicateurs ---------------------------- */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCardDelta
              label="Chiffre d'affaires"
              value={<MoneyText value={data!.profit.revenue} bold />}
              delta={data!.comparison.deltaPercent}
              hint={`vs période précédente`}
              tone="primary"
              icon={
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <StatCardDelta
              label="Bénéfice net estimé"
              value={<MoneyText value={data!.profit.netProfit} bold colored />}
              hint={`Marge brute ${formatPercent(data!.profit.grossMarginPercent)}`}
              tone={data!.profit.netProfit >= 0 ? 'success' : 'error'}
              icon={
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              }
            />
            <StatCardDelta
              label="Disponible en caisse"
              value={<MoneyText value={data!.cash.balance} bold />}
              hint={
                data!.cash.sessionStatus === 'open'
                  ? `Caisse ouverte${data!.cash.sessionOpenedAt ? ` depuis ${formatDateTime(data!.cash.sessionOpenedAt)}` : ''}`
                  : 'Aucune session ouverte'
              }
              tone={data!.cash.sessionStatus === 'open' ? 'info' : 'neutral'}
              icon={
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
              }
            />
            <StatCardDelta
              label="Créances clients"
              value={<MoneyText value={data!.receivables.total} bold />}
              hint={`${data!.receivables.debtorsCount} client(s) débiteur(s)`}
              tone={data!.receivables.total > 0 ? 'warning' : 'success'}
              icon={
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              }
            />
            <StatCardDelta
              label="Dettes fournisseurs"
              value={<MoneyText value={data!.payables.total} bold />}
              hint={`${data!.payables.creditorsCount} fournisseur(s) à régler`}
              tone={data!.payables.total > 0 ? 'warning' : 'success'}
              icon={
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5" />
                </svg>
              }
            />
          </div>

          {/* ------------------------- Détail du bénéfice ------------------------- */}
          <PageSection title="Composition du bénéfice" subtitle="Aucun montant n’est stocké : tout est recalculé à la lecture.">
            <Card>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                <MiniStat label="Chiffre d'affaires" value={<MoneyText value={data!.profit.revenue} />} tone="primary" />
                <MiniStat label="Coût des marchandises" value={<MoneyText value={data!.profit.cogs} />} tone="info" />
                <MiniStat label="Marge brute" value={<MoneyText value={data!.profit.grossProfit} />} tone="success" />
                <MiniStat label="Dépenses" value={<MoneyText value={data!.profit.expenses} />} tone="warning" />
                <MiniStat label="Main-d'œuvre" value={<MoneyText value={data!.profit.laborCost} />} tone="warning" />
                <MiniStat
                  label="Bénéfice net"
                  value={<MoneyText value={data!.profit.netProfit} />}
                  tone={data!.profit.netProfit >= 0 ? 'success' : 'error'}
                />
              </div>

              {data!.jobs.revenue > 0 && (
                <p className="mt-4 border-t border-base-200 pt-3 text-xs text-base-content/60">
                  Dont <strong>{data!.jobs.count}</strong> prestation(s) de chantier pour{' '}
                  <MoneyText value={data!.jobs.revenue} /> — document facturable autonome, jamais
                  compté deux fois dans le chiffre d’affaires.
                </p>
              )}
            </Card>
          </PageSection>

          {/* ------------------------------ Graphiques ---------------------------- */}
          <div className="grid gap-5 lg:grid-cols-2">
            <PageSection title="Évolution sur 12 mois" subtitle="Ventes, achats et dépenses par mois.">
              <Card>
                <MonthlyEvolutionChart data={data!.monthly} />
              </Card>
            </PageSection>

            <PageSection
              title="Produits les plus vendus"
              subtitle={`Chiffre d'affaires par produit — ${periodLabel.toLowerCase()}.`}
            >
              <Card>
                {data!.topProducts.length === 0 ? (
                  <EmptyState
                    title="Aucune vente sur la période"
                    description="Les produits les plus vendus apparaîtront ici dès la première vente enregistrée."
                  />
                ) : (
                  <TopProductsChart data={data!.topProducts} />
                )}
              </Card>
            </PageSection>
          </div>

          {/* --------------------------- Alertes et listes ------------------------ */}
          <div className="grid gap-5 lg:grid-cols-2">
            <PageSection
              title="Alertes de stock"
              subtitle={`${data!.stock.lowStockCount} produit(s) sous le seuil, ${data!.stock.outOfStockCount} en rupture.`}
              actions={
                <Link href="/stocks" className="btn btn-ghost btn-sm">
                  Voir le stock
                </Link>
              }
            >
              <Card padded={false}>
                {data!.stock.alerts.length === 0 ? (
                  <EmptyState
                    title="Aucune alerte de stock"
                    description="Tous les produits sont au-dessus de leur seuil d’alerte."
                  />
                ) : (
                  <ul className="divide-y divide-base-200">
                    {data!.stock.alerts.map((product) => (
                      <li key={product.id} className="flex items-center justify-between gap-3 px-5 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{product.name}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <QuantityText value={product.stock} unit={product.unit} className="text-sm" />
                          <Badge tone={product.isOut ? 'error' : 'warning'}>
                            {product.isOut ? 'Rupture' : 'Stock faible'}
                          </Badge>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </PageSection>

            <PageSection
              title="Dernières opérations"
              subtitle="Les huit dernières ventes enregistrées."
              actions={
                <RoleGate action="sales.view">
                  <Link href="/ventes" className="btn btn-ghost btn-sm">
                    Toutes les ventes
                  </Link>
                </RoleGate>
              }
            >
              <Card padded={false}>
                {data!.recentSales.length === 0 ? (
                  <EmptyState
                    title="Aucune vente enregistrée"
                    description="Enregistrez votre première vente pour la voir apparaître ici."
                    action={
                      <Link href="/ventes/nouvelle" className="btn btn-primary btn-sm">
                        Nouvelle vente
                      </Link>
                    }
                  />
                ) : (
                  <ul className="divide-y divide-base-200">
                    {data!.recentSales.map((sale) => (
                      <li key={sale.id}>
                        <Link
                          href={`/ventes/${sale.id}`}
                          className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-base-200/60"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {sale.customerName || 'Client comptoir'}
                            </p>
                            <p className="text-xs text-base-content/50">
                              {sale.invoiceNumber} · {formatDateShort(sale.date)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            <MoneyText value={sale.total} className="text-sm" />
                            <StatusBadge status={sale.paymentStatus} />
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </PageSection>
          </div>

          {/* ------------------------ Clients débiteurs ------------------------- */}
          {data!.receivables.top.length > 0 && (
            <PageSection
              title="Clients débiteurs"
              subtitle="Les encours les plus importants à relancer."
              actions={
                <Link href="/soldes" className="btn btn-ghost btn-sm">
                  Voir tous les soldes
                </Link>
              }
            >
              <Card padded={false}>
                <ul className="divide-y divide-base-200">
                  {data!.receivables.top.map((customer) => (
                    <li key={customer.id}>
                      <Link
                        href={`/clients/${customer.id}`}
                        className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-base-200/60"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{customer.name}</p>
                          <p className="text-xs text-base-content/50">{customer.phone ?? 'Sans téléphone'}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {customer.overdue && <Badge tone="error">En retard</Badge>}
                          <MoneyText value={customer.balance} className="text-sm" bold />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </PageSection>
          )}
        </>
      )}

      {/* Rafraîchissement manuel : en desktop, il n'existe aucune barre d'outils. */}
      {data && (
        <div className="flex justify-end">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={isLoading}
            onClick={() => {
              void load().then(() => toast.success('Tableau de bord actualisé'));
            }}
          >
            {isLoading ? <span className="loading loading-spinner loading-xs" /> : 'Actualiser'}
          </button>
        </div>
      )}
    </div>
  );
}
