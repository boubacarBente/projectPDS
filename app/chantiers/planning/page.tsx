'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState, ErrorState, SkeletonTable } from '@/components/design-system';
import { StoreScopeSelect, StoreTag, scopeShowsStore, useStoreScope } from '@/components/store-scope';
import { formatDateShort } from '@/lib/date-format';
import { today } from '@/lib/format';
import { JobStatusBadges, readApiError, type Paginated, type ServiceJobRow } from '@/components/chantiers/chantiers-modals';
import { ProgressBar } from '@/components/prestations/shared';

/* ==================================================================
 * Planning des chantiers (cahier « Prestations » §22) — vue du mois.
 *
 * Desktop : une barre par chantier entre son début et sa fin **prévus**
 * (début réel s'il est connu), la ligne « aujourd'hui », les retards en
 * rouge. Téléphone : liste chronologique, sans diagramme qui déborderait.
 * ================================================================== */

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function monthBounds(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10), days: last.getUTCDate() };
}

function dayIndex(date: string, from: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export default function PlanningPage() {
  const { scope, setScope, apply } = useStoreScope('planning');
  const storeParam = apply(new URLSearchParams()).get('store') ?? '';
  const now = today();
  const [year, setYear] = useState(Number(now.slice(0, 4)));
  const [month, setMonth] = useState(Number(now.slice(5, 7)) - 1);
  const [includeDone, setIncludeDone] = useState(true);
  const [jobs, setJobs] = useState<ServiceJobRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setJobs(null);
    setError(null);
    const params = new URLSearchParams({ limit: '500' });
    if (storeParam) params.set('store', storeParam);
    fetch(`/api/chantiers?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Le planning n’a pas pu être chargé.'));
        return (await response.json()) as Paginated<ServiceJobRow>;
      })
      .then((payload) => setJobs(payload.data ?? []))
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Le planning n’a pas pu être chargé.');
      });
    return () => controller.abort();
  }, [storeParam]);

  const bounds = monthBounds(year, month);

  /** Chantiers dont la période recoupe le mois (sans fin prévue : un seul jour, ou jusqu'à aujourd'hui s'il est ouvert). */
  const rows = useMemo(() => {
    return (jobs ?? [])
      .filter((job) => job.status !== 'cancelled' && job.status !== 'quote' && (includeDone || job.status !== 'completed'))
      .map((job) => {
        const start = job.actualStartDate ?? job.startDate;
        if (!start) return null;
        const open = job.status !== 'completed';
        const planned = job.actualEndDate ?? job.endDate;
        // Un chantier ouvert dont la fin prévue est dépassée court jusqu'à aujourd'hui :
        // sinon le chantier en retard — le plus important à voir — disparaissait du mois en cours.
        const end = open && start <= now && (!planned || planned < now) ? now : (planned ?? start);
        return { job, start, end: end < start ? start : end };
      })
      .filter((row): row is { job: ServiceJobRow; start: string; end: string } => Boolean(row) && row!.start <= bounds.to && row!.end >= bounds.from)
      .sort((a, b) => a.start.localeCompare(b.start));
  }, [jobs, includeDone, bounds.from, bounds.to, now]);

  const unplanned = useMemo(
    () => (jobs ?? []).filter((job) => ['pending', 'planned'].includes(job.status) && !job.startDate),
    [jobs],
  );

  const shift = (delta: number) => {
    const date = new Date(Date.UTC(year, month + delta, 1));
    setYear(date.getUTCFullYear());
    setMonth(date.getUTCMonth());
  };
  const todayIndex = now >= bounds.from && now <= bounds.to ? dayIndex(now, bounds.from) : null;
  const showStore = scopeShowsStore(scope);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Chantiers"
        title="Planning"
        description="Les chantiers du mois sur une ligne de temps : ce qui démarre, ce qui se termine, ce qui est en retard."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="join">
          <button type="button" className="btn join-item min-h-11" onClick={() => shift(-1)} aria-label="Mois précédent">
            ‹
          </button>
          <span className="btn join-item pointer-events-none min-h-11 min-w-[11rem] capitalize">
            {MONTHS[month]} {year}
          </span>
          <button type="button" className="btn join-item min-h-11" onClick={() => shift(1)} aria-label="Mois suivant">
            ›
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost min-h-11 border border-base-300"
          onClick={() => {
            setYear(Number(now.slice(0, 4)));
            setMonth(Number(now.slice(5, 7)) - 1);
          }}
        >
          Ce mois-ci
        </button>
        <StoreScopeSelect value={scope} onChange={setScope} className="min-h-11 w-full sm:w-56" />
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="checkbox checkbox-sm" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />
          Afficher les chantiers terminés
        </label>
      </div>

      {error ? (
        <ErrorState title="Planning indisponible" description={error} />
      ) : !jobs ? (
        <SkeletonTable rows={6} cols={4} />
      ) : rows.length === 0 ? (
        <EmptyState title="Aucun chantier ce mois-ci" description="Aucun chantier daté ne tombe sur ce mois." />
      ) : (
        <>
          {/* Diagramme — à partir de la tablette */}
          <Card className="hidden space-y-1 md:block" padded={false}>
            <div className="flex border-b border-base-200 px-4 py-2 text-xs text-base-content/55">
              <span className="w-56 shrink-0">Chantier</span>
              <div className="relative flex-1">
                <div className="flex">
                  {Array.from({ length: bounds.days }, (_, i) => (
                    <span key={i} className={`flex-1 text-center tabular ${i + 1 === 1 || (i + 1) % 5 === 0 ? '' : 'opacity-0'}`}>
                      {i + 1}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <ul>
              {rows.map(({ job, start, end }) => {
                const left = Math.max(0, dayIndex(start, bounds.from));
                const right = Math.min(bounds.days - 1, dayIndex(end, bounds.from));
                const width = ((right - left + 1) / bounds.days) * 100;
                const tone = job.status === 'completed' ? 'bg-success/70' : job.isLate ? 'bg-error/80' : job.status === 'suspended' ? 'bg-warning/70' : job.status === 'planned' || job.status === 'pending' ? 'bg-info/60' : 'bg-primary/80';
                return (
                  <li key={job.id} className="flex items-center border-b border-base-200/70 px-4 py-2 last:border-0 hover:bg-base-200/40">
                    <div className="w-56 shrink-0 pr-3">
                      <Link href={`/chantiers/${job.id}`} className="block truncate text-sm font-semibold text-primary hover:underline">
                        {job.reference}
                      </Link>
                      <span className="block truncate text-xs text-base-content/60">{job.title || job.customerName}</span>
                      <StoreTag name={job.storeName} show={showStore} />
                    </div>
                    <div className="relative h-8 flex-1">
                      {todayIndex !== null && (
                        <span
                          className="absolute inset-y-0 w-px bg-error/70"
                          style={{ left: `${((todayIndex + 0.5) / bounds.days) * 100}%` }}
                          aria-hidden
                        />
                      )}
                      <Link
                        href={`/chantiers/${job.id}`}
                        title={`${job.reference} — du ${formatDateShort(start)} au ${formatDateShort(end)} · ${job.progress} %`}
                        className={`absolute top-1 flex h-6 items-center overflow-hidden rounded-md px-2 text-[11px] font-medium text-white ${tone}`}
                        style={{ left: `${(left / bounds.days) * 100}%`, width: `${Math.max(width, 3)}%` }}
                      >
                        <span className="truncate">
                          {job.progress} %{job.isLate ? ' · en retard' : ''}
                        </span>
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap gap-4 border-t border-base-200 px-4 py-2.5 text-xs text-base-content/65">
              <Legend className="bg-info/60" label="Préparation / planifié" />
              <Legend className="bg-primary/80" label="En cours" />
              <Legend className="bg-warning/70" label="Suspendu" />
              <Legend className="bg-error/80" label="En retard" />
              <Legend className="bg-success/70" label="Terminé" />
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-px bg-error" aria-hidden /> Aujourd’hui
              </span>
            </div>
          </Card>

          {/* Liste — téléphone */}
          <ul className="space-y-3 md:hidden">
            {rows.map(({ job, start, end }) => (
              <li key={job.id}>
                <Link href={`/chantiers/${job.id}`} className="surface-card block space-y-2 border border-base-200 bg-base-100 p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block font-semibold text-primary">{job.reference}</span>
                      <span className="block truncate text-xs text-base-content/60">{job.title || job.customerName}</span>
                    </span>
                    <JobStatusBadges job={job} />
                  </div>
                  <p className="text-xs text-base-content/60 tabular">
                    Du {formatDateShort(start)} au {formatDateShort(end)}
                  </p>
                  <ProgressBar value={job.progress} late={job.isLate} />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {unplanned.length > 0 && (
        <Card className="space-y-2">
          <h2 className="text-sm font-semibold">À planifier ({unplanned.length})</h2>
          <p className="text-xs text-base-content/55">Chantiers sans date de début prévue : ils n’apparaissent pas sur la ligne de temps.</p>
          <ul className="flex flex-wrap gap-2">
            {unplanned.map((job) => (
              <li key={job.id}>
                <Link href={`/chantiers/${job.id}`} className="btn btn-ghost btn-sm min-h-11 border border-base-300">
                  {job.reference} · {job.customerName}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-3 w-5 rounded ${className}`} aria-hidden /> {label}
    </span>
  );
}
