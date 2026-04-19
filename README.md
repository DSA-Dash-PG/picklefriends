# 🥒 SB Pickle Friends Spring Bash — Netlify Deployment

## One-time Setup (5 minutes)

### 1. Upload to Netlify
- Go to https://app.netlify.com
- Drag this entire folder onto the Netlify deploy area
  OR connect your GitHub repo

### 2. Set Environment Variable
In Netlify → Site settings → Environment variables, add:
```
ADMIN_PIN = 2626
```
(Change this to your desired PIN — must match the `ADMIN_PIN` in public/index.html)

### 3. Enable Netlify Blobs
Netlify Blobs is automatically enabled for all Netlify sites.
No extra setup needed — it activates on first use.

### 4. Install dependencies (if deploying via GitHub)
The `package.json` includes `@netlify/blobs`.
Netlify will auto-install on deploy.

---

## How it works

| What | Where |
|------|-------|
| Frontend | `public/index.html` — single-page app |
| API | `netlify/functions/api.js` — serverless function |
| Database | Netlify Blobs (key: `pickle-bash/tournament`) |
| Real-time | Frontend polls `/api` every 5 seconds |

## Changing the PIN
1. In Netlify env vars: change `ADMIN_PIN`
2. In `public/index.html`: find `const ADMIN_PIN = '2626'` and update to match

## Multiple Scorers
Share the deployed URL with anyone who needs to enter scores.
They tap the 🔒 icon → enter PIN → can now enter scores on their phone.
All scores sync to every device within 5 seconds.

## Resetting for next event
Admin → Roster tab → 🗑 Clear button → resets everything in the database.
