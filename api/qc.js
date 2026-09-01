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

// AGGREGATED at the grain (day, enterprise, qcUser, editUser, submitIssue,
// loginUser) with COUNT(*) AS n. This collapses ~435k raw rows to ~60k
// summarized rows, so the function returns in seconds instead of paginating
// hundreds of thousands of rows for minutes (which crashed the browser).
//
// `day` is the QC SHIFT-DAY in IST, not the calendar day. The Spot QC team
// works 5 PM → 5 AM, so a shift is labeled by the date it STARTED: the window
// [D 17:00, D+1 17:00) all belongs to day D. We shift the boundary from
// midnight to 17:00 by subtracting 17 hours before taking the IST date, so a
// correction at 2 AM on the 16th correctly counts as the 15th's shift.
// (India has no DST, so the fixed offset makes this exact.)
const SELECT_COLS = {
  images: `
      FORMAT_DATE('%Y-%m-%d', DATE(TIMESTAMP_SUB(Timestamp, INTERVAL 17 HOUR), 'Asia/Kolkata')) AS day,
      Enterprise    AS enterprise,
      QC_User       AS qcUser,
      Editing_User  AS editUser,
      Submit_Issue  AS submitIssue,
      Login_User    AS loginUser,
      COUNT(*)      AS n`,
  '360': `
      FORMAT_DATE('%Y-%m-%d', DATE(TIMESTAMP_SUB(Timestamp, INTERVAL 17 HOUR), 'Asia/Kolkata')) AS day,
      Enterprise    AS enterprise,
      User          AS qcUser,
      CAST(NULL AS STRING) AS editUser,
      Reason        AS submitIssue,
      QC_By         AS loginUser,
      COUNT(*)      AS n`,
};

// Grouping columns (everything selected except the COUNT and the constant-NULL
// editUser for 360). Grouping by output alias is supported in BigQuery.
const GROUP_BY = {
  images: 'GROUP BY day, enterprise, qcUser, editUser, submitIssue, loginUser',
  '360':  'GROUP BY day, enterprise, qcUser, submitIssue, loginUser',
};

function buildQuery(product, projectId, days) {
  const table = TABLE[product];
  const cols  = SELECT_COLS[product];

  // Always drop future-dated rows. A QC event cannot occur in the future, so
  // any Timestamp > now is corrupt data (a bulk backfill was writing the
  // insertion time — dated months ahead — instead of the real QC time). This
  // guard applies even when days='all', so those rows never reach the
  // dashboard, KPIs, or the Slack report.
  const conds = ['Timestamp <= CURRENT_TIMESTAMP()'];
  if (days > 0) {
    conds.push(`Timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${days} DAY)`);
  }
  const where = 'WHERE ' + conds.join(' AND ');

  return `
    SELECT ${cols}
    FROM \`${projectId}.spot_qc.${table}\`
    ${where}
    ${GROUP_BY[product]}
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

    // Aggregated rows: day (IST 'YYYY-MM-DD' string) + dimensions + count n.
    const out = rows.map(r => ({
      day:         r.day         || '',
      enterprise:  r.enterprise  || '',
      qcUser:      r.qcUser      || '',
      editUser:    r.editUser    || '',
      submitIssue: r.submitIssue || '',
      loginUser:   r.loginUser   || '',
      n:           Number(r.n)   || 0,
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
