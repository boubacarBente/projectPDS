import { BackButton } from '@/components/back-button';

type PageHeaderProps = {
  /**
   * Contexte de la page, au-dessus du titre. Une **chaîne** suffit le plus
   * souvent ; un `ReactNode` permet d'y placer un fil d'Ariane dont le dernier
   * segment est un lien (page « Nouvelle vente »), sans changer le rendu des
   * appelants existants.
   */
  eyebrow: React.ReactNode;
  title: string;
  description: string;
  actions?: React.ReactNode;
};

/**
 * En-tête de page.
 *
 * Un contenant discret, calé sur le vocabulaire visuel du reste de
 * l'application (cartes de stats, cartes de tableau) : rayon modéré, filet
 * fin, ombre légère. Pas de fond translucide, pas de `backdrop-blur`, pas
 * d'ombre portée lourde — ces trois effets cumulés faisaient passer l'en-tête
 * pour un modal. Un léger dégradé dans la couleur configurée lui donne son
 * identité sans le charger.
 *
 * L'eyebrow utilise `text-primary` et non une teinte Tailwind figée : la
 * couleur primaire est réglable par l'utilisateur (`lib/colors.ts` écrit
 * `--color-primary`), donc une couleur en dur ignorerait son choix.
 *
 * Le titre est un `<h1>` : c'est le titre principal de la page.
 *
 * La flèche retour est **en ligne avec l'eyebrow** plutôt que sur sa propre
 * ligne : elle reste en haut à gauche, mais sans ajouter une ligne vide qui la
 * détachait du bloc de texte.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: PageHeaderProps) {
  return (
    <header className="rounded-2xl border border-base-200 bg-linear-to-r from-primary/5 to-base-100 p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* Sans marge propre : l'alignement vient du `items-center`. */}
            <BackButton withMargin={false} />
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
              {eyebrow}
            </p>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-base-content sm:text-[28px]">
            {title}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-base-content/55">
            {description}
          </p>
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
