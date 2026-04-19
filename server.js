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

const HOURS = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'];

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timeslots (
      id SERIAL PRIMARY KEY,
      salon_id TEXT REFERENCES salons(id),
      date DATE NOT NULL,
      time TEXT NOT NULL,
      status TEXT DEFAULT 'busy',
      customer_name TEXT,
      service TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(salon_id, date, time)
    )
  `);

  const { rows } = await pool.query('SELECT id FROM salons WHERE id = $1', ['salon_1']);
  if (rows.length === 0) {
    await pool.query(`
      INSERT INTO salons (id, name, address, phone, hours, services, notification_email)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      'salon_1', 'Salon Aurora', 'Copova 5, Ljubljana', '01 234 5678',
      'Pon-Pet: 8:00-20:00, Sob: 8:00-16:00',
      '- Zenski haircut: 25-45 EUR\n- Moski haircut: 15-20 EUR\n- Barvanje (celo): 60-120 EUR\n- Balayage/highlights: 80-150 EUR\n- Trajni kodri: 70-100 EUR\n- Frizura za posebne priloznosti: 40-65 EUR\n- Manikura: 20-30 EUR\n- Pedikura: 25-35 EUR',
      'salon@aurora.si'
    ]);
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

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
app.get('/admin/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE id = $1', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).send('<h1>Salon not found</h1>');
  res.send(buildAdminPage(salon));
});

app.get('/admin/:id/timeslots', async (req, res) => {
  const { date } = req.query;
  const { rows } = await pool.query(
    'SELECT * FROM timeslots WHERE salon_id = $1 AND date = $2 ORDER BY time',
    [req.params.id, date]
  );
  res.json(rows);
});

app.post('/admin/:id/timeslots', async (req, res) => {
  const { date, time, status, customerName, service } = req.body;
  if (status === 'busy') {
    await pool.query(`
      INSERT INTO timeslots (salon_id, date, time, status, customer_name, service)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (salon_id, date, time) DO UPDATE
      SET status = $4, customer_name = $5, service = $6
    `, [req.params.id, date, time, status, customerName, service]);
  } else {
    // Če postavimo nazaj na prost - izbrišemo iz DB
    await pool.query(
      'DELETE FROM timeslots WHERE salon_id = $1 AND date = $2 AND time = $3',
      [req.params.id, date, time]
    );
  }
  res.json({ success: true });
});

// ─── CHAT ─────────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { salonId, messages } = req.body;
  const { rows } = await pool.query('SELECT * FROM salons WHERE id = $1 AND active = true', [salonId]);
  const salon = rows[0];
  if (!salon) return res.status(404).json({ error: 'Salon not found' });

  // Pridobi ZASEDENE termine za naslednje 7 dni
  const today = new Date();
  const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { rows: busySlots } = await pool.query(
    "SELECT date, time FROM timeslots WHERE salon_id = $1 AND date >= $2 AND date <= $3 AND status = 'busy' ORDER BY date, time",
    [salonId, today.toISOString().split('T')[0], nextWeek.toISOString().split('T')[0]]
  );

  try {
    const data = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: buildSystemPrompt(salon, busySlots),
      messages: messages
    });
    const reply = data.content[0].text;
    res.json({ reply, bookingDetected: detectBooking(reply) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'API error' });
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

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function buildSystemPrompt(salon, busySlots) {
  // Izračunaj proste termine (vsi HOURS minus zasedeni)
  const busyByDate = {};
  busySlots.forEach(s => {
    const d = new Date(s.date).toISOString().split('T')[0];
    if (!busyByDate[d]) busyByDate[d] = new Set();
    busyByDate[d].add(s.time);
  });

  // Naslednji 7 dni
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const dayName = d.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'numeric' });
    const busy = busyByDate[dateStr] || new Set();
    const free = HOURS.filter(h => !busy.has(h));
    if (free.length > 0) {
      days.push(dayName + ': ' + free.join(', '));
    }
  }

  const slotsText = days.length > 0
    ? days.join('\n')
    : 'Vsi termini naslednji teden so prosti (08:00-19:00).';

  return 'Si AI asistent za frizerski salon ' + salon.name + '. Odgovarjas VEDNO in SAMO v slovenscini.\n' +
    'NIKOLI ne uporabi markdown formatiranja (**bold**, *italic*) - pisi navadno besedilo.\n' +
    'Si prijazen, profesionalen in jedrnat (max 2-3 stavki razen pri rezervacijah).\n\n' +
    'INFORMACIJE O SALONU:\n' +
    '- Ime: ' + salon.name + '\n' +
    '- Naslov: ' + salon.address + '\n' +
    '- Telefon: ' + salon.phone + '\n' +
    '- Delovni cas: ' + salon.hours + '\n\n' +
    'STORITVE IN CENIK:\n' + salon.services + '\n\n' +
    'PROSTI TERMINI (naslednji teden):\n' + slotsText + '\n\n' +
    'NAVODILA ZA REZERVACIJE:\n' +
    '- Ko stranka zeli rezervacijo, jo prijazno vprasaj za: ime, storitev, dan in cas\n' +
    '- Predlagaj proste termine iz zgornjega seznama\n' +
    '- Ko imas vse podatke, reci da bo termin potrjen\n\n' +
    'PRAVILA:\n' +
    '- Nikoli si ne izmisljuj informacij\n' +
    '- Ce ne ves, preusmeri na telefon: ' + salon.phone + '\n' +
    '- Bodi topel in prijazen kot pravi recepcionist';
}

function detectBooking(text) {
  const patterns = [/termin.*potrjen/i, /rezerviral/i, /booking confirmed/i];
  return patterns.some(p => p.test(text)) ? { detected: true } : null;
}

function buildChatPage(salon) {
  const apiUrl = process.env.API_URL || 'https://frizerbot-backend-production.up.railway.app';
  return `<!DOCTYPE html>
<html lang="sl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${salon.name} - AI Asistent</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f0eb; min-height: 100vh; display: flex; flex-direction: column; align-items: center; }
    .header { width: 100%; background: #1a1410; padding: 16px 24px; display: flex; align-items: center; gap: 14px; }
    .header-avatar { width: 44px; height: 44px; border-radius: 50%; background: rgba(201,168,76,0.2); display: flex; align-items: center; justify-content: center; color: #c9a84c; font-size: 18px; font-weight: 700; }
    .header-info h1 { color: #fff; font-size: 16px; font-weight: 600; }
    .header-info p { color: #6b5f52; font-size: 12px; margin-top: 2px; }
    .header-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; margin-left: auto; }
    .chat-container { width: 100%; max-width: 640px; flex: 1; display: flex; flex-direction: column; height: calc(100vh - 65px); }
    .messages { flex: 1; overflow-y: auto; padding: 20px 16px; display: flex; flex-direction: column; gap: 12px; }
    .msg { display: flex; flex-direction: column; max-width: 80%; }
    .msg.user { align-self: flex-end; align-items: flex-end; }
    .msg.bot { align-self: flex-start; }
    .bubble { padding: 10px 14px; border-radius: 18px; font-size: 14px; line-height: 1.5; }
    .msg.user .bubble { background: #1a1410; color: #f0ebe0; border-bottom-right-radius: 4px; }
    .msg.bot .bubble { background: #fff; color: #2d2520; border-bottom-left-radius: 4px; border: 0.5px solid rgba(0,0,0,0.08); box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .msg-time { font-size: 10px; color: #aaa; margin-top: 4px; padding: 0 4px; }
    .typing { display: flex; gap: 4px; padding: 12px 14px; background: #fff; border-radius: 18px; border-bottom-left-radius: 4px; width: fit-content; border: 0.5px solid rgba(0,0,0,0.08); }
    .typing span { width: 6px; height: 6px; border-radius: 50%; background: #bbb; animation: bounce 1.2s infinite; }
    .typing span:nth-child(2) { animation-delay: 0.2s; }
    .typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce { 0%, 100% { transform: translateY(0); opacity: 0.4; } 50% { transform: translateY(-5px); opacity: 1; } }
    .input-area { padding: 12px 16px; background: #fff; border-top: 1px solid rgba(0,0,0,0.08); display: flex; gap: 10px; align-items: center; }
    .input-area input { flex: 1; padding: 10px 16px; border-radius: 100px; border: 1px solid #ddd; font-size: 14px; outline: none; background: #faf7f2; font-family: inherit; }
    .input-area input:focus { border-color: #c9a84c; background: #fff; }
    .send-btn { width: 40px; height: 40px; border-radius: 50%; background: #1a1410; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .send-btn svg { width: 16px; height: 16px; fill: #c9a84c; }
    .info-bar { background: #faf7f2; padding: 10px 16px; display: flex; gap: 16px; flex-wrap: wrap; border-bottom: 1px solid rgba(0,0,0,0.06); font-size: 12px; color: #6b5f52; }
    .powered { text-align: center; font-size: 11px; color: #bbb; padding: 6px; background: #fff; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-avatar">${salon.name.charAt(0)}</div>
    <div class="header-info">
      <h1>${salon.name}</h1>
      <p>AI Asistent - Odgovori v manj kot 10 sekund</p>
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
      <input type="text" id="input" placeholder="Vpisite sporocilo..." />
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
    function getTime() { return new Date().toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' }); }
    function addBotMsg(text) {
      const msgs = document.getElementById('messages');
      const div = document.createElement('div');
      div.className = 'msg bot';
      div.innerHTML = '<div class="bubble">' + text + '</div><div class="msg-time">' + getTime() + '</div>';
      msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
    }
    function addUserMsg(text) {
      const msgs = document.getElementById('messages');
      const div = document.createElement('div');
      div.className = 'msg user';
      div.innerHTML = '<div class="bubble">' + text + '</div><div class="msg-time">' + getTime() + '</div>';
      msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
    }
    function showTyping() {
      const msgs = document.getElementById('messages');
      const div = document.createElement('div');
      div.id = 'typing'; div.className = 'msg bot';
      div.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
      msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
    }
    function removeTyping() { document.getElementById('typing')?.remove(); }
    async function sendMsg() {
      if (isTyping) return;
      const input = document.getElementById('input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      addUserMsg(text);
      messages.push({ role: 'user', content: text });
      isTyping = true; showTyping();
      try {
        const res = await fetch(API_URL + '/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ salonId: SALON_ID, messages })
        });
        const data = await res.json();
        removeTyping(); addBotMsg(data.reply);
        messages.push({ role: 'assistant', content: data.reply });
      } catch(e) {
        removeTyping();
        addBotMsg('Oprostite, prislo je do napake. Poklisite nas: ${salon.phone}');
      }
      isTyping = false;
    }
    document.getElementById('input').addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });
    document.getElementById('send').addEventListener('click', sendMsg);
    setTimeout(() => { addBotMsg('Pozdravljeni! Sem AI asistent salona ${salon.name}. Pomagam z informacijami o storitvah, cenah in rezervacijah. Kako vam lahko pomagam?'); }, 300);
  </script>
</body>
</html>`;
}

function buildAdminPage(salon) {
  const apiUrl = process.env.API_URL || 'https://frizerbot-backend-production.up.railway.app';
  return `<!DOCTYPE html>
<html lang="sl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin - ${salon.name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f0eb; min-height: 100vh; }
    .header { background: #1a1410; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { color: #c9a84c; font-size: 18px; }
    .header p { color: #6b5f52; font-size: 12px; }
    .container { max-width: 800px; margin: 24px auto; padding: 0 16px; }
    .date-nav { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; background: #fff; padding: 12px 16px; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .date-nav button { background: #1a1410; color: #c9a84c; border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; font-size: 16px; }
    .date-nav h2 { flex: 1; text-align: center; font-size: 16px; color: #2d2520; }
    .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
    .slot { background: #fff; border-radius: 10px; padding: 12px; text-align: center; cursor: pointer; border: 2px solid #4ade80; transition: all 0.15s; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .slot.busy { border-color: #f87171; background: #fff5f5; }
    .slot .time { font-size: 18px; font-weight: 600; color: #1a1410; }
    .slot .status { font-size: 11px; margin-top: 4px; color: #16a34a; }
    .slot.busy .status { color: #dc2626; }
    .slot .customer { font-size: 11px; color: #6b5f52; margin-top: 2px; }
    .legend { display: flex; gap: 16px; margin-bottom: 16px; font-size: 12px; color: #6b5f52; }
    .legend span { display: flex; align-items: center; gap: 6px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.free { background: #4ade80; }
    .dot.busy { background: #f87171; }
    .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center; }
    .modal.open { display: flex; }
    .modal-box { background: #fff; border-radius: 16px; padding: 24px; width: 300px; }
    .modal-box h3 { margin-bottom: 16px; color: #1a1410; }
    .modal-box label { display: block; font-size: 12px; color: #6b5f52; margin-bottom: 4px; margin-top: 12px; }
    .modal-box input { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
    .modal-btns { display: flex; gap: 8px; margin-top: 16px; }
    .btn { flex: 1; padding: 10px; border-radius: 8px; border: none; cursor: pointer; font-size: 14px; font-weight: 500; }
    .btn-busy { background: #fee2e2; color: #dc2626; }
    .btn-free { background: #dcfce7; color: #16a34a; }
    .btn-cancel { background: #f3f4f6; color: #6b7280; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Admin: ${salon.name}</h1>
      <p>Klikni na termin da ga oznacis kot zaseden</p>
    </div>
    <a href="/salon/${salon.id}" style="color:#c9a84c;font-size:12px;text-decoration:none;">Oglej chat stran</a>
  </div>
  <div class="container">
    <div class="date-nav">
      <button id="prev">&#8249;</button>
      <h2 id="dateTitle"></h2>
      <button id="next">&#8250;</button>
    </div>
    <div class="legend">
      <span><div class="dot free"></div> Prost (default)</span>
      <span><div class="dot busy"></div> Zaseden</span>
    </div>
    <div class="slots" id="slots"></div>
  </div>

  <div class="modal" id="modal">
    <div class="modal-box">
      <h3 id="modal-title">Termin</h3>
      <label>Ime stranke (opcijsko)</label>
      <input type="text" id="modal-customer" placeholder="Ime Priimek" />
      <label>Storitev (opcijsko)</label>
      <input type="text" id="modal-service" placeholder="Zenski haircut..." />
      <div class="modal-btns">
        <button class="btn btn-cancel" id="modal-cancel">Preklic</button>
        <button class="btn btn-free" id="modal-set-free">Prost</button>
        <button class="btn btn-busy" id="modal-set-busy">Zaseden</button>
      </div>
    </div>
  </div>

  <script>
    const API_URL = '${apiUrl}';
    const SALON_ID = '${salon.id}';
    const HOURS = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'];
    let currentDate = new Date();
    let currentSlot = null;
    let slotsData = {};

    function formatDate(d) { return d.toISOString().split('T')[0]; }
    function formatDateSl(d) { return d.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }

    async function loadSlots() {
      const dateStr = formatDate(currentDate);
      document.getElementById('dateTitle').textContent = formatDateSl(currentDate);
      const res = await fetch(API_URL + '/admin/' + SALON_ID + '/timeslots?date=' + dateStr);
      const data = await res.json();
      slotsData = {};
      data.forEach(s => { slotsData[s.time] = s; });
      renderSlots();
    }

    function renderSlots() {
      const container = document.getElementById('slots');
      container.innerHTML = '';
      HOURS.forEach(hour => {
        const slot = slotsData[hour];
        const isBusy = slot && slot.status === 'busy';
        const div = document.createElement('div');
        div.className = 'slot' + (isBusy ? ' busy' : '');
        div.innerHTML = '<div class="time">' + hour + '</div>' +
          '<div class="status">' + (isBusy ? 'Zaseden' : 'Prost') + '</div>' +
          (slot && slot.customer_name ? '<div class="customer">' + slot.customer_name + '</div>' : '');
        div.addEventListener('click', () => openModal(hour, slot));
        container.appendChild(div);
      });
    }

    function openModal(time, slot) {
      currentSlot = time;
      document.getElementById('modal-title').textContent = 'Termin ob ' + time;
      document.getElementById('modal-customer').value = slot ? (slot.customer_name || '') : '';
      document.getElementById('modal-service').value = slot ? (slot.service || '') : '';
      document.getElementById('modal').classList.add('open');
    }

    async function saveSlot(status) {
      const customerName = document.getElementById('modal-customer').value;
      const service = document.getElementById('modal-service').value;
      await fetch(API_URL + '/admin/' + SALON_ID + '/timeslots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: formatDate(currentDate), time: currentSlot, status, customerName, service })
      });
      document.getElementById('modal').classList.remove('open');
      loadSlots();
    }

    document.getElementById('modal-cancel').addEventListener('click', () => {
      document.getElementById('modal').classList.remove('open');
    });
    document.getElementById('modal-set-busy').addEventListener('click', () => saveSlot('busy'));
    document.getElementById('modal-set-free').addEventListener('click', () => saveSlot('free'));

    document.getElementById('prev').addEventListener('click', () => { currentDate.setDate(currentDate.getDate() - 1); loadSlots(); });
    document.getElementById('next').addEventListener('click', () => { currentDate.setDate(currentDate.getDate() + 1); loadSlots(); });

    loadSlots();
  </script>
</body>
</html>`;
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
      summary: booking.service + ' - ' + booking.customerName,
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
    subject: 'Potrjen termin - ' + salon.name,
    html: '<p>Pozdravljeni ' + booking.customerName + ', vas termin je potrjen: ' + booking.service + ' dne ' + booking.date + ' ob ' + booking.time + '.</p>'
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log('FrizerBot backend running on port ' + PORT);
});