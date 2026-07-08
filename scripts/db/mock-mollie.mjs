// Minimal mock of the Mollie API for LOCAL E2E of the payment money-path. Point the edge
// functions at it with MOLLIE_API_BASE (e.g. http://host.docker.internal:54999). It implements
// just the endpoints the create-payment → webhook → commit loop touches:
//   GET  /v2/profiles         → one test profile (real profile API keys 403 on this; this unblocks it)
//   POST /v2/payments         → creates an 'open' payment, echoes amount+metadata, returns a checkout link
//   GET  /v2/payments/:id     → returns that payment as 'paid' (so the webhook re-fetch commits)
// No real money, no external calls — deterministic. Run: node scripts/db/mock-mollie.mjs
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_MOLLIE_PORT || 54999);
const payments = new Map();
let seq = 1;

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

createServer((req, res) => {
  const path = new URL(req.url, 'http://mock').pathname;

  if (req.method === 'GET' && path === '/v2/profiles') {
    return send(res, 200, { count: 1, _embedded: { profiles: [{ id: 'pfl_mock', mode: 'test', status: 'verified' }] } });
  }

  if (req.method === 'POST' && path === '/v2/payments') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch { /* ignore */ }
      const id = `tr_mock_${seq++}`;
      const p = { resource: 'payment', id, mode: 'test', status: 'open', amount: b.amount, description: b.description, metadata: b.metadata ?? {}, profileId: b.profileId ?? 'pfl_mock' };
      payments.set(id, p);
      return send(res, 201, { ...p, _links: { checkout: { href: `http://localhost:8080/mock-mollie-checkout?id=${id}`, type: 'text/html' } } });
    });
    return;
  }

  const m = path.match(/^\/v2\/payments\/(tr_mock_\d+)$/);
  if (req.method === 'GET' && m) {
    const p = payments.get(m[1]);
    if (!p) return send(res, 404, { status: 404, title: 'Not Found', detail: 'No payment exists with token ' + m[1] });
    // Simulate a completed test checkout: the re-fetch sees the payment as paid.
    return send(res, 200, { ...p, status: 'paid', paidAt: '2026-07-08T00:05:00+00:00' });
  }

  return send(res, 404, { status: 404, title: 'Not Found', detail: `mock-mollie: ${req.method} ${path}` });
}).listen(PORT, () => console.log(`mock-mollie listening on :${PORT}`));
