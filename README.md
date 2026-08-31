# ASIC RACI Tool

Nested RACI charts, business-case task flows, and the object registry both point at.

This repository holds **two applications**, on purpose:

| | | |
|---|---|---|
| **`index.html`** | The product today | One self-contained file. No build, no server, no install — open it and it works. Still shipping, still the thing users have. |
| **`apps/web`** | The product being built | Nuxt, Postgres, OIDC, realtime collaboration, directory sync. Being brought up to parity with the file above. |

They read and write **the same file format**, so anyone can move between them at any point. That is
the whole migration strategy, and it is enforced by a test — see
[ADR-0002](docs/dev/adr/0002-strangler-migration.md).

---

## Getting started

```bash
# Prerequisites: Node 22+, pnpm 9+, Docker (for the dev stack)

pnpm install
cp .env.example .env          # every default works against the dev stack
pnpm stack:up                 # Postgres + Keycloak + an OpenLDAP standing in for AD
pnpm db:migrate
pnpm dev                      # http://localhost:3000
```

`pnpm stack:up` seeds a Keycloak realm, so you can complete a login on a fresh clone without
provisioning an identity provider first. Two users are created:

| Username | Password | Role |
|---|---|---|
| `admin.user` | `password` | admin |
| `editor.user` | `password` | editor |

To work on the **legacy app**, open `index.html` in a browser. There is nothing to build or serve.

### Commands

```bash
pnpm verify        # lint + typecheck + test — what CI runs
pnpm test          # all packages
pnpm test:watch
pnpm build         # build the packages
pnpm dev           # the Nuxt app
pnpm db:generate   # generate a migration after changing packages/db/src/schema.ts
pnpm db:migrate
pnpm db:studio     # browse the database
pnpm stack:down
```

---

## Layout

```
index.html                 the legacy app — still the product
docs/                      user-facing field guides (served from the app's Help view)
docs/dev/                  developer documentation — start with ARCHITECTURE.md
ops/                       dev-stack fixtures: Keycloak realm, LDAP seed, sample CSV

packages/
  core/                    the domain. No framework, no DOM, no I/O. Everything derives from it.
  crdt/                    the workspace as a Yjs document: layout, mutations, merge repair
  directory/              AD / EntraID / CSV ingest, and the reconciliation that keeps ids stable
  db/                      Postgres: the update log, snapshots, users, sessions, audit
  auth/                    OpenID Connect, provider-agnostic

apps/
  web/                     the Nuxt application
```

**The dependency rule:** `core` depends on nothing. Everything else depends on `core`. Nothing
depends on `apps/web`. If you find yourself wanting to import from the app into a package, the
logic belongs in a package.

---

## Where to start reading

1. **[docs/dev/ARCHITECTURE.md](docs/dev/ARCHITECTURE.md)** — how it fits together, and the known
   limits.
2. **[docs/dev/adr/](docs/dev/adr/)** — the four decisions that shaped everything else, and what
   each one cost.
3. **[docs/dev/PORTING.md](docs/dev/PORTING.md)** — what is left to bring across from `index.html`,
   sliced so several people can work in parallel.
4. **[docs/dev/CONTRIBUTING.md](docs/dev/CONTRIBUTING.md)** — conventions, and the three rules that
   are not negotiable.

If you are here to fix something in the app users have today, you want `index.html` and nothing
else in this list.

---

## The three things most likely to surprise you

**A chart's rows are stored flat, not nested.** `index.html` nests them (`children[]`); the new
model keys every row by id with a `parentId` and an ordering string. That is forced by realtime
collaboration — see [ADR-0001](docs/dev/adr/0001-flat-tree-fractional-order.md). `packages/core/src/legacy.ts`
converts between the two shapes in both directions, and is tested against the real 810-row demo
workspace.

**The database does not have a `chart` table.** A workspace is stored as an append-only log of Yjs
updates, with periodic snapshots. Listing and searching go through a derived projection
(`workspace_index`) that can be rebuilt from the log at any time. See
[ADR-0004](docs/dev/adr/0004-crdt-update-log-storage.md).

**A CRDT converges; it does not keep your data meaningful.** Two people can each make a legal move
that merges into a parent cycle. `packages/crdt/src/repair.ts` detects and repairs that
deterministically, so every client fixes it the same way with no extra round trip. Nothing is ever
deleted by the repair.

---

## Status

| Workstream | State |
|---|---|
| Domain model, legacy round trip | Done — 76 tests |
| Realtime collaboration (Yjs) | Done — 20 convergence tests |
| Directory sync (AD / Entra / CSV) | Done — 30 tests |
| Postgres persistence | Done — 19 tests against real Postgres |
| OIDC authentication | Done — 25 tests |
| Nuxt app | **Vertical slice only.** Auth, collaboration and one editable chart. |
| Chart cascade UI, flows, roster, exports | **Not started** — see PORTING.md |

`index.html` remains the product until that last row is done.
