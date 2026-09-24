'use client';

/**
 * Document du rapport — **imprimable et exportable** (README §11, §16.1).
 *
 * Deux sorties, un seul jeu de chiffres :
 *  - `RapportExportDocument` : le document DOM capturé par
 *    `lib/export-document.ts` (`exportDocumentAsPDF`, `exportDocumentAsImage`) et par
 *    `shareOnWhatsApp()`. Il porte un `id` stable, exactement comme la facture
 *    de `/ventes/[id]` — c'est ce nœud que les exports photographient.
 *  - `buildRapportCsv()` : le **jeu de données** du rapport en CSV, avec BOM
 *    UTF-8 et séparateur `;` pour qu'Excel l'ouvre correctement en français
 *    (README §4.3 : aucune dépendance `xlsx`).
 *
 * Le document est en noir sur blanc, quelle que soit la couleur choisie dans
 * les paramètres : une capture d'écran doit rester lisible et imprimable.
 */

import type { ReactNode } from 'react';
import { formatCurrency, formatNumber, formatPercent, formatQuantity } from '@/lib/format';
import { formatDateLong, formatDateShort } from '@/lib/date-format';
import type { RapportData } from '@/lib/rapports-types';
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';

/** Identifiant DOM du document exporté (unique dans la page). */
export const RAPPORT_DOCUMENT_ID = 'rapport-document';

export type RapportExportCompany = {
  companyName: string;
  companyBranch: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyTaxId: string;
  companyLogo: string;
  currency: string;
};

/* ------------------------------------------------------------------ *
 * Document imprimable
 * ------------------------------------------------------------------ */

function DocumentSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="border-b border-black/15 pb-1 text-[12px] font-bold uppercase tracking-wide">
        {title}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function DocumentTable({
  head,
  rows,
  emptyLabel,
}: {
  head: string[];
  rows: ReactNode[][];
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <p className="text-[11px] italic text-black/50">{emptyLabel}</p>;
  }

  return (
    <table className="w-full border-collapse text-[11px]">
      <thead>
        <tr className="bg-black/5">
          {head.map((cell, index) => (
            <th
              key={cell}
              className={`border-b border-black/15 px-2 py-1 font-semibold ${
                index === 0 ? 'text-left' : 'text-right'
              }`}
            >
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="border-b border-black/10">
            {row.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                className={`px-2 py-1 tabular ${cellIndex === 0 ? 'text-left' : 'text-right'}`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RapportExportDocument({
  id = RAPPORT_DOCUMENT_ID,
  report,
  company,
  width = '48rem',
  className = '',
}: {
  id?: string;
  report: RapportData;
  company: RapportExportCompany;
  width?: string;
  className?: string;
}) {
  const currency = company.currency || 'GNF';
  const money = (value: number) => formatCurrency(value, currency);

  const comparison = report.comparison;

  return (
    <article
      id={id}
      style={{ width }}
      className={`mx-auto max-w-full rounded-2xl border border-base-200 bg-white p-4 text-[13px] text-black shadow-sm sm:p-6 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none ${className}`.trim()}
    >
      {/* ── En-tête ─────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-primary/70 pb-4">
        <div className="flex min-w-0 items-start gap-3">
          {/* Logo téléversé dans les paramètres ; à défaut, le logo livré avec
              l'application (le client en a fourni un, un rapport sans logo
              serait un recul). */}
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
              <p className="text-xs text-black/70">{company.companyBranch}</p>
            ) : null}
            <div className="mt-1 space-y-0.5 text-[11px] leading-4 text-black/70">
              {company.companyAddress ? <p>{company.companyAddress}</p> : null}
              <p>
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
            Rapport d&apos;activité
          </p>
          <p className="text-lg font-bold leading-tight sm:text-xl">{report.period.label}</p>
          <p className="mt-1 text-xs text-black/70">
            Du {formatDateLong(report.period.from)}
          </p>
          <p className="text-xs text-black/70">Au {formatDateLong(report.period.to)}</p>
          <p className="mt-1 text-[11px] text-black/50">
            Comparé au {formatDateShort(report.previousPeriod.from)} →{' '}
            {formatDateShort(report.previousPeriod.to)}
          </p>
        </div>
      </header>

      {/* ── Résumé décisionnel ──────────────────────────────────────────── */}
      {report.decisionSummary.length > 0 && (
        <section className="mt-4 rounded-xl border border-primary/30 bg-primary/5 px-3 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-primary">À retenir</p>
          <ul className="mt-1.5 space-y-1 text-[12px] leading-5">
            {report.decisionSummary.map((sentence, index) => (
              <li key={index}>• {sentence}</li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Synthèse et comparaison ─────────────────────────────────────── */}
      <DocumentSection title="Synthèse">
        <DocumentTable
          head={['Indicateur', 'Période', 'Précédente', 'Variation']}
          emptyLabel="Aucune donnée."
          rows={[
            [
              "Chiffre d'affaires (TTC)",
              money(comparison.revenue.current),
              money(comparison.revenue.previous),
              comparison.revenue.deltaPercent === null
                ? '—'
                : formatPercent(comparison.revenue.deltaPercent),
            ],
            [
              'Marge brute',
              money(comparison.margin.current),
              money(comparison.margin.previous),
              comparison.margin.deltaPercent === null
                ? '—'
                : formatPercent(comparison.margin.deltaPercent),
            ],
            [
              'Nombre de ventes',
              formatNumber(comparison.salesCount.current),
              formatNumber(comparison.salesCount.previous),
              comparison.salesCount.deltaPercent === null
                ? '—'
                : formatPercent(comparison.salesCount.deltaPercent),
            ],
            [
              "Chiffre d'affaires HT",
              money(report.summary.revenueHt),
              '—',
              '—',
            ],
            ['Panier moyen', money(report.summary.averageBasket), '—', '—'],
            ['Encaissé', money(report.summary.collected), '—', '—'],
            ['Reste à encaisser (période)', money(report.summary.outstanding), '—', '—'],
            ['Dépenses', money(report.summary.expenses), '—', '—'],
            ['Bénéfice net', money(report.summary.netProfit), '—', '—'],
            ['Solde de caisse', money(report.summary.cash.balance), '—', '—'],
          ]}
        />
      </DocumentSection>

      {/* ── Produits vendus et marges ───────────────────────────────────── */}
      <DocumentSection title="Produits vendus">
        <DocumentTable
          head={['Produit', 'Quantité', "Chiffre d'affaires", 'Part']}
          emptyLabel="Aucun produit vendu sur la période."
          rows={report.soldByProduct
            .slice(0, 15)
            .map((row) => [
              row.productName,
              formatQuantity(row.quantity, row.unit),
              money(row.revenue),
              formatPercent(row.sharePercent),
            ])}
        />
      </DocumentSection>

      <DocumentSection title="Marges par produit">
        <DocumentTable
          head={['Produit', 'Chiffre d’affaires', 'Coût', 'Marge', 'Taux']}
          emptyLabel="Aucune marge calculable sur la période."
          rows={report.productMargins
            .slice(0, 15)
            .map((row) => [
              row.productName,
              money(row.revenue),
              money(row.cost),
              money(row.margin),
              formatPercent(row.marginPercent),
            ])}
        />
      </DocumentSection>

      {/* ── Clients ─────────────────────────────────────────────────────── */}
      <DocumentSection title="Meilleurs clients">
        <DocumentTable
          head={['Client', 'Ventes', "Chiffre d'affaires", 'Encaissé', 'Reste dû']}
          emptyLabel="Aucun client facturé sur la période."
          rows={report.topCustomers.map((row) => [
            row.customerName,
            formatNumber(row.salesCount),
            money(row.revenue),
            money(row.collected),
            money(row.outstanding),
          ])}
        />
      </DocumentSection>

      <DocumentSection title="Créances clients">
        <DocumentTable
          head={['Client', 'Factures', 'Solde dû', 'Échéance']}
          emptyLabel="Aucune créance client."
          rows={report.receivables.items.map((row) => [
            row.customerName,
            formatNumber(row.invoiceCount),
            money(row.balance),
            row.oldestDueDate ? formatDateShort(row.oldestDueDate) : 'Sans échéance',
          ])}
        />
      </DocumentSection>

      <DocumentSection title="Dettes fournisseurs">
        <DocumentTable
          head={['Fournisseur', 'Achats', 'Solde dû', 'Échéance']}
          emptyLabel="Aucune dette fournisseur."
          rows={report.payables.items.map((row) => [
            row.supplierName,
            formatNumber(row.invoiceCount),
            money(row.balance),
            row.oldestDueDate ? formatDateShort(row.oldestDueDate) : 'Sans échéance',
          ])}
        />
      </DocumentSection>

      {/* ── Stock ───────────────────────────────────────────────────────── */}
      <DocumentSection title="Stock — ruptures et alertes">
        <DocumentTable
          head={['Produit', 'Stock', 'Seuil', "Valeur d'achat", 'État']}
          emptyLabel="Aucune alerte de stock."
          rows={[
            ...report.stockInsights.outOfStock.map((row) => [
              row.name,
              formatQuantity(row.stock, row.unit),
              formatQuantity(row.stockMin, row.unit),
              money(row.stockValue),
              'Rupture',
            ]),
            ...report.stockInsights.alerts.map((row) => [
              row.name,
              formatQuantity(row.stock, row.unit),
              formatQuantity(row.stockMin, row.unit),
              money(row.stockValue),
              'Seuil atteint',
            ]),
          ]}
        />
        <p className="mt-2 text-[11px] text-black/70">
          Valeur du stock : {money(report.stockInsights.purchaseValue)} au prix d&apos;achat,{' '}
          {money(report.stockInsights.saleValue)} au prix de vente — marge potentielle{' '}
          {money(report.stockInsights.potentialMargin)}.
        </p>
      </DocumentSection>

      {/* ── Dépenses ────────────────────────────────────────────────────── */}
      <DocumentSection title="Dépenses par catégorie">
        <DocumentTable
          head={['Catégorie', 'Écritures', 'Montant']}
          emptyLabel="Aucune dépense sur la période."
          rows={report.expenses.byCategory.map((row) => [
            row.category,
            formatNumber(row.count),
            money(row.total),
          ])}
        />
      </DocumentSection>

      {/* ── Résultat ────────────────────────────────────────────────────── */}
      <DocumentSection title="Résultat de la période">
        <DocumentTable
          head={['Poste', 'Montant']}
          emptyLabel="Aucune donnée."
          rows={[
            ['Chiffre d’affaires des lignes de vente', money(report.netProfit.revenue)],
            ['Coût des marchandises vendues', money(report.netProfit.cogs)],
            ['Bénéfice brut', money(report.netProfit.grossProfit)],
            ['Dépenses de fonctionnement', money(report.netProfit.expenses)],
            ['Main-d’œuvre chantiers et fabrications', money(report.netProfit.laborCost)],
            ['Bénéfice net', money(report.netProfit.netProfit)],
          ]}
        />
        <p className="mt-2 text-[11px] text-black/70">
          Taux de marge brute : {formatPercent(report.netProfit.grossMarginPercent)}.
        </p>
      </DocumentSection>

      <footer className="mt-6 border-t border-black/15 pt-3 text-[10px] text-black/60">
        <p>
          Rapport généré le {formatDateLong(new Date())} — montants en {currency}. Tous les
          totaux sont calculés à la lecture depuis les factures, paiements et dépenses : aucun
          n&apos;est stocké.
        </p>
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * Export CSV (README §4.3, §16.1)
 * ------------------------------------------------------------------ */

/** Un champ CSV : guillemets doublés, délimiteur protégé. */
function csvField(value: string): string {
  const text = String(value ?? '');
  if (/[";\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Nombre pour Excel français : ni séparateur de milliers, ni espace
 * insécable (qui transformerait la cellule en texte), et la virgule décimale.
 */
function csvNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 1000) / 1000).replace('.', ',');
}

/**
 * Jeu de données complet du rapport affiché, en CSV.
 * BOM UTF-8 + séparateur `;` : Excel ouvre le fichier correctement en français.
 */
export function buildRapportCsv(report: RapportData, company: RapportExportCompany): string {
  const lines: string[] = [];
  const row = (...cells: (string | number)[]) => {
    lines.push(cells.map((cell) => csvField(typeof cell === 'number' ? csvNumber(cell) : cell)).join(';'));
  };

  row('Rapport', company.companyName);
  row('Filiale', company.companyBranch);
  row('Période', report.period.label);
  row('Du', report.period.from);
  row('Au', report.period.to);
  row('Période précédente — du', report.previousPeriod.from);
  row('Période précédente — au', report.previousPeriod.to);
  row('Devise', company.currency);
  lines.push('');

  row('SYNTHÈSE');
  row('Indicateur', 'Période', 'Période précédente', 'Variation %');
  row("Chiffre d'affaires TTC", report.comparison.revenue.current, report.comparison.revenue.previous, report.comparison.revenue.deltaPercent ?? '');
  row('Marge brute', report.comparison.margin.current, report.comparison.margin.previous, report.comparison.margin.deltaPercent ?? '');
  row('Nombre de ventes', report.comparison.salesCount.current, report.comparison.salesCount.previous, report.comparison.salesCount.deltaPercent ?? '');
  row("Chiffre d'affaires HT", report.summary.revenueHt);
  row('Panier moyen', report.summary.averageBasket);
  row('Encaissé', report.summary.collected);
  row('Reste à encaisser (période)', report.summary.outstanding);
  row('Dépenses', report.summary.expenses);
  row('Bénéfice net', report.summary.netProfit);
  row('Solde de caisse', report.summary.cash.balance);
  lines.push('');

  row('RÉSUMÉ DÉCISIONNEL');
  report.decisionSummary.forEach((sentence) => row(sentence));
  lines.push('');

  row('PRODUITS VENDUS');
  row('Produit', 'Code', 'Quantité', 'Unité', "Chiffre d'affaires", 'Part %');
  report.soldByProduct.forEach((item) =>
    row(item.productName, item.productCode, item.quantity, item.unit, item.revenue, item.sharePercent),
  );
  lines.push('');

  row('MARGES PAR PRODUIT');
  row('Produit', 'Quantité', "Chiffre d'affaires", "Coût d'achat", 'Marge', 'Taux %', 'Marge unitaire');
  report.productMargins.forEach((item) =>
    row(item.productName, item.quantity, item.revenue, item.cost, item.margin, item.marginPercent, item.unitMargin),
  );
  lines.push('');

  row('MEILLEURS CLIENTS');
  row('Client', 'Ventes', "Chiffre d'affaires", 'Encaissé', 'Reste dû');
  report.topCustomers.forEach((item) =>
    row(item.customerName, item.salesCount, item.revenue, item.collected, item.outstanding),
  );
  lines.push('');

  row('CRÉANCES CLIENTS');
  row('Client', 'Téléphone', 'Factures', 'Solde dû', 'Échéance la plus ancienne', 'En retard');
  report.receivables.items.forEach((item) =>
    row(
      item.customerName,
      item.phone ?? '',
      item.invoiceCount,
      item.balance,
      item.oldestDueDate ?? '',
      item.overdue ? 'Oui' : 'Non',
    ),
  );
  row('Total créances', report.receivables.total);
  row('Nombre de débiteurs', report.receivables.debtorsCount);
  lines.push('');

  row('DETTES FOURNISSEURS');
  row('Fournisseur', 'Téléphone', 'Achats', 'Solde dû', 'Échéance la plus ancienne', 'En retard');
  report.payables.items.forEach((item) =>
    row(
      item.supplierName,
      item.phone ?? '',
      item.invoiceCount,
      item.balance,
      item.oldestDueDate ?? '',
      item.overdue ? 'Oui' : 'Non',
    ),
  );
  row('Total dettes', report.payables.total);
  row('Nombre de fournisseurs', report.payables.creditorsCount);
  lines.push('');

  row('STOCK');
  row('Produit', 'Code', 'Stock', 'Unité', 'Seuil', "Valeur d'achat", 'État');
  report.stockInsights.outOfStock.forEach((item) =>
    row(item.name, item.code, item.stock, item.unit, item.stockMin, item.stockValue, 'Rupture'),
  );
  report.stockInsights.alerts.forEach((item) =>
    row(item.name, item.code, item.stock, item.unit, item.stockMin, item.stockValue, 'Seuil atteint'),
  );
  row("Valeur d'achat du stock", report.stockInsights.purchaseValue);
  row('Valeur de vente du stock', report.stockInsights.saleValue);
  row('Marge potentielle', report.stockInsights.potentialMargin);
  lines.push('');

  row('DÉPENSES');
  row('Catégorie', 'Écritures', 'Montant');
  report.expenses.byCategory.forEach((item) => row(item.category, item.count, item.total));
  row('Total dépenses', report.expenses.total);
  lines.push('');

  row('MAIN-D’ŒUVRE ET MATIÈRES');
  row('Poste', 'Nombre', 'Matières', "Main-d'œuvre");
  row('Chantiers', report.jobCosts.serviceJobs.count, report.jobCosts.serviceJobs.materialCost, report.jobCosts.serviceJobs.laborCost);
  row('Briqueterie', report.jobCosts.brickProductions.count, report.jobCosts.brickProductions.materialCost, report.jobCosts.brickProductions.laborCost);
  row('Atelier', report.jobCosts.furnitureOrders.count, report.jobCosts.furnitureOrders.materialCost, report.jobCosts.furnitureOrders.laborCost);
  row('Total', '', report.jobCosts.totalMaterialCost, report.jobCosts.totalLaborCost);
  lines.push('');

  row('RÉSULTAT');
  row('Chiffre d’affaires des lignes de vente', report.netProfit.revenue);
  row('Coût des marchandises vendues', report.netProfit.cogs);
  row('Bénéfice brut', report.netProfit.grossProfit);
  row('Taux de marge brute %', report.netProfit.grossMarginPercent);
  row('Dépenses de fonctionnement', report.netProfit.expenses);
  row('Main-d’œuvre', report.netProfit.laborCost);
  row('Bénéfice net', report.netProfit.netProfit);

  // BOM UTF-8 : sans lui, Excel affiche « Ã© » à la place de « é ».
  return `\uFEFF${lines.join('\r\n')}`;
}

/** Déclenche le téléchargement du CSV (aucune dépendance externe). */
export function downloadRapportCsv(
  report: RapportData,
  company: RapportExportCompany,
  fileName = 'rapport',
): void {
  const csv = buildRapportCsv(report, company);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileName}.csv`;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
