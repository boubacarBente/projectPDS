'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from '@/components/tooltip';

export async function generateInvoiceBlob(
  invoiceHTML: string,
): Promise<Blob | null> {
  try {
    const html2canvasModule = await import('html2canvas');
    const hc = html2canvasModule.default;

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;height:1200px;border:none;';
    document.body.appendChild(iframe);

    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!iframeDoc) throw new Error('Cannot access iframe');

    const isCompleteDocument = /<(?:!doctype|html)(?:\s|>)/i.test(invoiceHTML);

    iframeDoc.open();
    iframeDoc.write(isCompleteDocument ? invoiceHTML : `<!DOCTYPE html><html><head><style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; background: rgb(255,255,255); padding: 40px; }
    </style></head><body>${invoiceHTML}</body></html>`);
    iframeDoc.close();

    await Promise.all(
      Array.from(iframeDoc.images).map((image) => {
        if (image.complete) return Promise.resolve();

        return new Promise<void>((resolve) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => resolve(), { once: true });
        });
      }),
    );

    const canvas = await hc(iframeDoc.body, {
      scale: 2, useCORS: true, allowTaint: true, backgroundColor: 'rgb(255,255,255)', logging: false,
    });

    document.body.removeChild(iframe);

    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
  } catch (err) {
    console.error('Invoice image generation error:', err);
    return null;
  }
}

type ShareOnWhatsAppOptions = {
  photoOnly?: boolean;
};

export async function shareOnWhatsApp(
  invoiceHTML: string,
  textMessage: string,
  fileName = 'facture.png',
  shareTitle = 'Facture',
  options: ShareOnWhatsAppOptions = {},
): Promise<void> {
  const shouldIncludeText = !options.photoOnly && textMessage.trim().length > 0;
  const shouldIncludeTitle = !options.photoOnly && shareTitle.trim().length > 0;

  const blob = await generateInvoiceBlob(invoiceHTML);
  if (!blob) {
    if (!shouldIncludeText) {
      throw new Error("Impossible de générer la photo à partager.");
    }

    window.open(`https://wa.me/?text=${encodeURIComponent(textMessage)}`, '_blank');
    return;
  }

  // Try Web Share API (mobile browsers → includes WhatsApp)
  const file = new File([blob], fileName, { type: 'image/png' });

  if (navigator.share && navigator.canShare) {
    const shareData: ShareData = { files: [file] };

    if (shouldIncludeTitle) shareData.title = shareTitle;
    if (shouldIncludeText) shareData.text = textMessage;

    if (navigator.canShare(shareData)) {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        // User cancelled or share failed — fall through to fallback
        const isAbortError = err instanceof Error && err.name === 'AbortError';
        if (isAbortError) return;

        console.error('Share error:', err);
      }
    }
  }

  // Fallback: open WhatsApp Web with the image URL + text
  if (!shouldIncludeText) {
    throw new Error("Le partage direct de la photo seule n'est pas disponible sur cet appareil.");
  }

  const blobUrl = URL.createObjectURL(blob);
  const message = `${textMessage}\n${blobUrl}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  // Cleanup blob URL after a delay
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

interface ExportDropdownProps {
  onExportPDF: () => void;
  onExportImage: () => void;
  onShareWhatsApp?: () => void;
  compact?: boolean;
  label?: string;
}

export function ExportDropdown({ onExportPDF, onExportImage, onShareWhatsApp, compact = false, label }: ExportDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuPosition = () => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const menuWidth = 176;
    const menuHeight = onShareWhatsApp ? 134 : 90;
    const margin = 8;
    const left = Math.min(
      Math.max(margin, rect.right - menuWidth),
      window.innerWidth - menuWidth - margin,
    );
    const opensUp = rect.bottom + menuHeight + margin > window.innerHeight;
    const top = opensUp
      ? Math.max(margin, rect.top - menuHeight - 6)
      : rect.bottom + 6;

    setMenuPosition({ top, left });
  };

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);

    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [isOpen]);

  const handleSelect = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  const toggleMenu = () => {
    if (!isOpen) updateMenuPosition();
    setIsOpen((current) => !current);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <Tooltip label={label || 'Télécharger'}>
        <button
          ref={buttonRef}
          type="button"
          onClick={toggleMenu}
          className={compact
            ? "btn btn-ghost btn-sm btn-square"
            : "btn btn-primary btn-sm gap-1"
          }
          aria-label={label || 'Télécharger'}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          {!compact && <span className="hidden sm:inline">{label || 'Télécharger'}</span>}
          <svg xmlns="http://www.w3.org/2000/svg" className={`h-3 w-3 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </Tooltip>

      {isOpen && menuPosition && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] w-44 rounded-xl border border-base-200 bg-base-100 shadow-2xl overflow-hidden"
          style={{ top: menuPosition.top, left: menuPosition.left }}
        >
          <button
            type="button"
            onClick={() => handleSelect(onExportPDF)}
            className="flex cursor-pointer items-center gap-2.5 w-full px-4 py-2.5 text-sm font-medium text-base-content hover:bg-base-200 transition-colors"
            title="Exporter en PDF"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-info shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            PDF
          </button>
          <div className="border-t border-base-200" />
          <button
            type="button"
            onClick={() => handleSelect(onExportImage)}
            className="flex cursor-pointer items-center gap-2.5 w-full px-4 py-2.5 text-sm font-medium text-base-content hover:bg-base-200 transition-colors"
            title="Exporter en image (PNG)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-success shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Image
          </button>
          {onShareWhatsApp && (
            <>
              <div className="border-t border-base-200" />
              <button
                type="button"
                onClick={() => handleSelect(onShareWhatsApp)}
                className="flex cursor-pointer items-center gap-2.5 w-full px-4 py-2.5 text-sm font-medium text-base-content hover:bg-base-200 transition-colors"
                title="Partager sur WhatsApp"
              >
                {/* `text-success` et non `text-emerald-500` : la règle d'or du
                    README §5.3 interdit toute couleur figée, qui ignorerait le
                    thème choisi par le client. */}
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-success shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                WhatsApp
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
