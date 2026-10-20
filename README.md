# Clan Tracker
Tracks the Ninja Zenshin clan ranking and war results over time.

1. Supabase: run `supabase/migrations/001_init.sql` in the SQL editor.
2. Vercel: import this repo, add the env vars from `.env.example`.
3. GitHub: add secrets `CRON_SECRET` and `SITE_URL` (your Vercel URL). The workflow syncs every 3 hours; run it manually from the Actions tab for the first snapshot.
