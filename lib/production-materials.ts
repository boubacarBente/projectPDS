/**
 * Matières des filiales de production (README §31.3, §31.4) — reprise
 * généralisée de l'atelier de meubles (README §29) :
 *
 * 1. **Nomenclature** d'un modèle (`production_model_materials`) : matières
 *    pour **une** unité. Elle donne des **besoins** (× quantité prévue, sur le
 *    stock du magasin, déjà sorti déduit), jamais des lignes ni des sorties.
 * 2. **Matière sortie** (`production_materials`) : une ligne = une sortie de
 *    stock réelle (`addStockMovement`, jamais de stock négatif), chutes
 *    comprises, valorisée au prix d'achat (ou à un coût saisi) et comptée
 *    dans le coût de la production (`MATERIAL_COST_SQL`).
 * 3. Retirer une matière la **rend au stock avec ses chutes** et marque la
 *    ligne retirée (`deleted_at`) — jamais d'effacement.
 * 4. Matières facultatives : une filiale sans nomenclature (la briqueterie, dont
 *    les intrants sont des dépenses de lot) n'en voit pas la contrainte.
 *
 * Reprise de l'atelier (README §31.9) : `importFurnitureModels` recopie, sur
 * demande d'une personne et **dans le magasin actif**, les modèles de l'ancien
 * atelier en modèles de la filiale Meuble (produit lié + nomenclature). Fait
 * une fois, sur un poste, puis synchronisé : une reprise automatique en
 * migration aurait créé un doublon par poste.
 */

import { db, rawAll, rawGet, withTransaction } from '@/db';
import { and, eq, isNull } from 'drizzle-orm';
import { brickTypes, productionMaterials, productionModelMaterials } from '@/db/schema';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api';
import { roundMoney } from '@/lib/format';
import { addStockMovement } from '@/lib/stock';
import { createProduct } from '@/lib/products';
import {
  assertBrickTypeInStore,
  assertProductionEditable,
  getBrickType,
  listProductionMaterials,
  type ProductionMaterialRow,
} from '@/lib/brick';
import type { ProductionBranch } from '@/lib/branches-shared';

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function qty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/* ------------------------------------------------------------------ *
 * Nomenclature
 * ------------------------------------------------------------------ */

export type ModelMaterialRow = {
  id: number;
  modelId: number;
  productId: number;
  productName: string;
  unit: string;
  /** Quantité pour une unité du modèle. */
  quantity: number;
  notes: string | null;
  purchasePrice: number;
  /** Stock du produit dans le magasin du modèle. */
  availableStock: number;
  /** quantité × prix d'achat (coût matière estimé d'une unité). */
  amount: number;
};

export async function listModelMaterials(modelId: number): Promise<ModelMaterialRow[]> {
  const rows = await rawAll<any>(
    `SELECT b.id, b.model_id, b.product_id, b.quantity, b.notes,
            p.name AS product_name, p.unit AS product_unit, p.purchase_price,
            COALESCE((SELECT ps.quantity FROM product_stocks ps WHERE ps.product_id = b.product_id AND ps.store_id = bt.store_id), 0) AS stock
       FROM production_model_materials b
       INNER JOIN brick_types bt ON bt.id = b.model_id
       LEFT JOIN products p ON p.id = b.product_id
      WHERE b.model_id = ? AND b.deleted_at IS NULL
      ORDER BY p.name COLLATE NOCASE, b.id`,
    [modelId],
  );
  return rows.map((row) => {
    const quantity = num(row.quantity);
    const purchasePrice = num(row.purchase_price);
    return {
      id: num(row.id),
      modelId: num(row.model_id),
      productId: num(row.product_id),
      productName: String(row.product_name ?? 'Produit introuvable'),
      unit: String(row.product_unit ?? 'pièce'),
      quantity,
      notes: row.notes ?? null,
      purchasePrice,
      availableStock: num(row.stock),
      amount: roundMoney(quantity * purchasePrice),
    };
  });
}

export type ModelMaterialInput = { productId: number; quantity: number; notes?: string | null };

/**
 * Remplace la nomenclature d'un modèle de la filiale (magasin actif). Une ligne
 * existante garde son identité de synchronisation ; une ligne retirée est
 * marquée (`deleted_at`), puis réactivée si le produit revient.
 */
export async function setModelMaterials(
  modelId: number,
  lines: ModelMaterialInput[],
  storeId: number,
  branchId: number,
): Promise<ModelMaterialRow[]> {
  return withTransaction(async () => {
    const model = await assertBrickTypeInStore(modelId, storeId, branchId);
    const seen = new Set<number>();
    const cleaned: { productId: number; quantity: number; notes: string | null }[] = [];
    for (const line of Array.isArray(lines) ? lines : []) {
      const productId = num(line?.productId);
      const quantity = num(line?.quantity);
      if (!Number.isInteger(productId) || productId <= 0) throw new ValidationError('Chaque ligne de nomenclature doit désigner un produit');
      if (quantity <= 0) throw new ValidationError('La quantité d’une ligne de nomenclature doit être supérieure à zéro');
      if (productId === model.productId) throw new ValidationError('Un modèle ne peut pas entrer dans sa propre nomenclature.');
      if (seen.has(productId)) throw new ValidationError('Un même produit apparaît deux fois dans la nomenclature');
      seen.add(productId);
      const product = await rawGet<{ id: number }>('SELECT id FROM products WHERE id = ?', [productId]);
      if (!product) throw new NotFoundError('Produit introuvable dans la nomenclature');
      cleaned.push({ productId, quantity: qty(quantity), notes: String(line?.notes ?? '').trim().slice(0, 200) || null });
    }

    const existing = await rawAll<{ id: number; product_id: number; deleted_at: number | null }>(
      'SELECT id, product_id, deleted_at FROM production_model_materials WHERE model_id = ?',
      [modelId],
    );
    const byProduct = new Map(existing.map((r) => [num(r.product_id), r]));
    const now = new Date();
    for (const line of cleaned) {
      const previous = byProduct.get(line.productId);
      if (previous) {
        await db
          .update(productionModelMaterials)
          .set({ quantity: line.quantity, notes: line.notes, deletedAt: null, updatedAt: now })
          .where(eq(productionModelMaterials.id, num(previous.id)));
        byProduct.delete(line.productId);
      } else {
        await db.insert(productionModelMaterials).values({ modelId, ...line });
      }
    }
    for (const row of byProduct.values()) {
      if (row.deleted_at == null) {
        await db.update(productionModelMaterials).set({ deletedAt: now, updatedAt: now }).where(eq(productionModelMaterials.id, num(row.id)));
      }
    }
    return listModelMaterials(modelId);
  });
}

/* ------------------------------------------------------------------ *
 * Besoins d'une production
 * ------------------------------------------------------------------ */

export type MaterialRequirementLine = {
  productId: number;
  productName: string;
  unit: string;
  quantityPerUnit: number;
  requiredQuantity: number;
  consumedQuantity: number;
  toConsumeQuantity: number;
  availableStock: number;
  missingQuantity: number;
  purchasePrice: number;
  estimatedCost: number;
  isCovered: boolean;
};

export type MaterialRequirements = {
  quantity: number;
  lines: MaterialRequirementLine[];
  estimatedCost: number;
  isCovered: boolean;
};

function consumedByProduct(materials: ProductionMaterialRow[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const m of materials) {
    if (m.productId) map.set(m.productId, (map.get(m.productId) ?? 0) + m.quantity);
  }
  return map;
}

/** Besoins de la production : nomenclature × quantité prévue, sorties déjà faites déduites. */
export async function computeProductionRequirements(productionId: number): Promise<MaterialRequirements> {
  const production = await rawGet<{ brick_type_id: number; planned_quantity: number; produced_quantity: number }>(
    'SELECT brick_type_id, planned_quantity, produced_quantity FROM brick_productions WHERE id = ?',
    [productionId],
  );
  if (!production) throw new NotFoundError('Production introuvable');
  // Quantité prévue, sinon quantité produite (une production saisie après coup).
  const units = num(production.planned_quantity) > 0 ? num(production.planned_quantity) : num(production.produced_quantity);
  const bom = await listModelMaterials(num(production.brick_type_id));
  const consumed = consumedByProduct(await listProductionMaterials(productionId));
  const lines = bom.map((material) => {
    const requiredQuantity = qty(material.quantity * units);
    const consumedQuantity = qty(consumed.get(material.productId) ?? 0);
    const toConsumeQuantity = qty(Math.max(0, requiredQuantity - consumedQuantity));
    const missingQuantity = qty(Math.max(0, toConsumeQuantity - material.availableStock));
    return {
      productId: material.productId,
      productName: material.productName,
      unit: material.unit,
      quantityPerUnit: material.quantity,
      requiredQuantity,
      consumedQuantity,
      toConsumeQuantity,
      availableStock: material.availableStock,
      missingQuantity,
      purchasePrice: material.purchasePrice,
      estimatedCost: roundMoney(requiredQuantity * material.purchasePrice),
      isCovered: missingQuantity <= 0.0001,
    };
  });
  return {
    quantity: units,
    lines,
    estimatedCost: roundMoney(lines.reduce((sum, l) => sum + l.estimatedCost, 0)),
    isCovered: lines.every((l) => l.isCovered),
  };
}

/* ------------------------------------------------------------------ *
 * Sorties de matière
 * ------------------------------------------------------------------ */

export type MaterialInput = {
  productId: number;
  quantity: number;
  wastageQuantity?: number;
  unitCost?: number | null;
  userId?: number | null;
};

async function consumeInTx(
  production: { id: number; batchNumber: string; productId: number },
  input: MaterialInput,
  storeId: number,
  branch: ProductionBranch,
): Promise<ProductionMaterialRow> {
  const productId = num(input.productId);
  if (!Number.isInteger(productId) || productId <= 0) throw new ValidationError('Sélectionnez un produit');
  if (productId === production.productId) {
    throw new ValidationError('Le produit fabriqué ne peut pas être sa propre matière.');
  }
  const quantity = qty(num(input.quantity));
  const wastage = qty(Math.max(0, num(input.wastageQuantity)));
  if (quantity <= 0) throw new ValidationError('La quantité doit être supérieure à zéro');

  const product = await rawGet<{ id: number; name: string; unit: string; purchase_price: number | null }>(
    'SELECT id, name, unit, purchase_price FROM products WHERE id = ?',
    [productId],
  );
  if (!product) throw new NotFoundError('Produit introuvable');
  const unitCost = roundMoney(
    input.unitCost !== undefined && input.unitCost !== null && num(input.unitCost) > 0 ? num(input.unitCost) : num(product.purchase_price),
  );

  const [row] = await db
    .insert(productionMaterials)
    .values({
      productionId: production.id,
      productId,
      productName: product.name,
      unit: product.unit,
      quantity,
      wastageQuantity: wastage,
      unitCost,
      // Les chutes ont été achetées comme le reste : elles font partie du coût.
      amount: roundMoney((quantity + wastage) * unitCost),
      userId: input.userId ?? null,
    })
    .returning();

  // Dans la transaction : un stock insuffisant annule la ligne avec (aucun stock négatif).
  await addStockMovement(productId, 'exit', quantity, {
    storeId,
    referenceType: 'production_material',
    referenceId: production.id,
    motif: `matière production ${production.batchNumber} : ${product.name}`,
    userId: input.userId ?? null,
  });
  if (wastage > 0) {
    // Mouvement distinct : chutes et casse restent lisibles dans le journal de stock.
    await addStockMovement(productId, 'exit', wastage, {
      storeId,
      referenceType: 'production_material',
      referenceId: production.id,
      motif: `chutes (${branch.lossLabel.toLocaleLowerCase('fr')}) production ${production.batchNumber} : ${product.name}`,
      userId: input.userId ?? null,
    });
  }
  return (await listProductionMaterials(production.id)).find((m) => m.id === row.id)!;
}

async function editableForMaterials(productionId: number, storeId: number, branch: ProductionBranch) {
  const production = await assertProductionEditable(productionId, storeId, branch.id);
  if (production.status === 'finished') {
    throw new ConflictError('Cette production est terminée (en stock) : ses matières ne se modifient plus.');
  }
  return production;
}

export async function addProductionMaterial(
  productionId: number,
  input: MaterialInput,
  storeId: number,
  branch: ProductionBranch,
): Promise<ProductionMaterialRow> {
  return withTransaction(async () => {
    const production = await editableForMaterials(productionId, storeId, branch);
    return consumeInTx(production, input, storeId, branch);
  });
}

/** Sort **tout** le reste prévu par la nomenclature, ou rien (stock insuffisant). */
export async function consumePlannedMaterials(
  productionId: number,
  storeId: number,
  branch: ProductionBranch,
  userId?: number | null,
): Promise<ProductionMaterialRow[]> {
  return withTransaction(async () => {
    const production = await editableForMaterials(productionId, storeId, branch);
    const requirements = await computeProductionRequirements(productionId);
    if (requirements.lines.length === 0) {
      throw new ValidationError('Ce modèle n’a pas de nomenclature : ajoutez ses matières une à une, ou complétez le modèle.');
    }
    const toConsume = requirements.lines.filter((line) => line.toConsumeQuantity > 0);
    if (toConsume.length === 0) throw new ValidationError('Toutes les matières prévues sont déjà sorties du stock.');
    const missing = toConsume.filter((line) => !line.isCovered);
    if (missing.length > 0) {
      throw new ValidationError(
        `Stock insuffisant dans ce magasin : ${missing
          .map((line) => `${line.productName} (manque ${String(line.missingQuantity).replace('.', ',')} ${line.unit})`)
          .join(', ')}. Rien n’a été sorti.`,
      );
    }
    const added: ProductionMaterialRow[] = [];
    for (const line of toConsume) {
      added.push(await consumeInTx(production, { productId: line.productId, quantity: line.toConsumeQuantity, userId }, storeId, branch));
    }
    return added;
  });
}

/** Retire une matière : retour au stock **avec ses chutes**, ligne marquée retirée. */
export async function removeProductionMaterial(
  productionId: number,
  materialId: number,
  storeId: number,
  branch: ProductionBranch,
  userId?: number | null,
): Promise<ProductionMaterialRow> {
  return withTransaction(async () => {
    const production = await editableForMaterials(productionId, storeId, branch);
    const line = (await listProductionMaterials(productionId)).find((m) => m.id === materialId);
    if (!line) throw new NotFoundError('Ligne de matière introuvable sur cette production');
    await db
      .update(productionMaterials)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(productionMaterials.id, materialId), isNull(productionMaterials.deletedAt)));
    const back = qty(line.quantity + line.wastageQuantity);
    if (line.productId && back > 0) {
      await addStockMovement(line.productId, 'entry', back, {
        storeId,
        referenceType: 'production_material',
        referenceId: productionId,
        motif: `retour matière production ${production.batchNumber} : ${line.productName}`,
        userId: userId ?? null,
      });
    }
    return line;
  });
}

/* ------------------------------------------------------------------ *
 * Reprise des modèles de l'ancien atelier (filiale Meuble)
 * ------------------------------------------------------------------ */

export type FurnitureImportCandidate = {
  furnitureModelId: number;
  code: string;
  name: string;
  salePrice: number;
  materialsCount: number;
  /** Modèle de filiale déjà créé depuis ce modèle (import déjà fait). */
  importedModelId: number | null;
};

export async function listFurnitureImportCandidates(storeId: number, branchId: number): Promise<FurnitureImportCandidate[]> {
  const rows = await rawAll<any>(
    `SELECT fm.id, fm.code, fm.name, fm.sale_price,
            (SELECT COUNT(*) FROM furniture_model_materials b WHERE b.model_id = fm.id) AS materials_count,
            (SELECT bt.id FROM brick_types bt WHERE bt.furniture_model_id = fm.id AND bt.branch_id = ? LIMIT 1) AS imported_id
       FROM furniture_models fm
      WHERE fm.store_id = ? AND fm.is_active = 1
      ORDER BY fm.code`,
    [branchId, storeId],
  );
  return rows.map((r) => ({
    furnitureModelId: num(r.id),
    code: r.code,
    name: r.name,
    salePrice: num(r.sale_price),
    materialsCount: num(r.materials_count),
    importedModelId: r.imported_id == null ? null : num(r.imported_id),
  }));
}

/**
 * Crée, pour chaque modèle actif de l'atelier du magasin actif non encore repris,
 * un modèle de la filiale : produit lié (repris s'il porte déjà ce nom et n'est
 * lié à aucun modèle), prix conseillé, description et nomenclature.
 */
export async function importFurnitureModels(
  branch: ProductionBranch,
  storeId: number,
  userId: number | null,
): Promise<{ imported: number; skipped: number }> {
  if (branch.activity !== 'furniture') {
    throw new ValidationError('Seule une filiale d’activité « Meubles » reprend les modèles de l’ancien atelier.');
  }
  return withTransaction(async () => {
    const candidates = (await listFurnitureImportCandidates(storeId, branch.id)).filter((c) => c.importedModelId == null);
    let imported = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const model = await rawGet<any>('SELECT * FROM furniture_models WHERE id = ?', [candidate.furnitureModelId]);
      if (!model) continue;
      let product = await rawGet<{ id: number }>('SELECT id FROM products WHERE name = ? COLLATE NOCASE LIMIT 1', [model.name]);
      if (product) {
        const linked = await rawGet<{ id: number }>(
          'SELECT id FROM brick_types WHERE product_id = ? AND store_id = ? AND is_active = 1 LIMIT 1',
          [product.id, storeId],
        );
        if (linked) {
          skipped++;
          continue;
        }
      } else {
        const created = await createProduct(
          { name: model.name, unit: 'pièce', salePrice: num(model.sale_price), purchasePrice: 0, description: model.description ?? null },
          { userId, storeId, ownerStoreId: storeId },
        );
        product = { id: created.id };
      }
      const [type] = await db
        .insert(brickTypes)
        .values({
          storeId,
          branchId: branch.id,
          productId: num(product.id),
          name: model.name,
          shape: 'solid',
          dimensions: model.standard_dimensions ?? null,
          description: model.description ?? null,
          category: 'Meuble',
          furnitureModelId: num(model.id),
          userId,
        })
        .returning({ id: brickTypes.id });
      const bom = await rawAll<{ product_id: number; quantity: number; notes: string | null }>(
        'SELECT product_id, quantity, notes FROM furniture_model_materials WHERE model_id = ?',
        [model.id],
      );
      for (const line of bom) {
        if (num(line.quantity) <= 0) continue;
        await db.insert(productionModelMaterials).values({
          modelId: type.id,
          productId: num(line.product_id),
          quantity: num(line.quantity),
          notes: line.notes ?? null,
        });
      }
      imported++;
    }
    return { imported, skipped };
  });
}

/** Modèle + nomenclature (fiche du modèle). */
export async function getModelWithMaterials(modelId: number) {
  const model = await getBrickType(modelId);
  if (!model) return null;
  return { model, materials: await listModelMaterials(modelId) };
}
