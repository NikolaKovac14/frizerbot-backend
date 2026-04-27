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

function buildAdminPage(salon) {
  const apiUrl = process.env.API_URL || 'https://bookwell.si';
  const scheduleJson = JSON.stringify(salon.schedule || DEFAULT_SCHEDULE);

  return `<!DOCTYPE html>
<html lang="sl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin · ${salon.name}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --black: #0a0a0a;
      --white: #ffffff;
      --off-white: #f7f7f5;
      --rule: #e0e0e0;
      --muted: #888888;
      --ink-light: #444444;
      --gold: #c9984a;
      --gold-hover: #b8863a;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }

    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--off-white);
      color: var(--black);
      font-size: 13px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    /* ─── MASTHEAD ─── */
    .masthead {
      background: var(--white);
      border-bottom: 2px solid var(--black);
      padding: 0 40px;
      display: flex;
      align-items: stretch;
      height: 60px;
    }
    .masthead-title {
      font-family: 'Playfair Display', serif;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--black);
      display: flex;
      align-items: center;
      padding-right: 32px;
      border-right: 1px solid var(--rule);
      white-space: nowrap;
    }
    .masthead-label {
      display: flex;
      align-items: center;
      padding: 0 24px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--muted);
      border-right: 1px solid var(--rule);
    }
    .masthead-spacer { flex: 1; }
    .masthead-link {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 20px;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      text-decoration: none;
      border-left: 1px solid var(--rule);
      transition: color 0.15s;
    }
    .masthead-link:hover { color: var(--black); }
    .masthead-link svg { width: 10px; height: 10px; }

    /* ─── NAV ─── */
    .nav {
      background: var(--white);
      border-bottom: 1px solid var(--rule);
      padding: 0 40px;
      display: flex;
      gap: 0;
    }
    .nav-tab {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 24px 12px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color 0.15s;
      user-select: none;
    }
    .nav-tab:hover { color: var(--black); }
    .nav-tab.active {
      color: var(--black);
      border-bottom-color: var(--gold);
    }

    /* ─── LAYOUT ─── */
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .page { max-width: 880px; margin: 0 auto; padding: 40px 32px; }

    /* ─── DATE NAVIGATION ─── */
    .date-nav {
      display: flex;
      align-items: baseline;
      gap: 20px;
      margin-bottom: 8px;
    }
    .date-heading {
      font-family: 'Playfair Display', serif;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1;
      color: var(--black);
      flex: 1;
    }
    .date-heading em {
      font-style: italic;
      font-weight: 400;
      color: var(--muted);
    }
    .nav-arrow {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--muted);
      padding: 4px 2px;
      font-size: 20px;
      line-height: 1;
      transition: color 0.12s;
      font-family: 'Playfair Display', serif;
    }
    .nav-arrow:hover { color: var(--black); }
    .today-btn {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
      background: none;
      border: 1px solid var(--rule);
      padding: 5px 12px;
      cursor: pointer;
      transition: all 0.12s;
    }
    .today-btn:hover { border-color: var(--black); color: var(--black); }

    /* ─── RULE ─── */
    .section-rule {
      border: none;
      border-top: 1px solid var(--rule);
      margin: 16px 0 28px;
    }
    .section-rule.thick {
      border-top: 2px solid var(--black);
      margin: 0 0 28px;
    }

    /* ─── STATS ROW ─── */
    .stats-row {
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin-bottom: 32px;
      display: flex;
      align-items: center;
      gap: 0;
      flex-wrap: wrap;
    }
    .stat-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .stat-item .num {
      font-family: 'Playfair Display', serif;
      font-size: 18px;
      font-weight: 700;
      color: var(--black);
      letter-spacing: -0.01em;
    }
    .stat-item .num.green { color: #2a7a2a; }
    .stat-item .num.red { color: #8a1a1a; }
    .stat-item .num.blue { color: #1a3a7a; }
    .stat-sep {
      margin: 0 14px;
      color: var(--rule);
      font-size: 16px;
      font-weight: 300;
    }

    /* ─── CLOSED BANNER ─── */
    .closed-banner {
      border: 1px solid var(--rule);
      background: var(--white);
      padding: 56px 40px;
      text-align: center;
    }
    .closed-title {
      font-family: 'Playfair Display', serif;
      font-size: 22px;
      font-weight: 400;
      font-style: italic;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .closed-sub {
      font-size: 12px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--rule);
      font-weight: 600;
    }

    /* ─── SLOTS GRID ─── */
    .slots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
      gap: 1px;
      background: var(--rule);
      border: 1px solid var(--rule);
    }
    .slot-card {
      background: var(--white);
      padding: 16px 18px 14px;
      cursor: pointer;
      transition: background 0.1s;
      position: relative;
    }
    .slot-card:hover { background: var(--off-white); }
    .slot-card.busy { background: var(--black); }
    .slot-card.busy:hover { background: #1a1a1a; }
    .slot-card.bot { background: var(--black); }
    .slot-card.bot:hover { background: #1a1a1a; }

    .slot-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .slot-time {
      font-family: 'Playfair Display', serif;
      font-size: 19px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--black);
      line-height: 1;
    }
    .slot-card.busy .slot-time,
    .slot-card.bot .slot-time {
      color: var(--white);
    }
    .slot-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ccc;
      flex-shrink: 0;
    }
    .slot-card:not(.busy):not(.bot) .slot-dot { background: #b0b0b0; }
    .slot-card.busy .slot-dot { background: var(--white); }
    .slot-card.bot .slot-dot { background: var(--gold); }

    .slot-name {
      font-size: 11px;
      font-weight: 400;
      color: var(--ink-light);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }
    .slot-card.busy .slot-name,
    .slot-card.bot .slot-name {
      color: rgba(255,255,255,0.55);
    }
    .slot-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
      margin-top: 2px;
    }
    .slot-card.busy .slot-label { color: rgba(255,255,255,0.3); }
    .slot-card.bot .slot-label { color: var(--gold); }

    /* ─── MODAL ─── */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 200;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: var(--white);
      width: 100%;
      max-width: 360px;
      box-shadow: 0 32px 80px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .modal-header {
      background: var(--black);
      padding: 24px 28px 20px;
      border-bottom: 1px solid #222;
    }
    .modal-time-display {
      font-family: 'Playfair Display', serif;
      font-size: 36px;
      font-weight: 700;
      color: var(--white);
      letter-spacing: -0.02em;
      line-height: 1;
    }
    .modal-date-label {
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.3);
      margin-top: 6px;
    }
    .modal-body { padding: 22px 28px; }
    .modal-info-card {
      background: var(--off-white);
      border-left: 2px solid var(--gold);
      padding: 10px 14px;
      margin-bottom: 18px;
      font-size: 12px;
      color: var(--ink-light);
      line-height: 1.8;
      display: none;
    }
    .modal-info-card.visible { display: block; }
    .modal-info-row { display: flex; align-items: center; gap: 8px; }
    .modal-field-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 5px;
      margin-top: 14px;
    }
    .modal-field-label:first-child { margin-top: 0; }
    .modal-input {
      width: 100%;
      padding: 9px 12px;
      border: 1px solid var(--rule);
      background: var(--off-white);
      font-size: 13px;
      font-family: system-ui, sans-serif;
      color: var(--black);
      outline: none;
      transition: border-color 0.12s;
      border-radius: 0;
    }
    .modal-input:focus { border-color: var(--black); background: var(--white); }
    .modal-actions {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid var(--rule);
    }
    .modal-btn {
      padding: 9px 10px;
      border: 1px solid var(--rule);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-family: system-ui, sans-serif;
      cursor: pointer;
      background: var(--white);
      color: var(--black);
      transition: all 0.12s;
      border-radius: 0;
    }
    .modal-btn:hover { background: var(--off-white); }
    .modal-btn.btn-busy {
      background: var(--black);
      color: var(--white);
      border-color: var(--black);
    }
    .modal-btn.btn-busy:hover { background: #222; }
    .modal-btn.btn-primary-action {
      background: var(--gold);
      color: var(--white);
      border-color: var(--gold);
    }
    .modal-btn.btn-primary-action:hover { background: var(--gold-hover); border-color: var(--gold-hover); }

    /* ─── SCHEDULE ─── */
    .schedule-card {
      background: var(--white);
      border: 1px solid var(--rule);
    }
    .schedule-head {
      padding: 22px 28px;
      border-bottom: 2px solid var(--black);
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
    }
    .schedule-head-title {
      font-family: 'Playfair Display', serif;
      font-size: 22px;
      font-weight: 700;
      color: var(--black);
    }
    .schedule-head-sub {
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 500;
    }
    .day-row {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 15px 28px;
      border-bottom: 1px solid var(--rule);
      transition: background 0.1s;
    }
    .day-row:last-child { border-bottom: none; }
    .day-row:hover { background: var(--off-white); }
    .day-name {
      width: 110px;
      font-size: 13px;
      font-weight: 500;
      color: var(--black);
      flex-shrink: 0;
    }
    .toggle-wrap {
      position: relative;
      width: 36px;
      height: 18px;
      flex-shrink: 0;
    }
    .toggle-wrap input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute;
      inset: 0;
      background: var(--rule);
      cursor: pointer;
      transition: 0.2s;
      border-radius: 0;
    }
    .toggle-wrap input:checked + .toggle-slider { background: var(--gold); }
    .toggle-slider::before {
      content: '';
      position: absolute;
      height: 12px;
      width: 12px;
      left: 3px;
      top: 3px;
      background: var(--white);
      transition: 0.2s;
    }
    .toggle-wrap input:checked + .toggle-slider::before { transform: translateX(18px); }
    .day-times {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--muted);
    }
    .day-times.disabled { opacity: 0.25; pointer-events: none; }
    .day-times input[type=time] {
      padding: 5px 10px;
      border: 1px solid var(--rule);
      font-size: 13px;
      font-family: system-ui, sans-serif;
      color: var(--black);
      background: var(--off-white);
      outline: none;
      transition: border-color 0.12s;
      border-radius: 0;
    }
    .day-times input[type=time]:focus { border-color: var(--black); background: var(--white); }
    .day-sep { color: var(--rule); font-weight: 300; }

    .schedule-footer {
      padding: 18px 28px;
      border-top: 2px solid var(--black);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .save-btn {
      background: var(--gold);
      color: var(--white);
      border: none;
      padding: 10px 28px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-family: system-ui, sans-serif;
      cursor: pointer;
      transition: background 0.15s;
      border-radius: 0;
    }
    .save-btn:hover { background: var(--gold-hover); }
    .save-msg {
      display: none;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #2a7a2a;
    }
    .save-msg.visible { display: flex; align-items: center; gap: 6px; }

    /* ─── SCROLLBAR ─── */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--rule); }

    /* ─── RESPONSIVE ─── */
    @media (max-width: 600px) {
      .masthead { padding: 0 20px; }
      .nav { padding: 0 20px; }
      .page { padding: 24px 20px; }
      .date-heading { font-size: 24px; }
      .slots-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
      .day-row { padding: 12px 20px; gap: 12px; }
      .day-name { width: 90px; }
      .schedule-head, .schedule-footer { padding: 16px 20px; }
      .modal-body { padding: 18px 22px; }
    }
  </style>
</head>
<body>

  <div class="masthead">
    <div class="masthead-title">${salon.name}</div>
    <div class="masthead-label">Admin Panel</div>
    <div class="masthead-spacer"></div>
    <a href="/${salon.type || 'salon'}/${salon.slug || salon.id}" class="masthead-link">
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4.5 1.5H2a.5.5 0 0 0-.5.5v8c0 .28.22.5.5.5h8a.5.5 0 0 0 .5-.5V7.5M7 1.5h3.5m0 0v3.5m0-3.5L5 7"/>
      </svg>
      Javna stran
    </a>
  </div>

  <nav class="nav">
    <div class="nav-tab active" onclick="switchTab('termini')">Termini</div>
    <div class="nav-tab" onclick="switchTab('urnik')">Delovni čas</div>
  </nav>

  <!-- TERMINI -->
  <div class="tab-content active" id="tab-termini">
    <div class="page">

      <div class="date-nav">
        <button class="nav-arrow" id="prev">&#8592;</button>
        <div class="date-heading" id="dateTitle"></div>
        <button class="today-btn" id="today">Danes</button>
        <button class="nav-arrow" id="next">&#8594;</button>
      </div>

      <hr class="section-rule thick">

      <div class="stats-row" id="stats-row"></div>

      <div id="slots-container"></div>

    </div>
  </div>

  <!-- URNIK -->
  <div class="tab-content" id="tab-urnik">
    <div class="page">
      <div class="schedule-card">
        <div class="schedule-head">
          <div>
            <div class="schedule-head-title">Delovni čas</div>
          </div>
          <div class="schedule-head-sub">Urnik terminov</div>
        </div>
        <div id="schedule-rows"></div>
        <div class="schedule-footer">
          <div class="save-msg" id="save-msg">&#10003; &nbsp;Shranjeno</div>
          <button class="save-btn" onclick="saveSchedule()">Shrani spremembe</button>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL -->
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-time-display" id="modal-time-display"></div>
        <div class="modal-date-label" id="modal-date-label"></div>
      </div>
      <div class="modal-body">
        <div class="modal-info-card" id="modal-info-card"></div>
        <div class="modal-field-label">Ime stranke</div>
        <input class="modal-input" type="text" id="modal-customer" placeholder="Ime Priimek" />
        <div class="modal-field-label">Storitev</div>
        <input class="modal-input" type="text" id="modal-service" placeholder="npr. Ženski haircut" />
        <div class="modal-actions">
          <button class="modal-btn" id="modal-cancel">Preklic</button>
          <button class="modal-btn" id="modal-set-free">Prost</button>
          <button class="modal-btn btn-busy" id="modal-set-busy">Zaseden</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const API_URL = '${apiUrl}';
    const SALON_ID = '${salon.id}';
    let currentDate = new Date();
    let currentSlot = null;
    let slotsData = {};
    let schedule = ${scheduleJson};

    const DAY_KEYS = ['mon','tue','wed','thu','fri','sat','sun'];
    const DAY_NAMES_SL = { mon:'Ponedeljek', tue:'Torek', wed:'Sreda', thu:'Četrtek', fri:'Petek', sat:'Sobota', sun:'Nedelja' };

    function generateSlots(from, to) {
      const slots = [];
      let [h, m] = from.split(':').map(Number);
      const [eh, em] = to.split(':').map(Number);
      while (h < eh || (h === eh && m < em)) {
        slots.push(String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0'));
        m += 30; if (m >= 60) { m -= 60; h++; }
      }
      return slots;
    }

    function getDayKey(d) {
      return ['sun','mon','tue','wed','thu','fri','sat'][d.getDay()];
    }

    function switchTab(name) {
      document.querySelectorAll('.nav-tab').forEach((t, i) =>
        t.classList.toggle('active', ['termini','urnik'][i] === name));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
    }

    function formatDate(d) { return d.toISOString().split('T')[0]; }

    function formatDateSl(d) {
      return d.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }

    function isToday(d) {
      return d.toDateString() === new Date().toDateString();
    }

    async function loadSlots() {
      const dateStr = formatDate(currentDate);
      const isTodayFlag = isToday(currentDate);
      const dateHeading = document.getElementById('dateTitle');

      const dayName = currentDate.toLocaleDateString('sl-SI', { weekday: 'long' });
      const dayNum = currentDate.toLocaleDateString('sl-SI', { day: 'numeric', month: 'long', year: 'numeric' });
      dateHeading.innerHTML = dayName + ', <em>' + dayNum + (isTodayFlag ? ' — danes' : '') + '</em>';

      const dayKey = getDayKey(currentDate);
      const daySchedule = schedule[dayKey];
      const container = document.getElementById('slots-container');

      if (!daySchedule || !daySchedule.open) {
        container.innerHTML = \`
          <div class="closed-banner">
            <div class="closed-title">Salon je zaprt</div>
            <div class="closed-sub">Ta dan ni delovnega časa</div>
          </div>\`;
        document.getElementById('stats-row').innerHTML = '';
        return;
      }

      const res = await fetch(API_URL + '/admin/' + SALON_ID + '/timeslots?date=' + dateStr);
      const data = await res.json();
      slotsData = {};
      data.forEach(s => { slotsData[s.time] = s; });

      const hours = generateSlots(daySchedule.from, daySchedule.to);
      const busyCount = hours.filter(h => slotsData[h] && slotsData[h].status === 'busy').length;
      const botCount = hours.filter(h => slotsData[h] && slotsData[h].status === 'busy' && slotsData[h].customer_email).length;
      const freeCount = hours.length - busyCount;

      document.getElementById('stats-row').innerHTML = \`
        <div class="stat-item"><span class="num">\${hours.length}</span>&nbsp;terminov</div>
        <span class="stat-sep">—</span>
        <div class="stat-item"><span class="num green">\${freeCount}</span>&nbsp;prostih</div>
        <span class="stat-sep">—</span>
        <div class="stat-item"><span class="num red">\${busyCount}</span>&nbsp;zasedenih</div>
        <span class="stat-sep">—</span>
        <div class="stat-item"><span class="num blue">\${botCount}</span>&nbsp;bot rezervacij</div>
      \`;

      container.innerHTML = '<div class="slots-grid" id="slots"></div>';
      renderSlots(hours);
    }

    function renderSlots(hours) {
      const grid = document.getElementById('slots');
      if (!grid) return;
      grid.innerHTML = '';
      hours.forEach(hour => {
        const slot = slotsData[hour];
        const isBusy = slot && slot.status === 'busy';
        const isBot = isBusy && slot.customer_email;
        const cls = isBusy ? (isBot ? 'bot' : 'busy') : '';

        const card = document.createElement('div');
        card.className = 'slot-card ' + cls;

        const statusLabel = isBusy ? (isBot ? 'Bot' : 'Zaseden') : 'Prost';
        const nameHtml = slot && slot.customer_name
          ? \`<div class="slot-name">\${slot.customer_name}</div>\`
          : \`<div class="slot-name">&nbsp;</div>\`;

        card.innerHTML = \`
          <div class="slot-top">
            <div class="slot-time">\${hour}</div>
            <div class="slot-dot"></div>
          </div>
          \${nameHtml}
          <div class="slot-label">\${statusLabel}</div>
        \`;
        card.addEventListener('click', () => openModal(hour, slot));
        grid.appendChild(card);
      });
    }

    function openModal(time, slot) {
      currentSlot = time;
      document.getElementById('modal-time-display').textContent = time;
      document.getElementById('modal-date-label').textContent = formatDateSl(currentDate).toUpperCase();
      document.getElementById('modal-customer').value = slot?.customer_name || '';
      document.getElementById('modal-service').value = slot?.service || '';

      const infoCard = document.getElementById('modal-info-card');
      if (slot && slot.customer_email) {
        infoCard.className = 'modal-info-card visible';
        infoCard.innerHTML = \`
          <div class="modal-info-row"><span>✉</span>&nbsp;\${slot.customer_email}</div>
          <div class="modal-info-row"><span>☏</span>&nbsp;\${slot.customer_phone || '–'}</div>
        \`;
      } else {
        infoCard.className = 'modal-info-card';
        infoCard.innerHTML = '';
      }
      document.getElementById('modal-overlay').classList.add('open');
    }

    async function saveSlot(status) {
      const customerName = document.getElementById('modal-customer').value;
      const service = document.getElementById('modal-service').value;
      await fetch(API_URL + '/admin/' + SALON_ID + '/timeslots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: formatDate(currentDate), time: currentSlot, status, customerName, service })
      });
      document.getElementById('modal-overlay').classList.remove('open');
      loadSlots();
    }

    function buildScheduleUI() {
      const container = document.getElementById('schedule-rows');
      container.innerHTML = '';
      DAY_KEYS.forEach(key => {
        const d = schedule[key] || { open: false, from: '08:00', to: '20:00' };
        const row = document.createElement('div');
        row.className = 'day-row';
        row.innerHTML = \`
          <div class="day-name">\${DAY_NAMES_SL[key]}</div>
          <label class="toggle-wrap">
            <input type="checkbox" id="open-\${key}" \${d.open ? 'checked' : ''} onchange="toggleDay('\${key}')">
            <span class="toggle-slider"></span>
          </label>
          <div class="day-times \${d.open ? '' : 'disabled'}" id="times-\${key}">
            <input type="time" id="from-\${key}" value="\${d.from}" step="1800">
            <span class="day-sep">–</span>
            <input type="time" id="to-\${key}" value="\${d.to}" step="1800">
          </div>
        \`;
        container.appendChild(row);
      });
    }

    function toggleDay(key) {
      const isOpen = document.getElementById('open-' + key).checked;
      document.getElementById('times-' + key).className = 'day-times' + (isOpen ? '' : ' disabled');
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
      await fetch(API_URL + '/admin/' + SALON_ID + '/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSchedule)
      });
      schedule = newSchedule;
      const msg = document.getElementById('save-msg');
      msg.classList.add('visible');
      setTimeout(() => msg.classList.remove('visible'), 2500);
      loadSlots();
    }

    // ── Events ──
    document.getElementById('modal-cancel').addEventListener('click', () =>
      document.getElementById('modal-overlay').classList.remove('open'));
    document.getElementById('modal-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-overlay'))
        document.getElementById('modal-overlay').classList.remove('open');
    });
    document.getElementById('modal-set-busy').addEventListener('click', () => saveSlot('busy'));
    document.getElementById('modal-set-free').addEventListener('click', () => saveSlot('free'));
    document.getElementById('prev').addEventListener('click', () => {
      currentDate.setDate(currentDate.getDate() - 1); loadSlots();
    });
    document.getElementById('next').addEventListener('click', () => {
      currentDate.setDate(currentDate.getDate() + 1); loadSlots();
    });
    document.getElementById('today').addEventListener('click', () => {
      currentDate = new Date(); loadSlots();
    });

    // ── Init ──
    loadSlots();
    buildScheduleUI();
    setInterval(loadSlots, 30000);
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