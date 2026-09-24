/**
 * Génération du message et envoi d'un rapport (README §11, §16.2, §16.3).
 *
 * Deux modes, et le mode par défaut est le **mode manuel** (Q9, README §16.3) :
 *
 * | Mode | Ce qui se passe | Hors ligne |
 * |---|---|---|
 * | **Manuel** (`reportFrequency = 'manual'`, passerelle absente, ou aucun destinataire) | le message est construit, la livraison est enregistrée, et une URL `wa.me` / `sms:` pré-remplie est renvoyée : l'interface l'ouvre, l'utilisateur appuie sur « envoyer » | ✅ oui |
 * | **Automatique** | `fetch` vers la passerelle configurée dans `settings.reportProviderConfig` | ❌ non (mais l'échec **ne lève jamais**) |
 *
 * ⚠️ Règle de vérité : `status` reflète ce qui s'est réellement passé. Un échec
 * de la passerelle est enregistré `failed` avec son `error` conservé, et la
 * fonction **ne lève pas** — l'application doit rester utilisable hors ligne
 * (§16.3). Inversement, une livraison n'est jamais enregistrée `sent` quand
 * aucun envoi n'a été tenté… sauf en mode manuel, où la ligne décrit la remise
 * du message à l'application de messagerie de l'utilisateur (le seul mode qui
 * fonctionne sans Internet), et où la réponse porte
 * `requiresManualSend: true` pour que l'interface dise « message préparé » et
 * non « rapport envoyé ».
 *
 * ⚠️ Module **serveur** : il ne doit jamais être importé à l'exécution par un
 * composant client (CONVENTIONS §11 bis).
 */

import { db, rawAll, rawGet } from '@/db';
import { reportDeliveries } from '@/db/schema';
import { getSettings, type Settings } from '@/lib/settings';
import { getRapportData } from '@/lib/rapports';
import { writeAudit } from '@/lib/audit';
import { enqueueSyncWrite } from '@/lib/sync';
import { formatCurrency, formatNumber } from '@/lib/format';
import { formatDateShort } from '@/lib/date-format';
import type {
  RapportData,
  RapportDeliveryChannel,
  RapportDeliveryRow,
  RapportDeliveryStatus,
  RapportDeliveryTrigger,
  RapportPeriodKey,
} from '@/lib/rapports-types';

/* ------------------------------------------------------------------ *
 * Message texte (WhatsApp / SMS)
 * ------------------------------------------------------------------ */

/**
 * Message **court** et lisible sur un téléphone : des retours à la ligne et des
 * `•`, jamais de tableau markdown (illisible en SMS, tronqué sur WhatsApp).
 *
 * Contenu imposé par le README §16.2 : nom de l'entreprise, période, ventes,
 * CA, bénéfice, caisse, clients débiteurs, dettes fournisseurs, alertes de stock.
 */
export function buildReportMessage(data: RapportData, settings: Settings): string {
  const currency = settings.currency || 'GNF';
  const money = (value: number) => formatCurrency(value, currency);
  const lines: string[] = [];

  lines.push(`*${settings.companyName || 'Planète Déco'}*`);
  if (settings.companyBranch) lines.push(settings.companyBranch);
  lines.push(`Rapport ${data.period.label}`);
  lines.push(
    `Période : ${formatDateShort(data.period.from)} → ${formatDateShort(data.period.to)}`,
  );
  lines.push('');

  lines.push(
    `• Ventes : ${formatNumber(data.summary.salesCount)} — panier moyen ${money(
      data.summary.averageBasket,
    )}`,
  );
  lines.push(`• Chiffre d'affaires : ${money(data.summary.revenueTtc)}`);
  lines.push(`• Encaissé : ${money(data.summary.collected)}`);
  lines.push(`• Reste à encaisser (période) : ${money(data.summary.outstanding)}`);
  lines.push(`• Dépenses : ${money(data.summary.expenses)}`);
  lines.push(`• Bénéfice net : ${money(data.summary.netProfit)}`);
  lines.push(`• Caisse : ${money(data.summary.cash.balance)}`);

  lines.push(
    `• Clients débiteurs : ${formatNumber(data.receivables.debtorsCount)} — ${money(
      data.receivables.total,
    )}`,
  );
  lines.push(
    `• Dettes fournisseurs : ${formatNumber(data.payables.creditorsCount)} — ${money(
      data.payables.total,
    )}`,
  );

  const alerts = data.stockInsights;
  if (alerts.outOfStockCount > 0 || alerts.lowStockCount > 0) {
    lines.push('');
    lines.push('Alertes de stock :');
    if (alerts.outOfStockCount > 0) {
      const names = alerts.outOfStock.slice(0, 3).map((item) => item.name).join(', ');
      lines.push(
        `• ${formatNumber(alerts.outOfStockCount)} rupture${
          alerts.outOfStockCount > 1 ? 's' : ''
        } : ${names}${alerts.outOfStockCount > 3 ? '…' : ''}`,
      );
    }
    if (alerts.lowStockCount > 0) {
      const names = alerts.alerts.slice(0, 3).map((item) => item.name).join(', ');
      lines.push(
        `• ${formatNumber(alerts.lowStockCount)} seuil${
          alerts.lowStockCount > 1 ? 's' : ''
        } d'alerte atteint${alerts.lowStockCount > 1 ? 's' : ''} : ${names}${
          alerts.lowStockCount > 3 ? '…' : ''
        }`,
      );
    }
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Configuration de la passerelle
 * ------------------------------------------------------------------ */

type ReportProviderConfig = {
  /** Passerelle HTTP générique (SMS ou webhook) : URL d'appel. */
  url?: string;
  /** Jeton d'authentification (en-tête `Authorization: Bearer …`). */
  token?: string;
  /** Expéditeur affiché, pour une passerelle SMS. */
  from?: string;
  sender?: string;
  /** WhatsApp Cloud API (Meta) : identifiant du numéro émetteur. */
  phoneNumberId?: string;
  /** `whatsapp-cloud` | `webhook` | libre. */
  provider?: string;
};

/**
 * Lit `settings.reportProviderConfig` (chaîne JSON, §9.2).
 *
 * Retourne `null` — donc **mode manuel** — dès que la configuration n'est pas
 * exploitable : chaîne vide, JSON invalide, ou JSON sans URL ni couple
 * `phoneNumberId` + `token`. C'est volontaire : une configuration à moitié
 * saisie ne doit pas faire échouer un envoi, elle doit laisser l'application
 * fonctionner hors ligne (§16.3).
 */
function parseProviderConfig(raw: string | null | undefined): ReportProviderConfig | null {
  if (!raw || !raw.trim()) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const config = parsed as ReportProviderConfig;
    const hasWebhook = typeof config.url === 'string' && config.url.trim().length > 0;
    const hasCloudApi =
      typeof config.phoneNumberId === 'string' &&
      config.phoneNumberId.trim().length > 0 &&
      typeof config.token === 'string' &&
      config.token.trim().length > 0;

    return hasWebhook || hasCloudApi ? config : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * URL de partage (mode manuel)
 * ------------------------------------------------------------------ */

/** Ne conserve qu'un numéro exploitable : `+224 620 00 00 00` → `+224620000000`. */
function normalizePhone(value: string): string {
  const trimmed = String(value ?? '').trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `${plus}${digits}` : '';
}

/**
 * URL pré-remplie ouverte par l'interface.
 *
 * ⚠️ WhatsApp n'accepte **qu'un seul numéro** dans un lien `wa.me` : on utilise
 * donc le premier destinataire exploitable, et l'intégralité de la liste reste
 * enregistrée dans `report_deliveries` (c'est elle qui fait foi dans
 * l'historique). Sans destinataire, `wa.me/?text=…` ouvre WhatsApp sur le
 * sélecteur de contact — l'application ne choisit pas à la place de l'utilisateur.
 */
export function buildShareUrl(
  channel: RapportDeliveryChannel,
  recipients: string[],
  message: string,
): string {
  const text = encodeURIComponent(message);
  const numbers = recipients.map(normalizePhone).filter(Boolean);

  if (channel === 'sms') {
    const targets = numbers.join(',');
    return `sms:${targets}?body=${text}`;
  }

  const first = numbers[0];
  return first ? `https://wa.me/${first.replace('+', '')}?text=${text}` : `https://wa.me/?text=${text}`;
}

/* ------------------------------------------------------------------ *
 * Envoi automatique
 * ------------------------------------------------------------------ */

/** Délai maximal d'une tentative vers la passerelle : au-delà, on n'attend plus. */
const GATEWAY_TIMEOUT_MS = 12_000;

/**
 * Tente l'envoi vers la passerelle configurée.
 *
 * **Ne lève jamais** : toute erreur (pas d'Internet, DNS, jeton refusé, délai
 * dépassé) revient sous forme de `{ ok: false, error }` pour être **conservée**
 * dans `report_deliveries.error`. C'est la condition pour que l'application
 * reste utilisable hors ligne (§16.3, §23 : la synchronisation ne bloque jamais
 * une opération métier ; un rapport non plus).
 */
async function deliverAutomatically(
  config: ReportProviderConfig,
  channel: RapportDeliveryChannel,
  recipients: string[],
  message: string,
): Promise<{ ok: boolean; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

  try {
    const useCloudApi = !config.url && Boolean(config.phoneNumberId);

    const url = useCloudApi
      ? `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`
      : String(config.url);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;

    const payload = useCloudApi
      ? {
          messaging_product: 'whatsapp',
          to: normalizePhone(recipients[0] ?? '').replace('+', ''),
          type: 'text',
          text: { body: message },
        }
      : {
          channel,
          from: config.from ?? config.sender ?? '',
          to: recipients,
          message,
        };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        error: `Passerelle ${response.status} ${response.statusText}${
          detail ? ` — ${detail.slice(0, 300)}` : ''
        }`.trim(),
      };
    }

    return { ok: true, error: null };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: `Délai dépassé (${GATEWAY_TIMEOUT_MS / 1000} s) : passerelle injoignable` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Enregistrement d'une livraison
 * ------------------------------------------------------------------ */

function splitRecipients(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function recordDelivery(input: {
  period: RapportPeriodKey;
  from: string;
  to: string;
  channel: RapportDeliveryChannel;
  recipients: string[];
  content: string;
  status: RapportDeliveryStatus;
  error: string | null;
  triggeredBy: RapportDeliveryTrigger;
  userId: number | null;
  userName: string | null;
}): Promise<RapportDeliveryRow> {
  const sentAt = new Date();

  const inserted = await db
    .insert(reportDeliveries)
    .values({
      period: input.period,
      fromDate: input.from,
      toDate: input.to,
      channel: input.channel,
      recipients: input.recipients.join(','),
      content: input.content,
      status: input.status,
      error: input.error,
      triggeredBy: input.triggeredBy,
      userId: input.userId,
      sentAt,
    })
    .returning({ id: reportDeliveries.id, syncId: reportDeliveries.syncId });

  const id = inserted[0]?.id ?? 0;

  await enqueueSyncWrite('report_deliveries', inserted[0]?.syncId, 'insert', {
    period: input.period,
    from_date: input.from,
    to_date: input.to,
    channel: input.channel,
    recipients: input.recipients.join(','),
    content: input.content,
    status: input.status,
    error: input.error,
    triggered_by: input.triggeredBy,
    user_id: input.userId,
    sent_at: sentAt.toISOString(),
  });

  return {
    id,
    period: input.period,
    fromDate: input.from,
    toDate: input.to,
    channel: input.channel,
    recipients: input.recipients,
    content: input.content,
    status: input.status,
    error: input.error,
    triggeredBy: input.triggeredBy,
    userId: input.userId,
    userName: input.userName,
    sentAt: sentAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Envoi
 * ------------------------------------------------------------------ */

export type SendReportOptions = {
  period: RapportPeriodKey;
  /** Date métier `YYYY-MM-DD`. */
  from: string;
  /** Date métier `YYYY-MM-DD`. */
  to: string;
  channel: RapportDeliveryChannel;
  recipients: string[];
  userId: number | null;
  userName?: string | null;
  triggeredBy: RapportDeliveryTrigger;
  /**
   * `false` : prépare le message **sans rien enregistrer** (bouton « rapport de
   * test », aperçu). Aucune ligne n'est écrite : un test n'est pas un envoi.
   */
  record?: boolean;
};

/**
 * Prépare puis envoie (ou fait préparer) le rapport d'une période.
 *
 * Écrit **toujours** une ligne dans `report_deliveries` quand `record` n'est pas
 * `false` — succès **ou** échec — puis journalise l'action (`writeAudit`).
 */
export async function sendReport(options: SendReportOptions): Promise<{
  delivery: RapportDeliveryRow | null;
  message: string;
  shareUrl: string | null;
  requiresManualSend: boolean;
  mode: 'manual' | 'automatic';
  /** Raison de l'échec automatique, même quand la ligne n'est pas enregistrée. */
  error: string | null;
}> {
  const settings = await getSettings();
  const data = await getRapportData({ from: options.from, to: options.to });
  const message = buildReportMessage(data, settings);

  const recipients = options.recipients.map((value) => String(value).trim()).filter(Boolean);
  const config = parseProviderConfig(settings.reportProviderConfig);

  // Mode manuel : paramétré comme tel, passerelle inexploitable, ou rien à qui
  // envoyer. C'est le mode par défaut recommandé (Q9) et le seul hors ligne.
  const requiresManualSend =
    settings.reportFrequency === 'manual' || !config || recipients.length === 0;

  if (requiresManualSend) {
    const shareUrl = buildShareUrl(options.channel, recipients, message);

    const delivery =
      options.record === false
        ? null
        : await recordDelivery({
            period: options.period,
            from: options.from,
            to: options.to,
            channel: options.channel,
            recipients,
            content: message,
            // La ligne décrit la remise du message à l'application de
            // messagerie : l'application ne peut pas observer l'appui final de
            // l'utilisateur, et `requiresManualSend` le dit à l'interface.
            status: 'sent',
            error: null,
            triggeredBy: options.triggeredBy,
            userId: options.userId,
            userName: options.userName ?? null,
          });

    if (delivery) {
      await writeAudit({
        user: options.userId ? { id: options.userId, name: options.userName ?? 'Utilisateur' } : null,
        action: 'create',
        entity: 'report_deliveries',
        entityId: delivery.id,
        details: {
          mode: 'manual',
          period: options.period,
          from: options.from,
          to: options.to,
          channel: options.channel,
          recipients,
          triggeredBy: options.triggeredBy,
        },
      });
    }

    return { delivery, message, shareUrl, requiresManualSend: true, mode: 'manual', error: null };
  }

  // Mode automatique : la passerelle est configurée. Un échec est enregistré,
  // jamais levé (§16.3).
  const result = await deliverAutomatically(config as ReportProviderConfig, options.channel, recipients, message);

  const delivery =
    options.record === false
      ? null
      : await recordDelivery({
          period: options.period,
          from: options.from,
          to: options.to,
          channel: options.channel,
          recipients,
          content: message,
          status: result.ok ? 'sent' : 'failed',
          error: result.error,
          triggeredBy: options.triggeredBy,
          userId: options.userId,
          userName: options.userName ?? null,
        });

  if (delivery) {
    await writeAudit({
      user: options.userId ? { id: options.userId, name: options.userName ?? 'Utilisateur' } : null,
      action: 'create',
      entity: 'report_deliveries',
      entityId: delivery.id,
      details: {
        mode: 'automatic',
        period: options.period,
        from: options.from,
        to: options.to,
        channel: options.channel,
        recipients,
        status: delivery.status,
        error: delivery.error,
        triggeredBy: options.triggeredBy,
      },
    });
  }

  return {
    delivery,
    message,
    shareUrl: null,
    requiresManualSend: false,
    mode: 'automatic',
    error: result.error,
  };
}

/* ------------------------------------------------------------------ *
 * Historique des envois (§16.2 : « Historique des rapports envoyés »)
 * ------------------------------------------------------------------ */

export type ReportDeliveriesQuery = {
  period?: string;
  channel?: string;
  status?: string;
  /** Filtre sur la date de début du rapport. */
  from?: string;
  /** Filtre sur la date de fin du rapport. */
  to?: string;
  page?: number;
  limit?: number;
};

export type ReportDeliveriesResult = {
  data: RapportDeliveryRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

function mapDeliveryRow(row: any): RapportDeliveryRow {
  return {
    id: Number(row.id),
    period: (row.period ?? 'day') as RapportPeriodKey,
    fromDate: row.from_date,
    toDate: row.to_date,
    channel: (row.channel ?? 'whatsapp') as RapportDeliveryChannel,
    recipients: splitRecipients(row.recipients),
    content: row.content ?? '',
    status: (row.status ?? 'sent') as RapportDeliveryStatus,
    error: row.error ?? null,
    triggeredBy: (row.triggered_by ?? 'manual') as RapportDeliveryTrigger,
    userId: row.user_id == null ? null : Number(row.user_id),
    userName: row.user_name ?? null,
    // `sent_at` est stocké en **secondes** Unix (mode `timestamp` de Drizzle).
    sentAt: row.sent_at ? new Date(Number(row.sent_at) * 1000).toISOString() : null,
  };
}

/** Historique paginé des livraisons, avec le nom de l'utilisateur déclencheur. */
export async function listReportDeliveries(
  options: ReportDeliveriesQuery = {},
): Promise<ReportDeliveriesResult> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: (string | number)[] = [];

  if (options.period) {
    where.push('d.period = ?');
    args.push(options.period);
  }
  if (options.channel) {
    where.push('d.channel = ?');
    args.push(options.channel);
  }
  if (options.status) {
    where.push('d.status = ?');
    args.push(options.status);
  }
  if (options.from) {
    where.push('d.from_date >= ?');
    args.push(options.from);
  }
  if (options.to) {
    where.push('d.to_date <= ?');
    args.push(options.to);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, countRow] = await Promise.all([
    rawAll<any>(
      `SELECT d.id, d.period, d.from_date, d.to_date, d.channel, d.recipients, d.content,
              d.status, d.error, d.triggered_by, d.user_id, d.sent_at,
              u.name AS user_name
       FROM report_deliveries d
       LEFT JOIN users u ON u.id = d.user_id
       ${whereSql}
       ORDER BY d.sent_at DESC, d.id DESC
       LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    ),
    rawGet<{ total: number }>(
      `SELECT COUNT(*) AS total FROM report_deliveries d ${whereSql}`,
      args,
    ),
  ]);

  const total = Number(countRow?.total ?? 0);

  return {
    data: rows.map(mapDeliveryRow),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}
