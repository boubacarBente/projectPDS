'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { FilterSelect } from '@/components/search-filter';
import { ResponsiveTable } from '@/components/responsive-table';
import { DatePicker } from '@/components/date-picker';
import { Badge, Card, EmptyState, ErrorState, MoneyText, PageSection, SkeletonCards, StatCardDelta } from '@/components/design-system';
import { useSettings } from '@/app/parametres/page';
import { StoreScopeSelect, useStoreScope } from '@/components/store-scope';
import { RevenueTrendChart, TopProductsChart } from '@/components/dashboard/dashboard-charts';
import { formatMonthYear, formatDateShort } from '@/lib/date-format';
import { addDays, formatNumber, formatQuantity, today } from '@/lib/format';
import {
  JOB_STATUS_OPTIONS,
  JobStatusBadges,
  jobCategoryOptions,
  readApiError,
  type JobsSummary,
  type ServiceJobRow,
} from '@/components/chantiers/chantiers-modals';
import { ProgressBar, describeAudit, type QuotesSummary, type RequestsSummary } from '@/components/prestations/shared';

/* ==================================================================
 * Pilotage des chantiers — tableau de bord du magasin (cahier §17) et vue
 * consolidée de l'administrateur (§18) : même écran, la **portée** décide.
 *
 * « Tous les magasins » ajoute la comparaison par magasin ; les montants
 * restent attribués à leur magasin (aucune donnée locale n'est mélangée).
 * Coûts et bénéfices n'apparaissent que pour qui peut voir les marges.
 * ================================================================== */

type StoreRow = {
  storeId: number;
  storeName: string;
  jobs: number;
  open: number;
  late: number;
  billed: number;
  collected: number;
  outstanding: number;
  totalCost: number | null;
  margin: number | null;
};

type Dashboard = {
  summary: JobsSummary;
  requests: RequestsSummary;
  quotes: QuotesSummary;
  byStore: StoreRow[];
  topServices: { name: string; storeName: string; quantity: number; unit: string; amount: number; jobs: number }[];
  byCategory: { category: string; jobs: number; billed: number; margin: number | null }[];
  monthly: { month: string; billed: number; collected: number }[];
  lateJobs: ServiceJobRow[];
  activity: { id: number; createdAt: string | null; userName: string; storeName: string | null; action: string; entity: string; entityId: number | null; details: string | null }[];
  withCosts: boolean;
};

const PERIODS = [
  { value: '30', label: '30 derniers jours' },
  { value: '90', label: '3 derniers mois' },
  { value: '365', label: '12 derniers mois' },
  { value: 'all', label: 'Depuis le début' },
  { value: 'custom', label: 'Période choisie' },
];

const ENTITY_LINKS: Record<string, { label: string; href: (id: number) => string }> = {
  service_job: { label: 'Chantier', href: (id) => `/chantiers/${id}` },
  quote: { label: 'Devis', href: (id) => `/chantiers/devis/${id}` },
  service_request: { label: 'Demande', href: (id) => `/chantiers/demandes/${id}` },
  service: { label: 'Prestation', href: (id) => `/prestations/${id}` },
};
const ACTIONS: Record<string, string> = { create: 'Création', update: 'Modification', cancel: 'Annulation', validate: 'Validation', reject: 'Refus' };

export default function PilotageChantiersPage() {
  const { settings } = useSettings();
  const { scope, setScope, apply } = useStoreScope('pilotage-chantiers');
  const storeParam = apply(new URLSearchParams()).get('store') ?? '';
  const [period, setPeriod] = useState('365');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const range = useMemo(() => {
    if (period === 'custom') return { from, to };
    if (period === 'all') return { from: '', to: '' };
    return { from: addDays(today(), -Number(period)), to: '' };
  }, [period, from, to]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setData(null);
    const params = new URLSearchParams();
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    if (category) params.set('category', category);
    if (status) params.set('status', status);
    if (storeParam) params.set('store', storeParam);
    fetch(`/api/chantiers/pilotage?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Le pilotage n’a pas pu être chargé.'));
        return (await response.json()) as Dashboard;
      })
      .then(setData)
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Le pilotage n’a pas pu être chargé.');
      });
    return () => controller.abort();
  }, [range, category, status, storeParam, reload]);

  const s = data?.summary;
  const open = s ? s.byStatus.pending + s.byStatus.planned + s.byStatus.in_progress + s.byStatus.suspended : 0;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Chantiers"
        title="Pilotage des chantiers"
        description="Où en sont les chantiers, ce qu’ils rapportent et ce qui reste à encaisser — pour votre magasin, ou pour tout le réseau en vue consolidée."
      />

      <div className="flex flex-wrap items-center gap-2">
        <StoreScopeSelect value={scope} onChange={setScope} className="min-h-11 w-full sm:w-56" />
        <div className="w-full sm:w-52">
          <FilterSelect value={period} onChange={(value) => setPeriod(value || '365')} options={PERIODS} placeholder="Période" />
        </div>
        {period === 'custom' && (
          <>
            <div className="w-full sm:w-44">
              <DatePicker value={from} onChange={setFrom} placeholder="Du" />
            </div>
            <div className="w-full sm:w-44">
              <DatePicker value={to} onChange={setTo} placeholder="Au" />
            </div>
          </>
        )}
        <div className="w-full sm:w-52">
          <FilterSelect value={category} onChange={setCategory} options={jobCategoryOptions(settings.jobCategories ?? [])} placeholder="Tous les types" />
        </div>
        <div className="w-full sm:w-48">
          <FilterSelect value={status} onChange={setStatus} options={JOB_STATUS_OPTIONS} placeholder="Tous les statuts" />
        </div>
      </div>
      <p className="-mt-3 text-xs text-base-content/55">La période porte sur la date de début prévue des chantiers et la date des demandes et devis.</p>

      {error ? (
        <ErrorState title="Pilotage indisponible" description={error} onRetry={() => setReload((r) => r + 1)} />
      ) : !data || !s ? (
        <SkeletonCards count={10} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            <StatCardDelta label="Chantiers en cours" tooltip="Chantiers en préparation, planifiés, en cours ou suspendus." tone="primary" value={formatNumber(open)} hint={`${formatNumber(s.byStatus.in_progress)} en cours, ${formatNumber(s.byStatus.planned)} planifié(s)`} />
            <StatCardDelta label="Terminés" tooltip="Chantiers terminés sur la période." tone="success" value={formatNumber(s.byStatus.completed)} hint={`${formatNumber(s.byStatus.cancelled)} annulé(s)`} />
            <StatCardDelta label="En retard" tooltip="Chantiers non terminés dont la fin prévue est dépassée (aujourd’hui)." tone={s.late > 0 ? 'error' : 'success'} value={formatNumber(s.late)} hint={s.late > 0 ? 'Voir la liste plus bas' : 'Aucun retard'} />
            <StatCardDelta label="Demandes en attente" tooltip="Demandes de clients pas encore closes : nouvelles, à l’étude, en visite, devis à préparer ou envoyé." tone="warning" value={formatNumber(data.requests.pending)} hint={`${formatNumber(data.requests.byStatus.new)} nouvelle(s)`} />
            <StatCardDelta label="Devis en attente" tooltip="Devis en brouillon ou envoyés, encore valables, sans réponse du client." tone="info" value={<MoneyText value={data.quotes.pendingAmount} />} hint={`${formatNumber(data.quotes.pendingCount)} devis · ${data.quotes.acceptanceRate.toLocaleString('fr-FR')} % acceptés`} />
            <StatCardDelta label="Montant des chantiers" tooltip="Total facturé aux clients pour les chantiers de la période (prestations), hors annulés." tone="primary" value={<MoneyText value={s.billed} />} hint={`${formatNumber(s.totalJobs)} chantier(s)`} />
            <StatCardDelta label="Paiements reçus" tooltip="Argent encaissé sur ces chantiers (acomptes et soldes)." tone="success" value={<MoneyText value={s.collected} />} hint={s.billed > 0 ? `${Math.round((s.collected / s.billed) * 100)} % du montant` : undefined} />
            <StatCardDelta label="Créances" tooltip="Ce que les clients doivent encore sur ces chantiers." tone={s.outstanding > 0 ? 'error' : 'success'} value={<MoneyText value={s.outstanding} remaining bold />} hint="Reste à encaisser" />
            {data.withCosts && s.totalCost !== null && (
              <StatCardDelta label="Coûts des chantiers" tooltip="Matériaux au prix d’achat, main-d’œuvre, sous-traitance convenue et dépenses rattachées aux chantiers." tone="warning" value={<MoneyText value={s.totalCost} />} hint={`dont dépenses ${new Intl.NumberFormat('fr-FR').format(s.expensesCost ?? 0)} GNF`} />
            )}
            {data.withCosts && s.margin !== null && (
              <StatCardDelta label="Bénéfice estimatif" tooltip="Montant des chantiers moins leurs coûts. Estimatif tant que des chantiers sont en cours." tone={s.margin >= 0 ? 'success' : 'error'} value={<MoneyText value={s.margin} colored />} hint={s.marginPercent !== null ? `Marge ${s.marginPercent.toLocaleString('fr-FR')} %` : undefined} />
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="space-y-2 lg:col-span-3">
              <h2 className="text-sm font-semibold">Montant facturé et encaissé, mois par mois</h2>
              {data.monthly.length === 0 ? (
                <EmptyState title="Pas encore de chantier" description="Aucun chantier sur la période." />
              ) : (
                <RevenueTrendChart
                  labels={data.monthly.map((m) => formatMonthYear(`${m.month}-01`).replace(/^\w/, (c) => c.toUpperCase()))}
                  series={[
                    { label: 'Facturé', values: data.monthly.map((m) => m.billed), tone: 0 },
                    { label: 'Encaissé', values: data.monthly.map((m) => m.collected), tone: 1 },
                  ]}
                />
              )}
            </Card>
            <Card className="space-y-2 lg:col-span-2">
              <h2 className="text-sm font-semibold">Prestations les plus vendues</h2>
              {data.topServices.length === 0 ? (
                <EmptyState title="Aucune prestation facturée" description="Les chantiers de la période n’ont pas de prestation du catalogue." />
              ) : (
                <TopProductsChart data={data.topServices.map((t) => ({ productName: t.name, amount: t.amount }))} />
              )}
            </Card>
          </div>

          {data.byStore.length > 1 && (
            <PageSection title="Comparaison des magasins" subtitle="Chaque montant reste attribué au magasin qui a réalisé le chantier.">
              <ResponsiveTable
                columns={[
                  { key: 'store', label: 'Magasin', primary: true, render: (r: StoreRow) => <span className="font-semibold">{r.storeName}</span> },
                  {
                    key: 'jobs',
                    label: 'Chantiers',
                    render: (r: StoreRow) => (
                      <span className="block text-sm">
                        {formatNumber(r.jobs)}
                        <span className="block text-xs text-base-content/55">
                          {r.open} ouvert(s){r.late > 0 ? ` · ${r.late} en retard` : ''}
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: 'billed',
                    label: 'Facturé',
                    className: 'text-right whitespace-nowrap',
                    render: (r: StoreRow) => (
                      <span className="block">
                        <MoneyText value={r.billed} bold />
                        <span className="block text-xs text-base-content/55">
                          encaissé <MoneyText value={r.collected} />
                        </span>
                      </span>
                    ),
                  },
                  { key: 'outstanding', label: 'Créances', className: 'text-right whitespace-nowrap', render: (r: StoreRow) => <MoneyText value={r.outstanding} remaining bold /> },
                  ...(data.withCosts
                    ? [
                        {
                          key: 'margin',
                          label: 'Bénéfice estimatif',
                          className: 'text-right whitespace-nowrap',
                          render: (r: StoreRow) => (
                            <span className="block">
                              <MoneyText value={r.margin ?? 0} colored bold />
                              {r.billed > 0 && r.margin !== null && (
                                <span className="block text-xs text-base-content/55">{Math.round((r.margin / r.billed) * 100)} %</span>
                              )}
                            </span>
                          ),
                        },
                      ]
                    : []),
                ]}
                data={data.byStore}
                getRowKey={(r) => r.storeId}
              />
            </PageSection>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <PageSection title="Par type de prestation" subtitle="Comparaison des catégories (liste commune à tous les magasins).">
              <Card className="space-y-3">
                {data.byCategory.length === 0 ? (
                  <p className="text-sm text-base-content/60">Aucun chantier sur la période.</p>
                ) : (
                  data.byCategory.map((row) => {
                    const max = data.byCategory[0]?.billed || 1;
                    return (
                      <div key={row.category} className="space-y-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                          <span className="font-medium">{row.category}</span>
                          <span className="text-right">
                            <MoneyText value={row.billed} bold />
                            <span className="ml-1 text-xs text-base-content/55">
                              · {row.jobs} chantier{row.jobs > 1 ? 's' : ''}
                              {row.margin !== null && row.billed > 0 ? ` · marge ${Math.round((row.margin / row.billed) * 100)} %` : ''}
                            </span>
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-base-300" aria-hidden>
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(3, (row.billed / max) * 100)}%` }} />
                        </div>
                      </div>
                    );
                  })
                )}
              </Card>
            </PageSection>

            <PageSection title="Prestations les plus utilisées" subtitle="Classées par montant facturé, avec le magasin qui les vend.">
              <Card>
                {data.topServices.length === 0 ? (
                  <p className="text-sm text-base-content/60">Aucune prestation facturée sur la période.</p>
                ) : (
                  <ol className="divide-y divide-base-200">
                    {data.topServices.map((t, index) => (
                      <li key={`${t.name}-${t.storeName}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                        <span className="min-w-0">
                          <span className="mr-2 text-base-content/40 tabular">{index + 1}.</span>
                          <span className="font-medium">{t.name}</span>
                          <span className="block pl-5 text-xs text-base-content/55">
                            {t.storeName} · {formatQuantity(t.quantity, t.unit)} · {t.jobs} chantier{t.jobs > 1 ? 's' : ''}
                          </span>
                        </span>
                        <MoneyText value={t.amount} bold className="shrink-0" />
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            </PageSection>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <PageSection title="Chantiers en retard" subtitle="Fin prévue dépassée, chantier non terminé.">
              <Card>
                {data.lateJobs.length === 0 ? (
                  <p className="text-sm text-success">Aucun chantier en retard.</p>
                ) : (
                  <ul className="divide-y divide-base-200">
                    {data.lateJobs.map((job) => (
                      <li key={job.id} className="space-y-1.5 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Link href={`/chantiers/${job.id}`} className="font-semibold text-primary hover:underline">
                            {job.reference}
                          </Link>
                          <JobStatusBadges job={job} />
                        </div>
                        <p className="text-xs text-base-content/60">
                          {job.customerName}
                          {job.storeName ? ` · ${job.storeName}` : ''} · fin prévue le {formatDateShort(job.endDate)}
                        </p>
                        <ProgressBar value={job.progress} late />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </PageSection>

            <PageSection title="Activité récente" subtitle="Les dernières actions sur les demandes, devis, chantiers et prestations.">
              <Card>
                {data.activity.length === 0 ? (
                  <p className="text-sm text-base-content/60">Aucune activité enregistrée.</p>
                ) : (
                  <ul className="divide-y divide-base-200">
                    {data.activity.map((entry) => {
                      const link = ENTITY_LINKS[entry.entity];
                      const line = describeAudit(entry.details)[0];
                      return (
                        <li key={entry.id} className="py-2.5 text-sm">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span>
                              <Badge tone="neutral">{link?.label ?? entry.entity}</Badge>{' '}
                              <span className="font-medium">{ACTIONS[entry.action] ?? entry.action}</span>
                              <span className="text-base-content/60"> par {entry.userName}</span>
                            </span>
                            <span className="text-xs text-base-content/50">
                              {entry.createdAt ? new Date(entry.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : ''}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-base-content/60">
                            {entry.storeName ? `${entry.storeName} · ` : ''}
                            {line ?? ''}
                            {link && entry.entityId ? (
                              <>
                                {' '}
                                <Link href={link.href(entry.entityId)} className="link">
                                  ouvrir
                                </Link>
                              </>
                            ) : null}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </PageSection>
          </div>
        </>
      )}
    </div>
  );
}
