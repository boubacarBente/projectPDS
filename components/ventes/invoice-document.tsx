/**
 * Document facture imprimable (README §11).
 *
 * Composant **purement présentationnel** : aucun état, aucun hook, aucune
 * requête. Tout ce qui s'affiche arrive par les props — ce qui le rend
 * réutilisable tel quel par `/ventes/[id]`, par la modale de détail et par les
 * exports PDF / image (`lib/export-document.ts`, qui capturent ce même nœud DOM
 * via son `id`).
 *
 * Structure imposée par le README §11 :
 *   en-tête (logo, entreprise, filiale, adresse, téléphone, email, NIF)
 *   → bloc client → corps (#, code, désignation, quantité, unité, prix, remise,
 *   montant) → pied (sous-total, remise, total HT, TVA, total à payer, payé,
 *   reste à payer, statut).
 *
 * Aucune couleur Tailwind figée : le document est en noir sur blanc pour rester
 * imprimable quelle que soit la couleur choisie par le client dans les
 * paramètres — la couleur d'accent est réservée au cadre supérieur.
 *
 * ⚠️ TVA à 0 % : la ligne n'est pas supprimée (le taux doit rester lisible sur
 * une facture), mais elle est affichée discrètement. Un taux non nul la remet en
 * évidence automatiquement.
 */

import { formatCurrency, formatNumber, formatQuantity } from '@/lib/format';
import { formatDateLong, formatDateShort } from '@/lib/date-format';
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';

export type InvoiceDocumentCompany = {
  companyName: string;
  companyBranch: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyTaxId: string;
  companyLogo: string;
  /** Devise affichée (par défaut GNF). */
  currency: string;
  /** Note de pied de facture configurable (§9.2). */
  invoiceFooterNote?: string;
};

export type InvoiceDocumentCustomer = {
  name: string;
  /** Renseigné quand la vente est rattachée à une fiche client. */
  phone?: string | null;
  address?: string | null;
};

export type InvoiceDocumentItem = {
  id?: number | string;
  productCode: string;
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  amount: number;
};

export type InvoiceDocumentInvoice = {
  invoiceNumber: string;
  date: string;
  dueDate?: string | null;
  subTotal: number;
  discount: number;
  totalHt: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  /** draft | active | cancelled */
  status: string;
  notes?: string | null;
  cancelReason?: string | null;
  userName?: string | null;
};

/** Libellés français des statuts de paiement (§10.4). */
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  paid: 'Payée',
  partial: 'Partiellement payée',
  unpaid: 'Impayée',
};

const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  draft: 'Brouillon — non validée',
  active: 'Facture active',
  cancelled: 'Facture annulée',
};

export function InvoiceDocument({
  id = 'invoice-document',
  company,
  invoice,
  items,
  customer,
  width,
  className = '',
}: {
  /** Identifiant DOM utilisé par les exports (`exportDocumentAsPDF`, `exportDocumentAsImage`). */
  id?: string;
  company: InvoiceDocumentCompany;
  invoice: InvoiceDocumentInvoice;
  items: InvoiceDocumentItem[];
  /** `null` = vente comptoir. */
  customer?: InvoiceDocumentCustomer | null;
  /**
   * Largeur du document. `100%` : il épouse son conteneur (aperçu dans une
   * modale) ; `100%` par défaut, `48rem` sur la page facture pour plafonner à la
   * largeur d'une feuille A4 en lecture.
   */
  width?: string;
  className?: string;
}) {
  const currency = company.currency || 'GNF';

  const paymentStatusLabel =
    PAYMENT_STATUS_LABELS[invoice.paymentStatus] ?? invoice.paymentStatus ?? '—';
  const documentStatusLabel = DOCUMENT_STATUS_LABELS[invoice.status] ?? null;

  const isCredit = Boolean(invoice.dueDate) && Number(invoice.remainingAmount) > 0.001;

  // Total des quantités : un récapitulatif utile au comptoir, sans colonne de
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
            Le logo de l'entreprise est téléversé dans les paramètres (stocké en
            base64). Tant qu'aucun logo n'a été téléversé, on affiche le logo
            livré avec l'application plutôt qu'un bloc d'initiales : le client a
            fourni son logo, une facture sans logo serait un recul.
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
            Facture
          </p>
          <p className="tabular text-lg font-bold leading-tight sm:text-xl">
            {invoice.invoiceNumber}
          </p>
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

      {/* ── Bloc client + règlement ──────────────────────────────────────── */}
      <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-base-200 px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
            Client
          </p>
          <p className="mt-0.5 text-sm font-semibold break-words">
            {customer?.name?.trim() ? customer.name : 'Client comptoir'}
          </p>
          {customer?.phone ? <p className="tabular text-xs text-base-content/70">{customer.phone}</p> : null}
          {customer?.address ? (
            <p className="text-xs text-base-content/70 break-words">{customer.address}</p>
          ) : null}
          {!customer?.name?.trim() ? (
            <p className="text-xs text-base-content/50">
              Vente au comptoir — aucune fiche client rattachée.
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
            <p className="text-xs text-base-content/70">Vendeur : {invoice.userName}</p>
          ) : null}
        </div>
      </section>

      {/* ── Corps : lignes de la facture ─────────────────────────────────── */}
      <section className="mt-4">
        {items.length === 0 ? (
          <p className="rounded-xl border border-base-200 py-6 text-center text-sm text-base-content/50">
            Aucune ligne sur cette facture.
          </p>
        ) : (
          <>
            {/* Une seule mise en page, du mobile à l'impression : la largeur est
                répartie en pourcentages, donc jamais de défilement horizontal à
                360 px (§5.5 règle 1) — et le document capturé par les exports est
                identique à celui de l'écran, sans variante responsive. */}
            <table className="table table-xs w-full table-fixed">
              <colgroup>
                <col style={{ width: '4%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '26%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '14%' }} />
              </colgroup>
              <thead>
                <tr className="border-base-200">
                  <th className="text-left">#</th>
                  <th className="text-left">Code</th>
                  <th className="text-left">Désignation</th>
                  <th className="text-right">Qté</th>
                  <th className="text-left">Unité</th>
                  <th className="text-right">Prix unit.</th>
                  <th className="text-right">Remise</th>
                  <th className="text-right">Montant</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr
                    key={item.id ?? `${item.productCode}-${index}`}
                    className="border-base-200/70"
                  >
                    <td className="tabular text-base-content/60">{index + 1}</td>
                    <td className="tabular break-all">{item.productCode}</td>
                    <td className="break-words">{item.productName}</td>
                    <td className="tabular text-right">{formatQuantity(item.quantity)}</td>
                    <td className="break-words">{item.unit}</td>
                    <td className="tabular text-right">{formatCurrency(item.unitPrice, currency)}</td>
                    <td className="tabular text-right">
                      {item.discount > 0 ? formatCurrency(item.discount, currency) : '—'}
                    </td>
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
                  <td colSpan={2} />
                  <td className="text-right text-xs text-base-content/60">
                    {items.length} ligne(s)
                  </td>
                  <td className="tabular text-right text-xs font-semibold">
                    {formatCurrency(invoice.subTotal, currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </section>

      {/* ── Pied : cascade des totaux ────────────────────────────────────── */}
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
                Facture annulée
              </p>
              <p className="mt-0.5 break-words text-base-content/80">
                Motif : {invoice.cancelReason || 'non renseigné'}
              </p>
            </div>
          ) : null}
          {isCredit ? (
            <p className="tabular">
              Échéance de règlement : {formatDateShort(invoice.dueDate)} — solde dû{' '}
              {formatCurrency(invoice.remainingAmount, currency)}.
            </p>
          ) : null}
        </div>

        <dl className="w-full shrink-0 space-y-1 text-sm sm:w-80">
          <div className="flex items-center justify-between gap-3 border-b border-base-200 py-1.5">
            <dt className="text-base-content/60">Sous-total</dt>
            <dd className="tabular font-medium">{formatCurrency(invoice.subTotal, currency)}</dd>
          </div>

          {invoice.discount > 0 ? (
            <div className="flex items-center justify-between gap-3 border-b border-base-200 py-1.5">
              <dt className="text-base-content/60">Remise globale</dt>
              <dd className="tabular font-medium">− {formatCurrency(invoice.discount, currency)}</dd>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 border-b border-base-200 py-1.5">
            <dt className="text-base-content/60">Total HT</dt>
            <dd className="tabular font-semibold">{formatCurrency(invoice.totalHt, currency)}</dd>
          </div>

          {/* TVA : discrète à 0 %, mise en évidence dès qu'un taux est configuré. */}
          <div
            className={`flex items-center justify-between gap-3 border-b border-base-200 py-1.5 ${
              Number(invoice.taxAmount) > 0 ? '' : 'text-base-content/45'
            }`}
          >
            <dt>TVA ({formatNumber(invoice.taxRate, 2)} %)</dt>
            <dd className="tabular font-medium">{formatCurrency(invoice.taxAmount, currency)}</dd>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg bg-base-200 px-2.5 py-2">
            <dt className="font-semibold">Total à payer</dt>
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
        <p>Merci pour votre confiance.</p>
        <p className="font-semibold text-base-content/70">
          {company.companyName}
          {company.companyBranch ? ` — ${company.companyBranch}` : ''}
        </p>
      </footer>
    </article>
  );
}
