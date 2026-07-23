# Spot QC Dashboard → BigQuery setup

The dashboard now reads from BigQuery through a Vercel serverless function
instead of published Google Sheets CSVs.

    Browser (index.html)  →  /api/qc?product=images|360  →  BigQuery  →  JSON

## Files

    index.html          → dashboard (put at repo root, as before)
    api/qc.js           → serverless function (Vercel auto-detects /api)
    package.json        → declares @google-cloud/bigquery

Repo layout should be:

    your-repo/
      index.html
      package.json
      api/
        qc.js

## 1. Create a service account (one-time, in Google Cloud)

1. Google Cloud Console → project **spyne-reprocess** → IAM & Admin → Service Accounts → Create.
2. Name it e.g. `dashboard-bq-reader`.
3. Grant these roles:
   - **BigQuery Data Viewer**
   - **BigQuery Job User**
4. Create a JSON key (Keys → Add key → JSON) and download it.

## 2. Add environment variables in Vercel

Project → Settings → Environment Variables → add:

| Name                       | Value                                              |
|----------------------------|----------------------------------------------------|
| `GCP_PROJECT_ID`           | `spyne-reprocess`                                   |
| `GCP_SERVICE_ACCOUNT_JSON` | paste the ENTIRE contents of the downloaded JSON key |

For `GCP_SERVICE_ACCOUNT_JSON`, paste the raw JSON exactly as-is (Vercel handles
the multi-line value). The function does `JSON.parse()` on it.

**Redeploy after adding/changing env vars** — Vercel only picks them up on a new
deployment.

## 3. Deploy

    git add index.html package.json api/qc.js
    git commit -m "Switch data source from Google Sheets to BigQuery"
    git push

Vercel installs the dependency and exposes `/api/qc` automatically.

## 4. Verify

- Open `https://<your-app>.vercel.app/api/qc?product=images` → should return
  `{ "product": "images", "count": N, "rows": [...] }`.
- Same for `?product=360`.
- Then open the dashboard; the Product filter toggles between the two tables.

## Notes

- **Table/field mapping** is inside `api/qc.js` (the `QUERIES` object). If a
  column is ever renamed in BigQuery, update it there only.
- **Cost/perf:** responses are edge-cached 60s (`s-maxage=60`). The Refresh
  button in the UI forces the browser to refetch, but the edge cache may still
  serve a <60s-old copy. Raise/lower `s-maxage` in `qc.js` if needed.
- **Dates:** BigQuery `Timestamp` (UTC) is grouped onto the **IST** calendar day
  in the dashboard, matching how the sheet data was used.
- If the tables live in a non-US BigQuery region, change `location: 'US'` in
  `qc.js` to the correct region (e.g. `'asia-south1'`).
