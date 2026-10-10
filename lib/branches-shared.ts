/**
 * Filiales de production — constantes et formes **sans dépendance serveur**
 * (README §31). Importable par les composants client (invariant 6) ; la
 * logique qui lit la base vit dans `lib/branches.ts`.
 */

export const BRANCH_ACTIVITIES = ['bricks', 'glass', 'furniture', 'other'] as const;
export type BranchActivity = (typeof BRANCH_ACTIVITIES)[number];

export const BRANCH_ACTIVITY_LABELS: Record<BranchActivity, string> = {
  bricks: 'Briques',
  glass: 'Vitrerie',
  furniture: 'Meubles',
  other: 'Autre activité',
};

export const BRANCH_STATUSES = ['active', 'suspended', 'archived'] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

export const BRANCH_STATUS_LABELS: Record<BranchStatus, string> = {
  active: 'Active',
  suspended: 'Suspendue',
  archived: 'Archivée',
};

/** Jetons de couleur du thème DaisyUI (invariant 11 : jamais de couleur figée). */
export const BRANCH_COLORS = ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error', 'neutral'] as const;
export type BranchColor = (typeof BRANCH_COLORS)[number];

export const BRANCH_COLOR_LABELS: Record<BranchColor, string> = {
  primary: 'Principale',
  secondary: 'Secondaire',
  accent: 'Accent',
  info: 'Bleu information',
  success: 'Vert',
  warning: 'Orange',
  error: 'Rouge',
  neutral: 'Neutre',
};

/**
 * Classes complètes par jeton : Tailwind ne génère que les classes écrites en
 * toutes lettres dans le code (une classe construite `bg-${color}` serait absente).
 */
export const BRANCH_COLOR_CLASSES: Record<BranchColor, { dot: string; soft: string }> = {
  primary: { dot: 'bg-primary', soft: 'bg-primary/10 text-primary' },
  secondary: { dot: 'bg-secondary', soft: 'bg-secondary/10 text-secondary' },
  accent: { dot: 'bg-accent', soft: 'bg-accent/10 text-accent' },
  info: { dot: 'bg-info', soft: 'bg-info/10 text-info' },
  success: { dot: 'bg-success', soft: 'bg-success/10 text-success' },
  warning: { dot: 'bg-warning', soft: 'bg-warning/10 text-warning' },
  error: { dot: 'bg-error', soft: 'bg-error/10 text-error' },
  neutral: { dot: 'bg-neutral', soft: 'bg-neutral/10 text-base-content' },
};

export function branchColorClasses(color: string | null | undefined) {
  return BRANCH_COLOR_CLASSES[(BRANCH_COLORS as readonly string[]).includes(color ?? '') ? (color as BranchColor) : 'primary'];
}

/** Unités proposées (le champ reste libre). */
export const BRANCH_UNITS = ['pièce', 'm²', 'm³', 'mètre', 'paquet', 'lot', 'kg', 'sac', 'planche', 'feuille'] as const;

export type BranchAccessLevel = 'view' | 'edit' | 'manage';
export const BRANCH_ACCESS_LABELS: Record<BranchAccessLevel, string> = {
  view: 'Consulter',
  edit: 'Saisir',
  manage: 'Gérer',
};

/** Étape de fabrication d'une filiale. La mise en stock (`stored`) est toujours la dernière. */
export type BranchStage = { key: string; label: string };

export const STORED_STAGE: BranchStage = { key: 'stored', label: 'En stock' };

/** Étapes proposées à la création d'une filiale, selon son activité. */
export const DEFAULT_STAGES: Record<BranchActivity, string[]> = {
  bricks: ['Moulage', 'Séchage', 'Cuisson'],
  glass: ['Découpe', 'Façonnage', 'Contrôle'],
  furniture: ['Découpe', 'Assemblage', 'Finition'],
  other: ['En cours'],
};

export const DEFAULT_LOSS_LABELS: Record<BranchActivity, string> = {
  bricks: 'Cassées',
  glass: 'Casse',
  furniture: 'Rebuts',
  other: 'Pertes',
};

/**
 * Vue d'une filiale envoyée à l'interface. `stages` exclut la mise en stock ;
 * `flow` = étapes + mise en stock, dans l'ordre du métier.
 */
export type ProductionBranch = {
  id: number;
  name: string;
  activity: BranchActivity;
  description: string | null;
  storeId: number | null;
  storeName: string | null;
  status: BranchStatus;
  color: BranchColor;
  sortOrder: number;
  unit: string;
  stages: BranchStage[];
  flow: BranchStage[];
  lossLabel: string;
  batchPrefix: string;
  orderPrefix: string;
  accessMode: 'all' | 'restricted';
  customerMode: 'all' | 'selected';
  createdAt: Date | string | null;
  /** Niveau de la session courante sur cette filiale (renseigné par l'API). */
  access?: BranchAccessLevel;
  /** Compteurs (liste d'administration). */
  modelsCount?: number;
  productionsCount?: number;
  ordersCount?: number;
  usersCount?: number;
  customersCount?: number;
};

/** Lien de menu d'une filiale (barre latérale). */
export type BranchNavLink = { id: number; name: string; color: BranchColor; href: string };

export function branchHref(branchId: number, path = ''): string {
  return `/filiales/${branchId}${path}`;
}

export function branchApi(branchId: number, path = ''): string {
  return `/api/filiales/${branchId}${path}`;
}

/** Libellé d'une étape (clé inconnue = clé brute, jamais d'écran vide). */
export function stageLabel(branch: Pick<ProductionBranch, 'flow'> | null | undefined, key: string): string {
  return branch?.flow.find((s) => s.key === key)?.label ?? (key === 'stored' ? STORED_STAGE.label : key);
}

/** Étape suivante dans le flux, ou `null` si la production est déjà en stock. */
export function nextStage(branch: Pick<ProductionBranch, 'flow'>, key: string): BranchStage | null {
  const index = branch.flow.findIndex((s) => s.key === key);
  return index >= 0 && index < branch.flow.length - 1 ? branch.flow[index + 1] : null;
}
