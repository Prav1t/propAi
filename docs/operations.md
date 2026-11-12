# Operations runbook

For whoever is on call. Deployment is in [`deployment.md`](deployment.md); signals and alerts are in [`observability.md`](observability.md).

## Releasing a new version

1. **Read the iteration notes** for the version (`docs/iterations/`): new environment variables, new migrations.
2. **Check the configuration** with the production environment: `npm run config:check`.
3. **Back up** (or confirm point-in-time recovery is on): `npm run db:backup`.
4. **Run the migrator** to completion (`npm run db:migrate`, or the `migrator` image). It applies new migrations, syncs the permission catalogue and system roles, and re-grants the app role. It is safe to run twice.
5. **Roll the app and worker** to the new version. Instances stop cleanly: the worker finishes the turn in flight on `SIGTERM` (give it 40 seconds), and requests in flight complete.
6. **Check** `/api/health` on the new instances, the queue gauges, and the error rate for ten minutes.

### How migrations are written

- **Forward-only.** There are no down migrations. Rolling back code is fine; rolling back the database means restoring a backup.
- **Safe while the old version still serves** (expand, then contract):
  - a release may add tables, nullable columns, columns with defaults, and indexes;
  - it may not drop or rename anything the previous version still reads. That happens one release later.
- **Indexes on big tables:** `CREATE INDEX` blocks writes to that table while it builds (seconds for hundreds of thousands of rows, longer for millions). Migrations here use plain `CREATE INDEX`, so on a very large table run the release in a quiet period. Migration `0028` adds an index to `work_orders`.
- **Every table with an `org_id` gets row-level security in the same release.** A test (`tenant-isolation.test.ts`) fails the build otherwise, and the restore drill checks it on real data.

### Rolling back

- **Code only** (no migration in the release, or only additive ones): redeploy the previous image.
- **Data:** restore (below). Decide quickly: every minute of new writes is lost by a restore.

## Backups and restore

**What must be backed up:**

| What | How | Without it |
|---|---|---|
| The database | Provider point-in-time recovery, plus `npm run db:backup` (a `pg_dump` with a checksum) copied off-site | Everything is lost |
| Uploaded files | Bucket versioning (S3), or the uploads volume (`db:backup` archives it when `FILE_STORAGE=local`) | Attachments and documents are lost; records survive |
| `APP_ENCRYPTION_KEY` (and any old keys still in use) | Your secret manager, stored apart from database backups | Sealed secrets (MFA secrets, integration credentials, webhook signing secrets, SSO client secrets) can't be read. People re-enrol MFA; integrations are reconnected |

A backup contains personal data. Encrypt it at rest, restrict who can read it, and apply your retention period to it too: a record erased on request still exists in older backups until they expire. Say so in your privacy notice.

**Targets to agree with customers** (the product doesn't set these): with daily dumps the worst case is a day of lost data; with point-in-time recovery it is minutes. A restore of a small database takes minutes; test yours to know.

### Restore drill

`npm run db:restore-drill` proves that a backup restores and that the restored data is intact, without touching the live database. Run it monthly and after any change to the backup setup.

```bash
npm run db:restore-drill                      # takes a fresh backup and drills with it
npm run db:restore-drill -- backups/db-….dump # drills with an existing backup (checksum verified)
```

It restores into a scratch database on the same server, then checks:

- row counts against the source (fresh backups);
- row-level security is on, with policies, for every table that has an `org_id`;
- the app role can't bypass row-level security and can't change the audit log;
- the migration history is present;
- every audit hash chain verifies end to end, using the application's own verification code.

It exits non-zero if any check fails, and drops the scratch database (`--keep` leaves it for inspection). It needs `pg_dump` and `pg_restore` of the server's major version, and an owner role allowed to create databases.

### Restoring for real

1. Stop the app and worker (or put up a maintenance page). Writes during a restore are lost.
2. Restore: provider point-in-time recovery to a new instance, or `createdb` and `pg_restore --no-owner --dbname=<new database> <file>`.
3. Run `npm run db:migrate` against the restored database. It re-grants the app role and applies anything newer than the backup.
4. Run the restore drill's checks against it if time allows, or at least the audit verification under *Settings → Audit log*.
5. Point `DATABASE_URL` and `MIGRATION_DATABASE_URL` at it and start the app and worker.
6. Restore files to the same point if they were lost too. Records whose files are missing show the attachment as unavailable.
7. Tell customers what window of changes was lost.

## Incidents

| Symptom | Look at | Usual cause and fix |
|---|---|---|
| Site down, `/api/health` 503 | `checks.database` | Database unreachable or out of connections. Each app instance holds up to 10 connections; workers a few more. Raise the limit or add a pooler |
| `/api/health` says `migrations: failing` | Release log | The app is newer than the schema: the migrator didn't run. Run it |
| `/api/health` says `database_role: failing` | `DATABASE_URL` | The app is connecting as a superuser or the table owner. **Tenant isolation is not enforced.** Fix the role before serving traffic |
| Notifications, automation or webhooks late | `app_queue_oldest_seconds`, `app_worker_last_tick_age_seconds`, `worker.tick_failed` | Worker not running, or failing on one job. A failed turn logs the error and retries; one bad item doesn't block the others |
| Emails not arriving | `email.failed`, the `email` queue | Provider credentials or sending-domain setup |
| Uploads failing | `checks.storage` | Bucket permissions, or a full disk with local storage |
| Sign-in says "too many attempts" for everyone | `TRUSTED_PROXY_HOPS` | Unset behind a proxy: everyone shares the proxy's address. Set it to the number of proxies |
| A customer quotes an error *Reference* | Search logs for that digest | `request.error` has the route and request id |
| Assistant says it is unavailable | `ai.stream_failed`, provider status | Model provider outage or an exhausted cap. The rest of the product is unaffected |
| An automation rule is misbehaving | *Automations → Runs* | Disable the rule. Rules that fire in a loop are paused automatically (`automation.paused_runaway`) |

**Suspected security incident:** revoke sessions (*Settings → Security → Signed-in members*, or delete from `sessions`), rotate API keys and webhook secrets from *Settings → Developers*, rotate the encryption key (below), then read the audit log and verify its chain. The threat model (`security/threat-model.md`) lists what each control protects.

## Rotating secrets

| Secret | How | Effect |
|---|---|---|
| `APP_ENCRYPTION_KEY` | Add the new key as current with a new `APP_ENCRYPTION_KEY_ID`, move the old one to `APP_ENCRYPTION_OLD_KEYS` (`id:key`), deploy, run `npm run keys:rotate`, check `npm run keys:status`, then remove the old key | None for users |
| Database passwords | Change the role's password, update the URL, roll instances | Brief reconnects |
| `METRICS_TOKEN` | Change it and the scraper's copy | None |
| VAPID keys | Don't, unless leaked: every device must turn push on again | Push stops until people re-subscribe |
| Stripe, mail and model provider keys | Rotate at the provider, update the variable, roll instances | None |
| A customer's API keys, webhook secrets, SSO client secret | The customer does this in *Settings* | Theirs to schedule |

Rotate the encryption key and database passwords at least yearly, and whenever someone with access leaves.

## Scaling

Measured on the development machine (2 shared vCPUs running the app, PostgreSQL and the load generator together) with the demo organization grown to **150,258 work orders**, using `npm run load:test`:

| Page | One user, p50 / p95 | Ten users at once, p50 / p95 |
|---|---|---|
| Dashboard | 140 / 297 ms | 843 / 1,062 ms |
| Maintenance list (open work) | 111 / 177 ms | 904 / 1,174 ms |
| Maintenance search | 193 / 245 ms | 1,114 / 1,426 ms |
| Maintenance, all history, page 40 | 330 / 372 ms | 1,393 / 1,645 ms |
| Analytics | 191 / 266 ms | 1,060 / 1,279 ms |
| Tasks, residents, search, calendar | 36–76 / 49–98 ms | 393–494 / 552–752 ms |

Ten users requesting pages back to back with no pauses produced about 12 pages a second with no errors; the processor was the limit, not the database. What that means in practice:

- **One 2-vCPU instance** served about 12 pages a second with a six-figure work order history. If a person loads a page every 20 to 30 seconds, that is on the order of 200 to 300 people active at the same moment. That is arithmetic from this test, not a measurement of real use.
- **Add app instances** behind the load balancer for more. The app is stateless; give it Redis and S3 first.
- **The database** was not the limit in this test. One index was added because of it (`work_orders_open_idx`: queries for open work went from 24 ms to 4 ms). The all-history list sorts by urgency, which reads every row the person can see; it is the first query to revisit beyond a few hundred thousand work orders.
- **The worker** rarely needs more than one instance. A second gives availability, not throughput.

These numbers come from one small machine and synthetic data. Repeat the test on your own hardware before promising a customer anything: create a database whose name contains `load`, migrate and seed it, add rows with `LOAD_ROWS=150000 npx tsx scripts/load-data.ts`, start the app against it and run `npm run load:test`.

## Routine checks

- **Daily:** queue gauges flat, no repeated `worker.tick_failed`, error rate normal.
- **Weekly:** `npm run security:audit` (also in CI); review `csp.violation` sources.
- **Monthly:** restore drill; dependency updates (patch and minor together, majors one at a time with the test suite); check certificate renewal.
- **Yearly, or when staff change:** rotate the encryption key and database passwords; review platform administrators.
