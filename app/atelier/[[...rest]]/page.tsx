import { redirect } from 'next/navigation';
import { getFurnitureBranch } from '@/lib/branches';

/**
 * Le module `/atelier` est supprimé (README §31.9) : l'atelier de meubles est
 * la filiale « Meuble ». Les anciennes adresses mènent à son historique —
 * `/atelier/12` → `/filiales/<id>/atelier/12` ; `/atelier/modeles` → ses modèles.
 */
export default async function LegacyAtelierRedirect({ params }: { params: Promise<{ rest?: string[] }> }) {
  const { rest = [] } = await params;
  const branch = await getFurnitureBranch();
  if (!branch) redirect('/filiales');
  if (rest[0] === 'modeles') redirect(`/filiales/${branch.id}/modeles`);
  const id = rest.length === 1 && /^\d+$/.test(rest[0]) ? `/${rest[0]}` : '';
  redirect(`/filiales/${branch.id}/atelier${id}`);
}
