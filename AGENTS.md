# Agent instructions (Nexus Agent / softwareproject3)

## Runtime environment

All Python tooling (`python`, `uv`, tests, scripts), and Node.js tooling (`node`, `npm`, `npx`) for this repository must run in the **conda** environment **`NexusAgent`**.

- Activate before terminal work: `conda activate NexusAgent`
- Or invoke that environment’s interpreters directly (same `PATH` effect once activated)

The environment **name** is defined in [`environment.yml`](environment.yml). Do **not** hardcode a single filesystem path in docs or scripts: installs differ by OS and conda location. To see where **`NexusAgent`** lives on your machine, run `conda env list` or `conda info --envs` (typical layout: `<conda_root>/envs/NexusAgent`). After activation, conda sets **`CONDA_PREFIX`** to that directory; on Windows, [`scripts/run-all.ps1`](scripts/run-all.ps1) uses **`CONDA_PREFIX`** to find `python.exe` and `npm.cmd`.

This matches [`environment.yml`](environment.yml) and avoids dependency drift between machines.

## Repository layout

What each top-level directory is for (FastAPI backend, React frontend, MCP server, Playwright e2e, test runner script) is documented under **Project layout** in **[README.md](README.md)**. Read that before changing code in an unfamiliar area.

## Setup and running services

Install steps are in **[README.md](README.md)**.

- **Default (cross-platform):** start backend, MCP server, and frontend in **separate terminals**, each with `conda activate NexusAgent`, using the commands in README **Run**.
- **Windows (PowerShell, optional):** after `conda activate NexusAgent` (so **`CONDA_PREFIX`** is set), from the repo root run **`.\scripts\run-all.ps1`**. It builds the MCP server, then opens three windows for backend, frontend, and MCP. Details: README **Run**.

## Testing

- Prefer **`python scripts/run_all_tests.py`** from the repo root for full verification after substantive changes.
- Use **`--skip-e2e`** when the stack is not running or E2E is out of scope for the change.
- **Install, Playwright setup, per-package commands, E2E prerequisites, and report locations** are documented in **[README.md](README.md)** under **Testing**.

## Secrets and configuration

Do **not** commit secrets. **`.env`** is gitignored; use local env files per team practice. Keep machine-only paths in user/editor settings, not in shared agent rules.

- **`MCP_IDLE_TEARDOWN_SECONDS`** (backend, default **600**): after this many seconds with no finished **`/agent/run`** (and with **`MCP_CLIENT_PERSIST`** enabled), the backend closes the persistent MCP client so the MCP server can tear down Audiotool sync. Set to **0** to disable idle teardown.

## Deployment

This project is deployed on **DigitalOcean App Platform**.

- When performing deployment-related tasks (checking app status, viewing build/run logs, updating the app spec, or managing the live environment), use the **DigitalOcean MCP** tools available in Claude Code.
- Prefer MCP tool calls over manual `doctl` CLI commands when the MCP is available in the session.
- Do **not** commit infrastructure changes (app specs, secrets) without confirming with the user first.
