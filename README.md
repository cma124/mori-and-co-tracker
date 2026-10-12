# Mori & Co. Tracker

HTML/JS frontend on Netlify + Google Apps Script API + Google Sheet as the database.

```
Browser (public/)  --POST /api-->  Netlify Function (netlify/functions/api.mjs)  -->  Apps Script Web App (backend/Code.gs)  -->  Google Sheet
```

The browser only ever talks to `/api` on your own site. The Apps Script URL is stored in a Netlify **environment variable** (`APPS_SCRIPT_URL`), so it is not in GitHub and not in the page, scripts or network requests the browser sees.

```
public/                 the website (index.html, app.js, styles.css, config.js, logos)  <- only this folder is published
netlify/functions/api.mjs   forwards /api calls to Apps Script using the APPS_SCRIPT_URL variable
netlify.toml            publish folder, function folder, security headers
backend/Code.gs         paste into Apps Script (not published on the website)
backend/test_backend.js offline tests for Code.gs: node backend/test_backend.js
```

## 1. Backend (Google Sheet + Apps Script)

1. Create a new Google Sheet.
2. **Extensions → Apps Script**, replace the default file with the contents of `backend/Code.gs`.
3. **Project Settings (gear) → Script properties → Add**:
   | Property | Value |
   |---|---|
   | `APP_USERNAME` | your login username |
   | `APP_PASSWORD` | a long, unique password |

   (Only needed if the script is *not* bound to the sheet: `SPREADSHEET_ID`.)
4. In the editor, select function `setup` and click **Run** once. Approve the permission prompt
   ("Google hasn't verified this app" → **Advanced → Go to … (unsafe) → Allow**; it's your own script).
   This creates the `Items` tab with headers.
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Copy the **Web app URL** (ends with `/exec`). Keep it private; it goes into Netlify in step 3 below, never into the code.

### Updating an existing deployment (e.g. after getting a new `Code.gs`)

1. Paste the new `Code.gs` over the old one and **Save**.
2. Run `setup` once. If your sheet already has data, this appends the missing columns (see below) and leaves everything else alone.
3. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.**
   Without this step the web app keeps running the *old* code. The URL stays the same, so Netlify needs no change.

## 2. Push to GitHub

Create an empty **private** repository on GitHub (no README/.gitignore), then in this folder:

```
git init
git add .
git status          # check: no .env file, no Apps Script URL anywhere
git commit -m "Product Tracker"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `.env` files. Do not paste the Apps Script URL or the login password into any file in this repo.

## 3. Deploy on Netlify

1. Netlify → **Add new site → Import an existing project → GitHub** → pick the repository.
2. Build settings: leave **Build command** empty. **Publish directory** = `public` and **Functions directory** = `netlify/functions` (both are read from `netlify.toml`).
3. Before the first deploy, open **Site configuration → Environment variables → Add a variable**:
   - Key `APPS_SCRIPT_URL`, value = your Apps Script Web app URL (`https://script.google.com/macros/s/.../exec`).
   - Tick **Contains secret values** if shown, so the value can't be read back in the Netlify UI.
4. **Deploy site.** (If you added the variable after a deploy, trigger **Deploys → Trigger deploy → Deploy site**; functions read variables at deploy time.)
5. Open the site, sign in, and check: browser DevTools → Network should show only `/api` requests and nothing to `script.google.com`.

Updating later: `git push` and Netlify redeploys automatically.

## What is and isn't protected

- Not in GitHub, not in the page: the Apps Script URL is only in Netlify's environment variables and used server-side by the function.
- Every API call still needs a valid login token (12 h). The function adds no extra access, accepts only POSTs from your own site, and limits request size.
- Honest limit: the Apps Script web app itself must be set to "Anyone", so someone who learned its URL could call it directly, and would still face the username/password check. If the URL ever leaks, create a **New deployment** in Apps Script (new URL), update `APPS_SCRIPT_URL` in Netlify, redeploy, and archive the old deployment. Use a long, unique password.
- Security headers (CSP, no framing, nosniff, HSTS, no-referrer, noindex) are set in `netlify.toml`.

## About the login credentials

Credentials are stored as **Script properties in Apps Script** (the server-side equivalent of an env file) and checked there. The browser only receives a signed token (12 h expiry) that every other API call must present.

## Sheet columns

`ID, Date, Product Code, Product Name, Product Brand, Unit Price (THB), Quantity, Total Price (THB), Rate, Total Price (MMK), Selling Price (MMK), Net Amount (MMK), Additional Cost (MMK), Additional Discount (MMK), Calculated Total Cost (MMK), Calculated Net Amount (MMK), Remark, Customer Name, Customer Phone, Customer Address, Created At, Updated At`

- **The app finds columns by their header name, not their position.** On a sheet created by an earlier version, the three Customer columns are added to the *end* of the header row (existing rows stay exactly as they were). You can drag columns into any order you like, and add your own extra columns; the app keeps them intact. Just don't rename the headers above (a renamed header is treated as a missing column and a new one is added).
- Derived columns (Total Price, Net Amount, Calculated…) are computed by the server on every save, so edit items through the app rather than typing into those cells.
- Text columns (including Customer Phone) are stored as plain text, so phone numbers keep their leading `0` and nothing typed is turned into a formula.
- `ID`, `Created At`, `Updated At` let items be addressed safely and sorted by creation date.

## What's included

- **Login**: no sign-up, server-checked credentials, session token, sign out.
- **Overview**: Top 5 product names and brands by quantity; Total Price (MMK), Total Selling Price (MMK), Total Net Amount (MMK); plus item count, total quantity, total THB, calculated net.
  **From / To date filters** (inclusive, on the item's Date field) that start on the **current month** (1st to last day) each time the app is opened, with "This month", "Last 30 days" and "All time" shortcuts. Leave either box empty for an open-ended range.
- **Items**: a table (stacked rows on tablets and phones) sorted newest-created first, with Date, Customer, Product, Qty, Total Price, Selling Price and Net Amount, plus view / edit / delete icons (delete asks for confirmation).
  A **totals strip** above the table shows Total quantity, Total Price, Total Selling Price, Total Net Amount and Calculated Net Amount (MMK) of exactly the rows listed (date range and search applied), updating as you change the filters.
  Same **From / To date filters** (also starting on the current month), plus search across customer, product, brand, code and remark. Your filters are kept when you open an item and come back.
- **Create / Edit / View** pages with a Customer section (name, phone, address), live calculation of the derived fields, validation, and autocomplete for existing names/brands/customers.
  Picking a returning customer's name fills in their phone and address (only if those boxes are still empty). The last-used rate is remembered for new items.

## Notes / limits

- Apps Script calls take ~0.5–2 s; the UI shows loading states.
- Writes are serialized with a script lock, so concurrent saves don't clash.
- Top 5 grouping is case-insensitive ("Dove" and "dove" count together).
- Customer phone accepts digits, spaces and `+ ( ) - . , / ;`. Name max 150 characters, address max 500.
- Apps Script web apps can't set CORS headers; the client sends `text/plain` JSON to avoid a preflight request, which is why the API is POST-only.
