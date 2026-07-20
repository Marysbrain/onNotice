# Runbook: Cloudflare Email Routing for carriersonnotice.com

Receive-only mail on the project domain, forwarded to an inbox you already read. Free, no message caps. About five minutes once the prerequisites exist.

## Prerequisites (your items, in order)

1. Create the new Cloudflare account for this project. Note: the signup form will not create a second account on an email that already has one, and the account switcher only appears once your login belongs to two or more accounts. So: sign up at dash.cloudflare.com/sign-up with a second address you control (for example con@athipp.com), verify it, then in the new account go to Manage Account, Members, and invite contact@athipp.com as Super Administrator. Accept the invite from your main login and the switcher (the account dropdown at top left) shows both. Rename the new account to Carriers On Notice under Manage Account, Configurations. Free. Keep it fully separate from the Stride gateway account.
2. Register carriersonnotice.com in that account, Cloudflare Registrar, at-cost pricing. COST FLAG: this is the roughly ten dollars a year item, confirm the exact price at checkout. Registering inside Cloudflare means DNS is already there and every step below is one dashboard.

## Setup

1. In the new account, open the domain, go to Email, then Email Routing, click Enable.
2. Cloudflare offers to add the required MX and TXT (SPF) records automatically. Accept. Done in one click because DNS is on Cloudflare.
3. Add a destination address: the personal or business inbox where you want mail to land. Cloudflare sends a verification email to it. Click the link.
4. Create two custom addresses:
   - contact@carriersonnotice.com, forward to your verified inbox
   - corrections@carriersonnotice.com, forward to the same inbox (or a different one if you want corrections separated)
5. Optional but recommended: set the catch-all to Drop. Anything sent to made-up addresses on the domain dies quietly instead of forwarding spam.
6. Send a test email to each address from any outside account. Confirm both arrive.

## Two things to know

1. Email Routing receives and forwards only. It does not send. When you reply, the mail goes out from your own inbox address, not from contact@. If you later want replies to come FROM contact@carriersonnotice.com, that is a separate setup (send-as through your mail provider with an SMTP service). Flag it when you want it; low-cost options exist but nothing needs it for launch.
2. When the review queue and story pipeline exist, Email Routing can also route mail into a Worker instead of an inbox. That is how corrections@ could someday file reports straight into the job table. Later phase, zero cost, noted here so we remember.
