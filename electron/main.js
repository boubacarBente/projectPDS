const { app, BrowserWindow, shell, dialog, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const http = require('http');
const crypto = require('crypto');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (error) {
  console.warn('[updater] désactivé :', error.message);
}

/**
 * Processus principal Electron — Planète Déco.
 *
 * Chaîne reprise du projet Gaz (README §22) : jeton d'accès, port libre,
 * serveur Next lancé par `fork`, mise à jour automatique.
 *
 * Adaptations Planète Déco :
 *  - identité de l'application (`Planète Déco`, `com.planetedeco.gestion`) ;
 *  - fenêtre **minimum 1024 × 700** (README §5.5 règle 10) : en dessous, la
 *    sidebar se replie automatiquement (breakpoint `lg` du design system) ;
 *  - **instance unique** : deux instances se disputeraient le même fichier
 *    SQLite local — c'est le risque le plus concret sur un poste de travail ;
 *  - arrêt propre du serveur Next, arbre de processus compris ;
 *  - messages et journal de mise à jour en français ;
 *  - en cas d'échec de chargement, une boîte de dialogue explique au lieu de
 *    laisser une fenêtre blanche.
 */

// ── Jeton d'accès à l'application ─────────────────────────────────────
// Régénéré à chaque lancement, transmis au serveur Next par variable
// d'environnement et injecté dans chaque requête émise par la fenêtre.
// Sans lui, `proxy.ts` répond 404 : l'application est inatteignable depuis un
// navigateur, y compris sur localhost.
const appToken = crypto.randomBytes(32).toString('hex');

const APP_ID = 'com.planetedeco.gestion';
const PRODUCT_NAME = 'Planète Déco';

if (autoUpdater) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Une pré-version ne doit jamais être poussée automatiquement sur un poste de
  // production : le client travaille, il ne teste pas.
  autoUpdater.allowPrerelease = false;
}

function getErrorMessage(error) {
  if (!error) return 'Erreur inconnue';
  return error.message || String(error);
}

function updaterLogPath() {
  const basePath = app.isReady() ? app.getPath('userData') : process.env.ELECTRON_APP_PATH;
  return basePath ? path.join(basePath, 'updater.log') : null;
}

function logUpdater(level, message, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${extra ? ` ${extra}` : ''}`;
  const logger = console[level] || console.log;
  logger(line);

  try {
    const filePath = updaterLogPath();
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (error) {
    console.warn('[updater] écriture du journal impossible :', getErrorMessage(error));
  }
}

function sendUpdaterEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function runUpdateCheck(source = 'manual') {
  if (!app.isPackaged) {
    return { status: 'dev', version: app.getVersion() };
  }

  if (!autoUpdater) {
    return { status: 'unavailable' };
  }

  try {
    logUpdater('info', `Vérification des mises à jour (${source}) — version actuelle ${app.getVersion()}`);
    sendUpdaterEvent('update-checking', { source, version: app.getVersion() });
    const result = await autoUpdater.checkForUpdates();
    return { status: 'ok', updateInfo: result ? result.updateInfo : null };
  } catch (error) {
    const message = getErrorMessage(error);
    logUpdater('error', `Échec de la vérification (${source}) : ${message}`);
    sendUpdaterEvent('update-error', { source, message });
    return { status: 'error', error: message };
  }
}

// ── Serveur Next ──────────────────────────────────────────────────────
let serverProcess = null;
let serverPort = 3000;

/**
 * Trouve un port réellement libre **pour l'interface de boucle locale**.
 *
 * ⚠️ Correction importante par rapport au projet Gaz. La version d'origine
 * écoutait sur toutes les interfaces (`server.listen(port)`), ce qui peut
 * réussir **alors que `127.0.0.1:<port>` est déjà pris** — Windows autorise
 * `0.0.0.0` et `127.0.0.1` à coexister. Conséquence observée en vérification :
 * lancée pendant qu'un serveur de développement occupait `127.0.0.1:3000`,
 * l'application croyait le port libre, son propre serveur mourait sur
 * `EADDRINUSE`, et la fenêtre se connectait **au serveur étranger** — donc à
 * une autre base de données.
 *
 * On teste donc exactement l'adresse sur laquelle le serveur Next sera lié
 * (`HOSTNAME: '127.0.0.1'`), ce qui rend la réservation fidèle.
 */
function findFreePort(startPort) {
  return new Promise((resolve) => {
    const server = require('net').createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => resolve(findFreePort(startPort + 1)));
  });
}

async function startNextServer() {
  const isDev = !app.isPackaged;

  if (isDev) {
    serverPort = 12000;
    // 127.0.0.1 et non « localhost » : le serveur de dev est lié à IPv4
    // uniquement, or « localhost » peut résoudre vers ::1 d'abord.
    return `http://127.0.0.1:${serverPort}`;
  }

  serverPort = await findFreePort(3000);

  const serverScript = path.join(app.getAppPath(), 'server.js');

  serverProcess = fork(serverScript, [], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(serverPort),
      // Base de données et sauvegardes dans %APPDATA%/planete-deco (README §22).
      ELECTRON_APP_PATH: app.getPath('userData'),
      // Next standalone écoute sur 0.0.0.0 par défaut : on le limite à la
      // boucle locale. Le jeton ferme le navigateur local, ceci ferme le réseau.
      HOSTNAME: '127.0.0.1',
      APP_TOKEN: appToken,
    },
    stdio: 'inherit',
  });

  const url = `http://127.0.0.1:${serverPort}`;
  await waitForServer(url);
  return url;
}

function waitForServer(url, retries = 90, delay = 1000) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const check = () => {
      http
        .get(url, (res) => {
          // Un 404 est une réponse valide : le serveur est vivant (c'est ce que
          // renvoie `proxy.ts` à une requête sans jeton, cas de cette sonde).
          if (res.statusCode < 500) resolve();
          else retry();
        })
        .on('error', retry);
    };
    const retry = () => {
      count++;
      if (count >= retries) {
        reject(
          new Error(
            `Le serveur local n'a pas répondu après ${retries} tentatives. ` +
              "Fermez l'application et relancez-la ; si le problème persiste, consultez db-error.log.",
          ),
        );
      } else {
        setTimeout(check, delay);
      }
    };
    check();
  });
}

/** Arrêt du serveur Next, arbre de processus compris. */
function stopNextServer() {
  if (!serverProcess) return;

  const child = serverProcess;
  serverProcess = null;

  try {
    if (process.platform === 'win32' && child.pid) {
      // `child.kill()` ne tue que le processus Node intermédiaire : les
      // processus de Next survivraient et garderaient le port et le fichier
      // SQLite ouverts.
      require('child_process').execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (error) {
    console.warn('[electron] arrêt du serveur :', getErrorMessage(error));
  }
}

// ── Fenêtre ───────────────────────────────────────────────────────────
let mainWindow = null;

function resolveIcon() {
  const candidates = [
    path.join(app.getAppPath(), 'public', 'icon.png'),
    path.join(__dirname, '..', 'public', 'icon.png'),
    path.join(process.resourcesPath || '', 'app', 'public', 'icon.png'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* on essaie le candidat suivant */
    }
  }

  return undefined;
}

async function createWindow(url) {
  mainWindow = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    icon: resolveIcon(),
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
    show: false,
  });

  // Aucune barre d'outils : c'est `BackButton` qui assure la navigation
  // (README §5.4 — « en desktop il n'existe aucune barre d'outils, donc aucun
  // moyen de rafraîchir autrement »).
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (process.env.DEBUG) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
    if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') {
      mainWindow.webContents.reload();
    }
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[electron] rendu interrompu :', details);
  });

  mainWindow.webContents.on('preload-error', (event, preloadPath, error) => {
    console.error('[electron] erreur de preload :', error);
  });

  // Une fenêtre blanche n'apprend rien à l'utilisateur : on explique.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[electron] échec de chargement :', errorCode, errorDescription, validatedURL);
    dialog.showErrorBox(
      'Chargement impossible',
      `L'application n'a pas pu charger son interface (${errorDescription}).\n\n` +
        'Fermez puis relancez Planète Déco.',
    );
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  // Injection du jeton dans TOUTES les requêtes de la fenêtre (navigation
  // initiale, chunks JS/CSS, fetch, payloads RSC). À enregistrer AVANT loadURL.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`http://127.0.0.1:${serverPort}/*`, `http://localhost:${serverPort}/*`] },
    (details, callback) => {
      details.requestHeaders['x-app-token'] = appToken;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  await mainWindow.loadURL(url);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Cycle de vie ──────────────────────────────────────────────────────
//
// Instance unique : deux instances ouvriraient deux fois le même `database.db`
// et se marcheraient dessus (verrous WAL, migrations concurrentes). La seconde
// tentative ramène simplement la fenêtre existante au premier plan.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Nécessaire pour que Windows associe correctement les notifications et
  // l'icône de la barre des tâches à l'application.
  app.setAppUserModelId(APP_ID);

  /*
   * Dossier de données **stable** (README §22 : `%APPDATA%/planete-deco`).
   *
   * Sans cette ligne, Electron dérive le dossier de `app.getName()`, donc du
   * `name` du `package.json` embarqué. Constaté à l'empaquetage : la base
   * atterrissait dans `%APPDATA%\gestion-planete-deco`, et non dans
   * `planete-deco` comme le documente le contrat de conception. Pire : le jour
   * où ce nom change, la base de données du client devient introuvable — elle
   * semble perdue alors qu'elle est simplement ailleurs.
   *
   * On fixe donc le chemin explicitement, une fois pour toutes.
   */
  try {
    const userDataDir = path.join(app.getPath('appData'), 'planete-deco');
    fs.mkdirSync(userDataDir, { recursive: true });
    app.setPath('userData', userDataDir);
  } catch (error) {
    console.warn('[electron] dossier de données personnalisé indisponible :', getErrorMessage(error));
  }

  app.whenReady().then(async () => {
    // Chemin persistant AVANT de démarrer le serveur : `db/index.ts` lit
    // `ELECTRON_APP_PATH` au moment de l'import.
    process.env.ELECTRON_APP_PATH = app.getPath('userData');

    try {
      const url = await startNextServer();
      await createWindow(url);

      if (autoUpdater) setupAutoUpdater();

      if (app.isPackaged && autoUpdater) {
        // Laisser l'interface s'afficher avant d'interroger le serveur de
        // mises à jour : l'utilisateur doit voir son application tout de suite.
        setTimeout(() => {
          void runUpdateCheck('startup');
        }, 3000);
      }
    } catch (err) {
      console.error('Démarrage impossible :', err);
      dialog.showErrorBox('Erreur de démarrage', getErrorMessage(err));
      stopNextServer();
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    stopNextServer();
    app.quit();
  });

  app.on('before-quit', () => {
    stopNextServer();
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const url = await startNextServer();
      await createWindow(url);
    }
  });
}

// ── Mise à jour automatique ───────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.logger = {
    info: (message) => logUpdater('info', String(message)),
    warn: (message) => logUpdater('warn', String(message)),
    error: (message) => logUpdater('error', String(message)),
    debug: (message) => logUpdater('debug', String(message)),
  };

  autoUpdater.on('checking-for-update', () => {
    logUpdater('info', 'Vérification en cours…');
    sendUpdaterEvent('update-checking', { version: app.getVersion() });
  });

  autoUpdater.on('update-available', (info) => {
    logUpdater('info', `Mise à jour ${info.version} disponible — téléchargement automatique…`);
    sendUpdaterEvent('update-available', { version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    logUpdater('info', `Aucune mise à jour disponible. Dernière version distante : ${info.version}`);
    sendUpdaterEvent('update-not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdaterEvent('update-progress', { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    logUpdater('info', `Mise à jour ${info.version} téléchargée.`);
    sendUpdaterEvent('update-downloaded', { version: info.version });

    const response = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      title: 'Mise à jour prête',
      message: `La version ${info.version} a été téléchargée.`,
      detail: "Redémarrer maintenant pour l'installer ?",
      buttons: ['Redémarrer maintenant', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (response === 0) {
      // `true, true` : installation silencieuse puis relance. Sans cela,
      // l'installateur NSIS réaffiche tout son assistant.
      stopNextServer();
      autoUpdater.quitAndInstall(true, true);
    }
  });

  autoUpdater.on('error', (err) => {
    const message = getErrorMessage(err);
    logUpdater('error', `Erreur : ${message}`);
    sendUpdaterEvent('update-error', { message });
  });
}

// ── IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('check-for-updates', async () => runUpdateCheck('manual'));
ipcMain.handle('get-app-version', () => app.getVersion());
