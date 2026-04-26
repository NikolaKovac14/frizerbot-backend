if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const sgMail = require('@sendgrid/mail');

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Privzeti urnik: pon-pet 8-20, sob 8-14, ned zaprto
const DEFAULT_SCHEDULE = {
  mon: { open: true,  from: '08:00', to: '20:00' },
  tue: { open: true,  from: '08:00', to: '20:00' },
  wed: { open: true,  from: '08:00', to: '20:00' },
  thu: { open: true,  from: '08:00', to: '20:00' },
  fri: { open: true,  from: '08:00', to: '20:00' },
  sat: { open: true,  from: '08:00', to: '14:00' },
  sun: { open: false, from: '08:00', to: '16:00' }
};

// Vrne seznam terminov na pol ure za določen datum glede na urnik salona
function getHoursForDate(schedule, dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dayMap = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayKey = dayMap[d.getDay()];
  const daySchedule = (schedule && schedule[dayKey]) || DEFAULT_SCHEDULE[dayKey];
  if (!daySchedule || !daySchedule.open) return [];
  return generateHalfHourSlots(daySchedule.from, daySchedule.to);
}

// Generira termine na pol ure med from in to
function generateHalfHourSlots(from, to) {
  const slots = [];
  let [h, m] = (from || '08:00').split(':').map(Number);
  const [endH, endM] = (to || '20:00').split(':').map(Number);
  while (h < endH || (h === endH && m < endM)) {
    slots.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
    m += 30;
    if (m >= 60) { m -= 60; h++; }
  }
  return slots;
}

// Berljiv prikaz urnika za system prompt
function scheduleToText(schedule) {
  const s = schedule || DEFAULT_SCHEDULE;
  const dayNames = { mon: 'Ponedeljek', tue: 'Torek', wed: 'Sreda', thu: 'Četrtek', fri: 'Petek', sat: 'Sobota', sun: 'Nedelja' };
  return Object.entries(dayNames).map(([key, name]) => {
    const d = s[key] || DEFAULT_SCHEDULE[key];
    if (!d || !d.open) return name + ': zaprto';
    return name + ': ' + d.from + ' - ' + d.to;
  }).join('\n');
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      hours TEXT,
      services TEXT,
      schedule JSONB DEFAULT NULL,
      calendar_id TEXT DEFAULT 'primary',
      notification_email TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Dodaj schedule kolono če še ne obstaja (za obstoječe baze)
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS schedule JSONB DEFAULT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS timeslots (
      id SERIAL PRIMARY KEY,
      salon_id TEXT REFERENCES salons(id),
      date DATE NOT NULL,
      time TEXT NOT NULL,
      status TEXT DEFAULT 'busy',
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      service TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(salon_id, date, time)
    )
  `);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'salon'`);
  const { rows } = await pool.query('SELECT id FROM salons WHERE id = $1', ['salon_1']);
  if (rows.length === 0) {
    await pool.query(`
      INSERT INTO salons (id, name, address, phone, hours, services, notification_email, schedule)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      'salon_1', 'Salon Aurora', 'Copova 5, Ljubljana', '01 234 5678',
      'Pon-Pet: 8:00-20:00, Sob: 8:00-14:00, Ned: zaprto',
      '- Ženski haircut: 25-45 EUR\n- Moški haircut: 15-20 EUR\n- Barvanje (celo): 60-120 EUR\n- Balayage/highlights: 80-150 EUR\n- Trajni kodri: 70-100 EUR\n- Frizura za posebne priložnosti: 40-65 EUR\n- Manikura: 20-30 EUR\n- Pedikura: 25-35 EUR',
      'salon@aurora.si',
      JSON.stringify(DEFAULT_SCHEDULE)
    ]);
  }
  console.log('DB inicializiran');
}

// ─── EMAIL FUNKCIJE ──────────────────────────────────────────────────────────
async function sendConfirmationEmail(customerEmail, customerName, salon, date, time, service) {
  try {
    const dateLj = new Date(date + 'T00:00:00');
    const dateFormatted = dateLj.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const msg = {
      to: customerEmail,
      from: process.env.SENDGRID_FROM_EMAIL || 'noreply@bookwell.si',
      subject: `✅ Rezervacija potrjena - ${salon.name}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #2d2520;">
          <div style="background: #1a1410; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #c9a84c; margin: 0; font-size: 24px;">✅ Rezervacija Potrjena</h1>
          </div>
          <div style="background: #fff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <p style="margin: 0 0 20px 0; font-size: 16px;">Pozdravljeni <strong>${customerName}</strong>,</p>
            <p style="margin: 0 0 25px 0; font-size: 14px; color: #6b5f52;">Vaša rezervacija je bila uspešno potrjena. Podrobnosti so spodaj:</p>
            <div style="background: #f5f0eb; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">📅 Datum:</span>
                <strong style="color: #1a1410;">${dateFormatted}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">🕐 Ura:</span>
                <strong style="color: #1a1410;">${time}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">💇 Storitev:</span>
                <strong style="color: #1a1410;">${service}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 14px; border-top: 1px solid rgba(0,0,0,0.1); padding-top: 12px;">
                <span style="color: #6b5f52;">📍 Naslov:</span>
                <strong style="color: #1a1410;">${salon.address}</strong>
              </div>
            </div>
            <div style="background: #dcfce7; border-left: 4px solid #4ade80; padding: 15px; border-radius: 4px; margin-bottom: 25px; font-size: 13px; color: #16a34a;">
              <strong>💡 Nasvet:</strong> Prosimo, pridite 5 minut prej. Če morate odpovedati termin, nas pokličite na ${salon.phone}.
            </div>
            <div style="border-top: 1px solid #e5e7eb; padding-top: 20px;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                Če potrebujete pomoč ali želite odpovedati termin, nas kontaktirajte:<br>
                📞 <strong>${salon.phone}</strong><br>
                📧 <strong>${salon.notification_email}</strong>
              </p>
            </div>
          </div>
          <div style="text-align: center; padding: 15px; font-size: 11px; color: #aaa;">
            <p style="margin: 0;">Poganja BookWell.si</p>
          </div>
        </div>
      `
    };
    await sgMail.send(msg);
    console.log('✅ Potrditveni e-mail poslan stranki:', customerEmail);
  } catch (err) {
    console.error('❌ Napaka pri pošiljanju e-maila stranki:', err);
  }
}

async function sendNotificationToSalon(salon, customerName, customerEmail, customerPhone, date, service, time) {
  try {
    const dateLj = new Date(date + 'T00:00:00');
    const dateFormatted = dateLj.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const msg = {
      to: salon.notification_email,
      from: process.env.SENDGRID_FROM_EMAIL || 'noreply@bookwell.si',
      subject: `🔔 Nova Rezervacija - ${salon.name} (${dateFormatted} ${time})`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #2d2520;">
          <div style="background: #1a1410; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #c9a84c; margin: 0; font-size: 24px;">🔔 Nova Rezervacija</h1>
          </div>
          <div style="background: #fff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <p style="margin: 0 0 20px 0; font-size: 16px;">Nova rezervacija v salonu <strong>${salon.name}</strong>!</p>
            <div style="background: #f5f0eb; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">👤 Ime:</span>
                <strong style="color: #1a1410;">${customerName}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">📞 Telefon:</span>
                <strong style="color: #1a1410;"><a href="tel:${customerPhone}" style="color: #1a1410; text-decoration: none;">${customerPhone}</a></strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">📧 E-pošta:</span>
                <strong style="color: #1a1410;"><a href="mailto:${customerEmail}" style="color: #1a1410; text-decoration: none;">${customerEmail}</a></strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">📅 Datum:</span>
                <strong style="color: #1a1410;">${dateFormatted}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">🕐 Ura:</span>
                <strong style="color: #1a1410;">${time}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 14px; border-top: 1px solid rgba(0,0,0,0.1); padding-top: 12px;">
                <span style="color: #6b5f52;">💇 Storitev:</span>
                <strong style="color: #1a1410;">${service}</strong>
              </div>
            </div>
            <div style="text-align: center;">
              <a href="${process.env.API_URL || 'https://bookwell.si'}/admin/${salon.id}" style="background: #1a1410; color: #c9a84c; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600; font-size: 14px;">
                Odpri Admin Panel
              </a>
            </div>
          </div>
          <div style="text-align: center; padding: 15px; font-size: 11px; color: #aaa;">
            <p style="margin: 0;">Poganja BookWell.si</p>
          </div>
        </div>
      `
    };
    await sgMail.send(msg);
    console.log('✅ Obvestilo e-mail poslano salonu:', salon.notification_email);
  } catch (err) {
    console.error('❌ Napaka pri pošiljanju obvestila salonu:', err);
  }
}

// ─── HOSTED CHAT STRAN ────────────────────────────────────────────────────────
app.get('/salon/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1) AND active = true', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).send('<h1>Salon not found</h1>');
  res.send(buildChatPage(salon));
});

app.get('/studio/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1) AND active = true', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).send('<h1>Not found</h1>');
  res.send(buildChatPage(salon));
});

app.get('/bar/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1) AND active = true', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).send('<h1>Not found</h1>');
  res.send(buildChatPage(salon));
});

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
app.get('/admin/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).send('<h1>Salon not found</h1>');
  res.send(buildAdminPage(salon));
});

app.get('/admin/:id/timeslots', async (req, res) => {
  const { date } = req.query;
  const { rows: salonRows } = await pool.query('SELECT id FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salonId = salonRows[0]?.id || req.params.id;
  const { rows } = await pool.query(
    'SELECT * FROM timeslots WHERE salon_id = $1 AND date = $2 ORDER BY time',
    [salonId, date]
  );
  res.json(rows);
});

app.post('/admin/:id/timeslots', async (req, res) => {
  const { date, time, status, customerName, service } = req.body;
  const { rows: salonRows } = await pool.query('SELECT id FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salonId = salonRows[0]?.id || req.params.id;
  if (status === 'busy') {
    await pool.query(`
      INSERT INTO timeslots (salon_id, date, time, status, customer_name, service)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (salon_id, date, time) DO UPDATE
      SET status = $4, customer_name = $5, service = $6
    `, [salonId, date, time, status, customerName, service]);
  } else {
    await pool.query('DELETE FROM timeslots WHERE salon_id = $1 AND date = $2 AND time = $3', [salonId, date, time]);
  }
  res.json({ success: true });
});

// ─── SCHEDULE ENDPOINT ────────────────────────────────────────────────────────
app.get('/admin/:id/schedule', async (req, res) => {
  const { rows: salonRows } = await pool.query('SELECT id FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salonId = salonRows[0]?.id || req.params.id;
  const { rows } = await pool.query('SELECT schedule FROM salons WHERE id = $1', [salonId]);
  res.json(rows[0]?.schedule || DEFAULT_SCHEDULE);
});

app.post('/admin/:id/schedule', async (req, res) => {
  const { rows: salonRows } = await pool.query('SELECT id FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salonId = salonRows[0]?.id || req.params.id;
  await pool.query('UPDATE salons SET schedule = $1 WHERE id = $2', [JSON.stringify(req.body), salonId]);
  res.json({ success: true });
});

// ─── BOOKING ENDPOINT ─────────────────────────────────────────────────────────
app.post('/booking', async (req, res) => {
  const { salonId, date, time, customerName, customerEmail, customerPhone, service } = req.body;
  if (!salonId || !date || !time || !customerName || !service) {
    return res.status(400).json({ error: 'Manjkajo podatki' });
  }

  const { rows: salonRows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1)', [salonId]);
  const salon = salonRows[0];
  if (!salon) return res.status(404).json({ error: 'Salon not found' });

  const { rows: existing } = await pool.query(
    "SELECT * FROM timeslots WHERE salon_id = $1 AND date = $2 AND time = $3 AND status = 'busy'",
    [salon.id, date, time]
  );
  if (existing.length > 0) return res.status(409).json({ error: 'Ta termin je že zaseden.' });

  await pool.query(`
    INSERT INTO timeslots (salon_id, date, time, status, customer_name, customer_email, customer_phone, service)
    VALUES ($1, $2, $3, 'busy', $4, $5, $6, $7)
    ON CONFLICT (salon_id, date, time) DO UPDATE
    SET status = 'busy', customer_name = $4, customer_email = $5, customer_phone = $6, service = $7
  `, [salon.id, date, time, customerName, customerEmail || '', customerPhone || '', service]);

  if (customerEmail) await sendConfirmationEmail(customerEmail, customerName, salon, date, time, service);
  if (salon.notification_email) await sendNotificationToSalon(salon, customerName, customerEmail || '', customerPhone || '', date, service, time);
  res.json({ success: true });
});

// ─── CHAT ─────────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { salonId, messages, customerInfo } = req.body;
  const filteredMessages = (messages || []).filter(m => m && m.content && m.content.trim() !== '');
  
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1) AND active = true', [salonId]);
  const salon = rows[0];
  if (!salon) return res.status(404).json({ error: 'Salon not found' });

  const actualSalonId = salon.id;
  const todayLj = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Ljubljana' }));
  const nextWeek = new Date(todayLj.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { rows: busySlots } = await pool.query(
    "SELECT date, time FROM timeslots WHERE salon_id = $1 AND date >= $2 AND date <= $3 AND status = 'busy' ORDER BY date, time",
    [actualSalonId, todayLj.toISOString().split('T')[0], nextWeek.toISOString().split('T')[0]] // ← actualSalonId
  );

  try {
    const data = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: buildSystemPrompt(salon, busySlots, customerInfo),
      messages: filteredMessages
    });

    const raw = data.content[0].text;
    console.log('✅ Bot response:', raw);

    const deleteMatch = raw.match(/\[\[DELETE:([^\]]+)\]\]/);
    if (deleteMatch) {
      try {
        const [date, time] = deleteMatch[1].trim().split('T');
        if (date && time) {
          const result = await pool.query(
            'DELETE FROM timeslots WHERE salon_id = $1 AND date = $2 AND time = $3',
            [actualSalonId, date, time] // ← actualSalonId
          );
          console.log('✅ Termin izbrisan - rows:', result.rowCount);
        }
      } catch (e) {
        console.error('❌ DELETE napaka:', e.message);
      }
    }

    const bookingMatch = raw.match(/\[\[BOOKING:\s*(\{[\s\S]*?\})\s*\]\]/);
    if (bookingMatch) {
      let booking;
      try {
        booking = JSON.parse(bookingMatch[1]);
      } catch (e) {
        const reply = raw.replace(/\[\[DELETE:[^\]]*\]\]/g, '').replace(/\[\[BOOKING:[\s\S]*?\]\]/g, '').trim();
        return res.json({ reply: reply + '\n\nOprostite, prišlo je do tehnične napake. Pokličite nas na ' + salon.phone, bookingDetected: null });
      }

      const { rows: existing } = await pool.query(
        "SELECT * FROM timeslots WHERE salon_id = $1 AND date = $2 AND time = $3 AND status = 'busy'",
        [actualSalonId, booking.date, booking.time] // ← actualSalonId
      );
      if (existing.length > 0) {
        if (existing[0].customer_email === finalEmail) {
          await pool.query(`UPDATE timeslots SET service=$1 WHERE salon_id=$2 AND date=$3 AND time=$4`,
            [finalService, actualSalonId, booking.date, booking.time]);
          const reply = raw.replace(/\[\[DELETE:[^\]]*\]\]/g, '').replace(/\[\[BOOKING:[\s\S]*?\]\]/g, '').trim();
          return res.json({ reply, bookingDetected: { date: booking.date, time: booking.time, customerName: finalName, service: finalService, email: finalEmail, phone: finalPhone }});
        }
        return res.json({ reply: 'Oprostite, ta termin je bil ravnokar zaseden. Izberite drug termin.', bookingDetected: null });
      }

      const cInfo = customerInfo || {};
      const finalName = booking.customerName || cInfo.name || 'Neznano';
      const finalEmail = cInfo.email || booking.customerEmail || '';
      const finalPhone = cInfo.phone || booking.customerPhone || '';
      const finalService = booking.service || 'Storitev';

      await pool.query(`
        INSERT INTO timeslots (salon_id, date, time, status, customer_name, customer_email, customer_phone, service)
        VALUES ($1, $2, $3, 'busy', $4, $5, $6, $7)
        ON CONFLICT (salon_id, date, time) DO UPDATE
        SET status = 'busy', customer_name = $4, customer_email = $5, customer_phone = $6, service = $7
      `, [actualSalonId, booking.date, booking.time, finalName, finalEmail, finalPhone, finalService]); 

      if (finalEmail) await sendConfirmationEmail(finalEmail, finalName, salon, booking.date, booking.time, finalService);
      if (salon.notification_email) await sendNotificationToSalon(salon, finalName, finalEmail, finalPhone, booking.date, finalService, booking.time);

      const reply = raw.replace(/\[\[DELETE:[^\]]*\]\]/g, '').replace(/\[\[BOOKING:[\s\S]*?\]\]/g, '').trim();
      return res.json({
        reply,
        bookingDetected: { date: booking.date, time: booking.time, customerName: finalName, service: finalService, email: finalEmail, phone: finalPhone }
      });
    }

    const needInfo = raw.includes('[[NEED_INFO]]');
    const cleanReply = raw.replace('[[NEED_INFO]]', '').replace(/\[\[DELETE:[^\]]*\]\]/g, '').trim();
    res.json({ reply: cleanReply, needInfo, bookingDetected: null });

  } catch (err) {
    console.error('❌ Chat API napaka:', err.message);
    res.status(500).json({ error: 'API napaka: ' + (err.message || 'Unknown error') });
  }
});

// ─── SALON MANAGEMENT ─────────────────────────────────────────────────────────
app.get('/salons', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE active = true ORDER BY created_at');
  res.json(rows);
});

app.post('/salons', async (req, res) => {
  const { name, address, phone, hours, services, notificationEmail, type } = req.body;
  const id = 'salon_' + Date.now();
  await pool.query(
    'INSERT INTO salons (id, name, address, phone, hours, services, notification_email, schedule, type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, name, address, phone, hours, services, notificationEmail, JSON.stringify(DEFAULT_SCHEDULE), type || 'salon']
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
function buildSystemPrompt(salon, busySlots, customerInfo) {
  const todayLj = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Ljubljana' }));
  const todayStr = todayLj.toLocaleDateString('sl-SI', { timeZone: 'Europe/Ljubljana', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const todayDateStr = todayLj.toISOString().split('T')[0];
  const currentHour = todayLj.getHours();
  const currentMinute = todayLj.getMinutes();
  const schedule = salon.schedule || DEFAULT_SCHEDULE;

  const busyByDate = {};
  busySlots.forEach(s => {
    const d = typeof s.date === 'string' ? s.date.split('T')[0] : s.date.toISOString().split('T')[0];
    if (!busyByDate[d]) busyByDate[d] = new Set();
    busyByDate[d].add(s.time);
  });

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Ljubljana' }));
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const dayName = d.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'numeric' });
    const allHours = getHoursForDate(schedule, dateStr);
    if (allHours.length === 0) continue; // zaprt dan
    const busy = busyByDate[dateStr] || new Set();
    let free = allHours.filter(h => !busy.has(h));

    // Za danes: samo termini v prihodnosti
    if (dateStr === todayDateStr) {
      free = free.filter(h => {
        const [hh, mm] = h.split(':').map(Number);
        if (hh > currentHour) return true;
        if (hh === currentHour && mm > currentMinute) return true;
        return false;
      });
    }

    if (free.length > 0) {
      days.push(dateStr + ' (' + dayName + '): ' + free.join(', '));
    }
  }

  const slotsText = days.length > 0 ? days.join('\n') : 'Trenutno ni prostih terminov v naslednjih 7 dneh.';

  if (customerInfo) {
    const safeName = (customerInfo.name || '').replace(/"/g, '').replace(/\\/g, '');
    return `Si AI asistent za frizerski salon ${salon.name}. Odgovarjaš VEDNO in SAMO v slovenščini.
NIKOLI ne uporabi markdown formatiranja - piši navadno besedilo.
Si prijazen, profesionalen in jedrnat.
Piši brezhibno in slovnično pravilno slovensko. Primeri napak ki se jim izogni: "razumijem" → "razumem", "potvrjena" → "potrjena", "kakršnahkoli" → "kakršnih koli". In tako dalje - vedno preveri slovnico pred odgovorom.

Današnji datum: ${todayStr}
DATUM ZA TAGE: ${todayDateStr}

INFORMACIJE O SALONU:
- Ime: ${salon.name}
- Naslov: ${salon.address}
- Telefon: ${salon.phone}

DELOVNI ČAS:
${scheduleToText(schedule)}

STORITVE IN CENIK:
${salon.services}

PROSTI TERMINI (oblika YYYY-MM-DD) - samo termini od zdaj naprej:
${slotsText}

PODATKI STRANKE (že vpisani - NE sprašuj znova):
- Ime: ${safeName}
- E-pošta: ${customerInfo.email}
- Telefon: ${customerInfo.phone}

REZERVACIJE - PRAVILA:
- Stranka JE že vpisala podatke
- Ko stranka izbere termin in storitev, TAKOJ potrdi rezervacijo brez dodatnih vprašanj
- Rezerviraj SAMO termine iz zgornjega seznama prostih terminov - nobenih drugih
- KRITIČNO: [[BOOKING:...]] tag dodaj SAMO ko imaš VSE: datum + čas + IME + STORITEV
- ČE STRANKA NI POVEDALA STORITVE: vprašaj za storitev, NE dodajaj [[BOOKING:...]] taga
- NE rezerviraj z "Storitev" ali prazno storitvijo kot placeholder

BRISANJE TERMINA:
- Če stranka želi IZBRISATI termin, VEDNO dodaj [[DELETE:YYYY-MM-DDTHH:MM]] na KONEC odgovora
- Primer: "Termin ob 18:00 sem ti izbrisal.[[DELETE:2026-04-20T18:00]]"

BRISANJE IN PRESELITEV:
- Dodaj NAJPREJ [[DELETE:...]] nato [[BOOKING:{...}]]

NOVA REZERVACIJA - na KONEC odgovora dodaj:
[[BOOKING:{"date":"YYYY-MM-DD","time":"HH:MM","customerName":"${safeName}","service":"ime storitve"}]]
Primer: [[BOOKING:{"date":"2025-06-15","time":"10:00","customerName":"${safeName}","service":"Ženski haircut"}]]

POTEK:
1. Stranka pove kaj hoče → predlagaj proste termine
2. Stranka izbere termin → takoj dodaj [[BOOKING:...]] tag
3. ČE ZAHTEVA BRISANJE: dodaj [[DELETE:...]] PRED [[BOOKING:...]]

KRITIČNO:
- Trenutna ura je ${String(currentHour).padStart(2,'0')}:${String(currentMinute).padStart(2,'0')}
- Ne uporabljaj fraz kot "Dobra novica!" ko sporočaš negativne info (zaprto, ni terminov...)
- Nikoli si ne izmišljuj prostih terminov - uporabi samo termine iz zgornjega seznama
- ČE STRANKA ZAHTEVA TERMIN KI NI V SEZNAMU PROSTIH TERMINOV: zavrni in predlagaj bližnji prosti termin
- ČE STRANKA ZAHTEVA PRETEKLI TERMIN (pred ${String(currentHour).padStart(2,'0')}:${String(currentMinute).padStart(2,'0')}): jasno povej "Ta termin je že minil" in predlagaj naslednji prosti termin
- NE POTRJUJ terminov ki niso v seznamu prostih terminov
- NE POSTAVLJAJ VPRAŠANJ po brisanju
- Če ne veš, preusmeri na telefon: ${salon.phone}`;

  } else {
    return `Si AI asistent za frizerski salon ${salon.name}. Odgovarjaš VEDNO in SAMO v slovenščini.
NIKOLI ne uporabi markdown formatiranja - piši navadno besedilo.
Si prijazen, profesionalen in jedrnat.
Piši brezhibno in slovnično pravilno slovensko. Primeri napak ki se jim izogni: "razumijem" → "razumem", "potvrjena" → "potrjena", "kakršnahkoli" → "kakršnih koli". In tako dalje - vedno preveri slovnico pred odgovorom.

Današnji datum: ${todayStr}
DATUM ZA TAGE: ${todayDateStr}

INFORMACIJE O SALONU:
- Ime: ${salon.name}
- Naslov: ${salon.address}
- Telefon: ${salon.phone}

DELOVNI ČAS:
${scheduleToText(schedule)}

STORITVE IN CENIK:
${salon.services}

PROSTI TERMINI (oblika YYYY-MM-DD) - samo termini od zdaj naprej:
${slotsText}

STRANKA NI VPISALA PODATKOV.

REZERVACIJE - PRAVILA:
- Ko stranka hoče rezervirati termin, dodaj [[NEED_INFO]] na KONEC odgovora
- Primer: "Odlično! Pred rezervacijo potrebujem še vaše podatke.[[NEED_INFO]]"
- Rezerviraj SAMO termine iz zgornjega seznama

PRAVILA:
- Nikoli si ne izmišljuj prostih terminov
- Če ne veš, preusmeri na telefon: ${salon.phone}

KRITIČNO:
- Trenutna ura je ${String(currentHour).padStart(2,'0')}:${String(currentMinute).padStart(2,'0')}
- Ne uporabljaj fraz kot "Dobra novica!" ko sporočaš negativne info (zaprto, ni terminov...)
- ČE STRANKA ZAHTEVA TERMIN KI NI V SEZNAMU PROSTIH TERMINOV: zavrni in predlagaj bližnji prosti termin
- ČE STRANKA ZAHTEVA PRETEKLI TERMIN: jasno povej "Ta termin je že minil" in predlagaj naslednjega
- NE POTRJUJ terminov ki niso v seznamu prostih terminov`;
  }
}
function buildChatPage(salon) {
  const apiUrl = process.env.API_URL || 'https://bookwell.si';
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
    .booking-confirm { background: #dcfce7; border: 1px solid #4ade80; border-radius: 12px; padding: 10px 14px; font-size: 13px; color: #16a34a; margin-top: 4px; }
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
    .contact-form { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 16px; margin-top: 6px; display: flex; flex-direction: column; gap: 10px; max-width: 280px; }
    .contact-form .form-title { font-size: 13px; font-weight: 600; color: #1a1410; }
    .contact-form .form-sub { font-size: 11px; color: #6b5f52; margin-top: -6px; }
    .contact-form input { padding: 8px 12px; border-radius: 8px; border: 1px solid #ddd; font-size: 13px; font-family: inherit; outline: none; transition: border 0.15s; }
    .contact-form input:focus { border-color: #c9a84c; }
    .contact-form .submit-btn { background: #1a1410; color: #e8c97a; border: none; border-radius: 8px; padding: 10px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.15s; }
    .contact-form .submit-btn:hover { opacity: 0.85; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-avatar">${salon.name.charAt(0)}</div>
    <div class="header-info">
      <h1>${salon.name}</h1>
      <p>AI Asistent - Rezervacije 24/7</p>
    </div>
    <div class="header-dot"></div>
  </div>
  <div class="chat-container">
    <div class="info-bar">
      <span>📍 ${salon.address}</span>
      <span>📞 ${salon.phone}</span>
    </div>
    <div class="messages" id="messages"></div>
    <div id="customer-bar" style="display:none; padding: 6px 16px; background:#f0fdf4; border-top:1px solid #86efac;">
      <span id="customer-bar-text" style="font-size:11px; color:#16a34a;"></span>
    </div>
    <div class="input-area">
      <input type="text" id="input" placeholder="Vpišite sporočilo..." />
      <button class="send-btn" id="send">
        <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
      </button>
    </div>
    <div class="powered">Poganja BookWell.si</div>
  </div>
  <script>
    const API_URL = '${apiUrl}';
    const SALON_ID = '${salon.id}';
    let messages = [];
    let isTyping = false;
    let customerInfo = null;

    function getTime() { return new Date().toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' }); }

    function addBotMsg(text, booking) {
      const msgs = document.getElementById('messages');
      const div = document.createElement('div');
      div.className = 'msg bot';
      let extra = '';
      if (booking) extra = '<div class="booking-confirm">✅ Rezervacija potrjena: ' + booking.service + ', ' + booking.date + ' ob ' + booking.time + '</div>';
      div.innerHTML = '<div class="bubble">' + text + '</div>' + extra + '<div class="msg-time">' + getTime() + '</div>';
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
      div.id = 'typing'; div.className = 'msg bot';
      div.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
      msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
    }
    function removeTyping() { document.getElementById('typing')?.remove(); }

    function showContactForm() {
      const msgs = document.getElementById('messages');
      document.getElementById('contact-form-msg')?.remove();
      const div = document.createElement('div');
      div.className = 'msg bot';
      div.id = 'contact-form-msg';
      div.innerHTML = \`
        <div class="contact-form">
          <div class="form-title">Vaši kontaktni podatki</div>
          <div class="form-sub">Potrebujemo za potrditev rezervacije</div>
          <input type="text" id="cf-name" placeholder="Ime in priimek" />
          <input type="email" id="cf-email" placeholder="E-poštni naslov" />
          <input type="tel" id="cf-phone" placeholder="Telefonska številka" />
          <button class="submit-btn" onclick="submitContactForm()">Potrdi in nadaljuj →</button>
        </div>
        <div class="msg-time">\` + getTime() + \`</div>
      \`;
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      setTimeout(() => document.getElementById('cf-name')?.focus(), 100);
    }

    function submitContactForm() {
      const name = document.getElementById('cf-name')?.value.trim();
      const email = document.getElementById('cf-email')?.value.trim();
      const phone = document.getElementById('cf-phone')?.value.trim();
      if (!name || !email || !phone) { alert('Prosimo izpolnite vsa polja.'); return; }
      customerInfo = { name, email, phone };
      document.getElementById('contact-form-msg')?.remove();
      document.getElementById('customer-bar').style.display = 'block';
      document.getElementById('customer-bar-text').textContent = '👤 ' + name + ' · ' + phone;
      addUserMsg('✓ ' + name + ' | ' + email + ' | ' + phone);
      messages.push({ role: 'user', content: 'Moji podatki so: Ime: ' + name + ', E-pošta: ' + email + ', Telefon: ' + phone + '. Prosim nadaljuj z rezervacijo termina, ki sva se ga dogovorila.' });
      sendToBot();
    }

    async function sendMsg() {
      if (isTyping) return;
      const input = document.getElementById('input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      addUserMsg(text);
      messages.push({ role: 'user', content: text });
      await sendToBot();
    }

    async function sendToBot() {
      isTyping = true;
      showTyping();
      try {
        const res = await fetch(API_URL + '/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ salonId: SALON_ID, messages, customerInfo })
        });
        const data = await res.json();
        removeTyping();
        if (data.needInfo && !customerInfo) {
          addBotMsg(data.reply);
          if (data.reply && data.reply.trim()) {
            messages.push({ role: 'assistant', content: data.reply });
          }
          showContactForm();
        } else if (data.bookingDetected) {
          addBotMsg(data.reply, data.bookingDetected);
          if (data.reply && data.reply.trim()) {
            messages.push({ role: 'assistant', content: data.reply });
          }
          messages.push({ role: 'user', content: '[SISTEM: Rezervacija uspešno shranjena.]' });
          messages.push({ role: 'assistant', content: 'Rezervacija je potrjena.' });
        } else {
          addBotMsg(data.reply);
          if (data.reply && data.reply.trim()) {
            messages.push({ role: 'assistant', content: data.reply });
          }
        }
      } catch(e) {
        removeTyping();
        addBotMsg('Oprostite, prišlo je do napake. Pokličite nas: ${salon.phone}');
      }
      isTyping = false;
    }

    document.getElementById('input').addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });
    document.getElementById('send').addEventListener('click', sendMsg);
    setTimeout(() => { addBotMsg('Pozdravljeni! Sem AI asistent salona ${salon.name}. Pomagam z rezervacijami in informacijami. Kako vam lahko pomagam?'); }, 300);
  </script>
</body>
</html>`;
}

// Drop this entire function into server.js replacing the existing buildAdminPage function

function buildAdminPage(salon) {
  const apiUrl = process.env.API_URL || 'https://bookwell.si';
  const scheduleJson = JSON.stringify(salon.schedule || DEFAULT_SCHEDULE);

  return `<!DOCTYPE html>
<html lang="sl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — ${salon.name}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #0a0806;
      --surface: #111009;
      --surface2: #1a1610;
      --surface3: #221e14;
      --border: rgba(201,168,76,0.12);
      --border2: rgba(255,255,255,0.06);
      --gold: #c9a84c;
      --gold2: #e8c96a;
      --gold-dim: rgba(201,168,76,0.15);
      --gold-glow: rgba(201,168,76,0.08);
      --text: #f0ebe0;
      --text2: #9b8f7e;
      --text3: #5a5047;
      --green: #4ade80;
      --green-bg: rgba(74,222,128,0.1);
      --red: #f87171;
      --red-bg: rgba(248,113,113,0.1);
      --blue: #60a5fa;
      --blue-bg: rgba(96,165,250,0.1);
      --amber: #fbbf24;
      --amber-bg: rgba(251,191,36,0.1);
      --radius: 14px;
      --radius-sm: 8px;
    }

    html { background: var(--bg); }

    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      overflow-x: hidden;
    }

    /* ── SIDEBAR ── */
    .sidebar {
      width: 220px;
      flex-shrink: 0;
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      position: fixed;
      top: 0; left: 0; bottom: 0;
      z-index: 50;
    }

    .sidebar-logo {
      padding: 24px 20px 20px;
      border-bottom: 1px solid var(--border2);
    }
    .sidebar-logo .brand {
      font-family: 'Playfair Display', serif;
      font-size: 18px;
      color: var(--gold2);
      letter-spacing: -0.3px;
    }
    .sidebar-logo .salon-name {
      font-size: 12px;
      color: var(--text3);
      margin-top: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sidebar-nav {
      padding: 16px 12px;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 13px;
      font-weight: 400;
      color: var(--text2);
      transition: all 0.15s;
      border: 1px solid transparent;
      text-decoration: none;
    }
    .nav-item:hover {
      background: var(--gold-glow);
      color: var(--text);
    }
    .nav-item.active {
      background: var(--gold-dim);
      border-color: var(--border);
      color: var(--gold);
      font-weight: 500;
    }
    .nav-icon { font-size: 15px; width: 20px; text-align: center; }

    .sidebar-footer {
      padding: 16px 12px;
      border-top: 1px solid var(--border2);
    }
    .chat-link {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      background: var(--gold-dim);
      border: 1px solid var(--border);
      color: var(--gold);
      font-size: 12px;
      font-weight: 500;
      text-decoration: none;
      transition: all 0.15s;
    }
    .chat-link:hover { background: rgba(201,168,76,0.22); }
    .live-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
      animation: pulse 2s ease infinite;
      margin-left: auto;
    }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* ── MAIN ── */
    .main {
      margin-left: 220px;
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    /* ── TOPBAR ── */
    .topbar {
      height: 64px;
      background: var(--surface);
      border-bottom: 1px solid var(--border2);
      display: flex;
      align-items: center;
      padding: 0 28px;
      gap: 16px;
      position: sticky;
      top: 0;
      z-index: 40;
    }
    .topbar-title {
      font-family: 'Playfair Display', serif;
      font-size: 18px;
      color: var(--text);
    }
    .topbar-sub {
      font-size: 12px;
      color: var(--text3);
      margin-left: 4px;
    }

    .date-nav {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
    }
    .date-btn {
      width: 34px; height: 34px;
      border-radius: var(--radius-sm);
      background: var(--surface2);
      border: 1px solid var(--border2);
      color: var(--text2);
      font-size: 16px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    .date-btn:hover { border-color: var(--border); color: var(--gold); }

    .date-display {
      font-family: 'DM Mono', monospace;
      font-size: 13px;
      color: var(--text);
      background: var(--surface2);
      border: 1px solid var(--border2);
      border-radius: var(--radius-sm);
      padding: 7px 14px;
      min-width: 200px;
      text-align: center;
    }

    .today-btn {
      padding: 7px 14px;
      border-radius: var(--radius-sm);
      background: var(--gold-dim);
      border: 1px solid var(--border);
      color: var(--gold);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .today-btn:hover { background: rgba(201,168,76,0.22); }

    /* ── CONTENT ── */
    .content {
      padding: 28px;
      flex: 1;
    }

    /* ── STATS ROW ── */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 24px;
      animation: fadeUp 0.4s ease both;
    }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }

    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border2);
      border-radius: var(--radius);
      padding: 18px 20px;
      position: relative;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .stat-card:hover { border-color: var(--border); }
    .stat-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      border-radius: 2px 2px 0 0;
    }
    .stat-card.s-total::before { background: var(--gold); }
    .stat-card.s-free::before { background: var(--green); }
    .stat-card.s-busy::before { background: var(--red); }
    .stat-card.s-bot::before { background: var(--blue); }

    .stat-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--text3);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
    }
    .stat-value {
      font-family: 'Playfair Display', serif;
      font-size: 32px;
      font-weight: 700;
      color: var(--text);
      line-height: 1;
    }
    .stat-card.s-total .stat-value { color: var(--gold); }
    .stat-card.s-free .stat-value { color: var(--green); }
    .stat-card.s-busy .stat-value { color: var(--red); }
    .stat-card.s-bot .stat-value { color: var(--blue); }

    /* ── SLOTS SECTION ── */
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .section-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text2);
      text-transform: uppercase;
      letter-spacing: 1.5px;
    }
    .legend {
      display: flex;
      gap: 16px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--text3);
    }
    .legend-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
    }

    .closed-banner {
      background: var(--surface);
      border: 1px solid var(--border2);
      border-radius: var(--radius);
      padding: 48px;
      text-align: center;
      color: var(--text3);
      font-size: 15px;
    }
    .closed-banner .icon { font-size: 32px; margin-bottom: 12px; }

    /* ── SLOTS GRID ── */
    .slots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 10px;
    }

    .slot {
      background: var(--surface);
      border: 1px solid var(--border2);
      border-radius: var(--radius);
      padding: 14px 16px;
      cursor: pointer;
      transition: all 0.15s;
      position: relative;
      overflow: hidden;
    }
    .slot::before {
      content: '';
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 3px;
      border-radius: 3px 0 0 3px;
    }
    .slot.free::before { background: var(--green); }
    .slot.busy::before { background: var(--red); }
    .slot.bot::before { background: var(--blue); }

    .slot:hover {
      border-color: var(--border);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    }
    .slot.free:hover { border-color: rgba(74,222,128,0.3); }
    .slot.busy:hover { border-color: rgba(248,113,113,0.3); }
    .slot.bot:hover { border-color: rgba(96,165,250,0.3); }

    .slot-time {
      font-family: 'DM Mono', monospace;
      font-size: 18px;
      font-weight: 500;
      color: var(--text);
      margin-bottom: 6px;
    }

    .slot-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 500;
      padding: 3px 7px;
      border-radius: 100px;
      margin-bottom: 8px;
    }
    .slot.free .slot-badge { background: var(--green-bg); color: var(--green); }
    .slot.busy .slot-badge { background: var(--red-bg); color: var(--red); }
    .slot.bot .slot-badge { background: var(--blue-bg); color: var(--blue); }

    .slot-customer {
      font-size: 11px;
      color: var(--text2);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .slot-service {
      font-size: 10px;
      color: var(--text3);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── TAB PANELS ── */
    .panel { display: none; }
    .panel.active { display: block; }

    /* ── SCHEDULE ── */
    .schedule-card {
      background: var(--surface);
      border: 1px solid var(--border2);
      border-radius: var(--radius);
      overflow: hidden;
      max-width: 600px;
    }
    .schedule-head {
      padding: 18px 24px;
      border-bottom: 1px solid var(--border2);
      font-size: 13px;
      font-weight: 500;
      color: var(--text2);
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .schedule-body { padding: 8px 0; }

    .day-row {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 14px 24px;
      border-bottom: 1px solid var(--border2);
      transition: background 0.15s;
    }
    .day-row:last-child { border-bottom: none; }
    .day-row:hover { background: var(--surface2); }

    .day-name {
      width: 110px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
    }
    .day-name.closed-day { color: var(--text3); }

    /* TOGGLE */
    .toggle-wrap { position: relative; width: 42px; height: 24px; flex-shrink: 0; }
    .toggle-wrap input { opacity: 0; width: 0; height: 0; position: absolute; }
    .toggle-track {
      position: absolute; inset: 0;
      background: var(--surface3);
      border: 1px solid var(--border2);
      border-radius: 24px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .toggle-wrap input:checked + .toggle-track {
      background: var(--gold-dim);
      border-color: var(--border);
    }
    .toggle-track::before {
      content: '';
      position: absolute;
      width: 16px; height: 16px;
      top: 3px; left: 3px;
      background: var(--text3);
      border-radius: 50%;
      transition: all 0.2s;
    }
    .toggle-wrap input:checked + .toggle-track::before {
      transform: translateX(18px);
      background: var(--gold);
    }

    .time-range {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--text2);
    }
    .time-range.disabled { opacity: 0.3; pointer-events: none; }
    .time-sep { color: var(--text3); font-size: 12px; }
    input[type=time] {
      background: var(--surface2);
      border: 1px solid var(--border2);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-family: 'DM Mono', monospace;
      font-size: 13px;
      padding: 6px 10px;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type=time]:focus { border-color: var(--border); }

    .save-btn {
      margin: 20px 24px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .btn-save {
      background: var(--gold);
      color: var(--bg);
      border: none;
      border-radius: var(--radius-sm);
      padding: 11px 24px;
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-save:hover { background: var(--gold2); }
    .save-confirm {
      font-size: 12px;
      color: var(--green);
      opacity: 0;
      transition: opacity 0.3s;
    }
    .save-confirm.show { opacity: 1; }

    /* ── MODAL ── */
    .modal-overlay {
      display: none;
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(4px);
      z-index: 200;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.open { display: flex; }

    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      width: 380px;
      box-shadow: 0 40px 80px rgba(0,0,0,0.6);
      animation: modalIn 0.2s ease both;
    }
    @keyframes modalIn {
      from { opacity: 0; transform: scale(0.95) translateY(8px); }
      to { opacity: 1; transform: none; }
    }

    .modal-header {
      padding: 24px 24px 0;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
    }
    .modal-time {
      font-family: 'Playfair Display', serif;
      font-size: 28px;
      color: var(--gold);
    }
    .modal-date-label {
      font-size: 12px;
      color: var(--text3);
      margin-top: 2px;
    }
    .modal-close {
      width: 32px; height: 32px;
      border-radius: 50%;
      background: var(--surface2);
      border: 1px solid var(--border2);
      color: var(--text3);
      font-size: 16px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    .modal-close:hover { border-color: var(--border); color: var(--text); }

    .modal-body { padding: 20px 24px; }

    .customer-info-box {
      background: var(--surface2);
      border: 1px solid var(--border2);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      margin-bottom: 16px;
      display: none;
    }
    .customer-info-box.show { display: block; }
    .ci-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text2);
      margin-bottom: 4px;
    }
    .ci-row:last-child { margin-bottom: 0; }
    .ci-icon { color: var(--text3); width: 14px; }

    .field-group { margin-bottom: 14px; }
    .field-label {
      display: block;
      font-size: 11px;
      font-weight: 500;
      color: var(--text3);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }
    .field-input {
      width: 100%;
      background: var(--surface2);
      border: 1px solid var(--border2);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-family: 'DM Sans', sans-serif;
      font-size: 14px;
      padding: 10px 12px;
      outline: none;
      transition: border-color 0.15s;
    }
    .field-input:focus { border-color: var(--border); }
    .field-input::placeholder { color: var(--text3); }

    .modal-actions {
      padding: 0 24px 24px;
      display: flex;
      gap: 8px;
    }
    .btn-modal {
      flex: 1;
      padding: 11px;
      border-radius: var(--radius-sm);
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s;
    }
    .btn-cancel-modal {
      background: var(--surface2);
      border-color: var(--border2);
      color: var(--text2);
    }
    .btn-cancel-modal:hover { border-color: var(--border); color: var(--text); }
    .btn-free-modal {
      background: var(--green-bg);
      border-color: rgba(74,222,128,0.2);
      color: var(--green);
    }
    .btn-free-modal:hover { background: rgba(74,222,128,0.2); }
    .btn-busy-modal {
      background: var(--red-bg);
      border-color: rgba(248,113,113,0.2);
      color: var(--red);
    }
    .btn-busy-modal:hover { background: rgba(248,113,113,0.2); }

    /* ── REFRESH INDICATOR ── */
    .refresh-ring {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--text3);
      margin-left: auto;
      position: relative;
    }
    .refresh-ring.refreshing {
      background: var(--gold);
      box-shadow: 0 0 8px var(--gold);
    }

    /* ── RESPONSIVE ── */
    @media (max-width: 900px) {
      .sidebar { display: none; }
      .main { margin-left: 0; }
      .stats-row { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 600px) {
      .slots-grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); }
      .content { padding: 16px; }
      .topbar { padding: 0 16px; }
    }
  </style>
</head>
<body>

<!-- SIDEBAR -->
<aside class="sidebar">
  <div class="sidebar-logo">
    <div class="brand">BookWell</div>
    <div class="salon-name">${salon.name}</div>
  </div>
  <nav class="sidebar-nav">
    <div class="nav-item active" onclick="showPanel('termini')" id="nav-termini">
      <span class="nav-icon">📅</span> Termini
    </div>
    <div class="nav-item" onclick="showPanel('urnik')" id="nav-urnik">
      <span class="nav-icon">🕐</span> Delovni čas
    </div>
  </nav>
  <div class="sidebar-footer">
    <a href="/${salon.type || 'salon'}/${salon.slug || salon.id}" class="chat-link" target="_blank">
      <span>💬</span> Chat stran
      <span class="live-dot"></span>
    </a>
  </div>
</aside>

<!-- MAIN -->
<div class="main">
  <!-- TOPBAR -->
  <div class="topbar">
    <div>
      <span class="topbar-title" id="topbar-title">Termini</span>
      <span class="topbar-sub" id="topbar-sub"></span>
    </div>
    <div class="date-nav" id="date-nav-wrap">
      <button class="date-btn" id="prev">&#8249;</button>
      <div class="date-display" id="dateDisplay">—</div>
      <button class="date-btn" id="next">&#8250;</button>
      <button class="today-btn" id="todayBtn">Danes</button>
      <div class="refresh-ring" id="refreshRing" title="Samodejno osveževanje"></div>
    </div>
  </div>

  <!-- CONTENT -->
  <div class="content">

    <!-- PANEL: TERMINI -->
    <div class="panel active" id="panel-termini">
      <div class="stats-row" id="statsRow">
        <div class="stat-card s-total">
          <div class="stat-label">Skupaj</div>
          <div class="stat-value" id="st-total">—</div>
        </div>
        <div class="stat-card s-free">
          <div class="stat-label">Prostih</div>
          <div class="stat-value" id="st-free">—</div>
        </div>
        <div class="stat-card s-busy">
          <div class="stat-label">Zasedenih</div>
          <div class="stat-value" id="st-busy">—</div>
        </div>
        <div class="stat-card s-bot">
          <div class="stat-label">Bot rezervacij</div>
          <div class="stat-value" id="st-bot">—</div>
        </div>
      </div>

      <div class="section-header">
        <div class="section-title">Urnik dneva</div>
        <div class="legend">
          <div class="legend-item"><div class="legend-dot" style="background:var(--green)"></div>Prost</div>
          <div class="legend-item"><div class="legend-dot" style="background:var(--red)"></div>Zaseden</div>
          <div class="legend-item"><div class="legend-dot" style="background:var(--blue)"></div>Bot</div>
        </div>
      </div>

      <div id="slots-container">
        <div class="slots-grid" id="slotsGrid"></div>
      </div>
    </div>

    <!-- PANEL: URNIK -->
    <div class="panel" id="panel-urnik">
      <div class="schedule-card">
        <div class="schedule-head">Delovni čas salona</div>
        <div class="schedule-body" id="scheduleBody"></div>
        <div class="save-btn">
          <button class="btn-save" onclick="saveSchedule()">Shrani spremembe</button>
          <span class="save-confirm" id="saveConfirm">✓ Shranjeno</span>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- MODAL -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <div class="modal-header">
      <div>
        <div class="modal-time" id="modalTime">—</div>
        <div class="modal-date-label" id="modalDateLabel">—</div>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="customer-info-box" id="customerInfoBox">
        <div class="ci-row"><span class="ci-icon">📧</span><span id="ci-email">—</span></div>
        <div class="ci-row"><span class="ci-icon">📞</span><span id="ci-phone">—</span></div>
      </div>
      <div class="field-group">
        <label class="field-label">Ime stranke</label>
        <input type="text" class="field-input" id="modalName" placeholder="Ime Priimek" />
      </div>
      <div class="field-group">
        <label class="field-label">Storitev</label>
        <input type="text" class="field-input" id="modalService" placeholder="npr. Ženski haircut" />
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-modal btn-cancel-modal" onclick="closeModal()">Preklic</button>
      <button class="btn-modal btn-free-modal" onclick="saveSlot('free')">Prost</button>
      <button class="btn-modal btn-busy-modal" onclick="saveSlot('busy')">Zaseden</button>
    </div>
  </div>
</div>

<script>
  const API = '${apiUrl}';
  const SID = '${salon.id}';
  let currentDate = new Date();
  let slotsData = {};
  let schedule = ${scheduleJson};
  let currentSlot = null;
  let refreshTimer = null;

  const DAY_KEYS = ['mon','tue','wed','thu','fri','sat','sun'];
  const DAY_NAMES = { mon:'Ponedeljek', tue:'Torek', wed:'Sreda', thu:'Četrtek', fri:'Petek', sat:'Sobota', sun:'Nedelja' };

  function fmt(d) { return d.toISOString().split('T')[0]; }
  function fmtSl(d) {
    return d.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function getDayKey(d) { return ['sun','mon','tue','wed','thu','fri','sat'][d.getDay()]; }

  function genSlots(from, to) {
    const s = []; let [h,m] = from.split(':').map(Number);
    const [eh,em] = to.split(':').map(Number);
    while (h < eh || (h === eh && m < em)) {
      s.push(String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'));
      m += 30; if (m >= 60) { m -= 60; h++; }
    }
    return s;
  }

  /* ── PANEL SWITCH ── */
  function showPanel(name) {
    ['termini','urnik'].forEach(n => {
      document.getElementById('panel-'+n).classList.toggle('active', n === name);
      document.getElementById('nav-'+n).classList.toggle('active', n === name);
    });
    document.getElementById('topbar-title').textContent = name === 'termini' ? 'Termini' : 'Delovni čas';
    document.getElementById('date-nav-wrap').style.display = name === 'termini' ? 'flex' : 'none';
  }

  /* ── LOAD SLOTS ── */
  async function loadSlots(showRefresh) {
    const ring = document.getElementById('refreshRing');
    if (showRefresh) ring.classList.add('refreshing');

    const dateStr = fmt(currentDate);
    document.getElementById('dateDisplay').textContent = fmtSl(currentDate);
    document.getElementById('topbar-sub').textContent = '';

    const dayKey = getDayKey(currentDate);
    const daySchedule = schedule[dayKey];
    const container = document.getElementById('slots-container');

    if (!daySchedule || !daySchedule.open) {
      container.innerHTML = '<div class="closed-banner"><div class="icon">🚫</div>Ta dan je salon zaprt</div>';
      updateStats(0, 0, 0, 0);
      if (showRefresh) setTimeout(() => ring.classList.remove('refreshing'), 600);
      return;
    }

    try {
      const res = await fetch(API + '/admin/' + SID + '/timeslots?date=' + dateStr);
      const data = await res.json();
      slotsData = {};
      data.forEach(s => { slotsData[s.time] = s; });
      renderSlots(daySchedule);
    } catch(e) {}

    if (showRefresh) setTimeout(() => ring.classList.remove('refreshing'), 600);
  }

  function renderSlots(daySchedule) {
    const hours = genSlots(daySchedule.from, daySchedule.to);
    const grid = document.createElement('div');
    grid.className = 'slots-grid';

    let freeCount = 0, busyCount = 0, botCount = 0;

    hours.forEach(hour => {
      const slot = slotsData[hour];
      const isBusy = slot && slot.status === 'busy';
      const isBot = isBusy && slot.customer_email;

      if (isBot) botCount++;
      else if (isBusy) busyCount++;
      else freeCount++;

      const el = document.createElement('div');
      const cls = isBot ? 'bot' : isBusy ? 'busy' : 'free';
      el.className = 'slot ' + cls;

      const badgeText = isBot ? '🤖 Bot' : isBusy ? '● Zaseden' : '○ Prost';

      el.innerHTML = \`
        <div class="slot-time">\${hour}</div>
        <div class="slot-badge">\${badgeText}</div>
        \${slot?.customer_name ? '<div class="slot-customer">'+slot.customer_name+'</div>' : ''}
        \${slot?.service ? '<div class="slot-service">'+slot.service+'</div>' : ''}
      \`;
      el.addEventListener('click', () => openModal(hour, slot));
      grid.appendChild(el);
    });

    updateStats(hours.length, freeCount, busyCount, botCount);

    const container = document.getElementById('slots-container');
    container.innerHTML = '';
    container.appendChild(grid);
  }

  function updateStats(total, free, busy, bot) {
    document.getElementById('st-total').textContent = total;
    document.getElementById('st-free').textContent = free;
    document.getElementById('st-busy').textContent = busy;
    document.getElementById('st-bot').textContent = bot;
  }

  /* ── MODAL ── */
  function openModal(time, slot) {
    currentSlot = time;
    document.getElementById('modalTime').textContent = time;
    document.getElementById('modalDateLabel').textContent = fmtSl(currentDate);
    document.getElementById('modalName').value = slot?.customer_name || '';
    document.getElementById('modalService').value = slot?.service || '';

    const infoBox = document.getElementById('customerInfoBox');
    if (slot?.customer_email) {
      document.getElementById('ci-email').textContent = slot.customer_email;
      document.getElementById('ci-phone').textContent = slot.customer_phone || '—';
      infoBox.classList.add('show');
    } else {
      infoBox.classList.remove('show');
    }

    document.getElementById('modalOverlay').classList.add('open');
    setTimeout(() => document.getElementById('modalName').focus(), 100);
  }

  function closeModal() {
    document.getElementById('modalOverlay').classList.remove('open');
  }

  async function saveSlot(status) {
    const name = document.getElementById('modalName').value;
    const service = document.getElementById('modalService').value;
    await fetch(API + '/admin/' + SID + '/timeslots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: fmt(currentDate), time: currentSlot, status, customerName: name, service })
    });
    closeModal();
    loadSlots(false);
  }

  /* ── SCHEDULE ── */
  function buildScheduleUI() {
    const body = document.getElementById('scheduleBody');
    body.innerHTML = '';
    DAY_KEYS.forEach(key => {
      const d = schedule[key] || { open: false, from: '08:00', to: '20:00' };
      const row = document.createElement('div');
      row.className = 'day-row';
      row.innerHTML = \`
        <div class="day-name \${d.open ? '' : 'closed-day'}" id="dn-\${key}">\${DAY_NAMES[key]}</div>
        <label class="toggle-wrap">
          <input type="checkbox" id="open-\${key}" \${d.open ? 'checked' : ''} onchange="toggleDay('\${key}')">
          <span class="toggle-track"></span>
        </label>
        <div class="time-range \${d.open ? '' : 'disabled'}" id="tr-\${key}">
          <input type="time" id="from-\${key}" value="\${d.from}" step="1800">
          <span class="time-sep">→</span>
          <input type="time" id="to-\${key}" value="\${d.to}" step="1800">
        </div>
      \`;
      body.appendChild(row);
    });
  }

  function toggleDay(key) {
    const open = document.getElementById('open-' + key).checked;
    document.getElementById('tr-' + key).className = 'time-range' + (open ? '' : ' disabled');
    document.getElementById('dn-' + key).className = 'day-name' + (open ? '' : ' closed-day');
  }

  async function saveSchedule() {
    const newSchedule = {};
    DAY_KEYS.forEach(key => {
      newSchedule[key] = {
        open: document.getElementById('open-' + key).checked,
        from: document.getElementById('from-' + key).value || '08:00',
        to: document.getElementById('to-' + key).value || '20:00'
      };
    });
    await fetch(API + '/admin/' + SID + '/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSchedule)
    });
    schedule = newSchedule;
    const c = document.getElementById('saveConfirm');
    c.classList.add('show');
    setTimeout(() => c.classList.remove('show'), 2500);
    loadSlots(false);
  }

  /* ── EVENTS ── */
  document.getElementById('prev').addEventListener('click', () => {
    currentDate.setDate(currentDate.getDate() - 1); loadSlots(true);
  });
  document.getElementById('next').addEventListener('click', () => {
    currentDate.setDate(currentDate.getDate() + 1); loadSlots(true);
  });
  document.getElementById('todayBtn').addEventListener('click', () => {
    currentDate = new Date(); loadSlots(true);
  });
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  // Init
  loadSlots(true);
  buildScheduleUI();

  // Auto-refresh every 30s
  refreshTimer = setInterval(() => loadSlots(true), 30000);
</script>
</body>
</html>`;
}
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/landing.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
});