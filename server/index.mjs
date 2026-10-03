/**
 * Serveur central de synchronisation — Planète Déco (option B).
 *
 * Rôle : recevoir les opérations de chaque poste (siège et magasins), les
 * conserver dans PostgreSQL, et redistribuer à chaque poste ce qui le concerne.
 * Les postes continuent de travailler hors ligne ; ils se synchronisent dès
 * qu'Internet revient.
 *
 * Sécurité :
 *  - chaque poste s'authentifie par un **jeton** (seul son SHA-256 est stocké) ;
 *  - un poste de magasin ne reçoit que les référentiels communs, les données de
 *    **son** magasin et les transferts qui le concernent ;
 *  - un poste de magasin ne peut **pas** écrire les données d'un autre magasin,
 *    ni les référentiels centraux (catalogue, comptes, paramètres, magasins) ;
 *  - l'inscription d'un poste exige la clé maîtresse (siège) ou un code à usage
 *    unique généré par le siège (magasin), valable 7 jours ;
 *  - le service se place derrière un proxy HTTPS (voir `Caddyfile`).
 *
 * Arbitrage des conflits : dernière écriture gagnante (`updated_at`). Les
 * envois sont sérialisés (verrou consultatif) : l'ordre des numéros de
 * séquence est l'ordre de validation, aucun poste ne peut « sauter » une ligne.
 */

import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const PORT = Number(process.env.PORT ?? 8080);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/planete_deco';
const MASTER_KEY = process.env.ENROLL_MASTER_KEY ?? '';
const MAX_BODY = 25 * 1024 * 1024;
const PULL_MAX = 1000;
const CODE_TTL_DAYS = 7;

/** Tables que seul le siège peut écrire (référentiels centraux). */
const HQ_ONLY = new Set(['users', 'stores', 'user_stores', 'user_permissions', 'settings', 'categories', 'products']);
/** Tables enfants d'un transfert : visibles par les deux magasins. */
const KNOWN_TABLES = new Set([
  'users', 'stores', 'user_stores', 'user_permissions', 'settings', 'categories', 'products',
  'customers', 'suppliers', 'workers', 'product_stocks', 'sales_invoices', 'sales_invoice_items',
  'purchase_invoices', 'purchase_invoice_items', 'service_jobs', 'service_job_materials',
  'service_job_workers', 'stock_transfers', 'stock_transfer_items', 'stock_transfer_events',
  'inventories', 'inventory_items', 'payments', 'cash_sessions', 'cash_movements', 'stock_movements',
  'expenses', 'report_deliveries', 'audit_logs',
  'services', 'service_price_history', 'service_requests', 'service_request_items', 'quotes',
  'quote_items', 'service_job_items', 'job_stages', 'job_subcontracts',
]);

export function createPool(url = DATABASE_URL) {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id text PRIMARY KEY,
      name text NOT NULL,
      mode text NOT NULL CHECK (mode IN ('hq', 'store')),
      store_sync_id text,
      device_code integer NOT NULL,
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz,
      last_push_at timestamptz,
      last_pull_at timestamptz,
      revoked_at timestamptz
    );
    CREATE SEQUENCE IF NOT EXISTS device_code_seq START 1;
    CREATE TABLE IF NOT EXISTS enroll_codes (
      code_hash text PRIMARY KEY,
      store_sync_id text NOT NULL,
      store_name text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      used_by text
    );
    CREATE TABLE IF NOT EXISTS sync_rows (
      seq bigserial UNIQUE,
      table_name text NOT NULL,
      sync_id text NOT NULL,
      is_global boolean NOT NULL DEFAULT false,
      store_sync_id text,
      peer_store_sync_id text,
      deleted boolean NOT NULL DEFAULT false,
      updated_at bigint NOT NULL,
      payload jsonb,
      origin_device text,
      received_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (table_name, sync_id)
    );
    CREATE INDEX IF NOT EXISTS sync_rows_seq_idx ON sync_rows (seq);
    CREATE INDEX IF NOT EXISTS sync_rows_store_idx ON sync_rows (store_sync_id, seq);
    CREATE INDEX IF NOT EXISTS sync_rows_peer_idx ON sync_rows (peer_store_sync_id, seq);
    CREATE INDEX IF NOT EXISTS sync_rows_global_idx ON sync_rows (is_global, seq);
    CREATE TABLE IF NOT EXISTS sync_log (
      id bigserial PRIMARY KEY,
      device_id text,
      kind text NOT NULL,
      count integer NOT NULL DEFAULT 0,
      detail text,
      at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Requête trop volumineuse'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 * Limitation simple des tentatives d'inscription (par adresse IP)
 * ------------------------------------------------------------------ */

const enrollAttempts = new Map();
function checkEnrollRate(ip) {
  const now = Date.now();
  const entry = enrollAttempts.get(ip) ?? { count: 0, since: now };
  if (now - entry.since > 15 * 60 * 1000) {
    entry.count = 0;
    entry.since = now;
  }
  entry.count += 1;
  enrollAttempts.set(ip, entry);
  if (entry.count > 20) throw new HttpError(429, 'Trop de tentatives d’inscription. Réessayez plus tard.');
}

/* ------------------------------------------------------------------ *
 * Authentification d'un poste
 * ------------------------------------------------------------------ */

async function authenticate(pool, req) {
  const header = String(req.headers.authorization ?? '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Poste non authentifié');
  const { rows } = await pool.query(
    `UPDATE devices SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING id, name, mode, store_sync_id, device_code`,
    [sha256(token)],
  );
  if (rows.length === 0) throw new HttpError(401, 'Jeton de poste invalide ou révoqué');
  return rows[0];
}

/* ------------------------------------------------------------------ *
 * Inscription
 * ------------------------------------------------------------------ */

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) code += alphabet[bytes[i] % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function enroll(pool, body, ip) {
  checkEnrollRate(ip);
  const name = String(body.deviceName ?? '').trim().slice(0, 80) || 'Poste';

  let mode;
  let storeSyncId = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (body.masterKey) {
      if (!MASTER_KEY) throw new HttpError(403, 'Clé maîtresse non configurée sur le serveur (ENROLL_MASTER_KEY)');
      if (!safeEqual(body.masterKey, MASTER_KEY)) throw new HttpError(403, 'Clé d’inscription incorrecte');
      mode = 'hq';
    } else if (body.code) {
      const { rows } = await client.query(
        `UPDATE enroll_codes SET used_at = now()
          WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING store_sync_id`,
        [sha256(normalizeCode(body.code))],
      );
      if (rows.length === 0) throw new HttpError(403, 'Code d’inscription invalide, expiré ou déjà utilisé');
      mode = 'store';
      storeSyncId = rows[0].store_sync_id;
    } else {
      throw new HttpError(400, 'Code d’inscription manquant');
    }

    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const { rows: codeRows } = await client.query(`SELECT nextval('device_code_seq') AS code`);
    const deviceCode = Number(codeRows[0].code);
    await client.query(
      `INSERT INTO devices (id, name, mode, store_sync_id, device_code, token_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, name, mode, storeSyncId, deviceCode, sha256(token)],
    );
    if (mode === 'store') {
      await client.query(`UPDATE enroll_codes SET used_by = $1 WHERE code_hash = $2`, [id, sha256(normalizeCode(body.code))]);
    }
    await client.query(`INSERT INTO sync_log (device_id, kind, detail) VALUES ($1, 'enroll', $2)`, [id, mode]);
    await client.query('COMMIT');
    return { deviceId: id, token, deviceCode: String(deviceCode), mode, storeSyncId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ *
 * Envoi (push)
 * ------------------------------------------------------------------ */

/** Le poste peut-il écrire cette ligne ? (portée entrante **et** portée existante) */
function canWrite(device, change, existing) {
  if (device.mode === 'hq') return true;
  if (HQ_ONLY.has(change.table)) return false;
  const mine = device.store_sync_id;
  const inScope = (scope) =>
    scope.is_global ||
    (scope.store_sync_id && scope.store_sync_id === mine) ||
    (scope.peer_store_sync_id && scope.peer_store_sync_id === mine);
  const incoming = {
    is_global: Boolean(change.isGlobal),
    store_sync_id: change.storeSyncId ?? null,
    peer_store_sync_id: change.peerStoreSyncId ?? null,
  };
  // Une ligne supprimée n'a pas de portée : on se fie à la portée existante.
  if (!change.deleted && !inScope(incoming)) return false;
  if (existing && !inScope(existing)) return false;
  if (!existing && change.deleted) return true;
  return true;
}

export async function handlePush(pool, device, body) {
  const changes = Array.isArray(body.changes) ? body.changes : [];
  const accepted = [];
  const rejected = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Envois sérialisés : l'ordre des séquences est l'ordre de validation.
    await client.query('SELECT pg_advisory_xact_lock(424242)');

    for (const change of changes) {
      if (!change || !KNOWN_TABLES.has(change.table) || typeof change.syncId !== 'string' || !change.syncId) {
        rejected.push({ table: change?.table, syncId: change?.syncId, reason: 'invalid' });
        continue;
      }

      const { rows: existingRows } = await client.query(
        `SELECT is_global, store_sync_id, peer_store_sync_id, deleted, updated_at, payload
           FROM sync_rows WHERE table_name = $1 AND sync_id = $2`,
        [change.table, change.syncId],
      );
      const existing = existingRows[0] ?? null;

      if (!canWrite(device, change, existing)) {
        rejected.push({ table: change.table, syncId: change.syncId, reason: 'forbidden' });
        continue;
      }

      const updatedAt = Math.max(0, Math.trunc(Number(change.updatedAt) || Date.now()));
      // Une suppression garde la portée de la ligne pour être redistribuée aux bons postes.
      const scope = change.deleted && existing
        ? existing
        : {
            is_global: Boolean(change.isGlobal),
            store_sync_id: change.storeSyncId ?? null,
            peer_store_sync_id: change.peerStoreSyncId ?? null,
          };

      const { rows } = await client.query(
        `INSERT INTO sync_rows (table_name, sync_id, is_global, store_sync_id, peer_store_sync_id, deleted, updated_at, payload, origin_device)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (table_name, sync_id) DO UPDATE SET
           is_global = EXCLUDED.is_global,
           store_sync_id = EXCLUDED.store_sync_id,
           peer_store_sync_id = EXCLUDED.peer_store_sync_id,
           deleted = EXCLUDED.deleted,
           updated_at = EXCLUDED.updated_at,
           payload = EXCLUDED.payload,
           origin_device = EXCLUDED.origin_device,
           received_at = now(),
           seq = nextval(pg_get_serial_sequence('sync_rows', 'seq'))
         WHERE sync_rows.updated_at <= EXCLUDED.updated_at
         RETURNING seq`,
        [
          change.table,
          change.syncId,
          scope.is_global,
          scope.store_sync_id,
          scope.peer_store_sync_id,
          Boolean(change.deleted),
          updatedAt,
          change.deleted ? null : JSON.stringify(change.payload ?? {}),
          device.id,
        ],
      );

      if (rows.length === 0) {
        rejected.push({
          table: change.table,
          syncId: change.syncId,
          reason: 'stale',
          server: existing ? { deleted: existing.deleted, updatedAt: Number(existing.updated_at), payload: existing.payload } : null,
        });
      } else {
        accepted.push(change.syncId);
      }
    }

    await client.query(`UPDATE devices SET last_push_at = now() WHERE id = $1`, [device.id]);
    await client.query(`INSERT INTO sync_log (device_id, kind, count) VALUES ($1, 'push', $2)`, [device.id, accepted.length]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return { accepted, rejected };
}

/* ------------------------------------------------------------------ *
 * Réception (pull)
 * ------------------------------------------------------------------ */

export async function handlePull(pool, device, since, limit) {
  const max = Math.max(1, Math.min(PULL_MAX, limit || 500));
  const params = [since, max + 1];
  let filter = '';
  if (device.mode !== 'hq') {
    params.push(device.store_sync_id);
    filter = `AND (is_global OR store_sync_id = $3 OR peer_store_sync_id = $3)`;
  }

  const { rows } = await pool.query(
    `SELECT seq, table_name, sync_id, is_global, store_sync_id, peer_store_sync_id, deleted, updated_at, payload
       FROM sync_rows
      WHERE seq > $1 ${filter}
      ORDER BY seq ASC
      LIMIT $2`,
    params,
  );

  const hasMore = rows.length > max;
  const page = hasMore ? rows.slice(0, max) : rows;

  let maxSeq = page.length > 0 ? Number(page[page.length - 1].seq) : since;
  if (!hasMore) {
    // Aucune ligne visible au-delà : on avance jusqu'au dernier numéro connu
    // (lignes d'autres magasins), pour ne pas les rescanner à chaque cycle.
    const { rows: top } = await pool.query(`SELECT COALESCE(MAX(seq), 0) AS max FROM sync_rows`);
    maxSeq = Math.max(maxSeq, Number(top[0].max));
  }

  await pool.query(`UPDATE devices SET last_pull_at = now() WHERE id = $1`, [device.id]);

  return {
    changes: page.map((r) => ({
      seq: Number(r.seq),
      table: r.table_name,
      syncId: r.sync_id,
      deleted: r.deleted,
      updatedAt: Number(r.updated_at),
      isGlobal: r.is_global,
      storeSyncId: r.store_sync_id,
      peerStoreSyncId: r.peer_store_sync_id,
      payload: r.payload,
    })),
    maxSeq,
    hasMore,
  };
}

/* ------------------------------------------------------------------ *
 * Administration (poste du siège)
 * ------------------------------------------------------------------ */

function requireHq(device) {
  if (device.mode !== 'hq') throw new HttpError(403, 'Réservé au poste du siège');
}

async function createEnrollCode(pool, device, body) {
  requireHq(device);
  const storeSyncId = String(body.storeSyncId ?? '').trim();
  if (!storeSyncId) throw new HttpError(400, 'Magasin manquant');
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_DAYS * 86_400_000);
  await pool.query(
    `INSERT INTO enroll_codes (code_hash, store_sync_id, store_name, created_by, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [sha256(normalizeCode(code)), storeSyncId, String(body.storeName ?? '').slice(0, 120), device.id, expiresAt],
  );
  return { code, expiresAt: expiresAt.toISOString() };
}

async function listDevices(pool, device) {
  requireHq(device);
  const { rows } = await pool.query(
    `SELECT d.id, d.name, d.mode, d.store_sync_id, d.device_code, d.created_at, d.last_seen_at,
            d.last_push_at, d.last_pull_at, d.revoked_at,
            (SELECT payload->>'name' FROM sync_rows WHERE table_name = 'stores' AND sync_id = d.store_sync_id) AS store_name
       FROM devices d ORDER BY d.created_at`,
  );
  return {
    devices: rows.map((r) => ({
      id: r.id,
      name: r.name,
      mode: r.mode,
      storeSyncId: r.store_sync_id,
      storeName: r.store_name ?? null,
      deviceCode: String(r.device_code),
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      lastPushAt: r.last_push_at,
      lastPullAt: r.last_pull_at,
      revokedAt: r.revoked_at,
      isCurrent: r.id === device.id,
    })),
  };
}

async function revokeDevice(pool, device, id) {
  requireHq(device);
  if (id === device.id) throw new HttpError(400, 'Un poste ne peut pas se révoquer lui-même');
  const { rowCount } = await pool.query(`UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
  if (!rowCount) throw new HttpError(404, 'Poste introuvable ou déjà révoqué');
  return { success: true };
}

/* ------------------------------------------------------------------ *
 * Routage
 * ------------------------------------------------------------------ */

export function createServer(pool) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        await pool.query('SELECT 1');
        return send(res, 200, { ok: true, time: new Date().toISOString() });
      }

      if (req.method === 'POST' && url.pathname === '/api/devices/enroll') {
        return send(res, 200, await enroll(pool, await readBody(req), ip));
      }

      const device = await authenticate(pool, req);

      if (req.method === 'POST' && url.pathname === '/api/sync/push') {
        return send(res, 200, await handlePush(pool, device, await readBody(req)));
      }
      if (req.method === 'GET' && url.pathname === '/api/sync/pull') {
        const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
        const limit = Number(url.searchParams.get('limit') ?? 500) || 500;
        return send(res, 200, await handlePull(pool, device, since, limit));
      }
      if (req.method === 'GET' && url.pathname === '/api/sync/status') {
        const { rows } = await pool.query(`SELECT COALESCE(MAX(seq), 0) AS max FROM sync_rows`);
        return send(res, 200, { device: { id: device.id, mode: device.mode }, maxSeq: Number(rows[0].max) });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/enroll-codes') {
        return send(res, 200, await createEnrollCode(pool, device, await readBody(req)));
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/devices') {
        return send(res, 200, await listDevices(pool, device));
      }
      const revoke = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)\/revoke$/);
      if (req.method === 'POST' && revoke) {
        return send(res, 200, await revokeDevice(pool, device, decodeURIComponent(revoke[1])));
      }

      return send(res, 404, { error: 'Route inconnue' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('[server]', error);
      return send(res, status, { error: status === 500 ? 'Erreur serveur' : error.message });
    }
  });
}

/* ------------------------------------------------------------------ *
 * Démarrage
 * ------------------------------------------------------------------ */

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.mjs');

if (isMain && process.env.NODE_TEST !== '1') {
  const pool = createPool();
  await migrate(pool);
  if (!MASTER_KEY) {
    console.warn('[server] ⚠️  ENROLL_MASTER_KEY non défini : le poste du siège ne pourra pas s’inscrire.');
  }
  createServer(pool).listen(PORT, () => {
    console.log(`[server] Planète Déco — synchronisation à l'écoute sur le port ${PORT}`);
  });
}
