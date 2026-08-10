# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

Contact **FURYWOLF** via [furywolf.net](https://furywolf.net) with:

- what the issue is and where (endpoint, file, or route);
- the steps or request needed to reproduce it;
- what an attacker could achieve with it.

You will get an acknowledgement as soon as it is seen. Please give a reasonable
window to ship a fix before disclosing publicly.

## Scope

In scope:

- the API (`apps/api`) and the web application (`apps/web`);
- authentication, session handling and the admin surface;
- injection, path traversal, access-control and denial-of-service issues.

Out of scope:

- findings that require an already-compromised administrator session;
- volumetric floods that only demonstrate that a single-node service can be
  saturated (the rate limits and their behaviour are documented at `/api-docs`);
- missing hardening headers with no demonstrated impact;
- vulnerabilities in Microsoft's symbol data itself, which this project indexes
  but does not produce.

## Deploying this yourself

If you self-host KernelArchive, note that the defaults are tuned for local use:

- `HOST` binds to `127.0.0.1`. Only change it behind a reverse proxy that
  terminates TLS.
- `TRUST_PROXY` decides whether `X-Forwarded-For` is believed. Set it to your
  proxy's address only. Trusting an untrusted value lets anyone reset their own
  rate limit by spoofing the header.
- `PUBLIC_APP_URL` drives the allowed CORS origin. Set it to your real origin.
- `KERNELARCHIVE_API_KEY` is optional and unset by default. When unset, no
  request can reach the elevated rate-limit tier.
- Never commit `local-cache/`. It contains `auth.sqlite` (admin password hash and
  active session tokens) and the full archive database.
