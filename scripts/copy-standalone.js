const fs = require('fs');
const path = require('path');

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');
const standaloneNodeModules = path.join(standalone, 'node_modules');
const rootPackagePath = path.join(root, 'package.json');
const externalAliasPackages = new Set(['@libsql/client', 'libsql']);
const forcedRuntimePackages = ['electron-updater'];
const externalAliasSubpaths = new Map([
  ['@libsql/client', ['node', 'sqlite3', 'http', 'ws', 'web']],
]);

function copy(src, dest, label) {
  if (!fs.existsSync(src)) {
    console.warn(`Warning: ${label} missing: ${src}`);
    return;
  }

  console.log(`Copying ${label}...`);
  fs.cpSync(src, dest, { recursive: true, force: true });
  console.log(`Copied ${label}`);
}

function remove(target, label) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`Removed ${label}`);
  }
}

function walk(dir, visitor) {
  if (!fs.existsSync(dir)) {
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    visitor(fullPath, entry);
    if (entry.isDirectory()) {
      walk(fullPath, visitor);
    }
  }
}

function ensureExternalAliases() {
  const serverDir = path.join(standalone, '.next', 'server');
  if (!fs.existsSync(serverDir) || !fs.existsSync(standaloneNodeModules)) {
    return;
  }

  const aliasPattern = /(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)-([0-9a-f]{16,})\b/gi;
  const aliases = new Map();

  walk(serverDir, (fullPath, entry) => {
    if (!entry.isFile() || (!entry.name.endsWith('.json') && !entry.name.endsWith('.js'))) {
      return;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    for (const match of content.matchAll(aliasPattern)) {
      const alias = match[0];
      const basePackage = match[1];

      if (!externalAliasPackages.has(basePackage)) {
        continue;
      }

      aliases.set(alias, basePackage);
    }
  });

  for (const [alias, basePackage] of aliases) {
    const aliasDir = path.join(standaloneNodeModules, alias);
    const baseDir = path.join(standaloneNodeModules, basePackage);

    if (!fs.existsSync(baseDir) || fs.existsSync(aliasDir)) {
      continue;
    }

    fs.mkdirSync(aliasDir, { recursive: true });
    writeAliasPackage(aliasDir, alias, basePackage);

    console.log(`Created external alias: ${alias} -> ${basePackage}`);
  }
}

function getPackagePath(packageName) {
  return path.join(root, 'node_modules', ...packageName.split('/'));
}

function copyRuntimePackage(packageName, copied = new Set()) {
  if (copied.has(packageName)) {
    return;
  }

  copied.add(packageName);

  const sourceDir = getPackagePath(packageName);
  const packagePath = path.join(sourceDir, 'package.json');

  if (!fs.existsSync(packagePath)) {
    console.warn(`Warning: runtime package missing: ${packageName}`);
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ];

  for (const dependencyName of dependencyNames) {
    copyRuntimePackage(dependencyName, copied);
  }

  copy(sourceDir, path.join(standaloneNodeModules, ...packageName.split('/')), `runtime package ${packageName}`);
}

function ensureForcedRuntimePackages() {
  for (const packageName of forcedRuntimePackages) {
    copyRuntimePackage(packageName);
  }
}

function writeAliasPackage(aliasDir, alias, basePackage) {
  const exportsMap = { '.': './index.js' };
  for (const subpath of externalAliasSubpaths.get(basePackage) ?? []) {
    exportsMap[`./${subpath}`] = `./${subpath}.js`;
  }

  fs.writeFileSync(
    path.join(aliasDir, 'package.json'),
    JSON.stringify({ name: alias, private: true, main: 'index.js', exports: exportsMap }, null, 2)
  );
  fs.writeFileSync(
    path.join(aliasDir, 'index.js'),
    `module.exports = require(${JSON.stringify(basePackage)});\n`
  );

  for (const subpath of externalAliasSubpaths.get(basePackage) ?? []) {
    fs.writeFileSync(
      path.join(aliasDir, `${subpath}.js`),
      `module.exports = require(${JSON.stringify(`${basePackage}/${subpath}`)});\n`
    );
  }
}

function rewriteStandalonePackageJson() {
  const rootPkg = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));
  const standalonePkgPath = path.join(standalone, 'package.json');
  const minimalPkg = {
    name: rootPkg.name,
    version: rootPkg.version,
    // `productName` doit être conservé : c'est lui qu'electron-builder utilise
    // pour le nom de l'application, de l'installeur et des raccourcis. Sans lui,
    // l'application s'appelle « gestion-planete-deco » dans Windows.
    // (`electron/main.js` fixe de son côté le dossier de données à
    // `%APPDATA%/planete-deco`, indépendamment de ce nom.)
    productName: rootPkg.build?.productName ?? rootPkg.productName,
    description: rootPkg.description,
    author: rootPkg.author,
    private: true,
    main: 'electron/main.js',
    optionalDependencies: {},
  };

  fs.writeFileSync(standalonePkgPath, JSON.stringify(minimalPkg, null, 2));
  console.log('Rewrote standalone package.json for Electron packaging');
}

remove(path.join(standalone, 'release'), 'standalone/release');
remove(path.join(standalone, 'data'), 'standalone/data');
remove(path.join(standalone, 'tmp-electron'), 'standalone/tmp-electron');
remove(path.join(standalone, 'db-error.log'), 'standalone/db-error.log');
remove(path.join(standalone, '.next', 'node_modules'), 'standalone/.next/node_modules');

copy(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'), '.next/static');
copy(path.join(root, 'public'), path.join(standalone, 'public'), 'public');
copy(path.join(root, 'db', 'migrations'), path.join(standalone, 'db', 'migrations'), 'db/migrations');
copy(path.join(root, 'electron'), path.join(standalone, 'electron'), 'electron');

ensureExternalAliases();
ensureForcedRuntimePackages();
rewriteStandalonePackageJson();

console.log('\nStandalone packaging is ready');
