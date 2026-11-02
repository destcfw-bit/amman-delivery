# AMMAN DELIVERY — Local preview

This runs the **actual application** on an isolated PostgreSQL database. It does not connect to existing TiGER, Click Plus or WhatsApp data.

## Windows / Mac / Linux (Docker Desktop required)

1. Clone the repository, then switch to `preview/amman-ui-red-silver`.
2. Copy `.env.preview.example` to `.env.preview`.
3. Replace **all** `CHANGE_ME` values with strong unique secrets. Never commit `.env.preview`.
4. Run:
   ```sh
   docker compose -f docker-compose.preview.yml --env-file .env.preview up --build -d
   ```
5. Open **http://localhost:3001** (captain) and **http://localhost:3001/admin** (admin), logging in with the admin values in your private env file.
6. Read logs with:
   ```sh
   docker compose -f docker-compose.preview.yml --env-file .env.preview logs -f app
   ```
7. Stop with:
   ```sh
   docker compose -f docker-compose.preview.yml --env-file .env.preview down
   ```

The stack binds to **127.0.0.1:3001** and therefore only opens on the computer running Docker. It uses a separate named PostgreSQL volume, has `RUN_WORKER=0`, and clears DropConnect settings. Do not use real customer data. Do not use `down -v` unless you intentionally want to erase preview data. This is not a public preview link and is not production-ready. Test real application login and migrations after startup.
