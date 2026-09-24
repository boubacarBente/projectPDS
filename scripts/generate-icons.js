/**
 * Génère toutes les déclinaisons d'icône à partir du logo fourni par le client.
 *
 * Le client dépose `public/logo.jpg` (et `public/icon.jpg`) : un JPEG carré de
 * 500 × 500, sans transparence. Ce script en dérive :
 *
 *  - `public/icon.png`  — icône de la fenêtre Electron + cibles macOS/Linux
 *  - `build/icon.png`   — réserve pour electron-builder (≥ 256 px exigé)
 *  - `app/icon.png`     — favicon du navigateur (convention Next.js App Router)
 *  - `build/icon.ico`   — icône Windows multi-tailles (16 → 256 px)
 *
 * ⚠️ L'ancien `build/icon.ico` datait d'un autre logo : sans cette
 * régénération, l'installateur, le raccourci du bureau et la barre des tâches
 * auraient continué d'afficher l'ancienne image.
 *
 * L'ICO est écrit à la main : le format accepte des entrées PNG depuis Windows
 * Vista, et `sharp` ne produit pas d'ICO. Le conteneur est trivial (en-tête +
 * un répertoire de 16 octets par taille, puis les PNG concaténés).
 *
 * Usage : `node scripts/generate-icons.js`
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');

const SOURCE_CANDIDATES = [
  path.join(root, 'public', 'icon.jpg'),
  path.join(root, 'public', 'logo.jpg'),
  path.join(root, 'public', 'icon.png'),
];

/** Tailles contenues dans l'ICO Windows, du plus petit au plus grand. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function findSource() {
  for (const candidate of SOURCE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Aucun logo source trouvé. Déposez « public/logo.jpg » ou « public/icon.jpg ». ` +
      `Cherché : ${SOURCE_CANDIDATES.map((c) => path.relative(root, c)).join(', ')}`,
  );
}

/**
 * Assemble un fichier ICO à partir de PNG.
 * @param {{size: number, buffer: Buffer}[]} images
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // réservé
  header.writeUInt16LE(1, 2); // type 1 = icône
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = directory.subarray(index * 16, (index + 1) * 16);
    // 256 se note 0 dans un octet : c'est la convention du format.
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2); // nombre de couleurs (0 = true color)
    entry.writeUInt8(0, 3); // réservé
    entry.writeUInt16LE(1, 4); // plans
    entry.writeUInt16LE(32, 6); // bits par pixel
    entry.writeUInt32LE(image.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.buffer.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.buffer)]);
}

async function main() {
  const source = findSource();
  const metadata = await sharp(source).metadata();

  console.log(`Source : ${path.relative(root, source)} (${metadata.width}×${metadata.height}, ${metadata.format})`);

  if (!metadata.width || Math.min(metadata.width, metadata.height) < 256) {
    console.warn(
      `⚠️  Image source plus petite que 256 px : l'icône Windows sera interpolée et paraîtra floue.`,
    );
  }

  // On ne monte jamais en résolution au-delà de la source : agrandir une image
  // ne crée pas de détail, cela ne fait que la rendre floue.
  const master = Math.min(metadata.width ?? 500, metadata.height ?? 500);

  const targets = [
    { file: 'build/icon.png', size: master },
    { file: 'public/icon.png', size: Math.min(master, 500) },
    { file: 'app/icon.png', size: Math.min(master, 256) },
  ];

  for (const target of targets) {
    const destination = path.join(root, target.file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await sharp(source)
      .resize(target.size, target.size, { fit: 'cover', position: 'centre' })
      .png({ compressionLevel: 9 })
      .toFile(destination);

    console.log(`✓ ${target.file} (${target.size}×${target.size})`);
  }

  const icoImages = [];
  for (const size of ICO_SIZES) {
    const buffer = await sharp(source)
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    icoImages.push({ size, buffer });
  }

  const ico = buildIco(icoImages);
  const icoPath = path.join(root, 'build', 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log(`✓ build/icon.ico (${ICO_SIZES.join(', ')} px — ${Math.round(ico.length / 1024)} Ko)`);

  console.log('\nIcônes régénérées. Relancez `npm run build:desktop:win` pour un installeur à jour.');
}

main().catch((error) => {
  console.error('Échec de la génération des icônes :', error.message);
  process.exit(1);
});
