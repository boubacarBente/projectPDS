'use client';

/**
 * Saisie des numéros de l'en-tête des documents (3 au plus, demande client) :
 * chacun avec une case « WhatsApp » qui choisit son icône sur la facture.
 * Utilisé dans Paramètres (numéros de l'entreprise) et dans la fiche d'un
 * magasin (ses propres numéros).
 *
 * ⚠️ Libellés : jamais « numéro » dans un libellé de champ ni un texte
 * d'exemple (AGENTS.md, invariant 10 — autoremplissage carte bancaire).
 */
import { MAX_DOCUMENT_PHONES, parseDocumentPhone, serializeDocumentPhone, type DocumentPhone } from '@/lib/settings-schema';

/** Format stocké → lignes du formulaire (toujours 3 lignes). */
export function phonesToRows(stored: string[] | null | undefined): DocumentPhone[] {
  const rows = (stored ?? []).map(parseDocumentPhone).slice(0, MAX_DOCUMENT_PHONES);
  while (rows.length < MAX_DOCUMENT_PHONES) rows.push({ number: '', whatsapp: false });
  return rows;
}

/** Lignes du formulaire → format stocké (lignes vides retirées). */
export function rowsToPhones(rows: DocumentPhone[]): string[] {
  return rows.filter((row) => row.number.trim()).map(serializeDocumentPhone).slice(0, MAX_DOCUMENT_PHONES);
}

export function DocumentPhonesEditor({
  idPrefix,
  rows,
  onChange,
  disabled = false,
}: {
  idPrefix: string;
  rows: DocumentPhone[];
  onChange: (rows: DocumentPhone[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<DocumentPhone>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <label htmlFor={`${idPrefix}-${index}`} className="sr-only">
            Téléphone {index + 1}
          </label>
          <input
            id={`${idPrefix}-${index}`}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            className="input input-bordered field-rounded min-h-11 w-full min-w-0 flex-1 sm:min-h-0"
            placeholder={`Téléphone ${index + 1} — ex. +224 621 49 64 06`}
            value={row.number}
            disabled={disabled}
            onChange={(event) => update(index, { number: event.target.value })}
          />
          <label className="flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap text-sm sm:min-h-0">
            <input
              type="checkbox"
              className="checkbox checkbox-sm checkbox-success"
              checked={row.whatsapp}
              disabled={disabled}
              onChange={(event) => update(index, { whatsapp: event.target.checked })}
            />
            WhatsApp
          </label>
        </div>
      ))}
    </div>
  );
}
