/*
 * Portée des lignes envoyées par un poste (revue de sécurité du 4 octobre
 * 2026) : un poste de magasin ne doit jamais pouvoir enregistrer une ligne au
 * nom d'un autre magasin, quelle que soit la portée qu'il déclare.
 *
 * Usage : cd server && npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_TEST = '1';
const { authorizedScope } = await import('../index.mjs');

const A = 'magasin-a';
const B = 'magasin-b';
const storeDevice = { mode: 'store', store_sync_id: A };
const hqDevice = { mode: 'hq', store_sync_id: null };

/** Faux client PostgreSQL : seules les lignes parentes de `sync_rows` sont lues. */
function fakeClient(rows = {}) {
  return {
    async query(_sql, [table, syncId]) {
      const row = rows[`${table}:${syncId}`];
      return { rows: row ? [row] : [] };
    },
  };
}
const change = (table, payload, declared = {}) => ({ table, syncId: 'x', deleted: false, payload, ...declared });

test('un paiement au nom d’un autre magasin est refusé, même déclaré du magasin du poste', async () => {
  const scope = await authorizedScope(fakeClient(), storeDevice, change('payments', { store_id: B }, { storeSyncId: A }), null);
  assert.equal(scope, null);
});

test('une ligne déclarée « globale » est ramenée au magasin du poste', async () => {
  const scope = await authorizedScope(fakeClient(), storeDevice, change('cash_movements', { store_id: A }, { isGlobal: true }), null);
  assert.deepEqual(scope, { is_global: false, store_sync_id: A, peer_store_sync_id: null });
});

test('un référentiel commun reste réservé au siège', async () => {
  for (const table of ['users', 'user_permissions', 'stores', 'settings', 'products', 'categories']) {
    assert.equal(await authorizedScope(fakeClient(), storeDevice, change(table, {}, { isGlobal: true }), null), null, table);
  }
});

test('une ligne enfant prend la portée de son document parent', async () => {
  const client = fakeClient({ 'sales_invoices:f1': { is_global: false, store_sync_id: B, peer_store_sync_id: null } });
  const forged = await authorizedScope(client, storeDevice, change('sales_invoice_items', { invoice_id: 'f1' }, { storeSyncId: A }), null);
  assert.equal(forged, null, 'ligne rattachée à une facture d’un autre magasin');

  const own = fakeClient({ 'sales_invoices:f2': { is_global: false, store_sync_id: A, peer_store_sync_id: null } });
  const ok = await authorizedScope(own, storeDevice, change('sales_invoice_items', { invoice_id: 'f2' }), null);
  assert.deepEqual(ok, { is_global: false, store_sync_id: A, peer_store_sync_id: null });
});

test('une ligne enfant dont le parent n’est pas encore arrivé reste dans le magasin du poste', async () => {
  const scope = await authorizedScope(fakeClient(), storeDevice, change('sales_invoice_items', { invoice_id: 'inconnu' }, { isGlobal: true }), null);
  assert.deepEqual(scope, { is_global: false, store_sync_id: A, peer_store_sync_id: null });
});

test('un transfert doit concerner le magasin du poste', async () => {
  const foreign = await authorizedScope(
    fakeClient(),
    storeDevice,
    change('stock_transfers', { source_store_id: B, destination_store_id: 'magasin-c' }, { storeSyncId: A }),
    null,
  );
  assert.equal(foreign, null);
  const outgoing = await authorizedScope(fakeClient(), storeDevice, change('stock_transfers', { source_store_id: A, destination_store_id: B }), null);
  assert.deepEqual(outgoing, { is_global: false, store_sync_id: A, peer_store_sync_id: B });
});

test('une ligne existante d’un autre magasin ne se modifie ni ne se supprime', async () => {
  const existing = { is_global: false, store_sync_id: B, peer_store_sync_id: null };
  assert.equal(await authorizedScope(fakeClient(), storeDevice, change('expenses', { store_id: A }), existing), null);
  assert.equal(await authorizedScope(fakeClient(), storeDevice, { table: 'expenses', syncId: 'x', deleted: true }, existing), null);
});

test('le siège est cru sur parole', async () => {
  const scope = await authorizedScope(fakeClient(), hqDevice, change('payments', { store_id: B }, { storeSyncId: B }), null);
  assert.deepEqual(scope, { is_global: false, store_sync_id: B, peer_store_sync_id: null });
});
