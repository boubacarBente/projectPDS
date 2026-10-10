'use client';

/**
 * Paramètres d'une filiale de production (README §31.1, §31.2).
 *
 * Lecture pour tout compte qui ouvre la filiale (nom, activité, magasin,
 * étapes, préfixes, accès, clients, caisse) ; modification, comptes autorisés
 * et statut pour le gestionnaire des filiales (`brick.branches`, siège) — le
 * serveur reste seul juge (`requireCentralEdit`, `lib/branches.ts`).
 */

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Card, InfoRow } from '@/components/design-system';
import { usePermission } from '@/components/role-gate';
import { NavIcon } from '@/components/nav-icons';
import { BrickTabs } from '@/components/briqueterie/brick-tabs';
import { useBranch } from '@/components/filiales/branch-context';
import { PageHeader } from '@/components/page-header';
import { BranchFormModal, BranchStatusDialog, BranchUsersModal } from '@/components/filiales/branch-admin';
import {
  BRANCH_ACCESS_LABELS,
  BRANCH_ACTIVITY_LABELS,
  BRANCH_COLOR_LABELS,
  BRANCH_ICON_LABELS,
  BRANCH_STATUS_LABELS,
  branchColorClasses,
  type BranchStatus,
} from '@/lib/branches-shared';

export default function BranchSettingsPage() {
  const { branch, reload } = useBranch();
  const canManage = usePermission('brick.branches');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isUsersOpen, setIsUsersOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<BranchStatus | null>(null);
  const color = branchColorClasses(branch.color);

  const afterChange = () => {
    reload();
    window.dispatchEvent(new Event('pd:branches-changed'));
  };

  return (
    <div className="mx-auto w-full max-w-7xl 2xl:max-w-[100rem] space-y-6 p-4 sm:p-6">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <span className={`inline-flex h-6 w-6 items-center justify-center rounded-lg ${color.soft}`}>
              <NavIcon iconKey={branch.icon} className="h-4 w-4" />
            </span>
            {branch.name}
          </span>
        }
        title="Paramètres"
        description={branch.description ?? BRANCH_ACTIVITY_LABELS[branch.activity]}
        actions={
          <>
            {canManage && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary min-h-11" onClick={() => setIsFormOpen(true)}>
              Modifier
            </button>
            <button type="button" className="btn btn-ghost min-h-11 border border-base-300" onClick={() => setIsUsersOpen(true)}>
              Comptes autorisés
            </button>
            {branch.status === 'active' ? (
              <button type="button" className="btn btn-ghost min-h-11 border border-base-300 text-warning" onClick={() => setStatusTarget('suspended')}>
                Suspendre
              </button>
            ) : (
              <button type="button" className="btn btn-ghost min-h-11 border border-base-300 text-success" onClick={() => setStatusTarget('active')}>
                Réactiver
              </button>
            )}
          </div>
        )}
          </>
        }
      />
      <BrickTabs />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-semibold">Identité et menu</h2>
          <InfoRow label="Nom affiché dans le menu">{branch.name}</InfoRow>
          <InfoRow label="Activité">{BRANCH_ACTIVITY_LABELS[branch.activity]}</InfoRow>
          <InfoRow label="Statut">{<Badge tone={branch.status === 'active' ? 'success' : 'warning'}>{BRANCH_STATUS_LABELS[branch.status]}</Badge>}</InfoRow>
          <InfoRow label="Icône">{BRANCH_ICON_LABELS[branch.icon]}</InfoRow>
          <InfoRow label="Couleur">{BRANCH_COLOR_LABELS[branch.color]}</InfoRow>
          <InfoRow label="Ordre dans le menu">{String(branch.sortOrder)}</InfoRow>
          <InfoRow label="Magasin">{branch.storeName ?? 'Tous les magasins'}</InfoRow>
        </Card>
        <Card>
          <h2 className="mb-3 font-semibold">Fabrication</h2>
          <InfoRow label="Étapes">{branch.flow.map((s) => s.label).join(' → ')}</InfoRow>
          <InfoRow label="Unité principale">{branch.unit}</InfoRow>
          <InfoRow label="Libellé des pertes">{branch.lossLabel}</InfoRow>
          <InfoRow label="Préfixe des productions">{branch.batchPrefix}</InfoRow>
          <InfoRow label="Préfixe des commandes">{branch.orderPrefix}</InfoRow>
        </Card>
        <Card>
          <h2 className="mb-3 font-semibold">Accès et clients</h2>
          <InfoRow label="Comptes">{branch.accessMode === 'restricted' ? 'Seulement les comptes autorisés' : 'Tous les comptes ayant les droits « Filiales »'}</InfoRow>
          <InfoRow label="Votre niveau">{BRANCH_ACCESS_LABELS[branch.access ?? 'view']}</InfoRow>
          <InfoRow label="Clients">{
              branch.customerMode === 'selected' ? (
                <Link href={`/filiales/${branch.id}/clients`} className="link link-primary">
                  Seulement les clients partagés
                </Link>
              ) : (
                'Tous les clients du magasin'
              )
            }</InfoRow>
        </Card>
        <Card>
          <h2 className="mb-3 font-semibold">Argent</h2>
          <InfoRow label="Caisse">Caisse du magasin, mouvements marqués « filiale »</InfoRow>
          <InfoRow label="Ventes">Dans l’espace de la filiale uniquement (jamais dans /ventes)</InfoRow>
          <InfoRow label="Dépenses">Circuit des dépenses : seuil d’approbation, décaissement par la caisse</InfoRow>
          <InfoRow label="Coûts et bénéfices">Visibles seulement avec le droit « Soldes et bénéfices »</InfoRow>
        </Card>
      </div>

      {canManage && (
        <>
          <BranchFormModal isOpen={isFormOpen} onClose={() => setIsFormOpen(false)} branch={branch} onSaved={afterChange} />
          <BranchUsersModal isOpen={isUsersOpen} onClose={() => setIsUsersOpen(false)} branch={branch} onSaved={afterChange} />
          <BranchStatusDialog branch={branch} target={statusTarget} onClose={() => setStatusTarget(null)} onDone={afterChange} />
        </>
      )}
    </div>
  );
}
