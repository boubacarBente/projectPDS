# typescript-lsp (adapté à projetPDS)

Copie du plugin `typescript-lsp` d'anthropics/claude-plugins-official, **adaptée** :
l'original lance `typescript-language-server`, qui s'appuie sur `tsserver` — absent de
TypeScript 7 (réécrit en Go). Le projet utilise TS 7.0.2 : on lance donc son serveur de
langage natif, `node node_modules/typescript/bin/tsc --lsp -stdio` (déclaré dans
`../.claude-plugin/marketplace.json`, champ `lspServers`). Rien à installer
globalement ; il suffit que `npm install` ait été fait.
