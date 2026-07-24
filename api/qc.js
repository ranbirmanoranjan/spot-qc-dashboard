// api/qc.js — Vercel serverless function
// Fetches Spot QC data from BigQuery and returns normalized rows as JSON.
//
// Query params:
//   ?product=images  → dataset table `spot_qc.image_responses`
//   ?product=360     → dataset table `spot_qc.responses_360`
//
// Required Vercel environment variables:
//   GCP_PROJECT_ID                   e.g. "spyne-reprocess"
//   GCP_SERVICE_ACCOUNT_JSON         full service-account key JSON (as a single-line string)
//
// The service account needs roles: BigQuery Data Viewer + BigQuery Job User
// on the spyne-reprocess project.

const { BigQuery } = require('@google-cloud/bigquery');

// Normalize every row to the SAME shape the front-end already expects, so no
// dashboard logic has to change. Each product maps its own columns onto these
// canonical fields.
//
// A WHERE clause on the partitioned Timestamp column keeps the payload small
// and fast. The dashboard passes ?days=N (default 120) so trends still work
// while avoiding shipping the entire multi-year table on every load.
const TABLE = { images: 'image_responses', '360': 'responses_360' };

const SELECT_COLS = {
  images: `
      Timestamp     AS ts,
      Enterprise    AS enterprise,
      QC_User       AS qcUser,
      Editing_User  AS editUser,
      SKU_ID        AS skuId,
      Image_ID      AS imageId,
      Issue         AS issue,
      Submit_Issue  AS submitIssue,
      Login_User    AS loginUser`,
  '360': `
      Timestamp     AS ts,
      Enterprise    AS enterprise,
      User          AS qcUser,
      CAST(NULL AS STRING) AS editUser,
      SKU_ID        AS skuId,
      Spin_ID       AS imageId,
      Issues        AS issue,
      Reason        AS submitIssue,
      QC_By         AS loginUser`,
};

function buildQuery(product, projectId, days) {
  const table = TABLE[product];
  const cols  = SELECT_COLS[product];
  // days<=0 means "all" (no date filter)
  const where = days > 0
    ? `WHERE Timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${days} DAY)`
    : '';
  return `
    SELECT ${cols}
    FROM \`${projectId}.spot_qc.${table}\`
    ${where}
    ORDER BY Timestamp
  `;
}

let bqClient = null;
const resultCache = {};   // warm-instance cache: key → { t, payload }
function getClient() {
  if (bqClient) return bqClient;
  const projectId = process.env.GCP_PROJECT_ID;
  const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
  bqClient = new BigQuery({ projectId, credentials });
  return bqClient;
}

module.exports = async (req, res) => {
  // CORS — allow the dashboard origin to call this endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const product = (req.query.product || 'images').toLowerCase();
  if (!TABLE[product]) {
    res.status(400).json({ error: `Unknown product: ${product}` });
    return;
  }

  // Date window (days). Default 120; ?days=0 or ?days=all → entire table.
  let days = 120;
  if (req.query.days !== undefined) {
    if (String(req.query.days).toLowerCase() === 'all') days = 0;
    else { const n = parseInt(req.query.days, 10); days = isNaN(n) ? 120 : n; }
  }

  try {
    const projectId = process.env.GCP_PROJECT_ID;
    const sql = buildQuery(product, projectId, days);

    // Warm-instance in-memory cache: if the same product+days was fetched in
    // the last 2 minutes on this function instance, return it instantly.
    const cacheKey = `${product}:${days}`;
    const now = Date.now();
    if (resultCache[cacheKey] && (now - resultCache[cacheKey].t) < 120000) {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      res.setHeader('X-Cache', 'HIT');
      res.status(200).json(resultCache[cacheKey].payload);
      return;
    }

    const [rows] = await getClient().query({
      query: sql,
      location: 'asia-south1',
      useQueryCache: true,       // reuse BigQuery's own cached results
      timeoutMs: 55000,          // fail before Vercel's function limit
    });

    // BigQuery TIMESTAMP comes back as a { value: 'ISO string' } object.
    const out = rows.map(r => ({
      timestamp:   r.ts && r.ts.value ? r.ts.value : (r.ts || ''),
      enterprise:  r.enterprise  || '',
      qcUser:      r.qcUser      || '',
      editUser:    r.editUser    || '',
      skuId:       r.skuId       || '',
      imageId:     r.imageId     || '',
      issue:       (r.issue || '').replace(/\s*\n\s*/g, ' | '),
      submitIssue: r.submitIssue || '',
      loginUser:   r.loginUser   || '',
    }));

    // Cache at the edge for 60s to cut BigQuery cost on rapid refreshes.
    const payload = { product, count: out.length, rows: out };
    resultCache[cacheKey] = { t: now, payload };
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
