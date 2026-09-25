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
}

export function Tooltip({ label, children, side = 'top', gap = 8 }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<{ top: number; left: number; below: boolean } | null>(null);

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

    const next = { top: Math.round(top), left: Math.round(left), below };
    const previous = placedRef.current;
    if (previous && previous.top === next.top && previous.left === next.left && previous.below === next.below) return;
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

  /** Compose avec un éventuel gestionnaire déjà présent sur l'enfant. */
  const compose = <E,>(existing: ((event: E) => void) | undefined, handler: (event: E) => void) => (event: E) => {
    existing?.(event);
    handler(event);
  };

  const trigger = isValidElement(children)
    ? cloneElement(children, {
        'aria-describedby': id,
        onMouseEnter: compose(children.props.onMouseEnter, (event: React.MouseEvent) =>
          show(event.currentTarget as HTMLElement),
        ),
        onMouseLeave: compose(children.props.onMouseLeave, hide),
        onFocus: compose(children.props.onFocus, (event: React.FocusEvent) => show(event.currentTarget as HTMLElement)),
        onBlur: compose(children.props.onBlur, hide),
      })
    : children;

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
        pointerEvents: 'none',
        transition: 'opacity .15s ease-out',
        zIndex: 80,
      }}
      className="w-max rounded-xl bg-neutral px-3 py-1.5 text-sm text-neutral-content shadow-xl"
    >
      <div className="text-left leading-snug">{label}</div>
    </div>
  );

  return (
    <>
      {trigger}
      {typeof document !== 'undefined' ? createPortal(bubble, document.body) : null}
    </>
  );
}
