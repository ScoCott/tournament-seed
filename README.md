# Seedline — Bracket Integrity Court

**Was this tournament bracket seeded fairly, or arranged to clear a path?**

Seedline is a GenLayer StudioNet contract that lets tournament organisers file a
draw on-chain. A panel of GenLayer validators independently audits the seeding
algorithm, the assigned seeds and the ranking history; the counted anomalies
yield a fairness ruling — **FAIR**, **CONTESTED** or **RIGGED**. Contested and
rigged draws are sent back for versioned re-draws (up to three rounds), and
every anomaly is recorded by kind in a permanent ledger.

---

## The Draw Lifecycle

A bracket progresses through six phases:

```
SUBMITTED → AUDITED → EVALUATED → RATIFIED  (if FAIR)
                                  → REDRAW → SUBMITTED (re-draw, up to 3×)
                                            → RETIRED   (submitter abandons)
```

| Phase | What happens |
|-------|-------------|
| **SUBMITTED** | Organiser files the draw: tournament name + seeding algorithm + assigned seeds + ranking history. |
| **AUDITED** | Validators inspect the draw via an LLM prompt, counting distinct, concrete seeding anomalies. |
| **EVALUATED** | The anomaly count determines the ruling: 0 anomalies → **FAIR**, 1–2 → **CONTESTED**, 3+ → **RIGGED**. |
| **RATIFIED** | The draw is settled on-chain as fair. No further action. |
| **REDRAW** | A contested/rigged draw is archived (v1, v2 …) and the organiser submits a new draw. |
| **RETIRED** | The submitter abandons the bracket at any point before ratification. |

---

## Anomaly Kinds

| Kind | Severity | Description |
|------|----------|-------------|
| SEED_INCONSISTENCY | 2 | Seed assignment does not match stated rank. |
| PATH_RIGGING | 3 | Bracket path engineered to favour a specific entrant. |
| COLLUSION_SIGNAL | 4 | Convenient repeated pairings or suspicious withdrawals. |
| ALGO_OVERRIDE | 4 | Manual override of the stated seeding algorithm. |
| UNKNOWN | 1 | Anomaly not fitting the four established kinds. |

---

## The Contract

`backend/tournament-seed.py` — a GenLayer Python contract (~864 lines).

- 6-phase state machine mapped as `IntEnum`
- An LLM prompt (`gl.nondet.exec_prompt`) reads the draw and counts anomalies
- Deterministic rule faults (`seed^rule`) and model faults (`seed^model`) are
  distinguished in user errors
- Validator functions ensure referee consensus on both rule and model paths
- `_fairness_ruling()` maps anomaly count to ruling
- Bracket revisions are archived per redraw round
- Per-tournament `TournamentRoll` tracks fairness metrics
- Full audit log records every state transition

### Key constants

| Constant | Value | Meaning |
|----------|-------|---------|
| DRAW_MIN_LEN | 40 | Minimum draw text length (chars) |
| DRAW_MAX_LEN | 6000 | Maximum draw text length |
| TOURNAMENT_MAX_LEN | 120 | Max tournament name length |
| ANOMALY_MAX | 64 | Ceiling on anomaly count |
| ANOMALY_TOL | 1 | Tolerance between leader and validator counts |
| CONTESTED_FLOOR | 1 | Anomalies ≥ 1 → CONTESTED |
| RIGGED_FLOOR | 3 | Anomalies ≥ 3 → RIGGED |
| REDRAW_CAP | 3 | Maximum re-draw rounds per bracket |
| MAX_ANOMALY_ITEMS | 48 | Max anomaly detail items stored |

### View functions (14 total)

| View | Returns |
|------|---------|
| `get_bracket(id)` | Full bracket struct |
| `get_bracket_card(id)` | Formatted bracket summary |
| `get_anomalies(id)` | Anomaly list for a bracket |
| `get_revisions(id)` | Archived draw revisions |
| `get_tournament_roll(tournament)` | Rollup for a tournament |
| `list_brackets_by_tournament(t, off, lim)` | Paginated tournament brackets |
| `list_brackets_by_submitter(addr)` | Brackets filed by an address |
| `get_audit_log(off, lim)` | Paginated audit trail |
| `get_ruling_distribution()` | Counts per ruling |
| `get_phase_distribution()` | Counts per phase |
| `top_tournaments(limit)` | Leaderboard by controversy score |
| `tournament_stats()` | Global counters |
| `list_anomaly_kinds()` | Anomaly kind catalogue |
| `get_fairness_bands()` | Ruling thresholds |

---

## The Frontend

React 18 + TypeScript + Vite, styled with a dark green/gold palette.

- **Three.js 3D hero** — single-elimination bracket rendered as a wireframe
  binary tree; a GSAP-driven light pulse advances from the leaves toward the
  champion node. Parallax responds to pointer movement.
- **Draw composer** — tournament name, discipline picker (Chess, Tennis,
  Esports, Boxing, Debate, Football), bracket size (8/16/32/64), and a text
  area for the full draw.
- **Ruling readout** — displays the bracket card, anomaly list, rationale, and
  lifecycle controls (Audit → Evaluate → Ratify / Redraw → Resubmit).
- **Fairness registry** — four on-chain views rendered as UI: ruling
  distribution bar chart, phase distribution tiles, top tournaments
  leaderboard, and anomaly kind legend.
- **My brackets** — wallet-linked list of brackets filed by the connected
  address.
- **Wallet integration** — RainbowKit + wagmi + genlayer-js for write
  operations (submit, audit, evaluate, ratify, resubmit, retire).
- **Repository-visible signer path** — `frontend/src/App.tsx` obtains the
  connected wagmi `walletClient`; every lifecycle button passes that signer into
  `frontend/src/contractService.ts`, which creates the genlayer-js write client
  with `account: walletClient.account.address` and `provider.request` from the
  wallet transport. The connected address alone is not used as a fake signer.

### Build & dev

```bash
cd frontend
npm install        # already locked in package-lock.json
npm run dev        # Vite dev server on port 5421
npm run build      # tsc -b && vite build → dist/
npm run preview    # Preview the production build
```

---

## Deploy (GitHub Pages)

A GitHub Actions workflow (`.github/workflows/deploy.yml`) builds the frontend
and publishes `frontend/dist/` to GitHub Pages on every push to `main`.

**Once deployed, the app is live at:**

```
https://ScoCott.github.io/tournament-seed/
```

---

## Contract Address

**`0x1A1fDd783a3ef52927ED0F63f8e72bB264C83977`** on GenLayer StudioNet
(chain ID 61999).

- Explorer: https://explorer-studio.genlayer.com/address/0x1A1fDd783a3ef52927ED0F63f8e72bB264C83977
- RPC: https://studio.genlayer.com/api
