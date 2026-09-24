/**
 * Export de documents (facture, reçu, rapport, devis) en PDF et en image.
 *
 * ## L'approche retenue — celle du projet Gaz
 *
 * On ne capture **jamais** la page affichée. On écrit un **document HTML
 * autonome**, avec sa propre feuille de styles et des **couleurs hexadécimales
 * uniquement**, dans un `<iframe>` invisible, puis on capture `iframeDoc.body`.
 *
 * ## Pourquoi c'est la seule approche qui fonctionne
 *
 * `html2canvas@1.4.1` ne sait analyser que `rgb()`, `rgba()`, `hsl()`, `hsla()`
 * et les couleurs nommées : les chaînes `oklch`, `oklab`, `lab` et `lch`
 * n'apparaissent **pas une seule fois** dans son code. Or Tailwind 4 et
 * DaisyUI 5 émettent des `oklch()` partout, et une simple opacité comme
 * `border-primary/70` produit un `color-mix()`. Capturer la page affichée
 * échoue donc.
 *
 * Aucune conversion côté navigateur n'est possible : vérifié à l'exécution,
 * `ctx.fillStyle = 'oklch(45% .24 277)'` renvoie `oklch(0.45 0.24 277.023)` —
 * le navigateur **normalise** la couleur sans la convertir en sRGB.
 *
 * Le gabarit ci-dessous n'utilise donc que des couleurs hexadécimales, y compris
 * la couleur principale du client (`settings.primaryColor`, exprimée en hex).
 * C'est exactement ce que fait le projet Gaz, dont l'export fonctionne.
 *
 * **Bénéfice secondaire** : le document exporté ne dépend plus de la mise en page
 * responsive de l'écran. Le PDF est net, complet, et réparti sur plusieurs pages
 * si nécessaire au lieu d'être comprimé sur une seule.
 */

import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';

/* ------------------------------------------------------------------ *
 * Palette — hexadécimal uniquement, jamais de fonction moderne
 * ------------------------------------------------------------------ */
const COLORS = {
  ink: '#1e293b',
  inkSoft: '#475569',
  muted: '#64748b',
  line: '#e2e8f0',
  lineStrong: '#cbd5e1',
  surface: '#ffffff',
  surfaceAlt: '#f8fafc',
  success: '#15803d',
  warning: '#b45309',
  danger: '#b91c1c',
  /** Repli si le client n'a pas défini de couleur principale. */
  primary: '#1e40af',
} as const;

/** Une couleur hexadécimale valide, sinon le repli. */
function safeHex(value: string | undefined | null, fallback: string = COLORS.primary): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())) return value.trim();
  if (typeof value === 'string' && /^#[0-9a-fA-F]{3}$/.test(value.trim())) {
    const [r, g, b] = value.trim().slice(1).split('');
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
}

/** Échappe le texte destiné au HTML (le contenu vient de la base). */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ------------------------------------------------------------------ *
 * Description du document
 * ------------------------------------------------------------------ */

export type ExportCompany = {
  name: string;
  branch?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
  logo?: string | null;
  /** Couleur principale du client (hexadécimal). */
  primaryColor?: string | null;
  currencySymbol?: string | null;
};

export type ExportBlock =
  /** Deux colonnes « libellé : valeur » — coordonnées, récapitulatif. */
  | { kind: 'keyValue'; title?: string; rows: [string, string][] }
  /** Tableau de lignes. */
  | {
      kind: 'table';
      title?: string;
      columns: { label: string; align?: 'left' | 'right' | 'center' }[];
      rows: string[][];
      /** Index des colonnes à rendre en chiffres alignés (tabular-nums). */
      numeric?: number[];
    }
  /** Bloc de totaux, aligné à droite. */
  | {
      kind: 'totals';
      title?: string;
      rows: { label: string; value: string; tone?: 'normal' | 'strong' | 'success' | 'warning' }[];
    }
  /** Paragraphe libre. */
  | { kind: 'paragraph'; title?: string; text: string };

export type ExportDocumentInput = {
  /** « FACTURE », « REÇU », « RAPPORT », « DEVIS ». */
  documentTitle: string;
  documentNumber?: string | null;
  documentDate?: string | null;
  /** Badge d'état affiché à droite du titre (« Payée », « En retard »…). */
  badge?: { label: string; tone?: 'success' | 'warning' | 'danger' | 'neutral' } | null;
  company: ExportCompany;
  /** Bloc de métadonnées sous l'en-tête (client, échéance, site…). */
  meta?: [string, string][];
  blocks: ExportBlock[];
  notes?: string | null;
  footer?: string | null;
};

/* ------------------------------------------------------------------ *
 * Gabarit HTML
 * ------------------------------------------------------------------ */

function badgeStyles(tone: string, primary: string): string {
  switch (tone) {
    case 'success':
      return `background:${COLORS.success};color:#ffffff;border-color:${COLORS.success}`;
    case 'warning':
      return `background:${COLORS.warning};color:#ffffff;border-color:${COLORS.warning}`;
    case 'danger':
      return `background:${COLORS.danger};color:#ffffff;border-color:${COLORS.danger}`;
    default:
      return `background:${COLORS.surfaceAlt};color:${COLORS.inkSoft};border-color:${COLORS.lineStrong}`;
  }
}

function toneColor(tone: string | undefined): string {
  switch (tone) {
    case 'success':
      return COLORS.success;
    case 'warning':
      return COLORS.warning;
    case 'strong':
      return COLORS.ink;
    default:
      return COLORS.inkSoft;
  }
}

function renderBlock(block: ExportBlock, primary: string): string {
  if (block.kind === 'keyValue') {
    return `
      <section class="block">
        ${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ''}
        <dl class="kv">
          ${block.rows
            .map(
              ([label, value]) =>
                `<div class="kv-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
            )
            .join('')}
        </dl>
      </section>`;
  }

  if (block.kind === 'table') {
    const numeric = new Set(block.numeric ?? []);
    return `
      <section class="block">
        ${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ''}
        <table>
          <thead>
            <tr>
              ${block.columns
                .map(
                  (column, index) =>
                    `<th class="${column.align ?? (numeric.has(index) ? 'right' : 'left')}">${escapeHtml(column.label)}</th>`,
                )
                .join('')}
            </tr>
          </thead>
          <tbody>
            ${
              block.rows.length === 0
                ? `<tr><td class="empty" colspan="${block.columns.length}">Aucune ligne.</td></tr>`
                : block.rows
                    .map(
                      (row) => `<tr>${row
                        .map((cell, index) => {
                          const align =
                            block.columns[index]?.align ?? (numeric.has(index) ? 'right' : 'left');
                          return `<td class="${align}${numeric.has(index) ? ' num' : ''}">${escapeHtml(cell)}</td>`;
                        })
                        .join('')}</tr>`,
                    )
                    .join('')
            }
          </tbody>
        </table>
      </section>`;
  }

  if (block.kind === 'totals') {
    return `
      <section class="block totals-wrap">
        <div class="totals">
          ${block.rows
            .map(
              (row) => `
            <div class="total-row">
              <span class="total-label">${escapeHtml(row.label)}</span>
              <span class="total-value num" style="color:${toneColor(row.tone)}">${escapeHtml(row.value)}</span>
            </div>`,
            )
            .join('')}
        </div>
      </section>`;
  }

  return `
    <section class="block">
      ${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ''}
      <p class="paragraph">${escapeHtml(block.text)}</p>
    </section>`;
}

/**
 * Produit un document HTML **complet et autonome**.
 * Aucune ressource externe : ni feuille de styles, ni police distante.
 */
export function renderExportDocument(input: ExportDocumentInput): string {
  const primary = safeHex(input.company.primaryColor);
  const currency = input.company.currencySymbol?.trim() || 'GNF';

  const companyLines = [
    input.company.branch,
    input.company.address,
    input.company.phone,
    input.company.email,
    input.company.taxId ? `NIF : ${input.company.taxId}` : null,
  ].filter((line): line is string => Boolean(line && String(line).trim()));

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(input.documentTitle)}${input.documentNumber ? ` ${escapeHtml(input.documentNumber)}` : ''}</title>
<style>
  /* Couleurs hexadécimales uniquement : aucune fonction colorimétrique moderne,
     sinon la capture échoue (voir l'en-tête de ce fichier). */
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 794px; /* ~A4 à 96 dpi */
    padding: 32px 36px;
    background: ${COLORS.surface};
    color: ${COLORS.ink};
    font-family: "Segoe UI", Arial, Helvetica, sans-serif;
    font-size: 13px;
    line-height: 1.45;
  }

  .num, table td.num, table th.right, table td.right { font-variant-numeric: tabular-nums; }

  /* ── En-tête ─────────────────────────────────────────────────── */
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 20px;
    padding-bottom: 16px;
    border-bottom: 2px solid ${primary};
    margin-bottom: 22px;
  }
  .company { display: flex; gap: 12px; align-items: flex-start; }
  .logo {
    width: 62px; height: 62px; flex: 0 0 62px;
    border-radius: 10px; object-fit: contain;
    border: 1px solid ${COLORS.line};
  }
  .company-name { font-size: 17px; font-weight: 700; color: ${COLORS.ink}; }
  .company-line { font-size: 11px; color: ${COLORS.muted}; }
  .doc-id { text-align: right; }
  .doc-title {
    font-size: 19px; font-weight: 700; letter-spacing: 0.06em;
    color: ${primary}; text-transform: uppercase;
  }
  .doc-number { font-size: 14px; font-weight: 600; margin-top: 2px; }
  .doc-date { font-size: 11px; color: ${COLORS.muted}; margin-top: 2px; }
  .badge {
    display: inline-block; margin-top: 8px; padding: 3px 10px;
    border-radius: 999px; border: 1px solid ${COLORS.lineStrong};
    font-size: 11px; font-weight: 600;
  }

  /* ── Métadonnées ─────────────────────────────────────────────── */
  .meta {
    display: flex; flex-wrap: wrap; gap: 10px 28px;
    padding: 12px 14px; margin-bottom: 20px;
    background: ${COLORS.surfaceAlt};
    border: 1px solid ${COLORS.line};
    border-radius: 10px;
  }
  .meta-item { min-width: 150px; }
  .meta-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: ${COLORS.muted}; }
  .meta-value { font-size: 13px; font-weight: 600; }

  /* ── Blocs ───────────────────────────────────────────────────── */
  .block { margin-bottom: 18px; }
  h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: ${COLORS.muted}; margin-bottom: 7px;
  }
  .paragraph { font-size: 13px; color: ${COLORS.inkSoft}; }

  .kv { display: flex; flex-direction: column; gap: 3px; }
  .kv-row { display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid ${COLORS.line}; padding: 4px 0; }
  .kv-row dt { color: ${COLORS.muted}; font-size: 12px; }
  .kv-row dd { font-weight: 600; text-align: right; }

  table { width: 100%; border-collapse: collapse; }
  thead th {
    background: ${COLORS.surfaceAlt};
    border-bottom: 2px solid ${COLORS.line};
    padding: 8px 9px;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: ${COLORS.inkSoft}; text-align: left;
  }
  thead th.right, tbody td.right { text-align: right; }
  thead th.center, tbody td.center { text-align: center; }
  tbody td { padding: 7px 9px; border-bottom: 1px solid ${COLORS.line}; font-size: 12.5px; }
  tbody tr:nth-child(even) td { background: #fcfdff; }
  td.empty { text-align: center; color: ${COLORS.muted}; font-style: italic; padding: 16px; }

  /* ── Totaux ──────────────────────────────────────────────────── */
  .totals-wrap { display: flex; justify-content: flex-end; }
  .totals { width: 320px; }
  .total-row { display: flex; justify-content: space-between; gap: 16px; padding: 6px 0; border-bottom: 1px solid ${COLORS.line}; }
  .total-label { color: ${COLORS.muted}; }
  .total-value { font-weight: 700; font-size: 14px; }

  /* ── Notes et pied ───────────────────────────────────────────── */
  .notes {
    margin-top: 6px; padding: 12px 14px;
    background: ${COLORS.surfaceAlt};
    border: 1px solid ${COLORS.line};
    border-radius: 10px;
  }
  .notes h2 { margin-bottom: 5px; }
  footer {
    margin-top: 26px; padding-top: 12px;
    border-top: 1px solid ${COLORS.line};
    text-align: center; font-size: 11px; color: ${COLORS.muted};
  }
  .footer-strong { font-size: 13px; font-weight: 700; color: ${COLORS.ink}; margin-top: 6px; }
  .currency { color: ${COLORS.muted}; font-size: 11px; }
</style>
</head>
<body>
  <header>
    <div class="company">
      ${
        input.company.logo
          ? `<img class="logo" src="${escapeHtml(input.company.logo)}" alt="" />`
          : ''
      }
      <div>
        <div class="company-name">${escapeHtml(input.company.name)}</div>
        ${companyLines.map((line) => `<div class="company-line">${escapeHtml(line)}</div>`).join('')}
      </div>
    </div>
    <div class="doc-id">
      <div class="doc-title">${escapeHtml(input.documentTitle)}</div>
      ${input.documentNumber ? `<div class="doc-number">${escapeHtml(input.documentNumber)}</div>` : ''}
      ${input.documentDate ? `<div class="doc-date">${escapeHtml(input.documentDate)}</div>` : ''}
      ${
        input.badge
          ? `<div class="badge" style="${badgeStyles(input.badge.tone ?? 'neutral', primary)}">${escapeHtml(input.badge.label)}</div>`
          : ''
      }
    </div>
  </header>

  ${
    input.meta && input.meta.length > 0
      ? `<div class="meta">
          ${input.meta
            .map(
              ([label, value]) =>
                `<div class="meta-item"><div class="meta-label">${escapeHtml(label)}</div><div class="meta-value">${escapeHtml(value)}</div></div>`,
            )
            .join('')}
        </div>`
      : ''
  }

  ${input.blocks.map((block) => renderBlock(block, primary)).join('')}

  ${
    input.notes
      ? `<section class="notes"><h2>Notes</h2><p class="paragraph">${escapeHtml(input.notes)}</p></section>`
      : ''
  }

  <footer>
    <div>${escapeHtml(input.footer ?? 'Document généré par le logiciel de gestion Planète Déco Sarlu')}</div>
    <div class="footer-strong">${escapeHtml(input.company.name)}</div>
    <div class="currency">Montants exprimés en ${escapeHtml(currency)}</div>
  </footer>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * Capture et enregistrement
 * ------------------------------------------------------------------ */

/**
 * Rend le document HTML dans un iframe invisible et le capture.
 *
 * L'iframe est indispensable : c'est ce qui garantit que seules **nos** couleurs
 * hexadécimales sont capturées, jamais celles de la page (Tailwind/DaisyUI).
 */
async function captureHtml(html: string, width = 794): Promise<HTMLCanvasElement> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:1400px;border:none;background:${COLORS.surface};`;
  document.body.appendChild(iframe);

  try {
    const frameDocument = iframe.contentDocument ?? iframe.contentWindow?.document;
    if (!frameDocument) throw new Error("Le document d'export n'a pas pu être créé");

    frameDocument.open();
    frameDocument.write(html);
    frameDocument.close();

    // Le logo est une image : on attend son chargement, sinon il manquerait
    // sur l'export (image absente = document incomplet pour le client).
    await Promise.all(
      Array.from(frameDocument.images).map(
        (image) =>
          new Promise<void>((resolve) => {
            if (image.complete) return resolve();
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => resolve(), { once: true });
          }),
      ),
    );

    // Une passe de rendu avant la capture, pour que la mise en page soit figée.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    return await html2canvas(frameDocument.body, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: COLORS.surface,
      logging: false,
      width,
      windowWidth: width,
    });
  } finally {
    iframe.remove();
  }
}

/**
 * Enregistre un document en PDF A4.
 * Les proportions sont conservées ; un document plus haut qu'une page est
 * réparti sur plusieurs pages plutôt que comprimé.
 */
export async function exportDocumentAsPDF(html: string, fileName: string): Promise<void> {
  const canvas = await captureHtml(html);
  const dataUrl = canvas.toDataURL('image/png');

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const printableWidth = pageWidth - margin * 2;
  const printableHeight = pageHeight - margin * 2;

  const ratio = canvas.height / canvas.width;
  const renderedHeight = printableWidth * ratio;

  if (renderedHeight <= printableHeight) {
    pdf.addImage(dataUrl, 'PNG', margin, margin, printableWidth, renderedHeight);
  } else {
    const pages = Math.ceil(renderedHeight / printableHeight);
    for (let page = 0; page < pages; page += 1) {
      if (page > 0) pdf.addPage();
      pdf.addImage(dataUrl, 'PNG', margin, margin - page * printableHeight, printableWidth, renderedHeight);
    }
  }

  pdf.save(`${fileName}.pdf`);
}

/** Enregistre un document en image PNG. */
export async function exportDocumentAsImage(html: string, fileName: string): Promise<void> {
  const canvas = await captureHtml(html);
  const dataUrl = canvas.toDataURL('image/png');

  const link = document.createElement('a');
  link.download = `${fileName}.png`;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Nom de fichier sûr, à partir d'une référence de document. */
export function exportFileName(prefix: string, reference: string | null | undefined): string {
  const safe = String(reference ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-');
  return safe ? `${prefix}-${safe}` : prefix;
}

/**
 * Convertit les paramètres de l'application en identité d'entreprise pour
 * l'export. Le logo a un repli sur le fichier livré avec l'application, et la
 * couleur principale est prise dans les réglages — **en hexadécimal**, ce qui
 * est justement ce qui rend la capture possible.
 */
export function exportCompanyFromSettings(settings: {
  companyName?: string | null;
  companyBranch?: string | null;
  companyAddress?: string | null;
  companyPhone?: string | null;
  companyEmail?: string | null;
  companyTaxId?: string | null;
  companyLogo?: string | null;
  primaryColor?: string | null;
  currencySymbol?: string | null;
  currency?: string | null;
}): ExportCompany {
  return {
    name: settings.companyName?.trim() || 'Planète Déco Sarlu',
    branch: settings.companyBranch ?? null,
    address: settings.companyAddress ?? null,
    phone: settings.companyPhone ?? null,
    email: settings.companyEmail ?? null,
    taxId: settings.companyTaxId ?? null,
    logo: settings.companyLogo?.trim() || DEFAULT_COMPANY_LOGO,
    primaryColor: settings.primaryColor ?? null,
    currencySymbol: settings.currencySymbol?.trim() || settings.currency?.trim() || 'GNF',
  };
}
