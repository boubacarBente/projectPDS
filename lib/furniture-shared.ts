/**
 * Atelier de meubles — constantes et types **sans accès à la base** (README §29).
 *
 * Les écrans importent leurs valeurs d'ici : `lib/furniture.ts` importe `@/db`
 * et ne doit jamais entrer dans le bundle navigateur (invariant 6).
 */

export const FURNITURE_STAGES = ['cutting', 'assembly', 'sanding', 'painting', 'finishing', 'delivered'] as const;

export type FurnitureStage = (typeof FURNITURE_STAGES)[number];

export type FurniturePurpose = 'customer' | 'stock';

export const FURNITURE_STAGE_LABELS: Record<FurnitureStage, string> = {
  cutting: 'Découpe',
  assembly: 'Assemblage',
  sanding: 'Ponçage',
  painting: 'Peinture / vernis',
  finishing: 'Finition',
  delivered: 'Livré',
};

export const FURNITURE_PURPOSE_LABELS: Record<FurniturePurpose, string> = {
  customer: 'Commande client',
  stock: 'Fabrication pour le stock',
};

/**
 * Libellé de la dernière étape : une fabrication pour le stock n'est pas
 * « livrée » à quelqu'un, elle est **mise en stock**.
 */
export function furnitureStageLabel(stage: FurnitureStage, purpose: FurniturePurpose = 'customer'): string {
  if (stage === 'delivered' && purpose === 'stock') return 'Mis en stock';
  return FURNITURE_STAGE_LABELS[stage];
}

export function furnitureStageSteps(purpose: FurniturePurpose = 'customer') {
  return FURNITURE_STAGES.map((stage) => ({ key: stage as string, label: furnitureStageLabel(stage, purpose) }));
}

export function isFurnitureStage(value: unknown): value is FurnitureStage {
  return typeof value === 'string' && (FURNITURE_STAGES as readonly string[]).includes(value);
}

/** Index d'une étape ; `-1` si inconnue (une donnée abîmée ne doit pas planter). */
export function furnitureStageIndex(stage: string | null | undefined): number {
  return FURNITURE_STAGES.indexOf((stage ?? '') as FurnitureStage);
}

/** Étape suivante, ou `null` si la commande est déjà au bout. */
export function nextFurnitureStage(stage: string | null | undefined): FurnitureStage | null {
  const index = furnitureStageIndex(stage);
  if (index < 0 || index >= FURNITURE_STAGES.length - 1) return null;
  return FURNITURE_STAGES[index + 1];
}
