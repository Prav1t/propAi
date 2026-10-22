#!/usr/bin/env bash
# Runs the E2E suite in batches, each with a fresh dev server that compiles only the routes that batch uses.
# For machines with little memory (CI containers around 6 GB): a dev server holding every compiled route plus a
# browser doesn't fit. Don't start a dev server yourself — Playwright starts one per batch (and stops it after).
# Usage: npm run test:e2e:batched            (reset the database first: npm run db:reset)
set -u
cd "$(dirname "$0")/.."
if curl -s -o /dev/null --max-time 2 http://localhost:3000/api/health; then
  echo "A server is already running on :3000 — stop it so each batch gets a fresh one." >&2
  exit 1
fi
status=0
up() { curl -s -o /dev/null --max-time 2 http://localhost:3000/api/health; }
run() {
  local specs="$1" warm="$2" files=()
  for s in $specs; do files+=("tests/e2e/$s.spec.ts"); done
  # Playwright reuses a server that's still answering, so wait for the previous batch's server to exit
  for _ in $(seq 60); do up || break; sleep 1; done
  if up; then echo "The previous batch's dev server is still running on :3000 — stopping." >&2; exit 1; fi
  echo "=== $specs"
  E2E_WARMUP_ONLY="$warm" npx playwright test "${files[@]}" || status=1
}
run "analytics automation" "analytics,brief,assistant,automations,maintenance"
run "assistant" "assistant,maintenance,settings/ai,packages,notifications"
run "assistant-actions" "assistant,maintenance,announcements,tasks,settings/ai,amenities"
# (auth and authorization were one batch; compiling all 60-odd routes it touches outgrew a ~6 GB limit)
run "auth" "register,verify,onboarding,orgs,settings,invite,account"
run "authorization" "maintenance,residents,units,properties,portfolios,analytics,packages,amenities,documents,staff,vendors,admin"
run "billing" "settings/billing,settings/developers,settings/integrations,developers,admin,maintenance,api/v1"
run "community" "amenities,packages,messages,announcements,documents,notifications"
run "frontdesk" "desk,visitors,parking,shifts,pass,assets,calendar,notifications"
run "knowledge" "knowledge,documents,assistant"
run "maintenance" "maintenance,inspections,notifications,tasks"
run "portfolio" "properties,buildings,units,residents,search,portfolios"
run "security" "sso,account/confirm,settings/security,settings/privacy,settings/developers,settings/audit,maintenance,analytics,assistant,calendar,api/v1"
exit $status
