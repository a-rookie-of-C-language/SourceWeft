# Import CC Switch into BYOK

In the LLM model selector, open **BYOK → Custom provider → Import from CC Switch**.
The desktop automatically reads the current user's `.cc-switch/cc-switch.db`;
choose a database explicitly when CC Switch uses a custom configuration directory.
The desktop queries SQLite read-only and includes live WAL changes.

The Web application also accepts a user-selected SQLite database. Close CC Switch
before selecting this standalone file so its latest WAL changes are checkpointed.
The file is parsed in browser memory using a lazily bundled SQLite implementation;
the full database is never uploaded and no CDN is required.

Review providers, endpoints, protocols and explicit model IDs. Currently selected
compatible providers are checked by default. API keys are hidden; no keys are
written to browser storage or importer logs. If a source has no configured model,
enter its model ID instead of relying on a guessed model. Select the configurations
to import and confirm the target server/workspace before saving.

Only selected keys are sent to the signed-in SourceWeft backend. They use the
existing team encryption and account/workspace BYOK authorization. A hosted
SourceWeft deployment stores them on that server, not only on the desktop.
System Provider activation, global credentials and default model choices do not
change. Imported models appear under the custom BYOK provider.

## Supported configurations

- Claude: `env.ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`,
  `ANTHROPIC_BASE_URL`, and explicitly configured default/model IDs.
- Gemini: `env.GEMINI_API_KEY` or `GOOGLE_API_KEY`,
  `GOOGLE_GEMINI_BASE_URL`, and `GEMINI_MODEL`.
- Codex: `auth.OPENAI_API_KEY` plus TOML `model`, `model_provider`, and the
  selected `model_providers` entry with `base_url`. Both `chat` and `responses`
  (including the Codex default when omitted) can be imported.

Codex Responses configurations are imported as Chat Completions with a visible
preview notice. The base URL and model IDs are preserved; the endpoint must also
support Chat Completions. This does not translate Responses requests or implement
a Responses transport. OAuth sessions, official-login tokens, other CC Switch
app types, UNC-specific behavior and old JSON configuration formats are not
imported. No runtime protocol/provider fallback is performed.

Local proxy endpoints must be reachable by the SourceWeft backend and pass its
existing endpoint policy. A remote backend cannot access a proxy on the desktop's
localhost. Endpoint validation is not a successful model inference check.

## Retry and replacement behavior

Each provider and its selected LLM models are saved atomically. Imports are
serialized per user/workspace in PostgreSQL. Repeated imports from the same CC
Switch provider/app reuse the imported credential and skip existing models.
Changed keys, endpoints, protocols or inactive credentials require explicit
replacement confirmation. Other credentials and models are never removed.
Interrupted network requests can be retried safely; the UI does not assume that
a lost response means the server saved nothing.

Current limits: 64 MiB database, 200 providers, 1 MiB settings per provider,
30 model IDs per import request, and 256 KiB request body.

## Verification

The focused Rust and Web parser tests cover Claude/Gemini mapping, Codex TOML and
protocol errors, hidden parser diagnostics, SQLite reads and row limits. Rust
also tests a live WAL database. Backend tests cover encryption, deduplication,
replacement confirmation, authorization/policy rejection and transaction rollback.
Real local API verification covered concurrent retries, changed-key confirmation,
anonymous denial and cross-workspace denial using disposable synthetic keys.
It confirmed one encrypted credential and one model, then removed test records.

No real user CC Switch keys or external model inference were used for verification.
