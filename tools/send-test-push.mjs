#!/usr/bin/env node
// Send ONE test APNs alert to a device token, mirroring src/lib/server/apns.ts
// (ES256 provider JWT + HTTP/2 to api.push.apple.com). Self-contained — no app
// imports. Reads APNS_* from the environment (run with `node --env-file=.env`).
//
// Usage: node --env-file=.env tools/send-test-push.mjs "<device-token>" ["title"] ["body"]
import crypto from 'node:crypto';
import http2 from 'node:http2';
import fs from 'node:fs';

const token = process.argv[2];
const title = process.argv[3] || 'Sully';
const body = process.argv[4] || 'Push is live — your phone is wired up. 🎉';
if (!token) {
	console.error('no device token given');
	process.exit(1);
}

const keyPath = process.env.APNS_KEY_PATH;
const keyId = process.env.APNS_KEY_ID;
const teamId = process.env.APNS_TEAM_ID;
const bundleId = process.env.APNS_BUNDLE_ID;
const production = String(process.env.APNS_PRODUCTION).toLowerCase() !== 'false';

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
const signingInput = `${header}.${claims}`;
const der = crypto.createSign('SHA256').update(signingInput).sign({
	key: fs.readFileSync(keyPath, 'utf8'),
	dsaEncoding: 'ieee-p1363'
});
const jwt = `${signingInput}.${b64url(der)}`;

const host = production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
const payload = JSON.stringify({ aps: { alert: { title, body }, sound: 'default' }, url: '/companion/chat' });

const client = http2.connect(host);
client.on('error', (e) => { console.error('connect_error', e.message); process.exit(1); });
const req = client.request({
	':method': 'POST',
	':path': `/3/device/${token}`,
	authorization: `bearer ${jwt}`,
	'apns-topic': bundleId,
	'apns-push-type': 'alert',
	'content-type': 'application/json'
});
let status = 0, data = '';
req.on('response', (h) => { status = Number(h[':status']) || 0; });
req.setEncoding('utf8');
req.on('data', (c) => (data += c));
req.on('end', () => {
	client.close();
	console.log(`APNs response: ${status}${data ? ' ' + data : ''}`);
	console.log(status === 200 ? 'SENT_OK' : 'SEND_FAILED');
	process.exit(status === 200 ? 0 : 2);
});
req.on('error', (e) => { client.close(); console.error('request_error', e.message); process.exit(1); });
req.end(payload);
