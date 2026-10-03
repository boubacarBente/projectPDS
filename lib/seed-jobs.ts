/**
 * Démonstration des **prestations de chantier multi-magasins** (appelée par
 * `lib/seed-data.ts`). Toutes les écritures passent par les fonctions métier :
 * c'est aussi un test d'intégration.
 *
 * Contenu, pensé pour que chaque écran et chaque filtre ait quelque chose à
 * montrer :
 *  - un catalogue **propre à chaque magasin** (même prestation, prix
 *    différents à Kaloum et Matoto ; une désactivée, une archivée ; un
 *    changement de prix dans l'historique) ;
 *  - des ouvriers rattachés aux magasins et regroupés en **équipes** ;
 *  - deux **sous-traitants** (fiches fournisseurs) ;
 *  - des **demandes** à chaque étape, des **devis** dans chaque statut (dont
 *    un expiré et un annulé) ;
 *  - des **chantiers** en préparation, planifiés, en cours, **en retard**,
 *    suspendus, terminés et annulés, avec prestations, étapes, équipe,
 *    matériaux, sous-traitance, dépenses et acomptes ;
 *  - des chantiers terminés sur les **12 derniers mois** (graphique du pilotage).
 */

import { rawGet } from '@/db';
import { writeAudit } from '@/lib/audit';
import { createExpense } from '@/lib/expenses';
import { createPayment } from '@/lib/payments';
import { createSupplier } from '@/lib/suppliers';
import { createWorker, updateWorker } from '@/lib/workers';
import { createService, setServiceStatus, updateService } from '@/lib/services';
import { createServiceRequest, setServiceRequestStatus } from '@/lib/service-requests';
import { cancelQuote, convertQuoteToJob, createQuote, setQuoteStatus } from '@/lib/quotes';
import {
  addJobMaterial,
  addJobStage,
  addJobSubcontract,
  addJobTeam,
  addJobWorker,
  cancelServiceJob,
  createServiceJob,
  updateStatus,
  type JobStatus,
} from '@/lib/jobs';
import { getSettings, updateSettings } from '@/lib/settings';
import { addDays, today } from '@/lib/format';

type StoreRef = { id: number; name: string };
type UserRef = { id: number; name: string };

export type JobsSeedContext = {
  hq: StoreRef;
  kaloum: StoreRef;
  matoto: StoreRef;
  admin: UserRef;
  gerantKal: UserRef;
  gerantMat: UserRef;
  customerIds: number[];
  productIds: Map<string, number>;
};

export type JobsSeedReport = { services: number; requests: number; quotes: number; jobs: number; subcontractors: number };

const CATALOG: Record<'KAL' | 'MAT' | 'SIEGE', { name: string; category: string; unit: string; price: number; description?: string }[]> = {
  KAL: [
    { name: 'Habillage de façade Alucobond', category: 'Alucobond / façade', unit: 'm²', price: 180_000, description: 'Ossature aluminium, pose et joints. Panneaux fournis à part.' },
    { name: 'Peinture intérieure deux couches', category: 'Peinture', unit: 'm²', price: 23_000, description: 'Préparation, sous-couche et deux couches de finition.' },
    { name: 'Faux plafond placo', category: 'Placo / faux plafond', unit: 'm²', price: 95_000 },
    { name: 'Installation électrique complète', category: 'Électricité', unit: 'forfait', price: 3_500_000, description: 'Tableau, circuits, prises et points lumineux d’un logement.' },
    { name: 'Pose de carrelage', category: 'Carrelage', unit: 'm²', price: 25_000 },
    { name: 'Plomberie salle de bain', category: 'Plomberie', unit: 'forfait', price: 2_800_000 },
    { name: 'Staff décoratif (corniche)', category: 'Plâtre / staff', unit: 'mètre', price: 45_000 },
  ],
  MAT: [
    { name: 'Pose de carrelage', category: 'Carrelage', unit: 'm²', price: 30_000 },
    { name: 'Peinture intérieure deux couches', category: 'Peinture', unit: 'm²', price: 22_000 },
    { name: 'Élévation de murs en agglos', category: 'Gros œuvre / maçonnerie', unit: 'm²', price: 120_000 },
    { name: 'Terrassement et fouilles', category: 'Gros œuvre / maçonnerie', unit: 'm³', price: 60_000 },
    { name: 'Point lumineux', category: 'Électricité', unit: 'point', price: 150_000 },
    { name: 'Porte intérieure posée', category: 'Menuiserie / meubles', unit: 'unité', price: 850_000 },
    { name: 'Crépissage extérieur', category: 'Gros œuvre / maçonnerie', unit: 'm²', price: 18_000 },
  ],
  SIEGE: [
    { name: 'Cuisine sur mesure', category: 'Menuiserie / meubles', unit: 'forfait', price: 12_000_000 },
    { name: 'Pose de meubles', category: 'Menuiserie / meubles', unit: 'jour', price: 350_000 },
  ],
};

export async function seedServiceJobs(ctx: JobsSeedContext): Promise<JobsSeedReport> {
  const report: JobsSeedReport = { services: 0, requests: 0, quotes: 0, jobs: 0, subcontractors: 0 };
  const { kaloum, matoto, hq, gerantKal, gerantMat, admin, customerIds, productIds } = ctx;
  const userIn = (user: UserRef, store: StoreRef) => ({ id: user.id, name: user.name, storeId: store.id });
  const audit = (user: UserRef, store: StoreRef, entity: string, entityId: number, action: 'create' | 'update' | 'validate' | 'cancel', details: Record<string, unknown>) =>
    writeAudit({ user: userIn(user, store), storeId: store.id, action, entity, entityId, details });

  // Catégories de dépense propres aux chantiers (cahier §13).
  const settings = await getSettings();
  const wanted = ['Sous-traitance', 'Location', 'Fournitures', 'Main-d’œuvre'];
  const missing = wanted.filter((c) => !settings.expenseCategories.includes(c));
  if (missing.length) await updateSettings({ expenseCategories: [...settings.expenseCategories, ...missing] });

  /* ---------------------------- Catalogues ---------------------------- */
  const svc = new Map<string, number>();
  const stores: [keyof typeof CATALOG, StoreRef, UserRef][] = [
    ['KAL', kaloum, gerantKal],
    ['MAT', matoto, gerantMat],
    ['SIEGE', hq, admin],
  ];
  for (const [code, store, user] of stores) {
    for (const def of CATALOG[code]) {
      const created = await createService({
        storeId: store.id,
        userId: user.id,
        name: def.name,
        category: def.category,
        unit: def.unit,
        unitPrice: def.price,
        description: def.description ?? null,
      });
      svc.set(`${code}:${def.name}`, created.id);
      await audit(user, store, 'service', created.id, 'create', { code: created.code, name: created.name, unitPrice: created.unitPrice, unit: created.unit });
      report.services += 1;
    }
  }
  const S = (code: keyof typeof CATALOG, name: string) => svc.get(`${code}:${name}`)!;
  // Un changement de prix (historique) ; une prestation désactivée, une archivée.
  const repricing = await updateService(S('KAL', 'Peinture intérieure deux couches'), { unitPrice: 25_000 }, {
    storeId: kaloum.id,
    userId: gerantKal.id,
    userName: gerantKal.name,
  });
  await audit(gerantKal, kaloum, 'service', repricing.service.id, 'update', { code: repricing.service.code, name: repricing.service.name, changes: repricing.changes });
  await setServiceStatus(S('KAL', 'Staff décoratif (corniche)'), 'inactive', kaloum.id);
  await setServiceStatus(S('MAT', 'Crépissage extérieur'), 'archived', matoto.id);

  /* --------------------- Ouvriers, équipes, sous-traitants --------------------- */
  const rename = async (name: string, storeId: number | null, team: string | null) => {
    const row = await rawGet<{ id: number }>('SELECT id FROM workers WHERE name = ?', [name]);
    if (row) await updateWorker(Number(row.id), { storeId, team });
  };
  await rename('Sékou Touré', kaloum.id, 'Équipe façade');
  await rename('Alpha Condé', kaloum.id, 'Équipe façade');
  await rename('Aïssatou Barry', kaloum.id, 'Équipe finitions');
  await rename('Ousmane Sylla', kaloum.id, 'Équipe finitions');
  // Kadiatou Soumah reste commune à tous les magasins.
  for (const worker of [
    { name: 'Mamadou Bah', role: 'foreman' as const, dailyRate: 140_000, specialty: 'Chef de chantier gros œuvre' },
    { name: 'Fodé Camara', role: 'worker' as const, dailyRate: 80_000, specialty: 'Maçon' },
    { name: 'Mariama Keïta', role: 'worker' as const, dailyRate: 85_000, specialty: 'Carreleuse' },
  ]) {
    await createWorker({ ...worker, storeId: matoto.id, team: worker.name === 'Mariama Keïta' ? null : 'Équipe gros œuvre' });
  }
  const egc = await createSupplier({
    name: 'Électricité Générale Conakry',
    phone: '+224 627 55 66 77',
    address: 'Dixinn, Conakry',
    isSubcontractor: true,
    specialty: 'Électricien',
  });
  const plomberie = await createSupplier({
    name: 'Plomberie Moderne Matoto',
    phone: '+224 669 12 12 12',
    address: 'Matoto, Conakry',
    isSubcontractor: true,
    specialty: 'Plombier',
  });
  report.subcontractors = 2;

  /* -------------------------------- Aides -------------------------------- */
  const d = (offset: number) => addDays(today(), offset);
  const pay = async (store: StoreRef, user: UserRef, jobId: number, share: number, date: string) => {
    const job = await rawGet<{ total: number }>('SELECT total FROM service_jobs WHERE id = ?', [jobId]);
    const amount = Math.round((Number(job?.total ?? 0) * share) / 1000) * 1000;
    if (amount > 0) {
      await createPayment({ storeId: store.id, type: 'service_job', referenceId: jobId, amount, paymentMethod: share >= 1 ? 'Virement' : 'Espèces', date, userId: user.id });
    }
  };
  const expense = (store: StoreRef, user: UserRef, jobId: number, category: string, amount: number, date: string, description: string, type: 'service_job' | 'job_subcontract' = 'service_job', beneficiary?: string) =>
    createExpense({ storeId: store.id, category, amount, date, description, beneficiary: beneficiary ?? null, referenceType: type, referenceId: jobId, userId: user.id, canSkipApproval: true });
  const material = (store: StoreRef, user: UserRef, jobId: number, name: string, quantity: number) => {
    const productId = productIds.get(name);
    return productId ? addJobMaterial(jobId, { productId, quantity, userId: user.id, storeId: store.id }).catch(() => null) : null;
  };
  const stages = async (store: StoreRef, jobId: number, list: [string, number, number | null, string?][]) => {
    for (const [name, progress, plannedOffset, serviceKey] of list) {
      await addJobStage(jobId, { name, progress, plannedDate: plannedOffset === null ? null : d(plannedOffset), serviceId: serviceKey ? svc.get(serviceKey) ?? null : null }, store.id);
    }
  };
  const jobAudit = async (user: UserRef, store: StoreRef, jobId: number, details: Record<string, unknown>) => {
    const row = await rawGet<{ reference: string; total: number }>('SELECT reference, total FROM service_jobs WHERE id = ?', [jobId]);
    await audit(user, store, 'service_job', jobId, 'create', { reference: row?.reference, total: row?.total, ...details });
    report.jobs += 1;
  };

  /* ------------------------------ Demandes ------------------------------ */
  const request = async (store: StoreRef, user: UserRef, customer: number, need: string, services: number[], dateOffset: number, desiredOffset: number | null, site: string) => {
    const created = await createServiceRequest({
      storeId: store.id,
      userId: user.id,
      customerId: customer,
      need,
      date: d(dateOffset),
      desiredDate: desiredOffset === null ? null : d(desiredOffset),
      siteAddress: site,
      serviceIds: services,
    });
    await audit(user, store, 'service_request', created.id, 'create', { reference: created.reference });
    report.requests += 1;
    return created;
  };
  const quote = async (
    store: StoreRef,
    user: UserRef,
    input: { customer: number; requestId?: number; title: string; category: string; site: string; dateOffset: number; validity?: number; items: { serviceId: number; quantity: number; discountPercent?: number }[]; description?: string },
  ) => {
    const created = await createQuote({
      storeId: store.id,
      userId: user.id,
      customerId: input.customer,
      requestId: input.requestId ?? null,
      title: input.title,
      category: input.category,
      siteAddress: input.site,
      description: input.description ?? null,
      date: d(input.dateOffset),
      validUntil: d(input.dateOffset + (input.validity ?? 30)),
      items: input.items,
    });
    await audit(user, store, 'quote', created.id, 'create', { reference: created.reference, total: created.total });
    report.quotes += 1;
    return created;
  };

  // Kaloum — une demande à chaque étape.
  await request(kaloum, gerantKal, customerIds[2], 'Repeindre le salon et les deux chambres, couleur claire.', [S('KAL', 'Peinture intérieure deux couches')], -1, 15, 'Matam, Conakry');
  const rStudy = await request(kaloum, gerantKal, customerIds[4], 'Faux plafond dans le séjour avec spots encastrés.', [S('KAL', 'Faux plafond placo'), S('KAL', 'Installation électrique complète')], -6, 30, 'Ratoma, Conakry');
  await setServiceRequestStatus(rStudy.id, 'study', kaloum.id);
  const rVisit = await request(kaloum, gerantKal, customerIds[3], 'Carrelage terrasse et salle de bain, plomberie à refaire.', [S('KAL', 'Pose de carrelage'), S('KAL', 'Plomberie salle de bain')], -9, 20, 'Nongo, Conakry');
  await setServiceRequestStatus(rVisit.id, 'visit', kaloum.id);
  const rRefused = await request(kaloum, gerantKal, customerIds[5], 'Habillage Alucobond de l’enseigne.', [S('KAL', 'Habillage de façade Alucobond')], -40, null, 'Taouyah, Conakry');
  await setServiceRequestStatus(rRefused.id, 'refused', kaloum.id, 'Budget du client insuffisant cette année');

  // Devis à préparer (brouillon) et devis envoyé, liés à une demande.
  const rDraft = await request(kaloum, gerantKal, customerIds[0], 'Peinture des parties communes de la résidence.', [S('KAL', 'Peinture intérieure deux couches')], -4, 25, 'Kipé, Conakry');
  await quote(kaloum, gerantKal, {
    customer: customerIds[0],
    requestId: rDraft.id,
    title: 'Peinture parties communes — bâtiment B',
    category: 'Peinture',
    site: 'Kipé, Conakry',
    dateOffset: -2,
    items: [{ serviceId: S('KAL', 'Peinture intérieure deux couches'), quantity: 640 }],
  });
  const rSent = await request(kaloum, gerantKal, customerIds[1], 'Faux plafond de la salle de réception.', [S('KAL', 'Faux plafond placo')], -15, 20, 'Kaloum, Conakry');
  const qSent = await quote(kaloum, gerantKal, {
    customer: customerIds[1],
    requestId: rSent.id,
    title: 'Faux plafond — salle de réception',
    category: 'Placo / faux plafond',
    site: 'Kaloum, Conakry',
    dateOffset: -12,
    items: [
      { serviceId: S('KAL', 'Faux plafond placo'), quantity: 180, discountPercent: 5 },
      { serviceId: S('KAL', 'Installation électrique complète'), quantity: 1 },
    ],
  });
  await setQuoteStatus(qSent.id, 'sent', kaloum.id);

  // Devis expiré (envoyé il y a 50 jours, validité 30 jours), refusé, annulé.
  const qExpired = await quote(kaloum, gerantKal, {
    customer: customerIds[2],
    title: 'Carrelage cuisine',
    category: 'Carrelage',
    site: 'Matam, Conakry',
    dateOffset: -50,
    items: [{ serviceId: S('KAL', 'Pose de carrelage'), quantity: 35 }],
  });
  await setQuoteStatus(qExpired.id, 'sent', kaloum.id);
  const qRefused = await quote(kaloum, gerantKal, {
    customer: customerIds[5],
    requestId: undefined,
    title: 'Enseigne Alucobond',
    category: 'Alucobond / façade',
    site: 'Taouyah, Conakry',
    dateOffset: -38,
    items: [{ serviceId: S('KAL', 'Habillage de façade Alucobond'), quantity: 24 }],
  });
  await setQuoteStatus(qRefused.id, 'sent', kaloum.id);
  await setQuoteStatus(qRefused.id, 'refused', kaloum.id);
  const qCancelled = await quote(kaloum, gerantKal, {
    customer: customerIds[4],
    title: 'Plomberie — doublon',
    category: 'Plomberie',
    site: 'Ratoma, Conakry',
    dateOffset: -20,
    items: [{ serviceId: S('KAL', 'Plomberie salle de bain'), quantity: 1 }],
  });
  await cancelQuote(qCancelled.id, 'Saisi en double par erreur', { id: gerantKal.id, storeId: kaloum.id });

  /* ------------------------------ Chantiers ------------------------------ */

  // K1 — façade de l'hôtel : demande → devis accepté → chantier en cours, équipe, étapes, dépenses, acompte.
  const rFacade = await request(kaloum, gerantKal, customerIds[1], 'Habillage complet de la façade nord de l’hôtel.', [S('KAL', 'Habillage de façade Alucobond')], -30, -15, 'Kaloum, Conakry');
  const qFacade = await quote(kaloum, gerantKal, {
    customer: customerIds[1],
    requestId: rFacade.id,
    title: 'Habillage façade Alucobond — aile nord',
    category: 'Alucobond / façade',
    site: 'Hôtel Kaloum Plaza, Kaloum',
    description: 'Dépose de l’ancien bardage, ossature aluminium, pose des panneaux rouge et argent.',
    dateOffset: -25,
    items: [
      { serviceId: S('KAL', 'Habillage de façade Alucobond'), quantity: 150 },
      { serviceId: S('KAL', 'Staff décoratif (corniche)'), quantity: 0 }, // remplacé ci-dessous (désactivée)
    ].filter((item) => item.quantity > 0),
  });
  await setQuoteStatus(qFacade.id, 'sent', kaloum.id);
  await setQuoteStatus(qFacade.id, 'accepted', kaloum.id);
  const { job: k1 } = await convertQuoteToJob(qFacade.id, { storeId: kaloum.id, userId: gerantKal.id, startDate: d(-12), endDate: d(10), responsibleUserId: gerantKal.id });
  await updateStatus(k1.id, 'in_progress', kaloum.id);
  await addJobTeam(k1.id, 'Équipe façade', 12, kaloum.id);
  await material(kaloum, gerantKal, k1.id, 'Panneau Alucobond 4 mm rouge', 20);
  await material(kaloum, gerantKal, k1.id, 'Panneau Alucobond 4 mm argent', 15);
  await material(kaloum, gerantKal, k1.id, 'Rail R48', 30);
  await stages(kaloum, k1.id, [
    ['Relevé et prise de mesures', 100, -12],
    ['Dépose de l’ancien bardage', 100, -9],
    ['Pose de l’ossature', 80, -3, 'KAL:Habillage de façade Alucobond'],
    ['Pose des panneaux', 30, 5, 'KAL:Habillage de façade Alucobond'],
    ['Finitions et nettoyage', 0, 10],
  ]);
  await expense(kaloum, gerantKal, k1.id, 'Location', 600_000, d(-11), 'Location échafaudage (2 semaines)');
  await expense(kaloum, gerantKal, k1.id, 'Transport', 250_000, d(-12), 'Livraison des panneaux sur site');
  await pay(kaloum, gerantKal, k1.id, 0.4, d(-12));
  await audit(gerantKal, kaloum, 'quote', qFacade.id, 'validate', { reference: qFacade.reference, convertedTo: k1.reference });
  await jobAudit(gerantKal, kaloum, k1.id, { fromQuote: qFacade.reference });

  // K2 — villa : électricité + plomberie, sous-traitée en partie, EN RETARD.
  const k2 = await createServiceJob({
    storeId: kaloum.id,
    userId: gerantKal.id,
    customerId: customerIds[3],
    category: 'Construction complète',
    title: 'Second œuvre villa — électricité et plomberie',
    siteAddress: 'Villa Nongo, Conakry',
    startDate: d(-35),
    endDate: d(-6),
    actualStartDate: d(-33),
    status: 'in_progress',
    responsibleUserId: gerantKal.id,
    items: [
      { serviceId: S('KAL', 'Installation électrique complète'), quantity: 1 },
      { serviceId: S('KAL', 'Plomberie salle de bain'), quantity: 2 },
      { serviceId: S('KAL', 'Pose de carrelage'), quantity: 60, discountPercent: 10 },
    ],
  });
  const egcWork = await addJobSubcontract(k2.id, { supplierId: egc.id, work: 'Câblage et tableau électrique', agreedAmount: 1_800_000, userId: gerantKal.id }, kaloum.id);
  await expense(kaloum, gerantKal, egcWork.id, 'Sous-traitance', 1_000_000, d(-20), 'Acompte électricien', 'job_subcontract', egc.name);
  await addJobWorker(k2.id, { workerId: (await rawGet<{ id: number }>("SELECT id FROM workers WHERE name = 'Kadiatou Soumah'"))?.id ?? null, days: 10 }, kaloum.id);
  await stages(kaloum, k2.id, [
    ['Saignées et gaines', 100, -28, 'KAL:Installation électrique complète'],
    ['Plomberie des salles de bain', 70, -15, 'KAL:Plomberie salle de bain'],
    ['Carrelage', 20, -8, 'KAL:Pose de carrelage'],
    ['Raccordements et essais', 0, -6],
  ]);
  await pay(kaloum, gerantKal, k2.id, 0.3, d(-33));
  await jobAudit(gerantKal, kaloum, k2.id, {});

  // K3 — planifié (début dans une semaine) ; K4 — suspendu ; K5 — annulé.
  const k3 = await createServiceJob({
    storeId: kaloum.id,
    userId: gerantKal.id,
    customerId: customerIds[4],
    category: 'Placo / faux plafond',
    title: 'Faux plafond séjour et couloir',
    siteAddress: 'Ratoma, Conakry',
    startDate: d(7),
    endDate: d(18),
    status: 'planned',
    responsibleUserId: gerantKal.id,
    items: [{ serviceId: S('KAL', 'Faux plafond placo'), quantity: 85 }],
  });
  await pay(kaloum, gerantKal, k3.id, 0.3, d(-1));
  await jobAudit(gerantKal, kaloum, k3.id, {});
  const k4 = await createServiceJob({
    storeId: kaloum.id,
    userId: gerantKal.id,
    customerId: customerIds[2],
    category: 'Peinture',
    title: 'Peinture extérieure — en attente du client',
    siteAddress: 'Matam, Conakry',
    startDate: d(-20),
    endDate: d(15),
    actualStartDate: d(-20),
    status: 'suspended',
    progress: 35,
    items: [{ serviceId: S('KAL', 'Peinture intérieure deux couches'), quantity: 220 }],
    notes: 'Suspendu : le client attend la fin de la saison des pluies.',
  });
  await jobAudit(gerantKal, kaloum, k4.id, {});
  const k5 = await createServiceJob({
    storeId: kaloum.id,
    userId: gerantKal.id,
    customerId: customerIds[0],
    category: 'Carrelage',
    title: 'Carrelage hall d’entrée',
    siteAddress: 'Kipé, Conakry',
    startDate: d(-45),
    endDate: d(-30),
    items: [{ serviceId: S('KAL', 'Pose de carrelage'), quantity: 40 }],
  });
  await cancelServiceJob(k5.id, 'Le client a confié les travaux à son propre carreleur', { id: gerantKal.id, name: gerantKal.name, storeId: kaloum.id });
  await jobAudit(gerantKal, kaloum, k5.id, {});

  // Chantiers terminés sur les 12 derniers mois (Kaloum et Matoto) : graphique et rentabilité.
  const history: [StoreRef, UserRef, keyof typeof CATALOG, number, string, string, [string, number][], number, string?][] = [
    [kaloum, gerantKal, 'KAL', 0, 'Peinture et finitions — six appartements', 'Peinture', [['Peinture intérieure deux couches', 1200]], 25, 'Peinture acrylique blanche 20 L'],
    [kaloum, gerantKal, 'KAL', 5, 'Façade Alucobond — boutique', 'Alucobond / façade', [['Habillage de façade Alucobond', 40]], 60, 'Panneau Alucobond 4 mm argent'],
    [kaloum, gerantKal, 'KAL', 3, 'Électricité appartement T4', 'Électricité', [['Installation électrique complète', 1]], 95],
    [kaloum, gerantKal, 'KAL', 1, 'Faux plafond bureaux', 'Placo / faux plafond', [['Faux plafond placo', 120]], 130],
    [kaloum, gerantKal, 'KAL', 4, 'Salle de bain complète', 'Plomberie', [['Plomberie salle de bain', 1], ['Pose de carrelage', 18]], 200],
    [kaloum, gerantKal, 'KAL', 0, 'Carrelage restaurant', 'Carrelage', [['Pose de carrelage', 160]], 280],
    [matoto, gerantMat, 'MAT', 3, 'Terrassement et fondations — maison R+1', 'Gros œuvre / maçonnerie', [['Terrassement et fouilles', 90]], 120],
    [matoto, gerantMat, 'MAT', 2, 'Murs de clôture', 'Gros œuvre / maçonnerie', [['Élévation de murs en agglos', 75]], 190],
    [matoto, gerantMat, 'MAT', 5, 'Carrelage boutique', 'Carrelage', [['Pose de carrelage', 70]], 240],
    [matoto, gerantMat, 'MAT', 0, 'Portes et peinture — duplex', 'Menuiserie / meubles', [['Porte intérieure posée', 6], ['Peinture intérieure deux couches', 300]], 320],
  ];
  for (const [store, user, code, customerIndex, title, category, lines, daysAgo, materialName] of history) {
    const job = await createServiceJob({
      storeId: store.id,
      userId: user.id,
      customerId: customerIds[customerIndex],
      category,
      title,
      siteAddress: 'Conakry',
      startDate: d(-daysAgo),
      endDate: d(-daysAgo + 14),
      actualStartDate: d(-daysAgo),
      actualEndDate: d(-daysAgo + 15),
      status: 'completed',
      responsibleUserId: user.id,
      items: lines.map(([name, quantity]) => ({ serviceId: S(code, name), quantity })),
    });
    if (materialName) await material(store, user, job.id, materialName, 10);
    // Coûts réalistes : 35 à 50 % du montant facturé (journaliers, fournitures hors stock).
    const share = 0.35 + (daysAgo % 4) * 0.05;
    const labor = Math.round((job.total * share * 0.7) / 1000) * 1000;
    const supplies = Math.round((job.total * share * 0.3) / 1000) * 1000;
    await expense(store, user, job.id, 'Main-d’œuvre', labor, d(-daysAgo + 7), 'Journaliers du chantier');
    await expense(store, user, job.id, 'Fournitures', supplies, d(-daysAgo + 3), 'Fournitures achetées pour le chantier');
    // Le plus ancien reste partiellement impayé : une créance à suivre.
    await pay(store, user, job.id, daysAgo === 200 ? 0.6 : 1, d(-daysAgo + 15));
    await jobAudit(user, store, job.id, {});
  }

  // Matoto — en cours avec équipe et sous-traitance, en préparation (devis accepté).
  const m1 = await createServiceJob({
    storeId: matoto.id,
    userId: gerantMat.id,
    customerId: customerIds[3],
    category: 'Gros œuvre / maçonnerie',
    title: 'Extension — élévation et carrelage',
    siteAddress: 'Matoto, Conakry',
    startDate: d(-10),
    endDate: d(25),
    actualStartDate: d(-9),
    status: 'in_progress',
    responsibleUserId: gerantMat.id,
    items: [
      { serviceId: S('MAT', 'Élévation de murs en agglos'), quantity: 85 },
      { serviceId: S('MAT', 'Pose de carrelage'), quantity: 70 },
    ],
  });
  await addJobTeam(m1.id, 'Équipe gros œuvre', 9, matoto.id);
  const plombWork = await addJobSubcontract(m1.id, { supplierId: plomberie.id, work: 'Évacuations et arrivées d’eau', agreedAmount: 2_200_000, userId: gerantMat.id }, matoto.id);
  await expense(matoto, gerantMat, plombWork.id, 'Sous-traitance', 700_000, d(-5), 'Premier versement plombier', 'job_subcontract', plomberie.name);
  await material(matoto, gerantMat, m1.id, 'Clous 50 mm (1 kg)', 12);
  await stages(matoto, m1.id, [
    ['Fondations', 100, -8],
    ['Élévation des murs', 55, 5, 'MAT:Élévation de murs en agglos'],
    ['Carrelage', 0, 20, 'MAT:Pose de carrelage'],
  ]);
  await pay(matoto, gerantMat, m1.id, 0.3, d(-10));
  await jobAudit(gerantMat, matoto, m1.id, {});

  const rMat = await request(matoto, gerantMat, customerIds[2], 'Installer des points lumineux dans toute la maison.', [S('MAT', 'Point lumineux')], -8, 10, 'Matoto, Conakry');
  const qMat = await quote(matoto, gerantMat, {
    customer: customerIds[2],
    requestId: rMat.id,
    title: 'Éclairage maison',
    category: 'Électricité',
    site: 'Matoto, Conakry',
    dateOffset: -6,
    items: [{ serviceId: S('MAT', 'Point lumineux'), quantity: 14 }],
  });
  await setQuoteStatus(qMat.id, 'sent', matoto.id);
  await setQuoteStatus(qMat.id, 'accepted', matoto.id);
  const { job: m2 } = await convertQuoteToJob(qMat.id, { storeId: matoto.id, userId: gerantMat.id, responsibleUserId: gerantMat.id });
  await audit(gerantMat, matoto, 'quote', qMat.id, 'validate', { reference: qMat.reference, convertedTo: m2.reference });
  await jobAudit(gerantMat, matoto, m2.id, { fromQuote: qMat.reference });
  // Un devis accepté pas encore converti, à Matoto.
  const qWaiting = await quote(matoto, gerantMat, {
    customer: customerIds[5],
    title: 'Carrelage bureaux',
    category: 'Carrelage',
    site: 'Taouyah, Conakry',
    dateOffset: -3,
    items: [{ serviceId: S('MAT', 'Pose de carrelage'), quantity: 110 }],
  });
  await setQuoteStatus(qWaiting.id, 'accepted', matoto.id);
  await request(matoto, gerantMat, customerIds[0], 'Terrassement pour une piscine.', [S('MAT', 'Terrassement et fouilles')], -2, 40, 'Kipé, Conakry');

  // Siège — une cuisine sur mesure terminée.
  const s1 = await createServiceJob({
    storeId: hq.id,
    userId: admin.id,
    customerId: customerIds[1],
    category: 'Menuiserie / meubles',
    title: 'Cuisine sur mesure — restaurant de l’hôtel',
    siteAddress: 'Kaloum, Conakry',
    startDate: d(-150),
    endDate: d(-120),
    actualStartDate: d(-150),
    actualEndDate: d(-118),
    status: 'completed' as JobStatus,
    items: [
      { serviceId: S('SIEGE', 'Cuisine sur mesure'), quantity: 1 },
      { serviceId: S('SIEGE', 'Pose de meubles'), quantity: 4 },
    ],
  });
  await expense(hq, admin, s1.id, 'Fournitures', 6_200_000, d(-148), 'Plans de travail, quincaillerie et électroménager');
  await expense(hq, admin, s1.id, 'Main-d’œuvre', 1_400_000, d(-120), 'Menuisiers et poseurs');
  await pay(hq, admin, s1.id, 1, d(-118));
  await jobAudit(admin, hq, s1.id, {});

  return report;
}
