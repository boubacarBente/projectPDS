'use client';

/**
 * Blocs réutilisables de la page `/soldes` (§10, §15).
 *
 * Trois blocs indépendants, montés par l'onglet actif :
 *  - `ReceivablesSection` : créances clients ;
 *  - `PayablesSection` : dettes fournisseurs ;
 *  - `ProfitabilitySection` : résultat de la période + produits les plus rentables.
 *
 * ⚠️ Composant **client** : aucun import à l'exécution d'un module serveur
 * (`lib/balances.ts`, `lib/dashboard.ts`… sont serveur — §11 bis). Les types
 * passent par `import type`, donc effacés à la compilation ; les données
 * arrivent par l'API.
 *
 * Toute liste passe par `ResponsiveTable`, tout montant par `MoneyText`, toute
 * quantité par `QuantityText` (CONVENTIONS §8).
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ResponsiveTable, type Column } from '@/components/responsive-table';
import { Badge, MiniStat, MoneyText, QuantityText } from '@/components/design-system';
import { formatNumber, formatPercent, DEFAULT_CURRENCY } from '@/lib/format';
import { formatDateShort, formatMonthYear } from '@/lib/date-format';
import type {
  BalancesSummary,
  ClientBalanceRow,
  ProductMarginRow,
  SupplierBalanceRow,
} from '@/lib/balances';

/* ------------------------------------------------------------------ *
 * Créances clients
 * ------------------------------------------------------------------ */

export function ReceivablesSection({
  clients,
  currency = DEFAULT_CURRENCY,
}: {
  clients: ClientBalanceRow[];
  currency?: string;
}) {
  const columns = useMemo<Column<ClientBalanceRow>[]>(
    () => [
      {
        key: 'name',
        label: 'Client',
        primary: true,
        render: (client) => (
          <Link
            href={`/clients/${client.id}`}
            className="font-medium text-primary hover:underline"
            title={`Ouvrir la fiche de ${client.name}`}
          >
            {client.name}
          </Link>
        ),
      },
      {
        key: 'phone',
        label: 'Téléphone',
        hideOnMobile: true,
        render: (client) => (
          <span className="text-sm text-base-content/70">{client.phone || '—'}</span>
        ),
      },
      {
        key: 'invoiceCount',
        label: 'Factures',
        className: 'text-right',
        render: (client) => <span className="tabular">{formatNumber(client.invoiceCount)}</span>,
      },
      {
        key: 'totalInvoiced',
        label: 'Total facturé',
        className: 'text-right',
        hideOnMobile: true,
        render: (client) => <MoneyText value={client.totalInvoiced} currency={currency} />,
      },
      {
        key: 'totalPaid',
        label: 'Déjà payé',
        className: 'text-right',
        hideOnMobile: true,
        render: (client) => <MoneyText value={client.totalPaid} currency={currency} />,
      },
      {
        key: 'balance',
        label: 'Solde dû',
        className: 'text-right',
        render: (client) => (
          <MoneyText value={client.balance} currency={currency} colored bold />
        ),
      },
      {
        key: 'oldestDueDate',
        label: 'Échéance',
        render: (client) => (
          <span className="whitespace-nowrap text-sm">
            {client.oldestDueDate ? formatDateShort(client.oldestDueDate) : '—'}
          </span>
        ),
      },
      {
        key: 'overdue',
        label: 'Retard',
        render: (client) =>
          client.overdue ? <Badge tone="error">En retard</Badge> : <Badge tone="success">À jour</Badge>,
      },
    ],
    [currency],
  );

  return (
    <div className="surface-card overflow-hidden border border-base-200 bg-base-100 shadow-sm">
      <ResponsiveTable
        columns={columns}
        data={clients}
        getRowKey={(client) => client.id}
        emptyMessage="Aucun client débiteur : toutes les factures sont réglées."
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Dettes fournisseurs
 * ------------------------------------------------------------------ */

export function PayablesSection({
  suppliers,
  currency = DEFAULT_CURRENCY,
}: {
  suppliers: SupplierBalanceRow[];
  currency?: string;
}) {
  const columns = useMemo<Column<SupplierBalanceRow>[]>(
    () => [
      {
        key: 'name',
        label: 'Fournisseur',
        primary: true,
        render: (supplier) => (
          <Link
            href={`/fournisseurs/${supplier.id}`}
            className="font-medium text-primary hover:underline"
            title={`Ouvrir la fiche de ${supplier.name}`}
          >
            {supplier.name}
          </Link>
        ),
      },
      {
        key: 'phone',
        label: 'Téléphone',
        hideOnMobile: true,
        render: (supplier) => (
          <span className="text-sm text-base-content/70">{supplier.phone || '—'}</span>
        ),
      },
      {
        key: 'purchaseCount',
        label: 'Achats',
        className: 'text-right',
        render: (supplier) => <span className="tabular">{formatNumber(supplier.purchaseCount)}</span>,
      },
      {
        key: 'totalPurchased',
        label: 'Total acheté',
        className: 'text-right',
        hideOnMobile: true,
        render: (supplier) => <MoneyText value={supplier.totalPurchased} currency={currency} />,
      },
      {
        key: 'totalPaid',
        label: 'Déjà payé',
        className: 'text-right',
        hideOnMobile: true,
        render: (supplier) => <MoneyText value={supplier.totalPaid} currency={currency} />,
      },
      {
        key: 'balance',
        label: 'Reste à payer',
        className: 'text-right',
        render: (supplier) => (
          <MoneyText value={supplier.balance} currency={currency} colored bold />
        ),
      },
      {
        key: 'oldestDueDate',
        label: 'Échéance',
        render: (supplier) => (
          <span className="whitespace-nowrap text-sm">
            {supplier.oldestDueDate ? formatDateShort(supplier.oldestDueDate) : '—'}
          </span>
        ),
      },
      {
        key: 'overdue',
        label: 'Retard',
        render: (supplier) =>
          supplier.overdue ? <Badge tone="error">En retard</Badge> : <Badge tone="success">À jour</Badge>,
      },
    ],
    [currency],
  );

  return (
    <div className="surface-card overflow-hidden border border-base-200 bg-base-100 shadow-sm">
      <ResponsiveTable
        columns={columns}
        data={suppliers}
        getRowKey={(supplier) => supplier.id}
        emptyMessage="Aucune dette fournisseur : tous les achats sont réglés."
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Résultat de la période
 * ------------------------------------------------------------------ */

/**
 * Composition du bénéfice (README §15) : CA → coût des marchandises → marge
 * brute → dépenses et main-d'œuvre → bénéfice net. Chaque ligne est un
 * `MiniStat` : la couleur ne porte jamais seule l'information.
 */
export function ProfitResultSection({
  summary,
  currency = DEFAULT_CURRENCY,
}: {
  summary: BalancesSummary;
  currency?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <MiniStat
          label="Chiffre d'affaires"
          value={<MoneyText value={summary.revenue} currency={currency} />}
          tone="primary"
        />
        <MiniStat
          label="Coût des marchandises"
          value={<MoneyText value={summary.cogs} currency={currency} />}
          tone="info"
        />
        <MiniStat
          label="Marge brute"
          value={<MoneyText value={summary.grossProfit} currency={currency} />}
          tone={summary.grossProfit >= 0 ? 'success' : 'error'}
        />
        <MiniStat
          label="Dépenses"
          value={<MoneyText value={summary.expenses} currency={currency} />}
          tone="warning"
        />
        <MiniStat
          label="Main-d'œuvre"
          value={<MoneyText value={summary.laborCost} currency={currency} />}
          tone="warning"
        />
        <MiniStat
          label="Bénéfice net"
          value={<MoneyText value={summary.netProfit} currency={currency} />}
          tone={summary.netProfit >= 0 ? 'success' : 'error'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-base-content/60">
        <Badge tone={summary.grossMarginPercent >= 0 ? 'success' : 'error'}>
          Marge brute {formatPercent(summary.grossMarginPercent)}
        </Badge>
        <span>
          Bénéfice net = marge brute − dépenses − main-d&apos;œuvre. Aucun de ces montants
          n&apos;est stocké : tout est recalculé à la lecture.
        </span>
      </div>

      {summary.jobsRevenue > 0 && (
        <p className="border-t border-base-200 pt-3 text-xs leading-5 text-base-content/60">
          Dont <strong>{formatNumber(summary.jobsCount)}</strong> prestation(s) de chantier pour{' '}
          <MoneyText value={summary.jobsRevenue} currency={currency} /> — les chantiers sont des
          documents facturables <strong>autonomes</strong> : ce montant s&apos;ajoute au chiffre
          d&apos;affaires des ventes, il ne le double-compte jamais (§15).
          {summary.jobsMaterialCost > 0 && (
            <>
              {' '}
              Les matériaux consommés par ces chantiers (
              <MoneyText value={summary.jobsMaterialCost} currency={currency} />) sont comptés dans
              le coût des marchandises.
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Tendance sur douze mois : chiffre d'affaires, dépenses et résultat avant coût
 * d'achat. Barres construites en `div` — aucune librairie de graphiques n'est
 * importée ici, et la teinte reste un jeton du thème.
 */
export function MonthlyTrendSection({
  months,
  currency = DEFAULT_CURRENCY,
}: {
  months: BalancesSummary['byMonth'];
  currency?: string;
}) {
  const max = months.reduce((acc, month) => Math.max(acc, month.revenue, month.expenses), 0);

  if (months.length === 0 || max <= 0) {
    return (
      <p className="py-6 text-center text-sm text-base-content/50">
        Aucun mouvement sur les douze derniers mois.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-base-content/60">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-primary" aria-hidden /> Chiffre d&apos;affaires
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-warning" aria-hidden /> Dépenses
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-success" aria-hidden /> Résultat avant coût
          d&apos;achat
        </span>
      </div>

      <ul className="space-y-2">
        {months.map((month) => {
          const revenueWidth = max > 0 ? Math.round((month.revenue / max) * 100) : 0;
          const expensesWidth = max > 0 ? Math.round((month.expenses / max) * 100) : 0;
          const profitWidth = max > 0 ? Math.round((Math.max(month.profit, 0) / max) * 100) : 0;

          return (
            <li key={month.month} className="grid grid-cols-[7.5rem_1fr] items-center gap-3">
              <span className="truncate text-xs text-base-content/60">
                {formatMonthYear(`${month.month}-01`)}
              </span>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-base-300/50">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${revenueWidth}%` }}
                    />
                  </div>
                  <MoneyText value={month.revenue} currency={currency} className="w-32 shrink-0 text-right text-[11px]" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-base-300/50">
                    <div
                      className="h-full rounded-full bg-warning"
                      style={{ width: `${expensesWidth}%` }}
                    />
                  </div>
                  <MoneyText value={month.expenses} currency={currency} className="w-32 shrink-0 text-right text-[11px]" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-base-300/50">
                    <div
                      className="h-full rounded-full bg-success"
                      style={{ width: `${profitWidth}%` }}
                    />
                  </div>
                  <MoneyText
                    value={month.profit}
                    currency={currency}
                    colored
                    className="w-32 shrink-0 text-right text-[11px]"
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Produits les plus rentables
 * ------------------------------------------------------------------ */

type MarginSort = 'cumulative' | 'unit';

/** Marge par produit : marge **unitaire** et marge **cumulée** (§15). */
export function ProductMarginsSection({
  margins,
  currency = DEFAULT_CURRENCY,
}: {
  margins: ProductMarginRow[];
  currency?: string;
}) {
  const [sort, setSort] = useState<MarginSort>('cumulative');

  const rows = useMemo(() => {
    if (sort === 'cumulative') return margins;
    return [...margins].sort((a, b) => b.unitMargin - a.unitMargin);
  }, [margins, sort]);

  const columns = useMemo<Column<ProductMarginRow>[]>(
    () => [
      {
        key: 'productName',
        label: 'Produit',
        primary: true,
        render: (row) => <span className="font-medium">{row.productName}</span>,
      },
      {
        key: 'quantity',
        label: 'Quantité vendue',
        className: 'text-right',
        render: (row) => <QuantityText value={row.quantity} />,
      },
      {
        key: 'unitMargin',
        label: 'Marge unitaire',
        className: 'text-right',
        render: (row) => (
          <MoneyText value={row.unitMargin} currency={currency} colored bold={sort === 'unit'} />
        ),
      },
      {
        key: 'margin',
        label: 'Marge cumulée',
        className: 'text-right',
        render: (row) => (
          <MoneyText
            value={row.margin}
            currency={currency}
            colored
            bold={sort === 'cumulative'}
          />
        ),
      },
      {
        key: 'marginPercent',
        label: 'Taux',
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => (
          <Badge tone={row.marginPercent >= 0 ? 'success' : 'error'}>
            {formatPercent(row.marginPercent)}
          </Badge>
        ),
      },
      {
        key: 'revenue',
        label: 'Chiffre d’affaires',
        className: 'text-right',
        hideOnMobile: true,
        render: (row) => <MoneyText value={row.revenue} currency={currency} />,
      },
    ],
    [currency, sort],
  );

  return (
    <div className="surface-card overflow-hidden border border-base-200 bg-base-100 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/40 px-4 py-3">
        <span className="text-xs text-base-content/60">
          Marge = (prix de vente − prix d&apos;achat du jour) × quantité vendue.
        </span>
        <div className="flex items-center gap-1 rounded-xl border border-base-200 bg-base-100 p-1">
          <button
            type="button"
            onClick={() => setSort('cumulative')}
            aria-pressed={sort === 'cumulative'}
            className={`btn btn-xs min-h-11 sm:min-h-0 ${sort === 'cumulative' ? 'btn-primary' : 'btn-ghost'}`}
          >
            Marge cumulée
          </button>
          <button
            type="button"
            onClick={() => setSort('unit')}
            aria-pressed={sort === 'unit'}
            className={`btn btn-xs min-h-11 sm:min-h-0 ${sort === 'unit' ? 'btn-primary' : 'btn-ghost'}`}
          >
            Marge unitaire
          </button>
        </div>
      </div>

      <ResponsiveTable
        columns={columns}
        data={rows}
        getRowKey={(row) => `${row.productId ?? 'sans-id'}-${row.productName}`}
        emptyMessage="Aucune vente de marchandise sur la période : aucune marge à calculer."
      />
    </div>
  );
}
