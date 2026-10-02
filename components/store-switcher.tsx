'use client';

import { useState } from 'react';
import { toast } from 'react-toastify';
import { useAuth } from '@/components/auth-provider';

/**
 * Sélecteur du **magasin actif** (pied de l'en-tête de la sidebar).
 *
 * - Un seul magasin accessible : simple étiquette (rien à choisir).
 * - Plusieurs magasins : liste déroulante ; choisir un magasin appelle
 *   `POST /api/auth/store` puis recharge la page — ventes, caisse, stock,
 *   dépenses… sont alors enregistrées dans ce magasin.
 * - Poste du siège : les autres magasins sont consultables mais en lecture
 *   seule (le serveur refuse toute écriture hors du magasin « siège »).
 */
export function StoreSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { stores, activeStore, activeStoreId, switchStore, device } = useAuth();
  const [busy, setBusy] = useState(false);

  if (stores.length === 0) return null;

  const readOnly =
    device?.mode === 'hq' && activeStore !== null && activeStore.kind !== 'headquarters';

  if (collapsed) {
    return (
      <div
        className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg text-[10px] font-bold"
        style={{ backgroundColor: 'var(--sidebar-active)', color: 'var(--sidebar-text)' }}
        title={activeStore ? `Magasin actif : ${activeStore.name}` : 'Aucun magasin actif'}
      >
        {activeStore?.code.slice(0, 3) ?? '—'}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label className="block text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--sidebar-text-muted)' }} htmlFor="store-switcher">
        Magasin actif
      </label>
      {stores.length === 1 ? (
        <p className="truncate rounded-lg px-2 py-1.5 text-sm font-medium" style={{ backgroundColor: 'var(--sidebar-active)', color: 'var(--sidebar-text)' }}>
          {activeStore?.name ?? stores[0].name}
        </p>
      ) : (
        <select
          id="store-switcher"
          // Couleurs de la barre latérale : le texte de la barre est clair, une liste
          // au fond blanc par défaut paraissait vide (texte blanc sur blanc).
          className="select select-sm w-full border-0 font-medium"
          style={{ backgroundColor: 'var(--sidebar-active)', color: 'var(--sidebar-text)' }}
          value={activeStoreId ?? ''}
          disabled={busy}
          onChange={async (event) => {
            const id = Number(event.target.value);
            if (!id || id === activeStoreId) return;
            setBusy(true);
            try {
              await switchStore(id);
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Changement de magasin impossible');
              setBusy(false);
            }
          }}
          aria-label="Changer de magasin actif"
        >
          {activeStoreId === null && (
            <option value="" className="bg-base-100 text-base-content">
              Choisir un magasin…
            </option>
          )}
          {stores.map((store) => (
            <option key={store.id} value={store.id} className="bg-base-100 text-base-content">
              {store.name}
              {store.kind === 'headquarters' ? ' (siège)' : ''}
              {store.status !== 'active' ? ' — suspendu' : ''}
            </option>
          ))}
        </select>
      )}
      {readOnly && (
        <p className="text-[10px] text-warning">Consultation seule depuis le poste du siège.</p>
      )}
      {activeStore && activeStore.status !== 'active' && (
        <p className="text-[10px] text-warning">Magasin suspendu : aucune opération possible.</p>
      )}
    </div>
  );
}
