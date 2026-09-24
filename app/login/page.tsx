'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { useAuth } from '@/components/auth-provider';
import { useSettings } from '@/app/parametres/page';
import { FormField } from '@/components/design-system';
import { motion } from 'framer-motion';

/**
 * Connexion et première installation (README §7.15, §17.1).
 *
 * Deux écrans en un, choisis par `GET /api/auth/setup` :
 *  - **premier lancement** (`needsSetup`) : création du premier administrateur ;
 *  - **ensuite** : connexion classique par identifiant.
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

  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const companyName = settings.companyName || 'Planète Déco';
  const branch = settings.companyBranch || 'Filiale Meubles';

  // Déjà connecté : on ne reste pas sur l'écran de connexion.
  useEffect(() => {
    if (user) router.replace('/');
  }, [user, router]);

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
        ? { name: name.trim(), username: username.trim().toLowerCase(), password }
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
              {needsSetup ? 'Première installation' : 'Connexion à votre espace'}
            </p>
          </div>

          {needsSetup && (
            <div className="mb-5 rounded-xl border border-info/30 bg-info/10 p-3 text-xs leading-relaxed text-base-content/70">
              Aucun compte n’existe encore. Créez le <strong>premier administrateur</strong> : il
              pourra ensuite ajouter les gérants, vendeurs, magasiniers, menuisiers et briquetiers.
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

          <form onSubmit={handleSubmit} className="space-y-4">
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
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  className="input input-bordered field-rounded w-full pr-12"
                  placeholder="••••••••"
                  autoComplete={needsSetup ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="btn btn-ghost btn-sm btn-circle absolute right-1 top-1/2 -translate-y-1/2"
                  aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    {showPassword ? (
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                      />
                    ) : (
                      <>
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                        />
                      </>
                    )}
                  </svg>
                </button>
              </div>
            </FormField>

            {needsSetup && (
              <FormField label="Confirmer le mot de passe" htmlFor="confirm" required>
                <input
                  id="confirm"
                  type={showPassword ? 'text' : 'password'}
                  className="input input-bordered field-rounded w-full"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
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

          <p className="mt-6 text-center text-[11px] leading-relaxed text-base-content/40">
            Application locale — vos données restent sur cet ordinateur.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
