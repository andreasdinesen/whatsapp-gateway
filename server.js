'use strict';

/*
 * WhatsApp Gateway
 * ----------------
 * Lille HTTP-bro oven på WhatsApp Web (Baileys). Sender beskeder via POST /send
 * og opfylder kontrakten fra Tilmeld (notifications.send_whatsapp):
 *
 *   POST /send
 *   Authorization: Bearer <API_KEY>   (kun hvis API_KEY er sat)
 *   Content-Type: application/json
 *   { "to": "<nummer eller gruppe-id>", "message": "<tekst>" }
 *
 * QR-login vises på GET /qr. Sessionen gemmes i DATA_DIR (default /data),
 * så man kun skal scanne QR én gang.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

// ---------------------------------------------------------------------------
// Konfiguration (env). Tomme variabler behandles som "ikke sat" (yggdrasil
// sender tomme variabler som faktiske tomme env-strenge — undgå den fælde).
// ---------------------------------------------------------------------------
const API_KEY = (process.env.API_KEY || '').trim();
const PORT = parseInt(process.env.PORT || '', 10) || 8080;

function pickDataDir() {
  const preferred = (process.env.DATA_DIR || '/data').trim() || '/data';
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch (_) {
    const fallback = path.join(process.cwd(), 'data');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const DATA_DIR = pickDataDir();
const AUTH_DIR = path.join(DATA_DIR, 'auth');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ---------------------------------------------------------------------------
// WhatsApp-forbindelse (Baileys)
// ---------------------------------------------------------------------------
let sock = null;
let connStatus = 'starting'; // starting | qr | open | close
let latestQR = null; // rå QR-streng til /qr
let meId = null; // eget nummer/JID når forbundet

// Lille lager over afsendte beskeder. Når en modtager-enhed ikke kan dekryptere
// en besked, sender den en "retry receipt" og beder os sende igen; uden dette
// lager kan vi ikke svare, og beskeden hænger på "Venter på denne besked".
const SENT_CACHE_MAX = 1000;
const sentMessages = new Map(); // key.id -> message (proto)

function rememberMessage(id, message) {
  if (!id || !message) return;
  sentMessages.set(id, message);
  if (sentMessages.size > SENT_CACHE_MAX) {
    // smid den ældste ud (Map bevarer indsættelsesrækkefølge)
    sentMessages.delete(sentMessages.keys().next().value);
  }
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp Gateway', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    // Bruges til at gen-sende en besked når en modtager-enhed beder om retry.
    getMessage: async (key) => sentMessages.get(key.id) || undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      connStatus = 'qr';
      console.log('[whatsapp] Ny QR-kode klar — scan den på /qr (eller herunder):');
      QRCode.toString(qr, { type: 'terminal', small: true })
        .then((s) => console.log(s))
        .catch(() => {});
    }

    if (connection === 'open') {
      latestQR = null;
      connStatus = 'open';
      meId = sock?.user?.id || null;
      console.log(`[whatsapp] Forbundet som ${meId}`);
    }

    if (connection === 'close') {
      connStatus = 'close';
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(
        `[whatsapp] Forbindelse lukket (kode ${statusCode}). ` +
          (loggedOut ? 'Logget ud — slet sessionen og scan QR igen.' : 'Genopretter...')
      );
      if (!loggedOut) {
        setTimeout(() => startSock().catch((e) => console.error('[whatsapp] reconnect-fejl', e)), 2000);
      } else {
        // Sessionen er ugyldig — ryd den så en ny QR kan dannes.
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (_) {}
        setTimeout(() => startSock().catch((e) => console.error('[whatsapp] reconnect-fejl', e)), 2000);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Modtager -> WhatsApp JID
//   - indeholder "@"            -> brug som-is (fuld JID, fx gruppe@g.us)
//   - "<tal>-<tal>"            -> ældre gruppe-id  -> @g.us
//   - 16+ cifre                -> moderne gruppe-id -> @g.us
//   - ellers                    -> telefonnummer    -> @s.whatsapp.net
// ---------------------------------------------------------------------------
function resolveJid(raw) {
  const to = String(raw == null ? '' : raw).trim();
  if (!to) throw new Error('tom modtager (to)');
  if (to.includes('@')) return to;
  if (/^\d+-\d+$/.test(to)) return `${to}@g.us`;
  if (/^\d{16,}$/.test(to)) return `${to}@g.us`;
  const digits = to.replace(/[^\d]/g, '');
  if (!digits) throw new Error(`ugyldig modtager: ${raw}`);
  return `${digits}@s.whatsapp.net`;
}

// ---------------------------------------------------------------------------
// HTTP-server
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

function requireAuth(req, res, next) {
  if (!API_KEY) return next(); // ingen nøgle konfigureret -> åben
  // Accepter enten Authorization-header (Tilmeld) eller ?key= (nem browser-adgang).
  const headerOk = (req.get('authorization') || '') === `Bearer ${API_KEY}`;
  const queryOk = req.query.key === API_KEY;
  if (!headerOk && !queryOk) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, status: connStatus, connected: connStatus === 'open' });
});

app.get('/qr', async (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (connStatus === 'open') {
    return res.send(`<!doctype html><html lang="da"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhatsApp Gateway</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:3rem auto;text-align:center;padding:0 1rem}
.ok{color:#128c7e;font-size:1.3rem}</style></head>
<body><h1>WhatsApp Gateway</h1>
<p class="ok">✅ Forbundet${meId ? ` som <code>${meId}</code>` : ''}</p>
<p>Klar til at sende beskeder via <code>POST /send</code>.</p></body></html>`);
  }

  let img = '';
  if (latestQR) {
    try {
      img = await QRCode.toDataURL(latestQR, { margin: 1, width: 320 });
    } catch (_) {}
  }
  res.send(`<!doctype html><html lang="da"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>WhatsApp Gateway — login</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:3rem auto;text-align:center;padding:0 1rem}
img{border:1px solid #ddd;border-radius:8px}.muted{color:#666}</style></head>
<body><h1>Scan QR for at logge ind</h1>
${img ? `<img src="${img}" alt="QR-kode" width="320" height="320">` : `<p class="muted">Venter på QR-kode... (status: ${connStatus})</p>`}
<p class="muted">Åbn WhatsApp → Indstillinger → Tilknyttede enheder → Tilknyt enhed.</p>
<p class="muted">Siden opdateres automatisk hvert 5. sekund.</p></body></html>`);
});

app.post('/send', requireAuth, async (req, res) => {
  const { to, message } = req.body || {};
  if (!to || typeof message !== 'string') {
    return res.status(400).json({ ok: false, error: 'kræver felterne "to" og "message"' });
  }
  if (connStatus !== 'open' || !sock) {
    console.error('[send] afvist — ikke forbundet til WhatsApp (status:', connStatus + ')');
    return res.status(503).json({ ok: false, error: 'ikke forbundet til WhatsApp — scan QR på /qr' });
  }
  let jid;
  try {
    jid = resolveJid(to);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  try {
    const result = await sock.sendMessage(jid, { text: message });
    rememberMessage(result?.key?.id, result?.message); // muliggør retry-svar
    console.log(`[send] -> ${jid}: ok (id ${result?.key?.id})`);
    return res.status(200).json({ ok: true, to: jid, id: result?.key?.id });
  } catch (e) {
    console.error(`[send] -> ${jid}: FEJL`, e?.message || e);
    return res.status(502).json({ ok: false, error: e?.message || 'send fejlede' });
  }
});

// Hjælpe-endpoint: list de grupper kontoen er med i, så man kan finde gruppe-id'et
// (@g.us) der skal sættes som "to" i Tilmeld. Åbn i browser: /groups?key=<API_KEY>
app.get('/groups', requireAuth, async (req, res) => {
  if (connStatus !== 'open' || !sock) {
    return res.status(503).json({ ok: false, error: 'ikke forbundet til WhatsApp — scan QR på /qr' });
  }
  let list;
  try {
    const groups = await sock.groupFetchAllParticipating();
    list = Object.values(groups)
      .map((g) => ({ id: g.id, name: g.subject || '(uden navn)', participants: (g.participants || []).length }))
      .sort((a, b) => a.name.localeCompare(b.name, 'da'));
  } catch (e) {
    console.error('[groups] FEJL', e?.message || e);
    return res.status(502).json({ ok: false, error: e?.message || 'kunne ikke hente grupper' });
  }

  if (req.accepts(['json', 'html']) === 'html') {
    const rows = list
      .map(
        (g) =>
          `<tr><td>${g.name}</td><td><code>${g.id}</code></td><td>${g.participants}</td></tr>`
      )
      .join('');
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!doctype html><html lang="da"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhatsApp Gateway — grupper</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.5rem .6rem;text-align:left}
th{background:#f4f4f4}code{background:#f4f4f4;padding:.1rem .3rem;border-radius:4px}.muted{color:#666}</style></head>
<body><h1>Grupper (${list.length})</h1>
<p class="muted">Kopiér <code>id</code>'et (slutter på <code>@g.us</code>) og brug det som <code>to</code> i Tilmeld.</p>
<table><thead><tr><th>Navn</th><th>Gruppe-id (to)</th><th>Deltagere</th></tr></thead>
<tbody>${rows || '<tr><td colspan="3" class="muted">Ingen grupper fundet</td></tr>'}</tbody></table>
</body></html>`);
  }
  res.json({ ok: true, count: list.length, groups: list });
});

app.listen(PORT, () => {
  console.log(`[whatsapp-gateway] listening on port ${PORT}`);
  console.log(`[whatsapp-gateway] data-mappe: ${DATA_DIR}`);
  console.log(`[whatsapp-gateway] auth: ${API_KEY ? 'API_KEY påkrævet' : 'ingen API_KEY (åben)'}`);
  console.log(`[whatsapp-gateway] åbn /qr for at logge ind`);
  startSock().catch((e) => console.error('[whatsapp] start-fejl', e));
});
