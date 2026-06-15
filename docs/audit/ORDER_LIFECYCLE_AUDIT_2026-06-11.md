# Order Lifecycle & COD Money/Custody Chain — End-to-End Audit

> **Sana:** 2026-06-11 · **Usul:** 6 mutaxassis agent (yaratish-senariylari, oldinga-oqim+custody, sotuv+pul, bekor/qaytarish, settlement-zanjiri, frontend-per-role) + adversarial verify. 24 agent.
> **Maqsad:** buyurtma yaralishidan (barcha senariylar) → yetkazish → pul yig'ilishi → courier→branch→HQ→market settlement → marketga to'lov; va bekor/qaytarish teskari yo'li — uchidan-uchiga to'g'rimi va nazoratdami?

## Yakuniy verdict — **62/100**

> PARTIALLY CORRECT — NOT fully controlled end-to-end. The order lifecycle, custody model, and money-creation legs are well-engineered and largely correct on the FORWARD/SELL path: every creation channel that actually runs sets a valid non-null holder and writes a custody event, the 3-leg COD posting + SELL_PROFIT conserve money exactly, and sell/cancel/rollback are atomic and idempotent. But the system is NOT complete or fully reconciled. There are THREE classes of real holes: (1) MONEY RECONCILIATION is split-brain — the per-order FIFO order_settlement ledger that the rollback-safety guard depends on is NEVER advanced by the production payments path (finance.cashbox.payment_*), so order_settlement rows stay PENDING forever, the rollback guard (isSettledToHq) never trips, and a rollback after cash has physically moved up the chain drives the courier cashbox negative with cash unaccounted. There is no end-to-end conservation invariant and three independent "what is owed" computations (order_settlement, finance cashbox legs, gateway buildManagerSettlement) that are never cross-checked. (2) CUSTODY has timeline holes: the full transfer-batch receive leaves a stale holder_branch_id (mis-scopes bulk courier-assign), and the entire return-to-market reverse path never moves custody to the market (no MARKET holder type, no closing custody event) so the parcel's return is never closed in the ledger. (3) FRONTEND is incomplete for core roles: managers cannot settle branch→HQ from the UI, proof-required markets cannot be sold/cancelled (no upload control), and the could-not-deliver / initiate-return / mark-returned-to-market transitions and the per-order settlement chain are only reachable via orphan/coverage screens. The money chain is mostly correct WHERE wired, but the integration seams between subsystems are where money can sit untracked, go negative on rollback, or double-count.

## Yaratish senariylari (har biri bo'yicha)

| Senariy | Verdict | Asosiy masala |
|---|---|---|
| MARKET self-create | **CORRECT** | None. resolvedMarketId forced to caller's own market; branch→HQ fallback; holder=HQ + custody event + tracking. Wired at /orders/add. Solid end-to-end. |
| BRANCH/FILIAL self-create | **CORRECT** | None. Gateway forces source='branch' + branch_id=assignedBranch, blocks cross-branch; holder=BRANCH + custody event. Frontend resolves server-side. Cross-branch abuse blocked. |
| POST/POCHTA registrator receive (NEW→RECEIVED) | **CORRECT (minor P3)** | Transitions NEW→RECEIVED + assigns region post_id in one TX; correctly does NOT fake a courier holder. Only gap: no custody event for the staging hop (P3 observability) — nothing lost. |
| TELEGRAM BOT create (market_operator) | **BROKEN (P1)** | market_id never resolved for MARKET_OPERATOR (bot DTO has no market_id; create() resolves it only for MARKET role; the 'required' guard skips operators). INSERT hits bigint NOT-NULL → fails, and the just-created customer is orphaned. Operators have no other create route. Confirmed end-to-end. |
| EXTERNAL provider — manual create | **CORRECT (backend)** | order.external.create → create() with source=EXTERNAL, holder=HQ, custody event. Backend sound and role-gated. |
| EXTERNAL provider — feed auto-receive | **NOT WIRED (P2)** | receiveExternalOrders() is logically correct (dedupe, HQ custody) but integration-service never calls order.receive_external and there is no operator UI — provider feeds never actually ingest; external COD orders silently never appear. |

## Pul va custody zanjiri — nazoratdami?

Money and custody are MOSTLY tracked on the forward sell path but have concrete holes at the integration seams. WHERE MONEY CAN GO WRONG: (1) SPLIT-BRAIN SETTLEMENT (P1, most serious): production cash handoffs use finance.cashbox.payment_courier/branch_to_main/market which move cashbox balances but NEVER advance order_settlement. So the per-order FIFO ledger stays PENDING forever in production. Because the rollback guard (isSettledToHq) keys on BRANCH_SETTLED/MARKET_SETTLED — statuses the production path never sets — a rollback of a SOLD/PAID order is PERMITTED even after the courier already handed cash to the branch and the branch remitted to HQ. The reversal then debits the FOR_COURIER cashbox (which ALLOWS negative balance) by the sale amount, driving it negative, while the cash physically sitting at HQ becomes unaccounted. (2) DOUBLE-DEBIT RISK: running BOTH the production payments page AND the orphan /settlement page for the same physical handover double-debits a cashbox (same source_type, different source_id → finance idempotency does not collide). Latent because /settlement is unlinked, but reachable by URL. (3) NO CONSERVATION INVARIANT: check-cashbox-invariant.ts only checks each cashbox's own ledger (near-tautological); nothing verifies sum(unsettled order_settlement amounts)=cashbox balances or that the three "owed" computations agree. (4) PARTNER-BRANCH KEPT SHARE: branchShare cash physically held by a partner branch has no cashbox/ledger record (exists only implicitly in SELL_PROFIT math) — cannot be audited as held funds. (5) NON-IDEMPOTENT RESUBMIT: a deliberate double-click on settlement gets a fresh UUID and over-allocates to the next-oldest orders with no owed-amount clamp (negative-allowed cashbox accepts it). (6) BRANCH EXPENSE LEG LOSS (P2): on sub-share partial sales a negative branchNet EXPENSE leg fails (BRANCH forbids negative), retries 10x, then is silently dropped from the outbox — HQ's view of what the branch owes is understated. WHERE CUSTODY CAN GO WRONG: physical custody has a valid non-null holder at creation in every channel, and forward batch receive (partial), scan-assign, and modern dispatch-assign all move the holder correctly with events. BUT: (a) FULL transfer-batch receive leaves holder_branch_id stale at the source while branch_id=destination — this mis-scopes the bulk courier-assign gate (blocks the legitimate destination manager) and is the path the whole-batch QR screen drives; (b) sendPost (PATCH /post/:id) puts orders ON_THE_ROAD without setting courier_id, so the holder stays BRANCH/HQ while the parcel is with the courier — a real landmine, but dormant (no live frontend caller); (c) the ENTIRE return-to-market reverse path never moves custody to the market: there is no MARKET holder type, and cancel/cancel-post-receive/CLOSED and markReturnedToMarket write no custody event — a cancelled/returned parcel ends life with a stale COURIER/BRANCH holder and there is NO custody record that the market received its goods. So an actor CAN reconcile what they hold vs owe on the forward sell path via their cashbox balance, but CANNOT reconcile the reverse (return) flow, and the per-order settlement reconciliation is effectively dead in production.

## Tasdiqlangan muammolar

### I1. [P1 · money] Split-brain settlement: production cash path never advances order_settlement, so rollback guard never trips and rollback after cash-reached-HQ drives courier cashbox negative
**Qayerda:** finance-service.service.ts:1624/1903/2054 (paymentsFromCourier/BranchToMain/ToMarket move cashbox only, zero order_settlement refs — verified grep returns nothing); order-service.service.ts:2023-2030 (isSettledToHq guard keys on BRANCH_SETTLED/MARKET_SETTLED) + 2281-2333 (reversal debits FOR_COURIER which allows negative at finance:499-501)

**Ta'sir:** After a courier→branch→HQ cash remittance done via the production payments UI, order_settlement is still PENDING, the rollback guard permits a rollback, the reversal posts an EXPENSE that drives the (negative-allowed) courier cashbox below zero, and the cash already at HQ becomes unaccounted. Money can be reversed on a wrong financial basis.

### I2. [P1 · money] Two parallel, unreconciled money-movement systems both debit the same cashboxes; only the cashbox path is wired in production
**Qayerda:** order-service settleCourierToBranch/BranchToHq/HqToMarket (FIFO, advances order_settlement) vs finance.cashbox.payment_* (lump-sum, no order_settlement); production UI cashDetail.tsx:124,222-224 uses only the finance path; same source_type so double-run double-debits

**Ta'sir:** order_settlement FIFO ledger is dead in production (rows PENDING forever); running both the payments page and the orphan /settlement page for one physical handover double-debits a cashbox. Split-brain accounting with no detector.

### I3. [P1 · money] No end-to-end money-conservation / cross-system reconciliation invariant
**Qayerda:** scripts/check-cashbox-invariant.ts:89-120 only checks per-cashbox balance==SUM(history) and balance==cash+card; no check of sum(order_settlement unsettled)=cashbox balances, no FIFO-vs-finance agreement

**Ta'sir:** A som can move via the finance path with the settlement row left PENDING and nothing flags the divergence; settlement-aware rollback and audit operate on permanently-stale data.

### I4. [P1 · money] buildManagerSettlement is a THIRD, gateway-side reimplementation of obligations using courier_tariff (not snapshotted courier_share)
**Qayerda:** api-gateway/finance-gateway.controller.ts:413-705,591-662

**Ta'sir:** Display-only olinishi_kerak/berilishi_kerak shown to operators can disagree with the authoritative cashbox/settlement values; for SALARY_ONLY couriers the owed amount is understated and for PARTNER branches it ignores branch_share. Not a stored-money corruption, but operators reconcile against wrong numbers.

### I5. [P1 · frontend] Branch→HQ settle has NO manager UI: cashDetail renders null for type 'branch' and finance branch-to-main is ADMIN-only; FIFO branch_to_hq only on orphan /settlement page
**Qayerda:** Elchi-Frontend/src/pages/payments/components/cashDetail.tsx:482 (type==='branch' ? null); finance-gateway.controller.ts:1228-1230 (branch-to-main @Roles SUPERADMIN/ADMIN); order.settlement.branch_to_hq is MANAGER but only reachable from /settlement (unlinked)

**Ta'sir:** A regional/hybrid manager can SEE what they owe HQ but has no navigable, role-appropriate action to record paying it. Core money workflow for a core role is unreachable.

### I6. [P1 · both] Telegram-bot create is broken: market_operator's market_id never resolved → NOT-NULL violation + orphaned customer
**Qayerda:** order-gateway.controller.ts:470-480 (market_id resolved only for MARKET; guard skips MARKET_OPERATOR) + 541-568 (botOrderCreate); order-service.service.ts:2767 (market_id:dto.market_id) vs order.entity bigint NOT NULL

**Ta'sir:** Market operators cannot create orders via the only creation route they have; each attempt leaves an orphan customer row. A documented creation channel is non-functional.

### I7. [P1 · frontend] Proof-required markets cannot be sold or cancelled via the UI (no proof-file upload control anywhere)
**Qayerda:** order-service enforceOperationProof:1357-1417 (SELL_*/CANCEL_* reject when no key); Elchi-Frontend SellModal.tsx + CancelModal.tsx have no file input (grep confirms none in src/pages/orders, src/pages/new_orders)

**Ta'sir:** For any market with a SELL_*/CANCEL_* proof condition enabled, every courier sell/cancel hits 'isbot majburiy' with no way to comply → order can be delivered but never marked sold, leaving COD cash + custody stuck in an unsettleable state.

### I8. [P1 · frontend] Return-to-market reverse path has no real UI: could-not-deliver / initiate-return / mark-returned-to-market only in coverage hooks; return-batch creation not wired; /settlement orphan
**Qayerda:** Elchi-Frontend entities/orders/ordersCoverage.ts:63-82 (only references); pages/returns/index.tsx read-only; branchCoverage.ts:36-38 returnBatches unused; settlement/index.tsx orphan+unguarded

**Ta'sir:** Couriers cannot record could-not-deliver; HQ cannot initiate a return; the branch cannot mark a parcel returned-to-market (the closing step). The exception/return-to-market lifecycle is backend-only — parcels get stuck in WAITING/WAITING_CUSTOMER with no UI exit (the legacy CANCEL→cancel-post path is the only operational reverse flow).

### I9. [P1 · custody] Full transfer-batch receive leaves stale holder_branch_id (custody model wrong) and writes no custody event; mis-scopes bulk courier-assign
**Qayerda:** order-service.service.ts:7959-8030 (receiveBranchTransferBatch sets branch_id only, never holder_*/custody event) vs correct sibling 8179-8239; downstream resolveOrderBranchScope=holder_branch_id??branch_id at logistics:2079-2080; live screen new_orders/branches/batches.tsx uses the buggy method

**Ta'sir:** After a whole-batch receive, holder_branch_id points at the source while the parcel is at destination; the bulk courier-assign gate then forbids the legitimate destination-branch manager (or trips a mixed-branch error). Custody timeline also missing the receive hop. Per-order receive screen is correct, so correctness depends on which screen staff use.

### I10. [P2 · custody] Return-to-market never moves custody to the market: no MARKET holder type, no closing custody event on cancel / cancel-post-receive(CLOSED) / markReturnedToMarket
**Qayerda:** order.entity OrderHolderType has no MARKET (23-27); cancelOrder:4248-4258, createCanceledPost logistics:2296-2310, receiveCanceledPost:2361-2371, markReturnedToMarket:2628-2649 all write status without holder_* or custody event

**Ta'sir:** A cancelled/returned parcel ends with a stale COURIER/BRANCH holder and there is NO auditable record the market took back its goods; disputes can't be resolved from custody history and branch stock still counts the parcel as on-hand.

### I11. [P2 · money] Return-batch creation has no order-status eligibility filter + markReturnedToMarket bypasses the state machine (raw save) → a SOLD order's settlement/COD can be left dangling
**Qayerda:** branch-service:1113-1153 + order-service createBranchReturnBatches:6790-6810 (only current_batch_id IS NULL) ; markReturnedToMarket:2631-2633 raw save, no isValidStatusTransition; receive overwrites SOLD→RECEIVED without touching settlement

**Ta'sir:** A privileged actor can route an already-SOLD order into a RETURN batch; receive silently resets status without reversing the sale's settlement/cashbox legs, so the order can reach RETURNED_TO_MARKET while collected COD stays owed up the chain. Privileged/off-happy-path (no UI selects SOLD into return batches), hence P2, but a real reconciliation gap.

### I12. [P2 · custody] sendPost (PATCH /post/:id) dispatches to a courier without setting courier_id → holder stays BRANCH/HQ while parcel is on the road (no COURIER custody event)
**Qayerda:** logistics-service.service.ts:1299-1302,1346-1350 (updateOrder passes only post_id+status); holder recalc gated on branch_id/courier_id at order-service:5296-5298

**Ta'sir:** Reachable SUPERADMIN/ADMIN/REGISTRATOR endpoint that creates a systematic wrong-holder/custody hole. DORMANT: no live frontend caller (useSendPost defined but invoked nowhere; the modern dispatch UI uses the correct assign-to-courier path). A landmine, not an active loss.

### I13. [P2 · money] Branch EXPENSE leg can be silently dropped (outbox poison) on sub-share partial sales because BRANCH cashboxes forbid negative balance
**Qayerda:** finance updateBalancesByMethod:499-507 (BRANCH not negative-allowed); order-service:3985-3996/4818-4829 (branch EXPENSE leg when branchNet<0); outbox maxAttempts=10 → status='failed'

**Ta'sir:** When total < courierShare+branchShare the branch leg throws, retries 10x, then is silently dropped; HQ's view of what the branch owes is understated with no alert. Edge case but a real money discrepancy.

### I14. [P2 · custody] Partner-branch kept share (branchShare) has no cashbox/ledger record
**Qayerda:** order-service.service.ts:3861-3866,1154-1160,1820-1847

**Ta'sir:** Real cash a partner branch keeps exists only implicitly in SELL_PROFIT math; it is never mirrored to a balance, so it cannot be reconciled or audited as held funds.

### I15. [P2 · money] PICKUP-branch manager has no UI showing branch balance or what is owed to HQ
**Qayerda:** MANAGER_PICKUP_CONFIG omits /payments and /cash-box; MyCashboxPage hardcodes role 'courier' and never renders branch settlement fields; backend cashbox/all-info would serve it

**Ta'sir:** Read-only visibility gap (no money loss): a PICKUP manager cannot see branch standing or owed-to-HQ from any screen.

### I16. [P2 · money] runFifoSettlement non-strict FIFO + non-idempotent operator resubmit with no owed-amount clamp on a negative-allowed cashbox
**Qayerda:** order-service.service.ts:1698 (skips older non-fitting leg, settles newer) + gateway mints fresh request_id per call (1415) + no server-side amount-vs-owed validation; FOR_COURIER allows negative

**Ta'sir:** Ordering fairness violated (newer order clears before older) and a deliberate double-submit over-allocates the same cash to next-oldest orders, driving the cashbox negative. No same-order double-count, but more cash can be settled than was handed over. Reachable only via the orphan /settlement page.

### I17. [P2 · frontend] Orphan ops/settlement pages registered without client-side role gating
**Qayerda:** Elchi-Frontend routes.tsx:255-262 (/settlement,/branch-ops,/logistics-ops,etc. no ProtectedRoute, absent from sidebars); branch-ops cancels a transfer batch by raw ID

**Ta'sir:** Backend RBAC still protects the endpoints (submits 403), but any authed user who learns the URL sees destructive dev forms; settlement input even sends an ignored branch_id that can mis-route if an admin submits. UX/hygiene, not privilege escalation.

### I18. [P2 · frontend] Courier scan-assign self-acquire action is built backend-side but wired to no real UI
**Qayerda:** backend logistics.order.scan_assign correct + RBAC; Elchi-Frontend scan pages are read-only, SCAN_ASSIGN only in coverage hook

**Ta'sir:** The courier's primary self-service custody-acquire action is unreachable; custody acceptance only happens via the mails/receive-post flow.

### I19. [P3 · state-machine] Double-assign race: no optimistic lock / no conditional WHERE on courier assignment
**Qayerda:** logistics scanAssignOrder:1885-1889 + assignOrdersToCourier:2110-2118 read-then-write; order updateFull save with no version column / no WHERE courier_id IS NULL

**Ta'sir:** Two concurrent assigns both pass the check; last-writer wins courier_id but both post counters increment. DOWNGRADED: post_total_price/order_quantity are display-only denormalized counters (recomputed on read), consumed by zero money flows; no money double-count, no custody loss. Transient cosmetic drift only.

### I20. [P3 · state-machine] Several lifecycle status writes bypass isValidStatusTransition (only updateFull is guarded)
**Qayerda:** order-service.service.ts:5321-5328 only call site vs raw UPDATEs at 2390,3488,3692,7993,8003,8185,8270

**Ta'sir:** Today each raw write hard-codes a valid transition so no illegal jump occurs, but the state machine is not centrally enforced — a future edit can silently violate the table with no guard.

### I21. [P3 · custody] Custody-event timeline gaps on non-holder-changing hops (receive, cancel, rollback)
**Qayerda:** order-service receiveNewOrders:3484-3510, cancelOrder:4248-4258, rollback:2387-2431 (no custody event when holder unchanged)

**Ta'sir:** Physical custody stays correctly attributed, but order_custody_event omits the received/cancelled/rolled-back hops, so reconstructing custody history from that table alone is incomplete vs order_tracking.

### I22. [P3 · frontend] Courier could-not-deliver and settle-to-branch have no UI affordance
**Qayerda:** couldNotDeliver only in coverage hook (no page imports it); courier has no settle action (correct per backend RBAC) and no confirmation of settlement beyond balance change

**Ta'sir:** Courier cannot record a soft delivery failure (must use CANCEL legacy path) and gets no explicit settlement feedback. Minor UX/visibility gaps.

## 🛠️ Tuzatish rejasi (bosqichma-bosqich — kod emas)

### Phase 1 — Money reconciliation (unify the settlement model; highest priority)
_The single biggest correctness risk is that two-and-a-half independent money models coexist and never reconcile, so the rollback-safety guard is blind and cash can be reversed on a wrong basis. Until this is unified, every other money fix is built on sand._

- **[P1/money]** Make the production cash path advance order_settlement: have finance.cashbox.payment_courier/branch_to_main/market drive (or be driven by) the per-order FIFO order_settlement state, or route the payments UI through order.settlement.* so cashbox legs and order_settlement always move together
- **[P1/money]** Fix the rollback guard so it reflects real-world cash position regardless of which path moved the money (do not key solely on order_settlement status that production never sets); block reversal once cash has demonstrably reached HQ
- **[P1/money]** Collapse the three obligation computations into one source of truth; make buildManagerSettlement read snapshotted courier_share/branch_share instead of courier_tariff so SALARY_ONLY and PARTNER figures match the ledger
- **[P1/money]** Add an end-to-end conservation invariant/reconciliation job: sum(unsettled order_settlement amounts) vs cashbox balances, and FIFO-vs-finance agreement; alert on divergence and on dropped outbox legs
- **[P2/money]** Prevent double-debit: share an idempotency/source key across the two payment paths (or retire one path) so one physical handover cannot be posted twice
- **[P2/money]** Add server-side owed-amount clamp + stable per-handover idempotency token to settlement so a deliberate resubmit cannot over-allocate; fix runFifoSettlement to be strictly oldest-first and report the true oldest gap
- **[P2/money]** Mirror the partner-branch kept share to a tracked balance, and stop silently dropping the negative branch EXPENSE leg (surface poisoned outbox rows to an operator)

### Phase 2 — Custody holes (keep a valid, audited holder at every hop and close the reverse path)
_Physical custody is correct at creation and on the modern forward path, but the full-receive staleness actively breaks bulk assignment and the entire return-to-market path never reaches the market in the custody model._

- **[P1/custody]** Fix full transfer-batch receive to set holder_type/holder_branch_id/holder_courier_id=destination + write a custody event (mirror the correct partial-receive sibling); until then point the whole-batch UI at the correct method
- **[P2/custody]** Introduce a MARKET holder type (or an equivalent terminal custody state) and write a closing custody event on markReturnedToMarket / cancel-post receive so the parcel's return is provably closed and not left with a stale courier/branch holder
- **[P2/custody]** Fix sendPost to set courier_id + assigned_at so the holder becomes COURIER with an event (eliminate the dormant landmine), even though it has no live caller today
- **[P3/custody]** Emit custody events for the non-holder-changing hops (received / cancelled / rolled-back) for a complete audit trail

### Phase 3 — State-machine integrity (block invalid reverse-path transitions, centralize guard)
_The state machine is only enforced in updateFull; the return path can reach terminal states without reversing money and via raw saves._

- **[P2/state-machine]** Add an order-status eligibility filter at return-batch creation and route markReturnedToMarket through isValidStatusTransition; reconcile/settle any live COD when an order is returned so a SOLD order's settlement can't be left dangling
- **[P3/state-machine]** Centralize the transition guard so every lifecycle status write (not just updateFull) is validated against the transitions table
- **[P3/state-machine]** Add a conditional WHERE / optimistic version to courier assignment to remove the double-assign race and its cosmetic counter drift

### Phase 4 — Frontend wiring & role completeness (make every role's required action reachable)
_Several core money/lifecycle actions are backend-only or mis-gated, so the right role cannot perform its step and sees the wrong state._

- **[P1/both]** Fix the Telegram-bot create path: resolve market_operator→market server-side (the mapping already exists in identity) and clean up the orphaned customer on failure
- **[P1/frontend]** Add a proof-file upload control to SellModal and CancelModal so proof-required markets can complete sell/cancel
- **[P1/frontend]** Give managers a real branch→HQ settle form (fix cashDetail type==='branch' null render) wired to the manager-permitted settlement endpoint
- **[P1/frontend]** Build real UI for could-not-deliver, initiate-return, mark-returned-to-market, and return-batch create/send/receive so the reverse-to-market lifecycle is operable; model WAITING_CUSTOMER and RETURNED_TO_MARKET in the order-status enum
- **[P2/frontend]** Either wire or retire the orphan /settlement page; if kept, add ProtectedRoute + remove the ignored branch_id input; add ProtectedRoute to all unguarded ops pages
- **[P2/both]** Wire courier scan-assign self-acquire UI and the external-provider feed import (and make integration-service actually call order.receive_external)
- **[P2/frontend]** Surface branch balance/owed-to-HQ to PICKUP managers and the market's receivable breakdown to markets; show couriers/managers the resulting owed amounts on sell

## ✅ To'g'ri va mustahkam ishlaydigan qismlar

- Initial custody is correct for every creation channel that actually runs: create() always resolves a concrete non-null holder (COURIER/BRANCH/HQ) and always writes an OrderCustodyEvent (null→holder) inside one transaction; order.entity defaults holder_type=HQ. No real creation path produces an orphan/null custodian.
- Market self-create, branch/filial self-create (with cross-branch abuse blocked at the gateway), registrator receive (NEW→RECEIVED + region post), and manual external create are all correct end-to-end with correct status, valid holder, custody+tracking events, and role gating.
- The 3-leg COD posting conserves money exactly: market=total-marketTariff, courier=total-courierShare, branch=total-courierShare-branchShare, and SELL_PROFIT=marketTariff-courierShare-branchShare equals HQ's net across the chain. The legs balance and each debt is consumed once at its settlement hop — no leak, no double-count in the math itself.
- Sell/partly-sell/cancel are atomic and idempotent: status flip + cashbox outbox enqueues + settlement row all commit in one transaction under a pessimistic lock on the WAITING row, with per-attempt dedup_epoch and finance-side idempotency on (cashbox,source_type,source_id,operation_type,dedup_epoch). A redelivered RMQ message is a no-op; sell→rollback→sell correctly re-applies.
- rollbackOrderToWaiting reverses all three sale legs exactly using snapshotted shares, reverses extra-cost symmetrically, resets the settlement row, and is atomic — the reversal logic itself is sound (its only flaw is the guard depending on a status the production path doesn't set).
- The courier cashbox balance correctly represents 'cash physically held by the courier that is owed up the chain' — the obligation is recorded the instant COD is collected, so a courier cannot hold COD cash with zero system record.
- The custody-correct forward paths work: partial transfer-batch receive (sets holder=BRANCH destination + custody event + re-batches the remainder so nothing is orphaned), QR scan-assign, and the modern dispatch assign-to-courier all move the holder to the right party and write custody events.
- The allowed-status-transitions table is complete and internally consistent (RETURNED_TO_MARKET terminal, CLOSED→WAITING re-open), and the per-order FIFO settlement arithmetic, when actually invoked, is coherent, atomic per leg, and safe against RMQ redelivery.
- The forward happy-path frontend is solid and role-correct: market create/see/get-paid, registrator intake+dispatch+send-batch, courier sell/partly-sell/cancel/rollback/send-to-cancel-post with correct per-role cashbox views, branch batch send/receive custody transfers, and admin/HQ receive-from-branch + pay-market + full money picture (three cashbox totals + P&L ledger).
- couldNotDeliver (re-deliverable, no money moved), initiateReturn (correctly blocks money-bearing states), and the legacy CANCEL→cancel-post return chain are logically correct backend-side and the cancel/rollback path is fully wired for couriers.

---

## 🛠️ REMEDIATION — 2026-06-11 (tuzatishlar)

Audit topilmalari bo'yicha quyidagilar **kod-tomondan tuzatildi va testdan o'tkazildi** (backend **258/258** jest yashil, frontend toza, ikkala prod-typecheck toza).

### Faza 1 — Pul reconciliation (split-brain yopildi)
- **I1+I2:** Yangi `order.settlement.advance` (faqat-state FIFO) — gateway prod to'lov yo'li (`finance.cashbox.payment_courier/branch_to_main/market`) cashbox'ni qimirlatgandan keyin `order_settlement`'ni ham advance qiladi (bir xil `dedup_epoch` token bilan, best-effort). Natija: rollback-guard (`isSettledToHq`) endi prodda ham to'g'ri ishlaydi; orphan `order.settlement.*` cashbox yo'li PENDING bo'lmagan rowlarda no-op bo'ladi → double-debit yo'q. Fayllar: `order-service.service.ts advanceSettlement`, `order-service.controller.ts`, `finance-gateway.controller.ts advanceOrderSettlement`.
- **I3:** `scripts/check-cashbox-invariant.ts`'ga cross-schema reconciliation (order_settlement status distribution + FOR_MARKET cashbox vs unsettled market_amount) — informational, migration-gate'ni buzmaydi.
- **I4:** `buildManagerSettlement` endi snapshotlangan `courier_share`ni ishlatadi (SALARY_ONLY kuryer qarzini to'g'ri ko'rsatadi).

### Faza 2 — Custody teshiklari
- **I9:** Full transfer-batch receive endi `holder_type/holder_branch_id=destination` o'rnatadi + custody event yozadi (partial-receive bilan bir xil) → bulk-assign mis-scope yo'q.
- **I10:** Yangi `OrderHolderType.MARKET` (enum + migratsiya `1716000000010`) + `markReturnedToMarket` custody'ni MARKETga yopadi (closing custody event).
- **I12:** `sendPost` ON_THE_ROAD'da order'ga `courier_id` o'rnatadi → holder COURIER bo'ladi.

### Faza 3 — State-machine
- **I11:** `markReturnedToMarket` SOLD/PAID/PARTLY_PAID'ni bloklaydi (avval rollback kerak); return-batch creation money-bearing/terminal statuslarni rad etadi.

### Boshqa backend
- **I6:** Telegram-bot create market_operator uchun `market_id`ni server-tomonda (user.market_id) hal qiladi — customer yaratishdan oldin (orphan yo'q).
- **I13:** Sub-share sotuvda BRANCH cashbox **system legi** uchun manfiyga ruxsat (manual remit strict qoladi) → outbox poison/silently-dropped yo'q.

### Faza 4 — Frontend
- **I17:** 8 ta orphan ops sahifa (`/settlement`, `*-ops`) `ProtectedRoute canViewOps` (admin/superadmin) bilan himoyalandi.
- **I7:** Yangi `ProofUpload` komponenti — SellModal + CancelModal'da proof-fayl yuklash (proof-talab market sell/cancel qila oladi). `proofFileKeys` ixtiyoriy — non-proof sotuvga ta'sir qilmaydi.
- **I5:** Manager branch→HQ settle — backend RBAC manager'ga o'z filiali uchun ruxsat (scoped, boshqa filialни rad etadi) + `cashDetail` branch uchun settle formasini render qiladi.

### ⏳ Qolgan (backend tayyor, kattaroq frontend UI ishi)
- **I8:** To'liq return/exception UI (could-not-deliver / initiate-return / mark-returned-to-market tugmalari + return-batch create/send/receive ekrani). Backend to'liq tuzatilgan; UI ko'p-ekranli ish — app ishlab turganda qurilishi tavsiya etiladi.
- **I15:** PICKUP-manager uchun branch-balans/HQ-qarz ko'rinishi (read-only UI).
- **I18:** Courier scan-assign self-acquire UI (backend tayyor).
- **P3 polish:** I19 (assign-race conditional WHERE), I20 (transition guard markazlashtirish), I21 (custody event'lar non-holder hop'larda).
