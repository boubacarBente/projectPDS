'use client';

/**
 * Nouvelle demande de transfert (cahier des charges §8 ; guide §6.15).
 *
 * Aussi utilisée pour **modifier** une demande encore en brouillon ou en
 * attente : `/transferts/nouveau?edit=<id>` (action `edit` de la fiche). Les
 * magasins ne changent pas en modification — seules les lignes, le motif, la
 * date souhaitée et les notes.
 *
 * Le stock disponible à la source est **indicatif** : il est relu au moment de
 * l'expédition, qui refuse une quantité supérieure au stock (le seul blocage
 * fiable, puisque d'autres ventes peuvent avoir lieu entre-temps).
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { Combobox } from '@/components/combobox';
import { DatePicker } from '@/components/date-picker';
import { Card, EmptyState, ErrorState, FormField, PageSection, Skeleton } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { readApiError, type TransferDetailRecord } from '@/components/transferts/transfer-ui';
import { formatQuantity } from '@/lib/format';

type StoreOption = { id: number; code: string; name: string; kind: 'store' | 'headquarters' };
type Available = { id: number; name: string; unit: string; barcode: string | null; available: number };
type Line = { key: number; productId: string; quantity: string };

let lineKey = 0;
const newLine = (productId = ''): Line => ({ key: ++lineKey, productId, quantity: '' });

export default function NouveauTransfertPage() {
  // `useSearchParams` exige une frontière Suspense au rendu statique (Next 16).
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <NouveauTransfert />
    </Suspense>
  );
}

function NouveauTransfert() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = Number(searchParams.get('edit')) || null;
  const presetProduct = searchParams.get('productId') ?? '';
  const canCreate = usePermission('transfers.create');
  const { activeStoreId, stores: myStores } = useAuth();

  const [stores, setStores] = useState<StoreOption[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [reason, setReason] = useState('');
  const [requestedDate, setRequestedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [newLine(presetProduct)]);
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<'draft' | 'submit' | 'edit' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  /* Annuaire des magasins, puis la demande à modifier le cas échéant. */
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch('/api/transferts/magasins', { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error(await readApiError(response, 'Liste des magasins indisponible.'));
        const list = (await response.json()) as StoreOption[];
        if (!active) return;
        setStores(list);

        if (editId) {
          const detailResponse = await fetch(`/api/transferts/${editId}`, { cache: 'no-store', credentials: 'same-origin' });
          if (!detailResponse.ok) throw new Error(await readApiError(detailResponse, 'Transfert introuvable.'));
          const detail = (await detailResponse.json()) as TransferDetailRecord;
          if (!active) return;
          if (!detail.actions.includes('edit')) {
            throw new Error('Ce transfert ne peut plus être modifié à cette étape.');
          }
          setSourceId(String(detail.transfer.sourceStoreId));
          setDestinationId(String(detail.transfer.destinationStoreId));
          setReason(detail.transfer.reason ?? '');
          setRequestedDate(detail.transfer.requestedDate ?? '');
          setNotes(detail.transfer.notes ?? '');
          setLines(detail.items.map((item) => ({ key: ++lineKey, productId: String(item.productId), quantity: String(item.quantityRequested) })));
        } else if (activeStoreId) {
          // Cas le plus courant : on demande de la marchandise POUR son magasin.
          setDestinationId(String(activeStoreId));
          const other = list.find((s) => s.id !== activeStoreId && s.kind === 'headquarters') ?? list.find((s) => s.id !== activeStoreId);
          if (other) setSourceId(String(other.id));
        }
      } catch (caught) {
        if (active) setLoadError(caught instanceof Error ? caught.message : 'Chargement impossible.');
      }
    })();
    return () => {
      active = false;
    };
  }, [editId, activeStoreId]);

  /* Disponible au magasin source : rechargé à chaque changement de source. */
  useEffect(() => {
    if (!sourceId) {
      setAvailable(null);
      return;
    }
    let active = true;
    setAvailable(null);
    setAvailableError(null);
    fetch(`/api/transferts/disponible?source=${sourceId}`, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response, 'Stock du magasin source indisponible.'));
        const list = (await response.json()) as Available[];
        if (active) setAvailable(list);
      })
      .catch((caught: unknown) => {
        if (active) setAvailableError(caught instanceof Error ? caught.message : 'Stock du magasin source indisponible.');
      });
    return () => {
      active = false;
    };
  }, [sourceId]);

  const byProduct = useMemo(() => new Map((available ?? []).map((p) => [String(p.id), p])), [available]);
  const productOptions = useMemo(
    () =>
      (available ?? []).map((p) => ({
        value: String(p.id),
        label: p.name,
        hint: p.available > 0 ? `Disponible : ${formatQuantity(p.available, p.unit)}` : 'Rupture au magasin source',
      })),
    [available],
  );

  const myStoreIds = new Set(myStores.map((s) => s.id));
  const sourceStore = stores?.find((s) => String(s.id) === sourceId) ?? null;
  const destinationStore = stores?.find((s) => String(s.id) === destinationId) ?? null;
  const involvesMe = myStoreIds.has(Number(sourceId)) || myStoreIds.has(Number(destinationId));

  const setLine = (key: number, changes: Partial<Line>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...changes } : l)));

  const validate = (): string | null => {
    if (!sourceId || !destinationId) return 'Choisissez le magasin source et le magasin destinataire.';
    if (sourceId === destinationId) return 'Le magasin source et le magasin destinataire doivent être différents.';
    if (!involvesMe) return 'Vous devez être affecté au magasin source ou au magasin destinataire.';
    const filled = lines.filter((l) => l.productId);
    if (filled.length === 0) return 'Ajoutez au moins un produit.';
    for (const [index, line] of filled.entries()) {
      const quantity = Number(line.quantity.replace(',', '.'));
      if (!Number.isFinite(quantity) || quantity <= 0) return `Ligne ${index + 1} : la quantité doit être supérieure à zéro.`;
    }
    const ids = filled.map((l) => l.productId);
    if (new Set(ids).size !== ids.length) return 'Un même produit apparaît sur deux lignes : regroupez les quantités.';
    return null;
  };

  const submit = async (mode: 'draft' | 'submit' | 'edit') => {
    const problem = validate();
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setIsSubmitting(mode);
    const items = lines
      .filter((l) => l.productId)
      .map((l) => ({ productId: Number(l.productId), quantity: Number(l.quantity.replace(',', '.')) }));
    try {
      const response = await fetch(editId ? `/api/transferts/${editId}` : '/api/transferts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(
          editId
            ? { action: 'edit', reason: reason.trim() || null, requestedDate: requestedDate || null, notes: notes.trim() || null, items }
            : {
                sourceStoreId: Number(sourceId),
                destinationStoreId: Number(destinationId),
                reason: reason.trim() || null,
                requestedDate: requestedDate || null,
                notes: notes.trim() || null,
                items,
                submit: mode === 'submit',
              },
        ),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Le transfert n’a pas pu être enregistré.'));
      const detail = (await response.json()) as TransferDetailRecord;
      toast.success(
        editId
          ? 'Transfert modifié'
          : mode === 'submit'
            ? `Demande ${detail.transfer.reference} envoyée`
            : `Brouillon ${detail.transfer.reference} enregistré`,
      );
      router.push(`/transferts/${detail.transfer.id}`);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'Le transfert n’a pas pu être enregistré.');
      setIsSubmitting(null);
    }
  };

  if (!canCreate) {
    return (
      <Card>
        <EmptyState title="Accès réservé" description="Votre compte ne permet pas de demander un transfert." />
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card>
        <ErrorState description={loadError} onRetry={() => window.location.reload()} />
      </Card>
    );
  }

  const busy = isSubmitting !== null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/transferts" className="hover:underline">
            Transferts
          </Link>
        }
        title={editId ? 'Modifier le transfert' : 'Nouveau transfert'}
        description="Indiquez d’où part la marchandise, où elle va, et quels produits. Le stock ne bouge qu’à l’expédition puis à la réception."
      />

      {stores === null ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <PageSection title="Trajet">
            <Card>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Magasin source (qui envoie)" htmlFor="transfer-source" required>
                  <select
                    id="transfer-source"
                    className="select select-bordered min-h-11 w-full"
                    value={sourceId}
                    disabled={busy || Boolean(editId)}
                    onChange={(e) => setSourceId(e.target.value)}
                  >
                    <option value="">Choisir…</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id} disabled={String(s.id) === destinationId}>
                        {s.name}
                        {s.kind === 'headquarters' ? ' (siège)' : ''}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField
                  label="Magasin destinataire (qui reçoit)"
                  htmlFor="transfer-destination"
                  required
                  hint="Vous devez travailler dans l’un des deux magasins."
                >
                  <select
                    id="transfer-destination"
                    className="select select-bordered min-h-11 w-full"
                    value={destinationId}
                    disabled={busy || Boolean(editId)}
                    onChange={(e) => setDestinationId(e.target.value)}
                  >
                    <option value="">Choisir…</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id} disabled={String(s.id) === sourceId}>
                        {s.name}
                        {s.kind === 'headquarters' ? ' (siège)' : ''}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Motif" htmlFor="transfer-reason" hint="Ex. réassort, rupture, ouverture d’un magasin.">
                  <input
                    id="transfer-reason"
                    className="input input-bordered min-h-11 w-full"
                    value={reason}
                    disabled={busy}
                    onChange={(e) => setReason(e.target.value)}
                    autoComplete="off"
                  />
                </FormField>
                <FormField label="Date souhaitée" htmlFor="transfer-date" hint="Facultatif.">
                  <DatePicker value={requestedDate} onChange={setRequestedDate} placeholder="jj mois aaaa" />
                </FormField>
              </div>
              {sourceStore && destinationStore && (
                <p className="mt-4 rounded-xl border border-base-200 bg-base-200/40 px-3 py-2 text-sm text-base-content/70">
                  <strong>{sourceStore.name}</strong> enverra la marchandise à <strong>{destinationStore.name}</strong>.
                </p>
              )}
            </Card>
          </PageSection>

          <PageSection
            title="Produits"
            subtitle={sourceStore ? `Quantités disponibles au magasin « ${sourceStore.name} ».` : 'Choisissez d’abord le magasin source.'}
          >
            <Card>
              {availableError && <p className="mb-3 text-sm text-error">{availableError}</p>}
              <ul className="space-y-3">
                {lines.map((line, index) => {
                  const product = byProduct.get(line.productId);
                  const quantity = Number(line.quantity.replace(',', '.'));
                  const tooMuch = product && Number.isFinite(quantity) && quantity > product.available;
                  return (
                    <li key={line.key} className="rounded-xl border border-base-200 p-3">
                      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
                        <FormField label={`Produit ${index + 1}`}>
                          <Combobox
                            value={line.productId}
                            onChange={(value) => setLine(line.key, { productId: value })}
                            options={productOptions}
                            placeholder={available === null ? 'Chargement…' : 'Rechercher un produit…'}
                            disabled={busy || available === null}
                            ariaLabel={`Produit de la ligne ${index + 1}`}
                          />
                        </FormField>
                        <FormField label={product ? `Quantité (${product.unit})` : 'Quantité'}>
                          <input
                            className="input input-bordered min-h-11 w-full tabular"
                            inputMode="decimal"
                            value={line.quantity}
                            disabled={busy}
                            onChange={(e) => setLine(line.key, { quantity: e.target.value })}
                            aria-label={`Quantité de la ligne ${index + 1}`}
                          />
                        </FormField>
                        <button
                          type="button"
                          className="btn btn-ghost min-h-11 text-error"
                          disabled={busy || lines.length === 1}
                          onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}
                          aria-label={`Retirer la ligne ${index + 1}`}
                        >
                          Retirer
                        </button>
                      </div>
                      {product && (
                        <p className={`mt-2 text-xs ${tooMuch ? 'text-warning' : 'text-base-content/55'}`}>
                          {tooMuch
                            ? `Attention : seulement ${formatQuantity(product.available, product.unit)} disponible(s) à la source aujourd’hui. L’expédition sera refusée si le stock reste insuffisant.`
                            : `Disponible à la source : ${formatQuantity(product.available, product.unit)}`}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                className="btn btn-outline btn-sm mt-4 min-h-11 sm:min-h-0"
                disabled={busy}
                onClick={() => setLines((current) => [...current, newLine()])}
              >
                Ajouter un produit
              </button>
            </Card>
          </PageSection>

          <PageSection title="Notes">
            <Card>
              <textarea
                className="textarea textarea-bordered w-full"
                rows={3}
                value={notes}
                disabled={busy}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Informations pour le magasin source (facultatif)"
                aria-label="Notes"
              />
            </Card>
          </PageSection>

          {formError && (
            <p role="alert" className="rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
              {formError}
            </p>
          )}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Link href={editId ? `/transferts/${editId}` : '/transferts'} className="btn btn-ghost min-h-11">
              Annuler
            </Link>
            {editId ? (
              <button type="button" className="btn btn-primary min-h-11" disabled={busy} onClick={() => void submit('edit')}>
                {isSubmitting === 'edit' ? <span className="loading loading-spinner loading-sm" /> : 'Enregistrer les modifications'}
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-outline min-h-11" disabled={busy} onClick={() => void submit('draft')}>
                  {isSubmitting === 'draft' ? <span className="loading loading-spinner loading-sm" /> : 'Enregistrer le brouillon'}
                </button>
                <button type="button" className="btn btn-primary min-h-11" disabled={busy} onClick={() => void submit('submit')}>
                  {isSubmitting === 'submit' ? <span className="loading loading-spinner loading-sm" /> : 'Envoyer la demande'}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
