/**
 * Optional Google Cloud Document AI preprocessing (runs on the server after burst capture).
 * Works best with Enterprise Document OCR; Custom Extractor may return text/layout without
 * pages[].image — then this returns null and the API falls back to sharp / raw image.
 */

import { JWT } from 'google-auth-library';

function documentAiDisabled() {
  const v = (process.env.DOCUMENT_AI_ENABLED || '').toLowerCase().trim();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

function parseServiceAccount() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64?.trim();
  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const creds = JSON.parse(decoded);
      if (typeof creds.client_email === 'string' && typeof creds.private_key === 'string') {
        return creds;
      }
    } catch {
      return null;
    }
  }
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    const creds = JSON.parse(raw);
    if (typeof creds.client_email !== 'string' || typeof creds.private_key !== 'string') {
      return null;
    }
    return creds;
  } catch {
    return null;
  }
}

function pickPageImageFromDocument(doc) {
  const pages = doc?.pages;
  if (!Array.isArray(pages)) return null;
  for (const page of pages) {
    const content = page?.image?.content;
    if (typeof content === 'string' && content.length >= 100) {
      const img = page.image;
      const outMime =
        img.mimeType ||
        img.mime_type ||
        (typeof img.contentType === 'string' ? img.contentType : null) ||
        'image/png';
      return { imageBase64: content, mimeType: outMime };
    }
  }
  return null;
}

function buildProcessorResource(project, location, processorId) {
  const version = process.env.DOCUMENT_AI_PROCESSOR_VERSION?.trim();
  const base = `projects/${project}/locations/${location}/processors/${processorId}`;
  if (version) {
    return `${base}/processorVersions/${version}`;
  }
  return base;
}

/**
 * @returns {Promise<{ imageBase64: string; mimeType: string } | null>}
 */
export async function tryDocumentAiPreprocess(imageBase64, mimeType) {
  if (process.env.VERCEL) return null;
  if (documentAiDisabled()) return null;

  const project =
    process.env.DOCUMENT_AI_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.GCP_PROJECT?.trim();
  const location = process.env.DOCUMENT_AI_LOCATION?.trim() || 'us';
  const processorId = process.env.DOCUMENT_AI_PROCESSOR_ID?.trim();
  if (!project || !processorId) return null;

  const creds = parseServiceAccount();
  if (!creds) return null;

  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  let token;
  try {
    const tok = await jwt.getAccessToken();
    token = typeof tok === 'string' ? tok : tok?.token;
  } catch (e) {
    console.warn('[Document AI] auth failed:', e instanceof Error ? e.message : e);
    return null;
  }
  if (!token) return null;

  const resource = buildProcessorResource(project, location, processorId);
  const apiRoot = process.env.DOCUMENT_AI_API_ROOT?.trim() || `https://${location}-documentai.googleapis.com/v1`;
  const url = `${apiRoot.replace(/\/$/, '')}/${resource}:process`;
  const bodyMime = typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';

  const attempts = [
    {
      label: 'fieldMask text,pages',
      body: {
        rawDocument: { mimeType: bodyMime, content: imageBase64 },
        fieldMask: 'text,pages',
      },
    },
    {
      label: 'no fieldMask',
      body: {
        rawDocument: { mimeType: bodyMime, content: imageBase64 },
      },
    },
  ];

  for (const attempt of attempts) {
    let res;
    let bodyStr;
    try {
      bodyStr = JSON.stringify(attempt.body);
    } catch (e) {
      console.warn('[Document AI] JSON body failed:', e instanceof Error ? e.message : e);
      continue;
    }
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: bodyStr,
      });
    } catch (e) {
      console.warn('[Document AI] request failed:', e instanceof Error ? e.message : e);
      continue;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || JSON.stringify(json).slice(0, 400);
      console.warn('[Document AI] HTTP', res.status, `(${attempt.label})`, msg);
      continue;
    }

    const picked = pickPageImageFromDocument(json.document);
    if (picked) {
      return picked;
    }

    const page0 = json.document?.pages?.[0];
    const keys = page0 ? Object.keys(page0).join(',') : 'no pages';
    console.warn('[Document AI] no page.image in response', `(${attempt.label})`, 'page0 keys:', keys);
  }

  return null;
}
