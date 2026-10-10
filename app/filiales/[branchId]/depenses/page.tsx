'use client';

/**
 * Dépenses d'une filiale de production (README §31.7).
 *
 * Deux natures, une seule liste :
 *  - **de production** : rattachées à une production (main-d'œuvre d'un lot,
 *    carburant du four, colle, découpe…), saisies depuis la fiche de la
 *    production, elles entrent dans son coût de revient ;
 *  - **globales** : loyer, salaires, entretien, outillage… saisies ici, elles
 *    concernent toute la filiale et diminuent le bénéfice de la période.
 *
 * Toutes suivent le circuit des dépenses (`lib/expenses.ts`) : seuil
 * d'approbation (jamais sa propre dépense), décaissement par la caisse du
 * magasin (le mouvement porte la filiale), annulation motivée, aucune
 * suppression.
 *
 * ⚠️ `lib/expenses.ts` est un module serveur : `import type` uniquement.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataToolbar } from '@/components/data-toolbar';
import { FilterSelect, Pagination } from '@/components/search-filter';
import { DatePicker } from '@/components/date-picker';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { IconAction, RowActions } from '@/components/row-actions';
import { Badge, EmptyState, ErrorState, FormField, MoneyText, SkeletonCards, SkeletonTable, StatCardDelta } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { BrickTabs, useBrickScope } from '@/components/briqueterie/brick-tabs';
import { useBranch } from '@/components/filiales/branch-context';
import { PageHeader } from '@/components/page-header';
import { readApiError } from '@/components/depenses/depenses-modals';
import { useSettings } from '@/app/parametres/page';
import { BRANCH_EXPENSE_CATEGORIES, BRANCH_EXPENSE_REFERENCE } from '@/lib/branches-shared';
import type { BranchExpensesSummary, ExpenseRow } from '@/lib/expenses';
import { formatCurrency, formatNumber, today } from '@/lib/format';
import { formatDateShort } from '@/lib/date-format';

const PAGE_SIZE = 15;

const KIND_OPTIONS = [
  { value: 'production', label: 'Dépenses de production' },
  { value: 'global', label: 'Dépenses globales' },
];

const STATUS_OPTIONS = [
  { value: 'approved', label: 'Décaissées' },
  { value: 'pending', label: 'En attente d’approbation' },
  { value: 'to_pay', label: 'Approuvées — à décaisser' },
  { value: 'rejected', label: 'Rejetées' },
];

const STATUS_BADGE: Record<ExpenseRow['approvalStatus'], { label: string; tone: 'success' | 'warning' | 'info' | 'error' }> = {
  approved: { label: 'Décaissée', tone: 'success' },
  pending: { label: 'En attente', tone: 'warning' },
  to_pay: { label: 'À décaisser', tone: 'info' },
  rejected: { label: 'Rejetée', tone: 'error' },
};

type ListPayload = { data: ExpenseRow[]; total: number; totalPages: number; summary: BranchExpensesSummary };

export default function BranchExpensesPage() {
  const { branch, api, href, writable, canLevel } = useBranch();
  const { user, activeStoreId } = useAuth();
  const { settings } = useSettings();
  const { scope, setScope, withStore, showStore } = useBrickScope();
  const canCreate = usePermission('expenses.create') && writable && canLevel('edit');
  const canApprove = usePermission('expenses.approve');
  const canPay = usePermission('expenses.create');
  const canCancel = usePermission('expenses.delete');
  const paymentMethods = settings.paymentMethods?.length ? settings.paymentMethods : ['Espèces'];
  const threshold = Number(settings.expenseApprovalThreshold ?? 0) || 0;

  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<ListPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState<string>(BRANCH_EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState('');
  const [beneficiary, setBeneficiary] = useState('');
  const [description, setDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const [cancelTarget, setCancelTarget] = useState<ExpenseRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [decision, setDecision] = useState<{ expense: ExpenseRow; action: 'approve' | 'reject' } | null>(null);
  const [decisionReason, setDecisionReason] = useState('');
  const [isActing, setIsActing] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (kind) query.set('kind', kind);
      if (status) query.set('approvalStatus', status);
      if (debounced) query.set('search', debounced);
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      const response = await fetch(withStore(api(`/depenses?${query}`)), { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(await readApiError(response, 'Les dépenses n’ont pas pu être chargées.'));
      setPayload(await response.json());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Les dépenses n’ont pas pu être chargées.');
    } finally {
      setIsLoading(false);
    }
  }, [api, page, kind, status, debounced, from, to, withStore]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  function openForm() {
    setCategory(BRANCH_EXPENSE_CATEGORIES[0]);
    setAmount('');
    setDate(today());
    setMethod(paymentMethods[0] ?? 'Espèces');
    setBeneficiary('');
    setDescription('');
    setShowForm(true);
  }

  async function submit() {
    const value = Number(amount.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Indiquez un montant supérieur à zéro.');
      return;
    }
    setIsSaving(true);
    try {
      const response = await fetch(api('/depenses'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ category, amount: value, date, paymentMethod: method, beneficiary: beneficiary.trim() || null, description: description.trim() || null }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'La dépense n’a pas pu être enregistrée.'));
      const saved = (await response.json()) as ExpenseRow;
      toast.success(
        saved.approvalStatus === 'pending'
          ? 'Dépense enregistrée : elle attend l’approbation d’un responsable avant le décaissement.'
          : 'Dépense enregistrée et décaissée.',
      );
      setShowForm(false);
      setReload((n) => n + 1);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'La dépense n’a pas pu être enregistrée.', { autoClose: 8000 });
    } finally {
      setIsSaving(false);
    }
  }

  async function act(expense: ExpenseRow, body: Record<string, unknown>, success: string) {
    setIsActing(true);
    try {
      const response = await fetch(api(`/depenses/${expense.id}`), {
        method: body.action === 'cancel' ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'L’opération a échoué.'));
      toast.success(success);
      setReload((n) => n + 1);
      return true;
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'L’opération a échoué.', { autoClose: 8000 });
      return false;
    } finally {
      setIsActing(false);
    }
  }

  const summary = payload?.summary;
  const rows = payload?.data ?? [];

  const columns: Column<ExpenseRow>[] = [
    { key: 'date', label: 'Date', render: (row) => formatDateShort(row.date) },
    {
      key: 'category',
      label: 'Dépense',
      primary: true,
      render: (row) => (
        <div className="min-w-0">
          <div className="font-semibold">{row.category}</div>
          <div className="truncate text-xs text-base-content/60">
            {row.description ?? row.beneficiary ?? '—'}
            {showStore && row.storeName ? ` · ${row.storeName}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'kind',
      label: 'Nature',
      render: (row) =>
        row.referenceType === BRANCH_EXPENSE_REFERENCE ? (
          <Badge tone="neutral">Globale</Badge>
        ) : row.referenceId ? (
          <Link href={href(`/productions/${row.referenceId}`)} className="link link-primary text-sm" onClick={(event) => event.stopPropagation()}>
            Production
          </Link>
        ) : (
          <Badge tone="neutral">Production</Badge>
        ),
    },
    { key: 'method', label: 'Moyen', hideOnMobile: true, render: (row) => row.paymentMethod },
    {
      key: 'status',
      label: 'État',
      render: (row) =>
        row.cancelled ? <Badge tone="error">Annulée</Badge> : <Badge tone={STATUS_BADGE[row.approvalStatus].tone}>{STATUS_BADGE[row.approvalStatus].label}</Badge>,
    },
    { key: 'amount', label: 'Montant', className: 'text-right', render: (row) => <MoneyText value={row.amount} bold /> },
  ];

  const sameStore = (row: ExpenseRow) => row.storeId === activeStoreId;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow={branch.name}
        title="Dépenses"
        description="Dépenses de production (rattachées à un lot, dans son coût de revient) et dépenses globales de la filiale (loyer, salaires, entretien…), qui diminuent le bénéfice de la période. Un décaissement sort de la caisse du magasin."
        actions={
          <>
            {canCreate && (
          <button type="button" className="btn btn-primary min-h-11" onClick={openForm}>
            Nouvelle dépense globale
          </button>
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
            label="Décaissé sur la période"
            tone="error"
            value={formatCurrency(summary.totalAmount)}
            tooltip="Total des dépenses de la filiale décaissées (non annulées) sur la période choisie, toutes natures confondues. Sans période : depuis le début."
          />
          <StatCardDelta
            label="Dépenses de production"
            tone="warning"
            value={formatCurrency(summary.productionAmount)}
            tooltip="Dépenses rattachées à une production : elles entrent dans le coût de revient de ce lot."
          />
          <StatCardDelta
            label="Dépenses globales"
            tone="info"
            value={formatCurrency(summary.globalAmount)}
            tooltip="Dépenses de toute la filiale, sans lot précis (loyer, salaires, entretien, outillage…). Elles diminuent le bénéfice de la période."
          />
          <StatCardDelta
            label="En attente"
            tone="neutral"
            value={`${formatNumber(summary.pendingCount)} · ${formatCurrency(summary.pendingAmount)}`}
            tooltip={`Dépenses en attente d’approbation ou approuvées mais pas encore décaissées. Seuil d’approbation : ${threshold > 0 ? formatCurrency(threshold) : 'aucun'}.`}
          />
        </div>
      )}

      <DataToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Rechercher une catégorie, un bénéficiaire…"
        filters={
          <>
            <div className="w-full sm:w-52">
              <FilterSelect value={kind} onChange={(v) => { setKind(v); setPage(1); }} options={KIND_OPTIONS} placeholder="Toutes natures" />
            </div>
            <div className="w-full sm:w-56">
              <FilterSelect value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS_OPTIONS} placeholder="Tous les états" />
            </div>
          </>
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
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <ErrorState title="Dépenses indisponibles" description={error} onRetry={() => setReload((n) => n + 1)} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Aucune dépense"
          description="Aucune dépense de la filiale ne correspond à ces filtres. Une dépense de production se saisit depuis la fiche de sa production."
          action={
            canCreate ? (
              <button type="button" className="btn btn-primary min-h-11" onClick={openForm}>
                Saisir une dépense globale
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResponsiveTable
            columns={columns}
            data={rows}
            getRowKey={(row) => row.id}
            actions={(row) =>
              row.cancelled || row.approvalStatus === 'rejected' ? null : (
                <RowActions>
                  {row.approvalStatus === 'pending' && canApprove && row.userId !== user?.id && (
                    <>
                      <IconAction icon="activate" tone="success" label={`Approuver ${row.category}`} onClick={() => { setDecisionReason(''); setDecision({ expense: row, action: 'approve' }); }} />
                      <IconAction icon="deactivate" tone="danger" label={`Rejeter ${row.category}`} onClick={() => { setDecisionReason(''); setDecision({ expense: row, action: 'reject' }); }} />
                    </>
                  )}
                  {row.approvalStatus === 'to_pay' && canPay && sameStore(row) && writable && (
                    <IconAction icon="pay" tone="primary" label={`Décaisser ${row.category}`} onClick={() => void act(row, { action: 'pay' }, 'Dépense décaissée : la sortie de caisse est enregistrée.')} />
                  )}
                  {canCancel && sameStore(row) && (
                    <IconAction icon="cancel" tone="danger" label={`Annuler ${row.category}`} onClick={() => { setCancelReason(''); setCancelTarget(row); }} />
                  )}
                </RowActions>
              )
            }
          />
          <Pagination currentPage={page} totalPages={payload?.totalPages ?? 1} onPageChange={setPage} />
          <p className="text-center text-xs text-base-content/60">{formatNumber(payload?.total ?? 0)} dépense(s)</p>
        </>
      )}

      <Modal
        isOpen={showForm}
        onClose={() => setShowForm(false)}
        title={`Dépense globale — ${branch.name}`}
        footer={
          <>
            <button type="button" className="btn btn-ghost min-h-11" onClick={() => setShowForm(false)} disabled={isSaving}>
              Annuler
            </button>
            <button type="button" className="btn btn-primary min-h-11" onClick={() => void submit()} disabled={isSaving}>
              {isSaving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Catégorie" htmlFor="branch-expense-category">
            <select id="branch-expense-category" className="select select-bordered min-h-11 w-full" value={category} onChange={(e) => setCategory(e.target.value)} disabled={isSaving}>
              {BRANCH_EXPENSE_CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Montant (GNF)" htmlFor="branch-expense-amount" hint={threshold > 0 ? `Au-delà de ${formatCurrency(threshold)}, approbation requise.` : undefined}>
            <input id="branch-expense-amount" type="text" inputMode="decimal" autoComplete="off" className="input input-bordered min-h-11 w-full" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={isSaving} />
          </FormField>
          <FormField label="Date" htmlFor="branch-expense-date">
            <DatePicker value={date} onChange={setDate} />
          </FormField>
          <FormField label="Moyen de paiement" htmlFor="branch-expense-method">
            <select id="branch-expense-method" className="select select-bordered min-h-11 w-full" value={method} onChange={(e) => setMethod(e.target.value)} disabled={isSaving}>
              {paymentMethods.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Bénéficiaire" htmlFor="branch-expense-beneficiary">
            <input id="branch-expense-beneficiary" type="text" autoComplete="off" className="input input-bordered min-h-11 w-full" value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} disabled={isSaving} />
          </FormField>
          <FormField label="Description" htmlFor="branch-expense-description">
            <input id="branch-expense-description" type="text" autoComplete="off" className="input input-bordered min-h-11 w-full" value={description} onChange={(e) => setDescription(e.target.value)} disabled={isSaving} />
          </FormField>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(decision)}
        onClose={() => setDecision(null)}
        tone={decision?.action === 'approve' ? 'primary' : 'error'}
        title={decision?.action === 'approve' ? 'Approuver la dépense' : 'Rejeter la dépense'}
        message={
          decision
            ? decision.action === 'approve'
              ? `${decision.expense.category} — ${formatCurrency(decision.expense.amount)} : la dépense sera décaissée tout de suite si elle appartient à votre magasin actif, sinon elle restera « à décaisser ».`
              : `${decision.expense.category} — ${formatCurrency(decision.expense.amount)} : la dépense ne sera jamais décaissée ni comptée.`
            : ''
        }
        confirmLabel={decision?.action === 'approve' ? 'Approuver' : 'Rejeter'}
        isSubmitting={isActing}
        onConfirm={async () => {
          if (!decision) return;
          if (decision.action === 'reject' && !decisionReason.trim()) {
            toast.error('Indiquez le motif du rejet.');
            return;
          }
          const done = await act(
            decision.expense,
            { action: decision.action, payNow: true, reason: decisionReason.trim() || null },
            decision.action === 'approve' ? 'Dépense approuvée.' : 'Dépense rejetée.',
          );
          if (done) setDecision(null);
        }}
      >
        {decision?.action === 'reject' && (
          <FormField label="Motif du rejet" htmlFor="branch-expense-reject">
            <input id="branch-expense-reject" type="text" className="input input-bordered min-h-11 w-full" value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} />
          </FormField>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        title="Annuler la dépense"
        message={
          cancelTarget
            ? `${cancelTarget.category} — ${formatCurrency(cancelTarget.amount)}. ${cancelTarget.approvalStatus === 'approved' ? 'L’argent revient dans la caisse du magasin.' : 'Rien n’était sorti de la caisse.'} La dépense reste visible, marquée annulée.`
            : ''
        }
        confirmLabel="Annuler la dépense"
        isSubmitting={isActing}
        onConfirm={async () => {
          if (!cancelTarget) return;
          if (!cancelReason.trim()) {
            toast.error('Le motif d’annulation est obligatoire.');
            return;
          }
          const done = await act(cancelTarget, { action: 'cancel', reason: cancelReason.trim() }, 'Dépense annulée.');
          if (done) setCancelTarget(null);
        }}
      >
        <FormField label="Motif" htmlFor="branch-expense-cancel">
          <input id="branch-expense-cancel" type="text" className="input input-bordered min-h-11 w-full" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
        </FormField>
      </ConfirmDialog>
    </div>
  );
}
