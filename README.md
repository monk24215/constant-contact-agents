# constant-contact-agents

Compartmentalized agents for managing Constant Contact via a Notion content calendar.

Each agent is a self-contained service. Deploy each as its own Railway service
with the matching Root Directory:

- `auth/`     -> Root Directory: `/auth`     (OAuth + token refresh)
- `composer/` -> Root Directory: `/composer` (Notion calendar -> CC drafts, DRAFT-ONLY)

There is intentionally NO workspace / build config at the repo root.
