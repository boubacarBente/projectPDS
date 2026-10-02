'use client';

/**
 * Briques partagées des écrans Inventaires.
 *
 * Libellés recopiés de `lib/inventories.ts` (module serveur : `import type`
 * uniquement côté client — AGENTS.md, invariant 6).
 */

import { Badge, type BadgeTone } from '@/components/design-system';
import type { InventoryItemRow, InventoryRow, InventoryStatus } from '@/lib/inventories';

/** Dates sérialisées en chaînes ISO par `NextResponse.json`. */
export type InventoryRecord = Omit<InventoryRow, 'validatedAt' | 'createdAt'> & {
  validatedAt: string | null;
  createdAt: string | null;
};
export type InventoryDetailRecord = {
  inventory: InventoryRecord;
  items: InventoryItemRow[];
  actions: ('count' | 'validate' | 'cancel')[];
};
export type { InventoryItemRow, InventoryStatus };

export const INVENTORY_STATUS: Record<InventoryStatus, { label: string; tone: BadgeTone }> = {
  open: { label: 'Comptage en cours', tone: 'warning' },
  validated: { label: 'Validé', tone: 'success' },
  cancelled: { label: 'Annulé', tone: 'neutral' },
};

export function InventoryStatusBadge({ status }: { status: InventoryStatus }) {
  const entry = INVENTORY_STATUS[status] ?? INVENTORY_STATUS.open;
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

export async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const message = (payload as { error?: unknown }).error;
      if (typeof message === 'string' && message.trim()) return message;
    }
  } catch {
    /* corps illisible */
  }
  return fallback;
}
