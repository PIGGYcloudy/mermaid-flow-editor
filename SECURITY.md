# Security policy

## Supported versions

Security fixes are applied to the latest release on the default branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting feature on the repository's **Security** tab.
Include a minimal reproduction, affected configuration, impact, and any
suggested mitigation. You should receive an acknowledgement within seven days.

## Deployment boundary

Mermaid Flow Editor proxies requests to user-selected OpenAI-compatible API
hosts. Before exposing an instance to the public internet:

- set `AI_API_ALLOWED_HOSTS` to an explicit host allowlist;
- use HTTPS;
- add authentication at a reverse proxy, VPN, or hosting platform if access
  should be restricted;
- apply request and concurrency limits at the reverse proxy or platform edge;
- keep `JSON_BODY_LIMIT` appropriately small.

API keys entered in the browser are stored in `sessionStorage`, sent only to
the application's proxy for the selected request, and are not persisted by the
application. The project has no server-side user store or shared AI credential.
Operators remain responsible for reverse-proxy and platform logs.
