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
const QUERIES = {
  images: `
    SELECT
      Timestamp     AS ts,
      Enterprise    AS enterprise,
      QC_User       AS qcUser,
      Editing_User  AS editUser,
      SKU_ID        AS skuId,
      Image_ID      AS imageId,
      Issue         AS issue,
      Submit_Issue  AS submitIssue,
      Login_User    AS loginUser
    FROM \`{PROJECT}.spot_qc.image_responses\`
  `,
  '360': `
    SELECT
      Timestamp     AS ts,
      Enterprise    AS enterprise,
      User          AS qcUser,
      CAST(NULL AS STRING) AS editUser,
      SKU_ID        AS skuId,
      Spin_ID       AS imageId,
      Issues        AS issue,
      Reason        AS submitIssue,
      QC_By         AS loginUser
    FROM \`{PROJECT}.spot_qc.responses_360\`
  `,
};

let bqClient = null;
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
  const sqlTemplate = QUERIES[product];
  if (!sqlTemplate) {
    res.status(400).json({ error: `Unknown product: ${product}` });
    return;
  }

  try {
    const projectId = process.env.GCP_PROJECT_ID;
    const sql = sqlTemplate.replace('{PROJECT}', projectId);
    const [rows] = await getClient().query({ query: sql, location: 'asia-south1' });

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
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json({ product, count: out.length, rows: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
