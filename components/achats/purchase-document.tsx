/**
 * Bon d'achat imprimable (README §7.5, §11).
 *
 * Composant **purement présentationnel** : aucun état, aucun hook, aucune
 * requête. Tout ce qui s'affiche arrive par les props — ce qui le rend
 * réutilisable tel quel par `/achats/[id]`, par la modale de détail et par les
 * exports PDF / image / WhatsApp (`lib/export-document.ts` construit son propre
 * document HTML ; ce composant-ci n'est jamais capturé, voir §11 quater).
 *
 * Différences assumées avec `components/ventes/invoice-document.tsx` :
 *  - un **fournisseur** au lieu d'un client (§14 : fournisseur obligatoire) ;
 *  - **pas de remise**, **pas de TVA**, pas de sous-total : `purchase_invoices`
 *    ne porte qu'un `total` (§6.3), un achat n'est pas une facture de vente ;
 *  - **pas de « Vendeur »** mais l'utilisateur qui a saisi l'achat, et le suivi
 *    de la **dette fournisseur** (payé / reste à payer) au pied du document.
 *
 * Aucune couleur Tailwind figée : le document est en noir sur blanc pour rester
 * imprimable quelle que soit la couleur choisie par le client dans les
 * paramètres — la couleur d'accent est réservée au filet supérieur.
 */

import { formatCurrency, formatNumber, formatQuantity } from '@/lib/format';
import { formatDateLong, formatDateShort } from '@/lib/date-format';
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';

export type PurchaseDocumentCompany = {
  companyName: string;
  companyBranch: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyTaxId: string;
  companyLogo: string;
  /** Devise affichée (par défaut GNF). */
  currency: string;
  /** Note de pied de document configurable (§9.2). */
  invoiceFooterNote?: string;
};

export type PurchaseDocumentSupplier = {
  name: string;
  /** Renseigné quand la fiche fournisseur est consultable. */
  phone?: string | null;
  address?: string | null;
  /** Numéro de facture du fournisseur (`supplierReference`). */
  reference?: string | null;
};

export type PurchaseDocumentItem = {
  id?: number | string;
  productCode: string;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  amount: number;
};

export type PurchaseDocumentInvoice = {
  reference: string;
  supplierReference?: string | null;
  date: string;
  dueDate?: string | null;
  total: number;
  amountPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  /** active | cancelled */
  status: string;
  notes?: string | null;
  cancelReason?: string | null;
  userName?: string | null;
};

/** Libellés français des statuts de paiement, côté achat (« à payer »). */
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  paid: 'Payé',
  partial: 'Partiellement payé',
  unpaid: 'À payer',
};

const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  active: 'Achat actif',
  cancelled: 'Achat annulé',
};

export function PurchaseDocument({
  id = 'purchase-document',
  company,
  invoice,
  items,
  supplier,
  width,
  className = '',
}: {
  /** Identifiant DOM du nœud imprimable (impression et repérage). */
  id?: string;
  company: PurchaseDocumentCompany;
  invoice: PurchaseDocumentInvoice;
  items: PurchaseDocumentItem[];
  /** Fournisseur obligatoire (§14) : jamais `null` sur un achat. */
  supplier: PurchaseDocumentSupplier;
  /**
   * Largeur du document. `100%` : il épouse son conteneur (aperçu dans une
   * modale) ; `48rem` sur la page pour plafonner à la largeur d'une feuille A4.
   */
  width?: string;
  className?: string;
}) {
  const currency = company.currency || 'GNF';

  const paymentStatusLabel =
    PAYMENT_STATUS_LABELS[invoice.paymentStatus] ?? invoice.paymentStatus ?? '—';
  const documentStatusLabel = DOCUMENT_STATUS_LABELS[invoice.status] ?? null;

  const isCredit = Boolean(invoice.dueDate) && Number(invoice.remainingAmount) > 0.001;

  // Total des quantités : un récapitulatif utile au magasin, sans colonne de
  // plus dans le tableau.
  const totalQuantity = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

  return (
    <article
      id={id}
      style={{ width }}
      className={`mx-auto max-w-full rounded-2xl border border-base-200 bg-white p-4 text-[13px] text-black shadow-sm sm:p-6 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none ${className}`.trim()}
    >
      {/* ── En-tête : identité de l'entreprise ───────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-primary/70 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          {/*
            Le logo vient des paramètres (base64) et retombe sur le logo livré
            avec l'application : le client a fourni son logo, un document sans
            logo serait un recul (§11 ter).
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={company.companyLogo || DEFAULT_COMPANY_LOGO}
            alt={`Logo ${company.companyName}`}
            className="h-14 w-14 shrink-0 rounded-xl object-contain sm:h-16 sm:w-16"
          />
          <div className="min-w-0">
            <p className="text-base font-bold leading-tight break-words sm:text-lg">
              {company.companyName}
            </p>
            {company.companyBranch ? (
              <p className="text-xs text-base-content/70">{company.companyBranch}</p>
            ) : null}
            <div className="mt-1 space-y-0.5 text-[11px] leading-4 text-base-content/70">
              {company.companyAddress ? <p>{company.companyAddress}</p> : null}
              <p className="tabular">
                {company.companyPhone ? `Tél. : ${company.companyPhone}` : null}
                {company.companyPhone && company.companyEmail ? ' · ' : null}
                {company.companyEmail ?? null}
              </p>
              {company.companyTaxId ? <p>NIF : {company.companyTaxId}</p> : null}
            </div>
          </div>
        </div>

        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
            Bon d&apos;achat
          </p>
          <p className="tabular text-lg font-bold leading-tight sm:text-xl">{invoice.reference}</p>
          <p className="tabular mt-1 text-xs text-base-content/70">
            Date : {formatDateLong(invoice.date)}
          </p>
          {invoice.dueDate ? (
            <p className="tabular text-xs text-base-content/70">
              Échéance : {formatDateShort(invoice.dueDate)}
            </p>
          ) : null}
          {documentStatusLabel ? (
            <p className="mt-1 text-xs font-semibold text-base-content/70">{documentStatusLabel}</p>
          ) : null}
        </div>
      </header>

      {/* ── Bloc fournisseur + règlement ─────────────────────────────────── */}
      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-base-200 px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
            Fournisseur
          </p>
          <p className="mt-0.5 text-sm font-semibold break-words">{supplier.name || '—'}</p>
          {supplier.phone ? (
            <p className="tabular text-xs text-base-content/70">{supplier.phone}</p>
          ) : null}
          {supplier.address ? (
            <p className="text-xs text-base-content/70 break-words">{supplier.address}</p>
          ) : null}
          {invoice.supplierReference ? (
            <p className="tabular mt-1 text-xs text-base-content/70">
              Réf. fournisseur : {invoice.supplierReference}
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-base-200 px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
            Règlement
          </p>
          <p className="mt-0.5 text-sm font-semibold">{invoice.paymentMethod || '—'}</p>
          <p className="text-xs text-base-content/70">Statut : {paymentStatusLabel}</p>
          {invoice.userName ? (
            <p className="text-xs text-base-content/70">Saisi par : {invoice.userName}</p>
          ) : null}
        </div>
      </section>

      {/* ── Corps : lignes de l'achat ────────────────────────────────────── */}
      <section className="mt-4">
        {items.length === 0 ? (
          <p className="rounded-xl border border-base-200 py-6 text-center text-sm text-base-content/50">
            Aucune ligne sur cet achat.
          </p>
        ) : (
          <>
            {/* Une seule mise en page, du mobile à l'impression : la largeur est
                répartie en pourcentages, donc jamais de défilement horizontal à
                360 px (§5.5 règle 1). */}
            <table className="table table-xs w-full table-fixed">
              <colgroup>
                <col style={{ width: '5%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '31%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '14%' }} />
              </colgroup>
              <thead>
                <tr className="border-base-200">
                  <th className="text-left">#</th>
                  <th className="text-left">Désignation</th>
                  <th className="text-right">Qté</th>
                  <th className="text-left">Unité</th>
                  <th className="text-right">Prix d&apos;achat</th>
                  <th className="text-right">Montant</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={item.id ?? `${item.productCode}-${index}`} className="border-base-200/70">
                    <td className="tabular text-base-content/60">{index + 1}</td>
                    <td className="break-words">{item.productName}</td>
                    <td className="tabular text-right">{formatQuantity(item.quantity)}</td>
                    <td className="break-words">{item.unit}</td>
                    <td className="tabular text-right">{formatCurrency(item.unitPrice, currency)}</td>
                    <td className="tabular text-right font-medium">
                      {formatCurrency(item.amount, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-base-200">
                  <td colSpan={3} className="text-left text-xs font-semibold">
                    Total général
                  </td>
                  <td className="tabular text-right text-xs font-semibold">
                    {formatQuantity(totalQuantity)}
                  </td>
                  <td colSpan={2} className="text-right text-xs text-base-content/60">
                    {formatNumber(items.length)} ligne(s)
                  </td>
                  <td className="tabular text-right text-xs font-semibold">
                    {formatCurrency(invoice.total, currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </section>

      {/* ── Pied : totaux et suivi de la dette fournisseur ───────────────── */}
      <section className="mt-4 flex flex-col gap-4 sm:flex-row sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2 text-xs text-base-content/70">
          {invoice.notes ? (
            <div className="rounded-xl border border-base-200 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
                Notes
              </p>
              <p className="mt-0.5 whitespace-pre-line break-words text-base-content/80">
                {invoice.notes}
              </p>
            </div>
          ) : null}
          {invoice.status === 'cancelled' ? (
            <div className="rounded-xl border border-error/40 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-error">
                Achat annulé
              </p>
              <p className="mt-0.5 break-words text-base-content/80">
                Motif : {invoice.cancelReason || 'non renseigné'}
              </p>
            </div>
          ) : null}
          {isCredit ? (
            <p className="tabular">
              Échéance de règlement : {formatDateShort(invoice.dueDate)} — dette restante{' '}
              {formatCurrency(invoice.remainingAmount, currency)}.
            </p>
          ) : null}
        </div>

        <dl className="w-full shrink-0 space-y-1 text-sm sm:w-80">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-base-200 px-2.5 py-2">
            <dt className="font-semibold">Total de l&apos;achat</dt>
            <dd className="tabular text-base font-bold">{formatCurrency(invoice.total, currency)}</dd>
          </div>

          <div className="flex items-center justify-between gap-3 border-b border-base-200 py-1.5">
            <dt className="text-base-content/60">Montant payé</dt>
            <dd className="tabular font-medium">{formatCurrency(invoice.amountPaid, currency)}</dd>
          </div>

          <div className="flex items-center justify-between gap-3 border-b border-base-200 py-1.5">
            <dt className="font-semibold">Reste à payer</dt>
            <dd
              className={`tabular font-bold ${
                Number(invoice.remainingAmount) > 0.001 ? 'text-error' : 'text-success'
              }`}
            >
              {formatCurrency(invoice.remainingAmount, currency)}
            </dd>
          </div>

          <div className="flex items-center justify-between gap-3 py-1.5">
            <dt className="text-base-content/60">Statut</dt>
            <dd className="font-semibold">{paymentStatusLabel}</dd>
          </div>
        </dl>
      </section>

      {/* ── Mentions de pied de document ─────────────────────────────────── */}
      <footer className="mt-6 space-y-1 border-t border-base-200 pt-3 text-center text-[11px] text-base-content/60">
        {company.invoiceFooterNote ? (
          <p className="whitespace-pre-line break-words">{company.invoiceFooterNote}</p>
        ) : null}
        <p>Marchandises reçues et mises en stock.</p>
        <p className="font-semibold text-base-content/70">
          {company.companyName}
          {company.companyBranch ? ` — ${company.companyBranch}` : ''}
        </p>
      </footer>
    </article>
  );
}
