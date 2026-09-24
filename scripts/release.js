#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const allowedBumps = new Set(["patch", "minor", "major"]);
const args = process.argv.slice(2);

let bump = "patch";
let message = "chore: update app";
let remote = "origin";
let shouldPush = true;

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (allowedBumps.has(arg)) {
    bump = arg;
    continue;
  }

  if (arg === "-m" || arg === "--message") {
    message = args[index + 1];
    if (!message) fail("Message de commit manquant apres --message.");
    index += 1;
    continue;
  }

  if (arg === "--remote") {
    remote = args[index + 1];
    if (!remote) fail("Nom du remote manquant apres --remote.");
    index += 1;
    continue;
  }

  if (arg === "--no-push") {
    shouldPush = false;
    continue;
  }

  fail(`Option inconnue: ${arg}`);
}

function run(command, commandArgs, options = {}) {
  const capture = Boolean(options.capture);
  const result = spawnSync(commandName(command), commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: shouldUseShell(command),
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.status !== 0 && !options.allowFailure) {
    if (capture && result.stderr) {
      console.error(result.stderr.trim());
    }
    process.exit(result.status || 1);
  }

  return capture ? (result.stdout || "").trim() : result;
}

function succeeds(command, commandArgs) {
  const result = spawnSync(commandName(command), commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: shouldUseShell(command),
    stdio: "ignore",
  });
  return result.status === 0;
}

function commandName(command) {
  if (process.platform === "win32" && command === "npm") {
    return "npm.cmd";
  }

  return command;
}

function shouldUseShell(command) {
  return process.platform === "win32" && command === "npm";
}

function nextVersion(currentVersion, bumpType) {
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    fail(`Version package.json non supportee: ${currentVersion}`);
  }

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  if (bumpType === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bumpType === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

run("git", ["rev-parse", "--is-inside-work-tree"], { capture: true });

const branch = run("git", ["branch", "--show-current"], { capture: true });
if (!branch) {
  fail("Impossible de publier depuis un etat Git detache. Change de branche puis relance la commande.");
}

const packagePath = path.join(process.cwd(), "package.json");
const packageLockPath = path.join(process.cwd(), "package-lock.json");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const version = nextVersion(packageJson.version, bump);
const tag = `v${version}`;

if (succeeds("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`])) {
  fail(`Le tag ${tag} existe deja. Augmente la version ou supprime le tag avant de publier.`);
}

const protectedPaths = [
  "db-error.log",
  "db/database.db",
  "db/database.db-shm",
  "db/database.db-wal",
];

console.log(`\nPublication ${tag} depuis la branche ${branch}...\n`);

run("git", ["add", "-A"]);

const stagedProtected = run("git", ["diff", "--cached", "--name-only", "--", ...protectedPaths], {
  capture: true,
  allowFailure: true,
})
  .split(/\r?\n/)
  .filter(Boolean);

if (stagedProtected.length > 0) {
  run("git", ["restore", "--staged", "--", ...stagedProtected]);
  console.log(`Fichiers locaux exclus de la release: ${stagedProtected.join(", ")}`);
}

if (succeeds("git", ["diff", "--cached", "--quiet"])) {
  console.log("Aucun changement applicatif non commite. Creation du commit de version uniquement.");
} else {
  run("git", ["commit", "-m", message]);
}

run("npm", ["version", bump, "--no-git-tag-version"]);
run("git", ["add", "package.json"]);

if (fs.existsSync(packageLockPath)) {
  run("git", ["add", "package-lock.json"]);
}

run("git", ["commit", "-m", `chore: release ${tag}`]);
run("git", ["tag", tag]);

if (shouldPush) {
  run("git", ["push", remote, branch]);
  run("git", ["push", remote, tag]);
  console.log(`\n${tag} envoye sur GitHub. GitHub Actions va construire la release desktop.`);
} else {
  console.log(`\n${tag} cree localement. Push manuel: git push ${remote} ${branch} && git push ${remote} ${tag}`);
}
