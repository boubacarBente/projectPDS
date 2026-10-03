'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DataToolbar } from '@/components/data-toolbar';
import { Modal } from '@/components/modal';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Badge, EmptyState, ErrorState, FormField, MoneyText, SkeletonCards, SkeletonTable, StatCardDelta } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { StoreScopeSelect, useStoreScope } from '@/components/store-scope';
import { formatNumber } from '@/lib/format';
import { readApiError } from '@/components/prestations/shared';

/* ==================================================================
 * Sous-traitants (cahier « Prestations » §12).
 *
 * Un sous-traitant est une **fiche fournisseur** marquée comme telle
 * (référentiel commun). Les montants affichés sont ceux des chantiers du ou des
 * magasins choisis : convenu, payé par des dépenses rattachées, reste dû.
 * ================================================================== */

type SubcontractorRow = {
  id: number;
  name: string;
  phone: string | null;
  specialty: string | null;
  isActive: boolean;
  jobs: number;
  agreed: number;
  paid: number;
  remaining: number;
};

export default function SousTraitantsPage() {
  const router = useRouter();
  const canCreate = usePermission('suppliers.create');
  const { scope, setScope, apply } = useStoreScope('sous-traitants');
  const storeParam = apply(new URLSearchParams()).get('store') ?? '';
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<SubcontractorRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    const params = new URLSearchParams();
    if (storeParam) params.set('store', storeParam);
    fetch(`/api/sous-traitants?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Les sous-traitants n’ont pas pu être chargés.'));
        return (await response.json()) as { data: SubcontractorRow[] };
      })
      .then((payload) => setRows(payload.data ?? []))
      .catch((caught) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Les sous-traitants n’ont pas pu être chargés.');
      });
    return () => controller.abort();
  }, [storeParam, reload]);

  const refresh = useCallback(() => setReload((r) => r + 1), []);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => !term || `${r.name} ${r.specialty ?? ''} ${r.phone ?? ''}`.toLowerCase().includes(term));
  }, [rows, search]);
  const totals = useMemo(
    () => (rows ?? []).reduce((acc, r) => ({ agreed: acc.agreed + r.agreed, paid: acc.paid + r.paid, remaining: acc.remaining + r.remaining }), { agreed: 0, paid: 0, remaining: 0 }),
    [rows],
  );

  const columns: Column<SubcontractorRow>[] = [
    {
      key: 'name',
      label: 'Sous-traitant',
      primary: true,
      render: (r) => (
        <div className="min-w-0">
          <Link href={`/fournisseurs/${r.id}`} className="font-semibold text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.name}
          </Link>
          <span className="block truncate text-xs text-base-content/55">
            {r.specialty || 'Métier non précisé'}
            {r.phone ? ` · ${r.phone}` : ''}
          </span>
          {!r.isActive && <Badge tone="neutral">Inactif</Badge>}
        </div>
      ),
    },
    { key: 'jobs', label: 'Chantiers', render: (r) => <span className="tabular">{formatNumber(r.jobs)}</span> },
    {
      key: 'agreed',
      label: 'Convenu',
      className: 'text-right whitespace-nowrap',
      render: (r) => (
        <span className="block">
          <MoneyText value={r.agreed} bold />
          <span className="block text-xs text-base-content/55">
            payé <MoneyText value={r.paid} />
          </span>
        </span>
      ),
    },
    { key: 'remaining', label: 'Reste dû', className: 'text-right whitespace-nowrap', render: (r) => <MoneyText value={r.remaining} remaining bold /> },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Chantiers"
        title="Sous-traitants"
        description="Les entreprises à qui des travaux sont confiés (électricien, plombier…) : ce qui a été convenu, payé, et ce qui leur reste dû."
        actions={
          canCreate ? (
            <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsCreateOpen(true)}>
              Nouveau sous-traitant
            </button>
          ) : undefined
        }
      />

      {!rows ? (
        <SkeletonCards count={4} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCardDelta label="Sous-traitants" tooltip="Fiches fournisseurs marquées « sous-traitant de chantier »." tone="primary" value={formatNumber(rows.filter((r) => r.isActive).length)} hint={`${formatNumber(rows.filter((r) => r.jobs > 0).length)} avec des travaux en cours ou passés`} />
          <StatCardDelta label="Montants convenus" tooltip="Total des travaux confiés sur les chantiers non annulés des magasins affichés." tone="info" value={<MoneyText value={totals.agreed} />} hint="Coût de sous-traitance" />
          <StatCardDelta label="Déjà payé" tooltip="Dépenses décaissées rattachées à ces travaux." tone="success" value={<MoneyText value={totals.paid} />} hint="Par la caisse" />
          <StatCardDelta label="Reste dû" tooltip="Ce que l’entreprise doit encore aux sous-traitants : convenu moins payé." tone={totals.remaining > 0 ? 'error' : 'success'} value={<MoneyText value={totals.remaining} remaining bold />} hint="À payer" />
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Rechercher un nom, un métier…"
        filters={<StoreScopeSelect value={scope} onChange={setScope} className="min-h-11 w-full sm:w-52" />}
      />

      {error ? (
        <ErrorState title="Sous-traitants indisponibles" description={error} onRetry={refresh} />
      ) : !rows ? (
        <SkeletonTable rows={5} cols={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Aucun sous-traitant"
          description={search ? 'Aucun sous-traitant ne correspond.' : 'Créez vos sous-traitants pour leur confier des travaux depuis un chantier.'}
        />
      ) : (
        <ResponsiveTable columns={columns} data={filtered} getRowKey={(r) => r.id} onRowClick={(r) => router.push(`/fournisseurs/${r.id}`)} />
      )}

      <SubcontractorModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} onSaved={refresh} />
    </div>
  );
}

function SubcontractorModal({ isOpen, onClose, onSaved }: { isOpen: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setSpecialty('');
    setPhone('');
    setAddress('');
    setFormError(null);
  }, [isOpen]);

  async function submit() {
    if (!name.trim()) return setFormError('Le nom est obligatoire.');
    setIsSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch('/api/fournisseurs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: name.trim(), specialty: specialty.trim() || null, phone: phone.trim() || null, address: address.trim() || null, isSubcontractor: true }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Le sous-traitant n’a pas pu être créé.'));
      toast.success(`Sous-traitant « ${name.trim()} » créé.`);
      onSaved();
      onClose();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'Le sous-traitant n’a pas pu être créé.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => !isSubmitting && onClose()} title="Nouveau sous-traitant" size="md" fullScreenMobile>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
          Le sous-traitant est une fiche du référentiel fournisseurs, commune à tous les magasins.
        </p>
        <FormField label="Nom ou raison sociale" htmlFor="sub-name" required>
          <input id="sub-name" type="text" className="input input-bordered min-h-11 w-full" value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Métier" htmlFor="sub-specialty">
            <input id="sub-specialty" type="text" className="input input-bordered min-h-11 w-full" value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="Électricien, plombier…" />
          </FormField>
          <FormField label="Téléphone" htmlFor="sub-phone">
            <input id="sub-phone" type="text" className="input input-bordered min-h-11 w-full" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Adresse" htmlFor="sub-address">
          <input id="sub-address" type="text" className="input input-bordered min-h-11 w-full" value={address} onChange={(e) => setAddress(e.target.value)} />
        </FormField>
        {formError && <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">{formError}</p>}
        <div className="flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
          <button type="button" className="btn btn-ghost min-h-11" onClick={onClose} disabled={isSubmitting}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
            {isSubmitting ? <span className="loading loading-spinner loading-sm" aria-hidden /> : 'Créer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
