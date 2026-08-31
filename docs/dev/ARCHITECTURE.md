# Architecture

How the pieces fit, what each one is responsible for, and — at the end — the limits that are known
and not yet addressed.

---

## The shape

```
                      ┌──────────────────────────────────────────┐
   browser            │  apps/web  (Nuxt)                        │
                      │                                          │
                      │  pages ──► @raci/core  (read: selectors) │
                      │        └─► @raci/crdt  (write: mutations)│
                      │                    │                     │
                      │              Y.Doc  │  websocket          │
                      └────────────────────┼─────────────────────┘
                                           │
                      ┌────────────────────┼─────────────────────┐
   server (Nitro)     │  /api/collab       ▼                     │
                      │   ├─ y-protocols/sync                    │
                      │   ├─ @raci/crdt   repair on merge        │
                      │   └─ @raci/db     append + compact       │
                      │                                          │
                      │  /api/auth/*    @raci/auth  (OIDC)       │
                      │  /api/workspaces  @raci/db (projection)  │
                      │  directory sync   @raci/directory        │
                      └────────────────────┬─────────────────────┘
                                           │
                              ┌────────────▼────────────┐
                              │  Postgres               │
                              │   doc_update  (log)     │
                              │   doc_snapshot          │
                              │   workspace_index       │
                              │   users / sessions /    │
                              │   audit / sync history  │
                              └─────────────────────────┘

     external:  Keycloak or EntraID (OIDC)  ·  Active Directory or Graph (org chart)
```

---

## Packages, and what each one owes you

### `@raci/core` — the domain

Everything the system knows about RACI, as pure data and pure functions. **No framework, no DOM, no
I/O.** If something needs a browser, a server or a database, it does not belong here.

| Module | Responsibility |
|---|---|
| `constants.ts` | The shared vocabulary — actors, columns, tiers, frameworks. Lifted verbatim from `index.html` because the exact key strings are baked into every saved file in the wild. |
| `schema.ts` | Zod schemas for everything. Not just types: every one of these crosses a trust boundary (a file someone emailed, a row from Postgres, a value another client wrote into the CRDT). |
| `fractional.ts` | Ordering keys. See [ADR-0001](adr/0001-flat-tree-fractional-order.md). |
| `tree.ts` | Navigation and moves over the flat node map, plus cycle/orphan detection and the deterministic repair plan. |
| `raci.ts` | The cascade and the rule engine. The genuinely hard logic, and the part most worth having under test. |
| `legacy.ts` | v0.39 JSON ↔ the flat model, both directions. The contract the whole migration rests on. |

**The invariant:** anything a reviewer would call "a rule about RACI" lives here, so there is exactly
one implementation of it and the app cannot drift from the exporter.

### `@raci/crdt` — the collaborative document

Wraps Yjs so nothing else touches a `Y.Map`.

- `doc.ts` — the document layout, and why each collection is shaped the way it is.
- `mutations.ts` — **every legal write.** One transaction each, one origin tag each. This is the list
  a permission check and an audit trail can both be written against.
- `repair.ts` — restores the tree invariants a merge can break.
- `undo.ts` — undo scoped to one person's edits.

### `@raci/directory` — where the org chart comes from

One port, three adapters (LDAP/AD, Microsoft Graph, CSV). The reconciliation in `reconcile.ts` is the
important part: it matches incoming units to existing ones by `externalId` and **keeps the local
id**, because every RACI assignment in the workspace points at those ids.

The sync writes the **roster** and nothing else. The directory owns structure; this tool owns
responsibility. Keeping that line sharp is what makes re-syncing safe.

### `@raci/db` — persistence

The update log, snapshots, the derived projection, and the ordinary relational data that has no
business being in a CRDT: users, memberships, sessions, the audit trail, directory sync history.

**Multi-tenancy is enforced in `repositories.ts` and nowhere else.** Postgres RLS would be stronger,
but it needs a per-request database role and this runs one pooled connection — so the org filter is a
convention, and a convention belongs in one reviewable file rather than scattered across route
handlers where an omission is invisible.

### `@raci/auth` — identity

Discovery-driven OIDC. Keycloak and EntraID are the same code with a different issuer URL.

`verify.ts` is **the security boundary of the application**. Read the note at the top of it before
changing anything in there.

---

## Request paths worth knowing

**Signing in.** `/api/auth/login` mints a PKCE verifier, nonce and state, writes them to
`auth_request`, and redirects to the IdP. The callback consumes that row (a returning `DELETE`, so
state is single-use atomically), exchanges the code, verifies the ID token, upserts the user on
`(issuer, subject)`, maps IdP groups to a role, and sets a session cookie whose **hash** is what the
database stores.

**Editing.** The page calls a mutation from `@raci/crdt`. That produces a Yjs update, which the
composable sends over the websocket. The server applies it to the shared document, broadcasts it to
the other clients, and appends it to `doc_update`. Every so often, compaction folds the log into a
snapshot.

**Listing.** Straight out of `workspace_index`. No CRDT is loaded — otherwise the gallery would be
the most expensive screen in the app.

**Directory sync.** Adapter reads a snapshot → `reconcile()` produces a roster plus a change list →
the roster is written into the CRDT as one transaction (through `setRoster`, so it lands as flat
per-unit records rather than nested arrays) → the run and its changes go to
`directory_sync_run`. Units that vanished are **reported, not deleted**.

---

## Known limits

These are real, and none of them is half-built. A half-built version of any of them would look like
it worked right up until it did not.

### Collaboration does not scale past one process

Each app instance holds its own in-memory `Y.Doc` per workspace. Two instances behind a load
balancer would each accept edits and diverge — clients on instance A would never see instance B's
work.

**Fixes, in increasing order of effort:** route by workspace id with a sticky hash (an hour of nginx
config, and it caps a workspace at one instance); or put a Redis pub/sub bus between the instances
(the standard y-websocket approach); or move to a dedicated collaboration service.

**Until then, run one instance.** It is stated here rather than guessed at in production.

### The directory sync has no delta support

Every run reads the whole directory. AD's DirSync and Graph's delta queries both exist and both
would be faster. A full snapshot plus reconciliation is *correct* on its own, and correctness came
first for something whose failure mode is silently orphaning every assignment in the workspace. An
adapter can add `fetchDelta` behind the same reconciliation later.

### No ad-hoc SQL over chart contents

See [ADR-0004](adr/0004-crdt-update-log-storage.md). "Every row where Cyber is Accountable" needs
either the projection extended or the document loaded. This will be felt when reporting requirements
arrive.

### The permission model is three coarse roles

`viewer` / `editor` / `admin`, workspace-wide. No per-chart or per-row grants. The legacy app has no
permission model at all, so this is a large step already; finer grants can be added as a separate
table without disturbing this one.

### Attachment bytes have no object-storage backend yet

`document_blob` can hold bytes inline or name a `storage_key`. Only the inline path is implemented.
Fine for a self-contained deployment, wrong for one with a lot of large attachments.

### The Nuxt app has four screens, not the whole product

Auth, collaboration, a flat chart table, the Roster, the Tasks lens and the Object Gallery. Still
only in `index.html`: the cascade layout and drilling, the flow canvas, four of the six export
formats, the Excel importer, the themes and the field guides. See [PORTING.md](PORTING.md).

`index.html` stays the shipping product until that list is empty, and both apps read and write the
same v0.39 JSON — enforced by `core/legacy.test.ts` against the real demo workspace.

---

## Testing

| Where | What it proves |
|---|---|
| `core/legacy.test.ts` | The round trip against the **real** 810-row demo workspace, dumped out of the running legacy app. A hand-written fixture would only prove the converter agrees with itself. |
| `core/fractional.test.ts` | You can always insert again — 500 successive bisections at one point. |
| `crdt/convergence.test.ts` | A two-client harness with the wire under the test's control, so "concurrent" means both sides really did apply before either saw the other. |
| `crdt/roster.test.ts` | The nested roster survives a flatten/nest round trip byte for byte against the real 694-unit demo, and two people editing one directorate no longer clobber each other. |
| `db/doc-store.test.ts` | Real Postgres in process (PGlite/WASM) — the actual migration, the actual SQL. Exercises bytea round-tripping, composite-key upserts and tenant isolation. |
| `auth/verify.test.ts` | Mints real tokens with real keys, then attacks them: `alg:none`, HMAC confusion, wrong key, wrong audience, replayed nonce, tampered payload. |

The negative tests are the point. A verifier that accepts a valid token is easy.
