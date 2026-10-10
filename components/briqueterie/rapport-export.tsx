'use client';

/**
 * Document du rapport de la **briqueterie** — imprimable et exportable
 * (README §11.1, §20).
 *
 * Deux sorties, un seul jeu de chiffres :
 *  - `BrickRapportExportDocument` : le document affiché dans la page, avec un
 *    `id` DOM stable (`BRICK_RAPPORT_DOCUMENT_ID`). C'est la reprise exacte du
 *    mécanisme de `components/rapports/rapport-export.tsx`.
 *  - `buildBrickRapportExportHtml()` : le **document HTML autonome** écrit dans
 *    l'iframe invisible par `lib/export-document.ts`, puis capturé en PDF, en
 *    image ou partagé sur WhatsApp — les trois exports partagent donc le même
 *    document.
 *
 * ## Pourquoi des couleurs hexadécimales, et pas les jetons du thème
 *
 * `html2canvas` ne sait analyser que `rgb()`, `rgba()`, `hsl()`, `hsla()` et les
 * couleurs nommées : Tailwind 4 et DaisyUI 5 n'émettent que des `oklch()`, et une
 * simple opacité comme `border-primary/70` produit un `color-mix()`. Capturer un
 * nœud stylé par le thème échoue donc (README §11.1, cause du défaut constaté en
 * recette). Le document exporté est un document **hors application** : il porte
 * ses propres couleurs hexadécimales. C'est la seule exception admise à la règle
 * « aucune couleur en dur » (§5.3), et elle vaut aussi pour l'aperçu ci-dessous,
 * qui doit rester rigoureusement identique au PDF.
 *
 * ## Pourquoi `BrickReports` est redéclaré ici
 *
 * Le front ne parle qu'à l'API (invariant 6) : importer une **valeur** depuis
 * `@/lib/brick-analytics` ferait entrer Drizzle, `@libsql/client` et `fs` dans le
 * bundle navigateur. Le type est donc recopié à l'identique du contrat de
 * `GET /api/briqueterie/rapports?...`.
 */

import type { CSSProperties, ReactNode } from 'react';
import { formatCurrency, formatNumber, formatPercent, formatQuantity } from '@/lib/format';
import { formatDateLong, formatDateShort } from '@/lib/date-format';
import {
  renderExportDocument,
  type ExportBlock,
  type ExportCompany,
} from '@/lib/export-document';
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';

/* ------------------------------------------------------------------ *
 * Contrat de l'API — GET /api/briqueterie/rapports
 * ------------------------------------------------------------------ */

export type BrickReports = {
  from: string;
  to: string;
  productionByDay: { date: string; lots: number; produced: number; broken: number; cost: number }[];
  productionByType: {
    brickTypeId: number;
    brickTypeName: string;
    lots: number;
    produced: number;
    broken: number;
    cost: number;
    unitCost: number;
  }[];
  expensesByProduction: {
    batchNumber: string;
    date: string;
    brickTypeName: string;
    category: string;
    amount: number;
    count: number;
  }[];
  generalExpensesByCategory: { category: string; total: number; count: number }[];
  salesByPeriod: {
    date: string;
    count: number;
    revenue: number;
    collected: number;
    outstanding: number;
  }[];
  salesByProduct: { productName: string; quantity: number; revenue: number }[];
  salesByCustomer: {
    customerName: string;
    count: number;
    revenue: number;
    outstanding: number;
  }[];
  receivables: {
    customerName: string;
    phone: string | null;
    invoiceCount: number;
    balance: number;
    oldestDueDate: string | null;
  }[];
  paymentsByMethod: { paymentMethod: string; total: number; count: number }[];
  stock: {
    brickTypeId: number;
    brickTypeName: string;
    shape: string;
    dimensions: string | null;
    productId: number;
    productName: string;
    unit: string;
    salePrice: number;
    purchasePrice: number;
    stock: number;
    stockMin: number;
    averageUnitCost: number;
    isLow: boolean;
    isOut: boolean;
    stockValue: number;
    saleValue: number;
    potentialMargin: number;
  }[];
  losses: {
    batchNumber: string;
    date: string;
    brickTypeName: string;
    brokenQuantity: number;
    reason: string | null;
  }[];
  profitabilityByProduct: {
    brickTypeId: number;
    brickTypeName: string;
    quantitySold: number;
    revenue: number;
    productionCost: number;
    margin: number;
    marginRate: number;
  }[];
  profitability: {
    revenue: number;
    productionCost: number;
    grossMargin: number;
    generalExpenses: number;
    estimatedResult: number;
    marginRate: number;
    producedQuantity: number;
    unitCost: number;
  };
};

/**
 * Identité d'entreprise du document. C'est **exactement** le type attendu par
 * `exportCompanyFromSettings()` (`lib/export-document.ts`) : la page peut donc lui
 * passer directement le résultat de cette fonction.
 */
export type BrickRapportExportCompany = ExportCompany;

/** Identifiant DOM du document exporté (unique dans la page). */
export const BRICK_RAPPORT_DOCUMENT_ID = 'briqueterie-rapport-document';

/** Accès fonctionnel au même identifiant, comme `RAPPORT_DOCUMENT_ID` sur /rapports. */
export function brickRapportDocumentId(): string {
  return BRICK_RAPPORT_DOCUMENT_ID;
}

/* ------------------------------------------------------------------ *
 * Palette du document — hexadécimal uniquement (voir l'en-tête du fichier)
 * ------------------------------------------------------------------ */

const HEX = {
  ink: '#0f172a',
  inkSoft: '#334155',
  muted: '#64748b',
  line: '#e2e8f0',
  lineStrong: '#cbd5e1',
  surface: '#ffffff',
  surfaceAlt: '#f8fafc',
  primary: '#1e40af',
} as const;

/* ------------------------------------------------------------------ *
 * Les 5 indicateurs de rentabilité du cahier des charges
 * ------------------------------------------------------------------ */

export type BrickProfitabilityIndicator = {
  key: string;
  label: string;
  /** Formule affichée à côté de la valeur : le chiffre doit être vérifiable. */
  formula: string;
  amount: number;
};

/**
 * Source unique des 5 indicateurs — la page les affiche en `MoneyText` (jetons du
 * thème) et le document exporté en hexadécimal, mais les **libellés, formules et
 * montants** ne sont écrits qu'ici : deux listes divergentes donneraient deux
 * vérités.
 */
export function brickProfitabilityIndicators(
  report: BrickReports,
): BrickProfitabilityIndicator[] {
  const p = report.profitability;

  return [
    {
      key: 'productionCost',
      label: 'Coût total de la production',
      formula: 'Dépenses rattachées aux lots + main-d’œuvre des affectations',
      amount: p.productionCost,
    },
    {
      key: 'unitCost',
      label: 'Coût unitaire de production',
      formula: 'Coût total ÷ pièces produites nettes (produites − cassées)',
      amount: p.unitCost,
    },
    {
      key: 'revenue',
      label: 'Chiffre d’affaires de la filiale',
      formula: 'Ventes du canal pièce (encaissé + reste à encaisser)',
      amount: p.revenue,
    },
    {
      key: 'grossMargin',
      label: 'Marge brute estimée',
      formula: 'Chiffre d’affaires − coût total de la production',
      amount: p.grossMargin,
    },
    {
      key: 'estimatedResult',
      label: 'Résultat estimé',
      formula: 'Marge brute − dépenses générales',
      amount: p.estimatedResult,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Sections du document — une seule liste de lignes pour l'écran, le PDF et le CSV
 * ------------------------------------------------------------------ */

type BrickCell = {
  /** Ce qui est affiché (document, écran). */
  text: string;
  /** Valeur brute, écrite telle quelle dans le CSV pour qu'Excel calcule. */
  value?: number;
};

type BrickDocumentSection = {
  title: string;
  head: string[];
  rows: BrickCell[][];
  /** Index des colonnes numériques : alignées à droite, en chiffres tabulaires. */
  numeric: number[];
  note?: string;
};

function labelCell(text: string): BrickCell {
  return { text };
}

function moneyCell(value: number, currency: string): BrickCell {
  return { text: formatCurrency(value, currency), value };
}

function quantityCell(value: number, unit?: string | null): BrickCell {
  return { text: formatQuantity(value, unit), value };
}

function percentCell(value: number): BrickCell {
  return { text: formatPercent(value), value };
}

function dateCell(date: string): BrickCell {
  return { text: formatDateShort(date) };
}

/** Nombre de lignes d'une section — utilisé par les notes de synthèse. */
function countRows(rows: { count?: number }[]): number {
  return rows.reduce((total, row) => total + Number(row.count ?? 0), 0);
}

/**
 * Toutes les sections du rapport, dans l'ordre de lecture : rentabilité d'abord
 * (c'est la question posée), puis production, dépenses, ventes, encaissements,
 * stock, pertes.
 *
 * Aucune ligne n'est tronquée : un rapport comptable amputé silencieusement est
 * pire qu'un PDF long — `exportDocumentAsPDF` répartit le document sur plusieurs
 * pages, c'est précisément ce pour quoi il a été écrit.
 */
export function buildBrickSections(
  report: BrickReports,
  company: BrickRapportExportCompany,
): BrickDocumentSection[] {
  const currency = company.currencySymbol?.trim() || 'GNF';
  const p = report.profitability;

  const producedTotal = report.productionByDay.reduce((sum, row) => sum + row.produced, 0);
  const brokenTotal = report.productionByDay.reduce((sum, row) => sum + row.broken, 0);
  const lotsTotal = report.productionByDay.reduce((sum, row) => sum + row.lots, 0);
  const goodTotal = Math.max(0, producedTotal - brokenTotal);
  const brickUnit = goodTotal === 1 ? 'pièce' : 'pièces';

  return [
    {
      title: 'Rentabilité de la période',
      head: ['Indicateur', 'Montant', 'Formule'],
      numeric: [1],
      rows: brickProfitabilityIndicators(report).map((indicator) => [
        labelCell(indicator.label),
        moneyCell(indicator.amount, currency),
        labelCell(indicator.formula),
      ]),
      note:
        `Taux de marge brute : ${formatPercent(p.marginRate)} — ${formatQuantity(goodTotal, brickUnit)} ` +
        `nettes (${formatQuantity(producedTotal, brickUnit)} produites, ${formatQuantity(brokenTotal, brickUnit)} cassées) ` +
        `sur ${formatNumber(lotsTotal)} lot(s).`,
    },
    {
      title: 'Rentabilité par modèle',
      head: ['Modèle', 'Quantité vendue', 'Chiffre d’affaires', 'Coût des pièces vendues', 'Marge', 'Taux (%)'],
      numeric: [1, 2, 3, 4, 5],
      rows: report.profitabilityByProduct.map((row) => [
        labelCell(row.brickTypeName),
        quantityCell(row.quantitySold, brickUnit),
        moneyCell(row.revenue, currency),
        moneyCell(row.productionCost, currency),
        moneyCell(row.margin, currency),
        percentCell(row.marginRate),
      ]),
      note:
        'Coût des pièces vendues = coût unitaire du type × quantité vendue ; le coût total de fabrication, ' +
        'lui, figure dans la section « Production par type ».',
    },
    {
      title: 'Production par jour',
      head: ['Date', 'Lots', 'Produites', 'Cassées', 'Coût'],
      numeric: [1, 2, 3, 4],
      rows: report.productionByDay.map((row) => [
        dateCell(row.date),
        quantityCell(row.lots, row.lots === 1 ? 'lot' : 'lots'),
        quantityCell(row.produced, brickUnit),
        quantityCell(row.broken, brickUnit),
        moneyCell(row.cost, currency),
      ]),
    },
    {
      title: 'Production par modèle',
      head: ['Modèle', 'Lots', 'Produites', 'Cassées', 'Coût', 'Coût unitaire'],
      numeric: [1, 2, 3, 4, 5],
      rows: report.productionByType.map((row) => [
        labelCell(row.brickTypeName),
        quantityCell(row.lots, row.lots === 1 ? 'lot' : 'lots'),
        quantityCell(row.produced, brickUnit),
        quantityCell(row.broken, brickUnit),
        moneyCell(row.cost, currency),
        moneyCell(row.unitCost, currency),
      ]),
    },
    {
      title: 'Dépenses rattachées aux productions',
      head: ['Date', 'Lot', 'Modèle', 'Catégorie', 'Écritures', 'Montant'],
      numeric: [4, 5],
      rows: report.expensesByProduction.map((row) => [
        dateCell(row.date),
        labelCell(row.batchNumber),
        labelCell(row.brickTypeName),
        labelCell(row.category),
        quantityCell(row.count, row.count === 1 ? 'écriture' : 'écritures'),
        moneyCell(row.amount, currency),
      ]),
    },
    {
      title: 'Dépenses générales par catégorie',
      head: ['Catégorie', 'Écritures', 'Montant'],
      numeric: [1, 2],
      rows: report.generalExpensesByCategory.map((row) => [
        labelCell(row.category),
        quantityCell(row.count, row.count === 1 ? 'écriture' : 'écritures'),
        moneyCell(row.total, currency),
      ]),
      note: `Total des dépenses générales : ${formatCurrency(p.generalExpenses, currency)} sur ${formatNumber(
        countRows(report.generalExpensesByCategory),
      )} écriture(s).`,
    },
    {
      title: 'Ventes par période',
      head: ['Date', 'Ventes', 'Chiffre d’affaires', 'Encaissé', 'Reste à encaisser'],
      numeric: [1, 2, 3, 4],
      rows: report.salesByPeriod.map((row) => [
        dateCell(row.date),
        quantityCell(row.count, row.count === 1 ? 'vente' : 'ventes'),
        moneyCell(row.revenue, currency),
        moneyCell(row.collected, currency),
        moneyCell(row.outstanding, currency),
      ]),
    },
    {
      title: 'Ventes par produit',
      head: ['Produit vendu', 'Quantité', 'Chiffre d’affaires'],
      numeric: [1, 2],
      rows: report.salesByProduct.map((row) => [
        labelCell(row.productName),
        quantityCell(row.quantity),
        moneyCell(row.revenue, currency),
      ]),
    },
    {
      title: 'Ventes par client',
      head: ['Client', 'Ventes', 'Chiffre d’affaires', 'Reste dû'],
      numeric: [1, 2, 3],
      rows: report.salesByCustomer.map((row) => [
        labelCell(row.customerName),
        quantityCell(row.count, row.count === 1 ? 'vente' : 'ventes'),
        moneyCell(row.revenue, currency),
        moneyCell(row.outstanding, currency),
      ]),
    },
    {
      title: `Créances clients (${formatNumber(report.receivables.length)})`,
      head: ['Client', 'Téléphone', 'Factures', 'Solde dû', 'Échéance la plus ancienne'],
      numeric: [2, 3],
      rows: report.receivables.map((row) => [
        labelCell(row.customerName),
        labelCell(row.phone ?? '—'),
        quantityCell(row.invoiceCount, row.invoiceCount === 1 ? 'facture' : 'factures'),
        moneyCell(row.balance, currency),
        labelCell(row.oldestDueDate ? formatDateShort(row.oldestDueDate) : 'Sans échéance'),
      ]),
      note: `Total des créances de la filiale : ${formatCurrency(
        report.receivables.reduce((sum, row) => sum + row.balance, 0),
        currency,
      )}.`,
    },
    {
      title: 'Paiements encaissés par moyen',
      head: ['Moyen de paiement', 'Nombre', 'Total'],
      numeric: [1, 2],
      rows: report.paymentsByMethod.map((row) => [
        labelCell(row.paymentMethod || '—'),
        quantityCell(row.count),
        moneyCell(row.total, currency),
      ]),
    },
    {
      title: 'État des stocks',
      head: [
        'Modèle',
        'Forme',
        'Dimensions',
        'Produit',
        'Stock',
        'Seuil',
        'Coût unitaire moyen',
        'Valeur du stock',
        'Valeur au prix de vente',
        'Marge potentielle',
        'État',
      ],
      numeric: [4, 5, 6, 7, 8, 9],
      rows: report.stock.map((row) => [
        labelCell(row.brickTypeName),
        labelCell(row.shape || '—'),
        labelCell(row.dimensions ?? '—'),
        labelCell(row.productName),
        quantityCell(row.stock, row.unit),
        quantityCell(row.stockMin, row.unit),
        moneyCell(row.averageUnitCost, currency),
        moneyCell(row.stockValue, currency),
        moneyCell(row.saleValue, currency),
        moneyCell(row.potentialMargin, currency),
        labelCell(row.isOut ? 'Rupture' : row.isLow ? 'Sous le seuil' : 'Disponible'),
      ]),
      note:
        `Valeur du stock : ${formatCurrency(
          report.stock.reduce((sum, row) => sum + row.stockValue, 0),
          currency,
        )} au coût de revient, ${formatCurrency(
          report.stock.reduce((sum, row) => sum + row.saleValue, 0),
          currency,
        )} au prix de vente.`,
    },
    {
      title: 'Pertes et casses',
      head: ['Date', 'Lot', 'Modèle', 'Quantité cassée', 'Motif'],
      numeric: [3],
      rows: report.losses.map((row) => [
        dateCell(row.date),
        labelCell(row.batchNumber),
        labelCell(row.brickTypeName),
        quantityCell(row.brokenQuantity, brickUnit),
        labelCell(row.reason ?? 'Motif non renseigné'),
      ]),
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Résumé décisionnel — généré à partir des chiffres, jamais figé
 * ------------------------------------------------------------------ */

/**
 * Trois à quatre phrases construites sur les chiffres de la période : production
 * et coût unitaire, chiffre d'affaires et marge, résultat estimé, puis alertes de
 * stock et créances. Aucune phrase n'est écrite en dur : un rapport dont le
 * commentaire ne suit pas les chiffres est un rapport qu'on cesse de lire.
 */
export function buildBrickDecisionSummary(report: BrickReports, currency = 'GNF'): string[] {
  const p = report.profitability;
  const money = (value: number) => formatCurrency(value, currency);

  const producedTotal = report.productionByDay.reduce((sum, row) => sum + row.produced, 0);
  const brokenTotal = report.productionByDay.reduce((sum, row) => sum + row.broken, 0);
  const lotsTotal = report.productionByDay.reduce((sum, row) => sum + row.lots, 0);
  const goodTotal = Math.max(0, producedTotal - brokenTotal);

  const salesCount = report.salesByPeriod.reduce((sum, row) => sum + row.count, 0);
  const receivablesTotal = report.receivables.reduce((sum, row) => sum + row.balance, 0);
  const outOfStock = report.stock.filter((row) => row.isOut).length;
  const lowStock = report.stock.filter((row) => row.isLow && !row.isOut).length;

  const sentences: string[] = [];

  sentences.push(
    producedTotal > 0
      ? `La période a produit ${formatQuantity(goodTotal, 'pièces')} nettes en ${formatNumber(lotsTotal)} lot(s), ` +
          `pour un coût de production de ${money(p.productionCost)}, soit ${money(p.unitCost)} la pièce` +
          (brokenTotal > 0 ? ` (${formatQuantity(brokenTotal, 'pièces')} cassées).` : '.')
      : `Aucune production n'a été enregistrée sur la période : le coût de production et le coût unitaire sont donc nuls.`,
  );

  sentences.push(
    salesCount > 0
      ? `Les ${formatNumber(salesCount)} vente(s) du canal des filiales ont dégagé ${money(p.revenue)} de chiffre d'affaires, ` +
          `pour une marge brute estimée de ${money(p.grossMargin)} (${formatPercent(p.marginRate)} du chiffre d'affaires).`
      : `Aucune vente de la filiale n'a été facturée sur la période : le chiffre d'affaires est nul et la marge brute ressort à ${money(
          p.grossMargin,
        )}.`,
  );

  sentences.push(
    `Après ${money(p.generalExpenses)} de dépenses générales, le résultat estimé de la période est ` +
      `${p.estimatedResult >= 0 ? 'bénéficiaire' : 'déficitaire'} de ${money(Math.abs(p.estimatedResult))}.`,
  );

  const alerts: string[] = [];
  if (outOfStock > 0 || lowStock > 0) {
    alerts.push(
      `stock : ${formatNumber(outOfStock)} type(s) en rupture et ${formatNumber(lowStock)} sous le seuil d'alerte`,
    );
  }
  if (receivablesTotal > 0) {
    alerts.push(`créances clients en cours : ${money(receivablesTotal)}`);
  }
  if (alerts.length > 0) {
    sentences.push(`Points de vigilance — ${alerts.join(' ; ')}.`);
  }

  return sentences;
}

/* ------------------------------------------------------------------ *
 * Document affiché dans la page (et imprimable)
 * ------------------------------------------------------------------ */

const DOCUMENT_STYLE: CSSProperties = {
  width: '48rem',
  maxWidth: '100%',
  margin: '0 auto',
  padding: 24,
  backgroundColor: HEX.surface,
  color: HEX.ink,
  border: `1px solid ${HEX.line}`,
  borderRadius: 16,
  boxShadow: `0 1px 2px 0 ${HEX.line}`,
  fontSize: 13,
  lineHeight: 1.45,
};

function DocumentTable({ section }: { section: BrickDocumentSection }) {
  if (section.rows.length === 0) {
    return (
      <p style={{ fontStyle: 'italic', color: HEX.muted, fontSize: 11 }}>
        Aucune donnée sur la période.
      </p>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
      <thead>
        <tr style={{ backgroundColor: HEX.surfaceAlt }}>
          {section.head.map((label, index) => (
            <th
              key={label}
              style={{
                borderBottom: `1px solid ${HEX.lineStrong}`,
                padding: '4px 8px',
                fontWeight: 600,
                textAlign: index === 0 ? 'left' : section.numeric.includes(index) ? 'right' : 'left',
              }}
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {section.rows.map((row, rowIndex) => (
          <tr key={rowIndex} style={{ borderBottom: `1px solid ${HEX.line}` }}>
            {row.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                style={{
                  padding: '4px 8px',
                  textAlign: cellIndex === 0 ? 'left' : section.numeric.includes(cellIndex) ? 'right' : 'left',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {cell.text}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DocumentSection({ section }: { section: BrickDocumentSection }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h2
        style={{
          borderBottom: `1px solid ${HEX.lineStrong}`,
          paddingBottom: 4,
          fontSize: 12,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {section.title}
      </h2>
      <div style={{ marginTop: 8 }}>
        <DocumentTable section={section} />
      </div>
      {section.note ? (
        <p style={{ marginTop: 6, fontSize: 11, color: HEX.inkSoft }}>{section.note}</p>
      ) : null}
    </section>
  );
}

/** Ligne « libellé : valeur » des coordonnées d'entreprise. */
function HeaderLine({ children }: { children: ReactNode }) {
  return <p style={{ fontSize: 11, lineHeight: 1.4, color: HEX.muted }}>{children}</p>;
}

export function BrickRapportExportDocument({
  id = BRICK_RAPPORT_DOCUMENT_ID,
  report,
  company,
  className = '',
}: {
  id?: string;
  report: BrickReports;
  company: BrickRapportExportCompany;
  className?: string;
}) {
  const currency = company.currencySymbol?.trim() || 'GNF';
  const summary = buildBrickDecisionSummary(report, currency);
  const sections = buildBrickSections(report, company);

  return (
    <article id={id} style={DOCUMENT_STYLE} className={className.trim()}>
      {/* ── En-tête entreprise ───────────────────────────────────────────── */}
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          gap: 16,
          borderBottom: `2px solid ${HEX.primary}`,
          paddingBottom: 16,
        }}
      >
        <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
          {/* Logo téléversé dans les paramètres ; à défaut, le logo livré avec
              l'application — un rapport sans logo serait un recul. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={company.logo || DEFAULT_COMPANY_LOGO}
            alt={`Logo ${company.name}`}
            style={{
              width: 56,
              height: 56,
              flex: '0 0 56px',
              borderRadius: 10,
              objectFit: 'contain',
              border: `1px solid ${HEX.line}`,
            }}
          />
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.2 }}>{company.name}</p>
            {company.branch ? <HeaderLine>{company.branch}</HeaderLine> : null}
            {company.address ? <HeaderLine>{company.address}</HeaderLine> : null}
            {company.phone ? <HeaderLine>Tél. : {company.phone}</HeaderLine> : null}
            {company.email ? <HeaderLine>{company.email}</HeaderLine> : null}
            {company.taxId ? <HeaderLine>NIF : {company.taxId}</HeaderLine> : null}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              color: HEX.primary,
            }}
          >
            Rapport de la filiale
          </p>
          <p style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>
            Du {formatDateShort(report.from)} au {formatDateShort(report.to)}
          </p>
          <p style={{ fontSize: 11, color: HEX.muted, marginTop: 2 }}>
            {formatDateLong(report.from)} → {formatDateLong(report.to)}
          </p>
        </div>
      </header>

      {/* ── Résumé décisionnel ──────────────────────────────────────────── */}
      {summary.length > 0 ? (
        <section
          style={{
            marginTop: 16,
            padding: '12px 14px',
            border: `1px solid ${HEX.lineStrong}`,
            borderRadius: 10,
            backgroundColor: HEX.surfaceAlt,
          }}
        >
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: HEX.primary,
            }}
          >
            À retenir
          </p>
          <ul style={{ marginTop: 6, paddingLeft: 16, fontSize: 12, lineHeight: 1.6 }}>
            {summary.map((sentence, index) => (
              <li key={index}>{sentence}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── Rentabilité, puis chaque section ────────────────────────────── */}
      {sections.map((section) => (
        <DocumentSection key={section.title} section={section} />
      ))}

      <footer
        style={{
          marginTop: 24,
          borderTop: `1px solid ${HEX.line}`,
          paddingTop: 12,
          fontSize: 10,
          color: HEX.muted,
        }}
      >
        <p>
          Rapport interne généré le {formatDateLong(new Date())} — montants en {currency}. Tous les
          totaux sont recalculés à la lecture depuis les productions, dépenses, ventes et paiements :
          aucun n&apos;est stocké.
        </p>
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * Document HTML autonome — cible des exports PDF, image et WhatsApp
 * ------------------------------------------------------------------ */

/**
 * Construit le document HTML **autonome** capturé par `lib/export-document.ts`.
 *
 * `renderExportDocument` n'accepte que des chaînes : on y projette les mêmes
 * sections que l'aperçu ci-dessus, donc les mêmes chiffres, dans le même ordre.
 */
export function buildBrickRapportExportHtml(
  report: BrickReports,
  company: BrickRapportExportCompany,
): string {
  const currency = company.currencySymbol?.trim() || 'GNF';
  const summary = buildBrickDecisionSummary(report, currency);
  const sections = buildBrickSections(report, company);
  const p = report.profitability;

  const blocks: ExportBlock[] = [
    {
      kind: 'paragraph',
      title: 'Résumé décisionnel',
      text: summary.join(' '),
    },
  ];

  // Chaque section est suivie de sa note de synthèse (totaux), quand elle en a
  // une : la note porte sur la section qui la précède, pas sur la suivante.
  sections.forEach((section) => {
    blocks.push({
      kind: 'table',
      title: section.title,
      columns: section.head.map((label, index) => ({
        label,
        align: index === 0 ? 'left' : section.numeric.includes(index) ? 'right' : 'left',
      })),
      numeric: section.numeric,
      rows: section.rows.map((row) => row.map((cell) => cell.text)),
    });

    if (section.note) {
      blocks.push({ kind: 'paragraph', title: section.title, text: section.note });
    }
  });

  return renderExportDocument({
    documentTitle: 'Rapport de la filiale',
    documentDate: `Période : ${formatDateShort(report.from)} → ${formatDateShort(report.to)}`,
    company,
    meta: [
      ['Période', `${formatDateShort(report.from)} → ${formatDateShort(report.to)}`],
      ['Pièces produites nettes', formatQuantity(p.producedQuantity, 'pièces')],
      ['Chiffre d’affaires', formatCurrency(p.revenue, currency)],
      ['Résultat estimé', formatCurrency(p.estimatedResult, currency)],
    ],
    blocks,
    footer: `Rapport interne de la filiale — ${company.name} · montants en ${currency}`,
  });
}

/* ------------------------------------------------------------------ *
 * Export tableur (CSV) — README §4.3, §11.1
 * ------------------------------------------------------------------ */

/** Un champ CSV : guillemets doublés, délimiteur protégé. */
function csvField(value: string): string {
  const text = String(value ?? '');
  if (/[";\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Nombre pour Excel français : ni séparateur de milliers, ni espace insécable
 * (qui transformerait la cellule en texte), et la virgule décimale.
 */
function csvNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 1000) / 1000).replace('.', ',');
}

/**
 * Jeu de données complet du rapport de briqueterie, en CSV.
 * BOM UTF-8 + séparateur `;` : Excel ouvre le fichier correctement en français.
 */
export function buildBrickRapportCsv(
  report: BrickReports,
  company: BrickRapportExportCompany,
): string {
  const currency = company.currencySymbol?.trim() || 'GNF';
  const lines: string[] = [];

  const row = (...cells: (string | number)[]) => {
    lines.push(
      cells.map((cell) => csvField(typeof cell === 'number' ? csvNumber(cell) : cell)).join(';'),
    );
  };

  row('Rapport', 'Filiale de production — production et rentabilité');
  row('Entreprise', company.name);
  row('Filiale', company.branch ?? '');
  row('Adresse', company.address ?? '');
  row('Téléphone', company.phone ?? '');
  row('NIF', company.taxId ?? '');
  row('Du', report.from);
  row('Au', report.to);
  row('Devise', currency);
  lines.push('');

  row('RÉSUMÉ DÉCISIONNEL');
  buildBrickDecisionSummary(report, currency).forEach((sentence) => row(sentence));
  lines.push('');

  buildBrickSections(report, company).forEach((section) => {
    row(section.title.toUpperCase());
    row(...section.head);
    section.rows.forEach((cells) => {
      row(...cells.map((cell) => cell.value ?? cell.text));
    });
    if (section.note) row(section.note);
    lines.push('');
  });

  // BOM UTF-8 : sans lui, Excel affiche « Ã© » à la place de « é ».
  return `\uFEFF${lines.join('\r\n')}`;
}

/** Déclenche le téléchargement du CSV (aucune dépendance externe). */
export function downloadBrickRapportCsv(
  report: BrickReports,
  company: BrickRapportExportCompany,
  fileName = 'rapport-briqueterie',
): void {
  const csv = buildBrickRapportCsv(report, company);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileName}.csv`;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
