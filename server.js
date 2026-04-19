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

// ─── POSTGRES ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
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
    res.json({ success: true, message: `Termin potrjen: ${service} dne ${date} ob ${time}`, calendarEventId });
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
  const id = `salon_${Date.now()}`;
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
  return `Si AI asistent za frizerski salon ${salon.name}. Odgovarjaš v slovenščini.
Si prijazen, profesionalen in jedrnat (max 2-3 stavki razen pri rezervacijah).

INFORMACIJE O SALONU:
- Ime: ${salon.name}
- Naslov: ${salon.address}
- Telefon: ${salon.phone}
- Delovni čas: ${salon.hours}

STORITVE IN CENIK:
${salon.services}

NAVODILA ZA REZERVACIJE:
- Ko stranka želi rezervacijo, jo prijazno vprašaj za: ime, storitev, dan in čas
- Ko imaš vse podatke, reci da bo termin potrjen in da bo dobila email potrditev

PRAVILA:
- Nikoli si ne izmišljuj informacij
- Če ne veš, preusmeri na telefon: ${salon.phone}
- Bodi topel in prijazen kot pravi recepcionist`;
}

function detectBooking(text) {
  const patterns = [/termin.*potrjen/i, /rezerviral/i, /booking confirmed/i];
  return patterns.some(p => p.test(text)) ? { detected: true } : null;
}

async function addToCalendar(salon, booking) {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/calendar'] });
  const calendar = google.calendar({ version: 'v3', auth });
  const startDateTime = new Date(`${booking.date}T${booking.time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);
  const event = await calendar.events.insert({
    calendarId: salon.calendar_id,
    requestBody: {
      summary: `${booking.service} – ${booking.customerName}`,
      description: `Tel: ${booking.customerPhone}`,
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
    subject: `Potrjen termin – ${salon.name}`,
    html: `<p>Pozdravljeni ${booking.customerName}, vaš termin je potrjen: ${booking.service} dne ${booking.date} ob ${booking.time}.</p>`
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`FrizerBot backend running on port ${PORT}`);
});