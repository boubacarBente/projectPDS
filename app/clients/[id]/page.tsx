'use client';

/**
 * Fiche client (README §7.2) — refonte visuelle calée sur la maquette du
 * client, adaptée à Planète Déco (quincaillerie, décoration, briqueterie,
 * atelier, chantiers : aucune notion de gaz).
 *
 * **Présentation seule** : les valeurs affichées viennent toutes de
 * `GET /api/clients/[id]` (`customer`, `invoiceCount`, `totalInvoiced`,
 * `totalPaid`, `balance`, `averageBasket`, bornes d'achat,
 * `creditLimitExceeded`, `topProducts`, `recentInvoices`). Aucune route n'est
 * modifiée, aucun total n'est inventé et rien n'est stocké (README §15).
 *
 * La seule donnée **calculée** ici est la série mensuelle du graphique
 * « Évolution des achats » : elle est agrégée **côté client**, à partir des
 * factures déjà renvoyées pour ce client (`recentInvoices`), filtrées sur les
 * factures **actives** — le même filtre que `totalInvoiced` côté API — pour que
 * la somme des barres corresponde au total facturé affiché.
 *
 * Écarts assumés avec la maquette (détaillés dans le rapport) :
 *   - aucune image de produit, aucune mention de gaz (données inexistantes) ;
 *   - pas de carte « Plafond du client » : le plafond est déjà dans
 *     « Informations du client » et dans l'encadré « Récapitulatif des
 *     encaissements », le dupliquer serait du bruit ;
 *   - **pas de pied de page** : la barre d'actions du bas de la maquette est un
 *     résidu des pages de saisie.
 *
 * Les 5 états sont couverts : squelette au chargement, `ErrorState` avec
 * « Réessayer », état vide explicite pour les factures et les produits, état
 * nominal, et toast pour le retour d'action.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'react-toastify';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  InfoRow,
  MoneyText,
  PageSection,
  QuantityText,
  SkeletonCards,
  SkeletonTable,
  StatusBadge,
} from '@/components/design-system';
import { CustomerMonthlyPurchasesChart, TopProductsChart } from '@/components/dashboard/dashboard-charts';
import { usePermission } from '@/components/role-gate';
import { Tooltip } from '@/components/tooltip';
import { ExportDropdown, shareOnWhatsApp } from '@/components/export-dropdown';
import {
  CustomerFormModal,
  PaymentModal,
  readApiError,
  type CustomerStatsRecord,
} from '@/components/clients/clients-modals';
import { useSettings } from '@/app/parametres/page';
import { DEFAULT_COMPANY_LOGO } from '@/lib/settings-schema';
import {
  exportCompanyFromSettings,
  exportDocumentAsImage,
  exportDocumentAsPDF,
  exportFileName,
  renderExportDocument,
} from '@/lib/export-document';
import { formatDateShort } from '@/lib/date-format';
import { formatCurrency, formatNumber, formatQuantity, today } from '@/lib/format';

type InvoiceRow = CustomerStatsRecord['recentInvoices'][number];

/** Fenêtre du graphique d'évolution (maquette : « 12 derniers mois »). */
const MONTHS_WINDOW = 12;

/**
 * Libellés de statut du **relevé exporté**.
 *
 * Recopiés volontairement : `lib/sales.ts` est un module **serveur** (il importe
 * `@/db`) — importer ses constantes ici ferait entrer `@libsql/client` et `fs`
 * dans le bundle du navigateur (README §26).
 */
const EXPORT_PAYMENT_STATUS: Record<string, string> = {
  paid: 'Payée',
  partial: 'Partiellement payée',
  unpaid: 'Impayée',
};

const EXPORT_DOCUMENT_STATUS: Record<string, string> = {
  active: 'Validée',
  draft: 'Brouillon',
  cancelled: 'Annulée',
};

/* ------------------------------------------------------------------ *
 * Briques visuelles locales (maquette) — copiées des pages tableau de
 * bord, ventes et achats validées : jetons du thème uniquement, aucune
 * couleur hexadécimale.
 * ------------------------------------------------------------------ */

/** Icône de tracé 24×24, `stroke` hérité (aucune couleur en dur). */
function Icon({
  d,
  children,
  className = 'h-5 w-5',
  strokeWidth = 1.8,
}: {
  d?: string;
  children?: React.ReactNode;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      aria-hidden
    >
      {children ?? <path strokeLinecap="round" strokeLinejoin="round" d={d} />}
    </svg>
  );
}

/** Teintes douces des pastilles (variantes /10 du thème). */
const PASTILLE_TONES = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  info: 'bg-info/10 text-info',
  accent: 'bg-accent/10 text-accent',
  warning: 'bg-warning/10 text-warning',
  error: 'bg-error/10 text-error',
  neutral: 'bg-base-200/80 text-base-content/60',
} as const;

type PastilleTone = keyof typeof PASTILLE_TONES;

/**
 * Explications affichées au survol (et au clavier) de l'**icône** de chaque carte
 * de métriques de la fiche client.
 *
 * Regroupées ici à la demande du client : un seul endroit à relire pour vérifier
 * ce que l'application affirme sur ses propres chiffres. Les clés sont les
 * libellés exacts des cartes.
 *
 * ⚠️ Ces phrases doivent rester **vraies** :
 *  - les quatre premiers montants sont **TTC** (`SUM(total)`, `SUM(amount_paid)`,
 *    `SUM(remaining_amount)`) ; le bénéfice brut est **HT** ;
 *  - la phrase du bénéfice dit « selon les prix enregistrés à la date de vente » :
 *    c'est l'évolution **prévue** (README Q20). Aujourd'hui le coût est lu sur le
 *    prix d'achat **actuel** du catalogue, donc modifier ce prix déplace la marge
 *    des ventes passées. À corriger ici le jour où le coût sera figé sur la ligne.
 */
const METRIC_TOOLTIPS = {
  'Solde à payer':
    'Montant restant à régler par le client sur l’ensemble de ses factures validées, toutes taxes comprises (TTC). Le solde s’affiche en rouge si un montant reste dû et en vert si tout est réglé.',

  'Total facturé':
    'Montant cumulé de toutes les factures validées émises au nom de ce client, toutes taxes comprises (TTC). Les factures en brouillon et annulées ne sont pas prises en compte.',

  'Total payé':
    'Montant total des paiements effectivement reçus de ce client. Chaque règlement est enregistré et associé à un reçu consultable dans l’historique des paiements.',

  'Panier moyen':
    'Montant moyen dépensé par commande. Il est calculé en divisant le total des factures validées par le nombre de factures correspondantes.',

  'Bénéfice brut':
    'Bénéfice brut généré par les ventes réalisées auprès de ce client. Il correspond au montant des ventes hors taxes, déduction faite du coût d’achat des marchandises, selon les prix enregistrés à la date de vente. Les factures en brouillon et annulées sont exclues.',
} as const;

/**
 * En-tête de carte : pastille d'icône carrée arrondie (~40 px) + titre gras +
 * sous-titre discret, actions éventuelles à droite (maquette).
 */
function CardTitle({
  icon,
  tone,
  title,
  subtitle,
  actions,
}: {
  icon: React.ReactNode;
  tone: PastilleTone;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${PASTILLE_TONES[tone]}`}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-base-content/60">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Carte de métrique : pastille colorée, libellé, valeur en gros.
 *
 * `hint` reste **facultatif** : la maquette affiche un pourcentage
 * d'évolution sous chaque carte, mais l'API ne renvoie aucune période de
 * comparaison pour un client — aucun chiffre n'est donc inventé ici.
 */
function MetricCard({
  label,
  value,
  hint,
  tone,
  icon,
  iconTooltip,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone: PastilleTone;
  icon: React.ReactNode;
  /**
   * Explication de la métrique, affichée au survol (et au focus) de l'**icône**.
   * Sert à lever un doute de lecture : montants TTC ici, bénéfice HT ailleurs.
   */
  iconTooltip?: React.ReactNode;
}) {
  return (
    <div className="surface-card min-w-0 border border-base-200 bg-base-100 p-4 shadow-sm sm:p-5">
      <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${PASTILLE_TONES[tone]}`}>
        {iconTooltip ? (
          <Tooltip label={iconTooltip}>
            {/* `tabIndex` : la bulle s'ouvre aussi au clavier, comme partout ailleurs. */}
            <span className="flex items-center justify-center" tabIndex={0}>
              {icon}
            </span>
          </Tooltip>
        ) : (
          icon
        )}
      </span>
      <p className="mt-3 truncate text-sm text-base-content/60">{label}</p>
      <p className="mt-1 truncate text-xl font-bold tabular sm:text-2xl">{value}</p>
      {hint && <p className="mt-1.5 truncate text-xs text-base-content/50">{hint}</p>}
    </div>
  );
}

/** Ligne « libellé / valeur » du récapitulatif, à fond alterné (maquette). */
function RecapRow({
  label,
  children,
  tinted = false,
}: {
  label: string;
  children: React.ReactNode;
  tinted?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${
        tinted ? 'bg-base-200/60' : 'bg-base-200/25'
      }`}
    >
      <span className="text-base-content/60">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

const ICONS = {
  /** Maison du fil d'Ariane (maquette). */
  home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2 2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  /** Carré primaire de l'en-tête : avatar de la fiche client. */
  customer:
    'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  phone:
    'M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z',
  pin: 'M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0zM15 11a3 3 0 11-6 0 3 3 0 016 0z',
  /** Billets — « Solde à payer ». */
  money:
    'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  /** Facture — « Total facturé ». */
  receipt:
    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  /** Portefeuille — « Total payé ». */
  wallet:
    'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
  /** Panier — « Panier moyen ». */
  basket: 'M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z',
  /** Barres du graphe « Évolution des achats ». */
  chart:
    'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  cube: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  checkCircle: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  alert:
    'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
  clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  calendar: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  shield:
    'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
} as const;

/**
 * La fenêtre du graphique : les `count` derniers mois **jusqu'au mois courant**
 * inclus. `Date` local : un décalage UTC ferait glisser un mois en début de
 * mois selon le fuseau.
 */
function lastMonths(count: number): string[] {
  const now = new Date();
  const months: string[] = [];

  for (let index = count - 1; index >= 0; index -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - index, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  return months;
}

/** `YYYY-MM-DD` → `YYYY-MM` (clé de regroupement mensuel). */
function monthKeyOf(date: string | null | undefined): string | null {
  if (typeof date !== 'string') return null;
  const key = date.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(key) ? key : null;
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default function ClientDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const customerId = Number(params?.id);

  const canPay = usePermission('payments.create');
  /** `balances.view` : seul ce rôle reçoit (et voit) le bénéfice brut du client. */
  const canViewProfit = usePermission('balances.view');
  const canUpdate = usePermission('customers.update');
  const { settings } = useSettings();

  const [stats, setStats] = useState<CustomerStatsRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  /* Un état booléen par modale (§8.3 règle 1). */
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  /** Modification de la fiche, ouverte depuis la fiche elle-même. */
  const [showEditModal, setShowEditModal] = useState(false);

  /** Verrou d'export : deux captures simultanées se marcheraient dessus. */
  const [isExporting, setIsExporting] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!Number.isInteger(customerId) || customerId <= 0) {
        setError('Identifiant client invalide.');
        setStatus(400);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/clients/${customerId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        });
        setStatus(response.status);

        if (!response.ok) {
          throw new Error(await readApiError(response, 'La fiche du client n’a pas pu être chargée.'));
        }

        setStats((await response.json()) as CustomerStatsRecord);
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        setStats(null);
        setError(
          caught instanceof Error ? caught.message : 'La fiche du client n’a pas pu être chargée.',
        );
      } finally {
        setIsLoading(false);
      }
    },
    [customerId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadToken]);

  const closePaymentModal = useCallback(() => setShowPaymentModal(false), []);

  /**
   * Après enregistrement de la fiche : on **recharge depuis l'API** au lieu de
   * recopier les champs reçus — le serveur fait foi, et un renommage doit se voir
   * partout (titre de la page, infobulle des reçus, relevé exporté).
   */
  const handleCustomerSaved = useCallback(() => {
    setShowEditModal(false);
    setReloadToken((token) => token + 1);
  }, []);

  /**
   * Série mensuelle « Évolution des achats » — **calcul côté client**.
   *
   * Source : `stats.recentInvoices`, déjà renvoyées par `GET /api/clients/[id]`
   * (les 10 dernières factures, tous statuts confondus). Seules les factures
   * **actives** sont retenues : c'est le filtre appliqué par l'API au total
   * facturé, donc la somme des barres retombe exactement sur « Total facturé ».
   * Une facture annulée ou un brouillon ne doit pas gonfler un achat.
   *
   * La fenêtre est le mois courant et les 11 mois précédents (12 mois). Un mois
   * sans facture vaut **0** et reste affiché : le graphe ne saute aucun mois.
   * Aucune route n'est appelée pour cela.
   */
  const monthlyPurchases = useMemo(() => {
    const buckets = new Map<string, number>();
    const window = lastMonths(MONTHS_WINDOW);
    window.forEach((month) => buckets.set(month, 0));

    (stats?.recentInvoices ?? []).forEach((invoice) => {
      if (invoice.status !== 'active') return;
      const key = monthKeyOf(invoice.date);
      // Hors fenêtre : ignoré, il ne doit pas être replié sur un autre mois.
      if (!key || !buckets.has(key)) return;
      buckets.set(key, (buckets.get(key) ?? 0) + (Number(invoice.total) || 0));
    });

    return window.map((month) => ({ month, total: buckets.get(month) ?? 0 }));
  }, [stats]);

  const purchasedMonths = useMemo(
    () => monthlyPurchases.filter((entry) => entry.total > 0.001).length,
    [monthlyPurchases],
  );

  const invoiceColumns = [
    {
      key: 'date',
      label: 'Date',
      className: 'whitespace-nowrap',
      render: (invoice: InvoiceRow) => (
        <span className="tabular text-base-content/70">{formatDateShort(invoice.date)}</span>
      ),
    },
    {
      key: 'invoiceNumber',
      label: 'Facture',
      primary: true,
      render: (invoice: InvoiceRow) => (
        <Link
          href={`/ventes/${invoice.id}`}
          className="font-semibold text-primary hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {invoice.invoiceNumber}
        </Link>
      ),
    },
    {
      key: 'total',
      label: 'Total',
      className: 'text-right whitespace-nowrap',
      render: (invoice: InvoiceRow) => <MoneyText value={invoice.total} bold />,
    },
    {
      key: 'amountPaid',
      label: 'Payé',
      hideOnMobile: true,
      className: 'text-right whitespace-nowrap',
      render: (invoice: InvoiceRow) => <MoneyText value={invoice.amountPaid} />,
    },
    {
      key: 'remainingAmount',
      label: 'Reste',
      className: 'text-right whitespace-nowrap',
      render: (invoice: InvoiceRow) =>
        /*
         * Même règle de couleur que le solde (§7.2) : rouge tant qu'il reste
         * quelque chose à encaisser, vert quand la facture est soldée. Les
         * factures annulées ou en brouillon restent **neutres** : leur « reste »
         * n'est pas encaissable, l'afficher en rouge serait un faux signal.
         */
        invoice.status === 'active' ? (
          <MoneyText value={invoice.remainingAmount} due bold={invoice.remainingAmount > 0.001} />
        ) : (
          <MoneyText value={invoice.remainingAmount} />
        ),
    },
    {
      key: 'paymentStatus',
      label: 'Statut',
      render: (invoice: InvoiceRow) => <StatusBadge status={invoice.paymentStatus} kind="payment" />,
    },
  ] satisfies Column<InvoiceRow>[];

  const customer = stats?.customer ?? null;
  const notFound = status === 404;

  const currency = settings.currency || 'GNF';
  const companyLogo = settings.companyLogo || DEFAULT_COMPANY_LOGO;
  const companyName = settings.companyName || 'Planète Déco';

  const hasDebt = (stats?.balance ?? 0) > 0.001;

  /*
   * Les deux boutons « Enregistrer un paiement » de la page (en-tête et
   * récapitulatif) déclenchent le même geste : une seule explication, pour
   * qu'elles ne divergent pas.
   *
   * Texte **imposé par le client** (recette) : repris mot pour mot. Il emploie
   * « règlement » et « mode de paiement » là où l'application dit ailleurs
   * « paiement » et « moyen de paiement » (libellé exact du champ du
   * formulaire) — c'est un choix assumé, validé tel quel. Ne pas le « corriger »
   * sans son accord.
   *
   * La bulle est élargie (`maxWidth`) car le texte fait plusieurs phrases : à
   * la largeur par défaut il s'étirerait sur sept lignes.
   */
  const paymentTooltip = (
    <>
      <strong>Enregistrer un paiement</strong>
      <span className="mt-1 block">
        Permet d&apos;enregistrer un règlement partiel ou total du client. Renseignez le
        montant, le mode de paiement et, si nécessaire, une note. Un reçu numéroté sera
        automatiquement généré, la caisse mise à jour et le solde restant recalculé.
      </span>
    </>
  );

  /*
   * Les **deux** liens qui mènent à `/clients/[id]/paiements` — « Historique des
   * paiements » dans l'en-tête et « Voir les encaissements » dans le
   * récapitulatif — partagent la même explication, définie une seule fois : deux
   * textes différents pour un même écran finiraient par se contredire.
   *
   * Vocabulaire d'ici : l'argent qui **entre** d'un client se dit « paiement »
   * ou « encaissement » (§7.2) — « règlement » y désigne le moyen de paiement ou
   * la sortie fournisseur.
   */
  const receiptsTooltip = (
    <>
      Ouvre l&apos;<strong>historique des paiements</strong> de{' '}
      {customer?.name ?? 'ce client'} : chaque encaissement enregistré, avec son{' '}
      <strong>reçu imprimable</strong>.
    </>
  );

  /* ------------------------------------------------------------------
   * Export et partage — PDF, image, WhatsApp
   *
   * Même mécanisme que la facture (`app/ventes/[id]`) et le reçu
   * (`app/recus/[id]`) : un document HTML **autonome**, en couleurs
   * hexadécimales uniquement, capturé dans un iframe invisible. On ne capture
   * jamais la page affichée : ses `oklch()` / `color-mix()` (Tailwind 4,
   * DaisyUI 5) font échouer la capture — détail dans `lib/export-document.ts`.
   * ------------------------------------------------------------------ */

  const fileBase = customer ? exportFileName('releve-client', customer.name) : 'releve-client';

  const exportHtml = useMemo(() => {
    if (!stats || !customer) return null;

    const money = (value: number) => formatCurrency(value, currency);
    /* Règle de couleur retenue : rouge dès que le client doit de l'argent,
       vert quand il n'a plus rien à payer. `danger`/`success` du gabarit. */
    const balanceTone = stats.balance > 0.001 ? ('danger' as const) : ('success' as const);

    return renderExportDocument({
      documentTitle: 'Relevé client',
      documentNumber: customer.name,
      documentDate: `Édité le ${formatDateShort(today())}`,
      badge:
        stats.balance > 0.001
          ? { label: 'Solde à payer', tone: 'danger' as const }
          : { label: 'À jour', tone: 'success' as const },
      company: exportCompanyFromSettings(settings),
      meta: [
        ['Téléphone', customer.phone || 'Non renseigné'],
        ['Adresse', customer.address || 'Non renseignée'],
        [
          'Plafond de crédit',
          customer.creditLimit > 0 ? money(customer.creditLimit) : 'Aucun plafond',
        ],
        ['Statut de la fiche', customer.isActive ? 'Actif' : 'Inactif'],
      ],
      blocks: [
        {
          kind: 'totals',
          title: 'Solde à payer',
          rows: [
            { label: 'Total facturé', value: money(stats.totalInvoiced) },
            { label: 'Total payé', value: money(stats.totalPaid), tone: 'success' as const },
            { label: 'Solde à payer', value: money(stats.balance), tone: balanceTone },
          ],
        },
        {
          kind: 'keyValue',
          title: 'Récapitulatif',
          rows: [
            ['Factures', formatNumber(stats.invoiceCount)],
            ['Panier moyen', money(stats.averageBasket)],
            [
              'Premier achat',
              stats.firstPurchaseDate ? formatDateShort(stats.firstPurchaseDate) : '—',
            ],
            [
              'Dernier achat',
              stats.lastPurchaseDate ? formatDateShort(stats.lastPurchaseDate) : '—',
            ],
          ],
        },
        {
          kind: 'table',
          title: 'Factures enregistrées',
          columns: [
            { label: 'Date' },
            { label: 'N° facture' },
            { label: 'Total', align: 'right' },
            { label: 'Payé', align: 'right' },
            { label: 'Reste', align: 'right' },
            { label: 'Règlement' },
            { label: 'Document' },
          ],
          numeric: [2, 3, 4],
          rows: stats.recentInvoices.map((invoice) => [
            formatDateShort(invoice.date),
            invoice.invoiceNumber,
            money(invoice.total),
            money(invoice.amountPaid),
            money(invoice.remainingAmount),
            EXPORT_PAYMENT_STATUS[invoice.paymentStatus] ?? invoice.paymentStatus,
            EXPORT_DOCUMENT_STATUS[invoice.status] ?? invoice.status,
          ]),
        },
        ...(stats.topProducts.length > 0
          ? [
              {
                kind: 'table' as const,
                title: 'Produits les plus achetés',
                columns: [
                  { label: 'Produit' },
                  { label: 'Quantité', align: 'right' as const },
                  { label: 'Montant', align: 'right' as const },
                ],
                numeric: [1, 2],
                rows: stats.topProducts.map((product) => [
                  product.productName,
                  formatQuantity(product.quantity),
                  money(product.amount),
                ]),
              },
            ]
          : []),
      ],
      notes: customer.notes?.trim() || null,
      footer:
        'Relevé de compte client — reprend les factures enregistrées à la date d’édition du document.',
    });
  }, [stats, customer, settings, currency]);

  const handleExportPDF = async () => {
    if (!exportHtml || isExporting) return;
    setIsExporting(true);
    try {
      await exportDocumentAsPDF(exportHtml, fileBase);
      toast.success('Relevé client exporté en PDF.');
    } catch (caught: any) {
      // Cause réelle affichée : un message générique rend l'échec indiagnosticable.
      toast.error(caught?.message ?? "Le PDF n'a pas pu être généré.", { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportImage = async () => {
    if (!exportHtml || isExporting) return;
    setIsExporting(true);
    try {
      await exportDocumentAsImage(exportHtml, fileBase);
      toast.success('Relevé client exporté en image.');
    } catch (caught: any) {
      toast.error(caught?.message ?? "L'image n'a pas pu être générée.", { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  };

  const handleShareWhatsApp = async () => {
    if (!exportHtml || !customer || !stats || isExporting) return;
    setIsExporting(true);
    try {
      const message = [
        `*${companyName}*`,
        `Relevé client — ${customer.name}`,
        `Total facturé : ${formatCurrency(stats.totalInvoiced, currency)}`,
        `Total payé : ${formatCurrency(stats.totalPaid, currency)}`,
        `Solde à payer : ${formatCurrency(stats.balance, currency)}`,
      ].join('\n');

      // Même document que le PDF et l'image : passer la page affichée
      // enverrait des classes Tailwind sans leur feuille de styles.
      await shareOnWhatsApp(exportHtml, message, `${fileBase}.png`, 'Relevé client');
    } catch (caught: any) {
      toast.error(caught?.message ?? 'Le partage WhatsApp n’a pas pu être effectué.', {
        autoClose: 10000,
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      {/* ── En-tête (maquette : fil d'Ariane, avatar, statut, actions, logo) ── */}
      <header className="rounded-3xl border border-base-200 bg-linear-to-r from-primary/10 to-base-100 p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-base-content/60">
              <Icon d={ICONS.home} className="h-3.5 w-3.5" />
              <Link href="/clients" className="hover:underline">
                Clients
              </Link>
              <span aria-hidden>›</span>
              <span className="font-medium">Détail client</span>
            </div>

            <div className="mt-3 flex min-w-0 items-center gap-3 sm:gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-content shadow-sm sm:h-12 sm:w-12">
                <Icon d={ICONS.customer} className="h-6 w-6" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="min-w-0 truncate text-2xl font-bold tracking-tight sm:text-3xl">
                    {customer?.name ?? (isLoading ? 'Chargement…' : 'Client')}
                  </h1>
                  {customer &&
                    (customer.isActive ? (
                      <Badge tone="success">Actif</Badge>
                    ) : (
                      <Badge tone="neutral">Inactif</Badge>
                    ))}
                  {stats?.creditLimitExceeded && <Badge tone="warning">Plafond dépassé</Badge>}
                </div>

                {/* Téléphone et adresse : uniquement s'ils existent. */}
                {(customer?.phone || customer?.address) && (
                  <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-base-content/60">
                    {customer?.phone && (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon d={ICONS.phone} className="h-4 w-4 shrink-0" />
                        <span className="tabular truncate">{customer.phone}</span>
                      </span>
                    )}
                    {customer?.address && (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon d={ICONS.pin} className="h-4 w-4 shrink-0" />
                        <span className="truncate">{customer.address}</span>
                      </span>
                    )}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Actions existantes + logo de la société (règle des autres pages). */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Link href="/clients" className="btn btn-ghost btn-sm min-h-11 gap-1.5 sm:min-h-0">
              <Icon d="M10 19l-7-7m0 0l7-7m-7 7h18" className="h-4 w-4" strokeWidth={2} />
              Retour à la liste
            </Link>
            {customer && (
              <Tooltip label={receiptsTooltip}>
                <Link
                  href={`/clients/${customer.id}/paiements`}
                  className="btn btn-outline btn-sm min-h-11 gap-1.5 sm:min-h-0"
                >
                  <Icon d={ICONS.wallet} className="h-4 w-4" />
                  Historique des paiements
                </Link>
              </Tooltip>
            )}
            {canPay && customer && stats && hasDebt && (
              <Tooltip label={paymentTooltip} maxWidth="min(26rem, calc(100vw - 1rem))">
                <button
                  type="button"
                  className="btn btn-success btn-sm min-h-11 gap-1.5 text-success-content sm:min-h-0"
                  onClick={() => setShowPaymentModal(true)}
                >
                  <Icon d={ICONS.money} className="h-4 w-4" />
                  Enregistrer un paiement
                </button>
              </Tooltip>
            )}
            {customer && stats && (
              <ExportDropdown
                onExportPDF={() => void handleExportPDF()}
                onExportImage={() => void handleExportImage()}
                onShareWhatsApp={() => void handleShareWhatsApp()}
                label="Exporter"
              />
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={companyLogo}
              alt={`Logo ${companyName}`}
              className="h-11 w-11 shrink-0 rounded-xl object-contain sm:h-14 sm:w-14"
            />
          </div>
        </div>
      </header>

      {isLoading && (
        <>
          <SkeletonCards count={4} />
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <SkeletonTable rows={5} cols={3} />
            </div>
            <SkeletonTable rows={5} cols={2} />
          </div>
          <SkeletonTable rows={4} cols={4} />
        </>
      )}

      {!isLoading && error && (
        <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
          {notFound ? (
            <EmptyState
              title="Client introuvable"
              description="Cette fiche n’existe pas ou a été désactivée. Revenez à la liste pour choisir un autre client."
              action={
                <Link href="/clients" className="btn btn-primary min-h-11 sm:min-h-0">
                  Retour à la liste des clients
                </Link>
              }
            />
          ) : (
            <ErrorState
              title="Impossible de charger la fiche client"
              description={error}
              onRetry={() => setReloadToken((token) => token + 1)}
            />
          )}
        </div>
      )}

      {!isLoading && !error && stats && customer && (
        <>
          {/* ── Cartes de métriques : uniquement des valeurs déjà calculées ── */}
          <div
            className={`grid gap-4 sm:grid-cols-2 ${
              canViewProfit && stats.profit !== null ? 'xl:grid-cols-5' : 'xl:grid-cols-4'
            }`}
          >
            {/*
              * Chaque icône explique **sa** métrique au survol (et au clavier) :
              * les textes sont regroupés dans `METRIC_TOOLTIPS` en tête de
              * fichier, pour qu'on les relise tous d'un coup d'œil.
              */}
            <MetricCard
              label="Solde à payer"
              value={<MoneyText value={stats.balance} due bold />}
              hint={hasDebt ? 'Reste dû par ce client' : 'Aucun encours'}
              tone={hasDebt ? 'error' : 'success'}
              icon={<Icon d={ICONS.money} />}
              iconTooltip={METRIC_TOOLTIPS['Solde à payer']}
            />
            <MetricCard
              label="Total facturé"
              value={<MoneyText value={stats.totalInvoiced} bold />}
              tone="info"
              icon={<Icon d={ICONS.receipt} />}
              iconTooltip={METRIC_TOOLTIPS['Total facturé']}
            />
            <MetricCard
              label="Total payé"
              value={<MoneyText value={stats.totalPaid} bold />}
              tone="success"
              icon={<Icon d={ICONS.wallet} />}
              iconTooltip={METRIC_TOOLTIPS['Total payé']}
            />
            <MetricCard
              label="Panier moyen"
              value={<MoneyText value={stats.averageBasket} bold />}
              tone="accent"
              icon={<Icon d={ICONS.basket} />}
              iconTooltip={METRIC_TOOLTIPS['Panier moyen']}
            />
            {/*
              * Bénéfice brut **de ce client** : Σ (total HT de ses ventes
              * validées) − coût des marchandises vendues. C'est la somme des
              * bénéfices de ses factures (colonne « Bénéfice » de la liste des
              * ventes), donc aucun second calcul susceptible de diverger.
              *
              * `null` veut dire « pas le droit » (`balances.view`) : le serveur
              * ne l'envoie pas. Vert si le client rapporte, rouge s'il a été
              * vendu à perte. Jamais exporté : le relevé part chez le client.
              */}
            {canViewProfit && stats.profit !== null && (
              <MetricCard
                label="Bénéfice brut"
                value={<MoneyText value={stats.profit} colored bold />}
                hint="Ventes HT − coût"
                tone={stats.profit >= 0 ? 'success' : 'error'}
                icon={<Icon d={ICONS.chart} />}
                iconTooltip={METRIC_TOOLTIPS['Bénéfice brut']}
              />
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* ── Informations du client ── */}
            <Card className="min-w-0 lg:col-span-2">
              <CardTitle
                icon={<Icon d={ICONS.customer} />}
                tone="primary"
                title="Informations du client"
                subtitle="Coordonnées, plafond et repères d’achat."
                actions={
                  customer.isActive ? (
                    <Badge tone="success">Actif</Badge>
                  ) : (
                    <Badge tone="neutral">Inactif</Badge>
                  )
                }
              />

              <div className="mt-4 divide-y divide-base-200/70">
                <InfoRow label="Téléphone">
                  {customer.phone ? (
                    <span className="tabular">{customer.phone}</span>
                  ) : (
                    <span className="font-normal text-base-content/50">Non renseigné</span>
                  )}
                </InfoRow>
                <InfoRow label="Adresse">
                  {customer.address || (
                    <span className="font-normal text-base-content/50">Non renseignée</span>
                  )}
                </InfoRow>
                <InfoRow label="Plafond de crédit">
                  {customer.creditLimit > 0 ? (
                    <MoneyText value={customer.creditLimit} />
                  ) : (
                    <span className="font-normal text-base-content/50">Aucun plafond</span>
                  )}
                </InfoRow>
                <InfoRow label="Nombre de factures">
                  <span className="tabular">{formatNumber(stats.invoiceCount)}</span>
                </InfoRow>
                <InfoRow label="Premier achat">{formatDateShort(stats.firstPurchaseDate)}</InfoRow>
                <InfoRow label="Dernier achat">{formatDateShort(stats.lastPurchaseDate)}</InfoRow>
                <InfoRow label="Fiche créée le">{formatDateShort(customer.createdAt)}</InfoRow>
                <InfoRow label="Informations utiles">
                  <span className="font-normal text-base-content/70">{customer.notes || '—'}</span>
                </InfoRow>
              </div>

              {canUpdate && (
                <div className="mt-4 flex flex-wrap gap-2 border-t border-base-200 pt-4">
                  {/*
                   * Ouvre la **modale d'édition** (celle de la liste des clients),
                   * pré-remplie avec cette fiche. Avant, ce bouton était un lien
                   * vers `/clients` : il n'annonçait pas ce qu'il faisait et
                   * obligeait à rouvrir la fiche pour la modifier.
                   */}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm min-h-11 gap-1.5 border border-base-300 sm:min-h-0"
                    onClick={() => setShowEditModal(true)}
                  >
                    <Icon d={ICONS.edit} className="h-4 w-4" />
                    Modifier
                  </button>
                </div>
              )}
            </Card>

            {/* ── Récapitulatif des encaissements ── */}
            <Card className="min-w-0 space-y-3">
              <CardTitle
                icon={<Icon d={ICONS.wallet} />}
                tone="success"
                title="Récapitulatif des encaissements"
                subtitle="Montants calculés à la lecture."
              />

              <div className="space-y-1.5 pt-1">
                <RecapRow label="Total facturé">
                  <MoneyText value={stats.totalInvoiced} />
                </RecapRow>
                <RecapRow label="Total encaissé" tinted>
                  <MoneyText value={stats.totalPaid} />
                </RecapRow>
                <RecapRow label="Reste à payer">
                  <MoneyText value={stats.balance} due bold />
                </RecapRow>
              </div>

              {/* Message existant du plafond de crédit : teinte + libellé. */}
              {stats.creditLimitExceeded ? (
                <p className="flex items-start gap-2 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
                  <Icon d={ICONS.alert} className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Le solde dépasse le plafond de crédit de{' '}
                    <MoneyText value={customer.creditLimit} />. L&apos;application avertit, elle ne
                    bloque pas la vente.
                  </span>
                </p>
              ) : (
                <p className="flex items-start gap-2 rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                  <Icon d={ICONS.checkCircle} className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Encours dans le plafond autorisé.</span>
                </p>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                {/* Même explication que le lien « Historique des paiements » de
                    l'en-tête : `receiptsTooltip` est défini une seule fois. */}
                <Tooltip label={receiptsTooltip}>
                  <Link
                    href={`/clients/${customer.id}/paiements`}
                    className="btn btn-ghost btn-sm min-h-11 border border-base-300 sm:min-h-0"
                  >
                    Voir les encaissements
                  </Link>
                </Tooltip>
                {canPay && hasDebt && (
                  <Tooltip label={paymentTooltip} maxWidth="min(26rem, calc(100vw - 1rem))">
                    <button
                      type="button"
                      className="btn btn-success btn-sm min-h-11 gap-1.5 text-success-content sm:min-h-0"
                      onClick={() => setShowPaymentModal(true)}
                    >
                      <Icon d={ICONS.money} className="h-4 w-4" />
                      Enregistrer un paiement
                    </button>
                  </Tooltip>
                )}
              </div>
            </Card>
          </div>

          {/* ── Graphiques : évolution des achats + produits les plus achetés ── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardTitle
                icon={<Icon d={ICONS.chart} />}
                tone="primary"
                title="Évolution des achats (12 derniers mois)"
                subtitle={
                  purchasedMonths > 0
                    ? `Achats de ce client par mois — ${stats.recentInvoices.filter((invoice) => invoice.status === 'active').length} facture(s) active(s) sur la fenêtre.`
                    : 'Aucun achat sur les 12 derniers mois.'
                }
              />
              <div className="mt-4">
                <CustomerMonthlyPurchasesChart data={monthlyPurchases} currency={currency} />
              </div>
            </Card>

            <Card className="min-w-0">
              <CardTitle
                icon={<Icon d={ICONS.cube} />}
                tone="info"
                title="Produits les plus achetés"
                subtitle="Cinq produits les plus achetés par ce client, par montant cumulé."
              />
              <div className="mt-4">
                {stats.topProducts.length === 0 ? (
                  <EmptyState
                    title="Aucun produit acheté"
                    description="Les produits apparaîtront ici dès la première vente enregistrée pour ce client."
                  />
                ) : (
                  <>
                    <TopProductsChart data={stats.topProducts} />

                    {/*
                     * Tableau produit / quantité / montant de la maquette.
                     * `min-w-0` + `truncate` : la colonne du nom se comprime,
                     * jamais de défilement horizontal.
                     */}
                    <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-2 border-t border-base-200 pt-3 text-sm">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-base-content/50">
                        Produit
                      </span>
                      <span className="text-right text-[10px] font-semibold uppercase tracking-wide text-base-content/50">
                        Quantité
                      </span>
                      <span className="text-right text-[10px] font-semibold uppercase tracking-wide text-base-content/50">
                        Montant
                      </span>

                      {stats.topProducts.map((product) => (
                        <Fragment key={product.productName}>
                          <span className="truncate font-medium">{product.productName}</span>
                          <span className="text-right">
                            <QuantityText value={product.quantity} />
                          </span>
                          <span className="text-right">
                            <MoneyText value={product.amount} />
                          </span>
                        </Fragment>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </Card>
          </div>

          {/* ── Dernières factures ── */}
          <PageSection
            title="Dernières factures"
            subtitle="Cliquez sur une ligne pour ouvrir la facture."
          >
            {stats.recentInvoices.length === 0 ? (
              <div className="surface-card border border-base-200 bg-base-100 shadow-sm">
                <EmptyState
                  title="Aucune facture"
                  description="Ce client n’a pas encore d’achat enregistré. Créez une vente depuis le module Ventes pour alimenter son historique."
                  action={
                    <Link href="/ventes" className="btn btn-primary min-h-11 sm:min-h-0">
                      Aller aux ventes
                    </Link>
                  }
                />
              </div>
            ) : (
              <ResponsiveTable
                columns={invoiceColumns}
                data={stats.recentInvoices}
                getRowKey={(invoice) => invoice.id}
                tableClassName="table-sm"
                onRowClick={(invoice) => router.push(`/ventes/${invoice.id}`)}
              />
            )}
          </PageSection>
        </>
      )}

      {/* Aucun pied de page : demande explicite du client (résidu des pages de saisie). */}

      {/*
        * Modification de la fiche **depuis la fiche elle-même** : on réutilise la
        * modale de la liste des clients (`CustomerFormModal`) en mode édition.
        * Elle enregistre elle-même (`PUT /api/clients/[id]`) : c'est son
        * `onSaved` qui ferme et déclenche le rechargement.
        */}
      {customer && (
        <CustomerFormModal
          isOpen={showEditModal}
          onClose={() => setShowEditModal(false)}
          onSaved={handleCustomerSaved}
          customer={customer}
          idPrefix="detail-edit"
        />
      )}

      {customer && (
        <PaymentModal
          isOpen={showPaymentModal}
          onClose={closePaymentModal}
          customer={{ id: customer.id, name: customer.name, balance: stats?.balance ?? 0 }}
          onRecorded={(payment) => {
            toast.success(`Paiement enregistré — reçu ${payment.receiptNumber}.`);
            setReloadToken((token) => token + 1);
          }}
        />
      )}
    </div>
  );
}
