/**
 * Paramètres : **types, valeurs par défaut et sérialisation**.
 *
 * Ce module est volontairement **sans aucune dépendance à la base** : le
 * `SettingsProvider` est un composant client et doit pouvoir importer les types
 * et les valeurs par défaut sans entraîner `db/index.ts` (et donc
 * `@libsql/client`) dans le bundle navigateur.
 *
 * L'accès aux données vit dans `lib/settings.ts` (serveur).
 */

export type Settings = {
  /* Entreprise */
  companyName: string;
  companyBranch: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyLogo: string;
  companyTaxId: string;
  /* Devise et format */
  currency: string;
  currencySymbol: string;
  dateFormat: string;
  /* Numérotation (Q1) */
  invoicePrefix: string;
  invoiceNumberFormat: string;
  purchasePrefix: string;
  receiptPrefix: string;
  jobPrefix: string;
  transferPrefix: string;
  inventoryPrefix: string;
  defaultTaxRate: number;
  /* Référentiels — listes fermées (§6.6) */
  paymentMethods: string[];
  units: string[];
  expenseCategories: string[];
  /* Apparence */
  theme: 'light' | 'dark';
  primaryColor: string;
  sidebarColor: string;
  sidebarCollapsed: boolean;
  /* Alertes de stock */
  lowStockAlert: boolean;
  defaultStockMin: number;
  /* Rapports (§11, §16) */
  reportChannels: string[];
  reportRecipients: string[];
  reportFrequency: 'manual' | 'day' | 'week' | 'month';
  reportSendTime: string;
  reportProviderConfig: string;
  /* Règles métier */
  creditLimitEnforced: boolean;
  invoiceFooterNote: string;
  /** Au-delà de ce montant, une dépense saisie par un non-administrateur attend une approbation (0 = jamais). */
  expenseApprovalThreshold: number;
  /** Les transferts exigent-ils une validation avant expédition ? */
  transferApprovalRequired: boolean;
  /** Répartition des charges du siège dans les rapports consolidés : prorata du CA, parts égales, ou aucune. */
  centralChargesAllocation: 'revenue' | 'equal' | 'none';
  /** Un gérant peut-il fixer un prix de vente local ? */
  localPricesAllowed: boolean;
  /* Sauvegarde (§18) — locaux au poste */
  autoBackupEnabled: boolean;
  /** Dossier de copie externe (clé USB, disque réseau, dossier Google Drive synchronisé). */
  backupExternalDir: string;
  backupRetentionDays: number;
  /*
   * La synchronisation n'est plus un paramètre : l'identité du poste, son mode
   * (autonome / siège / magasin) et l'adresse du serveur vivent dans
   * `sync_state` (voir `lib/device.ts`) et se règlent depuis /synchronisation.
   */
};

export const DEFAULT_SETTINGS: Settings = {
  companyName: 'Planète Déco Sarlu',
  companyBranch: 'Filiale Meubles',
  companyAddress: '',
  companyPhone: '',
  companyEmail: '',
  companyLogo: '',
  companyTaxId: '',
  currency: 'GNF',
  currencySymbol: 'GNF',
  dateFormat: 'DD/MM/YYYY',
  invoicePrefix: 'FAC',
  /**
   * `{STORE}` = code du magasin + numéro de poste (ex. `KAL3`) : deux postes
   * hors ligne ne peuvent jamais produire le même numéro (§9, §23.8).
   */
  invoiceNumberFormat: '{PREFIX}-{STORE}-{YYYY}-{NNNNNN}',
  purchasePrefix: 'ACH',
  receiptPrefix: 'REC',
  jobPrefix: 'CHA',
  transferPrefix: 'TRF',
  inventoryPrefix: 'INV',
  // Q2 : taux par défaut 0 % (facturation sans TVA), champ présent et configurable.
  defaultTaxRate: 0,
  paymentMethods: ['Espèces', 'Mobile Money', 'Virement', 'Crédit'],
  units: ['pièce', 'ensemble', 'carton', 'm²', 'kg', 'sac', 'litre'],
  expenseCategories: ['Transport', 'Loyer', 'Salaire', 'Carburant', 'Électricité', 'Autre'],
  theme: 'light',
  primaryColor: '#1e40af',
  sidebarColor: '#1e293b',
  sidebarCollapsed: false,
  lowStockAlert: true,
  defaultStockMin: 0,
  reportChannels: ['whatsapp'],
  reportRecipients: [],
  reportFrequency: 'manual',
  reportSendTime: '20:00',
  reportProviderConfig: '',
  // Q18 : on avertit, on ne bloque pas, en V1.
  creditLimitEnforced: false,
  invoiceFooterNote: '',
  expenseApprovalThreshold: 0,
  transferApprovalRequired: true,
  centralChargesAllocation: 'revenue',
  localPricesAllowed: true,
  autoBackupEnabled: true,
  backupExternalDir: '',
  backupRetentionDays: 30,
};

/** Clés de `settings` qui ne sont **jamais** synchronisées (§23.9). */
export const LOCAL_ONLY_SETTINGS_KEYS: (keyof Settings)[] = [
  'theme',
  'primaryColor',
  'sidebarColor',
  'sidebarCollapsed',
  'reportProviderConfig',
  'autoBackupEnabled',
  'backupExternalDir',
  'backupRetentionDays',
];

export const SETTINGS_KEY_LABELS: Partial<Record<keyof Settings, string>> = {
  companyName: "Nom de l'entreprise",
  companyBranch: 'Filiale',
  companyAddress: 'Adresse',
  companyPhone: 'Téléphone',
  companyEmail: 'Email',
  companyLogo: 'Logo',
  companyTaxId: 'NIF',
};

/**
 * Logo livré avec l'application, affiché sur les documents tant que le client
 * n'a pas téléversé le sien dans les paramètres.
 *
 * Le fichier vit dans `public/` : il est donc servi à la racine et peut servir
 * directement de `src` d'image, aussi bien dans l'interface que dans un document
 * exporté (PDF, image, WhatsApp). Les icônes de l'application sont **générées
 * depuis ce même fichier** par `scripts/generate-icons.js`.
 */
export const DEFAULT_COMPANY_LOGO = '/logo.jpg';

/** camelCase (application) → snake_case (base). */
export function toDbKey(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/** snake_case (base) → camelCase (application). */
export function fromDbKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export const ARRAY_SETTINGS_KEYS: (keyof Settings)[] = [
  'paymentMethods',
  'units',
  'expenseCategories',
  'reportChannels',
  'reportRecipients',
];

export const BOOLEAN_SETTINGS_KEYS: (keyof Settings)[] = [
  'lowStockAlert',
  'sidebarCollapsed',
  'creditLimitEnforced',
  'transferApprovalRequired',
  'localPricesAllowed',
  'autoBackupEnabled',
];

export const NUMBER_SETTINGS_KEYS: (keyof Settings)[] = [
  'defaultTaxRate',
  'defaultStockMin',
  'expenseApprovalThreshold',
  'backupRetentionDays',
];

/** Valeur applicative → texte stocké (les listes sont séparées par des virgules). */
export function serializeSetting(key: keyof Settings, value: unknown): string {
  if (ARRAY_SETTINGS_KEYS.includes(key)) {
    const list = Array.isArray(value) ? value : [];
    return list.map((v) => String(v).trim()).filter(Boolean).join(',');
  }
  if (BOOLEAN_SETTINGS_KEYS.includes(key)) return value ? 'true' : 'false';
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Texte stocké → valeur applicative typée. */
export function deserializeSetting(key: keyof Settings, raw: string): unknown {
  if (ARRAY_SETTINGS_KEYS.includes(key)) {
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (BOOLEAN_SETTINGS_KEYS.includes(key)) return raw === 'true' || raw === '1';
  if (NUMBER_SETTINGS_KEYS.includes(key)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_SETTINGS[key];
  }
  return raw;
}

/** Clés techniques (compteurs de numérotation) : présentes en base, hors `Settings`. */
export function isTechnicalSettingKey(key: string): boolean {
  return key.startsWith('seq_');
}

/*
 * Rendu d'un numéro de document. Fonction pure, placée ici pour que l'écran
 * des paramètres montre l'aperçu exact sans importer de module serveur.
 */
/** Applique le gabarit de numérotation (`{PREFIX}-{STORE}-{YYYY}-{NNNNNN}`). */
export function renderDocumentNumber(
  prefix: string,
  sequence: number,
  template: string,
  year = new Date().getFullYear(),
  storeTag = '',
): string {
  // Anciens gabarits sans `{STORE}` : le magasin est inséré après le préfixe,
  // sinon deux magasins produiraient le même numéro.
  let pattern = template;
  if (storeTag && !pattern.includes('{STORE}')) {
    pattern = pattern.includes('{PREFIX}') ? pattern.replace('{PREFIX}', '{PREFIX}-{STORE}') : `{STORE}-${pattern}`;
  }
  return pattern
    .replace('{PREFIX}', prefix)
    .replace('{STORE}', storeTag)
    .replace('{YYYY}', String(year))
    .replace('{YY}', String(year).slice(-2))
    .replace('{NNNNNN}', String(sequence).padStart(6, '0'))
    .replace('{NNNN}', String(sequence).padStart(4, '0'))
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
}
