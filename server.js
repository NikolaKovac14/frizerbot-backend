require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = { emails: { send: async () => console.log('Email skipped - no Resend key') } };

// ─── IN-MEMORY SALON DB ───────────────────────────────────────────────────────
const salons = {
  'salon_1': {
    id: 'salon_1',
    name: 'Salon Aurora',
    address: 'Čopova 5, Ljubljana',
    phone: '01 234 5678',
    hours: 'Pon-Pet: 8:00-20:00, Sob: 8:00-16:00',
    services: `
      - Ženski haircut: 25-45€
      - Moški haircut: 15-20€
      - Barvanje (celo): 60-120€
      - Balayage/highlights: 80-150€
      - Trajni kodri: 70-100€
      - Frizura za posebne priložnosti: 40-65€
      - Maniküra: 20-30€
      - Pedikura: 25-35€
    `,
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    notificationEmail: 'salon@aurora.si',
    active: true
  }
};

// ─── CHAT ENDPOINT ────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { salonId, messages, customerEmail, customerName } = req.body;
  const salon = salons[salonId];

  if (!salon || !salon.active) {
    return res.status(404).json({ error: 'Salon not found' });
  }

  const systemPrompt = buildSystemPrompt(salon);

  try {
    const data = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: messages
    });

    const reply = data.content[0].text;

    const bookingDetected = detectBooking(reply);
    if (bookingDetected && customerEmail) {
      await scheduleEmailReminder(salon, bookingDetected, customerEmail, customerName);
    }

    res.json({ reply, bookingDetected });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'API error' });
  }
});

// ─── BOOKING ENDPOINT ─────────────────────────────────────────────────────────
app.post('/booking', async (req, res) => {
  const { salonId, service, date, time, customerName, customerEmail, customerPhone } = req.body;
  const salon = salons[salonId];
  if (!salon) return res.status(404).json({ error: 'Salon not found' });

  try {
    let calendarEventId = null;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      calendarEventId = await addToCalendar(salon, { service, date, time, customerName, customerPhone });
    }

    if (customerEmail) {
      await sendConfirmation(salon, { service, date, time, customerName, customerEmail });
      await scheduleEmailReminder(salon, { service, date, time, customerName, customerEmail });
    }

    res.json({
      success: true,
      message: `Termin potrjen: ${service} dne ${date} ob ${time}`,
      calendarEventId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Booking error' });
  }
});

// ─── SALON MANAGEMENT ─────────────────────────────────────────────────────────
app.get('/salons', (req, res) => {
  res.json(Object.values(salons));
});

app.post('/salons', (req, res) => {
  const { name, address, phone, hours, services, notificationEmail } = req.body;
  const id = `salon_${Date.now()}`;
  salons[id] = { id, name, address, phone, hours, services, notificationEmail, active: true };
  res.json({ success: true, salonId: id });
});

app.put('/salons/:id', (req, res) => {
  if (!salons[req.params.id]) return res.status(404).json({ error: 'Not found' });
  salons[req.params.id] = { ...salons[req.params.id], ...req.body };
  res.json({ success: true });
});

// ─── HELPER: BUILD SYSTEM PROMPT ──────────────────────────────────────────────
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
- Opomnik pošljemo dan prej avtomatsko

PRAVILA:
- Nikoli si ne izmišljuj informacij
- Če ne veš, preusmeri na telefon: ${salon.phone}
- Bodi topel in prijazen kot pravi recepcionist`;
}

// ─── HELPER: DETECT BOOKING ───────────────────────────────────────────────────
function detectBooking(text) {
  const patterns = [/termin.*potrjen/i, /rezerviral/i, /booking confirmed/i];
  return patterns.some(p => p.test(text)) ? { detected: true } : null;
}

// ─── GOOGLE CALENDAR ──────────────────────────────────────────────────────────
async function addToCalendar(salon, booking) {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });

  const calendar = google.calendar({ version: 'v3', auth });
  const startDateTime = new Date(`${booking.date}T${booking.time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);

  const event = await calendar.events.insert({
    calendarId: salon.calendarId,
    requestBody: {
      summary: `${booking.service} – ${booking.customerName}`,
      description: `Tel: ${booking.customerPhone}`,
      start: { dateTime: startDateTime.toISOString(), timeZone: 'Europe/Ljubljana' },
      end: { dateTime: endDateTime.toISOString(), timeZone: 'Europe/Ljubljana' }
    }
  });

  return event.data.id;
}

// ─── EMAIL: POTRDITEV ─────────────────────────────────────────────────────────
async function sendConfirmation(salon, booking) {
  await resend.emails.send({
    from: 'noreply@frizerbot.si',
    to: booking.customerEmail,
    subject: `Potrjen termin – ${salon.name}`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;">
        <h2 style="color:#1a1410;">Vaš termin je potrjen ✅</h2>
        <p>Pozdravljeni ${booking.customerName},</p>
        <p>Vaš termin v salonu <strong>${salon.name}</strong> je uspešno rezerviran.</p>
        <div style="background:#faf7f2;padding:16px;border-radius:8px;margin:16px 0;">
          <p><strong>Storitev:</strong> ${booking.service}</p>
          <p><strong>Datum:</strong> ${booking.date}</p>
          <p><strong>Čas:</strong> ${booking.time}</p>
          <p><strong>Naslov:</strong> ${salon.address}</p>
        </div>
        <p>Dan pred terminom boste prejeli opomnik.</p>
        <p>Za spremembe nas pokličite: <a href="tel:${salon.phone}">${salon.phone}</a></p>
      </div>
    `
  });
}

// ─── EMAIL: OPOMNIK ───────────────────────────────────────────────────────────
async function scheduleEmailReminder(salon, booking) {
  const bookingDate = new Date(`${booking.date}T${booking.time}:00`);
  const reminderDate = new Date(bookingDate.getTime() - 24 * 60 * 60 * 1000);

  await resend.emails.send({
    from: 'noreply@frizerbot.si',
    to: booking.customerEmail,
    subject: `Opomnik: jutri ob ${booking.time} – ${salon.name}`,
    scheduledAt: reminderDate.toISOString(),
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;">
        <h2 style="color:#1a1410;">Opomnik za jutri 💇</h2>
        <p>Pozdravljeni ${booking.customerName},</p>
        <p>Jutri vas čaka termin v salonu <strong>${salon.name}</strong>.</p>
        <div style="background:#faf7f2;padding:16px;border-radius:8px;margin:16px 0;">
          <p><strong>Storitev:</strong> ${booking.service}</p>
          <p><strong>Čas:</strong> ${booking.time}</p>
          <p><strong>Naslov:</strong> ${salon.address}</p>
        </div>
        <p>Za odpoved ali spremembo pokličite: <a href="tel:${salon.phone}">${salon.phone}</a></p>
      </div>
    `
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FrizerBot backend running on port ${PORT}`));