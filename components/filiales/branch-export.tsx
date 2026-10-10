'use client';

import { useState } from 'react';
import { toast } from 'react-toastify';
import { ExportDropdown } from '@/components/export-dropdown';
import {
  exportDocumentAsImage,
  exportDocumentAsPDF,
  renderExportDocument,
  type ExportDocumentInput,
} from '@/lib/export-document';

/**
 * Bouton « Télécharger » en PDF ou en image pour les écrans des filiales
 * (vue consolidée, caisse, dépenses — README §31).
 *
 * Invariant 5 : on n'exporte jamais la page affichée. `build()` décrit un
 * **document autonome** (`renderExportDocument`, couleurs hexadécimales), le
 * même pour le PDF et pour l'image. Il est construit au clic, à partir des
 * réponses de l'API (aucun calcul financier côté navigateur).
 */
export function BranchExportButton({
  build,
  fileBase,
  what,
  label = 'Télécharger',
}: {
  /** Document à exporter (peut relire l'API), ou `null` tant que les données ne sont pas chargées. */
  build: () => ExportDocumentInput | null | Promise<ExportDocumentInput | null>;
  fileBase: string;
  /** Nom du document dans les messages (« le rapport consolidé »). */
  what: string;
  label?: string;
}) {
  const [isExporting, setIsExporting] = useState(false);

  async function run(kind: 'pdf' | 'image') {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const input = await build();
      if (!input) {
        toast.info('Les données ne sont pas encore chargées.');
        return;
      }
      const html = renderExportDocument(input);
      if (kind === 'pdf') await exportDocumentAsPDF(html, fileBase);
      else await exportDocumentAsImage(html, fileBase);
      toast.success(`${kind === 'pdf' ? 'PDF' : 'Image'} : ${what} téléchargé.`);
    } catch (caught: any) {
      // La cause réelle remonte : un message générique rendrait l'échec indiagnosticable.
      toast.error(caught?.message ?? `${what} n’a pas pu être exporté.`, { autoClose: 10000 });
    } finally {
      setIsExporting(false);
    }
  }

  return <ExportDropdown label={isExporting ? 'Export…' : label} onExportPDF={() => void run('pdf')} onExportImage={() => void run('image')} />;
}
