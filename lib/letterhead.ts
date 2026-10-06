/**
 * Numéros de téléphone de l'en-tête des documents (factures, reçus, exports) —
 * **une seule source** pour l'écran et pour les exports PDF / image / WhatsApp.
 *
 * Demande client (5 octobre 2026) : 3 numéros au plus, chacun pouvant être
 * marqué WhatsApp, réglés dans Paramètres ; un magasin peut avoir les siens
 * (fiche du magasin). Ordre de priorité :
 *  1. numéros du magasin émetteur (`stores.document_phones`) ;
 *  2. numéros de l'entreprise, c.-à-d. du magasin principal (`companyPhones`) ;
 *  3. ancien champ « Téléphone » du magasin ou de l'entreprise.
 *
 * Module **sans dépendance serveur** : importé par des composants client.
 */
import { MAX_DOCUMENT_PHONES, parseDocumentPhone, type DocumentPhone } from '@/lib/settings-schema';

type PhoneSettings = {
  companyPhone?: string | null;
  companyPhones?: string[] | null;
  /** Posé par `applyStoreLetterhead` : numéros propres au magasin émetteur. */
  letterheadPhones?: string[] | null;
};

const phonesOf = (values: string[] | null | undefined): DocumentPhone[] =>
  (values ?? [])
    .map(parseDocumentPhone)
    .filter((p) => p.number)
    .slice(0, MAX_DOCUMENT_PHONES);

export function documentPhonesFromSettings(settings: PhoneSettings): DocumentPhone[] {
  const store = phonesOf(settings.letterheadPhones);
  if (store.length > 0) return store;
  const company = phonesOf(settings.companyPhones);
  if (company.length > 0) return company;
  // L'ancien champ peut contenir plusieurs numéros séparés par « / ».
  return (settings.companyPhone ?? '')
    .split(/\s*[/;]\s*/)
    .map((number) => number.trim())
    .filter(Boolean)
    .slice(0, MAX_DOCUMENT_PHONES)
    .map((number) => ({ number, whatsapp: false }));
}

/** `+224 621 496 406 · +224 629 585 035 (WhatsApp)` — la ligne « Tél. » des en-têtes. */
export function formatDocumentPhones(phones: DocumentPhone[]): string {
  return phones.map((p) => (p.whatsapp ? `${p.number} (WhatsApp)` : p.number)).join(' · ');
}

/** Raccourci : la ligne de téléphones d'un en-tête, depuis les paramètres. */
export function documentPhoneLine(settings: PhoneSettings): string {
  return formatDocumentPhones(documentPhonesFromSettings(settings));
}
