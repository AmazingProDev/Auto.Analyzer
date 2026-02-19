const HOP_BY_HOP_HEADERS = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'accept-encoding',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto'
]);

function normalizeBaseUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    return s.replace(/\/+$/, '');
}

function getBackendBaseUrl() {
    return normalizeBaseUrl(
        process.env.OPTIM_BACKEND_URL ||
        process.env.RAILWAY_BACKEND_URL ||
        process.env.API_BASE_URL
    );
}

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function toOutboundHeaders(inHeaders) {
    const out = {};
    Object.entries(inHeaders || {}).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        const lk = String(key || '').toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lk)) return;
        out[key] = Array.isArray(value) ? value.join(', ') : String(value);
    });
    return out;
}

module.exports = async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    const baseUrl = getBackendBaseUrl();
    if (!baseUrl) {
        res.status(500).json({
            status: 'error',
            message: 'Missing backend URL. Set OPTIM_BACKEND_URL in Vercel project environment variables.'
        });
        return;
    }

    const incoming = new URL(req.url || '/', 'http://localhost');
    const targetUrl = `${baseUrl}${incoming.pathname}${incoming.search}`;

    const init = {
        method: req.method,
        headers: toOutboundHeaders(req.headers),
        redirect: 'manual'
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        const body = await readRawBody(req);
        if (body.length > 0) init.body = body;
    }

    let upstream;
    try {
        upstream = await fetch(targetUrl, init);
    } catch (err) {
        res.status(502).json({
            status: 'error',
            message: 'Failed to reach backend URL',
            detail: err && err.message ? err.message : String(err)
        });
        return;
    }

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
        const lk = String(key || '').toLowerCase();
        if (lk === 'transfer-encoding' || lk === 'connection') return;
        res.setHeader(key, value);
    });

    const payload = Buffer.from(await upstream.arrayBuffer());
    res.send(payload);
};
