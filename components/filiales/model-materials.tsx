'use client';

import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Modal } from '@/components/modal';
import { EmptyState, MoneyText, SkeletonTable } from '@/components/design-system';
import { branchApiUrl, useBranch } from '@/components/filiales/branch-context';
import { readApiError } from '@/components/workers/workers-modals';
import { formatQuantity } from '@/lib/format';

/**
 * Nomenclature d'un modèle de filiale (README §31.3) : matières nécessaires
 * pour **une** unité. Elle sert à calculer les besoins d'une production et à
 * « sortir les matières prévues » ; elle ne sort jamais rien du stock seule.
 * Prix d'achat masqués par le serveur sans `balances.view` (invariant 13).
 */

type ProductOption = { id: number; name: string; unit: string; stock: number };

type MaterialLine = {
  id?: number;
  productId: number;
  productName: string;
  unit: string;
  quantity: number;
  notes: string | null;
  purchasePrice?: number | null;
  amount?: number | null;
  availableStock?: number;
};

type Draft = { productId: string; quantity: string; notes: string };

export function ModelMaterialsModal({
  isOpen,
  onClose,
  model,
  products,
  canEdit,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  model: { id: number; name: string; unit?: string } | null;
  products: ProductOption[];
  canEdit: boolean;
  onSaved?: () => void;
}) {
  const { branch } = useBranch();
  const [lines, setLines] = useState<MaterialLine[] | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !model) return;
    const controller = new AbortController();
    setLines(null);
    setIsEditing(false);
    setError(null);
    fetch(branchApiUrl(`/modeles/${model.id}/nomenclature`), { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'La nomenclature n’a pas pu être chargée.'));
        return (await response.json()) as MaterialLine[];
      })
      .then(setLines)
      .catch((reason) => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : 'La nomenclature n’a pas pu être chargée.');
      });
    return () => controller.abort();
  }, [isOpen, model]);

  function startEdit() {
    setDrafts(
      (lines ?? []).map((line) => ({ productId: String(line.productId), quantity: String(line.quantity), notes: line.notes ?? '' })),
    );
    if ((lines ?? []).length === 0) setDrafts([{ productId: '', quantity: '', notes: '' }]);
    setIsEditing(true);
  }

  async function save() {
    if (!model) return;
    const materials = drafts
      .filter((d) => d.productId)
      .map((d) => ({ productId: Number(d.productId), quantity: Number(d.quantity.replace(',', '.')), notes: d.notes.trim() || null }));
    if (materials.some((m) => !Number.isFinite(m.quantity) || m.quantity <= 0)) {
      toast.error('Chaque matière doit avoir une quantité supérieure à zéro.');
      return;
    }
    setIsSaving(true);
    try {
      const response = await fetch(branchApiUrl(`/modeles/${model.id}/nomenclature`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ materials }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'La nomenclature n’a pas pu être enregistrée.'));
      setLines((await response.json()) as MaterialLine[]);
      setIsEditing(false);
      toast.success(`Nomenclature de « ${model.name} » enregistrée.`);
      onSaved?.();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'La nomenclature n’a pas pu être enregistrée.', { autoClose: 8000 });
    } finally {
      setIsSaving(false);
    }
  }

  const total = (lines ?? []).reduce((sum, line) => sum + (line.amount ?? 0), 0);
  const showCosts = (lines ?? []).some((line) => line.amount !== null && line.amount !== undefined);

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !isSaving && onClose()}
      title={`Nomenclature — ${model?.name ?? ''}`}
      size="lg"
      fullScreenMobile
      footer={
        isEditing ? (
          <>
            <button type="button" className="btn btn-ghost min-h-11" onClick={() => setIsEditing(false)} disabled={isSaving}>
              Annuler
            </button>
            <button type="button" className="btn btn-primary min-h-11" onClick={() => void save()} disabled={isSaving}>
              {isSaving ? 'Enregistrement…' : 'Enregistrer la nomenclature'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-ghost min-h-11" onClick={onClose}>
              Fermer
            </button>
            {canEdit && lines !== null && (
              <button type="button" className="btn btn-primary min-h-11" onClick={startEdit}>
                Modifier
              </button>
            )}
          </>
        )
      }
    >
      <p className="mb-4 rounded-xl border border-base-200 bg-base-200/40 px-4 py-3 text-sm text-base-content/70">
        Matières nécessaires pour <strong>une</strong> unité de ce modèle dans « {branch.name} ». Une production en déduit ses
        besoins ; les matières ne sortent du stock que lorsqu’on les sort sur la production (chutes comprises).
      </p>
      {error ? (
        <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
          {error}
        </p>
      ) : lines === null ? (
        <SkeletonTable rows={3} cols={3} />
      ) : isEditing ? (
        <div className="space-y-3">
          {drafts.map((draft, index) => (
            <div key={index} className="grid gap-2 rounded-xl border border-base-200 p-3 sm:grid-cols-[1fr_8rem_1fr_auto] sm:items-end">
              <label className="form-control">
                <span className="label-text text-xs">Matière</span>
                <select
                  className="select select-bordered min-h-11 w-full"
                  value={draft.productId}
                  onChange={(event) => setDrafts((all) => all.map((d, i) => (i === index ? { ...d, productId: event.target.value } : d)))}
                  disabled={isSaving}
                >
                  <option value="">— Produit —</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} ({product.unit})
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-control">
                <span className="label-text text-xs">Quantité / unité</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  className="input input-bordered min-h-11 w-full tabular"
                  value={draft.quantity}
                  onChange={(event) => setDrafts((all) => all.map((d, i) => (i === index ? { ...d, quantity: event.target.value } : d)))}
                  disabled={isSaving}
                />
              </label>
              <label className="form-control">
                <span className="label-text text-xs">Observation</span>
                <input
                  type="text"
                  autoComplete="off"
                  className="input input-bordered min-h-11 w-full"
                  value={draft.notes}
                  onChange={(event) => setDrafts((all) => all.map((d, i) => (i === index ? { ...d, notes: event.target.value } : d)))}
                  disabled={isSaving}
                />
              </label>
              <button
                type="button"
                className="btn btn-ghost min-h-11 text-error"
                aria-label="Retirer cette matière"
                onClick={() => setDrafts((all) => all.filter((_, i) => i !== index))}
                disabled={isSaving}
              >
                Retirer
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-ghost min-h-11 border border-base-300"
            onClick={() => setDrafts((all) => [...all, { productId: '', quantity: '', notes: '' }])}
            disabled={isSaving}
          >
            Ajouter une matière
          </button>
        </div>
      ) : lines.length === 0 ? (
        <EmptyState
          title="Aucune nomenclature"
          description="Ce modèle n’a pas de matières déclarées : ses productions saisissent leurs matières une à une, ou leurs intrants en dépenses."
        />
      ) : (
        <ul className="divide-y divide-base-200 rounded-xl border border-base-200 text-sm">
          {lines.map((line) => (
            <li key={line.productId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <span className="font-medium">{line.productName}</span>
                {line.notes ? <span className="block text-xs text-base-content/60">{line.notes}</span> : null}
              </span>
              <span className="tabular text-right">
                {formatQuantity(line.quantity, line.unit)}
                {line.availableStock !== undefined && (
                  <span className="block text-xs text-base-content/60">stock : {formatQuantity(line.availableStock, line.unit)}</span>
                )}
                {showCosts && line.amount !== null && line.amount !== undefined && <MoneyText value={line.amount} className="block text-xs" />}
              </span>
            </li>
          ))}
          {showCosts && (
            <li className="flex items-center justify-between px-3 py-2 font-semibold">
              <span>Coût matière estimé d’une unité</span>
              <MoneyText value={total} bold />
            </li>
          )}
        </ul>
      )}
    </Modal>
  );
}

type ImportCandidate = {
  furnitureModelId: number;
  code: string;
  name: string;
  salePrice: number;
  materialsCount: number;
  importedModelId: number | null;
};

/**
 * Reprise des modèles de l'ancien atelier (README §31.9) — filiale « Meubles »
 * seulement. Visible tant qu'il reste des modèles d'atelier non repris dans le
 * magasin actif.
 */
export function AtelierImportCard({ onImported }: { onImported?: () => void }) {
  const { branch, api, canLevel, writable } = useBranch();
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (branch.activity !== 'furniture') return;
    const controller = new AbortController();
    fetch(api('/modeles/import-atelier'), { cache: 'no-store', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as ImportCandidate[]) : []))
      .then(setCandidates)
      .catch(() => setCandidates([]));
    return () => controller.abort();
  }, [api, branch.activity, version]);

  const pending = candidates.filter((c) => c.importedModelId == null);
  if (branch.activity !== 'furniture' || pending.length === 0) return null;
  const canImport = canLevel('manage') && writable;

  async function runImport() {
    setIsImporting(true);
    try {
      const response = await fetch(api('/modeles/import-atelier'), { method: 'POST' });
      if (!response.ok) throw new Error(await readApiError(response, 'La reprise des modèles a échoué.'));
      const result = (await response.json()) as { imported: number; skipped: number };
      toast.success(
        `${result.imported} modèle(s) de l’atelier repris avec leur nomenclature${result.skipped ? ` ; ${result.skipped} ignoré(s) (produit déjà lié à un autre modèle)` : ''}.`,
      );
      setVersion((v) => v + 1);
      onImported?.();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'La reprise des modèles a échoué.', { autoClose: 8000 });
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <div role="status" className="alert alert-info flex flex-col items-start gap-3 sm:flex-row sm:items-center">
      <div className="flex-1 text-sm">
        <strong>{pending.length} modèle(s) de l’ancien atelier</strong> ne sont pas encore repris dans cette filiale pour le magasin
        actif ({pending.slice(0, 3).map((c) => c.name).join(', ')}
        {pending.length > 3 ? '…' : ''}). La reprise crée pour chacun un modèle avec son produit (stock et prix) et sa nomenclature.
      </div>
      {canImport && (
        <button type="button" className="btn btn-primary min-h-11" onClick={() => void runImport()} disabled={isImporting}>
          {isImporting ? 'Reprise…' : 'Reprendre les modèles'}
        </button>
      )}
    </div>
  );
}
