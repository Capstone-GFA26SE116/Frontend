# METANOIA — Workflow, Demo Scenarios & Test Plan (Defense 1.1)

> Preparation document for **Defense 1.1** (Review 2). Content follows the current implementation in `src/`.
> Part A is the formal deliverable mapped to the instructor's criteria. Part B is the technical reference used while demoing.
>
> **Convention:** every item marked `[TO BUILD]` does not exist in the repository yet and must be completed before Defense.
> UI strings quoted below are the **actual Vietnamese labels shown in the app** — each is followed by its English gloss so the demo script stays unambiguous.

---

# PART A — DELIVERABLE MAPPED TO THE DEFENSE 1.1 CRITERIA

## A.1. Identifying the Main Workflows

### A.1.1. Main Workflow list

Number of Main Workflows: **10**. The rule "number of workflows ≥ number of team members" is satisfied for any team of up to 10 members.
Every workflow has **exactly one owner**; every member owns **at least one workflow** (assignment table in A.1.3).

| ID | Main Workflow name | Actor | Trigger | Business outcome | Primary entity & state transitions |
|---|---|---|---|---|---|
| **MW-01** | Authentication & work-profile onboarding | New user (Guest → Member) | First app launch / click "Đăng nhập Google" (Sign in with Google) | Valid access token + personalised profile (role, domains, goals) | `User`: `Guest → Authenticated`; `Profile`: `Empty → Configured` |
| **MW-02** | Client (customer) management | Project Manager / Freelancer | Add / edit / delete a customer | Complete customer directory; customers can be attached to projects | `Client`: `— → Active` (create), `Active → Deleted` (delete) |
| **MW-03** | Project & milestone bootstrap | Project Manager | Click "New project" / "New milestone" | A project with deadline, client and phase structure ready to hold tasks | `Project`: `Draft → Active`; `Milestone`: `— → Open` |
| **MW-04** | Manual task decomposition (Task/Subtask) | Project Manager | Create a task in Planning, add subtasks | Tasks + subtasks with time estimates, ready to be scheduled | `Task`: `— → ToDo`; `Subtask`: `— → ToDo` |
| **MW-05** | AI task decomposition (Copilot) | Project Manager | Send a chat prompt to the AI service | AI proposes subtasks, user approves and applies them → real subtasks in DB | `Subtask`: `— → ToDo` (AI-generated); `Task`: `ToDo → ToDo` (draft attached) |
| **MW-06** | AI schedule proposal & slot approval | Project Manager | Click "Đề xuất lịch" (Propose schedule) in Copilot/Schedule | AI-generated time slots approved one by one → `Approved` slots in the calendar | `ScheduleSlot`: `— → Proposed → Approved` |
| **MW-07** | Calendar view & two-way Google Calendar sync | End user | Open `/schedule`, click Connect / Sync | One unified calendar holding both METANOIA slots and Google events | `ScheduleSlot`: `Approved → Due`; `googleEventId` assigned / restored |
| **MW-08** | Focus session execution | End user | Click "Bắt đầu" (Start) on a slot, or self-report time already worked | Quantified real working time per task → training data for K_bias | `ScheduleSlot`: `Due → InProgress → Overrun → Done`; `FocusSession`: `— → Running → Stopped/AutoTimeout/PendingConfirm` |
| **MW-09** | Notification delivery & reminders | End user (reactive) | BE pushes an event over SignalR / Web Push | Realtime toast + persisted inbox + unread badge | `Notification`: `— → Unread → Read` |
| **MW-10** | Plan upgrade & PayOS checkout | End user (Free tier) | Click "Mua gói này" (Buy this plan) on `/pricing` | Subscription upgraded, invoice issued | `Payment`: `Pending → Succeeded`; `Subscription`: `— → Active` |

### A.1.2. Activity Diagram specification (for cross-checking against the SDD)

Each MW below is an **activity step list** — it is the source for drawing the Activity Diagram in the SDD and guarantees a 1-1 mapping.

**MW-01 — Authentication & work-profile onboarding**
1. Open Landing → 2. Select "Đăng nhập" (Sign in) → 3. [decision] Is `VITE_GOOGLE_CLIENT_ID` configured?
   - No → *mock fallback* → 3b. Show "chưa được cấu hình" (not configured) → end of error branch
   - Yes → 4. Render Google button (GIS `accounts.id`) → 5. User picks an account → 6. Receive `idToken`
4. `POST /api/Auth/google` → 5. [decision] HTTP 200?
   - 401/400 → *exception* → show error, return to step 4
   - 200 → 6. Persist `accessToken`/`refreshToken` in localStorage → 7. `getPostLoginPath(from)`
6. → 8. [decision] Landing already seen / is there a `from`?
   - Valid `from` → 9. Navigate to the deep link
   - Landing not seen → 9. Navigate to `/`
   - Otherwise → 9. Navigate to `/dashboard`
9. → 10. [decision] Does `metanoia:onboarding` exist?
   - Yes → 11. Enter the app
   - No → 12. Onboarding (3 steps: role → domains → goals) → 13. Write localStorage → 14. Enter `/dashboard`

**MW-02 — Client management**
1. Open `/clients` → 2. `GET /api/clients` → 3. Render list (master) → 4. Select a client → 5. `GET /api/clients/{id}` (detail) → 6. [decision] Action?
   - Create → 7. Open form → 8. Validate (name required, email format) → 9. `POST /api/clients` → 10. Reload list
   - Update → 11. `PUT /api/clients/{id}` → 12. Reload
   - Delete → 13. Confirmation modal → 14. `DELETE /api/clients/{id}` → 15. Reload
10. → 16. Count that client's projects via `GET /api/projects` → 17. Render profile completeness

**MW-03 — Project & milestone bootstrap**
1. Open `/projects` → 2. `GET /api/projects/filter` + `GET /api/clients` (in parallel) → 3. Render grid + KPIs
4. Click "New project" → 5. Open modal → 6. [decision] Pick an existing client / create a new one in the nested modal?
   - Create new → 7. `POST /api/clients` → 8. Auto-select the new client → back to 9
   - Existing → 9. Select a client / leave empty (internal project)
9. → 10. Enter name, startDate, deadline, description → 11. [decision] deadline > startDate?
   - No → *exception* → block submit + show validation error
   - Yes → 12. `POST /api/projects` (empty clientId → `null`) → 13. `GET /api/projects/{id}/progress` → 14. Render the new card
15. Open `/projects/{id}/milestones` → 16. "New milestone" → 17. Enter name, orderIndex ≥ 1, dueDate → 18. `POST /api/projects/{id}/milestones` → 19. Render the milestone chip

**MW-04 — Manual task decomposition**
1. Open `/projects/{id}/planning` → 2. Load milestones + tasks + subtasks → 3. [decision] Does the project already have a milestone?
   - No → *exception* → 4. Show the "Create a milestone first" hint with a quick-create button → back to step 3
   - Yes → 5. "New task" → 6. Enter title*, description, taskType, milestoneId*, domain, deadline, estimatedMinutes
7. [decision] taskType = Fixed?
   - Yes → 8. Enter fixedStart/fixedEnd → 9. BE auto-creates an `Approved` slot (auto-scheduled)
   - Flexible → 10. No slot created
11. `POST /api/projects/{id}/tasks` → 12. Expand the task → 13. "Add subtask" × N → 14. `POST /api/tasks/{taskId}/subtasks`
15. Click the 📅 button → 16. "Schedule Task" modal → 17. [decision] Pick one subtask / "Whole task"?
   - One subtask → 18. Create 1 slot
   - Whole task → 19. Split the time proportionally to each subtask's `estimatedMinutes` (ordered by `orderIndex`) → 20. Create N consecutive slots
21. `POST /api/tasks/{taskId}/schedule-slots` (status `Approved`, `isManualOverride: true`) → 22. Toast the result

**MW-05 — AI task decomposition**
1. Open `/copilot` → 2. Select a project → 3. Select a task → 4. Click "Load"
5. In parallel: `GET /chat/tasks/{task_id}` + `GET /memory/similar?task_id=&limit=5` → 6. Render chat history + RAG panel
7. Pick a quick prompt or type a message → 8. FE prepends the `[Task] [Description]` context → 9. `POST /chat/tasks/{task_id}/messages`
10. [decision] AI returns 409 (another task is being processed)?
   - Yes → 11. Automatic retry, max 2 times (backoff 1.5s → 3s) → back to 9
   - No → 12. Render the Draft Card (subtasks, estimate, adjusted, K_bias, warning)
13. Click "Accept & apply subtasks" → 14. `POST /chat/tasks/{task_id}/apply` → 15. Real subtasks written to DB + a confirmation message injected into the stream
16. [decision] Is `applyingRef` locked? → if yes, double-apply is blocked → 17. Toast "Synced!"

**MW-06 — AI schedule proposal & slot approval**
1. Click "Đề xuất lịch" → 2. Collect eligible tasks: `taskType = Flexible`, no fixed time, no slot yet, `status ∉ {Done, Completed, Cancelled, Skipped}`
3. For **each** task, issue a separate `POST {AI}/schedule/propose` (in parallel) → 4. Receive `proposal_id`, `is_feasible`, `missing_minutes`, `explanation`, `slots[]`, `warnings[]`
5. [decision] `is_feasible = false`? → *exception* → 6. Show warnings (`not_enough_time`/`overdue`/`no_free_slot`/`insufficient_time`) + `missing_minutes` → 7. Stop this branch (the task is not scheduled)
8. Render the slots (ticked by default) → 9. User ticks / unticks → 10. Click "Thêm vào lịch" (Add to calendar)
11. For **each** ticked slot: `POST /api/tasks/{taskId}/schedule-slots` with the **matching** `scheduleProposalId` → 12. [decision] Error? → untick the failed slot, keep the panel open for re-approval
13. Toast "Đã thêm N khung giờ" (N slots added) → 14. Refresh the calendar

**MW-07 — Calendar & Google Calendar sync**
1. Open `/schedule` → 2. [decision] View mode? → Week / Month / Gantt → 3. `GET /api/calendar` + merged project/task/subtask/slot data
4. [decision] Is Google connected? (`GET /api/google-calendar/status`)
   - Not connected → 5. "Connect" → `GET /api/google-calendar/connect` → 6. `window.location.assign(authorizationUrl)` (full-page redirect — `fetch` is impossible here because the Authorization header would be lost)
   - Connected → 9. Click "Sync" → `POST /api/google-calendar/sync` → 10. Toast `+added · updated · cancelled` → 11. Refresh
7. Google calls the BE callback → 8. BE stores the token → redirect to `/auth/google/callback?calendar=connected` → the page reads the query and calls `GET /api/google-calendar/status` → shows "connected"

**MW-08 — Focus session execution**
1. Click a slot → 2. Detail modal → 3. [decision] What is the slot `phase`?
   - `Proposed` → *exception* → no Start button is rendered (the BE would return 400)
   - `Approved` → "Bắt đầu sớm" (Start early) · `Due` → "Bắt đầu" (Start) · `Missed` → "Làm bù" (Make up)
4. Click Start → 5. `POST /api/focus/start { taskId, scheduleSlotId }`
6. [decision] HTTP status?
   - 201 → 7. Initialise the clock: `elapsed = server.elapsedSeconds + (performance.now() - receivedAt)/1000` → 8. Persist `plannedMinutes` in sessionStorage → 9. Render the global timer bar
   - 409 → *exception* → 10. Read `details` (it *is* the running session) → 11. Switch the UI to that session — no red error
   - 400/404 → *exception* → show the message
12. [decision] `warning = STARTED_VERY_EARLY` (> 2h early)? → dialog "keep or discard?" → if "No" → call Stop immediately with `Interrupted`
13. Periodic resync: `GET /api/focus/current` every 20s and on `visibilitychange` → the clock never goes stale
14. Click "Dừng" (Stop) → 15. Dialog to pick a reason (`Completed`/`Interrupted`/`Blocked`/`Other`) → 16. `POST /api/focus/{sessionId}/stop`
17. [decision] HTTP 409 (already stopped)? → treat as **success**, do not raise an error
18. [decision] `stopReason = Completed`? → slot → `Done`; otherwise → slot → `Due` → 19. `checkInRequired`? → check-in dialog
20. `GET /api/focus/{slotId}/time-summary` → 21. Render Planned / Actual / Session count
22. [alternate branch] Forgot to press Start → `POST /api/focus/self-report` (validates `endedAt > startedAt`, neither in the future, ≤ 24h)
23. [alternate branch] System auto-timeout → `GET /api/focus/pending-confirmation` → `POST /api/focus/{sessionId}/confirm { confirmed, correctedMinutes }`

**MW-09 — Notification delivery & reminders**
1. App mount → `NotificationsProvider` opens **one** SignalR connection `/hubs/notifications` (`accessTokenFactory` passes the JWT, `withAutomaticReconnect()`)
2. [decision] Any `actionType` arriving? (`PRE_START_REMINDER`, `START_PROMPT`, `NOT_STARTED`, `NEAR_END`, `OVERRUN`, `AUTO_TIMEOUT`, `CHECK_IN`, `MISSED_SLOT`)
   - Yes → 3. Show the toast → 4. Refetch `GET /api/focus/current` + `GET /api/focus/pending-confirmation` + `GET /api/notifications` → 5. Update the badge
   - No → 6. Wait
7. [secondary branch] Web Push: `GET /api/notifications/vapid-public-key` → subscribe via service worker `/sw.js` → `POST /api/notifications/subscribe`
8. Open `/notifications` → 9. [decision] Filter? (All / Unread) → 10. `GET /api/notifications?unreadOnly&take=50` → 11. Render
12. Mark as read: `POST /api/notifications/{id}/read` or `POST /api/notifications/read-all` → 13. Badge updates

**MW-10 — Plan upgrade & PayOS checkout**
1. Open `/pricing` → 2. `GET /api/subscription-plans` + `GET /api/me` → 3. Render plans, monthly/yearly toggle, comparison
4. Click "Mua gói này" (Buy this plan) — only for plans with `isActive && price > 0` → 5. `POST /api/payments/checkout { planId }` → 6. Persist the pending payment in localStorage → 7. `window.location.assign(checkoutUrl)` → the PayOS page
8. PayOS redirects to `/payment/success` or `/payment/cancel` → 9. `POST /api/payments/{paymentId}/sync` (every 3s, max 10 attempts)
10. [decision] `status`?
   - `Succeeded` → 11. Refetch `/api/me` + `/api/invoices` → 12. Show the new plan + invoice
   - `Pending` → 13. "Đang xử lý" (Processing) → retry — **do not** report a failure
   - `Cancelled`/`Expired`/`Failed` → 14. Show the matching message + a "create again" button
   - `503` → keep "Processing" → retry

### A.1.3. Owner assignment

> Replace `M1..M5` with the real team member names. Everyone owns at least one workflow.

| Owner | Main Workflows owned | Count | Demo role |
|---|---|---|---|
| **M1** | MW-01, MW-09 | 2 | Sign-in → onboarding → notifications |
| **M2** | MW-02, MW-03 | 2 | Clients → projects → milestones |
| **M3** | MW-04, MW-05 | 2 | Manual decomposition → AI decomposition |
| **M4** | MW-06, MW-07 | 2 | AI scheduling → calendar & Google Calendar |
| **M5** | MW-08, MW-10 | 2 | Focus session → billing |

*(For a team of N members: redistribute the table so every member owns ≥ 1 workflow and the total stays 10.)*

### A.1.4. Cross-check against the SDD

| Main Workflow | Activity Diagram in the SDD | Planned section | Status |
|---|---|---|---|
| MW-01 | AD-01 Authentication & onboarding | §4.1 | `[TO DRAW]` |
| MW-02 | AD-02 Client management | §4.2 | `[TO DRAW]` |
| MW-03 | AD-03 Project & milestone bootstrap | §4.3 | `[TO DRAW]` |
| MW-04 | AD-04 Manual decomposition | §4.4 | `[TO DRAW]` |
| MW-05 | AD-05 AI decomposition | §4.5 | `[TO DRAW]` |
| MW-06 | AD-06 AI schedule proposal | §4.6 | `[TO DRAW]` |
| MW-07 | AD-07 Calendar & Google Calendar | §4.7 | `[TO DRAW]` |
| MW-08 | AD-08 Focus session | §4.8 | `[TO DRAW]` |
| MW-09 | AD-09 Notifications | §4.9 | `[TO DRAW]` |
| MW-10 | AD-10 PayOS checkout | §4.10 | `[TO DRAW]` |

**Rule "every workflow has a matching Activity Diagram in the SDD"**: use the **same IDs** (MW-0x ↔ AD-0x) so the instructor can compare them 1-1.

---

## A.2. Preparing the demo scenarios

### A.2.1. Staging environment

| Item | Configuration |
|---|---|
| FE | `npm run build` → deploy on Vercel (`vercel.json` already exists), or `npm run dev` on the demo machine |
| Backend | Staging URL in `VITE_API_URL` |
| AI Service | Staging URL in `VITE_AI_API_URL` (FastAPI) |
| Google OAuth | `VITE_GOOGLE_CLIENT_ID` (demo Client ID) — Redirect URI registered for the staging domain |
| Google Calendar | Demo Google account with Calendar scope granted |
| PayOS | Test merchant, `ReturnUrl`/`CancelUrl` pointing at staging |
| Push notifications | Web Push requires **https** or `localhost` — on a non-https staging domain only SignalR + the inbox can be demoed |
| Data | Loaded by the seed script (A.5.2), re-runnable any number of times |

### A.2.2. Sample-data script

The repository has **no seed script yet**. To create `[TO BUILD]`:

```
scripts/
  seed-demo.ts        # creates client, project, milestone, task, subtask, slot
  seed-history.ts     # creates completed past tasks → data for RAG / K_bias
  reset-demo.ts       # deletes demo data by name prefix
```

**Minimum sample dataset** (shared by every scenario):

| Group | Data | Used by |
|---|---|---|
| Account | 1 demo Google user (onboarding already completed) | Everything |
| Clients | "Minh Long Trading Co." (email, phone, notes), "Ha Anh Studio" | MW-02, MW-03 |
| Project | "Minh Long e-commerce website" — starts today, deadline in +14 days, first client attached | MW-03..MW-08 |
| Milestones | "Phase 1 — Design", "Phase 2 — Development" (order 1, 2) | MW-03, MW-04 |
| **Flexible** tasks with no slot | "Build the payment API" (120′), "Design the checkout page" (90′) | MW-05, MW-06 |
| Task with a full description | "Build the payment API" — description lists the concrete business milestones | MW-05 (so the AI does not ask clarifying questions) |
| **Fixed** task | "Client review meeting" — fixedStart/fixedEnd | MW-04, Fixed branch |
| Subtasks | 3 subtasks for the design task (60′, 90′, 30′) | MW-04, "Whole task" branch |
| History (RAG) | ≥ 5 completed tasks in the same domain with estimated vs actual divergence (so K_bias ≠ 1) | MW-05 RAG panel, MW-08 |
| Slots | 1 `Approved` slot today 09:00–10:00 (to demo Start) | MW-08 |
| Slots | 1 `Approved` slot tomorrow (to demo "start early") | MW-08 exception |
| Slots | 1 `Proposed` slot (to demo the hidden Start button) | MW-08 exception |
| Slots | 1 slot of 3 minutes (to demo auto-timeout) | MW-08 exception |

### A.2.3. Demo scenario list

> Every scenario specifies: **Preconditions & sample data → Steps → Expected result → Presenter**.
> Total: 10 Main Scenarios + 20 Exception Scenarios = **30 scenarios**.

---

#### **MW-01 — Authentication & work-profile onboarding** · Owner: M1

**MS-01 (Main)** — First-time Google sign-in
- *Preconditions:* clean `localStorage`, valid `VITE_GOOGLE_CLIENT_ID`, staging BE + AI running.
- *Sample data:* demo Google account.
- *Steps:* 1) Open `/` → 2) "Đăng nhập" (Sign in) → 3) Pick the Google account → 4) Pick a role + 2 domains + 2 goals → 5) "Tiếp tục vào Không gian làm việc" (Continue into the workspace).
- *Expected result:* `POST /api/Auth/google` returns 200 → tokens persisted in localStorage → `metanoia:onboarding` written → land on `/dashboard` with the timeline populated from real API data.
- *Presenter:* M1.

**ES-01 (Exception)** — OAuth failure / expired token
- *Preconditions:* use DevTools to block `POST /api/Auth/google` with 401.
- *Steps:* 1) Click the Google button → 2) Pick an account → 3) BE returns 401 → 4) Click the Google button again.
- *Expected result:* shows "Đăng nhập Google thất bại" (Google sign-in failed), no crash, no session created; the button remains usable. If the `accessToken` has expired, a 401 triggers an automatic `POST /api/Auth/refresh` + retry.
- *Presenter:* M1.

**ES-02 (Exception)** — Skipping onboarding
- *Preconditions:* signed in, no `metanoia:onboarding` key yet.
- *Steps:* 1) Open `/onboarding` → 2) Click "Bỏ qua bước này" (Skip this step) → 3) Navigation to `/dashboard`.
- *Expected result:* a default profile is still persisted → onboarding is marked complete → the app is reachable and the user is not re-prompted.
- *Presenter:* M1.

---

#### **MW-02 — Client management** · Owner: M2

**MS-02 (Main)** — Create / update / delete a customer
- *Preconditions:* signed in + onboarding completed.
- *Sample data:* client "Minh Long Trading Co." does not exist yet.
- *Steps:* 1) Open `/clients` → 2) "New client" → 3) Enter name, email, phone, notes → 4) Save → 5) Select the new client → 6) Edit the email → 7) Delete a different client.
- *Expected result:* `POST` → 201 → the client appears in the list; its project count comes from `GET /api/projects`; deleting shows a confirmation modal and the client disappears from the list.
- *Presenter:* M2.

**ES-03 (Exception)** — Invalid input
- *Preconditions:* the create-client modal is open.
- *Steps:* 1) Leave `name` empty → 2) Enter a malformed email `abc@` → 3) Click Save.
- *Expected result:* the form validates inline, the Save button is blocked, the matching error is shown, and **no API call is made**.
- *Presenter:* M2.

**ES-04 (Exception)** — Insufficient permission / deleting a client that still has projects
- *Preconditions:* "Minh Long Trading Co." is attached to one project.
- *Steps:* 1) Attempt to delete the client → 2) Confirm.
- *Expected result:* the BE returns `400/409` → a clear message is shown and no data is lost; or, if the BE allows it, the project must be updated to `clientId = null`. **The actual BE behaviour must be confirmed before Defense and documented in the SDD.**
- *Presenter:* M2.

---

#### **MW-03 — Project & milestone bootstrap** · Owner: M2

**MS-03 (Main)** — Create a project and a client from inside the project modal
- *Preconditions:* client "Minh Long Trading Co." already exists.
- *Sample data:* project "Minh Long e-commerce website".
- *Steps:* 1) Open `/projects` → 2) "New project" → 3) Enter name, start, deadline, description → 4) In the Client field click "New client" (nested modal) → create "Ha Anh Studio" → 5) The new client is auto-selected → 6) "Create project" → 7) Open `/projects/{id}/milestones` → 8) Create "Phase 1 — Design".
- *Expected result:* the new project card appears first in the grid with 0% progress; the milestone chip shows in the list; `GET /api/projects/{id}/progress` returns the correct percentage.
- *Presenter:* M2.

**ES-05 (Exception)** — Business-rule violation: deadline ≤ startDate
- *Preconditions:* the "New project" modal is open.
- *Steps:* 1) startDate = 20/10/2026 → 2) deadline = 18/10/2026 → 3) Click "Create project".
- *Expected result:* validation blocks the submit, shows "deadline phải sau startDate" (deadline must be after startDate), and `POST /api/projects` is **not** called.
- *Presenter:* M2.

**ES-06 (Exception)** — Task without a milestone
- *Preconditions:* a brand-new project with **no** milestone.
- *Steps:* 1) Open `/projects/{id}/planning` → 2) Click "New task" → 3) Fill everything in → 4) Click Create.
- *Expected result:* the submit button is disabled and the "Create a milestone first" hint with a quick-create button is shown. This is a **mandatory business rule** — every task must belong to exactly one milestone.
- *Presenter:* M2.

---

#### **MW-04 — Manual task decomposition** · Owner: M3

**MS-04 (Main)** — Task → Subtask → manual slot split
- *Preconditions:* the project has the milestone "Phase 1 — Design".
- *Sample data:* task "Design the customer dashboard" (Flexible, est. 120′) with 3 subtasks 60′/90′/30′.
- *Steps:* 1) Open `/projects/{id}/planning` → 2) "New task" → fill → Create → 3) Expand the task → "Add subtask" × 3 → 4) Click 📅 → 5) Start 09:00, End 13:00 → pick "Whole task" → 6) Schedule → 7) Switch to the Week view in `/schedule`.
- *Expected result:* toast "3 subtask đã được chia lịch" (3 subtasks have been scheduled); three consecutive blocks appear at 09:00–10:00, 10:00–11:30 and 11:30–12:00 with the exact `estimatedMinutes` proportions, tagged as the "Manual" source, with `status = Approved`.
- *Presenter:* M3.

**ES-07 (Exception)** — Creating a `Fixed` task without `fixedStart`/`fixedEnd`
- *Preconditions:* the "New task" modal is open with taskType = Fixed.
- *Steps:* 1) Select Fixed → 2) Leave fixedStart/fixedEnd empty → 3) Click Create.
- *Expected result:* the form requires the full time range and blocks the submit, or the BE returns 400 and the message is shown. If the input is valid → the BE auto-creates an `Approved` slot (auto-scheduled).
- *Presenter:* M3.

**ES-08 (Exception)** — Deleting a milestone that still holds tasks
- *Preconditions:* "Phase 1 — Design" still has one task.
- *Steps:* 1) Delete the milestone → 2) Confirm in the modal.
- *Expected result:* the milestone is deleted; the task survives but its `milestoneId = null` → the user must be warned that the task lost its phase link, and `/planning` must block editing that task until a milestone is re-assigned.
- *Presenter:* M3.

---

#### **MW-05 — AI task decomposition** · Owner: M3

**MS-05 (Main)** — Chat decompose + apply subtasks
- *Preconditions:* the AI Service staging instance is running; the task "Build the payment API" has a complete description.
- *Sample data:* ≥ 5 completed historical tasks in the same domain (for RAG).
- *Steps:* 1) Open `/copilot` → 2) Select the project → 3) Select the task → 4) Click "Load" → 5) Click the ⚡ quick prompt → 6) Inspect the Draft Card → 7) Click "Accept & apply subtasks".
- *Expected result:* `GET /chat/tasks/{id}` and `GET /memory/similar` return real data; the AI reads **both title and description** (the FE prepends `[Task] [Description]` to the message) so it does **not** ask vague clarifying questions; the Draft Card shows "Your estimate → Adjusted" plus the `K_bias` badge; after applying, the real subtasks appear in `/planning` and a confirmation message is injected into the chat stream.
- *Presenter:* M3.

**ES-09 (Exception)** — AI Service error / overload (409, 5xx)
- *Preconditions:* block `POST /chat/tasks/{id}/messages` with 409.
- *Steps:* 1) Send a message → 2) Observe the retries → 3) If it still fails, press send again.
- *Expected result:* at most 2 automatic retries (backoff 1.5s → 3s); if the retries are exhausted, a clear error is shown, the typed message is **not** lost, and **no** bogus subtasks are created.
- *Presenter:* M3.

**ES-10 (Exception)** — Duplicate apply / insufficient AI context
- *Preconditions:* (a) double-click "Accept & apply"; (b) use a task with no description.
- *Steps:* 1) Double-click "Accept & apply" → 2) Observe → 3) Send a prompt for the task without a description.
- *Expected result:* `applyingRef` blocks the double-apply (exactly one API call). For the task with no description, the AI answers with a clarifying question instead of inventing meaningless subtasks, and the FE renders that question as-is.
- *Presenter:* M3.

---

#### **MW-06 — AI schedule proposal & slot approval** · Owner: M4

**MS-06 (Main)** — Propose → approve selected slots → visible in the calendar
- *Preconditions:* a Flexible task with no slot and no fixed time; the AI Service is running.
- *Sample data:* "Build the payment API", "Design the checkout page".
- *Steps:* 1) Click "Đề xuất lịch" → 2) Wait for the AI to return the slots → 3) Untick one slot → 4) Click "Thêm vào lịch" → 5) Open `/schedule` on the Week view.
- *Expected result:* each task receives **its own request** (exactly one `proposal_id` per task); ticked slots are committed via `POST /api/tasks/{taskId}/schedule-slots` with the matching `scheduleProposalId` → `status = Approved`; the unticked slot is **not** created; the calendar refreshes.
- *Presenter:* M4.

**ES-11 (Exception)** — Not enough time / overdue task (`is_feasible = false`)
- *Preconditions:* one task whose deadline has passed or that needs more than 8h in a day.
- *Steps:* 1) Click "Đề xuất lịch" → 2) Observe the result.
- *Expected result:* `is_feasible = false` + `missing_minutes` + specific `warnings[]` (`not_enough_time`/`overdue`/`no_free_slot`/`insufficient_time`) → **no** slot is created. This is the **correct designed behaviour**, not a bug — say so explicitly during the demo.
- *Presenter:* M4.

**ES-12 (Exception)** — Shared `proposal_id` / mid-run slot failure
- *Preconditions:* make one `POST /api/tasks/{id}/schedule-slots` call fail with 400.
- *Steps:* 1) Tick 3 slots → 2) Click "Thêm vào lịch" → 3) Observe the toast.
- *Expected result:* the failed slot is unticked automatically, the **panel stays open** so the user can re-approve, and the slots that already succeeded are not lost. Mandatory rule: each task uses its own `proposal_id` — sharing one id makes the BE reject the request.
- *Presenter:* M4.

---

#### **MW-07 — Calendar & Google Calendar sync** · Owner: M4

**MS-07 (Main)** — Connect + two-way sync
- *Preconditions:* demo Google account; Google Calendar API enabled.
- *Sample data:* 1 Google event this week + 2 METANOIA slots.
- *Steps:* 1) Open `/schedule` → 2) Sidebar → Google Calendar → "Connect" → 3) Approve the OAuth consent → 4) Return to `/auth/google/callback?calendar=connected` → 5) Click "Sync" → 6) Observe the Week view.
- *Expected result:* `GET /api/google-calendar/status` = connected; `POST /api/google-calendar/sync` returns `{added, updated, cancelled}` shown in the toast; Google events and METANOIA slots appear in one calendar, distinguishable by their source tag.
- *Presenter:* M4.

**ES-13 (Exception)** — Not connected yet / the user denies consent
- *Preconditions:* not connected; on the second attempt the user clicks "Cancel" on the Google screen.
- *Steps:* 1) Click "Connect" → 2) Click "Cancel"/"Deny" in Google → 3) Return to the app.
- *Expected result:* the status remains "not connected", a retry-oriented message is shown, and the app does not crash. If the deployed BE returns `404/405/302`, the hook falls back to redirecting straight to the endpoint.
- *Presenter:* M4.

**ES-14 (Exception)** — Sync failure (Google API error / revoked token)
- *Preconditions:* revoke the permission in the Google Account while the BE still holds the token.
- *Steps:* 1) Click "Sync" → 2) Observe the result.
- *Expected result:* an informative error is shown, slots that fail to sync are flagged with `syncFailed`, and the other slots are unaffected.
- *Presenter:* M4.

---

#### **MW-08 — Focus session execution** · Owner: M5

**MS-08 (Main)** — Start → run across pages → Stop → summary
- *Preconditions:* an `Approved` slot today at 09:00–10:00.
- *Sample data:* slot "Component design" 09:00–10:00.
- *Steps:* 1) Open `/schedule` → Week → click the slot → 2) Detail modal → "Bắt đầu" (Start) → 3) The timer bar appears at the bottom → 4) Navigate to `/dashboard` → the timer keeps running → 5) Go back → "Dừng" (Stop) → 6) Pick "Đã xong" (Completed) → confirm → 7) Answer the check-in → 8) Reopen the modal.
- *Expected result:* `POST /api/focus/start` returns 201 → the global timer bar is visible on every page; the clock is accurate (monotonic, unaffected by changing the system time); `POST /api/focus/{id}/stop` returns 200 → the slot becomes `Done`; toast "Phiên này X phút · tổng task Y phút"; `GET /api/focus/{slotId}/time-summary` renders Planned / Actual / Session count.
- *Presenter:* M5.

**ES-15 (Exception)** — Two tabs open (session already running → 409)
- *Preconditions:* tab 1 already has a running session.
- *Steps:* 1) Open tab 2 → `/schedule` → 2) Click "Bắt đầu" (Start) on a different slot → 3) Observe the toast → 4) Back to tab 1 → click "Dừng" (Stop) twice quickly.
- *Expected result:* in tab 2, the toast "Đang có phiên khác chạy" (another session is running) appears — not red, no crash — and the FE reads `details` and switches to displaying the running session. In tab 1, the second Stop returns 409 → treated as **success**, with no error shown.
- *Presenter:* M5.

**ES-16 (Exception)** — `Proposed` / already `Done` slot → clicking Start
- *Preconditions:* one `Proposed` slot and one `Done` slot exist.
- *Steps:* 1) Open the `Proposed` slot → observe the buttons → 2) Open the `Done` slot → observe the buttons → 3) (Optional) call `POST /api/focus/start` with the `Proposed` slot directly from the DevTools console.
- *Expected result:* the UI renders **no** Start button for `Proposed`/`Done`/`Cancelled` (the BE would return 400); a manual call returns 400 → the message is shown and no session is created.
- *Presenter:* M5.

---

#### **MW-09 — Notification delivery & reminders** · Owner: M1

**MS-09 (Main)** — Realtime toast + inbox
- *Preconditions:* signed in, app open, SignalR connected.
- *Steps:* 1) Open the app → 2) Have the BE push a `START_PROMPT` / `NEAR_END` event (or use `scripts/trigger-notification.ts` to simulate it `[TO BUILD]`) → 3) Observe the toast → 4) Click the bell → 5) `/notifications` → filter "Chưa đọc" (Unread) → 6) "Đánh dấu đã đọc" (Mark as read).
- *Expected result:* the toast shows the correct content; the unread badge updates; after every SignalR event the FE refetches `/api/focus/current` + `/api/focus/pending-confirmation` so the clock never goes stale; the inbox keeps a persistent history.
- *Presenter:* M1.

**ES-17 (Exception)** — SignalR connection loss / BE error
- *Preconditions:* block `/hubs/notifications` or turn off the network.
- *Steps:* 1) With the app open → 2) Disconnect the network for 10s → 3) Restore it → 4) Observe.
- *Expected result:* `withAutomaticReconnect()` re-establishes the connection automatically; the app remains usable during the outage thanks to the fallback poll `GET /api/focus/current` every 20s; the running session is not lost.
- *Presenter:* M1.

**ES-18 (Exception)** — Web Push subscription fails (no https / user blocks it)
- *Preconditions:* the demo runs on a non-https domain, or the user clicks "Block" in the browser's notification prompt.
- *Steps:* 1) Click "Bật thông báo" (Enable notifications) → 2) Block in the browser → 3) Observe the status.
- *Expected result:* a clear explanation is shown (https/localhost required, or blocked by the user), the status still reads correctly (not enabled), the app does not break, and the SignalR channel keeps working.
- *Presenter:* M1.

---

#### **MW-10 — Plan upgrade & PayOS checkout** · Owner: M5

**MS-10 (Main)** — Buy a plan → pay → the plan becomes active
- *Preconditions:* the PayOS test merchant is configured with `ReturnUrl`/`CancelUrl` pointing at staging.
- *Steps:* 1) Open `/pricing` → 2) Toggle monthly/yearly → 3) Click "Mua gói này" (Buy this plan) → 4) The PayOS page (QR) → 5) Pay → 6) Redirect to `/payment/success` → 7) Observe → 8) Open `/profile` and check the invoice.
- *Expected result:* `POST /api/payments/checkout` returns `checkoutUrl` → the redirect happens; `POST /api/payments/{id}/sync` polls every 3s up to 10 times; on `Succeeded` the FE refetches `/api/me` + `/api/invoices` → the new plan and its invoice are displayed.
- *Presenter:* M5.

**ES-19 (Exception)** — The user cancels the payment / PayOS errors out
- *Preconditions:* PayOS test merchant.
- *Steps:* 1) Click "Mua gói này" → 2) On the PayOS page choose cancel → 3) Or simulate PayOS returning `503`.
- *Expected result:* `Cancelled` → the matching message plus a "create again" button; `Pending` → "Đang xử lý" (Processing) → retry, **never** reported as a failure; `503` → stay in "Processing" and retry. The FE must **never** conclude "payment succeeded" from the URL alone.
- *Presenter:* M5.

**ES-20 (Exception)** — Profile: `PUT /api/me/profile` is unstable
- *Preconditions:* already on `/profile`.
- *Steps:* 1) Edit the display name → 2) Save → 3) Reload the page.
- *Expected result:* `PUT /api/me/profile` is currently **mocked** in `api-client.ts` (the BE is not stable yet) → the name change takes effect for the session through an overlay. **This must be stated explicitly during the demo.**
- *Presenter:* M5.

---

## A.3. Determining the number of test cases to commit to

### A.3.1. Formula

```
Total committed TC = TC(Mandatory Feature) + TC(E2E Main Workflow) + TC(state transitions) + TC(NFR)
```

### A.3.2. Mandatory Features (12) — at least 3 test cases each

| # | Mandatory Feature | Related workflow | Minimum TC | Notes |
|---|---|---|---|---|
| MF-01 | Google OAuth sign-in + token refresh | MW-01 | 3 | success, failure, expired token |
| MF-02 | 3-step onboarding & profile persistence | MW-01 | 3 | completed, skipped, abandoned midway |
| MF-03 | Client CRUD | MW-02 | 3 | create, update, delete |
| MF-04 | Project management (create/detail/progress) | MW-03 | 3 | create with client, deadline validation, filter |
| MF-05 | Milestone management + manual task/subtask decomposition | MW-03, MW-04 | 3 | task must have a milestone, subtasks, deletion |
| MF-06 | AI chat decompose + apply subtasks | MW-05 | 3 | success, AI error, double-apply prevention |
| MF-07 | RAG memory / K_bias display | MW-05 | 3 | with data, without data, figures match the BE |
| MF-08 | AI schedule proposal + slot approval | MW-06 | 3 | feasible, infeasible, slot failure |
| MF-09 | Week/Month/Gantt calendar + two-way Google Calendar sync | MW-07 | 3 | 3 views, connect, sync |
| MF-10 | Focus session (start/stop/timer/self-report/auto-timeout) | MW-08 | 3 | full lifecycle, 409, slot state transitions |
| MF-11 | Realtime notifications (SignalR / Web Push / inbox) | MW-09 | 3 | receive, connection loss, mark as read |
| MF-12 | PayOS billing + profile/invoices | MW-10 | 3 | successful payment, cancel/error, invoice view |

→ **36 test cases**.

### A.3.3. End-to-end tests for the Main Workflows (10)

| # | E2E test | Workflow | Scenario reused |
|---|---|---|---|
| E2E-01 | Sign in → onboarding → dashboard shows the real schedule | MW-01 | MS-01 |
| E2E-02 | Create client → create project attached to it → the project card appears | MW-02, MW-03 | MS-02, MS-03 |
| E2E-03 | Create milestone → task → 3 subtasks → "Whole task" split → 3 slots visible | MW-04 | MS-04 |
| E2E-04 | Copilot: load task → chat → apply subtasks → subtasks visible in Planning | MW-05 | MS-05 |
| E2E-05 | AI schedule proposal → approve a subset → `Approved` slots visible in the Week view | MW-06 | MS-06 |
| E2E-06 | Connect Google Calendar → Sync → the Google event appears in the calendar | MW-07 | MS-07 |
| E2E-07 | Start focus → runs across pages → Stop with Completed → slot `Done` → time-summary | MW-08 | MS-08 |
| E2E-08 | Receive a SignalR toast → open the inbox → mark as read → the badge returns to 0 | MW-09 | MS-09 |
| E2E-09 | Buy a plan → PayOS → success → the plan shows in the profile with an invoice | MW-10 | MS-10 |
| E2E-10 | End-to-end essence: manual task + AI task + AI slot → Focus → RAG updates K_bias | MW-04..MW-08 | MS-04→MS-05→MS-06→MS-08 |

→ **10 test cases**.

### A.3.4. Tests for the state transitions of the primary entities

| Entity | States | Valid transitions tested | Invalid transitions tested | TC |
|---|---|---|---|---|
| **ScheduleSlot** | Proposed, Approved, Due, InProgress, Overrun, Done, Missed, Skipped, Cancelled, Postponed | Proposed→Approved; Approved→Due; Due→InProgress; InProgress→Overrun; InProgress→Done; Approved→Done; Due→Missed; Approved→Skipped; Due→Cancelled; InProgress→Postponed | Proposed→InProgress (Start before approval); Done→InProgress; Cancelled→InProgress; Missed→Overrun | **14** |
| **Task** | ToDo, InProgress, Done, Skipped | ToDo→InProgress; InProgress→Done; ToDo→Skipped; Done→ToDo (reopen) | ToDo→Done without a focus session (blocked when the rule is on); Done→InProgress | **6** |
| **Subtask** | ToDo, InProgress, Done, Skipped | ToDo→InProgress; InProgress→Done; ToDo→Skipped | Done→InProgress | **4** |
| **Project** | Draft, Active, Pending, Completed | Draft→Active; Active→Completed; Completed→Active (restore) | Active→Draft; Completed→Draft | **5** |
| **Milestone** | Open, InProgress, Completed | Open→InProgress; InProgress→Completed; Completed→Open | Open→Completed without passing through InProgress | **4** |
| **Client** | Active, Deleted | Active→Deleted | Deleted→Active (deletion is a hard delete) | **3** |
| **FocusSession** | Running, Stopped, AutoTimeout, PendingConfirm | Running→Stopped (Completed); Running→Stopped (Interrupted); Running→AutoTimeout; AutoTimeout→PendingConfirm→Stopped | Stopped→Running (resume — unsupported, must be rejected); PendingConfirm→Running | **6** |
| **Payment** | Pending, Succeeded, Cancelled, Expired, Failed | Pending→Succeeded; Pending→Cancelled; Pending→Expired; Pending→Failed | Succeeded→Failed; Cancelled→Succeeded | **6** |
| **Notification** | Unread, Read | Unread→Read; Unread→Read (read-all) | Read→Unread | **4** |

→ **52 test cases**.

### A.3.5. Measurable NFR tests (8 NFRs)

| # | NFR | Measurement criterion | Method | TC |
|---|---|---|---|---|
| NFR-01 | Page load performance | LCP ≤ 2.5s, FCP ≤ 1.8s (mobile emulation) | Lighthouse CI in the pipeline | 1 |
| NFR-02 | Calendar API performance | p95 `GET /api/calendar` ≤ 500ms, p95 `POST /api/focus/start` ≤ 300ms | k6 / Artillery script against staging | 1 |
| NFR-03 | Focus clock accuracy | drift ≤ 1s after 30 minutes; unaffected by changing the system time | Playwright: change the system time → compare `elapsed` | 1 |
| NFR-04 | Accessibility | WCAG 2.1 AA: contrast ≥ 4.5:1, visible focus ring, keyboard navigation | automated axe-core + manual check | 1 |
| NFR-05 | Responsiveness | ≥ 3 breakpoints (375 / 768 / 1440) with no horizontal overflow or overlap | Playwright screenshots at 3 sizes | 1 |
| NFR-06 | Session security | refresh token cleared on logout; tokens never logged; automatic refresh on 401 | automated test asserting localStorage after logout + log audit | 1 |
| NFR-07 | Realtime reliability | after a 30s outage, reconnection within 10s and no focus session lost | Playwright `context.setOffline` | 1 |
| NFR-08 | Data isolation | another user's task/slot returns `404/403`; no data leaks through `details` | two-user cross-access test with foreign IDs | 1 |

→ **8 test cases**.

### A.3.6. Total committed test cases

| Group | Count |
|---|---|
| Mandatory Feature (12 × 3) | 36 |
| E2E Main Workflow | 10 |
| State transitions of the primary entities | 52 |
| Measurable NFR | 8 |
| **TOTAL COMMITTED** | **106** |

**Commitment: 106 test cases.**

### A.3.7. Automation ratio (≥ 50% in CI)

| Test layer | Tool | TC | Automated? |
|---|---|---|---|
| Unit — pure logic (focus-logic, schedule-proposal-logic, calendar dedupe, k_bias) | Vitest | 18 | ✅ |
| Component — forms/modals/slot panel | Vitest + Testing Library | 12 | ✅ |
| API contract — smoke tests against staging (auth, project, task, slot, focus) | Vitest + supertest/msw | 14 | ✅ |
| Integration — AI flow: propose → apply → schedule (mocked AI service) | Vitest + msw | 8 | ✅ |
| E2E — Playwright: 10 Main Scenarios | Playwright | 10 | ✅ |
| E2E — Playwright: 6 key exception scenarios (ES-01, ES-03, ES-05, ES-09, ES-12, ES-15) | Playwright | 6 | ✅ |
| **Automated in CI** | | **68** | **64.2%** ✅ |
| Manual — the 14 remaining exception scenarios + 8 manual NFR checks | | 38 | ❌ (manual) |
| **TOTAL** | | **106** | |

**Commitment: 68/106 = 64.2% of test cases run automatically in CI** (above the 50% threshold).

> ⚠ Current repository state: `package.json` has **no** `vitest`, `@playwright/test`, `msw`, `axe-core` or `k6`. These must be added — see A.5.

---

## A.4. Defense 1.1 acceptance criteria

| # | Proposed criterion (to be placed in **Appendix A of BM01**) | How it is measured | Current status |
|---|---|---|---|
| **T1** | 100% of Main Workflows run end-to-end on staging | 10/10 E2E pass | ☐ Not measured |
| **T2** | 100% of Main Scenarios pass | 10/10 | ☐ Not measured |
| **T3** | ≥ 80% of Exception Scenarios pass | ≥ 16/20 | ☐ Not measured |
| **T4** | Actual test case count ≥ the committed count | ≥ 106 | ☐ Not measured |
| **T5** | Pass rate ≥ 90% | ≥ 95/106 pass | ☐ Not measured |
| **T6** | 100% of the main-path tests for Mandatory Features pass | 36/36 pass | ☐ Not measured |
| **T7** | ≥ 50% of test cases automated and executed in CI | 68/106 = 64.2% | ☐ No CI yet |
| **T8** | No open Critical/High defects | 0 | ☐ Not measured |
| **T9** | Every member can demo the workflow they own | 5/5 members rehearse | ☐ Not measured |
| **T10** | Every owner can explain the code, the entity states and the exception handling | 1-1 review checklist | ☐ Not measured |
| **T11** | Every Main Workflow has a matching Activity Diagram in the SDD (MW-0x ↔ AD-0x) | 10/10 | ☐ `[TO DRAW]` |
| **T12** | The sample-data seed script is idempotent and re-runnable | `npm run seed:demo` | ☐ `[TO BUILD]` |

**Proposed adjustments / additions** (to be agreed with the instructor at Review 2):
1. **T4** — committing to **106 TC**; this number may be adjusted once the instructor confirms the official Mandatory Feature list. Proposal: fix MF = 12 as listed above.
2. **T7** — committing to **64.2%** (68/106); proposal: keep the threshold at ≥ 60% to retain a buffer.
3. **T3** — proposal: split "exceptions the system handles correctly" (must be 100%) from "environment-caused exceptions" (80% allowed).
4. **T8** — define the Critical/High levels explicitly: blocks a main flow / causes data loss / leaks data.

---

## A.5. Preparing and validating the demo

### A.5.1. Pre-demo checklist

| # | Item | Status |
|---|---|---|
| 1 | Staging `.env` complete: `VITE_API_URL`, `VITE_AI_API_URL`, `VITE_GOOGLE_CLIENT_ID` | ☐ |
| 2 | Staging BE + AI Service running, no 5xx errors | ☐ |
| 3 | Seed script runs successfully and produces the dataset in A.2.2 | ☐ `[TO BUILD]` |
| 4 | Demo Google account pre-signed-in (avoids the OAuth wall mid-presentation) | ☐ |
| 5 | PayOS test merchant working, ReturnUrl/CancelUrl pointing at staging | ☐ |
| 6 | Dry-run of the 10 Main Scenarios, results recorded | ☐ |
| 7 | Dry-run of the 20 Exception Scenarios, results recorded | ☐ |
| 8 | Actual result vs expected result compared (table A.5.3) | ☐ |
| 9 | Defects recorded: description, severity, owner, resolution status | ☐ |
| 10 | Every owner rehearses ≥ 2 times and can explain the code, the states and the exceptions | ☐ |
| 11 | CI run is green; test report and build link archived | ☐ `[TO BUILD]` |
| 12 | Contingency material ready if the network fails (video / screenshots of each step) | ☐ |

### A.5.2. Items to build before Defense

```
package.json (new scripts)
  "test": "vitest run"
  "test:watch": "vitest"
  "test:e2e": "playwright test"
  "test:coverage": "vitest run --coverage"
  "seed:demo": "tsx scripts/seed-demo.ts"
  "seed:history": "tsx scripts/seed-history.ts"
  "seed:reset": "tsx scripts/reset-demo.ts"

.github/workflows/ci.yml
  job test    : npm ci → npm run lint → npm run test:coverage → upload coverage
  job e2e     : npm ci → npx playwright install → npm run test:e2e → upload report
  job build   : npm ci → npm run build

tests/
  unit/        focus-logic, schedule-proposal-logic, calendar dedupe, k_bias
  component/   form modal, slot panel, focus bar
  contract/    staging API smoke (auth, project, task, slot, focus)
  integration/ AI propose → apply → schedule (mocked AI)
  e2e/         10 main scenarios + 6 exception scenarios (Playwright)

scripts/
  seed-demo.ts, seed-history.ts, reset-demo.ts, trigger-notification.ts
```

### A.5.3. Dry-run results log (template — fill in during the demo)

| # | Scenario | Presenter | Expected result | Actual result | Pass? | Defect (if any) | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| MS-01 | First-time Google sign-in | M1 | Land on `/dashboard` with a real schedule | | | | | |
| ES-01 | OAuth failure | M1 | Error shown, no crash | | | | | |
| … | … | … | … | | | | | |

*(All 30 rows — copy from A.2.3.)*

---

## A.6. Deliverables to hand in

| # | Deliverable | Location in this document | Status |
|---|---|---|---|
| 1 | Main Workflow list + owners | A.1.1, A.1.3 | ✅ done (fill in the real names M1..M5) |
| 2 | Matching Activity Diagrams in the SDD | A.1.2, A.1.4 | ☐ `[TO DRAW]` — the step lists are ready |
| 3 | Main + exception scenario list | A.2.3 (10 + 20) | ✅ done |
| 4 | Test case list + total committed count | A.3 (106 TC) | ✅ done |
| 5 | Automation ratio | A.3.7 (64.2%) | ✅ done (CI still to be installed) |
| 6 | Proposed Defense 1.1 criteria | A.4 (12 criteria) | ✅ done |
| 7 | Evidence of the dry run: demo results, test report, CI status | A.5.3 + CI artifacts | ☐ `[TO BUILD]` |
| 8 | Sample-data loading script in the repository | A.5.2 | ☐ `[TO BUILD]` |

---

# PART B — TECHNICAL REFERENCE (used while demoing)

## B.1. Architecture overview

METANOIA is made of **3 service tiers**:

| Tier | Environment variable | Responsibility |
|---|---|---|
| **Backend (BE)** | `VITE_API_URL` | Auth, projects, tasks, milestones, calendar, focus sessions, notifications, billing |
| **AI Service (Neural Engine)** | `VITE_AI_API_URL` | Task-decompose chat, RAG memory, time-slot proposals |
| **Google Calendar** | via the BE's OAuth flow | External events, two-way sync |
| **PayOS** | via the BE | Plan checkout |

Every request goes through a single API layer: `src/lib/api-client.ts`
- Automatically attaches `Authorization: Bearer <accessToken>`.
- On 401 → refresh (`POST /api/Auth/refresh`) → retry → on failure, log out and return to `/login`.
- Response contract: `{ ok: true, data }` or `{ ok: false, error, status, details }`.
- `details` is preserved separately — it is where the BE returns the **running session** when `POST /api/focus/start` answers 409.

Key points for the demo:
- The focus clock **always comes from the server** (`elapsedSeconds`), never from `Date.now()` — changing the system time does not move the clock (`src/hooks/useFocusSession.ts`).
- There is only **one** SignalR connection for the whole app (`NotificationsProvider` wraps the app in `App.tsx`).

## B.2. Route map

| Route | Layout | Guard | Page |
|---|---|---|---|
| `/` | — | public | Landing (`Landing.tsx`) |
| `/login`, `/register` | AuthLayout | `RedirectIfAuthenticated` | Sign in / register (Google OAuth) |
| `/pricing` | SiteLayout | public | Pricing + PayOS |
| `/payment/success`, `/payment/cancel` | SiteLayout | `ProtectedRoute` (**not** gated by onboarding) | Payment result |
| `/onboarding` | SiteLayout | `ProtectedRoute` | Personalisation survey (once) |
| `/dashboard` | SiteLayout | `ProtectedRoute` + onboarding | Today view |
| `/projects` | SiteLayout | " | Project portfolio |
| `/projects/:projectId` | SiteLayout | " | Project detail |
| `/projects/:projectId/planning` | SiteLayout | " | Manual decomposition |
| `/projects/:projectId/milestones` | SiteLayout | " | Milestone management |
| `/projects/:projectId/schedule` | SiteLayout | " | Project-scoped schedule |
| `/schedule` | SiteLayout | " | Week / Month / Gantt calendar |
| `/copilot` | SiteLayout | " | AI Schedule Coordinator |
| `/clients` | SiteLayout | " | Customer directory (master–detail) |
| `/profile` | SiteLayout | " | Profile + plan + invoices |
| `/notifications` | SiteLayout | " | Notification inbox |
| `/auth/google/callback` | SiteLayout | `ProtectedRoute` | Google Calendar OAuth callback |
| `*` | — | — | Fallback to Landing |

Guards:
- Not signed in → `/login` (remembering `state.from`).
- Signed in but **onboarding not completed** → `/onboarding` (localStorage key `metanoia:onboarding`, `src/pages/onboarding/storage.ts`).
- Exception: `/payment/*` is not gated by onboarding.

## B.3. Main API call chain (in demo order)

```
Auth      POST /api/Auth/google → GET /api/me
Setup     GET /api/clients → POST /api/clients → POST /api/projects
Project   GET /api/projects/filter → GET /api/projects/{id}/progress
Detail    GET /api/projects/{id} → .../milestones → .../tasks → GET /api/tasks/{id}/subtasks
Planning  POST .../milestones → .../tasks → .../subtasks → POST /api/tasks/{id}/schedule-slots
AI        GET /chat/tasks/{id} → GET /memory/similar → POST /chat/tasks/{id}/messages
          → POST /chat/tasks/{id}/apply → POST /schedule/propose → POST /api/tasks/{id}/schedule-slots
Schedule  GET /api/calendar → POST /api/google-calendar/sync
Focus     POST /api/focus/start → GET /api/focus/current → POST /api/focus/{id}/stop
          → GET /api/focus/{slotId}/time-summary → GET /api/focus/pending-confirmation
Notify    SignalR /hubs/notifications → GET /api/notifications
Billing   GET /api/subscription-plans → POST /api/payments/checkout → POST /api/payments/{id}/sync
          → GET /api/invoices
```

## B.4. Business rules & edge cases to state explicitly during the demo

| Item | Prepared explanation |
|---|---|
| `PUT /api/me/profile` | **Currently mocked** in the FE because the BE is not stable yet (`api-client.ts`) |
| Quick capture on the Dashboard | Only an in-memory scratch pad — the BE has no "inbox" API yet |
| The "AI decompose" button on the project card | Currently a simulated toast; the real AI flow lives in `/copilot` |
| The route `/projects/:id/execution` | Does not exist — the "AI auto-decompose" button in Project Detail calls `preventDefault` |
| Check-in after Stop | The BE has no API to store it → the FE only shows the dialog and discards it |
| The AI cannot find a slot | `is_feasible = false` + `missing_minutes` + specific warnings — **correct by design**, not a bug |
| 409 on Start | **Correct** behaviour: another session is already running in another tab |
| 409 on Stop | The session was already stopped → treated as **success** |
| `Proposed` slot | **No** Start button is rendered (the BE would return 400) — `focus-logic.ts` hides it deliberately |
| The clock never drifts | Intentional: the time origin comes from the server + `performance.now()` |
| 1 task = 1 `schedule/propose` request | Batching tasks makes one failure turn the whole group into `is_feasible=false` |
| One `proposal_id` per task | Sharing a single id makes the BE reject the request |

## B.5. Focus session states (from `FOCUS_SESSION_FE.md`)

| Slot status | Meaning | Rendered button |
|---|---|---|
| `Proposed` | Proposed by the AI or the user, not yet approved | **No** Start button |
| `Approved` | Approved, not yet due | "Bắt đầu sớm" (Start early) |
| `Due` | Due, waiting for the user to press Start | "Bắt đầu" (Start), prominent |
| `InProgress` | In progress | "Dừng" (Stop) |
| `Overrun` | Past the expected end but still running | "Dừng" (Stop), warning colour |
| `Done` | Finished | Hidden |
| `Missed` | The time passed without a Start | "Làm bù" (Make up) |
| `Skipped` / `Cancelled` / `Postponed` | Skipped / cancelled / postponed | Hidden or dimmed |

The system **never starts the timer by itself**: when a slot is due it only transitions to `Due` and sends a reminder. Real working time exists only after the user presses Start.

Stop reasons: `Completed` (→ slot `Done`) · `Interrupted` / `Blocked` / `Other` (→ slot back to `Due`).

## B.6. Maintaining this document

- `src/lib/api-client.ts` — the source of truth for **every endpoint**. API change → update A.3.3 and B.3.
- `src/hooks/useFocusSession.ts` — the source of truth for **every focus behaviour**. Change → update A.1.2 (MW-08) and B.5.
- `src/components/schedule-proposal-logic.ts` — the source of truth for **AI scheduling**. Change → update A.1.2 (MW-06).
- `src/components/focus/focus-logic.ts` — the source of truth for **button rendering per slot state**. Change → update B.5.
- `FOCUS_SESSION_FE.md` — the original BE-side spec; when it conflicts, **the BE spec wins**.

---

# 9. MAIN WORKFLOWS & DEMO SCENARIOS (BM01 §9 format)

## 9.1 Main workflow

A **main workflow** is a complete business flow, from the initial action of an actor to the final business outcome.
A workflow is valid when it involves **at least two actors** *or* passes through **at least three mandatory features**, and it changes the state of **at least one primary entity**.
The number of workflows is at least equal to the number of team members.
**Ownership:** each workflow has exactly one owner; every member owns at least one workflow.
**Traceability:** each workflow maps to one activity diagram in the SDD (MW-0x ↔ AD-0x).

| ID | Workflow | Actors | Business outcome | Mandatory features | Primary entity states | Owner |
|---|---|---|---|---|---|---|
| **WF-01** | Sign in and configure the work profile | End User, Google OAuth, Backend | The user is authenticated and the AI knows the user's role, domains and goals | F-01, F-02 | `User`: `Guest → Authenticated`; `Profile`: `Empty → Configured` | *M1* |
| **WF-02** | Manage the customer directory | End User (Project Manager), Backend | A complete customer directory, and customers can be attached to projects | F-03 | `Client`: `— → Active → Deleted` | *M2* |
| **WF-03** | Bootstrap a project and its phases | End User (Project Manager), Backend | A project with deadline, customer and phase structure ready to hold tasks | F-04, F-05 | `Project`: `Draft → Active`; `Milestone`: `— → Open` | *M2* |
| **WF-04** | Break a task down manually and split its time | End User (Project Manager), Backend, Scheduler | Tasks and subtasks with time estimates, converted into approved calendar slots | F-05 | `Task`: `— → ToDo`; `Subtask`: `— → ToDo`; `ScheduleSlot`: `— → Approved` | *M3* |
| **WF-05** | Break a task down with AI and apply the result | End User (Project Manager), AI Service, Backend | AI-proposed subtasks are reviewed by the user and stored as real subtasks | F-06, F-07 | `Subtask`: `— → ToDo` (AI-generated); `Task`: `ToDo → ToDo` (draft attached) | *M3* |
| **WF-06** | Propose a schedule with AI and approve the time slots | End User (Project Manager), AI Service, Backend | AI-generated slots are approved one by one and become `Approved` slots in the calendar | F-08 | `ScheduleSlot`: `— → Proposed → Approved` | *M4* |
| **WF-07** | Read the calendar and synchronise it with Google Calendar | End User, Google Calendar, Backend | One unified calendar containing both METANOIA slots and Google events | F-09 | `ScheduleSlot`: `Approved → Due`; `googleEventId`: `null → assigned` | *M4* |
| **WF-08** | Execute a focus session and record the real time spent | End User, Backend, Notification Service | Quantified real working time per task, which becomes K_bias training data | F-10 | `ScheduleSlot`: `Due → InProgress → Overrun → Done`; `FocusSession`: `— → Running → Stopped / AutoTimeout / PendingConfirm` | *M5* |
| **WF-09** | Receive reminders and manage the notification inbox | End User, Notification Service, Backend | Real-time toasts plus a persisted inbox with an unread badge | F-11 | `Notification`: `— → Unread → Read` | *M1* |
| **WF-10** | Upgrade the plan and pay through PayOS | End User (Free tier), PayOS, Backend | The subscription is upgraded and an invoice is issued | F-12 | `Payment`: `Pending → Succeeded`; `Subscription`: `— → Active` | *M5* |

**Validity check** — every workflow satisfies the "≥ 2 actors or ≥ 3 mandatory features" condition:

| Workflow | Actors (count) | Mandatory features (count) | Satisfied via |
|---|---|---|---|
| WF-01 | 3 | 2 | actors |
| WF-02 | 2 | 1 | actors |
| WF-03 | 2 | 2 | actors |
| WF-04 | 3 | 1 | actors |
| WF-05 | 3 | 2 | actors |
| WF-06 | 3 | 1 | actors |
| WF-07 | 3 | 1 | actors |
| WF-08 | 3 | 1 | actors |
| WF-09 | 3 | 1 | actors |
| WF-10 | 3 | 1 | actors |

**Traceability**: WF-01…WF-10 map one-to-one to the activity diagrams AD-01…AD-10 in the SDD (§4.1–§4.10); the step lists are given in §A.1.2 of this document.

---

## 9.2 Demo scenarios

Every main workflow has **at least one main scenario and one exception scenario** (invalid data, business-rule violation, insufficient permission, or an external service failing).
The demo runs on the **staging environment declared in Report 4** — it is never run on a personal machine.
Sample data is loaded by a **script kept in the repository**, so the demo is repeatable.
The jury may pick any scenario at random and change the input data; the expected results below hold for the equivalent data variation.

| ID | Workflow | Type | Preconditions & data | Main steps | Expected result |
|---|---|---|---|---|---|
| **DS-01a** | WF-01 | Main | Clean `localStorage`; a valid Google account; the staging BE and AI service are running | Open `/` → "Đăng nhập" → pick the Google account → pick a role + 2 domains + 2 goals → "Tiếp tục vào Không gian làm việc" | `POST /api/Auth/google` returns 200, the tokens are persisted, `metanoia:onboarding` is written, and the user lands on `/dashboard` with a timeline loaded from real API data |
| **DS-01b** | WF-01 | Exception | The staging BE returns `401` for `POST /api/Auth/google` (invalid or revoked Google token) | Click the Google button → pick an account → the BE rejects the token → click the Google button again | The message "Đăng nhập Google thất bại" is shown, no session is created and the app does not crash; the sign-in button stays usable. An expired `accessToken` triggers an automatic `POST /api/Auth/refresh` + retry |
| **DS-02a** | WF-02 | Main | The user is signed in and onboarding is complete; the customer "Minh Long Trading Co." does not exist yet | Open `/clients` → "New client" → enter name, email, phone and notes → save → select the customer → edit the email → delete another customer | `POST /api/clients` returns 201 and the customer appears in the list with its project count taken from `GET /api/projects`; the update is persisted; the deletion asks for confirmation and then removes the customer from the list |
| **DS-02b** | WF-02 | Exception | The customer "Minh Long Trading Co." is still attached to one project; the BE rejects deleting a referenced customer with `400/409` | Try to delete the customer → confirm in the modal | The BE error is surfaced with a clear message, no data is lost and no orphaned project is created; the customer remains in the directory and the list is reloaded |
| **DS-03a** | WF-03 | Main | The customer "Minh Long Trading Co." already exists | Open `/projects` → "New project" → enter name, start date, deadline and description → in the Customer field open the nested "New client" modal → create "Ha Anh Studio" → it is auto-selected → "Create project" → open `/projects/{id}/milestones` → create "Phase 1 — Design" | The new project card appears first in the grid with 0% progress, the newly created customer is attached, and `GET /api/projects/{id}/progress` returns the correct percentage; the milestone chip appears in the milestone list |
| **DS-03b** | WF-03 | Exception | The start date is later than the deadline (`20/10/2026` → `18/10/2026`) | Open "New project" → enter an inverted date range → click "Create project" | The client-side rule rejects the input: the submit is blocked with "deadline phải sau startDate" and `POST /api/projects` is never called. The same guard applies to tasks created in a project that has no milestone yet |
| **DS-04a** | WF-04 | Main | The project has the milestone "Phase 1 — Design" and 3 subtasks estimated at 60′ / 90′ / 30′ | Open `/projects/{id}/planning` → create the Flexible task "Design the customer dashboard" (est. 120′) → add the 3 subtasks → click 📅 → start 09:00, end 13:00 → choose "Whole task" → schedule → switch to the Week view | The toast "3 subtask đã được chia lịch" appears and three consecutive blocks are created at 09:00–10:00, 10:00–11:30 and 11:30–12:00 with the exact `estimatedMinutes` proportions, `status = Approved`, `isManualOverride = true`, tagged as the "Manual" source |
| **DS-04b** | WF-04 | Exception | The task type is set to `Fixed` but `fixedStart` / `fixedEnd` are left empty | Open "New task" → select `Fixed` → leave the time range empty → click Create | The form requires the full time range and blocks the submit, or the BE answers `400` and the message is shown; no slot is created. Once the range is valid, the BE auto-creates an `Approved` slot |
| **DS-05a** | WF-05 | Main | The AI service is running; the task "Build the payment API" has a complete description; ≥ 5 completed historical tasks exist in the same domain | Open `/copilot` → select the project → select the task → "Load" → click the ⚡ quick prompt → inspect the Draft Card → "Accept & apply subtasks" | `GET /chat/tasks/{id}` and `GET /memory/similar` return real data; the AI reads both title and description so it does not ask vague questions; the Draft Card shows "Your estimate → Adjusted" with the `K_bias` badge; after applying, the subtasks exist in `/planning` and a confirmation message is injected into the chat |
| **DS-05b** | WF-05 | Exception | The AI service answers `409` (another task is being processed) or `5xx` for `POST /chat/tasks/{id}/messages` | Send a chat message → observe the automatic retries → if it still fails, press send again | At most 2 automatic retries with a 1.5s → 3s backoff; if they are exhausted, a clear error is shown, the typed message is **not** lost and **no** subtasks are created. Double-clicking "Accept & apply" triggers exactly one API call thanks to `applyingRef` |
| **DS-06a** | WF-06 | Main | Two Flexible tasks have no slot yet and no fixed time ("Build the payment API", "Design the checkout page") | Click "Đề xuất lịch" → wait for the proposals → untick one slot → "Thêm vào lịch" → open `/schedule` on the Week view | Each task receives its **own** proposal request (one `proposal_id` per task); the ticked slots are committed with the matching `scheduleProposalId` and become `Approved`; the unticked slot is not created; the calendar refreshes |
| **DS-06b** | WF-06 | Exception | One task is overdue or needs more than 8 hours in a day, so the AI cannot fit it | Click "Đề xuất lịch" → observe the result | The proposal comes back with `is_feasible = false`, `missing_minutes` and specific warnings (`not_enough_time` / `overdue` / `no_free_slot` / `insufficient_time`); **no slot is created**. This is the correct designed behaviour, not a failure — the demo must present it as such |
| **DS-07a** | WF-07 | Main | A demo Google account with Calendar access; 1 Google event this week and 2 METANOIA slots | Open `/schedule` → sidebar "Google Calendar" → "Connect" → approve the OAuth consent → return to `/auth/google/callback?calendar=connected` → "Sync" → observe the Week view | `GET /api/google-calendar/status` reports connected; `POST /api/google-calendar/sync` returns `{added, updated, cancelled}` shown in the toast; Google events and METANOIA slots coexist in one calendar and are distinguishable by their source tag |
| **DS-07b** | WF-07 | Exception | The user denies the consent on the Google screen, or the stored token has been revoked in the Google Account | Click "Connect" → "Cancel"/"Deny" in Google → return to the app → then click "Sync" with the revoked token | The status stays "not connected" and a retry-oriented message is shown; the sync error is reported and the affected slots are flagged with `syncFailed` while the other slots are unaffected; the app never crashes |
| **DS-08a** | WF-08 | Main | An `Approved` slot exists today at 09:00–10:00 | Open `/schedule` → click the slot → "Bắt đầu" → navigate to `/dashboard` → go back → "Dừng" → pick "Đã xong" → confirm → answer the check-in → reopen the slot modal | `POST /api/focus/start` returns 201 and the global timer bar appears on every page; the clock is accurate and unaffected by changing the system time; `POST /api/focus/{id}/stop` returns 200 and the slot becomes `Done`; `GET /api/focus/{slotId}/time-summary` renders Planned / Actual / Session count |
| **DS-08b** | WF-08 | Exception | A session is already running in another tab; additionally a `Proposed` slot and a 3-minute slot exist | Open a second tab and press "Bắt đầu" on another slot → observe the toast → in the first tab press "Dừng" twice quickly → open the `Proposed` slot | The second tab receives `409`: the FE reads `details`, shows "Đang có phiên khác chạy" and switches to the running session instead of raising a red error; the duplicate Stop also answers `409` and is treated as success; the `Proposed` slot renders **no** Start button (the BE would answer `400`) |
| **DS-09a** | WF-09 | Main | The user is signed in, the app is open and SignalR is connected; a slot is about to become due | Let the BE push a `START_PROMPT` / `NEAR_END` event → observe the toast → open the bell → `/notifications` → filter "Chưa đọc" → "Đánh dấu đã đọc" | The toast shows the correct content; the unread badge updates; after every SignalR event the FE refetches `/api/focus/current` + `/api/focus/pending-confirmation` so the clock never goes stale; the inbox keeps a persistent history and the badge returns to 0 |
| **DS-09b** | WF-09 | Exception | The SignalR endpoint is unreachable, or Web Push is blocked because the staging domain is not https | Disconnect the network for 10s → restore it → then enable push notifications and block them in the browser | `withAutomaticReconnect()` re-establishes the connection automatically and the app stays usable through the fallback poll every 20s without losing the running session; the Web Push failure is explained clearly, the status remains "not enabled" and the SignalR channel keeps working |
| **DS-10a** | WF-10 | Main | The PayOS test merchant is configured with `ReturnUrl`/`CancelUrl` pointing at staging | Open `/pricing` → toggle monthly/yearly → "Mua gói này" → pay on the PayOS page → the app returns to `/payment/success` → wait → open `/profile` | `POST /api/payments/checkout` returns a `checkoutUrl` and the redirect happens; `POST /api/payments/{id}/sync` polls every 3s up to 10 times; on `Succeeded` the FE refetches `/api/me` + `/api/invoices` and the new plan plus its invoice are displayed |
| **DS-10b** | WF-10 | Exception | The user cancels the payment on the PayOS page, or PayOS answers `503` / `Failed` | Click "Mua gói này" → cancel on the PayOS page → then repeat with a failing PayOS response | `Cancelled` shows the matching message and a "create again" button; `Pending` and `503` keep showing "Đang xử lý" and are retried rather than reported as a failure; the FE never concludes "payment succeeded" from the URL alone — only the backend status decides |

### 9.2.1. Input data the jury may vary

The jury may pick any row above at random and change the input data. The expected results remain valid for the equivalent variation:

| Scenario | Input that may be varied | Expected behaviour of the system |
|---|---|---|
| DS-01a | A different role / domain / goal selection | The stored profile follows the selection; the dashboard renders the same way |
| DS-02a | A different customer name / email / phone | The customer is created and listed exactly as entered |
| DS-03a | A different project name, start date, deadline, or customer | The project card and the progress percentage follow the entered data |
| DS-04a | Different subtask estimates (e.g. 45′ / 45′ / 30′) | The three slots are split proportionally to the new estimates |
| DS-05a | A different task with a different description | The AI decomposes the new task; the K_bias badge follows the new draft |
| DS-06a | A different set of Flexible tasks | Each task still gets its own `proposal_id` and its own approval request |
| DS-07a | A different Google event | The sync counters (`added` / `updated` / `cancelled`) reflect the new event |
| DS-08a | A different slot start time / duration | The timer, the overrun warning and the time summary follow the new slot |
| DS-09a | A different notification action type | The toast content and the badge follow the pushed event |
| DS-10a | A different plan (monthly / yearly) | The checkout order and the resulting invoice follow the selected plan |

### 9.2.2. Staging and data preparation

| Item | Statement |
|---|---|
| Environment | Staging only — Backend, AI service, Google OAuth and PayOS test merchant are all declared in **Report 4**. The demo is never executed on a personal machine. |
| Data loading | A seed script in the repository (`scripts/seed-demo.ts`, `scripts/seed-history.ts`, `scripts/reset-demo.ts`) creates the clients, project, milestones, tasks, subtasks, slots and the completed-task history used by every scenario; it is idempotent so the demo can be repeated. |
| Reproducibility | `npm run seed:demo && npm run seed:history` resets the staging data to the exact state described in §A.2.2 before each rehearsal. |
| Contingency | If a staging service is down, the recorded demo video and the per-step screenshots are shown, together with the corresponding test report and CI status. |

---

# 10. TEST CASES

## 10.1 Test strategy

### 10.1.1. Test levels

| Level | Scope | Tooling | Runs in CI | Count |
|---|---|---|---|---|
| **Unit** | Pure logic: `focus-logic.ts`, `schedule-proposal-logic.ts`, calendar item dedupe, K_bias computation | Vitest | ✅ | 18 |
| **Component** | Forms, modals, slot panel, focus timer bar | Vitest + Testing Library | ✅ | 12 |
| **API contract** | Smoke tests against the staging Backend (auth, project, task, slot, focus) | Vitest + supertest/msw | ✅ | 14 |
| **Integration** | AI flow: propose → apply → schedule (mocked AI service) | Vitest + msw | ✅ | 8 |
| **E2E (main)** | The 10 Main Scenarios of §9.2 | Playwright | ✅ | 10 |
| **E2E (exception)** | 6 key exception scenarios (DS-01b, DS-03b, DS-05b, DS-06b, DS-08b, DS-10b) | Playwright | ✅ | 6 |
| **E2E (manual)** | The 14 remaining exception scenarios | Playwright / manual | ❌ | 14 |
| **NFR** | Performance, accuracy, accessibility, responsiveness, security, reliability | Lighthouse CI / k6 / axe-core / Playwright | partial | 8 |
| **TOTAL** | | | **68 automated (64.2%)** | **106** |

### 10.1.2. Numbering convention

| Prefix | Group | Count |
|---|---|---|
| `TC-MF-xx` | Mandatory Feature test cases (§10.2) | 36 |
| `TC-E2E-xx` | End-to-end tests of the Main Workflows (§10.3) | 10 |
| `TC-ST-xxx` | State-transition tests of the primary entities (§10.4) | 52 |
| `TC-NFR-xx` | Measurable NFR tests (§10.5) | 8 |

### 10.1.3. Entry / exit criteria

| Criterion | Definition |
|---|---|
| Entry | A build is deployed to staging and the seed data is loaded; the Backend and the AI service answer without 5xx errors. |
| Exit | ≥ 90% of all test cases pass (≥ 95/106); 100% of the main-path Mandatory Feature tests pass (36/36); 100% of the E2E Main Workflow tests pass (10/10); no open Critical/High defect. |
| Automation exit | ≥ 50% of the committed cases execute automatically in CI — committed **64.2%** (68/106). |

---

## 10.2 Mandatory Feature test cases (36)

| ID | Feature | Scenario / steps | Expected result | Type | Auto |
|---|---|---|---|---|---|
| **TC-MF-01** | F-01 Google OAuth | Sign in with a valid Google account; the BE returns 200 | `POST /api/Auth/google` returns 200; `accessToken` + `refreshToken` are written to localStorage; the user is redirected per `getPostLoginPath` | Main | ✅ |
| **TC-MF-02** | F-01 Google OAuth | The BE answers `401` for `POST /api/Auth/google` | The error "Đăng nhập Google thất bại" is displayed; no session is created; the app does not crash; the button stays usable | Exception | ✅ |
| **TC-MF-03** | F-01 Google OAuth | The `accessToken` has expired → the first request answers `401` | The FE automatically calls `POST /api/Auth/refresh`, stores the new tokens and retries the original request successfully | Exception | ✅ |
| **TC-MF-04** | F-02 Onboarding | Complete all 3 steps (role, 2 domains, 2 goals) | `metanoia:onboarding` is written to localStorage with the selected values; the user lands on `/dashboard` | Main | ✅ |
| **TC-MF-05** | F-02 Onboarding | Click "Bỏ qua bước này" (Skip) | A default profile is stored, onboarding is marked complete, and the user enters `/dashboard` without being re-prompted | Exception | ✅ |
| **TC-MF-06** | F-02 Onboarding | Abandon at step 2, reload the page | The user is returned to the onboarding flow and the previous selection is preserved or safely reset; the app does not enter the dashboard | Exception | ❌ |
| **TC-MF-07** | F-03 Client CRUD | Create a client with name, email, phone and notes | `POST /api/clients` returns 201; the client appears in the list and in the "Create project" customer dropdown | Main | ✅ |
| **TC-MF-08** | F-03 Client CRUD | Edit the email and phone of an existing client | `PUT /api/clients/{id}` returns 200; the new values are rendered immediately and survive a reload | Main | ✅ |
| **TC-MF-09** | F-03 Client CRUD | Delete a client that has no project | A confirmation modal is shown; after confirming, `DELETE /api/clients/{id}` returns 200 and the client disappears from the list | Main | ✅ |
| **TC-MF-10** | F-04 Project management | Create a project with name, start date, deadline, description and an existing customer | `POST /api/projects` returns 201; the card appears first in the grid with 0% progress and the customer name | Main | ✅ |
| **TC-MF-11** | F-04 Project management | Create a project with `deadline < startDate` | The submit is blocked with "deadline phải sau startDate"; `POST /api/projects` is never called | Exception | ✅ |
| **TC-MF-12** | F-04 Project management | Filter by status and by customer; open a project card | The filtered list matches the criteria; the detail page shows Hero, KPIs, timeline with the "Today" marker, milestone and task previews | Main | ❌ |
| **TC-MF-13** | F-05 Milestone & manual decomposition | Create a milestone with name, orderIndex ≥ 1 and dueDate | `POST /api/projects/{id}/milestones` returns 201; the milestone chip and its order are rendered | Main | ✅ |
| **TC-MF-14** | F-05 Milestone & manual decomposition | Create a task in a project that has no milestone | The submit is disabled and the "Create a milestone first" hint with the quick-create button is shown; no task is created | Exception | ✅ |
| **TC-MF-15** | F-05 Milestone & manual decomposition | Create a task with 3 subtasks and split the whole task into slots | The task and the 3 subtasks are stored; 3 proportional slots are created with `status = Approved` and `isManualOverride = true` | Main | ✅ |
| **TC-MF-16** | F-06 AI chat decompose | Send the ⚡ quick prompt for a task with a complete description | The AI returns a draft with subtasks, estimates, reasons and a K_bias badge; no vague clarifying question is asked because the FE sends `[Task]` and `[Description]` | Main | ✅ |
| **TC-MF-17** | F-06 AI chat decompose | The AI service answers `409` then `5xx` | At most 2 automatic retries with a 1.5s → 3s backoff; then a clear error is shown; the typed message is not lost; no subtask is created | Exception | ✅ |
| **TC-MF-18** | F-06 AI chat decompose | Double-click "Accept & apply subtasks" | `applyingRef` blocks the second call: exactly one `POST /chat/tasks/{task_id}/apply` is issued and the subtasks are created once | Exception | ✅ |
| **TC-MF-19** | F-07 RAG memory / K_bias | Open a task that has similar completed tasks in history | The RAG panel lists the similar tasks with estimated vs actual, ratio, similarity % and `search_mode`; the Avg K_bias is displayed | Main | ✅ |
| **TC-MF-20** | F-07 RAG memory / K_bias | Open a task with no similar task in history | The panel shows the empty state without errors and no bogus K_bias value is displayed | Exception | ❌ |
| **TC-MF-21** | F-07 RAG memory / K_bias | Compare the K_bias shown by the FE with the value returned by the API | The two values match exactly (same rounding); the badge reflects `adjusted_minutes / your_estimate_minutes` | Main | ✅ |
| **TC-MF-22** | F-08 AI schedule proposal | Propose a schedule for 2 eligible Flexible tasks | Each task receives its own `POST /schedule/propose` and its own `proposal_id`; the proposal panel shows the slots, the reasons and the warnings | Main | ✅ |
| **TC-MF-23** | F-08 AI schedule proposal | Approve a subset of the proposed slots | Only the ticked slots are committed with the matching `scheduleProposalId`; the unticked slots are not created; the success toast shows the correct count | Main | ✅ |
| **TC-MF-24** | F-08 AI schedule proposal | One task is infeasible (overdue / not enough time) | `is_feasible = false` with `missing_minutes` and specific warnings; no slot is created for that task; the other tasks are unaffected | Exception | ✅ |
| **TC-MF-25** | F-09 Calendar & Google sync | Switch between the Week, Month and Gantt views | Each view renders the same calendar data with the correct layout; the active view is highlighted and the date navigation works | Main | ❌ |
| **TC-MF-26** | F-09 Calendar & Google sync | Connect Google Calendar and approve the OAuth consent | The callback returns to `/auth/google/callback?calendar=connected`; `GET /api/google-calendar/status` reports connected; the sidebar shows the account | Main | ✅ |
| **TC-MF-27** | F-09 Calendar & Google sync | Run a sync with one new, one changed and one cancelled Google event | `POST /api/google-calendar/sync` returns `{added, updated, cancelled}`; the toast shows the counters and the calendar reflects the change; `googleEventId` is stored | Main | ✅ |
| **TC-MF-28** | F-10 Focus session | Start a slot, navigate to another page, then stop with "Đã xong" | The global timer bar stays visible across pages; `POST /api/focus/{id}/stop` returns 200; the slot becomes `Done`; the time summary shows planned / actual / session count | Main | ✅ |
| **TC-MF-29** | F-10 Focus session | Press Start while another session is already running | The BE answers 409; the FE reads `details` and switches to the running session with the toast "Đang có phiên khác chạy" — no red error, no crash | Exception | ✅ |
| **TC-MF-30** | F-10 Focus session | Self-report time already worked (forgot to press Start) | `POST /api/focus/self-report` validates `endedAt > startedAt`, no future timestamps and ≤ 24h; a valid report is recorded and shows in the time summary | Exception | ✅ |
| **TC-MF-31** | F-11 Notifications | The BE pushes a `START_PROMPT` over SignalR | The toast appears with the correct content; the FE refetches `/api/focus/current` and `/api/focus/pending-confirmation`; the unread badge increases | Main | ✅ |
| **TC-MF-32** | F-11 Notifications | The SignalR connection is lost for 10s and restored | `withAutomaticReconnect()` re-establishes the connection; the fallback poll keeps the clock running; the running session is not lost | Exception | ✅ |
| **TC-MF-33** | F-11 Notifications | Open `/notifications`, filter "Chưa đọc", mark one and then all as read | `POST /api/notifications/{id}/read` and `/read-all` succeed; the badge updates and the filter result changes accordingly | Main | ✅ |
| **TC-MF-34** | F-12 PayOS billing | Buy a monthly plan and complete the payment | `POST /api/payments/checkout` returns a `checkoutUrl`; after the redirect `POST /api/payments/{id}/sync` reports `Succeeded`; the new plan and its invoice are displayed | Main | ✅ |
| **TC-MF-35** | F-12 PayOS billing | Cancel the payment on the PayOS page | The status is `Cancelled`; the matching message and a "create again" button are shown; no subscription is activated; the FE never infers success from the URL | Exception | ✅ |
| **TC-MF-36** | F-12 PayOS billing | Open `/profile` and inspect the plan, the invoices and the subscription history | `GET /api/me`, `/api/invoices` and `/api/user-subscriptions` return real data and are rendered consistently | Main | ❌ |

---

## 10.3 End-to-end tests of the Main Workflows (10)

| ID | Workflow | Scenario | Steps | Expected result | Auto |
|---|---|---|---|---|---|
| **TC-E2E-01** | WF-01 | Sign in → onboarding → dashboard | Sign in with Google → complete onboarding → land on `/dashboard` | The dashboard shows the timeline, the 4 metrics, the deadline radar and the mini calendar, all from real API data | ✅ |
| **TC-E2E-02** | WF-02 / WF-03 | Customer → project | Create a client → create a project attached to it | Both records exist; the project card shows the customer and 0% progress | ✅ |
| **TC-E2E-03** | WF-04 | Milestone → task → subtasks → manual split | Create the milestone, the task and the 3 subtasks → split "Whole task" → open the Week view | 3 slots appear at the expected times with the Manual source tag and `status = Approved` | ✅ |
| **TC-E2E-04** | WF-05 | Copilot: load → chat → apply | Load the task → send the quick prompt → apply the subtasks | The subtasks exist in `/planning` and the chat stream contains the confirmation message | ✅ |
| **TC-E2E-05** | WF-06 | AI proposal → partial approval | Propose → untick one slot → approve → open the Week view | Only the ticked slots are created, with `status = Approved` and the correct `scheduleProposalId` | ✅ |
| **TC-E2E-06** | WF-07 | Google Calendar connect → sync | Connect → sync → inspect the Week view | The Google event appears next to the METANOIA slots with the correct source tag | ✅ |
| **TC-E2E-07** | WF-08 | Focus: start → cross pages → stop | Start → navigate to `/dashboard` → stop with "Đã xong" → answer the check-in | The timer survives navigation; the slot becomes `Done`; the time summary shows the real minutes | ✅ |
| **TC-E2E-08** | WF-09 | Realtime toast → inbox | Receive a SignalR event → open the inbox → mark as read | The toast appears, the inbox lists the event and the badge returns to 0 | ✅ |
| **TC-E2E-09** | WF-10 | Buy a plan → PayOS → invoice | Buy → pay → wait for the sync → open `/profile` | The plan is upgraded and the invoice is listed | ❌ (requires the PayOS sandbox) |
| **TC-E2E-10** | WF-04→WF-08 | Full cycle: manual + AI task + AI slot → focus → RAG | Create a task manually, decompose another with AI, schedule both with AI, run a focus session on one | The session time is stored and the next `/memory/similar` call reflects the new actual time in the K_bias ratio | ❌ (needs a long session) |

---

## 10.4 State-transition tests of the primary entities (52)

### 10.4.1. ScheduleSlot (14)

| ID | Transition | Preconditions | Steps | Expected result |
|---|---|---|---|---|
| **TC-ST-001** | `Proposed → Approved` | A slot proposed by the AI exists | Approve the slot in the proposal panel | `POST /api/tasks/{taskId}/schedule-slots` with `status = Approved` succeeds; the slot becomes startable |
| **TC-ST-002** | `Approved → Due` | An `Approved` slot whose start time has passed | Wait for the scheduler tick / reload the calendar | The slot status becomes `Due` and the Start button becomes prominent |
| **TC-ST-003** | `Due → InProgress` | A `Due` slot | Press "Bắt đầu" | `POST /api/focus/start` returns 201; the slot becomes `InProgress`; the timer bar appears |
| **TC-ST-004** | `InProgress → Overrun` | A session running past `expectedEndAt` | Keep the session running | The slot becomes `Overrun`; the timer switches to the warning style; the Stop button is still available |
| **TC-ST-005** | `InProgress → Done` | A running session | Stop with "Đã xong" | The slot becomes `Done`; the Stop button is replaced by a hidden/disabled state; the time summary shows 1 session |
| **TC-ST-006** | `Approved → Done` | An `Approved` slot starting in < 2h | Start early, work, stop with "Đã xong" | The slot passes through `InProgress` and ends in `Done`; only a light "started early" toast is shown |
| **TC-ST-007** | `Due → Missed` | A `Due` slot whose end time passes without a Start | Wait past the slot end | The slot becomes `Missed` and offers the "Làm bù" (make up) action |
| **TC-ST-008** | `Approved → Skipped` | An `Approved` slot | Skip the slot from the slot panel | The slot becomes `Skipped`; the Start button is hidden or dimmed |
| **TC-ST-009** | `Due → Cancelled` | A `Due` slot | Cancel the slot with a confirmation | The slot becomes `Cancelled`; the Start button is removed |
| **TC-ST-010** | `InProgress → Postponed` | A running session | Postpone the slot from the slot panel | The slot becomes `Postponed`; the running session is closed consistently |
| **TC-ST-011** | `Proposed → InProgress` **(invalid)** | A `Proposed` slot | Try to press Start (UI hidden) and, if forced, call `POST /api/focus/start` directly | The BE answers 400; the FE shows the message and creates **no** session; the slot stays `Proposed` |
| **TC-ST-012** | `Done → InProgress` **(invalid)** | A `Done` slot | Try to press Start (UI hidden) and force the API call | The BE answers 400; no session is created; the slot stays `Done` |
| **TC-ST-013** | `Cancelled → InProgress` **(invalid)** | A `Cancelled` slot | Force `POST /api/focus/start` | The BE answers 400; no session is created; the slot stays `Cancelled` |
| **TC-ST-014** | `Missed → Overrun` **(invalid)** | A `Missed` slot | Force a start + overrun on a missed slot without a session | The transition is rejected; the slot does not reach `Overrun` without an active session |

### 10.4.2. Task (6)

| ID | Transition | Steps | Expected result |
|---|---|---|---|
| **TC-ST-015** | `ToDo → InProgress` | Mark the task as in progress in Planning | `PUT /api/tasks/{taskId}` persists the status; the card shows the InProgress styling |
| **TC-ST-016** | `InProgress → Done` | Mark the task as done | The status is persisted; the card renders the done styling; the backend is notified so the AI can learn from the real time |
| **TC-ST-017** | `ToDo → Skipped` | Skip the task | The status is persisted and the task is excluded from the "active" filters |
| **TC-ST-018** | `Done → ToDo` (reopen) | Reopen a completed task | The status returns to `ToDo`; the done styling is removed |
| **TC-ST-019** | `ToDo → Done` without a focus session **(invalid)** | Mark a task done while the "must record real time" rule is enabled | The change is blocked or flagged; the AI is not fed a fabricated completion |
| **TC-ST-020** | `Done → InProgress` **(invalid)** | Try to move a completed task back to in progress | The transition is rejected; the task stays `Done` |

### 10.4.3. Subtask (4)

| ID | Transition | Steps | Expected result |
|---|---|---|---|
| **TC-ST-021** | `ToDo → InProgress` | Toggle the subtask checkbox to in progress | The status is persisted and the checklist icon updates |
| **TC-ST-022** | `InProgress → Done` | Complete the subtask | The status is persisted; the parent task progress recalculates |
| **TC-ST-023** | `ToDo → Skipped` | Skip the subtask | The status is persisted; the subtask is dimmed |
| **TC-ST-024** | `Done → InProgress` **(invalid)** | Try to un-complete a done subtask directly to in progress | The transition is rejected; only `Done → ToDo` is accepted |

### 10.4.4. Project (5)

| ID | Transition | Steps | Expected result |
|---|---|---|---|
| **TC-ST-025** | `Draft → Active` | Create the project with a valid date range and customer | The project becomes `Active` and is counted in the "Active projects" KPI |
| **TC-ST-026** | `Active → Completed` | Mark the project completed | The status is persisted; the card moves to the Completed filter; the portfolio average progress is updated |
| **TC-ST-027** | `Completed → Active` (restore) | Restore an archived project | The project returns to `Active` and reappears in the default filter |
| **TC-ST-028** | `Active → Draft` **(invalid)** | Try to move an active project back to draft | The transition is rejected; the BE accepts only the documented transitions |
| **TC-ST-029** | `Completed → Draft` **(invalid)** | Try to move a completed project to draft | The transition is rejected; the project stays `Completed` |

### 10.4.5. Milestone (4)

| ID | Transition | Steps | Expected result |
|---|---|---|---|
| **TC-ST-030** | `— → Open` | Create a milestone with orderIndex ≥ 1 and a dueDate | The milestone chip appears in Planning and in the project detail preview |
| **TC-ST-031** | `Open → InProgress` | Move the milestone to in progress | The status is persisted and the phase colouring changes |
| **TC-ST-032** | `InProgress → Completed` | Complete the milestone | The status is persisted; the milestone shows as completed in the project timeline |
| **TC-ST-033** | `Open → Completed` **(invalid)** | Try to complete a milestone that never entered in progress | The transition is rejected; the milestone stays `Open` |

### 10.4.6. Client (3)

| ID | Transition | Steps | Expected result |
|---|---|---|---|
| **TC-ST-034** | `— → Active` | Create a customer with valid data | The customer is created and listed; it can be attached to a project |
| **TC-ST-035** | `Active → Deleted` | Delete the customer and confirm | The customer is removed from the list and from the project customer dropdown |
| **TC-ST-036** | `Deleted → Active` **(invalid)** | Try to restore a deleted customer | Not supported (hard delete): the restore is rejected and the customer stays deleted |

### 10.4.7. FocusSession (6)

| ID | Transition | Steps | Expected result |
|---|---|---|---|
| **TC-ST-037** | `— → Running` | Press Start on a `Due` slot | `POST /api/focus/start` returns 201 with `captureMethod = "Timer"`; the session is running with a server-authoritative clock |
| **TC-ST-038** | `Running → Stopped` (Completed) | Stop with "Đã xong" | `sessionMinutes` and `taskTotalMinutes` are returned; the slot becomes `Done` |
| **TC-ST-039** | `Running → Stopped` (Interrupted) | Stop with "Bị gián đoạn" | The slot returns to `Due` so the Start button is offered again |
| **TC-ST-040** | `Running → AutoTimeout` | Let a short slot run past the auto-timeout threshold | The BE stops the session automatically; it is listed in `GET /api/focus/pending-confirmation` |
| **TC-ST-041** | `AutoTimeout → PendingConfirm → Stopped` | Confirm the pending session with corrected minutes | `POST /api/focus/{sessionId}/confirm` succeeds; the corrected minutes are used and the session becomes `Stopped` |
| **TC-ST-042** | `Stopped → Running` (resume) **(invalid)** | Try to resume a stopped session | Not supported: the FE starts a **new** session instead; the old session stays immutable |

### 10.4.8. Payment (6)

| ID | Transition | Steps | Expected result |
|---|---|---|---|
| **TC-ST-043** | `Pending → Succeeded` | Complete the payment on the PayOS page | `POST /api/payments/{id}/sync` returns `Succeeded`; the subscription becomes active; the invoice is listed |
| **TC-ST-044** | `Pending → Cancelled` | Cancel on the PayOS page | The status is `Cancelled`; a "create again" button is offered; no subscription is activated |
| **TC-ST-045** | `Pending → Expired` | Let the checkout expire | The status is `Expired`; the FE reports it and offers to restart the payment |
| **TC-ST-046** | `Pending → Failed` | The gateway declines the payment | The status is `Failed`; the matching message is shown; the app stays usable |
| **TC-ST-047** | `Succeeded → Failed` **(invalid)** | A webhook attempts to downgrade a successful payment | The transition is rejected; the payment stays `Succeeded` and the subscription is unaffected |
| **TC-ST-048** | `Cancelled → Succeeded` **(invalid)** | A late webhook attempts to complete a cancelled payment | The transition is rejected; the payment stays `Cancelled` and no subscription is granted |

### 10.4.9. Notification (4)

| ID | Transition | Steps | Expected result |
|---|---|---|---|
| **TC-ST-049** | `— → Unread` | The BE pushes an event over SignalR | The notification is stored and the unread badge increases |
| **TC-ST-050** | `Unread → Read` (single) | Mark one notification as read | `POST /api/notifications/{id}/read` succeeds; the badge decreases by one |
| **TC-ST-051** | `Unread → Read` (read all) | Click "mark all as read" | `POST /api/notifications/read-all` succeeds; the badge drops to 0 |
| **TC-ST-052** | `Read → Unread` **(invalid)** | Try to mark a read notification as unread again | Not supported by the BE contract; the notification stays `Read` |

---

## 10.5 Measurable NFR test cases (8)

| ID | NFR | Measurement | Pass criterion | Method | Auto |
|---|---|---|---|---|---|
| **TC-NFR-01** | NFR-01 Page performance | Lighthouse CI on the main routes (`/dashboard`, `/projects`, `/schedule`, `/copilot`) under mobile emulation | LCP ≤ 2.5s and FCP ≤ 1.8s on every route | Lighthouse CI in the pipeline | ✅ |
| **TC-NFR-02** | NFR-02 API performance | Load test against staging: `GET /api/calendar` and `POST /api/focus/start` | p95 ≤ 500ms for the calendar and ≤ 300ms for the focus start, with no 5xx above 0.1% | k6 / Artillery script | ✅ |
| **TC-NFR-03** | NFR-03 Focus clock accuracy | Run a session for 30 minutes, then change the system time by ±2h and compare the displayed elapsed value | Drift ≤ 1s after 30 minutes; the clock does **not** react to the system time change | Playwright + `performance.now()` comparison | ✅ |
| **TC-NFR-04** | NFR-04 Accessibility | Automated axe-core scan on the 10 main routes + manual keyboard navigation and focus-ring check | No critical axe violation; contrast ≥ 4.5:1; every interactive element reachable by keyboard | axe-core + manual review | ✅ |
| **TC-NFR-05** | NFR-05 Responsiveness | Screenshots at 375 / 768 / 1440 px on `/dashboard`, `/schedule`, `/copilot`, `/projects` | No horizontal overflow, no overlapping elements, no clipped text at any breakpoint | Playwright visual check | ✅ |
| **TC-NFR-06** | NFR-06 Session security | Log out, then inspect localStorage and the network log | The access and refresh tokens are removed; no token appears in any console/network log; a 401 triggers exactly one refresh attempt | Playwright + log audit | ✅ |
| **TC-NFR-07** | NFR-07 Realtime reliability | Take the browser offline for 30s during a running session, then restore it | The SignalR connection is re-established within 10s; the focus session and its elapsed time are preserved | Playwright `context.setOffline` | ✅ |
| **TC-NFR-08** | NFR-08 Data isolation | User B requests User A's project, task and slot by ID | Every request returns 404/403; no data of user A leaks through the error `details` field | Two-user cross-access test | ✅ |

---

## 10.6 Test coverage summary

| Group | Committed | Automated | Manual | Pass rate target |
|---|---|---|---|---|
| Mandatory Feature (§10.2) | 36 | 27 | 9 | 100% on the main path |
| E2E Main Workflow (§10.3) | 10 | 8 | 2 | 100% |
| State transitions (§10.4) | 52 | 25 | 27 | ≥ 90%, 100% on the valid transitions |
| NFR (§10.5) | 8 | 8 | 0 | 100% on the measurable thresholds |
| **TOTAL** | **106** | **68 (64.2%)** | **38** | **≥ 90% overall (≥ 95/106)** |

**Commitments carried into Appendix A of BM01:**
- 106 committed test cases; the executed count must be **≥ 106**.
- ≥ 50% automated in CI — committed **64.2%** (68/106).
- 100% of the main-path Mandatory Feature tests must pass (36/36).
- 100% of the E2E Main Workflow tests must pass (10/10).
- ≥ 90% overall pass rate (≥ 95/106).
- 0 open Critical/High defects.
