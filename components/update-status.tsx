'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';

type UpdateState =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'dev'
  | 'unavailable';

const statusBadgeClass: Record<UpdateState, string> = {
  idle: 'badge-ghost',
  checking: 'badge-info',
  current: 'badge-success',
  available: 'badge-info',
  downloading: 'badge-info',
  downloaded: 'badge-success',
  error: 'badge-error',
  dev: 'badge-warning',
  unavailable: 'badge-warning',
};

function getPayloadVersion(payload?: ElectronUpdatePayload | null) {
  return payload && typeof payload.version === 'string' ? payload.version : null;
}

function getProgress(payload: ElectronUpdatePayload | number) {
  if (typeof payload === 'number') return payload;
  return typeof payload.percent === 'number' ? payload.percent : null;
}

function formatVersion(version: string | null) {
  return version ? `v${version}` : '...';
}

export function AppVersionDisplay() {
  const [isElectron, setIsElectron] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.isElectron) return;

    setIsElectron(true);
    api.getAppVersion().then(setCurrentVersion).catch(() => setCurrentVersion(null));
  }, []);

  if (!isElectron) return null;

  return (
    <div
      className="mb-3 flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs"
      style={{
        color: 'var(--sidebar-text-muted)',
        backgroundColor: 'color-mix(in srgb, var(--sidebar-text) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--sidebar-text) 14%, transparent)',
      }}
    >
      <span className="truncate">Version</span>
      <span className="shrink-0 font-semibold" style={{ color: 'var(--sidebar-text)' }}>
        {formatVersion(currentVersion)}
      </span>
    </div>
  );
}

export function UpdateStatus() {
  const [isElectron, setIsElectron] = useState<boolean | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>('idle');
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const manualCheckRef = useRef(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.isElectron) {
      setIsElectron(false);
      setState('unavailable');
      setMessage("Disponible dans l'application desktop installée");
      return;
    }

    setIsElectron(true);
    api.getAppVersion().then(setCurrentVersion).catch(() => setCurrentVersion(null));

    const unsubscribers = [
      api.onUpdateChecking?.(() => {
        setState('checking');
        setMessage('Vérification en cours...');
      }),
      api.onUpdateAvailable?.((payload) => {
        const version = getPayloadVersion(payload);
        setLatestVersion(version);
        setState('available');
        setProgress(null);
        setMessage(version ? `Version ${version} disponible` : 'Mise à jour disponible');
        toast.info(
          version
            ? `Mise à jour ${version} disponible. Téléchargement en cours...`
            : 'Mise à jour disponible. Téléchargement en cours...',
          { toastId: 'update-available' }
        );
      }),
      api.onUpdateProgress?.((payload) => {
        const percent = getProgress(payload);
        const roundedPercent = percent === null ? null : Math.round(percent);
        setState('downloading');
        setProgress(roundedPercent);
        setMessage(
          roundedPercent === null
            ? 'Téléchargement en cours...'
            : `Téléchargement ${roundedPercent}%`
        );
      }),
      api.onUpdateDownloaded?.((payload) => {
        const version = getPayloadVersion(payload);
        setLatestVersion(version);
        setState('downloaded');
        setProgress(100);
        setMessage(version ? `Version ${version} prête` : 'Mise à jour prête');
        toast.success("Mise à jour téléchargée. Redémarrez pour l'installer.", {
          toastId: 'update-downloaded',
          autoClose: false,
        });
      }),
      api.onUpdateNotAvailable?.((payload) => {
        const version = getPayloadVersion(payload);
        setLatestVersion(version);
        setState('current');
        setProgress(null);
        setMessage('Application à jour');
        if (manualCheckRef.current) {
          toast.info('Application déjà à jour.', { toastId: 'update-current' });
        }
      }),
      api.onUpdateError?.((payload) => {
        const errorMessage = payload.message || 'Vérification impossible';
        setState('error');
        setMessage(errorMessage);
        toast.error(`Mise à jour: ${errorMessage}`, {
          toastId: 'update-error',
          autoClose: 8000,
        });
      }),
    ].filter(Boolean) as ElectronUpdateUnsubscribe[];

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  const isBusy = state === 'checking' || state === 'downloading' || state === 'available';
  const statusText = useMemo(() => {
    if (message) return message;
    if (state === 'dev') return 'Mode développement';
    if (state === 'unavailable') return "Desktop uniquement";
    return 'Prêt à vérifier';
  }, [message, state]);

  const statusLabel = useMemo(() => {
    if (state === 'checking') return 'Vérification';
    if (state === 'current') return 'À jour';
    if (state === 'available') return 'Disponible';
    if (state === 'downloading') return 'Téléchargement';
    if (state === 'downloaded') return 'Prête';
    if (state === 'error') return 'Erreur';
    if (state === 'dev') return 'Développement';
    if (state === 'unavailable') return 'Indisponible';
    return 'En attente';
  }, [state]);

  const checkForUpdates = async () => {
    const api = window.electronAPI;
    if (!api?.checkForUpdates) return;

    manualCheckRef.current = true;
    setState('checking');
    setMessage('Vérification en cours...');

    const result = await api.checkForUpdates();
    if (result?.status === 'dev') {
      setState('dev');
      setMessage('Mode développement');
      toast.info("Les mises à jour sont actives seulement dans l'app installée.");
    } else if (result?.status === 'unavailable') {
      setState('unavailable');
      setMessage('Module indisponible');
      toast.error('Le module de mise à jour est indisponible.');
    } else if (result?.status === 'error') {
      setState('error');
      setMessage(result.error || 'Vérification impossible');
    }
  };

  const installedVersionText = isElectron === false ? 'Non disponible' : formatVersion(currentVersion);
  const latestVersionText = latestVersion ? formatVersion(latestVersion) : 'En attente';

  return (
    <div className="rounded-2xl border border-base-200 bg-base-100 shadow-sm">
      <div className="flex flex-col gap-5 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M20 9A8 8 0 006.9 4.9L4 10m16 4l-2.9 5.1A8 8 0 014 15" />
            </svg>
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-lg font-semibold text-base-content">Mise à jour de l'application</h4>
              <span className={`badge ${statusBadgeClass[state]}`}>{statusLabel}</span>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-base-content/65">
              {isElectron === false
                ? "Disponible uniquement dans l'application desktop installée."
                : "Suivez la version installée et lancez une vérification quand vous voulez."}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={checkForUpdates}
          disabled={!isElectron || isBusy}
          className="btn btn-primary gap-2 lg:min-w-56"
        >
          {isBusy ? (
            <span className="loading loading-spinner loading-sm"></span>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8 8 0 004.582 9H9m11 11v-5h-.581m0 0a8 8 0 01-15.357-2H9" />
            </svg>
          )}
          Vérifier
        </button>
      </div>

      <div className="grid grid-cols-1 border-t border-base-200 sm:grid-cols-3">
        <div className="border-b border-base-200 p-5 sm:border-b-0 sm:border-r">
          <p className="text-xs font-semibold uppercase tracking-wide text-base-content/50">Version installée</p>
          <p className="mt-2 text-2xl font-bold text-base-content">{installedVersionText}</p>
        </div>
        <div className="border-b border-base-200 p-5 sm:border-b-0 sm:border-r">
          <p className="text-xs font-semibold uppercase tracking-wide text-base-content/50">Dernière version</p>
          <p className="mt-2 text-2xl font-bold text-base-content">{latestVersionText}</p>
        </div>
        <div className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-base-content/50">État</p>
          <p className="mt-2 text-sm font-medium leading-6 text-base-content">{statusText}</p>
        </div>
      </div>

      {state === 'downloading' && progress !== null && (
        <div className="border-t border-base-200 px-5 py-4">
          <div className="mb-2 flex items-center justify-between text-xs font-medium text-base-content/60">
            <span>Téléchargement</span>
            <span>{progress}%</span>
          </div>
          <progress className="progress progress-primary h-2 w-full" value={progress} max={100} />
        </div>
      )}
    </div>
  );
}
