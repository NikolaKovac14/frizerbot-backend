if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = { emails: { send: async () => console.log('Email skipped - no Resend key') } };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      hours TEXT,
      services TEXT,
      calendar_id TEXT DEFAULT 'primary',
      notification_email TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query('SELECT id FROM salons WHERE id = $1', ['salon_1']);
  if (rows.length === 0) {
    await pool.query(`
      INSERT INTO salons (id, name, address, phone, hours, services, notification_email)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      'salon_1', 'Salon Aurora', 'Čopova 5, Ljubljana', '01 234 5678',
      'Pon-Pet: 8:00-20:00, Sob: 8:00-16:00',
      '- Ženski haircut: 25-45€\n- Moški haircut: 15-20€\n- Barvanje (celo): 60-120€\n- Balayage/highlights: 80-150€\n- Trajni kodri: 70-100€\n- Frizura za posebne priložnosti: 40-65€\n- Maniküra: 20-30€\n- Pedikura: 25-35€',
      'salon@aurora.si'
    ]);
    console.log('Demo salon dodan v DB');
  }
  console.log('DB inicializiran');
}

// ─── HOSTED CHAT STRAN ────────────────────────────────────────────────────────
app.get('/salon/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE id = $1 AND active = true', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).send('<h1>Salon not found</h1>');
  res.send(buildChatPage(salon));
});

function buildChatPage(salon) {
  const apiUrl = process.env.API_URL || 'https://frizerbot-backend-production.up.railway.app';
  return `<!DOCTYPE html>
<html lang="sl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${salon.name} – AI Asistent</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f0eb;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .header {
      width: 100%;
      background: #1a1410;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .header-avatar {
      width: 44px; height: 44px; border-radius: 50%;
      background: rgba(201,168,76,0.2);
      display: flex; align-items: center; justify-content: center;
      color: #c9a84c; font-size: 18px; font-weight: 700;
    }
    .header-info h1 { color: #fff; font-size: 16px; font-weight: 600; }
    .header-info p { color: #6b5f52; font-size: 12px; margin-top: 2px; }
    .header-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; margin-left: auto; }

    .chat-container {
      width: 100%; max-width: 640px;
      flex: 1; display: flex; flex-direction: column;
      height: calc(100vh - 65px);
    }
    .messages {
      flex: 1; overflow-y: auto; padding: 20px 16px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .messages::-webkit-scrollbar { width: 3px; }
    .messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 3px; }

    .msg { display: flex; flex-direction: column; max-width: 80%; }
    .msg.user { align-self: flex-end; align-items: flex-end; }
    .msg.bot { align-self: flex-start; }
    .bubble {
      padding: 10px 14px; border-radius: 18px;
      font-size: 14px; line-height: 1.5;
    }
    .msg.user .bubble {
      background: #1a1410; color: #f0ebe0;
      border-bottom-right-radius: 4px;
    }
    .msg.bot .bubble {
      background: #fff; color: #2d2520;
      border-bottom-left-radius: 4px;
      border: 0.5px solid rgba(0,0,0,0.08);
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }
    .msg-time { font-size: 10px; color: #aaa; margin-top: 4px; padding: 0 4px; }

    .typing {
      display: flex; gap: 4px; padding: 12px 14px;
      background: #fff; border-radius: 18px; border-bottom-left-radius: 4px;
      width: fit-content; border: 0.5px solid rgba(0,0,0,0.08);
    }
    .typing span {
      width: 6px; height: 6px; border-radius: 50%; background: #bbb;
      animation: bounce 1.2s infinite;
    }
    .typing span:nth-child(2) { animation-delay: 0.2s; }
    .typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 100% { transform: translateY(0); opacity: 0.4; }
      50% { transform: translateY(-5px); opacity: 1; }
    }

    .input-area {
      padding: 12px 16px;
      background: #fff;
      border-top: 1px solid rgba(0,0,0,0.08);
      display: flex; gap: 10px; align-items: center;
    }
    .input-area input {
      flex: 1; padding: 10px 16px; border-radius: 100px;
      border: 1px solid #ddd; font-size: 14px; outline: none;
      background: #faf7f2; font-family: inherit;
      transition: border-color 0.15s;
    }
    .input-area input:focus { border-color: #c9a84c; background: #fff; }
    .send-btn {
      width: 40px; height: 40px; border-radius: 50%;
      background: #1a1410; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.1s; flex-shrink: 0;
    }
    .send-btn:hover { transform: scale(1.05); background: #2d2218; }
    .send-btn svg { width: 16px; height: 16px; fill: #c9a84c; }

    .info-bar {
      background: #faf7f2;
      padding: 10px 16px;
      display: flex; gap: 16px; flex-wrap: wrap;
      border-bottom: 1px solid rgba(0,0,0,0.06);
      font-size: 12px; color: #6b5f52;
    }
    .info-bar span { display: flex; align-items: center; gap: 4px; }

    .powered {
      text-align: center; font-size: 11px; color: #bbb;
      padding: 6px; background: #fff;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-avatar">${salon.name.charAt(0)}</div>
    <div class="header-info">
      <h1>${salon.name}</h1>
      <p>AI Asistent • Odgovori v &lt; 10 sekund</p>
    </div>
    <div class="header-dot"></div>
  </div>

  <div class="chat-container">
    <div class="info-bar">
      <span>📍 ${salon.address}</span>
      <span>📞 ${salon.phone}</span>
      <span>🕐 ${salon.hours}</span>
    </div>
    <div class="messages" id="messages"></div>
    <div class="input-area">
      <input type="text" id="input" placeholder="Vpišite sporočilo..." />
      <button class="send-btn" id="send">
        <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
      </button>
    </div>
    <div class="powered">Poganja FrizerBot.si</div>
  </div>

  <script>
    const API_URL = '${apiUrl}';
    const SALON_ID = '${salon.id}';
    let messages = [];
    let isTyping = false;

    function getTime() {
      return new Date().toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
    }

    function addBotMsg(text) {
      const msgs = document.getElementById('messages');
      const div = document.createElement('div');
      div.className = 'msg bot';
      div.innerHTML = '<div class="bubble">' + text + '</div><div class="msg-time">' + getTime() + '</div>';
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function addUserMsg(text) {
      const msgs = document.getElementById('messages');
      const div = document.createElement('div');
      div.className = 'msg user';
      div.innerHTML = '<div class="bubble">' + text + '</div><div class="msg-time">' + getTime() + '</div>';
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function showTyping() {
      const msgs = document.getElementById('messages');
      const div = document.createElement('div');
      div.id = 'typing';
      div.className = 'msg bot';
      div.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function removeTyping() {
      document.getElementById('typing')?.remove();
    }

    async function sendMsg() {
      if (isTyping) return;
      const input = document.getElementById('input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      addUserMsg(text);
      messages.push({ role: 'user', content: text });
      isTyping = true;
      showTyping();
      try {
        const res = await fetch(API_URL + '/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ salonId: SALON_ID, messages })
        });
        const data = await res.json();
        removeTyping();
        addBotMsg(data.reply);
        messages.push({ role: 'assistant', content: data.reply });
      } catch(e) {
        removeTyping();
        addBotMsg('Oprostite, prišlo je do napake. Pokličite nas: ${salon.phone}');
      }
      isTyping = false;
    }

    document.getElementById('input').addEventListener('keydown', e => {
      if (e.key === 'Enter') sendMsg();
    });
    document.getElementById('send').addEventListener('click', sendMsg);

    // Pozdravno sporočilo
    setTimeout(() => {
      addBotMsg('Pozdravljeni! 👋 Sem AI asistent salona ${salon.name}. Pomagam z informacijami o storitvah, cenah in rezervacijah. Kako vam lahko pomagam?');
    }, 300);
  </script>
</body>
</html>`;
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { salonId, messages, customerEmail, customerName } = req.body;
  const { rows } = await pool.query('SELECT * FROM salons WHERE id = $1 AND active = true', [salonId]);
  const salon = rows[0];
  if (!salon) return res.status(404).json({ error: 'Salon not found' });

  try {
    const data = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: buildSystemPrompt(salon),
      messages: messages
    });
    const reply = data.content[0].text;
    res.json({ reply, bookingDetected: detectBooking(reply) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'API error' });
  }
});

// ─── BOOKING ──────────────────────────────────────────────────────────────────
app.post('/booking', async (req, res) => {
  const { salonId, service, date, time, customerName, customerEmail, customerPhone } = req.body;
  const { rows } = await pool.query('SELECT * FROM salons WHERE id = $1', [salonId]);
  const salon = rows[0];
  if (!salon) return res.status(404).json({ error: 'Salon not found' });

  try {
    let calendarEventId = null;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      calendarEventId = await addToCalendar(salon, { service, date, time, customerName, customerPhone });
    }
    if (customerEmail) {
      await sendConfirmation(salon, { service, date, time, customerName, customerEmail });
    }
    res.json({ success: true, message: 'Termin potrjen: ' + service + ' dne ' + date + ' ob ' + time, calendarEventId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Booking error' });
  }
});

// ─── SALON MANAGEMENT ─────────────────────────────────────────────────────────
app.get('/salons', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE active = true ORDER BY created_at');
  res.json(rows);
});

app.post('/salons', async (req, res) => {
  const { name, address, phone, hours, services, notificationEmail } = req.body;
  const id = 'salon_' + Date.now();
  await pool.query(
    'INSERT INTO salons (id, name, address, phone, hours, services, notification_email) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, name, address, phone, hours, services, notificationEmail]
  );
  res.json({ success: true, salonId: id });
});

app.put('/salons/:id', async (req, res) => {
  const { name, address, phone, hours, services, notificationEmail, active } = req.body;
  await pool.query(
    'UPDATE salons SET name=$1, address=$2, phone=$3, hours=$4, services=$5, notification_email=$6, active=$7 WHERE id=$8',
    [name, address, phone, hours, services, notificationEmail, active, req.params.id]
  );
  res.json({ success: true });
});

app.delete('/salons/:id', async (req, res) => {
  await pool.query('UPDATE salons SET active = false WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function buildSystemPrompt(salon) {
  return 'Si AI asistent za frizerski salon ' + salon.name + '. Odgovarjaš v slovenščini.\n' +
    'Si prijazen, profesionalen in jedrnat (max 2-3 stavki razen pri rezervacijah).\n\n' +
    'INFORMACIJE O SALONU:\n' +
    '- Ime: ' + salon.name + '\n' +
    '- Naslov: ' + salon.address + '\n' +
    '- Telefon: ' + salon.phone + '\n' +
    '- Delovni čas: ' + salon.hours + '\n\n' +
    'STORITVE IN CENIK:\n' + salon.services + '\n\n' +
    'NAVODILA ZA REZERVACIJE:\n' +
    '- Ko stranka želi rezervacijo, jo prijazno vprašaj za: ime, storitev, dan in čas\n' +
    '- Ko imaš vse podatke, reci da bo termin potrjen in da bo dobila email potrditev\n\n' +
    'PRAVILA:\n' +
    '- Nikoli si ne izmišljuj informacij\n' +
    '- Če ne veš, preusmeri na telefon: ' + salon.phone + '\n' +
    '- Bodi topel in prijazen kot pravi recepcionist';
}

function detectBooking(text) {
  const patterns = [/termin.*potrjen/i, /rezerviral/i, /booking confirmed/i];
  return patterns.some(p => p.test(text)) ? { detected: true } : null;
}

async function addToCalendar(salon, booking) {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/calendar'] });
  const calendar = google.calendar({ version: 'v3', auth });
  const startDateTime = new Date(booking.date + 'T' + booking.time + ':00');
  const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);
  const event = await calendar.events.insert({
    calendarId: salon.calendar_id,
    requestBody: {
      summary: booking.service + ' – ' + booking.customerName,
      description: 'Tel: ' + booking.customerPhone,
      start: { dateTime: startDateTime.toISOString(), timeZone: 'Europe/Ljubljana' },
      end: { dateTime: endDateTime.toISOString(), timeZone: 'Europe/Ljubljana' }
    }
  });
  return event.data.id;
}

async function sendConfirmation(salon, booking) {
  await resend.emails.send({
    from: 'noreply@frizerbot.si',
    to: booking.customerEmail,
    subject: 'Potrjen termin – ' + salon.name,
    html: '<p>Pozdravljeni ' + booking.customerName + ', vaš termin je potrjen: ' + booking.service + ' dne ' + booking.date + ' ob ' + booking.time + '.</p>'
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log('FrizerBot backend running on port ' + PORT);
});