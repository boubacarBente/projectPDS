'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'react-toastify';
import { Badge, MoneyText, type BadgeTone } from '@/components/design-system';
import { shareOnWhatsApp } from '@/components/export-dropdown';
import { useSettings } from '@/app/parametres/page';
import { companyFromSettings, type DevisCompany } from '@/components/chantiers/chantiers-modals';
import { applyStoreLetterhead, type StoreLetterheadView } from '@/lib/settings-schema';
import { exportCompanyFromSettings, exportDocumentAsImage, exportDocumentAsPDF, type ExportBlock } from '@/lib/export-document';
import { formatCurrency, formatQuantity } from '@/lib/format';

/* ==================================================================
 * Documents de prestation (devis, facture de chantier) — écran et export.
 *
 * Règles reprises de README §11.1 / AGENTS.md n° 5 et 14 :
 *  - en-tête **au nom du magasin émetteur** (`applyStoreLetterhead`) ;
 *  - l'export ne capture jamais la page : il rend un document HTML autonome
 *    (`renderExportDocument`) — le **même** pour PDF, image et WhatsApp ;
 *  - aucun coût interne ni marge n'apparaît sur un document client : seules
 *    les lignes de **prestations** (prix de vente) y figurent.
 * ================================================================== */

export type DocumentLine = {
  name: string;
  code?: string | null;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  amount: number;
};

/** Paramètres d'en-tête du magasin émetteur, pour l'écran et pour l'export. */
export function useDocumentCompany(store: StoreLetterheadView | undefined) {
  const { settings } = useSettings();
  const docSettings = useMemo(() => applyStoreLetterhead(settings, store ?? null), [settings, store]);
  const company = useMemo(() => companyFromSettings(docSettings), [docSettings]);
  const exportCompany = useMemo(() => exportCompanyFromSettings(docSettings), [docSettings]);
  return { company, exportCompany };
}

export function DocumentShell({
  id,
  company,
  title,
  number,
  dateLines,
  badge,
  children,
  footer,
}: {
  id: string;
  company: DevisCompany;
  title: string;
  number: string;
  dateLines: string[];
  badge?: { label: string; tone: BadgeTone } | null;
  children: ReactNode;
  footer?: string | null;
}) {
  return (
    <div id={id} className="print-area mx-auto w-full max-w-4xl rounded-2xl border border-base-200 bg-base-100 p-5 shadow-sm sm:p-8">
      {/*
        Même disposition que la facture de vente (components/ventes/invoice-document.tsx)
        et que l'export (renderExportDocument) : identité à gauche, titre à droite,
        puis les coordonnées sur toute la largeur. Sous le nom, la ligne des
        téléphones élargissait le bloc de gauche et rejetait le titre au milieu.
      */}
      <header className="border-b-2 border-primary/70 pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {company.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={company.logo} alt={`Logo ${company.name}`} className="h-14 w-14 shrink-0 rounded-xl border border-base-200 object-contain sm:h-16 sm:w-16" />
            ) : null}
            <div className="min-w-0">
              <p className="text-base font-bold leading-tight wrap-break-word sm:text-lg">{company.name}</p>
              {company.branch ? <p className="text-xs text-base-content/70 sm:text-sm">{company.branch}</p> : null}
            </div>
          </div>
          <div className="shrink-0 sm:text-right">
            <p className="text-xl font-extrabold uppercase leading-none tracking-[0.12em] text-primary sm:text-2xl">{title}</p>
            <p className="tabular mt-1.5 text-sm font-semibold leading-tight sm:text-base">{number}</p>
            {dateLines.map((line) => (
              <p key={line} className="tabular mt-0.5 text-xs text-base-content/60">
                {line}
              </p>
            ))}
            {badge && (
              <div className="mt-2 flex sm:justify-end">
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </div>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] leading-4 text-base-content/70">
          {company.address ? <span>{company.address}</span> : null}
          {company.phone ? <span className="tabular">Tél. : {company.phone}</span> : null}
          {company.email ? <span>{company.email}</span> : null}
          {company.taxId ? <span>NIF : {company.taxId}</span> : null}
        </div>
      </header>
      {children}
      <p className="mt-6 border-t border-base-200 pt-4 text-center text-xs text-base-content/50">
        {footer || company.footerNote || 'Merci pour votre confiance.'}
      </p>
    </div>
  );
}

/** Bloc « Client / Chantier » d'un document. */
export function PartiesBlock({
  customerName,
  customerPhone,
  rightTitle,
  rightLines,
}: {
  customerName: string;
  customerPhone: string | null;
  rightTitle: string;
  rightLines: (string | null | undefined)[];
}) {
  return (
    <div className="grid gap-4 py-5 sm:grid-cols-2">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/45">Client</p>
        <p className="mt-1 font-semibold">{customerName}</p>
        {customerPhone ? <p className="tabular text-sm text-base-content/60">{customerPhone}</p> : null}
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-base-content/45">{rightTitle}</p>
        {rightLines.filter(Boolean).map((line, index) => (
          <p key={index} className={index === 0 ? 'mt-1 font-semibold' : 'text-sm text-base-content/60'}>
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * Lignes de prestations : tableau à partir de `sm`, cartes empilées sur
 * téléphone (aucun débordement horizontal à 400 px).
 */
export function LinesBlock({ lines }: { lines: DocumentLine[] }) {
  const hasDiscount = lines.some((line) => line.discountPercent > 0);
  return (
    <div className="mb-5">
      <p className="mb-2 text-sm font-semibold">Prestations</p>
      {/* Conteneur masqué sur téléphone : la classe `table` de DaisyUI l'emporte sur `hidden` posé sur le tableau lui-même. */}
      <div className="hidden sm:block">
      <table className="table table-sm w-full">
        <thead>
          <tr className="bg-base-200">
            <th className="font-semibold">Désignation</th>
            <th className="text-right font-semibold">Quantité</th>
            <th className="text-right font-semibold">Prix unitaire</th>
            {hasDiscount && <th className="text-right font-semibold">Remise</th>}
            <th className="text-right font-semibold">Montant</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td>
                <div className="font-medium">{line.name}</div>
                {line.code ? <div className="text-xs text-base-content/50">{line.code}</div> : null}
              </td>
              <td className="text-right tabular">{formatQuantity(line.quantity, line.unit)}</td>
              <td className="text-right">
                <MoneyText value={line.unitPrice} />
              </td>
              {hasDiscount && <td className="text-right tabular">{line.discountPercent ? `${line.discountPercent.toLocaleString('fr-FR')} %` : '—'}</td>}
              <td className="text-right">
                <MoneyText value={line.amount} bold />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <ul className="space-y-2 sm:hidden">
        {lines.map((line, index) => (
          <li key={index} className="rounded-xl border border-base-200 px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 font-medium">{line.name}</span>
              <MoneyText value={line.amount} bold className="shrink-0" />
            </div>
            <p className="mt-0.5 text-xs text-base-content/60">
              {formatQuantity(line.quantity, line.unit)} × {formatCurrency(line.unitPrice)}
              {line.discountPercent ? ` − ${line.discountPercent.toLocaleString('fr-FR')} %` : ''}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TotalsBlock({ rows }: { rows: { label: string; value: ReactNode; strong?: boolean }[] }) {
  return (
    <div className="flex justify-end border-t border-base-200 pt-4">
      <div className="w-full space-y-1.5 sm:w-80">
        {rows.map((row) => (
          <div
            key={row.label}
            className={`flex items-center justify-between gap-3 ${row.strong ? 'border-t border-base-200 pt-2 text-base font-semibold' : 'text-sm'}`}
          >
            <span className={row.strong ? '' : 'text-base-content/65'}>{row.label}</span>
            <span>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Tableau des lignes pour l'export (mêmes colonnes que l'écran). */
export function exportLinesBlock(lines: DocumentLine[], currency: string): ExportBlock {
  const hasDiscount = lines.some((line) => line.discountPercent > 0);
  const money = (value: number) => formatCurrency(value, currency);
  return {
    kind: 'table',
    title: 'Prestations',
    columns: [
      { label: 'Désignation' },
      { label: 'Qté', align: 'right' },
      { label: 'Unité' },
      { label: 'Prix unit.', align: 'right' },
      ...(hasDiscount ? [{ label: 'Remise', align: 'right' as const }] : []),
      { label: 'Montant', align: 'right' },
    ],
    numeric: hasDiscount ? [1, 3, 4, 5] : [1, 3, 4],
    rows: lines.map((line) => [
      line.name,
      formatQuantity(line.quantity, ''),
      line.unit,
      money(line.unitPrice),
      ...(hasDiscount ? [line.discountPercent ? `${line.discountPercent} %` : '—'] : []),
      money(line.amount),
    ]),
  };
}

/** PDF, image et WhatsApp à partir du **même** document HTML autonome. */
export function useDocumentExports(html: string | null, fileBase: string, whatsappMessage: string, label: string) {
  const [isExporting, setIsExporting] = useState(false);
  const run = async (task: () => Promise<void>, success: string | null, failure: string) => {
    if (!html) return;
    setIsExporting(true);
    try {
      await task();
      if (success) toast.success(success);
    } catch (error: any) {
      toast.error(error?.message ?? failure, { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  };
  return {
    isExporting,
    exportPDF: () => run(() => exportDocumentAsPDF(html!, fileBase), 'PDF généré.', 'Le PDF n’a pas pu être généré.'),
    exportImage: () => run(() => exportDocumentAsImage(html!, fileBase), 'Image générée.', 'L’image n’a pas pu être générée.'),
    shareWhatsApp: () =>
      run(() => shareOnWhatsApp(html!, whatsappMessage, `${fileBase}.png`, label), null, 'Le partage WhatsApp n’a pas pu être effectué.'),
  };
}
