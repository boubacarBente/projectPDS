'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { UpdateStatus } from '@/components/update-status';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField, PageSection, Skeleton, Card } from '@/components/design-system';
import { ColorField } from '@/components/color-field';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import { useTheme } from '@/components/theme-provider';
import { applyThemeColors } from '@/lib/colors';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings-schema';
import { RoleGate } from '@/components/role-gate';

/* ==================================================================
 * Contexte global des paramètres (README §9.1)
 *
 * Repris du projet Gaz : les paramètres sont chargés **une seule fois** après
 * authentification, exposés à toute l'application (`app-shell.tsx` les utilise
 * pour le nom d'entreprise et les couleurs) et appliqués **en temps réel**.
 *
 * Différence de stockage : en base, ce sont des lignes clé/valeur
 * (`lib/settings-schema.ts` rétablit le typage). Le front, lui, ne change pas.
 * ================================================================== */

type SettingsContextType = {
  settings: Settings;
  isLoading: boolean;
  /** `silent: true` évite le double toast quand la page gère déjà le message. */
  updateSettings: (updates: Partial<Settings>, options?: { silent?: boolean }) => Promise<boolean>;
  refreshSettings: () => Promise<void>;
};

const SettingsContext = createContext<SettingsContextType>({
  settings: DEFAULT_SETTINGS,
  isLoading: true,
  updateSettings: async () => false,
  refreshSettings: async () => {},
});

/**
 * Valeurs par défaut, exportées sous le nom attendu par le projet Gaz.
 *
 * `components/theme-provider.tsx` est repris **tel quel** de Gaz (§3.1) et
 * importe `defaultSettings` depuis ce fichier : on conserve donc cet alias
 * plutôt que de réécrire un composant éprouvé.
 */
export const defaultSettings = DEFAULT_SETTINGS;

export const useSettings = () => useContext(SettingsContext);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const { user, isLoading: isAuthLoading } = useAuth();

  /**
   * Protection contre les réponses obsolètes : une requête lente ne doit pas
   * écraser le résultat d'une requête plus récente (patron du projet Gaz).
   */
  const requestIdRef = useRef(0);

  const refreshSettings = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    try {
      const res = await fetch('/api/parametres', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Chargement des paramètres impossible');

      const data = await res.json();
      if (requestId !== requestIdRef.current) return;

      setSettings({ ...DEFAULT_SETTINGS, ...(data.settings ?? {}) });
    } catch {
      // On garde les valeurs par défaut : l'application reste utilisable.
      if (requestId === requestIdRef.current) setSettings(DEFAULT_SETTINGS);
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthLoading) return;
    // Sur la page de connexion, aucun paramètre n'est nécessaire.
    if (!user) {
      setIsLoading(false);
      return;
    }
    void refreshSettings();
  }, [isAuthLoading, user, refreshSettings]);

  const updateSettings = useCallback(
    async (updates: Partial<Settings>, options?: { silent?: boolean }) => {
      // Optimiste : l'interface réagit immédiatement, puis on confirme.
      const previous = settings;
      setSettings((current) => ({ ...current, ...updates }));

      try {
        const res = await fetch('/api/parametres', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(updates),
        });

        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload.error ?? 'Enregistrement impossible');
        }

        const data = await res.json();
        setSettings({ ...DEFAULT_SETTINGS, ...(data.settings ?? {}) });

        if (!options?.silent) toast.success('Paramètres enregistrés');
        return true;
      } catch (error: any) {
        setSettings(previous);
        if (!options?.silent) {
          toast.error(error?.message ?? "Échec de l'enregistrement des paramètres");
        }
        return false;
      }
    },
    [settings],
  );

  const value = useMemo(
    () => ({ settings, isLoading, updateSettings, refreshSettings }),
    [settings, isLoading, updateSettings, refreshSettings],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/* ==================================================================
 * Page Paramètres — 10 sections (README §9.3)
 * ================================================================== */

type FormState = {
  companyName: string;
  companyBranch: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyTaxId: string;
  companyLogo: string;
  currency: string;
  currencySymbol: string;
  dateFormat: string;
  invoicePrefix: string;
  invoiceNumberFormat: string;
  purchasePrefix: string;
  receiptPrefix: string;
  jobPrefix: string;
  brickPrefix: string;
  furniturePrefix: string;
  defaultTaxRate: string;
  defaultStockMin: string;
  reportSendTime: string;
  syncApiUrl: string;
  syncIntervalMinutes: string;
  syncNumberBlockSize: string;
  invoiceFooterNote: string;
};

function toForm(settings: Settings): FormState {
  return {
    companyName: settings.companyName,
    companyBranch: settings.companyBranch,
    companyAddress: settings.companyAddress,
    companyPhone: settings.companyPhone,
    companyEmail: settings.companyEmail,
    companyTaxId: settings.companyTaxId,
    companyLogo: settings.companyLogo,
    currency: settings.currency,
    currencySymbol: settings.currencySymbol,
    dateFormat: settings.dateFormat,
    invoicePrefix: settings.invoicePrefix,
    invoiceNumberFormat: settings.invoiceNumberFormat,
    purchasePrefix: settings.purchasePrefix,
    receiptPrefix: settings.receiptPrefix,
    jobPrefix: settings.jobPrefix,
    brickPrefix: settings.brickPrefix,
    furniturePrefix: settings.furniturePrefix,
    defaultTaxRate: String(settings.defaultTaxRate),
    defaultStockMin: String(settings.defaultStockMin),
    reportSendTime: settings.reportSendTime,
    syncApiUrl: settings.syncApiUrl,
    syncIntervalMinutes: String(settings.syncIntervalMinutes),
    syncNumberBlockSize: String(settings.syncNumberBlockSize),
    invoiceFooterNote: settings.invoiceFooterNote,
  };
}

export default function ParametresPage() {
  const { settings, isLoading, updateSettings, refreshSettings } = useSettings();
  const { theme } = useTheme();
  const canUpdate = usePermission('settings.update');
  const canCritical = usePermission('settings.critical');
  const canBackup = usePermission('backup.manage');

  const [form, setForm] = useState<FormState>(() => toForm(settings));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [showSeedModal, setShowSeedModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(null);
  const [isWorking, setIsWorking] = useState(false);

  // Les paramètres arrivent après le premier rendu : on réaligne le formulaire.
  useEffect(() => {
    if (!isLoading) setForm(toForm(settings));
  }, [isLoading, settings]);

  const isDesktop =
    typeof window !== 'undefined' && Boolean((window as any).electronAPI?.isElectron);
  const hideDatabaseActions = isDesktop || process.env.NODE_ENV === 'production';

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  /* ---- Apparence : application immédiate, avant enregistrement (§9.1) ---- */
  const previewColors = (primary: string, sidebar: string) => {
    try {
      applyThemeColors(primary, sidebar, theme === 'dark');
    } catch {
      /* un hexadécimal incomplet ne doit pas casser la page pendant la saisie */
    }
  };

  const handleSaveCompany = async () => {
    setIsSubmitting(true);
    const done = await updateSettings({
      companyName: form.companyName,
      companyBranch: form.companyBranch,
      companyAddress: form.companyAddress,
      companyPhone: form.companyPhone,
      companyEmail: form.companyEmail,
      companyTaxId: form.companyTaxId,
      companyLogo: form.companyLogo,
      invoiceFooterNote: form.invoiceFooterNote,
    });
    setIsSubmitting(false);
    if (done) toast.success('Informations enregistrées');
  };

  const handleSaveNumbering = async () => {
    setIsSubmitting(true);
    const done = await updateSettings({
      invoicePrefix: form.invoicePrefix,
      invoiceNumberFormat: form.invoiceNumberFormat,
      purchasePrefix: form.purchasePrefix,
      receiptPrefix: form.receiptPrefix,
      jobPrefix: form.jobPrefix,
      brickPrefix: form.brickPrefix,
      furniturePrefix: form.furniturePrefix,
      defaultTaxRate: Number(form.defaultTaxRate) || 0,
    });
    setIsSubmitting(false);
    if (done) toast.success('Numérotation enregistrée');
  };

  const handleSaveCurrency = async () => {
    setIsSubmitting(true);
    const done = await updateSettings({
      currency: form.currency,
      currencySymbol: form.currencySymbol,
      dateFormat: form.dateFormat,
    });
    setIsSubmitting(false);
    if (done) toast.success('Devise et format enregistrés');
  };

  const handleSaveStock = async () => {
    setIsSubmitting(true);
    const done = await updateSettings({
      defaultStockMin: Number(form.defaultStockMin) || 0,
    });
    setIsSubmitting(false);
    if (done) toast.success('Réglages de stock enregistrés');
  };

  const handleSaveReports = async () => {
    setIsSubmitting(true);
    const done = await updateSettings({
      reportSendTime: form.reportSendTime,
    });
    setIsSubmitting(false);
    if (done) toast.success('Réglages de rapports enregistrés');
  };

  const handleLogoUpload = (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Le logo est trop volumineux (2 Mo maximum)', { autoClose: 8000 });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      set('companyLogo', String(reader.result ?? ''));
      toast.info('Logo chargé — cliquez sur « Enregistrer » pour le conserver');
    };
    reader.onerror = () => toast.error('Lecture du fichier impossible');
    reader.readAsDataURL(file);
  };

  /* ------------------------------ Actions base ------------------------------ */

  const downloadBackup = async () => {
    setIsWorking(true);
    try {
      const res = await fetch('/api/parametres/backup', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Sauvegarde impossible');

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `planete-deco-sauvegarde-${new Date().toISOString().slice(0, 10)}.db`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success('Sauvegarde téléchargée');
    } catch (error: any) {
      toast.error(error?.message ?? 'Sauvegarde impossible', { autoClose: 8000 });
    } finally {
      setIsWorking(false);
    }
  };

  const handleRestore = async () => {
    if (!pendingRestoreFile) return;
    setIsWorking(true);
    try {
      const body = new FormData();
      body.append('file', pendingRestoreFile);

      const res = await fetch('/api/parametres/restore', {
        method: 'POST',
        credentials: 'same-origin',
        body,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? 'Restauration impossible');

      toast.success(
        'Sauvegarde restaurée. Rechargez l’application pour voir les données restaurées.',
        { autoClose: 10000 },
      );
      setShowRestoreModal(false);
      setPendingRestoreFile(null);
      await refreshSettings();
    } catch (error: any) {
      toast.error(error?.message ?? 'Restauration impossible', { autoClose: 10000 });
    } finally {
      setIsWorking(false);
    }
  };

  const runDatabaseAction = async (action: 'reset-data' | 'seed-data') => {
    setIsWorking(true);
    try {
      const res = await fetch(`/api/parametres/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? 'Opération impossible');

      toast.success(
        action === 'reset-data' ? 'Base réinitialisée' : 'Données de démonstration créées',
      );
      await refreshSettings();
      window.location.reload();
    } catch (error: any) {
      toast.error(error?.message ?? 'Opération impossible', { autoClose: 8000 });
    } finally {
      setIsWorking(false);
      setShowResetModal(false);
      setShowSeedModal(false);
    }
  };

  const sendTestReport = async () => {
    setIsWorking(true);
    try {
      const res = await fetch('/api/rapports/envoyer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ period: 'day', test: true }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? 'Envoi impossible');
      toast.success(payload.message ?? 'Rapport de test préparé');
    } catch (error: any) {
      toast.error(error?.message ?? 'Envoi impossible', { autoClose: 8000 });
    } finally {
      setIsWorking(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Paramètres"
        description="Identité de l’entreprise, apparence, devise, numérotation, alertes, rapports, sauvegarde et restauration."
      />

      {!canUpdate && (
        <div className="alert border border-warning/30 bg-warning/10 text-sm">
          <span>
            Votre rôle donne un accès en <strong>consultation</strong> : les modifications sont
            réservées à l’administrateur et au gérant.
          </span>
        </div>
      )}

      {/* 1. Informations de l'entreprise */}
      <PageSection title="Informations de l’entreprise" subtitle="Elles apparaissent sur les factures, reçus et rapports.">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormField label="Nom de l’entreprise" required>
              <input
                className="input input-bordered field-rounded w-full"
                value={form.companyName}
                disabled={!canUpdate}
                onChange={(e) => set('companyName', e.target.value)}
              />
            </FormField>
            <FormField label="Filiale">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.companyBranch}
                disabled={!canUpdate}
                onChange={(e) => set('companyBranch', e.target.value)}
              />
            </FormField>
            <FormField label="NIF (identifiant fiscal)">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.companyTaxId}
                disabled={!canUpdate}
                onChange={(e) => set('companyTaxId', e.target.value)}
              />
            </FormField>
            <FormField label="Téléphone">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.companyPhone}
                disabled={!canUpdate}
                onChange={(e) => set('companyPhone', e.target.value)}
              />
            </FormField>
            <FormField label="Email">
              <input
                type="email"
                className="input input-bordered field-rounded w-full"
                value={form.companyEmail}
                disabled={!canUpdate}
                onChange={(e) => set('companyEmail', e.target.value)}
              />
            </FormField>
            <FormField label="Adresse">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.companyAddress}
                disabled={!canUpdate}
                onChange={(e) => set('companyAddress', e.target.value)}
              />
            </FormField>

            <FormField
              label="Logo"
              hint="PNG ou JPEG, 2 Mo maximum. Sans logo, un bloc texte prend sa place."
              className="sm:col-span-2"
            >
              <div className="flex flex-wrap items-center gap-3">
                {form.companyLogo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={form.companyLogo}
                    alt="Logo de l’entreprise"
                    className="h-14 w-14 rounded-lg border border-base-200 object-contain"
                  />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-base-300 text-[10px] text-base-content/40">
                    Aucun
                  </div>
                )}
                <input
                  type="file"
                  accept="image/*"
                  disabled={!canUpdate}
                  className="file-input file-input-bordered field-rounded file-input-sm w-full max-w-xs"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleLogoUpload(file);
                  }}
                />
                {form.companyLogo && canUpdate && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm text-error"
                    onClick={() => set('companyLogo', '')}
                  >
                    Retirer
                  </button>
                )}
              </div>
            </FormField>

            <FormField
              label="Note de bas de facture"
              hint="Mention libre imprimée sous les totaux (conditions, remerciements…)."
              className="sm:col-span-2 lg:col-span-3"
            >
              <input
                className="input input-bordered field-rounded w-full"
                value={form.invoiceFooterNote}
                disabled={!canUpdate}
                onChange={(e) => set('invoiceFooterNote', e.target.value)}
              />
            </FormField>
          </div>

          {canUpdate && (
            <div className="mt-5 flex justify-end border-t border-base-200 pt-4">
              <button
                type="button"
                className="btn btn-primary"
                disabled={isSubmitting}
                onClick={() => void handleSaveCompany()}
              >
                {isSubmitting ? <span className="loading loading-spinner loading-sm" /> : 'Enregistrer'}
              </button>
            </div>
          )}
        </Card>
      </PageSection>

      {/* 2. Apparence */}
      <PageSection
        title="Apparence"
        subtitle="Les couleurs sont appliquées immédiatement, avant même l’enregistrement."
      >
        <Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormField label="Couleur principale" hint="Actions, accents, éléments actifs.">
              <ColorField
                value={settings.primaryColor}
                disabled={!canUpdate}
                onPreview={(hex) => previewColors(hex, settings.sidebarColor)}
                onSave={(hex, options) => void updateSettings({ primaryColor: hex }, options)}
              />
            </FormField>

            <FormField
              label="Couleur de la barre latérale"
              hint="Le texte s’adapte automatiquement pour rester lisible."
            >
              <ColorField
                value={settings.sidebarColor}
                disabled={!canUpdate}
                onPreview={(hex) => previewColors(settings.primaryColor, hex)}
                onSave={(hex, options) => void updateSettings({ sidebarColor: hex }, options)}
              />
            </FormField>

            <FormField label="Réduction des animations" hint="Respecte le réglage du système.">
              <div className="flex h-11 items-center rounded-xl border border-base-200 bg-base-200/50 px-3 text-sm text-base-content/60">
                Géré par le système d’exploitation
              </div>
            </FormField>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-base-200 pt-4">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={!canUpdate}
              onClick={() => {
                previewColors(DEFAULT_SETTINGS.primaryColor, DEFAULT_SETTINGS.sidebarColor);
                void updateSettings({
                  primaryColor: DEFAULT_SETTINGS.primaryColor,
                  sidebarColor: DEFAULT_SETTINGS.sidebarColor,
                });
              }}
            >
              Rétablir les couleurs par défaut
            </button>
            <div className="flex items-center gap-2 text-xs text-base-content/50">
              <span>Aperçu :</span>
              <span
                className="inline-block h-6 w-6 rounded-md border border-base-300"
                style={{ backgroundColor: settings.primaryColor }}
                aria-hidden
              />
              <span
                className="inline-block h-6 w-6 rounded-md border border-base-300"
                style={{ backgroundColor: settings.sidebarColor }}
                aria-hidden
              />
            </div>
          </div>
        </Card>
      </PageSection>

      {/* 3. Devise et format */}
      <PageSection title="Devise et format">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormField label="Devise">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.currency}
                disabled={!canUpdate}
                onChange={(e) => set('currency', e.target.value)}
              />
            </FormField>
            <FormField label="Symbole affiché">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.currencySymbol}
                disabled={!canUpdate}
                onChange={(e) => set('currencySymbol', e.target.value)}
              />
            </FormField>
            <FormField label="Format de date">
              <select
                className="select select-bordered field-rounded w-full"
                value={form.dateFormat}
                disabled={!canUpdate}
                onChange={(e) => set('dateFormat', e.target.value)}
              >
                <option value="DD/MM/YYYY">JJ/MM/AAAA (31/12/2026)</option>
                <option value="DD-MM-YYYY">JJ-MM-AAAA (31-12-2026)</option>
                <option value="YYYY-MM-DD">AAAA-MM-JJ (2026-12-31)</option>
              </select>
            </FormField>
          </div>
          {canUpdate && (
            <div className="mt-5 flex justify-end border-t border-base-200 pt-4">
              <button
                type="button"
                className="btn btn-primary"
                disabled={isSubmitting}
                onClick={() => void handleSaveCurrency()}
              >
                Enregistrer
              </button>
            </div>
          )}
        </Card>
      </PageSection>

      {/* 4. Préfixes et numérotation */}
      <PageSection
        title="Préfixes et numérotation"
        subtitle="Le gabarit accepte {PREFIX}, {YYYY}, {YY}, {NNNNNN} et {NNNN}."
      >
        <Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <FormField label="Préfixe facture de vente">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.invoicePrefix}
                disabled={!canUpdate}
                onChange={(e) => set('invoicePrefix', e.target.value.toUpperCase())}
              />
            </FormField>
            <FormField label="Préfixe achat">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.purchasePrefix}
                disabled={!canUpdate}
                onChange={(e) => set('purchasePrefix', e.target.value.toUpperCase())}
              />
            </FormField>
            <FormField label="Préfixe reçu">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.receiptPrefix}
                disabled={!canUpdate}
                onChange={(e) => set('receiptPrefix', e.target.value.toUpperCase())}
              />
            </FormField>
            <FormField label="Préfixe chantier">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.jobPrefix}
                disabled={!canUpdate}
                onChange={(e) => set('jobPrefix', e.target.value.toUpperCase())}
              />
            </FormField>
            <FormField label="Préfixe lot de briques">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.brickPrefix}
                disabled={!canUpdate}
                onChange={(e) => set('brickPrefix', e.target.value.toUpperCase())}
              />
            </FormField>
            <FormField label="Préfixe commande meuble">
              <input
                className="input input-bordered field-rounded w-full"
                value={form.furniturePrefix}
                disabled={!canUpdate}
                onChange={(e) => set('furniturePrefix', e.target.value.toUpperCase())}
              />
            </FormField>
            <FormField label="Gabarit du numéro" className="sm:col-span-2">
              <input
                className="input input-bordered field-rounded w-full font-mono text-sm"
                value={form.invoiceNumberFormat}
                disabled={!canUpdate}
                onChange={(e) => set('invoiceNumberFormat', e.target.value)}
              />
            </FormField>
            <FormField
              label="Taux de TVA par défaut (%)"
              hint="0 % = facturation sans TVA. Le taux reste modifiable sur chaque facture."
            >
              <input
                type="number"
                min={0}
                max={100}
                step="0.1"
                className="input input-bordered field-rounded w-full tabular"
                value={form.defaultTaxRate}
                disabled={!canUpdate}
                onChange={(e) => set('defaultTaxRate', e.target.value)}
              />
            </FormField>
          </div>

          <p className="mt-3 rounded-lg border border-base-200 bg-base-200/40 px-3 py-2 text-xs text-base-content/60">
            Exemple de numéro :{' '}
            <span className="font-mono">
              {form.invoicePrefix || 'FAC'}-{new Date().getFullYear()}-
              {String(1).padStart(6, '0')}
            </span>
          </p>

          {canUpdate && (
            <div className="mt-5 flex justify-end border-t border-base-200 pt-4">
              <button
                type="button"
                className="btn btn-primary"
                disabled={isSubmitting}
                onClick={() => void handleSaveNumbering()}
              >
                Enregistrer
              </button>
            </div>
          )}
        </Card>
      </PageSection>

      {/* 5. Paiements */}
      <PageSection title="Moyens de paiement" subtitle="Liste fermée utilisée dans toutes les ventes, achats et dépenses.">
        <Card>
          <TagListEditor
            values={settings.paymentMethods}
            disabled={!canUpdate}
            placeholder="Ex. Chèque"
            onChange={(values) => void updateSettings({ paymentMethods: values })}
          />
        </Card>
      </PageSection>

      {/* 6. Référentiels : unités et catégories de dépense */}
      <PageSection
        title="Unités et catégories de dépenses"
        subtitle="Ces listes sont fermées : une saisie libre rendrait les rapports par catégorie faux."
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <h3 className="mb-3 text-sm font-semibold">Unités de mesure</h3>
            <TagListEditor
              values={settings.units}
              disabled={!canUpdate}
              placeholder="Ex. tonne"
              onChange={(values) => void updateSettings({ units: values })}
            />
          </Card>
          <Card>
            <h3 className="mb-3 text-sm font-semibold">Catégories de dépenses</h3>
            <TagListEditor
              values={settings.expenseCategories}
              disabled={!canUpdate}
              placeholder="Ex. Entretien"
              onChange={(values) => void updateSettings({ expenseCategories: values })}
            />
          </Card>
        </div>
      </PageSection>

      {/* 7. Stock */}
      <PageSection title="Stock et alertes">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Alertes de stock faible">
              <label className="flex h-11 cursor-pointer items-center gap-3 rounded-xl border border-base-200 bg-base-200/40 px-3">
                <input
                  type="checkbox"
                  className="toggle toggle-primary"
                  checked={settings.lowStockAlert}
                  disabled={!canUpdate}
                  onChange={(e) => void updateSettings({ lowStockAlert: e.target.checked })}
                />
                <span className="text-sm">
                  {settings.lowStockAlert ? 'Activées' : 'Désactivées'}
                </span>
              </label>
            </FormField>
            <FormField
              label="Seuil d’alerte par défaut"
              hint="Appliqué aux nouveaux produits ; modifiable produit par produit."
            >
              <input
                type="number"
                min={0}
                step="0.01"
                className="input input-bordered field-rounded w-full tabular"
                value={form.defaultStockMin}
                disabled={!canUpdate}
                onChange={(e) => set('defaultStockMin', e.target.value)}
              />
            </FormField>
          </div>
          {canUpdate && (
            <div className="mt-5 flex justify-end border-t border-base-200 pt-4">
              <button
                type="button"
                className="btn btn-primary"
                disabled={isSubmitting}
                onClick={() => void handleSaveStock()}
              >
                Enregistrer
              </button>
            </div>
          )}
        </Card>
      </PageSection>

      {/* 8. Rapports SMS / WhatsApp */}
      <PageSection
        title="Rapports SMS / WhatsApp"
        subtitle="Le mode manuel fonctionne hors ligne : le logiciel prépare le message et l’ouvre."
      >
        <Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormField label="Canaux actifs">
              <div className="flex flex-wrap gap-2">
                {['whatsapp', 'sms'].map((channel) => {
                  const active = settings.reportChannels.includes(channel);
                  return (
                    <button
                      key={channel}
                      type="button"
                      disabled={!canUpdate}
                      onClick={() =>
                        void updateSettings({
                          reportChannels: active
                            ? settings.reportChannels.filter((c) => c !== channel)
                            : [...settings.reportChannels, channel],
                        })
                      }
                      className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost border border-base-300'}`}
                    >
                      {channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}
                    </button>
                  );
                })}
              </div>
            </FormField>

            <FormField label="Fréquence d’envoi">
              <select
                className="select select-bordered field-rounded w-full"
                value={settings.reportFrequency}
                disabled={!canUpdate}
                onChange={(e) =>
                  void updateSettings({ reportFrequency: e.target.value as Settings['reportFrequency'] })
                }
              >
                <option value="manual">Manuel uniquement</option>
                <option value="day">Chaque soir</option>
                <option value="week">Chaque fin de semaine</option>
                <option value="month">Chaque fin de mois</option>
              </select>
            </FormField>

            <FormField
              label="Heure d’envoi"
              hint="Si l’application est fermée à cette heure, l’envoi est rattrapé à l’ouverture (Q8)."
            >
              <input
                type="time"
                className="input input-bordered field-rounded w-full tabular"
                value={form.reportSendTime}
                disabled={!canUpdate}
                onChange={(e) => set('reportSendTime', e.target.value)}
              />
            </FormField>

            <FormField
              label="Destinataires"
              hint="Numéros séparés par des virgules, avec indicatif pays."
              className="sm:col-span-2"
            >
              <input
                className="input input-bordered field-rounded w-full"
                value={settings.reportRecipients.join(', ')}
                disabled={!canUpdate}
                onChange={(e) =>
                  void updateSettings(
                    {
                      reportRecipients: e.target.value
                        .split(',')
                        .map((v) => v.trim())
                        .filter(Boolean),
                    },
                    { silent: true },
                  )
                }
              />
            </FormField>
          </div>

          <div className="mt-5 flex flex-wrap justify-end gap-3 border-t border-base-200 pt-4">
            {canUpdate && (
              <button
                type="button"
                className="btn btn-outline"
                disabled={isSubmitting}
                onClick={() => void handleSaveReports()}
              >
                Enregistrer
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={isWorking}
              onClick={() => void sendTestReport()}
            >
              {isWorking ? <span className="loading loading-spinner loading-sm" /> : 'Envoyer un rapport de test'}
            </button>
          </div>
        </Card>
      </PageSection>

      {/* 9. Synchronisation */}
      <RoleGate action="sync.manage">
        <PageSection
          title="Synchronisation en ligne"
          subtitle="Optionnelle et désactivée par défaut : le poste reste pleinement utilisable hors ligne (Q21)."
        >
          <Card>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <FormField label="Mode">
                <select
                  className="select select-bordered field-rounded w-full"
                  value={settings.syncMode}
                  onChange={(e) =>
                    void updateSettings({ syncMode: e.target.value as Settings['syncMode'] })
                  }
                >
                  <option value="off">Désactivée</option>
                  <option value="backup">A — Sauvegarde en ligne (unidirectionnel)</option>
                  <option value="multi">B — Multi-postes (bidirectionnel)</option>
                </select>
              </FormField>
              <FormField label="Adresse de l’API de synchronisation">
                <input
                  className="input input-bordered field-rounded w-full"
                  placeholder="https://sync.exemple.com"
                  value={form.syncApiUrl}
                  onChange={(e) => set('syncApiUrl', e.target.value)}
                  onBlur={() => void updateSettings({ syncApiUrl: form.syncApiUrl })}
                />
              </FormField>
              <FormField label="Intervalle (minutes)">
                <input
                  type="number"
                  min={1}
                  className="input input-bordered field-rounded w-full tabular"
                  value={form.syncIntervalMinutes}
                  onChange={(e) => set('syncIntervalMinutes', e.target.value)}
                  onBlur={() =>
                    void updateSettings({ syncIntervalMinutes: Number(form.syncIntervalMinutes) || 15 })
                  }
                />
              </FormField>
            </div>

            <p className="mt-3 text-xs text-base-content/50">
              Le jeton d’appareil et l’écran de suivi se trouvent dans{' '}
              <a href="/synchronisation" className="link link-primary">
                Synchronisation
              </a>
              .
            </p>
          </Card>
        </PageSection>
      </RoleGate>

      {/* 10. Application */}
      <PageSection title="Application">
        <Card>
          <UpdateStatus />
        </Card>
      </PageSection>

      {/* 11. Sauvegarde et restauration */}
      <RoleGate action="backup.manage">
        <PageSection
          title="Sauvegarde et restauration"
          subtitle="La sauvegarde est un fichier SQLite complet, restaurable tel quel."
        >
          <Card>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="btn btn-primary"
                disabled={isWorking}
                onClick={() => void downloadBackup()}
              >
                Sauvegarder maintenant
              </button>
              <button
                type="button"
                className="btn btn-outline"
                disabled={isWorking}
                onClick={() => {
                  setPendingRestoreFile(null);
                  setShowRestoreModal(true);
                }}
              >
                Restaurer une sauvegarde
              </button>
            </div>

            <div className="mt-4 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-base-content/70">
              <strong>Restaurer remplace toutes les données actuelles.</strong> Une copie de
              sécurité de la base en place est créée automatiquement avant l’écrasement.
            </div>
          </Card>
        </PageSection>
      </RoleGate>

      {/* 12. Zone dangereuse — outils de développement uniquement */}
      {canCritical && !hideDatabaseActions && (
        <PageSection
          title="Zone dangereuse"
          subtitle="Outils de développement : masqués en production et dans l’application de bureau."
        >
          <Card className="border-error/30">
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="btn btn-outline btn-error"
                disabled={isWorking}
                onClick={() => setShowResetModal(true)}
              >
                Réinitialiser les données
              </button>
              <button
                type="button"
                className="btn btn-outline"
                disabled={isWorking}
                onClick={() => setShowSeedModal(true)}
              >
                Préremplir les données de démonstration
              </button>
            </div>
          </Card>
        </PageSection>
      )}

      {/* ------------------------------- Modales ------------------------------- */}

      <ConfirmDialog
        isOpen={showResetModal}
        onClose={() => setShowResetModal(false)}
        onConfirm={() => void runDatabaseAction('reset-data')}
        title="Réinitialiser toutes les données"
        tone="error"
        confirmLabel="Tout effacer"
        isSubmitting={isWorking}
        message={
          <>
            Toutes les ventes, achats, clients, produits, mouvements de caisse et de stock seront{' '}
            <strong>définitivement supprimés</strong>. Les paramètres de l’entreprise sont
            conservés.
            <br />
            <span className="text-sm">Cette action est irréversible.</span>
          </>
        }
      />

      <ConfirmDialog
        isOpen={showSeedModal}
        onClose={() => setShowSeedModal(false)}
        onConfirm={() => void runDatabaseAction('seed-data')}
        title="Préremplir les données de démonstration"
        tone="warning"
        confirmLabel="Préremplir"
        isSubmitting={isWorking}
        message="Un catalogue de démonstration (catégories, produits, clients, fournisseurs, ouvriers) sera ajouté. Les données existantes ne sont pas supprimées."
      />

      <ConfirmDialog
        isOpen={showRestoreModal}
        onClose={() => {
          if (!isWorking) {
            setShowRestoreModal(false);
            setPendingRestoreFile(null);
          }
        }}
        onConfirm={() => void handleRestore()}
        title="Restaurer une sauvegarde"
        tone="error"
        confirmLabel="Restaurer"
        isSubmitting={isWorking}
        message="Choisissez un fichier de sauvegarde (.db). Les données actuelles seront remplacées."
      >
        <input
          type="file"
          accept=".db,application/octet-stream"
          className="file-input file-input-bordered field-rounded mb-4 w-full"
          onChange={(e) => setPendingRestoreFile(e.target.files?.[0] ?? null)}
        />
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------------------------------------------
 * Éditeur de liste fermée (moyens de paiement, unités, catégories)
 * ------------------------------------------------------------------ */

function TagListEditor({
  values,
  onChange,
  disabled,
  placeholder = 'Ajouter…',
}: {
  values: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      toast.info('Cette valeur existe déjà');
      return;
    }
    onChange([...values, value]);
    setDraft('');
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {values.length === 0 && (
          <span className="text-sm text-base-content/50">Aucune valeur.</span>
        )}
        {values.map((value) => (
          <span
            key={value}
            className="badge-pill inline-flex items-center gap-1.5 border border-base-300 bg-base-200/60 px-3 py-1.5 text-sm"
          >
            {value}
            {!disabled && (
              <button
                type="button"
                className="text-base-content/40 transition-colors hover:text-error"
                aria-label={`Retirer ${value}`}
                onClick={() => onChange(values.filter((v) => v !== value))}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </span>
        ))}
      </div>

      {!disabled && (
        <div className="mt-3 flex gap-2">
          <input
            className="input input-bordered field-rounded w-full max-w-xs"
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn btn-outline" onClick={add}>
            Ajouter
          </button>
        </div>
      )}
    </div>
  );
}
