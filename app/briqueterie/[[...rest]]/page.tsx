import { redirect } from 'next/navigation';
import { getDefaultBrickBranch } from '@/lib/branches';

/**
 * Anciennes adresses de la briqueterie (README §30) → espace de la filiale
 * « Briqueterie » (README §31.2). Les favoris et les liens déjà partagés
 * continuent de fonctionner : `/briqueterie/commandes/12` mène à
 * `/filiales/<id>/commandes/12` ; l'ancienne fiche de lot `/briqueterie/12`
 * mène à `/filiales/<id>/productions/12`.
 */
export default async function LegacyBrickRedirect({ params }: { params: Promise<{ rest?: string[] }> }) {
  const { rest = [] } = await params;
  const branch = await getDefaultBrickBranch();
  if (!branch) redirect('/filiales');
  const path = rest.length === 1 && /^\d+$/.test(rest[0]) ? ['productions', rest[0]] : rest.map((part) => (part === 'types' ? 'modeles' : part));
  redirect(`/filiales/${branch.id}${path.length ? `/${path.map(encodeURIComponent).join('/')}` : ''}`);
}
