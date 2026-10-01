/**
 * Journal des actions importantes (§12 « historique des actions », §14
 * « historique des opérations »).
 *
 * Règle : toute écriture sensible appelle `writeAudit`. La journalisation ne
 * doit **jamais** faire échouer l'opération métier — elle est donc
 * entièrement encapsulée dans un try/catch.
 */

import { db } from '@/db';
import { auditLogs, stores } from '@/db/schema';
import { desc, and, eq, gte, lte, sql, inArray, or, isNull, type SQL } from 'drizzle-orm';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  type AuditAction,
} from '@/lib/audit-labels';

/**
 * Les libellés et le type d'action vivent dans `lib/audit-labels.ts`, un module
 * **sans dépendance serveur** : `app/utilisateurs/historique/page.tsx` est un
 * composant client et doit pouvoir les importer sans entraîner `@libsql/client`
 * ni `fs` dans le bundle navigateur. On les ré-exporte ici pour que le serveur
 * conserve un point d'entrée unique.
 */
export { AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS, auditActionLabel, auditEntityLabel } from '@/lib/audit-labels';
export type { AuditAction } from '@/lib/audit-labels';

export type AuditInput = {
  /** L'utilisateur de session porte aussi son magasin actif (`storeId`). */
  user?: { id: number; name: string; storeId?: number | null } | null;
  /** Magasin concerné ; par défaut le magasin actif de l'utilisateur. */
  storeId?: number | null;
  action: AuditAction;
  entity: string;
  entityId?: number | null;
  details?: Record<string, unknown> | string | null;
};

export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    const details =
      input.details == null
        ? null
        : typeof input.details === 'string'
          ? input.details
          : JSON.stringify(input.details);

    await db.insert(auditLogs).values({
      userId: input.user?.id ?? null,
      userName: input.user?.name ?? 'Système',
      storeId: input.storeId !== undefined ? input.storeId : (input.user?.storeId ?? null),
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      details,
    });
  } catch (error) {
    console.error('[audit] Écriture impossible (opération métier préservée) :', error);
  }
}

export type AuditListEntry = {
  id: number;
  storeId: number | null;
  storeName: string | null;
  userId: number | null;
  userName: string;
  action: string;
  entity: string;
  entityId: number | null;
  details: string | null;
  createdAt: Date | null;
};

export async function listAuditLogs(options: {
  page?: number;
  limit?: number;
  userId?: number;
  action?: string;
  entity?: string;
  /** Restreint à un document précis (historique d'une fiche). */
  entityId?: number;
  from?: string;
  to?: string;
  search?: string;
  /**
   * Magasins visibles. `includeCentral` ajoute les actions sans magasin
   * (connexions, comptes, paramètres) — réservé à l'administration centrale.
   */
  storeIds?: number[];
  includeCentral?: boolean;
}): Promise<{ data: AuditListEntry[]; total: number; page: number; limit: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];
  if (options.userId) conditions.push(eq(auditLogs.userId, options.userId));
  if (options.action) conditions.push(eq(auditLogs.action, options.action));
  if (options.entity) conditions.push(eq(auditLogs.entity, options.entity));
  if (options.entityId) conditions.push(eq(auditLogs.entityId, options.entityId));
  if (options.from) conditions.push(gte(auditLogs.createdAt, new Date(`${options.from}T00:00:00`)));
  if (options.to) conditions.push(lte(auditLogs.createdAt, new Date(`${options.to}T23:59:59`)));
  if (options.search) {
    conditions.push(
      sql`(${auditLogs.userName} LIKE ${`%${options.search}%`} OR ${auditLogs.entity} LIKE ${`%${options.search}%`} OR ${auditLogs.details} LIKE ${`%${options.search}%`})`,
    );
  }
  if (options.storeIds) {
    const ids = options.storeIds.filter((id) => Number.isInteger(id) && id > 0);
    const storeCondition = ids.length > 0 ? inArray(auditLogs.storeId, ids) : sql`0 = 1`;
    conditions.push(
      options.includeCentral ? (or(storeCondition, isNull(auditLogs.storeId)) as SQL) : storeCondition,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalResult] = await Promise.all([
    db
      .select({ log: auditLogs, storeName: stores.name })
      .from(auditLogs)
      .leftJoin(stores, eq(stores.id, auditLogs.storeId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)` }).from(auditLogs).where(where),
  ]);

  const total = Number(totalResult[0]?.count ?? 0);

  return {
    data: rows.map(({ log: r, storeName }) => ({
      id: r.id,
      storeId: r.storeId ?? null,
      storeName: storeName ?? null,
      userId: r.userId,
      userName: r.userName,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      details: r.details,
      createdAt: r.createdAt,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}
