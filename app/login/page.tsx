'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { useAuth } from '@/components/auth-provider';
import { useSettings } from '@/app/parametres/page';
import { FormField } from '@/components/design-system';
import { PasswordInput } from '@/components/password-input';
import { motion } from 'framer-motion';

/**
 * Connexion et première installation (README §7.15, §17.1).
 *
 * Quatre écrans, choisis par `GET /api/auth/setup` puis par la réponse de
 * connexion :
 *  - **premier lancement** (`needsSetup`) — deux choix :
 *      · « Nouvelle installation » : création du premier administrateur et du
 *        premier magasin (siège ou magasin) ;
 *      · « Rejoindre le serveur » : poste d'un magasin, inscrit avec le code
 *        fourni par le siège (`POST /api/auth/join`) ; comptes, catalogue et
 *        données du magasin arrivent par synchronisation ;
 *  - **connexion** classique par identifiant ;
 *  - **choix du magasin** quand le compte a accès à plusieurs magasins
 *    (`needsStoreChoice`) → `POST /api/auth/store`.
 *
 * ⚠️ Le compte administrateur **codé en dur** du projet Gaz (`boubacar` /
 * `1265`) est supprimé : c'était une faille, un compte connu contournant la base
 * (§3.4). Il n'existe aucun chemin d'authentification hors base.
 */
export default function LoginPage() {
  const router = useRouter();
  const { refreshUser, user } = useAuth();
  const { settings } = useSettings();

  const [isCheckingSetup, setIsCheckingSetup] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [setupMode, setSetupMode] = useState<'new' | 'join'>('new');
  const [storeChoices, setStoreChoices] = useState<{ id: number; code: string; name: string; kind: string }[] | null>(null);
  const [storeName, setStoreName] = useState('');
  const [storeCode, setStoreCode] = useState('');
  const [storeKind, setStoreKind] = useState<'headquarters' | 'store'>('headquarters');
  const [serverUrl, setServerUrl] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [deviceName, setDeviceName] = useState('');

  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const companyName = settings.companyName || 'Planète Déco';
  const branch = settings.companyBranch || 'Filiale Meubles';

  // Déjà connecté : on ne reste pas sur l'écran de connexion (sauf choix du magasin en cours).
  useEffect(() => {
    if (user && !storeChoices) router.replace('/');
  }, [user, router, storeChoices]);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch('/api/auth/setup', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setNeedsSetup(Boolean(data.needsSetup));
      } catch {
        // En cas de doute on propose la connexion : elle est le cas nominal.
        if (!cancelled) setNeedsSetup(false);
      } finally {
        if (!cancelled) setIsCheckingSetup(false);
      }
    };

    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Choix du magasin actif après une connexion multi-magasins. */
  const chooseStore = async (storeId: number) => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ storeId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Choix du magasin impossible');
      setStoreChoices(null);
      await refreshUser();
      router.replace('/');
    } catch (err: any) {
      setError(err?.message ?? 'Choix du magasin impossible');
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Installation d'un poste de magasin : inscription au serveur central. */
  const handleJoin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!serverUrl.trim() || !joinCode.trim()) {
      setError("L'adresse du serveur et le code d'inscription sont obligatoires.");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/auth/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          serverUrl: serverUrl.trim(),
          code: joinCode.trim(),
          deviceName: deviceName.trim() || 'Poste magasin',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Inscription impossible');
      if (!data.users) {
        throw new Error(
          'Poste inscrit, mais aucun compte n’a encore été reçu. Vérifiez que le siège a bien synchronisé, puis réessayez la connexion.',
        );
      }
      toast.success('Poste inscrit : les données du magasin ont été reçues. Connectez-vous.');
      setNeedsSetup(false);
    } catch (err: any) {
      setError(err?.message ?? 'Inscription impossible');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!username.trim() || !password) {
      setError("L'identifiant et le mot de passe sont obligatoires.");
      return;
    }

    if (needsSetup) {
      if (!name.trim()) {
        setError('Le nom affiché est obligatoire.');
        return;
      }
      if (password.length < 6) {
        setError('Le mot de passe doit contenir au moins 6 caractères.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Les deux mots de passe ne correspondent pas.');
        return;
      }
    }

    setIsSubmitting(true);

    try {
      const endpoint = needsSetup ? '/api/auth/setup' : '/api/auth/login';
      const payload = needsSetup
        ? {
            name: name.trim(),
            username: username.trim().toLowerCase(),
            password,
            storeName: storeName.trim(),
            storeCode: storeCode.trim().toUpperCase(),
            storeKind,
          }
        : { username: username.trim(), password };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error ?? 'Connexion impossible');
      }

      // Plusieurs magasins accessibles : on demande dans quel magasin travailler.
      if (!needsSetup && data.needsStoreChoice && Array.isArray(data.stores) && data.stores.length > 1) {
        setStoreChoices(data.stores);
        await refreshUser();
        return;
      }

      toast.success(needsSetup ? 'Bienvenue ! Votre compte administrateur est créé.' : 'Connexion réussie');
      await refreshUser();
      router.replace('/');
    } catch (err: any) {
      setError(err?.message ?? 'Connexion impossible');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCheckingSetup) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-200">
        <span className="loading loading-spinner loading-lg text-primary" />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-base-200 px-4 py-10">
      {/* Fond décoratif : uniquement des teintes issues du thème. */}
      <div
        className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-primary/20 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-40 -right-24 h-96 w-96 rounded-full bg-secondary/20 blur-3xl"
        aria-hidden
      />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="relative w-full max-w-md"
      >
        <div className="surface-card border border-base-200 bg-base-100 p-6 shadow-md shadow-black/5 sm:p-8">
          {/* Identité */}
          <div className="mb-7 flex flex-col items-center text-center">
            <Image
              src="/logo.jpg"
              alt=""
              width={64}
              height={64}
              className="mb-3 rounded-2xl"
              priority
            />
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{companyName}</h1>
            <p className="mt-0.5 text-sm text-base-content/60">{branch}</p>
            <p className="mt-3 text-sm font-medium text-primary">
              {storeChoices
                ? 'Dans quel magasin travaillez-vous ?'
                : needsSetup
                  ? 'Première installation'
                  : 'Connexion à votre espace'}
            </p>
          </div>

          {needsSetup && !storeChoices && (
            <div className="mb-5 space-y-3">
              <div role="tablist" className="tabs tabs-boxed grid grid-cols-2">
                <button
                  type="button"
                  role="tab"
                  className={`tab ${setupMode === 'new' ? 'tab-active' : ''}`}
                  onClick={() => setSetupMode('new')}
                >
                  Nouvelle installation
                </button>
                <button
                  type="button"
                  role="tab"
                  className={`tab ${setupMode === 'join' ? 'tab-active' : ''}`}
                  onClick={() => setSetupMode('join')}
                >
                  Rejoindre le serveur
                </button>
              </div>
              <div className="rounded-xl border border-info/30 bg-info/10 p-3 text-xs leading-relaxed text-base-content/70">
                {setupMode === 'new' ? (
                  <>
                    Créez le <strong>premier administrateur</strong> et le <strong>premier magasin</strong>.
                    Choisissez « Siège » pour le poste central qui pilotera les autres magasins.
                  </>
                ) : (
                  <>
                    Poste d’un <strong>magasin</strong> : saisissez l’adresse du serveur central et le{' '}
                    <strong>code d’inscription</strong> généré au siège (page Synchronisation). Les comptes,
                    le catalogue et les données du magasin seront téléchargés.
                  </>
                )}
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-2.5 rounded-xl border border-error/30 bg-error/10 p-3 text-sm text-error"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="mt-0.5 h-4 w-4 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m0 3.75h.008M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {storeChoices ? (
            <div className="space-y-2">
              {storeChoices.map((store) => (
                <button
                  key={store.id}
                  type="button"
                  className="btn btn-outline min-h-12 w-full justify-between"
                  disabled={isSubmitting}
                  onClick={() => void chooseStore(store.id)}
                >
                  <span>{store.name}</span>
                  <span className="badge badge-ghost">{store.kind === 'headquarters' ? 'Siège' : store.code}</span>
                </button>
              ))}
            </div>
          ) : needsSetup && setupMode === 'join' ? (
            <form onSubmit={handleJoin} className="space-y-4">
              <FormField label="Adresse du serveur central" htmlFor="serverUrl" required hint="Ex. https://sync.mon-entreprise.com">
                <input
                  id="serverUrl"
                  className="input input-bordered field-rounded w-full"
                  placeholder="https://…"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                />
              </FormField>
              <FormField label="Code d’inscription" htmlFor="joinCode" required hint="Fourni par le siège, valable 7 jours, à usage unique.">
                <input
                  id="joinCode"
                  className="input input-bordered field-rounded w-full font-mono uppercase"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                />
              </FormField>
              <FormField label="Nom de ce poste" htmlFor="deviceName" hint="Ex. Caisse 1 — Kaloum">
                <input
                  id="deviceName"
                  className="input input-bordered field-rounded w-full"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                />
              </FormField>
              <button type="submit" className="btn btn-primary min-h-12 w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <span className="loading loading-spinner loading-sm" />
                    Inscription et téléchargement…
                  </>
                ) : (
                  'Inscrire ce poste'
                )}
              </button>
            </form>
          ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {needsSetup && (
              <div className="grid grid-cols-3 gap-3">
                <FormField label="Premier magasin" htmlFor="storeName" className="col-span-2">
                  <input
                    id="storeName"
                    className="input input-bordered field-rounded w-full"
                    placeholder="Ex. Siège Conakry"
                    value={storeName}
                    onChange={(e) => setStoreName(e.target.value)}
                  />
                </FormField>
                <FormField label="Code" htmlFor="storeCode" hint="2 à 10 car.">
                  <input
                    id="storeCode"
                    className="input input-bordered field-rounded w-full uppercase"
                    placeholder="SIEGE"
                    value={storeCode}
                    onChange={(e) => setStoreCode(e.target.value)}
                  />
                </FormField>
                <FormField label="Type" htmlFor="storeKind" className="col-span-3">
                  <select
                    id="storeKind"
                    className="select select-bordered field-rounded w-full"
                    value={storeKind}
                    onChange={(e) => setStoreKind(e.target.value as 'headquarters' | 'store')}
                  >
                    <option value="headquarters">Siège (poste central, pilote les autres magasins)</option>
                    <option value="store">Magasin unique (installation autonome)</option>
                  </select>
                </FormField>
              </div>
            )}

            {needsSetup && (
              <FormField label="Nom affiché" htmlFor="name" required>
                <input
                  id="name"
                  className="input input-bordered field-rounded w-full"
                  placeholder="Ex. Boubacar Bente"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </FormField>
            )}

            <FormField
              label="Identifiant"
              htmlFor="username"
              required
              hint={needsSetup ? 'Minuscules, chiffres, « . », « _ » ou « - ».' : undefined}
            >
              <input
                id="username"
                className="input input-bordered field-rounded w-full"
                placeholder="Ex. boubacar"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </FormField>

            <FormField label="Mot de passe" htmlFor="password" required>
              <PasswordInput
                id="password"
                value={password}
                onChange={setPassword}
                className="field-rounded"
                placeholder="••••••••"
                autoComplete={needsSetup ? 'new-password' : 'current-password'}
              />
            </FormField>

            {needsSetup && (
              <FormField label="Confirmer le mot de passe" htmlFor="confirm" required>
                <PasswordInput
                  id="confirm"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  className="field-rounded"
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </FormField>
            )}

            <button
              type="submit"
              className="btn btn-primary min-h-12 w-full"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <span className="loading loading-spinner loading-sm" />
                  {needsSetup ? 'Création…' : 'Connexion…'}
                </>
              ) : needsSetup ? (
                'Créer le compte administrateur'
              ) : (
                'Se connecter'
              )}
            </button>
          </form>
          )}

          <p className="mt-6 text-center text-[11px] leading-relaxed text-base-content/40">
            Les données sont enregistrées sur ce poste et fonctionnent sans Internet ; elles sont
            synchronisées avec le serveur central quand le poste y est relié.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
