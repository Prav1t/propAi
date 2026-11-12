# Production security checklist

Go through this before the first customer, and again after any change to how the product is hosted. The threat model ([`threat-model.md`](threat-model.md)) explains the controls; this is the list of things an operator has to set or decide. Items marked **enforced** are checked by the start-up configuration check or the readiness probe.

## Network and TLS

- [ ] The app is reachable only over HTTPS, and `APP_URL` is the public `https://` address (**enforced**).
- [ ] HSTS: the app sends `max-age=63072000; includeSubDomains; preload`. Decide whether to submit the domain to the preload list. It is hard to undo, and every subdomain must serve HTTPS.
- [ ] `TRUSTED_PROXY_HOPS` equals the number of proxies in front of the app, and the proxy overwrites or appends `X-Forwarded-For` (warned when unset).
- [ ] The database, Redis and `/api/metrics` are not reachable from the internet.
- [ ] Outbound traffic is allowed to: your mail provider, model provider, Stripe, the browser push services, and customers' webhook and SSO addresses. Webhooks and push refuse private addresses.

## Database

- [ ] The app connects as its own role: not a superuser, no `BYPASSRLS`, not the owner of the tables (**enforced** twice: different users at start-up, and the role's privileges in `/api/health`).
- [ ] `sslmode=require` or stricter on remote connections (warned).
- [ ] Point-in-time recovery or scheduled backups are on, copied off the host, encrypted, and a restore drill has passed (`npm run db:restore-drill`).
- [ ] The owner role's password is known only to the release pipeline and backups.

## Secrets

- [ ] Secrets come from a secret manager or an untracked env file with tight permissions. None are in the image or the repository (`npm run security:secrets` runs in CI).
- [ ] `APP_ENCRYPTION_KEY` is backed up separately from the database.
- [ ] A rotation date is set for the encryption key and database passwords (`operations.md`).
- [ ] No development switches: `E2E_FAULTS`, `RATE_LIMITS=relaxed`, `*_ALLOW_PRIVATE_TARGETS`, `OIDC_ALLOW_HTTP_ISSUERS`, `ALLOW_INSECURE_PRODUCTION` (**enforced**, except the last, which is the override itself: search your configuration for it).
- [ ] `SHOW_DEMO_ACCOUNTS` is unset and the demo data was never seeded into this database.

## Accounts

- [ ] Platform administrators are named people, each with two-step verification on. Review the list (`select email from users where is_platform_admin`).
- [ ] `ALLOW_REGISTRATION=false` if customers are onboarded by your team.
- [ ] Each customer's administrators are told about two-step verification, single sign-on and the session list under *Settings → Security*.

## Email

- [ ] A real provider is configured (**enforced**) and `MAIL_FROM` is your own domain.
- [ ] SPF, DKIM and DMARC are set for that domain, or password-reset emails will land in spam.

## Files

- [ ] The bucket is private, with versioning and encryption at rest. With local storage, the volume is backed up and on an encrypted disk.
- [ ] Decide on malware scanning. Uploads are checked by type and size and served as downloads, but they are **not scanned**: `fileScanner()` in `src/server/files/storage.ts` is the hook for ClamAV or a cloud scanner.

## Monitoring

- [ ] Logs are shipped and kept for as long as your policy says (audit checkpoints in the log are evidence: keep them at least as long as the audit log).
- [ ] The alerts in `observability.md` are set up, and someone receives them.
- [ ] `csp.violation` log lines are reviewed after each release.

## The assistant

- [ ] A model provider is chosen, and its data-handling terms are acceptable for resident data (what is sent: the question, the person's role, and the records the tools return for that person).
- [ ] Per-organization monthly caps are set (`AI_MONTHLY_REQUEST_CAP`, or per organization in the admin console).
- [ ] Each customer has reviewed the assistant's policy page (*Settings → Assistant*): what may run without asking.

## Legal and privacy (not provided by the product)

- [ ] Terms of service, a privacy notice and a data processing agreement exist. The product has the mechanisms (export, erasure, retention, consent records, audit) but no legal documents, and makes no compliance claim.
- [ ] You know where the data is hosted and have told customers.
- [ ] A contact for privacy requests and security reports is published.

## Not yet done for this product

Be straightforward with customers about these:

- No independent penetration test or security audit.
- No screen-reader testing (see `accessibility.md`).
- The Docker images have not been built or run by the authors' environment (see `deployment.md`).
- Push delivery and speech-to-text were tested against local stand-ins, not the real services.
- Stripe billing was tested against signed test events and a mock; a real Stripe account in test mode should be run through checkout, renewal and cancellation before charging anyone.
