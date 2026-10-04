'use client';

/**
 * Fiche d'un magasin (cahier des charges §4, §20 ; guide multi-magasins §6.14).
 *
 * Onglets : vue d'ensemble (indicateurs sur une période choisie), informations,
 * équipe, activité (journal d'audit **de ce magasin seul**, `central=false`).
 *
 * Statuts :
 *  - suspendre : le magasin reste consultable, mais plus aucune opération n'y
 *    est acceptée (le serveur refuse ventes, achats, caisse, transferts…) ;
 *  - archiver : refusé par le serveur tant qu'une caisse est ouverte ou qu'un
 *    transfert est en cours — on affiche son message tel quel.
 * Aucune suppression physique (AGENTS.md, invariant 1).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'react-toastify';
import { PageHeader } from '@/components/page-header';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DatePicker } from '@/components/date-picker';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  FormField,
  InfoRow,
  MoneyText,
  PageSection,
  SkeletonCards,
  StatCardDelta,
} from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { useAuth } from '@/components/auth-provider';
import {
  StoreFormModal,
  StoreKindBadge,
  StoreStatusBadge,
  readApiError,
  type StoreIndicators,
  type StoreRecord,
  type StoreStatus,
} from '@/components/magasins/store-ui';
import { ROLE_LABELS, type Role } from '@/lib/permissions';
import { auditActionLabel, auditEntityLabel } from '@/lib/audit-labels';
import { formatCurrency, formatNumber } from '@/lib/format';
import { formatDateShort, formatDateWithTime } from '@/lib/date-format';

type StoreUser = {
  id: number;
  name: string;
  username: string;
  role: Role;
  is_active: number;
  is_manager: number;
  assignment_active: number;
  starts_at: string | null;
  ends_at: string | null;
};

type AuditEntry = {
  id: number;
  userName: string;
  action: string;
  entity: string;
  entityId: number | null;
  createdAt: string | null;
};

type Tab = 'overview' | 'info' | 'team' | 'activity';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Vue d’ensemble' },
  { key: 'info', label: 'Informations' },
  { key: 'team', label: 'Équipe' },
  { key: 'activity', label: 'Activité' },
];

/** Changement de statut demandé, avec le libellé de la confirmation. */
type StatusChange = { status: StoreStatus; title: string; confirm: string; needsReason: boolean };

export default function MagasinFichePage() {
  const params = useParams<{ id: string }>();
  const storeId = Number(params.id);
  const { device, stores: myStores, activeStoreId, switchStore, canSwitchStore } = useAuth();
  const canManage = usePermission('stores.manage');
  const canAudit = usePermission('audit.view');
  const canEdit = canManage && device?.mode !== 'store';

  const [tab, setTab] = useState<Tab>('overview');
  const [store, setStore] = useState<StoreRecord | null>(null);
  const [users, setUsers] = useState<StoreUser[]>([]);
  const [indicators, setIndicators] = useState<StoreIndicators | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [indicatorsLoading, setIndicatorsLoading] = useState(false);

  const [showEdit, setShowEdit] = useState(false);
  const [statusChange, setStatusChange] = useState<StatusChange | null>(null);
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);

  const [activity, setActivity] = useState<AuditEntry[] | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!Number.isInteger(storeId) || storeId <= 0) {
      setError('Magasin introuvable.');
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/magasins/${storeId}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(await readApiError(response, 'Le magasin n’a pas pu être chargé.'));
      const payload = await response.json();
      setStore(payload.store);
      setUsers(Array.isArray(payload.users) ? payload.users : []);
      setIndicators(payload.indicators ?? null);
      setFrom(payload.period?.from ?? '');
      setTo(payload.period?.to ?? '');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Le magasin n’a pas pu être chargé.');
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const reloadIndicators = async (nextFrom: string, nextTo: string) => {
    if (!nextFrom || !nextTo) return;
    if (nextFrom > nextTo) {
      toast.error('La date de début doit précéder la date de fin');
      return;
    }
    setIndicatorsLoading(true);
    try {
      const response = await fetch(
        `/api/magasins/${storeId}/indicateurs?${new URLSearchParams({ from: nextFrom, to: nextTo })}`,
        { cache: 'no-store', credentials: 'same-origin' },
      );
      if (!response.ok) throw new Error(await readApiError(response, 'Indicateurs indisponibles.'));
      const payload = await response.json();
      setIndicators(payload.indicators);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Indicateurs indisponibles.');
    } finally {
      setIndicatorsLoading(false);
    }
  };

  const loadActivity = useCallback(async () => {
    setActivityError(null);
    try {
      const query = new URLSearchParams({ store: String(storeId), central: 'false', limit: '30' });
      const response = await fetch(`/api/audit?${query}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(await readApiError(response, 'Le journal n’a pas pu être chargé.'));
      const payload = await response.json();
      setActivity(Array.isArray(payload.data) ? payload.data : []);
    } catch (caught) {
      setActivityError(caught instanceof Error ? caught.message : 'Le journal n’a pas pu être chargé.');
    }
  }, [storeId]);

  useEffect(() => {
    if (tab === 'activity' && activity === null && canAudit) void loadActivity();
  }, [tab, activity, canAudit, loadActivity]);

  const submitStatus = async () => {
    if (!statusChange) return;
    if (statusChange.needsReason && !reason.trim()) {
      toast.error('Indiquez le motif');
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/magasins/${storeId}/statut`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ status: statusChange.status, reason: reason.trim() || null }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Le statut n’a pas pu être modifié.'));
      setStore(await response.json());
      toast.success('Statut du magasin mis à jour');
      setStatusChange(null);
      setReason('');
      setActivity(null);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Le statut n’a pas pu être modifié.', {
        autoClose: 8000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const workHere = async () => {
    setIsSwitching(true);
    try {
      await switchStore(storeId);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Changement de magasin impossible');
      setIsSwitching(false);
    }
  };

  if (isLoading && !store) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <SkeletonCards count={4} />
      </div>
    );
  }

  if (error || !store) {
    return (
      <div className="mx-auto w-full max-w-7xl">
        <Card>
          <ErrorState description={error ?? 'Magasin introuvable.'} onRetry={() => void load()} />
        </Card>
      </div>
    );
  }

  const isMine = myStores.some((s) => s.id === store.id);
  const isActive = activeStoreId === store.id;
  const managers = users.filter((u) => u.is_manager && u.assignment_active);

  const statusActions = canEdit ? (
    <>
      {store.status !== 'active' && (
        <button
          type="button"
          className="btn btn-outline btn-success min-h-11 sm:min-h-0"
          onClick={() =>
            setStatusChange({ status: 'active', title: 'Réactiver le magasin', confirm: 'Réactiver', needsReason: false })
          }
        >
          Réactiver
        </button>
      )}
      {store.status === 'active' && (
        <button
          type="button"
          className="btn btn-outline btn-warning min-h-11 sm:min-h-0"
          onClick={() =>
            setStatusChange({ status: 'suspended', title: 'Suspendre le magasin', confirm: 'Suspendre', needsReason: true })
          }
        >
          Suspendre
        </button>
      )}
      {store.status !== 'archived' && (
        <button
          type="button"
          className="btn btn-ghost min-h-11 border border-base-300 sm:min-h-0"
          onClick={() =>
            setStatusChange({ status: 'archived', title: 'Archiver le magasin', confirm: 'Archiver', needsReason: true })
          }
        >
          Archiver
        </button>
      )}
      <button type="button" className="btn btn-primary min-h-11 sm:min-h-0" onClick={() => setShowEdit(true)}>
        Modifier
      </button>
    </>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/magasins" className="hover:underline">
            Magasins
          </Link>
        }
        title={store.name}
        description={[store.code, store.address].filter(Boolean).join(' · ')}
        actions={statusActions}
      />

      <div className="flex flex-wrap items-center gap-2">
        <StoreKindBadge kind={store.kind} />
        <StoreStatusBadge status={store.status} />
        {isActive && <Badge tone="primary">Magasin actif de votre session</Badge>}
        {canSwitchStore && isMine && !isActive && store.status === 'active' && (
          <button
            type="button"
            className="btn btn-sm btn-outline min-h-11 sm:min-h-0"
            disabled={isSwitching}
            onClick={() => void workHere()}
          >
            {isSwitching ? <span className="loading loading-spinner loading-xs" /> : 'Travailler dans ce magasin'}
          </button>
        )}
      </div>

      {store.status === 'suspended' && (
        <div className="alert border border-warning/30 bg-warning/10 text-sm">
          <span>
            <strong>Magasin suspendu.</strong> Son historique reste consultable, mais aucune vente,
            achat, opération de caisse ou transfert n’y est accepté.
          </span>
        </div>
      )}
      {store.status === 'archived' && (
        <div className="alert border border-base-300 bg-base-200/60 text-sm">
          <span>
            <strong>Magasin archivé.</strong> Il n’apparaît plus dans les listes courantes ; son
            historique est conservé.
          </span>
        </div>
      )}

      <div role="tablist" className="tabs tabs-border overflow-x-auto">
        {TABS.filter((t) => t.key !== 'activity' || canAudit).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab min-h-11 whitespace-nowrap ${tab === t.key ? 'tab-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-6">
          <Card>
            <div className="flex flex-wrap items-end gap-3">
              <FormField label="Du" className="w-full sm:w-48">
                <DatePicker
                  value={from}
                  onChange={(date) => {
                    setFrom(date);
                    void reloadIndicators(date, to);
                  }}
                  placeholder="jj mois aaaa"
                />
              </FormField>
              <FormField label="Au" className="w-full sm:w-48">
                <DatePicker
                  value={to}
                  onChange={(date) => {
                    setTo(date);
                    void reloadIndicators(from, date);
                  }}
                  placeholder="jj mois aaaa"
                />
              </FormField>
              {indicatorsLoading && <span className="loading loading-spinner loading-sm mb-3" />}
            </div>
          </Card>

          {indicators && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCardDelta
                label="Chiffre d’affaires"
                tooltip="Total des ventes validées de ce magasin entre les deux dates, payées ou non. Les ventes annulées et les brouillons ne comptent pas."
                value={<MoneyText value={indicators.revenue} />}
                hint={`${formatNumber(indicators.salesCount)} vente(s), panier moyen ${formatCurrency(indicators.averageBasket)}`}
              />
              <StatCardDelta
                label="Encaissements"
                tooltip="Argent réellement reçu des clients par ce magasin entre les deux dates (ventes et chantiers), quel que soit le moment de la vente."
                value={<MoneyText value={indicators.collected} />}
                hint="Paiements reçus sur la période"
              />
              <StatCardDelta
                label="Achats"
                value={<MoneyText value={indicators.purchases} />}
                hint="Factures fournisseurs actives"
                tooltip="Total des factures d’achat de marchandises enregistrées par ce magasin entre les deux dates, payées ou non."
              />
              <StatCardDelta
                label="Dépenses"
                tooltip="Frais du magasin (loyer, transport, salaires…) réellement payés entre les deux dates. Une dépense encore en attente d’approbation n’est pas comptée."
                value={<MoneyText value={indicators.expenses} />}
                hint="Dépenses décaissées sur la période"
              />
              <StatCardDelta
                label="Créances clients"
                tooltip="Argent que les clients doivent encore à ce magasin aujourd’hui : la partie non payée de ses factures en cours, toutes dates confondues."
                value={<MoneyText value={indicators.receivables} remaining />}
                hint="À ce jour, toutes périodes"
              />
              <StatCardDelta
                label="Dettes fournisseurs"
                tooltip="Argent que ce magasin doit encore à ses fournisseurs aujourd’hui : la partie non payée de ses factures d’achat."
                value={<MoneyText value={indicators.payables} remaining />}
                hint="À ce jour, toutes périodes"
              />
              <StatCardDelta
                label="Valeur du stock"
                tooltip="Ce que vaut la marchandise présente aujourd’hui dans ce magasin, calculée avec le prix d’achat de chaque produit."
                value={<MoneyText value={indicators.stockValue} />}
                hint="Au prix d’achat, à ce jour"
              />
              <StatCardDelta
                label="Alertes de stock"
                tooltip="Nombre de produits dont la quantité est descendue au niveau d’alerte fixé (ou en dessous) : pensez à les racheter ou à demander un transfert."
                value={formatNumber(indicators.lowStock)}
                hint={indicators.lowStock > 0 ? 'Produit(s) sous le seuil' : 'Aucun produit sous le seuil'}
                tone={indicators.lowStock > 0 ? 'warning' : 'success'}
              />
            </div>
          )}

          <PageSection title="Raccourcis" subtitle="Ouvrent l’écran filtré sur ce magasin.">
            <div className="flex flex-wrap gap-2">
              {[
                { href: '/ventes', label: 'Ventes' },
                { href: '/achats', label: 'Achats' },
                { href: '/stocks', label: 'Stocks' },
                { href: '/caisse', label: 'Caisse' },
                { href: '/depenses', label: 'Dépenses' },
                { href: '/transferts', label: 'Transferts' },
                { href: '/inventaires', label: 'Inventaires' },
                { href: '/rapports', label: 'Rapports' },
              ].map((link) => (
                <Link
                  key={link.href}
                  href={`${link.href}?store=${store.id}`}
                  className="btn btn-sm btn-ghost min-h-11 border border-base-300 sm:min-h-0"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </PageSection>
        </div>
      )}

      {tab === 'info' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <h3 className="mb-2 text-sm font-semibold">Coordonnées</h3>
            <InfoRow label="Code">
              <span className="font-mono">{store.code}</span>
            </InfoRow>
            <InfoRow label="Nom">{store.name}</InfoRow>
            <InfoRow label="Adresse">{store.address || '—'}</InfoRow>
            <InfoRow label="Téléphone">{store.phone || '—'}</InfoRow>
            <InfoRow label="E-mail">{store.email || '—'}</InfoRow>
          </Card>
          <Card>
            <h3 className="mb-2 text-sm font-semibold">Exploitation</h3>
            <InfoRow label="Gérant principal">{store.managerName || '—'}</InfoRow>
            <InfoRow label="Date d’ouverture">{store.openingDate ? formatDateShort(store.openingDate) : '—'}</InfoRow>
            <InfoRow label="Horaires">{store.openingHours || '—'}</InfoRow>
            <InfoRow label="Pied de ticket">{store.receiptFooter || '—'}</InfoRow>
            <InfoRow label="Créé le">{store.createdAt ? formatDateWithTime(store.createdAt) : '—'}</InfoRow>
          </Card>
          {store.notes && (
            <Card className="lg:col-span-2">
              <h3 className="mb-2 text-sm font-semibold">Notes</h3>
              <p className="whitespace-pre-line text-sm text-base-content/75">{store.notes}</p>
            </Card>
          )}
        </div>
      )}

      {tab === 'team' && (
        <PageSection
          title="Équipe affectée"
          subtitle={
            managers.length > 0
              ? `Gérant(s) : ${managers.map((m) => m.name).join(', ')}`
              : 'Aucun gérant désigné pour ce magasin.'
          }
          actions={
            <Link href={`/utilisateurs?storeId=${store.id}`} className="btn btn-sm btn-outline min-h-11 sm:min-h-0">
              Gérer les affectations
            </Link>
          }
        >
          {users.length === 0 ? (
            <Card>
              <EmptyState
                title="Aucun utilisateur affecté"
                description="Affectez des comptes à ce magasin depuis l’écran Utilisateurs."
              />
            </Card>
          ) : (
            <Card padded={false}>
              <ul className="divide-y divide-base-200">
                {users.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <div className="font-medium">{u.name}</div>
                      <div className="text-xs text-base-content/55">
                        {u.username} · {ROLE_LABELS[u.role] ?? u.role}
                        {(u.starts_at || u.ends_at) &&
                          ` · ${u.starts_at ? `du ${formatDateShort(u.starts_at)}` : ''}${u.ends_at ? ` au ${formatDateShort(u.ends_at)}` : ''}`}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {u.is_manager ? <Badge tone="primary">Gérant</Badge> : null}
                      {!u.assignment_active ? <Badge tone="neutral">Affectation terminée</Badge> : null}
                      {!u.is_active ? <Badge tone="error">Compte désactivé</Badge> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </PageSection>
      )}

      {tab === 'activity' && canAudit && (
        <PageSection
          title="Activité récente"
          subtitle="Les 30 dernières actions enregistrées dans ce magasin."
          actions={
            <Link href={`/utilisateurs/historique?store=${store.id}`} className="btn btn-sm btn-outline min-h-11 sm:min-h-0">
              Journal complet
            </Link>
          }
        >
          {activityError ? (
            <Card>
              <ErrorState description={activityError} onRetry={() => void loadActivity()} />
            </Card>
          ) : activity === null ? (
            <SkeletonCards count={2} />
          ) : activity.length === 0 ? (
            <Card>
              <EmptyState title="Aucune activité" description="Aucune action n’a encore été enregistrée dans ce magasin." />
            </Card>
          ) : (
            <Card padded={false}>
              <ul className="divide-y divide-base-200">
                {activity.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3 text-sm">
                    <span className="tabular text-xs text-base-content/55">
                      {entry.createdAt ? formatDateWithTime(entry.createdAt) : '—'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong>{entry.userName}</strong> — {auditActionLabel(entry.action)} ·{' '}
                      {auditEntityLabel(entry.entity)}
                      {entry.entityId ? ` n° ${entry.entityId}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </PageSection>
      )}

      <StoreFormModal
        isOpen={showEdit}
        store={store}
        onClose={() => setShowEdit(false)}
        onSaved={(saved) => {
          setShowEdit(false);
          toast.success('Magasin enregistré');
          setStore(saved);
          void load();
        }}
      />

      <ConfirmDialog
        isOpen={statusChange !== null}
        onClose={() => {
          if (!isSubmitting) {
            setStatusChange(null);
            setReason('');
          }
        }}
        onConfirm={() => void submitStatus()}
        title={statusChange?.title ?? ''}
        confirmLabel={statusChange?.confirm}
        tone={statusChange?.status === 'active' ? 'success' : 'warning'}
        isSubmitting={isSubmitting}
        message={
          statusChange?.status === 'suspended'
            ? `${store.name} ne pourra plus enregistrer de vente, d’achat, d’opération de caisse ni de transfert. Son historique reste consultable.`
            : statusChange?.status === 'archived'
              ? `${store.name} sera retiré des listes courantes. Impossible tant qu’une caisse est ouverte ou qu’un transfert est en cours. Rien n’est supprimé.`
              : `${store.name} pourra de nouveau enregistrer des opérations.`
        }
      >
        {statusChange?.needsReason && (
          <FormField label="Motif" required className="mb-4">
            <textarea
              rows={2}
              className="textarea textarea-bordered w-full"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex. travaux, fermeture saisonnière…"
            />
          </FormField>
        )}
      </ConfirmDialog>
    </div>
  );
}
