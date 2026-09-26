'use client';

/**
 * Bulle d'explication autour d'une commande, ouverte au survol et au focus.
 *
 * Pourquoi un portail plutôt que la bulle daisyUI
 * ----------------------------------------------
 * Une bulle `position: absolute` est **rognée par le premier ancêtre qui cache
 * le débordement**. Dans cette application il y en a partout : les cartes
 * `PageSection` sont en `overflow-hidden`, la barre latérale en
 * `overflow-x-hidden`, les tableaux en `overflow-x-auto`. Résultat mesuré avec la
 * bulle daisyUI : **invisible ou coupée** dès qu'on l'utilise dans une carte, et
 * débordant de la fenêtre (barre de défilement horizontale) quand la commande est
 * près d'un bord.
 *
 * La bulle est donc rendue **dans un portail** (`createPortal` sur `body`) et
 * positionnée en `fixed` d'après la position réelle de la commande :
 *
 *  - elle n'est jamais rognée, quel que soit l'ancêtre ;
 *  - elle est **écrêtée aux bords** de la fenêtre (jamais de débordement) ;
 *  - elle bascule au-dessus ou en dessous selon la place disponible ;
 *  - elle suit la commande tant qu'elle est ouverte (défilement, redimensionnement).
 *
 * Accessibilité : `aria-describedby` est posé sur la commande (par
 * `cloneElement`, sans l'envelopper dans un élément supplémentaire), la bulle
 * porte `role="tooltip"`, reste **dans l'arbre d'accessibilité** (opacité, pas
 * `display`), et n'intercepte jamais la souris (`pointer-events: none`) — elle ne
 * peut donc pas voler le survol de la commande.
 */

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/** Demi-base du triangle de la flèche, en pixels (daisyUI : 0,25 rem). */
const ARROW_SIZE = 6;
/** Marge minimale entre la flèche et l'extrémité de la bulle. */
const ARROW_MARGIN = ARROW_SIZE + 8;

type TriggerProps = {
  'aria-describedby'?: string;
  onMouseEnter?: (event: React.MouseEvent) => void;
  onMouseLeave?: (event: React.MouseEvent) => void;
  onFocus?: (event: React.FocusEvent) => void;
  onBlur?: (event: React.FocusEvent) => void;
};

interface TooltipProps {
  /** Le texte de l'explication. */
  label: ReactNode;
  /** La commande à expliquer (un seul élément). */
  children: ReactElement<TriggerProps>;
  /** Préférence de côté ; la bulle bascule d'elle-même si la place manque. */
  side?: 'top' | 'bottom';
  /** Marge minimale avec les bords de la fenêtre. */
  gap?: number;
  /**
   * Relier la bulle à la commande par `aria-describedby` (vrai par défaut).
   * À désactiver quand le texte est **déjà** le nom accessible de la commande
   * (icône de ligne : `aria-label` + `<span class="sr-only">`) — sinon il est
   * annoncé deux fois.
   */
  ariaDescribedBy?: boolean;
}

export function Tooltip({ label, children, side = 'top', gap = 8, ariaDescribedBy = true }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<{ top: number; left: number; below: boolean; arrow: number } | null>(null);

  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef<typeof placed>(null);

  /** Place la bulle d'après la position réelle de la commande (jamais hors écran). */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;

    const t = trigger.getBoundingClientRect();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Écrêtage horizontal : la bulle reste entièrement visible.
    const left = Math.max(gap, Math.min(t.left + t.width / 2 - w / 2, vw - w - gap));

    // Au-dessus si la place le permet, sinon en dessous.
    const roomAbove = t.top - h - gap;
    const below = side === 'bottom' ? t.bottom + h + gap <= vh || roomAbove < gap : roomAbove < gap;
    const top = below ? Math.min(t.bottom + gap, vh - h - gap) : Math.max(gap, roomAbove);

    /*
     * Position de la flèche : **face au centre de la commande**. Quand la bulle
     * est écrêtée à un bord de la fenêtre, la flèche rentre dans la bulle au
     * lieu de la dépasser — elle pointe toujours vers la commande.
     */
    const arrow = Math.round(
      Math.max(ARROW_MARGIN, Math.min(t.left + t.width / 2 - left, w - ARROW_MARGIN)),
    );

    const next = { top: Math.round(top), left: Math.round(left), below, arrow };
    const previous = placedRef.current;
    if (
      previous &&
      previous.top === next.top &&
      previous.left === next.left &&
      previous.below === next.below &&
      previous.arrow === next.arrow
    ) {
      return;
    }
    placedRef.current = next;
    setPlaced(next);
  }, [gap, side]);

  /* La bulle suit la commande tant qu'elle est ouverte. */
  useLayoutEffect(() => {
    if (!open) return;
    place();
    let frame = requestAnimationFrame(function tick() {
      place();
      frame = requestAnimationFrame(tick);
    });
    const onChange = () => place();
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
    };
  }, [open, place]);

  /* Échap referme la bulle. */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const show = (trigger: HTMLElement | null) => {
    if (!trigger) return;
    triggerRef.current = trigger;
    setOpen(true);
  };
  const hide = () => {
    setOpen(false);
    setPlaced(null);
    placedRef.current = null;
  };

  /**
   * Les gestionnaires sont posés sur une **enveloppe `display: contents`**, pas
   * sur l'enfant. C'est indispensable : certains déclencheurs ne transmettent
   * pas les accessoires qu'on leur ajoute (`ToolbarButton` aplatissait ses
   * props, `next/link` ne relaie pas tout) — l'infobulle ne s'affichait alors
   * jamais, ou restait ouverte. `display: contents` ne crée **aucune boîte** :
   * la mise en page est strictement identique à celle d'un enfant nu.
   */
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const commandElement = () => wrapperRef.current?.firstElementChild as HTMLElement | null;

  const trigger = (
    <span
      ref={wrapperRef}
      data-tooltip-trigger=""
      style={{ display: 'contents' }}
      onMouseEnter={() => show(commandElement())}
      onMouseLeave={hide}
      onFocus={() => show(commandElement())}
      onBlur={hide}
    >
      {isValidElement(children) && ariaDescribedBy
        ? cloneElement(children, { 'aria-describedby': id })
        : children}
    </span>
  );

  const bubble = (
    <div
      ref={bubbleRef}
      id={id}
      role="tooltip"
      style={{
        position: 'fixed',
        top: placed?.top ?? 0,
        left: placed?.left ?? 0,
        maxWidth: 'min(20rem, calc(100vw - 1rem))',
        // Opacité (et non `display`/`visibility`) : la bulle reste annoncée aux
        // lecteurs d'écran via `aria-describedby`, et n'intercepte jamais la souris.
        opacity: open && placed ? 1 : 0,
        /*
         * Animation daisyUI : fondu **et** glissement de 4 px, 200 ms, retard de
         * 75 ms. La bulle part légèrement vers la commande (vers le bas si elle
         * s'affiche au-dessus, vers le haut sinon) puis se pose.
         */
        transform: open && placed ? 'none' : `translateY(${placed?.below ? '-4px' : '4px'})`,
        transition:
          'opacity .2s cubic-bezier(.4,0,.2,1) 75ms, transform .2s cubic-bezier(.4,0,.2,1) 75ms',
        pointerEvents: 'none',
        zIndex: 80,
      }}
      className="w-max rounded-xl bg-neutral px-3 py-1.5 text-sm text-neutral-content shadow-xl"
    >
      <div className="text-left leading-snug">{label}</div>
      {/*
        Flèche : un triangle CSS qui pointe vers la commande, aligné sur son
        centre (`placed.arrow`). Elle bascule avec la bulle — sous la bulle quand
        celle-ci est au-dessus, au-dessus quand elle est en dessous. La couleur
        est le jeton du thème, pas une valeur figée.
      */}
      <span
        aria-hidden
        data-tooltip-arrow=""
        style={{
          position: 'absolute',
          left: placed?.arrow ?? 0,
          width: 0,
          height: 0,
          borderLeft: `${ARROW_SIZE}px solid transparent`,
          borderRight: `${ARROW_SIZE}px solid transparent`,
          ...(placed?.below
            ? { top: -ARROW_SIZE, borderBottom: `${ARROW_SIZE}px solid var(--color-neutral)` }
            : { bottom: -ARROW_SIZE, borderTop: `${ARROW_SIZE}px solid var(--color-neutral)` }),
        }}
      />
    </div>
  );

  return (
    <>
      {trigger}
      {typeof document !== 'undefined' ? createPortal(bubble, document.body) : null}
    </>
  );
}
