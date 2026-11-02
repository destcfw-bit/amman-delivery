# AMMAN DELIVERY — Official Coolify deployment

Production source: `destcfw-bit/amman-delivery`, branch `main` (after the release is merged).
Use a **new Coolify application**, not an existing TiGER/Click Plus/Abshir/Safeer resource.

## Create the official app

1. In Coolify > Projects, add `AMMAN DELIVERY` (or a dedicated production environment).
2. Add a **Git-based Docker Compose Application** from `https://github.com/destcfw-bit/amman-delivery`, branch `main`, compose file `docker-compose.yml`. Choose the existing OVH server.
3. In Environment Variables, set:
   - `POSTGRES_PASSWORD`: new random **hexadecimal** secret (URL-safe; database is created only for AMMAN).
   - `JWT_SECRET`: another new long random secret.
   - `CAPTAIN_PASSWORD_KEY`: separate new long secret; **do not rotate** later without a password migration.
   - `ADMIN_USERNAME`: private administrative login.
   - `ADMIN_PASSWORD`: new strong administrative password.
   - `SITE_MODE=all`
   - `RUN_WORKER=0` and `AUTO_REGISTER_GROUP_MEMBERS=0` until the correct group and WhatsApp session are verified.
4. In Coolify Domains add the **actual approved hostname**, HTTPS, service `app`, internal port `3000`. Point the hostname's DNS record to the OVH host IP; enable HTTPS.
5. Deploy, then verify `https://YOUR_APPROVED_HOSTNAME/health` returns `{"ok":true,...,"db":true}`. Check `/captain`, `/admin`, and `/register`; create a nonproduction test captain for a sanity check.
6. Set up **Postgres volume backups** and verify restore procedures before accepting real transactions.

## Connect AMMAN's DropConnect session

Only after the website and database pass checks:

1. Obtain the real **AMMAN WhatsApp group ID** and its **independent DropConnect session ID**. Do **not** reuse a TiGER or Click Plus group/session by guesswork.
2. In Coolify set `WHATSAPP_PROVIDER=dropcode`, `DROPCODE_API_URL`, `DROPCODE_API_TOKEN` (or the credential expected by your DropConnect integration), `DROPCODE_SESSION_ID`, and a **unique** `DROPCODE_WEBHOOK_SECRET`.
3. Subscribe exactly the AMMAN session/group to `https://YOUR_APPROVED_HOSTNAME/webhooks/dropcode` with the shared signing secret. Confirm webhook HMAC and review signed event log.
4. Add the AMMAN group through the admin panel, set the explicitly approved commission/floor rules, and authorize the correct supervisors.
5. Only now set `RUN_WORKER=1` and redeploy. Keep `AUTO_REGISTER_GROUP_MEMBERS=0` unless its effects are separately approved.
6. Verify exactly one test message, one 👍 and its removal, balances, archived movements and voice media with a real phone.

Never paste secrets into GitHub, commit a .env, share or reuse old systems' databases, or enable the worker before session/group validation.

## Operations

- Health check: `/health` (verifies PostgreSQL).
- UI: `/` redirects to `/captain`; administration at `/admin`; onboarding at `/register`.
- The compose stack **does not publish PostgreSQL or the app's raw port** to the internet. HTTPS is provided by Coolify's proxy on service `app:3000`.
- Changing environment variables requires redeploying to recreate the application container.
- The Compose database volume persists across ordinary redeploys; do not delete it during upgrades.
- No official domain, Coolify resource, DB or WhatsApp session is provisioned automatically by merging code to GitHub.
