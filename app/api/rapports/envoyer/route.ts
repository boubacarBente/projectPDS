import { NextRequest } from 'next/server';
import {
  ValidationError,
  businessDate,
  fail,
  ok,
  readJson,
  requireAction,
} from '@/lib/api';
import { can } from '@/lib/permissions';
import { resolvePeriod } from '@/lib/dashboard';
import { getSettings } from '@/lib/settings';
import { sendReport } from '@/lib/report-sender';
import { today } from '@/lib/format';
import type {
  RapportDeliveryChannel,
  RapportPeriodKey,
  RapportSendRequest,
} from '@/lib/rapports-types';

/**
 * POST /api/rapports/envoyer (README §16.2, §16.3, §27.2).
 *
 * Corps : `{ period?, from?, to?, channel?, recipients?, test? }`.
 * Permission **`reports.view`**. Réponse :
 * `{ delivery, message, shareUrl, requiresManualSend, mode, error, forcedPeriod }`.
 *
 * ⚠️ **Déjà appelée par `app/parametres/page.tsx`** (bouton « Envoyer un
 * rapport de test ») avec `{ period: 'day', test: true }` : dans ce cas la route
 * répond **200 avec `{ message }`**, même sans destinataire configuré — le mode
 * manuel est le mode par défaut et il n'a besoin d'aucun destinataire pour
 * préparer le message.
 *
 * ── Deux décisions à connaître ────────────────────────────────────────────
 *
 * 1. **Un rapport de test n'est pas un envoi.** `test: true` prépare le message
 *    via le même gabarit que l'envoi réel mais **n'écrit aucune ligne** dans
 *    `report_deliveries` : l'historique ne doit contenir que de vrais envois.
 *    Si une passerelle est configurée, la tentative réelle a bien lieu (c'est
 *    l'objet du test) et son échec éventuel est renvoyé dans `error`.
 *
 * 2. **Restriction de période pour un vendeur.** Sans `reports.viewAll` (rôle
 *    `seller`), la période est **ramenée à aujourd'hui** et `forcedPeriod: true`
 *    le signale dans la réponse. On ne refuse pas ici, contrairement à
 *    `GET /api/rapports` : un rapport quotidien est l'usage normal d'un
 *    vendeur, et l'envoi programmé ne doit jamais échouer à cause d'un rôle.
 *    `GET` refuse parce qu'il sert à *explorer* une période ; `POST` force parce
 *    qu'il sert à *envoyer le rapport du jour*.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireAction('reports.view');
    const body = await readJson<RapportSendRequest>(request);
    const settings = await getSettings();

    const requestedPeriod = body.period;
    const period: RapportPeriodKey =
      requestedPeriod === 'week' || requestedPeriod === 'month' || requestedPeriod === 'day'
        ? requestedPeriod
        : 'day';

    const reference = today();

    /* ------------------------------- Bornes -------------------------------- */
    let from: string;
    let to: string;

    if (body.from || body.to) {
      from = businessDate(body.from, 'date de début', reference);
      to = businessDate(body.to, 'date de fin', from);

      if (from > to) {
        throw new ValidationError('La date de début doit précéder la date de fin');
      }
    } else {
      const bounds = resolvePeriod(period, reference);
      from = bounds.from;
      to = bounds.to;
    }

    /* ------------------- Restriction de période (vendeur) ------------------ */
    let forcedPeriod = false;
    if (!can(user, 'reports.viewAll') && (from !== reference || to !== reference)) {
      from = reference;
      to = reference;
      forcedPeriod = true;
    }

    /* ----------------------------- Destinataires --------------------------- */
    const configuredRecipients = Array.isArray(settings.reportRecipients)
      ? settings.reportRecipients
      : [];

    const recipients = (Array.isArray(body.recipients) ? body.recipients : configuredRecipients)
      .map((value) => String(value).trim())
      .filter(Boolean);

    const requestedChannel = body.channel;
    const channel: RapportDeliveryChannel =
      requestedChannel === 'sms' || requestedChannel === 'whatsapp'
        ? requestedChannel
        : settings.reportChannels?.includes('sms')
          ? 'sms'
          : 'whatsapp';

    /* ------------------------------ Envoi ---------------------------------- */
    const isTest = body.test === true;

    const result = await sendReport({
      period,
      from,
      to,
      channel,
      recipients,
      userId: user.id,
      userName: user.name,
      triggeredBy: 'manual',
      // Un test ne laisse aucune trace dans l'historique : ce n'est pas un envoi.
      record: !isTest,
    });

    return ok({
      delivery: result.delivery,
      message: result.message,
      shareUrl: result.shareUrl,
      requiresManualSend: result.requiresManualSend,
      mode: isTest ? ('test' as const) : result.mode,
      error: result.error,
      forcedPeriod,
    });
  } catch (error) {
    return fail(error);
  }
}
