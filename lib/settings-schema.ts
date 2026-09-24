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
  brickPrefix: string;
  furniturePrefix: string;
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
  /* Synchronisation (§23.9) — désactivée par défaut (Q21) */
  syncMode: 'off' | 'backup' | 'multi';
  syncApiUrl: string;
  syncDeviceId: string;
  syncIntervalMinutes: number;
  syncNumberBlockSize: number;
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
  invoiceNumberFormat: '{PREFIX}-{YYYY}-{NNNNNN}',
  purchasePrefix: 'ACH',
  receiptPrefix: 'REC',
  jobPrefix: 'CHA',
  brickPrefix: 'BRI',
  furniturePrefix: 'MEU',
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
  syncMode: 'off',
  syncApiUrl: '',
  syncDeviceId: '',
  syncIntervalMinutes: 15,
  syncNumberBlockSize: 500,
};

/** Clés de `settings` qui ne sont **jamais** synchronisées (§23.9). */
export const LOCAL_ONLY_SETTINGS_KEYS: (keyof Settings)[] = [
  'syncMode',
  'syncApiUrl',
  'syncDeviceId',
  'theme',
  'primaryColor',
  'sidebarColor',
  'sidebarCollapsed',
  'reportProviderConfig',
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
];

export const NUMBER_SETTINGS_KEYS: (keyof Settings)[] = [
  'defaultTaxRate',
  'defaultStockMin',
  'syncIntervalMinutes',
  'syncNumberBlockSize',
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
