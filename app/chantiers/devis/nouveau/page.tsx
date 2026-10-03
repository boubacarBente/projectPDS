'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { DatePicker } from '@/components/date-picker';
import { Card, ErrorState, FormField, MoneyText, SkeletonCards } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { useSettings } from '@/app/parametres/page';
import { jobCategoryOptions } from '@/components/chantiers/chantiers-modals';
import { addDays, today } from '@/lib/format';
import {
  CustomerPicker,
  ServiceLinesEditor,
  linesPayload,
  newLine,
  readApiError,
  resolveLine,
  useActiveServices,
  useCustomers,
  type LineDraft,
  type QuoteItemRow,
  type QuoteRow,
  type ServiceRequestRow,
} from '@/components/prestations/shared';

/* ==================================================================
 * Établir ou modifier un devis (cahier « Prestations » §9).
 *
 *  - `?demande=<id>` : préremplit client, adresse et prestations souhaitées à
 *    partir d'une demande, qui passe en « devis à préparer » ;
 *  - `?modifier=<id>` : modification d'un devis en brouillon ou envoyé.
 *
 * Les prestations viennent **du catalogue du magasin actif** : un devis ne
 * peut proposer que ce que le magasin vend (le serveur le revérifie).
 * ================================================================== */

export default function NouveauDevisPage() {
  const router = useRouter();
  const canCreate = usePermission('jobs.create');
  const canUpdate = usePermission('jobs.update');
  const { activeStore } = useAuth();
  const { settings } = useSettings();
  const { services, isLoading: servicesLoading } = useActiveServices();
  const { customers, isLoading: customersLoading, add: addCustomer } = useCustomers();

  const [mode, setMode] = useState<{ editId: number | null; requestId: number | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState('');
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(today());
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Le mode se lit dans l'URL au montage (sans `useSearchParams`, qui imposerait une frontière Suspense).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setMode({ editId: Number(params.get('modifier')) || null, requestId: Number(params.get('demande')) || null });
  }, []);

  useEffect(() => {
    const validity = Number(settings.quoteValidityDays ?? 30) || 30;
    setValidUntil((current) => current || addDays(date, validity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.quoteValidityDays]);

  // Préremplissage : devis à modifier ou demande d'origine.
  useEffect(() => {
    if (!mode) return;
    const controller = new AbortController();
    if (mode.editId) {
      fetch(`/api/devis/${mode.editId}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(await readApiError(response, 'Le devis n’a pas pu être chargé.'));
          return (await response.json()) as { quote: QuoteRow; items: QuoteItemRow[] };
        })
        .then(({ quote, items }) => {
          if (quote.status !== 'draft' && quote.status !== 'sent') {
            throw new Error('Ce devis n’est plus modifiable (accepté, refusé ou annulé).');
          }
          setReference(quote.reference);
          setCustomerId(String(quote.customerId));
          setCategory(quote.category ?? '');
          setTitle(quote.title ?? '');
          setSiteAddress(quote.siteAddress ?? '');
          setDescription(quote.description ?? '');
          setDate(quote.date);
          setValidUntil(quote.validUntil ?? '');
          setNotes(quote.notes ?? '');
          setLines(
            items.map((item) =>
              newLine({
                serviceId: item.serviceId ? String(item.serviceId) : '',
                quantity: String(item.quantity),
                unitPrice: String(item.unitPrice),
                discountPercent: item.discountPercent ? String(item.discountPercent) : '',
              }),
            ),
          );
        })
        .catch((caught) => {
          if (caught instanceof Error && caught.name === 'AbortError') return;
          setLoadError(caught instanceof Error ? caught.message : 'Le devis n’a pas pu être chargé.');
        });
    } else if (mode.requestId) {
      fetch(`/api/demandes/${mode.requestId}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(await readApiError(response, 'La demande n’a pas pu être chargée.'));
          return (await response.json()) as ServiceRequestRow;
        })
        .then((request) => {
          setReference(request.reference);
          setCustomerId(String(request.customerId));
          setSiteAddress(request.siteAddress ?? '');
          setDescription(request.need);
          const wished = request.services.filter((s) => s.serviceId);
          if (wished.length) setLines(wished.map((s) => newLine({ serviceId: String(s.serviceId) })));
        })
        .catch((caught) => {
          if (caught instanceof Error && caught.name === 'AbortError') return;
          setLoadError(caught instanceof Error ? caught.message : 'La demande n’a pas pu être chargée.');
        });
    }
    return () => controller.abort();
  }, [mode]);

  // Catégorie proposée : celle de la première prestation choisie.
  useEffect(() => {
    if (category) return;
    const first = lines.map((line) => services.find((s) => String(s.id) === line.serviceId)).find(Boolean);
    if (first) setCategory(first.category);
  }, [lines, services, category]);

  const total = useMemo(() => lines.reduce((sum, line) => sum + resolveLine(line, services).amount, 0), [lines, services]);
  const discountTotal = useMemo(
    () =>
      lines.reduce((sum, line) => {
        const r = resolveLine(line, services);
        return sum + (r.quantity * r.unitPrice - r.amount);
      }, 0),
    [lines, services],
  );

  const isEdit = Boolean(mode?.editId);
  const allowed = isEdit ? canUpdate : canCreate;

  async function submit() {
    if (isSubmitting || !mode) return;
    if (!customerId) return setFormError('Choisissez le client du devis.');
    const items = linesPayload(lines);
    if (items.length === 0) return setFormError('Ajoutez au moins une prestation.');
    if (items.some((item) => !(item.quantity > 0))) return setFormError('Chaque prestation doit avoir une quantité positive.');
    if (validUntil && validUntil < date) return setFormError('La date de validité ne peut pas précéder la date du devis.');

    setFormError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(isEdit ? `/api/devis/${mode.editId}` : '/api/devis', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          customerId: Number(customerId),
          requestId: isEdit ? undefined : mode.requestId,
          category: category || null,
          title: title.trim() || null,
          siteAddress: siteAddress.trim() || null,
          description: description.trim() || null,
          date,
          validUntil: validUntil || null,
          notes: notes.trim() || null,
          items,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Le devis n’a pas pu être enregistré.'));
      const saved = (await response.json()) as QuoteRow;
      toast.success(isEdit ? `Devis ${saved.reference} modifié.` : `Devis ${saved.reference} établi.`);
      router.push(`/chantiers/devis/${saved.id}`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Le devis n’a pas pu être enregistré.';
      setFormError(message);
      toast.error(message);
      setIsSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Devis" title="Devis" description="Établir un devis de prestation." />
        <Card>
          <ErrorState title="Impossible de continuer" description={loadError} />
        </Card>
        <div className="flex justify-center">
          <Link href="/chantiers/devis" className="btn btn-ghost min-h-11">
            Retour aux devis
          </Link>
        </div>
      </div>
    );
  }

  if (!mode) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
        <PageHeader eyebrow="Devis" title="Nouveau devis" description="Chargement…" />
        <SkeletonCards count={2} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow="Devis"
        title={isEdit ? `Modifier le devis ${reference ?? ''}` : 'Nouveau devis'}
        description={
          mode.requestId && reference
            ? `À partir de la demande ${reference} — client, adresse et prestations souhaitées sont repris.`
            : `Devis du magasin ${activeStore?.name ?? 'actif'}, à partir de son catalogue de prestations.`
        }
      />

      {!allowed ? (
        <Card>
          <ErrorState title="Action non autorisée" description="Votre rôle ne permet pas d’établir ou de modifier un devis." />
        </Card>
      ) : (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Card className="space-y-4">
            <h2 className="text-base font-semibold">Client et chantier</h2>
            <FormField label="Client" htmlFor="quote-customer" required>
              <CustomerPicker
                id="quote-customer"
                value={customerId}
                onChange={setCustomerId}
                customers={customers}
                isLoading={customersLoading}
                onCreated={addCustomer}
                disabled={isSubmitting}
              />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Intitulé" htmlFor="quote-title" hint="Ce que le client lira en titre du devis.">
                <input
                  id="quote-title"
                  type="text"
                  className="input input-bordered min-h-11 w-full"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Ex. Rénovation salle de bain"
                  disabled={isSubmitting}
                />
              </FormField>
              <FormField label="Type de prestation" htmlFor="quote-category" hint="Proposé d’après la première prestation.">
                <select
                  id="quote-category"
                  className="select select-bordered min-h-11 w-full"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  disabled={isSubmitting}
                >
                  <option value="">Choisir…</option>
                  {jobCategoryOptions(settings.jobCategories ?? [], category).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            <FormField label="Adresse du chantier" htmlFor="quote-site">
              <input
                id="quote-site"
                type="text"
                className="input input-bordered min-h-11 w-full"
                value={siteAddress}
                onChange={(event) => setSiteAddress(event.target.value)}
                placeholder="Quartier, commune, repère…"
                disabled={isSubmitting}
              />
            </FormField>
            <FormField label="Description des travaux" htmlFor="quote-description">
              <textarea
                id="quote-description"
                className="textarea textarea-bordered min-h-24 w-full"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Nature des travaux, contraintes, ce qui est inclus…"
                disabled={isSubmitting}
              />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Date du devis">
                <DatePicker value={date} onChange={setDate} placeholder="Date" />
              </FormField>
              <FormField label="Valable jusqu’au" hint="Après cette date, le devis apparaît « expiré ».">
                <DatePicker value={validUntil} onChange={setValidUntil} placeholder="Validité" />
              </FormField>
            </div>
          </Card>

          <Card className="space-y-4">
            <div>
              <h2 className="text-base font-semibold">Prestations</h2>
              <p className="text-sm text-base-content/60">
                Prix du catalogue proposé, modifiable ligne par ligne. Il sera figé dans le devis.
              </p>
            </div>
            <ServiceLinesEditor
              lines={lines}
              onChange={setLines}
              services={services}
              isLoading={servicesLoading}
              disabled={isSubmitting}
            />
          </Card>

          <Card className="space-y-4">
            <FormField label="Notes" htmlFor="quote-notes" hint="Conditions, délais, modalités de paiement… (imprimées sur le devis).">
              <textarea
                id="quote-notes"
                className="textarea textarea-bordered min-h-20 w-full"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={isSubmitting}
              />
            </FormField>
            <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
              <div className="text-sm text-base-content/70">
                {discountTotal > 0.5 && (
                  <span className="block">
                    Remises accordées : <MoneyText value={discountTotal} />
                  </span>
                )}
                <span className="block">Montant du devis</span>
              </div>
              <MoneyText value={total} bold className="text-2xl" />
            </div>
          </Card>

          {formError && (
            <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
              {formError}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-3">
            <Link href={isEdit ? `/chantiers/devis/${mode.editId}` : '/chantiers/devis'} className="btn btn-ghost min-h-11">
              Annuler
            </Link>
            <button type="submit" className="btn btn-primary min-h-11" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <span className="loading loading-spinner loading-sm" aria-hidden />
                  Enregistrement…
                </>
              ) : isEdit ? (
                'Enregistrer le devis'
              ) : (
                'Établir le devis'
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
