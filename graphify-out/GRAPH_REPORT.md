# Graph Report - projetPDS  (2026-10-08)

## Corpus Check
- 486 files · ~793,632 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 14 file(s) not represented in the graph (top: (none) 9, .cmd 1, .dot 1)

## Summary
- 4629 nodes · 17461 edges · 206 communities (172 shown, 34 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 404 edges (avg confidence: 0.93)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `564a3c84`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- formatNumber
- chantiers-modals.tsx
- formatDateShort
- MoneyText
- schema.ts
- ok
- useAuth
- api.ts
- withTransaction
- NotFoundError
- briqueterie-modals.tsx
- furniture.ts
- stores.ts
- today
- brick-orders.ts
- server.cjs
- fail
- permissions.ts
- brick.ts
- Planète Déco Sarlu — Filiale Meubles
- commandes-modals.tsx
- ventes/nouvelle/page.tsx
- users.ts
- atelier-modals.tsx
- scopeSql
- users/route.ts
- report-sender.ts
- stock/page.tsx
- Subagent-Driven Development
- purchases.ts
- sales.ts
- products.ts
- sync-engine.ts
- transfers.ts
- requireAction
- Installation
- package.json
- scripts
- Test-Driven Development (TDD)
- ValidationError
- services.ts
- build
- settings-schema.ts
- assertStoreVisible
- design-system.tsx
- index.mjs
- suppliers.ts
- scroll-engine.ts
- backup.ts
- caisse.ts
- briqueterie/rapport-export.tsx
- brick-analytics.ts
- index.ts
- ref_fs
- 6. Pages, une par une
- main.js
- audit.ts
- workers.ts
- app-shell.tsx
- triggers.ts
- productions/[id]/route.ts
- quantity
- chrome-devtools-cli/SKILL.md
- Visual Companion Guide
- Creation Log: Systematic Debugging Skill
- debug-optimize-lcp/SKILL.md
- Session diagnosis: <session-id>
- Security Scan Skill
- copy-standalone.js
- release.js
- compilerOptions
- Workflow Patterns
- inventaires/[id]/page.tsx
- Code Review Reception
- Testing CLAUDE.md Skills Documentation
- stock.ts
- schema-dbml.mjs
- verify-ui.js
- balances.ts
- Common Memory Leaks
- Root Cause Tracing
- Systematic Debugging
- Persuasion Principles for Skill Design
- dependencies
- Finishing a Development Branch
- Condition-Based Waiting
- Using Git Worktrees
- Writing Skills
- Guide multi-magasins — procédure complète, page par page
- server/package.json
- Invariants à ne pas casser
- produits/[id]/route.ts
- Dispatching Parallel Agents
- devDependencies
- 23. Synchronisation avec PostgreSQL (option en ligne)
- verify-routes-e2e.js
- Troubleshooting Wizard
- Testing Skills With Subagents
- Conventions de développement — Planète Déco
- Parcours de démonstration — chantiers, briqueterie, atelier
- device.ts
- verify-export-image.js
- verify-sales-draft-e2e.js
- CloseCashSessionModal
- theme-provider.tsx
- parametres/page.tsx
- Defense-in-Depth Validation
- Writing Plans
- [Analysis Title]
- Workflow Patterns
- Brainstorming Ideas Into Designs
- Returns: "OK" or lists conflicts
- 7. Modules fonctionnels
- generate-icons.js
- verify-chantiers-e2e.js
- Verification Before Completion
- Skill structure
- applyThemeColors
- verify-briqueterie-e2e.js
- clients/[id]/route.ts
- Workflow Patterns
- helper.js
- codex-tools.md
- Skill authoring best practices
- GitHub
- verify-atelier-e2e.js
- issue.md
- update-status.tsx
- ✅ Fait
- Frontend Design
- stop-server.sh
- Diagnosing Superpowers
- Superpowers session diagnosis bundle
- Case: <session-id>
- Gemini CLI Tool Mapping
- Hermes Agent Tool Mapping
- REFACTOR Phase: Close Loopholes (Stay Green)
- allowScripts
- 5. Architecture et structure du projet
- scope.test.mjs
- ref_node_fs
- verify-purchases-e2e.js
- LCP Optimization Strategies
- Frontend Design Plugin
- Muse Tool Mapping
- using-superpowers/SKILL.md
- Skill Discovery Optimization (SDO)
- Bulletproofing Skills Against Rationalization
- probe-export-ui.js
- verify-export-e2e.js
- Elements and Size for LCP
- Context7
- Pressure Test 1: Emergency Production Fix
- Pressure Test 2: Sunk Cost + Exhaustion
- Pressure Test 3: Authority + Social Pressure
- anthropic-best-practices.md
- Anti-Patterns
- Testing All Skill Types
- RED-GREEN-REFACTOR for Skills
- VERIFY GREEN: Pressure Testing
- proxy.ts
- electron-api.d.ts
- Largest Contentful Paint (LCP) Breakdown
- GitHub issues
- Pi Tool Mapping
- Evaluation and iteration
- Checklist for effective Skills
- Core principles
- File Organization
- Skill Types
- Example: TDD Skill Bulletproofing
- 6.1 `/login` — Connexion, première installation, choix du magasin ✅
- 28. Multi-magasins (v2)
- start-server.sh
- Antigravity CLI (`agy`) Tool Mapping
- Claude Code Tool Notes
- metric-card.tsx
- CLAUDE.md
- .claude/CLAUDE.md
- .mcp.json
- spec-document-reviewer-prompt.md
- context-safety.md
- redaction-policy.md
- session-discovery.md
- find-polluter.sh
- test-academic.md
- typescript-lsp/README.md
- postcss.config.mjs

## God Nodes (most connected - your core abstractions)
1. `fail()` - 303 edges
2. `ok()` - 302 edges
3. `requireAction()` - 298 edges
4. `ValidationError` - 244 edges
5. `writeAudit()` - 189 edges
6. `NotFoundError` - 185 edges
7. `next` - 176 edges
8. `MoneyText()` - 172 edges
9. `formatNumber()` - 157 edges
10. `parseId()` - 146 edges

## Surprising Connections (you probably didn't know these)
- `6.7 `/depenses` ✅` --references--> `useSettings()`  [INFERRED]
  docs/GUIDE-MULTI-MAGASINS.md → app/parametres/page.tsx
- `5.5 Responsive — la règle des 5 largeurs` --references--> `ResponsiveTable()`  [INFERRED]
  README.md → components/responsive-table.tsx
- `8. Design system — composants disponibles` --references--> `ActionIcon`  [INFERRED]
  docs/CONVENTIONS.md → components/row-actions.tsx
- `3.1 Repris **tel quel** (copie de fichier, zéro modification)` --references--> `useSearchFilter()`  [INFERRED]
  README.md → components/search-filter.tsx
- `10. Ordre de travail recommandé pour terminer` --references--> `StoreScopeSelect()`  [INFERRED]
  docs/GUIDE-MULTI-MAGASINS.md → components/store-scope.tsx

## Import Cycles
- None detected.

## Communities (206 total, 34 thin omitted)

### Community 0 - "formatNumber"
Cohesion: 0.05
Nodes (205): AchatsPage(), isPaymentStatusFilter(), isStatsPeriod(), PAYMENT_STATUS_OPTIONS, PaymentStatusFilter, PERIODS, PurchaseStats, StatsPeriod (+197 more)

### Community 1 - "chantiers-modals.tsx"
Cohesion: 0.03
Nodes (186): DemandeDetailPage(), setStatus(), MANUAL, ConvertModal(), submit(), post(), NouveauDevisPage(), submit() (+178 more)

### Community 2 - "formatDateShort"
Cohesion: 0.04
Nodes (165): AchatDetailPage(), LoadedPurchase, CustomerOption, isPaymentStatusFilter(), PAYMENT_STATUS_OPTIONS, PaymentStatusFilter, VentesBriqueteriePage(), ViewState (+157 more)

### Community 3 - "MoneyText"
Cohesion: 0.05
Nodes (89): CARD_TOOLTIPS, CardTitle(), CHIP_TONES, ChipTone, DashboardHeader(), DashboardPage(), Icon(), ICONS (+81 more)

### Community 4 - "schema.ts"
Cohesion: 0.02
Nodes (115): AuditLog, auditLogRelations, auditLogs, BRICK_ORDER_STATUS_VALUES, BRICK_STAGE_VALUES, brickProductions, brickProductionWorkers, brickTypes (+107 more)

### Community 5 - "ok"
Cohesion: 0.07
Nodes (90): POST(), DELETE(), GET(), modelFor(), Params, PUT(), POST(), Params (+82 more)

### Community 6 - "useAuth"
Cohesion: 0.05
Nodes (67): AuditEntry, MagasinFichePage(), StatusChange, StoreUser, Tab, TABS, EMPTY_INDICATORS, isPeriod() (+59 more)

### Community 7 - "api.ts"
Cohesion: 0.08
Nodes (58): GET(), GET(), GET(), GET(), GET(), GET(), GET(), GET() (+50 more)

### Community 8 - "withTransaction"
Cohesion: 0.05
Nodes (85): SettingsProvider(), withTransaction(), inventories, inventoryItems, settings, 3. Règles métier à ne jamais casser, createBrickProduction(), createCustomer() (+77 more)

### Community 9 - "NotFoundError"
Cohesion: 0.07
Nodes (74): 3. Règle d'or : toute écriture passe par `lib/`, ConflictError, NotFoundError, addJobItem(), addJobMaterialInTx(), addJobStage(), addJobSubcontract(), assertJobEditable() (+66 more)

### Community 10 - "briqueterie-modals.tsx"
Cohesion: 0.04
Nodes (87): ACTION_LABELS, BrickProductionDetailPage(), advance(), cancelProduction(), removeExpense(), removeMaterial(), removeWorker(), saveTeam() (+79 more)

### Community 11 - "furniture.ts"
Cohesion: 0.08
Nodes (69): PUT(), BrickStage, recalculateCashBalances(), assertCustomerInStore(), roundMoney(), addOrderMaterial(), addOrderWorker(), advanceFurnitureStage() (+61 more)

### Community 12 - "stores.ts"
Cohesion: 0.07
Nodes (55): POST(), registerFailure(), POST(), GET(), GET(), POST(), stores, userStores (+47 more)

### Community 13 - "today"
Cohesion: 0.06
Nodes (61): db, customers, serviceRequests, CustomerStats, today(), jobCategoryStoredValues(), Filters, getJobsDashboard() (+53 more)

### Community 14 - "brick-orders.ts"
Cohesion: 0.07
Nodes (61): brickOrderItems, brickOrders, furnitureOrders, payments, purchaseInvoices, salesInvoices, serviceJobs, assertOrderEditable() (+53 more)

### Community 15 - "server.cjs"
Cohesion: 0.05
Nodes (57): bootstrapPage(), brandMarkup(), broadcast(), browserLauncherForPlatform(), chmodOwnerOnly(), clients, companionUrl(), computeAcceptKey() (+49 more)

### Community 16 - "fail"
Cohesion: 0.07
Nodes (42): POST(), SwitchForbiddenError, GET(), GET(), Params, POST(), POST(), GET() (+34 more)

### Community 17 - "permissions.ts"
Cohesion: 0.07
Nodes (52): PasswordInput(), PasswordInputProps, AccessChoices, AccessEditor(), AccessSummary(), actionsFromChoices(), AreaChoice, choicesFromActions() (+44 more)

### Community 18 - "brick.ts"
Cohesion: 0.08
Nodes (58): PUT(), addProductionExpense(), addProductionWorker(), advanceStage(), assertBrickTypeInStore(), assertExpenseOfProduction(), assertProductionEditable(), assertWorkerAvailable() (+50 more)

### Community 19 - "Planète Déco Sarlu — Filiale Meubles"
Cohesion: 0.04
Nodes (57): 12. Stock et inventaire, 13. Caisse et solde, 14. Achats et dépenses, 16.1 Rapports affichés et exportés (§11), 16.2 Envoi automatique des rapports (§11), 16.3 Canaux, 16. Rapports et envoi SMS / WhatsApp, 18. Sauvegarde, restauration et sécurité (+49 more)

### Community 20 - "commandes-modals.tsx"
Cohesion: 0.09
Nodes (46): BrickOrderDetailPage(), buildQuery(), OrdersSummary, OrdersViewState, BRICK_ORDER_NEXT_STATUSES, BRICK_ORDER_STATUS_ACTIONS, BRICK_ORDER_STATUS_LABELS, BRICK_ORDER_STATUS_OPTIONS (+38 more)

### Community 21 - "ventes/nouvelle/page.tsx"
Cohesion: 0.06
Nodes (47): AchatsNouvelleContent(), CardTitle(), ComputedLine, computeLine(), DEFAULT_PAYMENT_METHODS, FieldLabel(), Icon(), ICONS (+39 more)

### Community 22 - "users.ts"
Cohesion: 0.09
Nodes (45): Params, PUT(), DELETE(), GET(), Params, GET(), users, deactivateUser() (+37 more)

### Community 23 - "atelier-modals.tsx"
Cohesion: 0.10
Nodes (46): AtelierOrderPage(), handleAdvance(), runAction(), reactivate(), bomFromMaterials(), BomLine, CancelOrderDialog(), CustomerOption (+38 more)

### Community 24 - "scopeSql"
Cohesion: 0.11
Nodes (47): rawAll(), rawGet(), getMonthlyTrend(), getCustomersSummary(), listDebtors(), getExpensesSummary(), endOfMonth(), parseBusinessDate() (+39 more)

### Community 25 - "users/route.ts"
Cohesion: 0.12
Nodes (39): GET(), Params, PUT(), DELETE(), GET(), OPTIONS(), Params, PUT() (+31 more)

### Community 26 - "report-sender.ts"
Cohesion: 0.06
Nodes (45): reportDeliveries, RapportCashMethod, RapportCollectedMethod, RapportComparison, RapportComparisonMetric, RapportDeliveryChannel, RapportDeliveryRow, RapportDeliveryStatus (+37 more)

### Community 27 - "stock/page.tsx"
Cohesion: 0.07
Nodes (43): BrickStockLine, BrickStockPayload, BrickStockSummary, buildStockColumns(), MOVEMENT_LABELS, MOVEMENT_TONES, movementColumns, MovementType (+35 more)

### Community 28 - "Subagent-Driven Development"
Cohesion: 0.04
Nodes (39): 1. Take the task, 2. Work the steps, 3. The completion contract, 4. Complete the task, Common Rationalizations, Example Workflow, Executing Plans, Final Review (+31 more)

### Community 29 - "purchases.ts"
Cohesion: 0.08
Nodes (44): purchaseInvoiceItems, SnapshotPeriod, applyStockDelta(), areQuantityMapsEqual(), assertSameStore(), auditUser(), buildPurchaseItems(), cancelPurchaseInvoice() (+36 more)

### Community 30 - "sales.ts"
Cohesion: 0.09
Nodes (45): applyStockDelta(), areQuantityMapsEqual(), assertBrickProducts(), assertSameStore(), auditUser(), buildSalesItems(), cancelSalesInvoice(), computeTotals() (+37 more)

### Community 31 - "products.ts"
Cohesion: 0.09
Nodes (42): categories, products, sqlOrderBy(), assertNameAvailable(), assertProductNameAvailable(), buildProductWhere(), CatalogEditError, CATEGORY_KINDS (+34 more)

### Community 32 - "sync-engine.ts"
Cohesion: 0.10
Nodes (40): POST(), rawRun(), syncedTable, getDeviceConfig(), applyChange(), ApplyContext, ApplyOutcome, call() (+32 more)

### Community 33 - "transfers.ts"
Cohesion: 0.14
Nodes (40): ACTION_PERMISSION, GET(), Params, POST(), withActions(), TRANSFER_EVENT_LABELS, TRANSFER_STAGES, TRANSFER_STATUS (+32 more)

### Community 34 - "requireAction"
Cohesion: 0.08
Nodes (27): GET(), PERIODS, GET(), GET(), PERIODS, GET(), POST(), POST() (+19 more)

### Community 35 - "Installation"
Cohesion: 0.06
Nodes (33): Antigravity, Claude Code, Codex App, Codex CLI, Commercial Services, Community, Contributing, Cursor (+25 more)

### Community 36 - "package.json"
Cohesion: 0.06
Nodes (29): { contextBridge, ipcRenderer }, on(), eslintConfig, author, description, main, name, private (+21 more)

### Community 37 - "scripts"
Cohesion: 0.06
Nodes (33): scripts, build, build:desktop:linux, build:desktop:mac, build:desktop:win, copy:standalone, db:dbml, db:generate (+25 more)

### Community 38 - "Test-Driven Development (TDD)"
Cohesion: 0.06
Nodes (29): Common Rationalizations, Debugging Integration, Example: Bug Fix, Final Rule, Good Tests, GREEN - Minimal Code, Overview, Red Flags - STOP and Start Over (+21 more)

### Community 39 - "ValidationError"
Cohesion: 0.14
Nodes (28): ValidationError, addCashMovement(), assertSameStore(), cancelExpense(), cashRelevantChanges(), COUNTED_EXPENSE_SQL, createExpense(), decideExpense() (+20 more)

### Community 40 - "services.ts"
Cohesion: 0.12
Nodes (29): jobCategoryLabel(), LEGACY_JOB_CATEGORY_LABELS, matchJobCategory(), assertOwnService(), cleanCode(), cleanPrice(), codeTaken(), createService() (+21 more)

### Community 41 - "build"
Cohesion: 0.06
Nodes (31): build, afterPack, appId, asar, directories, files, linux, mac (+23 more)

### Community 42 - "settings-schema.ts"
Cohesion: 0.12
Nodes (25): DocumentPhonesEditor(), phonesToRows(), rowsToPhones(), FormValues, initialValues(), STORE_KIND_LABELS, STORE_STATUS_LABELS, StoreFormModal() (+17 more)

### Community 43 - "assertStoreVisible"
Cohesion: 0.12
Nodes (24): DELETE(), GET(), Params, PUT(), POST(), GET(), Params, Params (+16 more)

### Community 44 - "design-system.tsx"
Cohesion: 0.09
Nodes (27): ClientDetailLoading(), TopProduct, ViewState, Available, Line, newLine(), NouveauTransfert(), NouveauTransfertPage() (+19 more)

### Community 45 - "index.mjs"
Cohesion: 0.14
Nodes (24): authenticate(), authorizedScope(), checkEnrollRate(), createEnrollCode(), createServer(), enroll(), enrollAttempts, generateCode() (+16 more)

### Community 46 - "suppliers.ts"
Cohesion: 0.15
Nodes (24): GET(), Params, DELETE(), GET(), Params, PUT(), GET(), assertSupplierVisible() (+16 more)

### Community 47 - "scroll-engine.ts"
Cohesion: 0.17
Nodes (26): ScrollRestoration(), applyScroll(), captureNow(), currentEntryKey(), currentUrl(), disposeScrollEngine(), EXCLUDED_PATHS, flushCapture() (+18 more)

### Community 48 - "backup.ts"
Cohesion: 0.12
Nodes (24): dbClient, getDbPath(), BackupError, BUSINESS_TABLES, DailyBackupResult, DEVICE_KEYS, ensureDailyBackup(), getBackupsDir() (+16 more)

### Community 49 - "caisse.ts"
Cohesion: 0.13
Nodes (25): cashMovements, cashSessions, CASH_REFERENCE_LABELS, CashCountByMethod, CashMovementRow, CashMovementType, CashReferenceType, CashSessionError (+17 more)

### Community 50 - "briqueterie/rapport-export.tsx"
Cohesion: 0.12
Nodes (25): BRICK_RAPPORT_DOCUMENT_ID, BrickCell, BrickDocumentSection, BrickProfitabilityIndicator, brickProfitabilityIndicators(), BrickRapportExportCompany, BrickRapportExportDocument(), BrickReports (+17 more)

### Community 51 - "brick-analytics.ts"
Cohesion: 0.12
Nodes (24): periodRange(), periodRange(), periodRange(), periodRange(), readApiError(), load(), BrickDashboard, BrickPeriod (+16 more)

### Community 52 - "index.ts"
Cohesion: 0.12
Nodes (21): acquireMigrationLock(), AppDatabase, backupsDir(), baseDb, currentExecutor(), dbDir, dbError(), dbLog() (+13 more)

### Community 53 - "ref_fs"
Cohesion: 0.11
Nodes (18): combineGraphs(), extractDotBlocks(), extractGraphBody(), main(), renderToSvg(), @libsql/client, default(), externalAliasPackages (+10 more)

### Community 54 - "6. Pages, une par une"
Cohesion: 0.08
Nodes (24): 6.10 `/clients`, `/fournisseurs` ⏳, 6.11 `/chantiers` ✅, 6.12 `/soldes`, `/rapports` ⏳, 6.13 `/recus` (paiements) ⏳, 6.15 Transferts entre magasins ✅, 6.16 Inventaires ✅, 6.17 `/synchronisation` ✅ (réécrite, à relire et tester), 6.18 `/parametres` ✅ (+16 more)

### Community 55 - "main.js"
Cohesion: 0.13
Nodes (21): { app, BrowserWindow, shell, dialog, ipcMain, session }, appToken, createWindow(), crypto, findFreePort(), { fork }, fs, getErrorMessage() (+13 more)

### Community 56 - "audit.ts"
Cohesion: 0.12
Nodes (16): DOCUMENTS, GET(), LABELS, Params, DOCUMENTS, GET(), LABELS, Params (+8 more)

### Community 57 - "workers.ts"
Cohesion: 0.15
Nodes (21): DELETE(), GET(), Params, PUT(), workers, DEFAULT_LIST_SORT, ListSort, deactivateWorker() (+13 more)

### Community 58 - "app-shell.tsx"
Cohesion: 0.17
Nodes (16): AppShell(), NavIcon(), PATHS, StoreSwitcher(), SyncIndicator(), SyncSummary, useTheme(), ThemeToggle() (+8 more)

### Community 59 - "triggers.ts"
Cohesion: 0.11
Nodes (20): LOCAL_TABLES, SYNCED_TABLE_NAMES, SYNCED_TABLES, SyncScope, Executor, installSyncTriggers(), quote(), TRIGGERS_VERSION (+12 more)

### Community 60 - "productions/[id]/route.ts"
Cohesion: 0.14
Nodes (18): DELETE(), detailFor(), GET(), Params, DELETE(), detailFor(), GET(), Params (+10 more)

### Community 61 - "quantity"
Cohesion: 0.15
Nodes (20): quantity(), 6.2 Correspondance schéma client → schéma cible, 6.3 Tables cibles métier (32), Atelier de meubles (§18), Briqueterie (§17), Caisse et dépenses, Partenaires, Prestations et main-d'œuvre (+12 more)

### Community 62 - "chrome-devtools-cli/SKILL.md"
Cohesion: 0.10
Nodes (18): Installation, Troubleshooting, AI Workflow, Command Usage, Debugging & Inspection, Emulation, Experimental Features, Extensions (+10 more)

### Community 63 - "Visual Companion Guide"
Cohesion: 0.10
Nodes (19): Browser Events Format, Cards (visual designs), Cleaning Up, CSS Classes Available, Design Tips, File Naming, How It Works, Mock elements (wireframe building blocks) (+11 more)

### Community 64 - "Creation Log: Systematic Debugging Skill"
Cohesion: 0.10
Nodes (19): Bulletproofing Elements, Creation Log: Systematic Debugging Skill, Enhancement 1: TDD Reference, Extraction Decisions, Final Outcome, Initial Version, Iterations, Key Insight (+11 more)

### Community 65 - "debug-optimize-lcp/SKILL.md"
Cohesion: 0.11
Nodes (17): 1. Identify LCP Element, 2. Audit Common Issues, LCP Debugging Snippets, 1. Eliminate Resource Load Delay (target: <10%), 2. Eliminate Element Render Delay (target: <10%), 3. Reduce Resource Load Duration (target: ~40%), 4. Reduce TTFB (target: ~40%), Debugging Workflow (+9 more)

### Community 66 - "Session diagnosis: <session-id>"
Cohesion: 0.11
Nodes (18): 1. Problem statement (REQUIRED), 2. Triage verdict (REQUIRED), 3. Environment (REQUIRED), 4. Sessions examined (REQUIRED), 5. Timeline (REQUIRED), 6.1 Skill timeline, 6.2 Plan adherence, 6.3 Repeated work (+10 more)

### Community 67 - "Security Scan Skill"
Cohesion: 0.11
Nodes (18): Auto-Fix, Basic Scan, Critical Findings (fix immediately), GitHub Action, High Findings (fix before production), Info Findings (awareness), Initialize Secure Config, Interpreting Results (+10 more)

### Community 68 - "copy-standalone.js"
Cohesion: 0.13
Nodes (16): copy(), copyRuntimePackage(), ensureExternalAliases(), ensureForcedRuntimePackages(), externalAliasPackages, externalAliasSubpaths, forcedRuntimePackages, fs (+8 more)

### Community 69 - "release.js"
Cohesion: 0.13
Nodes (18): allowedBumps, args, branch, commandName(), fail(), fs, nextVersion(), packageJson (+10 more)

### Community 70 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 71 - "Workflow Patterns"
Cohesion: 0.11
Nodes (16): 1. Find Orphaned Form Inputs, 2. Measure Tap Target Size, 3. Check Color Contrast, 4. Global Page Checks, Accessibility Debugging Snippets, 1. Automated Audit (Lighthouse), 2. Browser Issues & Audits, 3. Semantics & Structure (+8 more)

### Community 72 - "inventaires/[id]/page.tsx"
Cohesion: 0.18
Nodes (14): Draft, Filter, InventaireFichePage(), parse(), toDraft(), INVENTORY_STATUS, InventoryDetailRecord, InventoryRecord (+6 more)

### Community 73 - "Code Review Reception"
Cohesion: 0.12
Nodes (16): Acknowledging Correct Feedback, Code Review Reception, Common Mistakes, Forbidden Responses, From External Reviewers, From your human partner, GitHub Thread Replies, Gracefully Correcting Your Pushback (+8 more)

### Community 74 - "Testing CLAUDE.md Skills Documentation"
Cohesion: 0.12
Nodes (16): Documentation Variants to Test, Expected Results, Next Steps, NULL (Baseline - no skills doc), Scenario 1: Time Pressure + Confidence, Scenario 2: Sunk Cost + Works Already, Scenario 3: Authority + Speed Bias, Scenario 4: Familiarity + Efficiency (+8 more)

### Community 75 - "stock.ts"
Cohesion: 0.15
Nodes (14): AddStockMovementOptions, AssortmentError, recomputeStocks(), recomputeStoreStock(), round3(), setProductListed(), STOCK_MOVEMENT_LABELS, STOCK_REFERENCE_LABELS (+6 more)

### Community 76 - "schema-dbml.mjs"
Cohesion: 0.13
Nodes (15): blocks, colors, complet, defaultSetting(), enums, groupBlocks, grouped, GROUPS (+7 more)

### Community 77 - "verify-ui.js"
Cohesion: 0.18
Nodes (16): ERROR_MARKERS, evaluate(), fs, listeners, main(), os, path, pending (+8 more)

### Community 78 - "balances.ts"
Cohesion: 0.24
Nodes (14): GET(), PERIODS, BalancesByMonth, clientBalanceCte(), getBalancesSummary(), getClientBalances(), getMargins(), getSupplierBalances() (+6 more)

### Community 79 - "Common Memory Leaks"
Cohesion: 0.12
Nodes (14): 1. Uncleared Event Listeners, 2. Detached DOM Nodes, 3. Unintentional Global Variables, 4. Closures, 5. Unbounded Caches or Arrays, Common Memory Leaks, 1. Capturing Snapshots, 2. Comparing Snapshots (+6 more)

### Community 80 - "Root Cause Tracing"
Cohesion: 0.12
Nodes (15): 1. Observe the Symptom, 2. Find Immediate Cause, 3. Ask: What Called This?, 4. Keep Tracing Up, 5. Find Original Trigger, Adding Stack Traces, Finding Which Test Causes Pollution, Key Principle (+7 more)

### Community 81 - "Systematic Debugging"
Cohesion: 0.12
Nodes (15): Common Rationalizations, Overview, Phase 1: Root Cause Investigation, Phase 2: Pattern Analysis, Phase 3: Hypothesis and Testing, Phase 4: Implementation, Quick Reference, Red Flags - STOP and Follow Process (+7 more)

### Community 82 - "Persuasion Principles for Skill Design"
Cohesion: 0.12
Nodes (15): 1. Authority, 2. Commitment, 3. Scarcity, 4. Social Proof, 5. Unity, 6. Reciprocity, 7. Liking, Ethical Use (+7 more)

### Community 83 - "dependencies"
Cohesion: 0.12
Nodes (16): dependencies, chart.js, daisyui, drizzle-orm, electron-updater, framer-motion, html2canvas, jspdf (+8 more)

### Community 84 - "Finishing a Development Branch"
Cohesion: 0.13
Nodes (14): Common Rationalizations, Finishing a Development Branch, If your human partner asks to discard the work, Option 1: Merge Locally, Option 2: Push and Create PR, Option 3: Keep As-Is, Overview, Quick Reference (+6 more)

### Community 85 - "Condition-Based Waiting"
Cohesion: 0.15
Nodes (12): Common Mistakes, Condition-Based Waiting, Core Pattern, waitForEvent(), waitForEventCount(), waitForEventMatch(), Implementation, Overview (+4 more)

### Community 86 - "Using Git Worktrees"
Cohesion: 0.13
Nodes (14): 1a. Native Worktree Tools (preferred), 1b. Git Worktree Fallback, Common Rationalizations, Create the Worktree, Directory Selection, Overview, Quick Reference, Report (+6 more)

### Community 87 - "Writing Skills"
Cohesion: 0.13
Nodes (15): Code Examples, Common Rationalizations for Skipping Testing, Directory Structure, Discovery Workflow, Flowchart Usage, Match the Form to the Failure, Overview, Skill Creation Checklist (TDD Adapted) (+7 more)

### Community 88 - "Guide multi-magasins — procédure complète, page par page"
Cohesion: 0.13
Nodes (11): 10. Ordre de travail recommandé pour terminer, 1. Architecture retenue (option B), 2. État d'avancement, 5. Rôles et permissions, 7. Serveur central : installation sur VPS, 8. Mise en service d'un réseau de magasins, 9. Vérifications et tests, Guide multi-magasins — procédure complète, page par page (+3 more)

### Community 89 - "server/package.json"
Cohesion: 0.13
Nodes (14): pg, dependencies, pg, description, engines, node, main, name (+6 more)

### Community 90 - "Invariants à ne pas casser"
Cohesion: 0.18
Nodes (13): AGENTS.md — repères pour un agent qui travaille sur ce dépôt, Commandes, Conventions d'écriture, Invariants à ne pas casser, Le projet, Organisation, This is NOT the Next.js you know, Vérifier par exécution, pas par lecture (+5 more)

### Community 91 - "produits/[id]/route.ts"
Cohesion: 0.24
Nodes (11): GET(), POST(), PUT(), DELETE(), GET(), Params, PUT(), CentralDataError (+3 more)

### Community 92 - "Dispatching Parallel Agents"
Cohesion: 0.14
Nodes (13): 1. Identify Independent Domains, 2. Create Focused Agent Tasks, 3. Dispatch in Parallel, 4. Review and Integrate, Agent Prompt Structure, Common Mistakes, Dispatching Parallel Agents, Overview (+5 more)

### Community 93 - "devDependencies"
Cohesion: 0.14
Nodes (14): devDependencies, concurrently, drizzle-kit, electron, electron-builder, eslint, eslint-config-next, tailwindcss (+6 more)

### Community 94 - "23. Synchronisation avec PostgreSQL (option en ligne)"
Cohesion: 0.14
Nodes (14): 23.10 Écran `/synchronisation`, 23.11 Sécurité, 23.12 Ce que la synchronisation ne fait **pas**, 23.13 Tables, dépendances et scripts ajoutés, 23.1 Deux modes, deux niveaux d'ambition, 23.2 Architecture, 23.3 Colonnes de synchronisation — obligatoires, 23.4 Les références entre tables — le point difficile (+6 more)

### Community 95 - "verify-routes-e2e.js"
Cohesion: 0.20
Nodes (13): APP_DIR, check(), cookieHeader(), discover(), walk(), fs, jar, main() (+5 more)

### Community 96 - "Troubleshooting Wizard"
Cohesion: 0.15
Nodes (12): Error: `Could not find DevToolsActivePort`, Other Common Errors, Step 1: Find and Read Configuration, Step 2: Triage Common Connection Errors, Step 3: Read Known Issues, Step 4: Formulate a Configuration, Step 5: Run Diagnostic Commands, Step 6: Check GitHub for Existing Issues (+4 more)

### Community 97 - "Testing Skills With Subagents"
Cohesion: 0.15
Nodes (13): Common Mistakes (Same as TDD), GREEN Phase: Write Minimal Skill (Make It Pass), Meta-Testing (When GREEN Isn't Working), Overview, Quick Reference (TDD Cycle), Real-World Impact, RED Phase: Baseline Testing (Watch It Fail), TDD Mapping for Skill Testing (+5 more)

### Community 98 - "Conventions de développement — Planète Déco"
Cohesion: 0.15
Nodes (13): 10. Formatage, 11 bis. ⚠️ Séparation serveur / navigateur — la faute qui casse le build, 11. Synchronisation — 4 règles à respecter sans exception, 11 ter. Logo et icônes, 1. Le projet en une page, 2. Structure et propriété des fichiers, 4. Le patron de `lib/<module>.ts`, 6. Base de données — règles non négociables (+5 more)

### Community 99 - "Parcours de démonstration — chantiers, briqueterie, atelier"
Cohesion: 0.15
Nodes (13): 1. Générer les données, 2.1 La liste, 2.2 La fiche d'un chantier (`/chantiers/[id]`), 2. Parcours conseillé — Chantiers (`/chantiers`), 3.1 La liste, 3.2 La fiche d'un lot (`/briqueterie/[id]`), 3. Parcours conseillé — Briqueterie (`/briqueterie`), 4. Parcours conseillé — Atelier (`/atelier`) (+5 more)

### Community 100 - "device.ts"
Cohesion: 0.21
Nodes (10): register(), DeviceConfig, DeviceMode, invalidateDeviceConfig(), KEYS, setDeviceConfig(), startScheduler(), tick() (+2 more)

### Community 101 - "verify-export-image.js"
Cohesion: 0.18
Nodes (10): fs, main(), os, OUT, path, pending, PORT, send() (+2 more)

### Community 102 - "verify-sales-draft-e2e.js"
Cohesion: 0.28
Nodes (12): api(), check(), cookieHeader(), currentStock(), fs, jar, main(), openDatabase() (+4 more)

### Community 103 - "CloseCashSessionModal"
Cohesion: 0.29
Nodes (11): loadMovements(), loadSessions(), handleSubmit(), validate(), CloseCashSessionModal(), handleSubmit(), OpenCashSessionModal(), handleSubmit() (+3 more)

### Community 104 - "theme-provider.tsx"
Cohesion: 0.21
Nodes (9): metadata, RootLayout(), viewport, defaultSettings, AuthProvider(), ThemeContext, ThemeContextType, ThemeProvider() (+1 more)

### Community 105 - "parametres/page.tsx"
Cohesion: 0.24
Nodes (10): FormState, ParametresPage(), SettingsContext, SettingsContextType, StorageInfo, TagListEditor(), toForm(), ColorField() (+2 more)

### Community 106 - "Defense-in-Depth Validation"
Cohesion: 0.17
Nodes (11): Applying the Pattern, Defense-in-Depth Validation, Example from Session, Key Insight, Layer 1: Entry Point Validation, Layer 2: Business Logic Validation, Layer 3: Environment Guards, Layer 4: Debug Instrumentation (+3 more)

### Community 107 - "Writing Plans"
Cohesion: 0.17
Nodes (11): Execution Handoff, File Structure, Overview, Plan Document Header, Scope Check, Self-Review, Step Granularity, Task Right-Sizing (+3 more)

### Community 108 - "[Analysis Title]"
Cohesion: 0.17
Nodes (12): Advanced: Skills with executable code, [Analysis Title], Anti-patterns to avoid, Avoid offering too many options, Avoid Windows-style paths, Conditional workflow pattern, Examples pattern, Executive summary (+4 more)

### Community 109 - "Workflow Patterns"
Cohesion: 0.18
Nodes (10): 1. Diagnosing Authentication Failures & Redirects (401 / 403), 2. Cookie Banner & Consent Conformance Testing, 3. Auditing Cookie Security, SameSite & CHIPS (Partitioned Cookies), 4. Client-Side Cookie Inspection & Manipulation, Client-Side Capabilities & Limitations, Core Concepts, HttpOnly vs Client-Side Storage, Session Strategy: Live Tab vs Isolated Context (+2 more)

### Community 110 - "Brainstorming Ideas Into Designs"
Cohesion: 0.18
Nodes (10): After the Design (architectural path), Anti-Pattern: "Too Simple To Need Approval", Brainstorming Ideas Into Designs, Checklist, Establish Shared Understanding, Process Flow, Red Flags, The Process (+2 more)

### Community 111 - "Returns: "OK" or lists conflicts"
Cohesion: 0.18
Nodes (11): Avoid assuming tools are installed, Create verifiable intermediate outputs, MCP tool references, Next steps, Package dependencies, Returns: "OK" or lists conflicts, Runtime environment, Technical notes (+3 more)

### Community 112 - "7. Modules fonctionnels"
Cohesion: 0.18
Nodes (11): 7.11 Rapports (§11), 7.12 Utilisateurs (§12) · 7.13 Paramètres (§13) · 7.14 Sauvegarde et sécurité (§14), 7.15 Livraison et évolutions (§15), 7.16 Prestations, briqueterie, atelier, 7.2 Clients (§2), 7.3 Fournisseurs (§3), 7.5 Achats (§5), 7.6 Ventes (§6) (+3 more)

### Community 113 - "generate-icons.js"
Cohesion: 0.24
Nodes (10): sharp, buildIco(), findSource(), fs, ICO_SIZES, main(), path, root (+2 more)

### Community 114 - "verify-chantiers-e2e.js"
Cohesion: 0.29
Nodes (10): ADMIN, check(), daysAgo(), err(), KAL, login(), main(), MAT (+2 more)

### Community 115 - "Verification Before Completion"
Cohesion: 0.20
Nodes (9): Common Failures, Key Patterns, Overview, Rationalization Prevention, Red Flags - STOP, The Gate Function, The Iron Law, Verification Before Completion (+1 more)

### Community 116 - "Skill structure"
Cohesion: 0.20
Nodes (10): Avoid deeply nested references, Naming conventions, Pattern 1: High-level guide with references, Pattern 2: Domain-specific organization, Pattern 3: Conditional details, Progressive disclosure patterns, Skill structure, Structure longer reference files with table of contents (+2 more)

### Community 117 - "applyThemeColors"
Cohesion: 0.49
Nodes (9): applyThemeColors(), getContrastColor(), getContrastOklch(), hexToOklch(), hexToRgb(), lightenHex(), rgbToOklch(), shiftHue() (+1 more)

### Community 118 - "verify-briqueterie-e2e.js"
Cohesion: 0.38
Nodes (9): ADMIN, check(), err(), login(), main(), near(), put(), session() (+1 more)

### Community 119 - "clients/[id]/route.ts"
Cohesion: 0.39
Nodes (8): DELETE(), GET(), Params, PUT(), assertCustomerVisible(), deactivateCustomer(), reactivateCustomer(), updateCustomer()

### Community 120 - "Workflow Patterns"
Cohesion: 0.22
Nodes (8): Before interacting with a page, Core Concepts, Efficient data retrieval, Parallel execution, Testing an extension, Tool selection, Troubleshooting, Workflow Patterns

### Community 121 - "helper.js"
Cohesion: 0.42
Nodes (7): connect(), nextReconnectDelay(), reloadAfterRecovery(), sessionKey(), setStatus(), showTombstone(), websocketUrl()

### Community 122 - "codex-tools.md"
Cohesion: 0.22
Nodes (5): Codex App Finishing, Environment Detection, Model routing on spawns, Subagent dispatch requires multi-agent support, Waiting on children

### Community 123 - "Skill authoring best practices"
Cohesion: 0.22
Nodes (9): Avoid time-sensitive information, Common patterns, Content guidelines, Implement feedback loops, Skill authoring best practices, Template pattern, Use consistent terminology, Use workflows for complex tasks (+1 more)

### Community 124 - "GitHub"
Cohesion: 0.22
Nodes (8): API, Async merges, Auth, CI/runs, GitHub, Issues, Landing ownership, PRs

### Community 125 - "verify-atelier-e2e.js"
Cohesion: 0.42
Nodes (8): ADMIN, check(), err(), login(), main(), near(), session(), stockOf()

### Community 126 - "issue.md"
Cohesion: 0.25
Nodes (7): Actual behavior, Debug log or conversation transcript, Environment (required), Expected behavior, Is this a Superpowers issue or a platform issue?, Steps to reproduce, What happened?

### Community 127 - "update-status.tsx"
Cohesion: 0.39
Nodes (7): AppVersionDisplay(), formatVersion(), getPayloadVersion(), getProgress(), statusBadgeClass, UpdateState, UpdateStatus()

### Community 128 - "✅ Fait"
Cohesion: 0.32
Nodes (8): ✅ Fait, getCustomer(), getCustomerStats(), listCustomers(), mapCustomerRow(), searchCustomers(), storeFilter(), getEffectiveSalePrice()

### Community 129 - "Frontend Design"
Cohesion: 0.29
Nodes (6): Design principles, Frontend Design, Ground your designs in the subject matter, More on writing in design, Process: plan, review against the brief, build, critique, Restraint and self-critique

### Community 130 - "stop-server.sh"
Cohesion: 0.52
Nodes (6): command_has_server_id(), command_line_for_pid(), is_brainstorm_server(), mark_stopped(), read_expected_server_id(), stop-server.sh script

### Community 131 - "Diagnosing Superpowers"
Cohesion: 0.29
Nodes (6): Diagnosing Superpowers, Hard rules, Overview, Quick reference, Red Flags, Workflow

### Community 132 - "Superpowers session diagnosis bundle"
Cohesion: 0.29
Nodes (6): Files, How to read it, Producer instructions, Redaction, Superpowers session diagnosis bundle, What this is

### Community 133 - "Case: <session-id>"
Cohesion: 0.29
Nodes (6): Case: <session-id>, Context-safety rules for every reader of these files, Discovered sources and record meanings, Environment, Problem statement (agreed with your human partner), Sessions

### Community 134 - "Gemini CLI Tool Mapping"
Cohesion: 0.29
Nodes (7): Additional Gemini CLI tools, Gemini CLI Tool Mapping, Instructions file, Parallel dispatch, Personal skills directory, Prompt filling, Subagent support

### Community 135 - "Hermes Agent Tool Mapping"
Cohesion: 0.29
Nodes (6): Hermes Agent Tool Mapping, Instructions file, Invoking a skill, Subagent dispatch, Task tracking, Tools

### Community 136 - "REFACTOR Phase: Close Loopholes (Stay Green)"
Cohesion: 0.29
Nodes (7): 1. Explicit Negation in Rules, 2. Entry in Rationalization Table, 3. Red Flag Entry, 4. Update description, Plugging Each Hole, Re-verify After Refactoring, REFACTOR Phase: Close Loopholes (Stay Green)

### Community 137 - "allowScripts"
Cohesion: 0.29
Nodes (7): allowScripts, core-js@3.50.0, electron-winstaller@5.4.0, esbuild@0.18.20, esbuild@0.25.12, esbuild@0.28.2, unrs-resolver@1.12.2

### Community 138 - "5. Architecture et structure du projet"
Cohesion: 0.29
Nodes (7): 5.1 Architecture d'exécution, 5.2 Structure des dossiers, 5.3 Design system — une identité d'entreprise, cohérente sur toutes les pages, 5.4 Le sidebar et la navigation, 5.5 Responsive — la règle des 5 largeurs, 5. Architecture et structure du projet, Jetons de design (source unique de vérité)

### Community 140 - "ref_node_fs"
Cohesion: 0.29
Nodes (3): root, scopes, target

### Community 141 - "verify-purchases-e2e.js"
Cohesion: 0.48
Nodes (6): api(), check(), cookieHeader(), jar, main(), today

### Community 142 - "LCP Optimization Strategies"
Cohesion: 0.33
Nodes (5): 1. Eliminate Resource Load Delay, 2. Eliminate Element Render Delay, 3. Reduce Resource Load Duration, 4. Reduce Time to First Byte (TTFB), LCP Optimization Strategies

### Community 143 - "Frontend Design Plugin"
Cohesion: 0.33
Nodes (5): Authors, Frontend Design Plugin, Learn More, Usage, What It Does

### Community 144 - "Muse Tool Mapping"
Cohesion: 0.33
Nodes (5): Instructions file, Muse Tool Mapping, Skill invocation, Subagent dispatch, Task tracking

### Community 145 - "using-superpowers/SKILL.md"
Cohesion: 0.33
Nodes (5): Platform Adaptation, Red Flags, Skill Priority, The Rule, User Instructions

### Community 146 - "Skill Discovery Optimization (SDO)"
Cohesion: 0.33
Nodes (6): 1. Rich Description Field, 2. Keyword Coverage, 3. Descriptive Naming, 4. Token Efficiency (Critical), 5. Cross-Referencing Other Skills, Skill Discovery Optimization (SDO)

### Community 147 - "Bulletproofing Skills Against Rationalization"
Cohesion: 0.33
Nodes (6): Address "Spirit vs Letter" Arguments, Build Rationalization Table, Bulletproofing Skills Against Rationalization, Close Every Loophole Explicitly, Create Red Flags List, Update SDO for Violation Symptoms

### Community 148 - "probe-export-ui.js"
Cohesion: 0.60
Nodes (5): evaluate(), main(), pending, send(), sleep()

### Community 149 - "verify-export-e2e.js"
Cohesion: 0.60
Nodes (5): evaluate(), main(), pending, send(), sleep()

### Community 150 - "Elements and Size for LCP"
Cohesion: 0.40
Nodes (4): Elements and Size for LCP, Heuristics to Exclude Non-Contentful Elements, How is an Element's Size Determined?, What Elements are Considered?

### Community 151 - "Context7"
Cohesion: 0.40
Nodes (4): API Key (optional), Available Tools, Context7, Usage

### Community 152 - "Pressure Test 1: Emergency Production Fix"
Cohesion: 0.40
Nodes (4): Choose A, B, or C, Pressure Test 1: Emergency Production Fix, Scenario, Your Options

### Community 153 - "Pressure Test 2: Sunk Cost + Exhaustion"
Cohesion: 0.40
Nodes (4): Choose A, B, or C, Pressure Test 2: Sunk Cost + Exhaustion, Scenario, Your Options

### Community 154 - "Pressure Test 3: Authority + Social Pressure"
Cohesion: 0.40
Nodes (4): Choose A, B, or C, Pressure Test 3: Authority + Social Pressure, Scenario, Your Options

### Community 155 - "anthropic-best-practices.md"
Cohesion: 0.40
Nodes (4): [Analysis Title], Executive summary, Key findings, Recommendations

### Community 156 - "Anti-Patterns"
Cohesion: 0.40
Nodes (5): Anti-Patterns, ❌ Code in Flowcharts, ❌ Generic Labels, ❌ Multi-Language Dilution, ❌ Narrative Example

### Community 157 - "Testing All Skill Types"
Cohesion: 0.40
Nodes (5): Discipline-Enforcing Skills (rules/requirements), Pattern Skills (mental models), Reference Skills (documentation/APIs), Technique Skills (how-to guides), Testing All Skill Types

### Community 158 - "RED-GREEN-REFACTOR for Skills"
Cohesion: 0.40
Nodes (5): GREEN: Write Minimal Skill, Micro-Test Wording Before Full Scenarios, RED-GREEN-REFACTOR for Skills, RED: Write Failing Test (Baseline), REFACTOR: Close Loopholes

### Community 159 - "VERIFY GREEN: Pressure Testing"
Cohesion: 0.40
Nodes (5): Key Elements of Good Scenarios, Pressure Types, Testing Setup, VERIFY GREEN: Pressure Testing, Writing Pressure Scenarios

### Community 160 - "proxy.ts"
Cohesion: 0.40
Nodes (3): config, publicPrefixes, publicRoutes

### Community 161 - "electron-api.d.ts"
Cohesion: 0.40
Nodes (4): ElectronAPI, ElectronUpdatePayload, ElectronUpdateUnsubscribe, Window

### Community 162 - "Largest Contentful Paint (LCP) Breakdown"
Cohesion: 0.50
Nodes (3): Largest Contentful Paint (LCP) Breakdown, The Four Subparts of LCP, Why the Breakdown Matters

### Community 163 - "GitHub issues"
Cohesion: 0.50
Nodes (3): File, GitHub issues, Search

### Community 164 - "Pi Tool Mapping"
Cohesion: 0.50
Nodes (3): Pi Tool Mapping, Subagents, Task lists

### Community 165 - "Evaluation and iteration"
Cohesion: 0.50
Nodes (4): Build evaluations first, Develop Skills iteratively with the agent, Evaluation and iteration, Observe how agents navigate Skills

### Community 166 - "Checklist for effective Skills"
Cohesion: 0.50
Nodes (4): Checklist for effective Skills, Code and scripts, Core quality, Testing

### Community 167 - "Core principles"
Cohesion: 0.50
Nodes (4): Concise is key, Core principles, Set appropriate degrees of freedom, Test with all models you plan to use

### Community 168 - "File Organization"
Cohesion: 0.50
Nodes (4): File Organization, Self-Contained Skill, Skill with Heavy Reference, Skill with Reusable Tool

### Community 169 - "Skill Types"
Cohesion: 0.50
Nodes (4): Pattern, Reference, Skill Types, Technique

### Community 170 - "Example: TDD Skill Bulletproofing"
Cohesion: 0.50
Nodes (4): Example: TDD Skill Bulletproofing, Initial Test (Failed), Iteration 1 - Add Counter, Iteration 2 - Add Foundational Principle

### Community 171 - "6.1 `/login` — Connexion, première installation, choix du magasin ✅"
Cohesion: 0.50
Nodes (4): 6.1 `/login` — Connexion, première installation, choix du magasin ✅, A. Première installation (`needsSetup = true`), B. Connexion, C. Choix du magasin (comptes multi-magasins)

### Community 172 - "28. Multi-magasins (v2)"
Cohesion: 0.50
Nodes (4): 28.1 Architecture retenue (option B), 28.3 État d'avancement, 28.4 Outils de recette, 28. Multi-magasins (v2)

## Knowledge Gaps
- **1737 isolated node(s):** `context7`, `crypto`, `http`, `fs`, `path` (+1732 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1881 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **34 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `next` connect `api.ts` to `formatNumber`, `chantiers-modals.tsx`, `formatDateShort`, `MoneyText`, `ok`, `useAuth`, `briqueterie-modals.tsx`, `stores.ts`, `fail`, `permissions.ts`, `commandes-modals.tsx`, `ventes/nouvelle/page.tsx`, `users.ts`, `atelier-modals.tsx`, `users/route.ts`, `stock/page.tsx`, `sync-engine.ts`, `transfers.ts`, `requireAction`, `proxy.ts`, `package.json`, `assertStoreVisible`, `design-system.tsx`, `suppliers.ts`, `scroll-engine.ts`, `audit.ts`, `workers.ts`, `app-shell.tsx`, `productions/[id]/route.ts`, `inventaires/[id]/page.tsx`, `balances.ts`, `produits/[id]/route.ts`, `theme-provider.tsx`, `parametres/page.tsx`, `clients/[id]/route.ts`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `requireAction()` (e.g. with `9.1 Permissions par utilisateur (surcharges)` and `9. Permissions`) actually correct?**
  _`requireAction()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `context7`, `crypto`, `http` to the rest of the system?**
  _1737 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `formatNumber` be split into smaller, more focused modules?**
  _Cohesion score 0.04761418902833044 - nodes in this community are weakly interconnected._
- **Why does `Planète Déco Sarlu — Filiale Meubles` connect `Planète Déco Sarlu — Filiale Meubles` to `formatNumber`, `withTransaction`, `5. Architecture et structure du projet`, `28. Multi-magasins (v2)`, `7. Modules fonctionnels`, `23. Synchronisation avec PostgreSQL (option en ligne)`, `main.js`, `Guide multi-magasins — procédure complète, page par page`, `scopeSql`, `Invariants à ne pas casser`, `triggers.ts`, `users/route.ts`?**
  _High betweenness centrality (0.043) - this node is a cross-community bridge._
- **Should `chantiers-modals.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.028799702712746192 - nodes in this community are weakly interconnected._
- **Why does `drizzle-orm` connect `today` to `schema.ts`, `withTransaction`, `NotFoundError`, `furniture.ts`, `stores.ts`, `brick-orders.ts`, `brick.ts`, `users.ts`, `users/route.ts`, `purchases.ts`, `sales.ts`, `products.ts`, `transfers.ts`, `package.json`, `ValidationError`, `services.ts`, `suppliers.ts`, `backup.ts`, `caisse.ts`, `index.ts`, `ref_fs`, `audit.ts`, `workers.ts`, `stock.ts`, `schema-dbml.mjs`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._