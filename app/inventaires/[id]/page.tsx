'use client';

/**
 * Feuille de comptage d'un inventaire (cahier des charges §7 ; guide §6.16).
 *
 *  - Saisie de la quantité comptée et, en cas d'écart, de sa justification ;
 *    « Enregistrer » n'envoie que les lignes modifiées (le stock théorique est
 *    relevé par le serveur au moment de l'enregistrement de chaque ligne).
 *  - « Valider » transforme chaque écart en ajustement de stock ; le serveur
 *    refuse tant qu'un écart n'est pas justifié.
 *  - Lecture seule si l'inventaire est clos, ou s'il appartient à un autre
 *    magasin que le magasin actif (`actions` vide).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  Card,
  EmptyState,
  ErrorState,
  FormField,
  MoneyText,
  SkeletonCards,
  StatCardDelta,
} from '@/components/design-system';
import {
  InventoryStatusBadge,
  readApiError,
  type InventoryDetailRecord,
  type InventoryItemRow,
} from '@/components/inventaires/inventory-ui';
import { ExportDropdown } from '@/components/export-dropdown';
import { useSettings } from '@/app/parametres/page';
import {
  exportCompanyFromSettings,
  exportDocumentAsImage,
  exportDocumentAsPDF,
  exportFileName,
  renderExportDocument,
} from '@/lib/export-document';
import { formatCurrency, formatNumber, formatQuantity, today } from '@/lib/format';
import { formatDateShort, formatDateWithTime } from '@/lib/date-format';

type Draft = { counted: string; justification: string };
type Filter = 'all' | 'uncounted' | 'gaps';

const toDraft = (item: InventoryItemRow): Draft => ({
  counted: item.countedQuantity === null ? '' : String(item.countedQuantity),
  justification: item.justification ?? '',
});
const parse = (value: string) => (value.trim() === '' ? null : Number(value.replace(',', '.')));

export default function InventaireFichePage() {
  const params = useParams<{ id: string }>();
  const inventoryId = Number(params.id);
  const { settings } = useSettings();

  const [detail, setDetail] = useState<InventoryDetailRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [isSaving, setIsSaving] = useState(false);
  const [showValidate, setShowValidate] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const apply = (next: InventoryDetailRecord) => {
    setDetail(next);
    setDrafts(Object.fromEntries(next.items.map((item) => [item.id, toDraft(item)])));
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/inventaires/${inventoryId}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(await readApiError(response, 'L’inventaire n’a pas pu être chargé.'));
      apply(await response.json());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'L’inventaire n’a pas pu être chargé.');
    }
  }, [inventoryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = detail?.items ?? [];
  const canCount = detail?.actions.includes('count') ?? false;

  /** Lignes dont la saisie diffère de ce qui est enregistré. */
  const changed = useMemo(
    () =>
      items.filter((item) => {
        const draft = drafts[item.id];
        if (!draft) return false;
        return parse(draft.counted) !== item.countedQuantity || draft.justification.trim() !== (item.justification ?? '');
      }),
    [items, drafts],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      if (term && !item.productName.toLowerCase().includes(term)) return false;
      if (filter === 'uncounted') return item.countedQuantity === null;
      if (filter === 'gaps') return item.difference !== null && Math.abs(item.difference) > 0.0001;
      return true;
    });
  }, [items, search, filter]);

  const save = async (): Promise<boolean> => {
    if (changed.length === 0) return true;
    for (const item of changed) {
      const value = parse(drafts[item.id].counted);
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        toast.error(`Quantité invalide pour « ${item.productName} ».`);
        return false;
      }
    }
    setIsSaving(true);
    try {
      const response = await fetch(`/api/inventaires/${inventoryId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action: 'count',
          counts: changed.map((item) => ({
            itemId: item.id,
            countedQuantity: parse(drafts[item.id].counted),
            justification: drafts[item.id].justification.trim() || null,
          })),
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Les comptages n’ont pas pu être enregistrés.'));
      const next = await response.json();
      apply({ ...next, actions: detail?.actions ?? [] });
      toast.success(`${formatNumber(changed.length)} ligne(s) enregistrée(s)`);
      return true;
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Les comptages n’ont pas pu être enregistrés.', { autoClose: 8000 });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const validate = async () => {
    // On enregistre d'abord la saisie en cours : valider ne doit jamais l'ignorer.
    if (!(await save())) return;
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/inventaires/${inventoryId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'validate' }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'L’inventaire n’a pas pu être validé.'));
      const next = await response.json();
      apply({ ...next, actions: [] });
      setShowValidate(false);
      toast.success(`Inventaire validé : ${formatNumber(next.result?.adjustments ?? 0)} ajustement(s) de stock.`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'L’inventaire n’a pas pu être validé.', { autoClose: 10000 });
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!cancelReason.trim()) {
      toast.error('Le motif est obligatoire.');
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/inventaires/${inventoryId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'cancel', reason: cancelReason.trim() }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'L’inventaire n’a pas pu être annulé.'));
      apply({ ...(await response.json()), actions: [] });
      setShowCancel(false);
      toast.success('Inventaire annulé : le stock n’a pas été modifié.');
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'L’inventaire n’a pas pu être annulé.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (error) {
    return (
      <Card>
        <ErrorState description={error} onRetry={() => void load()} />
      </Card>
    );
  }
  if (!detail) return <SkeletonCards count={4} />;

  const { inventory, actions } = detail;
  const counted = items.filter((i) => i.countedQuantity !== null);
  const gaps = counted.filter((i) => i.difference !== null && Math.abs(i.difference) > 0.0001);
  const unexplained = gaps.filter((i) => !i.justification?.trim());
  const gapValue = gaps.reduce((sum, i) => sum + (i.difference ?? 0) * i.purchasePrice, 0);

  const readOnlyReason =
    inventory.status !== 'open'
      ? null
      : actions.length === 0
        ? `Cet inventaire appartient au magasin « ${inventory.storeName} » : il se compte et se valide depuis ce magasin (choisissez-le comme magasin actif dans la barre latérale).`
        : null;

  /**
   * Rapport d'inventaire (README §12, §31.6) : document autonome (invariant 5),
   * écarts et justifications — jamais de marge.
   */
  async function exportReport(kind: 'pdf' | 'image') {
    if (!detail) return;
    const inv = detail.inventory;
    const counted = detail.items.filter((item) => item.countedQuantity !== null);
    const gaps = counted.filter((item) => item.difference !== null && Math.abs(item.difference) > 0.0001);
    const html = renderExportDocument({
      documentTitle: 'Rapport d’inventaire',
      documentNumber: inv.reference,
      documentDate: `Édité le ${formatDateShort(today())}`,
      badge: { label: inv.status === 'validated' ? 'Validé' : inv.status === 'cancelled' ? 'Annulé' : 'Comptage en cours', tone: inv.status === 'validated' ? 'success' : inv.status === 'cancelled' ? 'danger' : 'warning' },
      company: exportCompanyFromSettings(settings),
      meta: [
        ['Magasin', inv.storeName],
        ['Périmètre', inv.productionBranchName ? `Filiale ${inv.productionBranchName}` : inv.categoryName ?? 'Tous les produits'],
        ['Ouvert le', `${formatDateShort(inv.createdAt)}${inv.openedByName ? ` par ${inv.openedByName}` : ''}`],
        ['Validé le', inv.validatedAt ? `${formatDateShort(inv.validatedAt)}${inv.validatedByName ? ` par ${inv.validatedByName}` : ''}` : '—'],
      ],
      blocks: [
        {
          kind: 'table',
          title: 'Comptage',
          columns: [
            { label: 'Produit' },
            { label: 'Théorique', align: 'right' },
            { label: 'Compté', align: 'right' },
            { label: 'Écart', align: 'right' },
            { label: 'Justification' },
          ],
          numeric: [1, 2, 3],
          rows: detail.items.map((item) => [
            item.productName,
            `${formatQuantity(item.expectedQuantity)} ${item.unit}`,
            item.countedQuantity === null ? '—' : `${formatQuantity(item.countedQuantity)} ${item.unit}`,
            item.difference === null ? '—' : `${item.difference > 0 ? '+' : ''}${formatQuantity(item.difference)}`,
            item.justification ?? '',
          ]),
        },
        {
          kind: 'totals',
          rows: [
            { label: 'Produits comptés', value: `${formatNumber(counted.length)} / ${formatNumber(detail.items.length)}` },
            { label: 'Lignes en écart', value: formatNumber(gaps.length), tone: gaps.length ? 'warning' : 'success' },
            { label: 'Valeur des écarts (prix d’achat)', value: formatCurrency(inv.discrepancyValue), tone: inv.discrepancyValue < 0 ? 'danger' : 'strong' },
          ],
        },
      ],
      notes: inv.notes,
    });
    const file = exportFileName('inventaire', inv.reference);
    try {
      if (kind === 'pdf') await exportDocumentAsPDF(html, file);
      else await exportDocumentAsImage(html, file);
      toast.success(kind === 'pdf' ? 'Rapport d’inventaire exporté en PDF.' : 'Rapport d’inventaire exporté en image.');
    } catch (caught: any) {
      toast.error(caught?.message ?? 'Le rapport n’a pas pu être exporté.', { autoClose: 10000 });
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        eyebrow={
          inventory.productionBranchId ? (
            <Link href={`/filiales/${inventory.productionBranchId}/inventaire`} className="hover:underline">
              Inventaires · {inventory.productionBranchName}
            </Link>
          ) : (
            <Link href="/inventaires" className="hover:underline">
              Inventaires
            </Link>
          )
        }
        title={inventory.reference}
        description={`${inventory.storeName} · ${
          inventory.productionBranchName ? `Filiale ${inventory.productionBranchName}` : inventory.categoryName ?? 'Tous les produits'
        } · ouvert le ${formatDateShort(inventory.createdAt)}${
          inventory.openedByName ? ` par ${inventory.openedByName}` : ''
        }`}
        actions={
          <>
            <ExportDropdown
              compact
              label="Télécharger"
              onExportPDF={() => void exportReport('pdf')}
              onExportImage={() => void exportReport('image')}
            />
            {actions.includes('cancel') && (
              <button
                type="button"
                className="btn btn-ghost min-h-11 text-error sm:min-h-0"
                disabled={isSaving || isSubmitting}
                onClick={() => {
                  setCancelReason('');
                  setShowCancel(true);
                }}
              >
                Annuler l’inventaire
              </button>
            )}
            {canCount && (
              <button
                type="button"
                className="btn btn-outline min-h-11 sm:min-h-0"
                disabled={isSaving || changed.length === 0}
                onClick={() => void save()}
              >
                {isSaving ? <span className="loading loading-spinner loading-sm" /> : `Enregistrer${changed.length ? ` (${changed.length})` : ''}`}
              </button>
            )}
            {actions.includes('validate') && (
              <button
                type="button"
                className="btn btn-primary min-h-11 sm:min-h-0"
                disabled={isSaving || isSubmitting}
                onClick={() => setShowValidate(true)}
              >
                Valider l’inventaire
              </button>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <InventoryStatusBadge status={inventory.status} />
        {inventory.status === 'validated' && (
          <span className="text-sm text-base-content/65">
            Validé le {formatDateWithTime(inventory.validatedAt)}
            {inventory.validatedByName ? ` par ${inventory.validatedByName}` : ''} : le stock a été corrigé.
          </span>
        )}
        {inventory.status === 'cancelled' && inventory.notes && (
          <span className="text-sm text-base-content/65">{inventory.notes}</span>
        )}
      </div>
      {readOnlyReason && (
        <p className="rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-sm">{readOnlyReason}</p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCardDelta
          label="Produits comptés"
          value={`${formatNumber(counted.length)} / ${formatNumber(items.length)}`}
          hint={counted.length === items.length ? 'Tout est compté' : `${formatNumber(items.length - counted.length)} reste(nt) à compter`}
          tooltip="Nombre de produits dont la quantité réellement présente a été saisie. Les produits non comptés ne sont pas touchés à la validation."
        />
        <StatCardDelta
          label="Écarts"
          value={formatNumber(gaps.length)}
          tone={gaps.length > 0 ? 'warning' : 'success'}
          hint={gaps.length > 0 ? 'Produits où le compte diffère du stock' : 'Le stock correspond au comptage'}
          tooltip="Produits dont la quantité comptée ne correspond pas au stock enregistré. À la validation, le stock est corrigé pour correspondre à ce qui a été compté."
        />
        <StatCardDelta
          label="À justifier"
          value={formatNumber(unexplained.length)}
          tone={unexplained.length > 0 ? 'error' : 'success'}
          hint={unexplained.length > 0 ? 'Obligatoire avant de valider' : 'Tous les écarts sont expliqués'}
          tooltip="Chaque écart doit être expliqué (casse, vol, erreur de saisie, retour non enregistré…). L’inventaire ne peut pas être validé tant qu’un écart n’a pas de justification."
        />
        <StatCardDelta
          label={gapValue < 0 ? 'Perte estimée' : gapValue > 0 ? 'Surplus estimé' : 'Écart en valeur'}
          value={<MoneyText value={Math.abs(gapValue)} />}
          tone={gapValue < 0 ? 'error' : gapValue > 0 ? 'success' : 'neutral'}
          hint="Écarts × prix d’achat"
          tooltip="Valeur des écarts au prix d’achat : ce que représente la marchandise manquante (perte) ou en trop (surplus). Calculée sur les lignes enregistrées."
        />
      </div>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input
            type="search"
            className="input input-bordered min-h-11 w-full sm:max-w-xs"
            placeholder="Rechercher un produit…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Rechercher un produit"
          />
          <div role="tablist" className="tabs tabs-box">
            {(
              [
                ['all', 'Tous'],
                ['uncounted', 'Non comptés'],
                ['gaps', 'Avec écart'],
              ] as [Filter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                className={`tab min-h-11 sm:min-h-0 ${filter === key ? 'tab-active' : ''}`}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {visible.length === 0 ? (
        <Card>
          <EmptyState title="Aucun produit" description="Aucun produit ne correspond à ce filtre." />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-base-200">
            {visible.map((item) => {
              const draft = drafts[item.id] ?? toDraft(item);
              const value = parse(draft.counted);
              // Écart affiché pendant la saisie : par rapport au théorique enregistré.
              const difference = value === null || !Number.isFinite(value) ? null : value - item.expectedQuantity;
              const hasGap = difference !== null && Math.abs(difference) > 0.0001;
              return (
                <li key={item.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_10rem] sm:items-start sm:px-5">
                  <div className="min-w-0">
                    <div className="font-medium">{item.productName}</div>
                    <div className="text-xs text-base-content/55">
                      Stock enregistré : {formatQuantity(item.expectedQuantity, item.unit)}
                    </div>
                    {hasGap && (
                      <div className={`mt-1 text-xs font-medium ${difference! < 0 ? 'text-error' : 'text-success'}`}>
                        {difference! < 0 ? 'Manque' : 'Surplus'} {formatQuantity(Math.abs(difference!), item.unit)}
                      </div>
                    )}
                  </div>
                  <FormField label="Compté">
                    <input
                      className="input input-bordered min-h-11 w-full tabular"
                      inputMode="decimal"
                      value={draft.counted}
                      disabled={!canCount || isSaving}
                      placeholder="—"
                      onChange={(e) => setDrafts((d) => ({ ...d, [item.id]: { ...draft, counted: e.target.value } }))}
                      aria-label={`Quantité comptée de ${item.productName}`}
                    />
                  </FormField>
                  {(hasGap || draft.justification) && (
                    <div className="sm:col-span-2">
                      <input
                        className={`input input-bordered input-sm min-h-11 w-full sm:min-h-0 ${hasGap && !draft.justification.trim() ? 'input-warning' : ''}`}
                        value={draft.justification}
                        disabled={!canCount || isSaving}
                        placeholder="Justification de l’écart (obligatoire) : casse, vol, erreur de saisie…"
                        onChange={(e) => setDrafts((d) => ({ ...d, [item.id]: { ...draft, justification: e.target.value } }))}
                        aria-label={`Justification de l’écart sur ${item.productName}`}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        isOpen={showValidate}
        onClose={() => {
          if (!isSubmitting) setShowValidate(false);
        }}
        onConfirm={() => void validate()}
        title="Valider l’inventaire"
        tone="warning"
        confirmLabel="Valider et corriger le stock"
        isSubmitting={isSubmitting || isSaving}
        message={
          <>
            Un ajustement de stock sera créé pour chacun des <strong>{formatNumber(gaps.length)}</strong> écart(s)
            {gaps.length > 0 && (
              <>
                {' '}
                ({gapValue < 0 ? 'perte' : 'surplus'} estimé(e) : <MoneyText value={Math.abs(gapValue)} />)
              </>
            )}
            . L’inventaire ne pourra plus être modifié.
            {changed.length > 0 && (
              <span className="mt-2 block text-sm">
                Vos {formatNumber(changed.length)} saisie(s) non enregistrée(s) le seront d’abord.
              </span>
            )}
            {unexplained.length > 0 && (
              <span className="mt-2 block rounded-lg border border-error/30 bg-error/10 px-2.5 py-1.5 text-sm text-error">
                {formatNumber(unexplained.length)} écart(s) sans justification : la validation sera refusée.
              </span>
            )}
          </>
        }
      />

      <ConfirmDialog
        isOpen={showCancel}
        onClose={() => {
          if (!isSubmitting) setShowCancel(false);
        }}
        onConfirm={() => void cancel()}
        title="Annuler l’inventaire"
        tone="error"
        confirmLabel="Annuler l’inventaire"
        isSubmitting={isSubmitting}
        message="Les comptages seront abandonnés et le stock ne sera pas modifié. L’inventaire reste consultable."
      >
        <FormField label="Motif" required className="mb-4">
          <textarea className="textarea textarea-bordered w-full" rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
        </FormField>
      </ConfirmDialog>
    </div>
  );
}
