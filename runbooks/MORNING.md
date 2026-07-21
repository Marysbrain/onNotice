# Morning runbook, 2026-07-21. Coffee first. Then this.

Where we left off: you rolled the API token (good, the exposed one is dead). The env file still has the dead token in it. Everything below fixes that and finishes launch. Claude walks you through it step by step in chat, this file is the map.

1. Get the new token value. If you copied it when you rolled it last night, use that. If you did not copy it, no problem: dashboard, Carriers On Notice account, Manage Account, API Tokens, roll it again, copy the value it shows.
2. Put it in the env file: open Terminal, run `nano ~/.con-cloudflare.env`, replace everything after the equals sign on the CLOUDFLARE_API_TOKEN line with the new value, Control+O, Return, Control+X.
3. Load and verify (Claude can verify from his side too):
   source ~/.con-cloudflare.env
   npx wrangler whoami
   Success looks like a table saying Carriers On Notice.
4. Admin token: `openssl rand -hex 16`, copy the output, then `npx wrangler secret put ADMIN_TOKEN` typed exactly like that, paste the random string at the prompt. Save the string in your password keeper as "signal-engine admin token."
5. Light the backfill engine:
   cd "/Users/michaelhipp/Desktop/SSDI Questionnaire Work/carriers-on-notice/signal-engine"
   npx wrangler d1 migrations apply signal_engine --remote
   npx wrangler deploy
   Say yes to the migration. Say no if wrangler offers to edit config files.
6. Tell Claude "done." He scrubs the old history file, verifies everything, and hands you the backfill trigger commands. History starts flowing the same hour.

Also still open, zero urgency: approve the terms target list (nine carrier URLs plus T-Mobile's own past-offers archives), and Email Routing setup per the email runbook.
