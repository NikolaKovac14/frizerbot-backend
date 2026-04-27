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
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Plus+Jakarta+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --gold: #b87333;
      --gold-light: #e8a87c;
      --gold-pale: #fff5ee;
      --ink: #1c1917;
      --ink-2: #3d3530;
      --ink-3: #8a7f78;
      --ink-4: #bdb5b0;
      --glass: rgba(255,255,255,0.82);
      --glass-strong: rgba(255,255,255,0.95);
      --glass-subtle: rgba(255,255,255,0.55);
      --border: rgba(255,255,255,0.9);
      --border-inner: rgba(0,0,0,0.07);
      --shadow: 0 4px 24px rgba(80,40,20,0.07);
      --shadow-md: 0 8px 40px rgba(80,40,20,0.10);
      --shadow-lg: 0 16px 64px rgba(80,40,20,0.13);
      --green: #2d8f5e;
      --green-bg: rgba(45,143,94,0.10);
      --red: #c0392b;
      --red-bg: rgba(192,57,43,0.09);
      --blue: #2563c4;
      --blue-bg: rgba(37,99,196,0.09);
      --radius: 14px;
      --radius-lg: 20px;
      --radius-xl: 28px;
    }
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      background: linear-gradient(135deg, #f0f4ff 0%, #fdf4ff 50%, #fff8f0 100%);
      min-height: 100vh;
      color: var(--ink-2);
      font-size: 14px;
      line-height: 1.5;
    }

    /* ── AMBIENT BACKGROUND BLOBS ── */
    body::before, body::after {
      content: '';
      position: fixed;
      border-radius: 50%;
      filter: blur(80px);
      pointer-events: none;
      z-index: 0;
    }
    body::before {
      width: 600px; height: 600px;
      top: -200px; left: -150px;
      background: radial-gradient(circle, rgba(184,115,51,0.07) 0%, transparent 70%);
    }
    body::after {
      width: 500px; height: 500px;
      bottom: -100px; right: -100px;
      background: radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 70%);
    }

    /* ── HEADER ── */
    .header {
      background: var(--glass);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border);
      padding: 0 36px;
      height: 62px;
      display: flex;
      align-items: center;
      gap: 16px;
      position: sticky;
      top: 0;
      z-index: 50;
      box-shadow: var(--shadow);
    }
    .header-logo {
      font-family: 'DM Serif Display', serif;
      font-size: 20px;
      color: var(--ink);
      letter-spacing: -0.01em;
      white-space: nowrap;
    }
    .header-logo span { color: var(--gold); font-style: italic; }
    .header-sep { flex: 1; }
    .header-badge {
      background: linear-gradient(135deg, rgba(184,115,51,0.12), rgba(184,115,51,0.06));
      border: 1px solid rgba(184,115,51,0.22);
      color: var(--gold);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 4px 12px;
      border-radius: 100px;
    }
    .header-link {
      color: var(--ink-3);
      font-size: 12px;
      font-weight: 500;
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--border-inner);
      background: rgba(255,255,255,0.5);
      transition: all 0.15s;
    }
    .header-link:hover {
      background: var(--glass-strong);
      color: var(--ink);
      box-shadow: var(--shadow);
    }
    .header-link svg { width: 12px; height: 12px; }

    /* ── NAV TABS ── */
    .nav {
      background: var(--glass-subtle);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border-inner);
      padding: 0 36px;
      display: flex;
      gap: 0;
      position: relative;
      z-index: 1;
    }
    .nav-tab {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 22px;
      font-size: 13px;
      font-weight: 500;
      color: var(--ink-3);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.18s;
      user-select: none;
      letter-spacing: 0.01em;
    }
    .nav-tab:hover { color: var(--ink-2); }
    .nav-tab.active { color: var(--gold); border-bottom-color: var(--gold); }
    .nav-tab svg { width: 14px; height: 14px; opacity: 0.7; }
    .nav-tab.active svg { opacity: 1; }

    /* ── LAYOUT ── */
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .page {
      max-width: 900px;
      margin: 0 auto;
      padding: 36px 28px;
      position: relative;
      z-index: 1;
    }

    /* ── DATE NAV ── */
    .date-nav {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 28px;
    }
    .date-nav-btn {
      width: 38px;
      height: 38px;
      background: var(--glass);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--ink-3);
      box-shadow: var(--shadow);
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .date-nav-btn:hover {
      background: var(--glass-strong);
      color: var(--ink);
      transform: translateY(-1px);
      box-shadow: var(--shadow-md);
    }
    .date-nav-btn svg { width: 16px; height: 16px; }
    .date-label {
      flex: 1;
      text-align: center;
      font-family: 'DM Serif Display', serif;
      font-size: 22px;
      color: var(--ink);
      letter-spacing: -0.01em;
    }
    .date-today-btn {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--gold);
      background: rgba(184,115,51,0.09);
      border: 1px solid rgba(184,115,51,0.2);
      border-radius: 8px;
      padding: 6px 14px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .date-today-btn:hover {
      background: rgba(184,115,51,0.16);
    }

    /* ── STATS ROW ── */
    .stats-row {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .stat-chip {
      background: var(--glass);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 22px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 110px;
      box-shadow: var(--shadow);
      flex: 1;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .stat-chip:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }
    .stat-value {
      font-family: 'DM Serif Display', serif;
      font-size: 28px;
      color: var(--ink);
      line-height: 1;
    }
    .stat-label {
      font-size: 11px;
      color: var(--ink-4);
      font-weight: 500;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    /* ── LEGEND ── */
    .legend {
      display: flex;
      gap: 20px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      align-items: center;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      font-weight: 500;
      color: var(--ink-3);
    }
    .legend-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .legend-dot.free { background: var(--green); }
    .legend-dot.busy { background: var(--red); }
    .legend-dot.bot { background: var(--blue); }

    /* ── CLOSED BANNER ── */
    .closed-banner {
      background: var(--glass);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 56px 24px;
      text-align: center;
      box-shadow: var(--shadow);
    }
    .closed-icon { font-size: 36px; margin-bottom: 14px; opacity: 0.5; }
    .closed-title {
      font-family: 'DM Serif Display', serif;
      font-size: 22px;
      color: var(--ink);
      margin-bottom: 6px;
    }
    .closed-sub { font-size: 13px; color: var(--ink-3); }

    /* ── SLOTS GRID ── */
    .slots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
      gap: 12px;
    }
    .slot-card {
      background: var(--glass);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      cursor: pointer;
      transition: all 0.18s cubic-bezier(0.34,1.56,0.64,1);
      position: relative;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .slot-card::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: linear-gradient(90deg, rgba(45,143,94,0.6), rgba(45,143,94,0.2));
      border-radius: 3px 3px 0 0;
    }
    .slot-card.busy::after {
      background: linear-gradient(90deg, rgba(192,57,43,0.6), rgba(192,57,43,0.2));
    }
    .slot-card.bot::after {
      background: linear-gradient(90deg, rgba(37,99,196,0.6), rgba(37,99,196,0.2));
    }
    .slot-card:hover {
      transform: translateY(-3px) scale(1.01);
      box-shadow: var(--shadow-md);
      border-color: rgba(255,255,255,0.98);
      background: var(--glass-strong);
    }
    .slot-card:active { transform: translateY(-1px) scale(0.99); }
    .slot-time {
      font-family: 'DM Serif Display', serif;
      font-size: 22px;
      color: var(--ink);
      letter-spacing: -0.01em;
      margin-bottom: 4px;
    }
    .slot-status {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
    }
    .slot-card:not(.busy):not(.bot) .slot-status { color: var(--green); }
    .slot-card.busy .slot-status { color: var(--red); }
    .slot-card.bot .slot-status { color: var(--blue); }
    .slot-name {
      font-size: 12px;
      color: var(--ink-3);
      margin-top: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 500;
    }
    .slot-service {
      font-size: 11px;
      color: var(--ink-4);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ── MODAL ── */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(28,25,23,0.28);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      z-index: 200;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: var(--glass-strong);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      width: 100%;
      max-width: 400px;
      box-shadow: var(--shadow-lg), 0 0 0 1px rgba(255,255,255,0.5) inset;
      overflow: hidden;
      animation: modalIn 0.2s cubic-bezier(0.34,1.56,0.64,1);
    }
    @keyframes modalIn {
      from { opacity: 0; transform: scale(0.94) translateY(8px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    .modal-header {
      background: linear-gradient(135deg, rgba(184,115,51,0.10), rgba(232,168,124,0.06));
      border-bottom: 1px solid rgba(184,115,51,0.12);
      padding: 24px 28px;
    }
    .modal-time {
      font-family: 'DM Serif Display', serif;
      font-size: 36px;
      color: var(--ink);
      letter-spacing: -0.02em;
      line-height: 1;
    }
    .modal-date-label {
      font-size: 12px;
      color: var(--ink-3);
      margin-top: 4px;
      font-weight: 500;
    }
    .modal-body { padding: 22px 28px; }
    .modal-info-card {
      background: rgba(37,99,196,0.06);
      border: 1px solid rgba(37,99,196,0.12);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 18px;
      font-size: 13px;
      color: var(--ink-3);
      line-height: 1.9;
      display: none;
    }
    .modal-info-card.visible { display: block; }
    .modal-info-row { display: flex; gap: 8px; align-items: center; }
    .modal-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      color: var(--ink-4);
      margin-bottom: 5px;
      margin-top: 16px;
    }
    .modal-label:first-of-type { margin-top: 0; }
    .modal-input {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid var(--border-inner);
      border-radius: 10px;
      font-size: 13px;
      font-family: 'Plus Jakarta Sans', sans-serif;
      color: var(--ink);
      background: rgba(255,255,255,0.7);
      outline: none;
      transition: all 0.15s;
    }
    .modal-input:focus {
      border-color: rgba(184,115,51,0.4);
      background: rgba(255,255,255,0.95);
      box-shadow: 0 0 0 3px rgba(184,115,51,0.08);
    }
    .modal-actions {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid var(--border-inner);
    }
    .modal-btn {
      padding: 10px 8px;
      border-radius: 10px;
      border: none;
      font-size: 12px;
      font-weight: 600;
      font-family: 'Plus Jakarta Sans', sans-serif;
      cursor: pointer;
      transition: all 0.15s;
      letter-spacing: 0.02em;
    }
    .modal-btn:hover { transform: translateY(-1px); box-shadow: var(--shadow); }
    .modal-btn:active { transform: translateY(0); }
    .btn-cancel {
      background: rgba(0,0,0,0.05);
      color: var(--ink-3);
      border: 1px solid var(--border-inner);
    }
    .btn-free {
      background: var(--green-bg);
      color: var(--green);
      border: 1px solid rgba(45,143,94,0.18);
    }
    .btn-busy {
      background: var(--red-bg);
      color: var(--red);
      border: 1px solid rgba(192,57,43,0.18);
    }

    /* ── SCHEDULE ── */
    .schedule-card {
      background: var(--glass);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      overflow: hidden;
      box-shadow: var(--shadow-md);
    }
    .schedule-header {
      padding: 24px 28px;
      border-bottom: 1px solid var(--border-inner);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: linear-gradient(135deg, rgba(255,255,255,0.6), rgba(255,255,255,0.2));
    }
    .schedule-title {
      font-family: 'DM Serif Display', serif;
      font-size: 20px;
      color: var(--ink);
    }
    .schedule-subtitle { font-size: 12px; color: var(--ink-3); margin-top: 3px; }
    .day-row {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 16px 28px;
      border-bottom: 1px solid rgba(0,0,0,0.04);
      transition: background 0.12s;
    }
    .day-row:last-child { border-bottom: none; }
    .day-row:hover { background: rgba(255,255,255,0.5); }
    .day-name {
      width: 100px;
      font-size: 13px;
      font-weight: 600;
      color: var(--ink-2);
    }
    .toggle-wrap {
      position: relative;
      width: 38px;
      height: 20px;
      flex-shrink: 0;
    }
    .toggle-wrap input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.12);
      border-radius: 20px;
      cursor: pointer;
      transition: 0.22s;
    }
    .toggle-wrap input:checked + .toggle-slider {
      background: linear-gradient(135deg, var(--gold), var(--gold-light));
    }
    .toggle-slider::before {
      content: '';
      position: absolute;
      height: 14px;
      width: 14px;
      left: 3px;
      bottom: 3px;
      background: #fff;
      border-radius: 50%;
      transition: 0.22s;
      box-shadow: 0 1px 4px rgba(0,0,0,0.18);
    }
    .toggle-wrap input:checked + .toggle-slider::before { transform: translateX(18px); }
    .day-times {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--ink-3);
    }
    .day-times.disabled { opacity: 0.3; pointer-events: none; }
    .day-times input[type=time] {
      padding: 6px 10px;
      border: 1px solid var(--border-inner);
      border-radius: 8px;
      font-size: 13px;
      font-family: 'Plus Jakarta Sans', sans-serif;
      color: var(--ink);
      background: rgba(255,255,255,0.7);
      outline: none;
      transition: all 0.15s;
    }
    .day-times input[type=time]:focus {
      border-color: rgba(184,115,51,0.4);
      background: rgba(255,255,255,0.95);
      box-shadow: 0 0 0 3px rgba(184,115,51,0.08);
    }
    .day-sep { color: var(--ink-4); font-size: 14px; }
    .schedule-footer {
      padding: 18px 28px;
      border-top: 1px solid var(--border-inner);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: linear-gradient(135deg, rgba(255,255,255,0.4), rgba(255,255,255,0.1));
    }
    .save-btn {
      background: linear-gradient(135deg, var(--ink), #3d3530);
      color: rgba(255,255,255,0.9);
      border: none;
      border-radius: 10px;
      padding: 11px 28px;
      font-size: 13px;
      font-weight: 600;
      font-family: 'Plus Jakarta Sans', sans-serif;
      cursor: pointer;
      transition: all 0.15s;
      letter-spacing: 0.02em;
      box-shadow: 0 4px 16px rgba(0,0,0,0.14);
    }
    .save-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    }
    .save-btn:active { transform: translateY(0); }
    .save-msg {
      display: none;
      font-size: 13px;
      color: var(--green);
      font-weight: 600;
      align-items: center;
      gap: 6px;
    }
    .save-msg.visible { display: flex; }

    /* ── SCROLLBAR ── */
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.10); border-radius: 10px; }

    /* ── RESPONSIVE ── */
    @media (max-width: 640px) {
      .header { padding: 0 16px; }
      .nav { padding: 0 16px; overflow-x: auto; }
      .page { padding: 20px 16px; }
      .date-label { font-size: 16px; }
      .slots-grid { grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
      .day-row { padding: 12px 16px; gap: 12px; }
      .day-name { width: 78px; font-size: 12px; }
      .schedule-header, .schedule-footer { padding: 14px 16px; }
      .modal-body { padding: 18px 20px; }
      .modal-header { padding: 20px; }
    }
  </style>
</head>
<body>

  <div class="header">
    <div class="header-logo">${salon.name}<span>.</span></div>
    <div class="header-sep"></div>
    <div class="header-badge">Admin</div>
    <a href="/${salon.type || 'salon'}/${salon.slug || salon.id}" class="header-link">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9M9 2h5m0 0v5m0-5L7 10"/>
      </svg>
      Oglej stran
    </a>
  </div>

  <nav class="nav">
    <div class="nav-tab active" onclick="switchTab('termini')">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1v3M11 1v3M2 7h12"/>
      </svg>
      Termini
    </div>
    <div class="nav-tab" onclick="switchTab('urnik')">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2 1.5"/>
      </svg>
      Delovni čas
    </div>
  </nav>

  <!-- TERMINI -->
  <div class="tab-content active" id="tab-termini">
    <div class="page">

      <div class="date-nav">
        <button class="date-nav-btn" id="prev" title="Prejšnji dan">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M10 4L6 8l4 4"/>
          </svg>
        </button>
        <div class="date-label" id="dateTitle"></div>
        <button class="date-today-btn" id="today">Danes</button>
        <button class="date-nav-btn" id="next" title="Naslednji dan">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M6 4l4 4-4 4"/>
          </svg>
        </button>
      </div>

      <div class="stats-row" id="stats-row"></div>

      <div class="legend">
        <div class="legend-item"><div class="legend-dot free"></div> Prost termin</div>
        <div class="legend-item"><div class="legend-dot busy"></div> Zaseden (ročno)</div>
        <div class="legend-item"><div class="legend-dot bot"></div> Rezerviral asistent</div>
      </div>

      <div id="slots-container"></div>
    </div>
  </div>

  <!-- URNIK -->
  <div class="tab-content" id="tab-urnik">
    <div class="page">
      <div class="schedule-card">
        <div class="schedule-header">
          <div>
            <div class="schedule-title">Delovni čas</div>
            <div class="schedule-subtitle">Nastavljeni urniki določajo razpoložljive termine</div>
          </div>
        </div>
        <div id="schedule-rows"></div>
        <div class="schedule-footer">
          <div class="save-msg" id="save-msg">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 8l3.5 3.5L13 4"/>
            </svg>
            Shranjeno
          </div>
          <button class="save-btn" onclick="saveSchedule()">Shrani spremembe</button>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL -->
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-time" id="modal-time-display"></div>
        <div class="modal-date-label" id="modal-date-label"></div>
      </div>
      <div class="modal-body">
        <div class="modal-info-card" id="modal-info-card"></div>
        <div class="modal-label">Ime stranke</div>
        <input class="modal-input" type="text" id="modal-customer" placeholder="Ime Priimek" />
        <div class="modal-label">Storitev</div>
        <input class="modal-input" type="text" id="modal-service" placeholder="npr. Ženski haircut" />
        <div class="modal-actions">
          <button class="modal-btn btn-cancel" id="modal-cancel">Preklic</button>
          <button class="modal-btn btn-free" id="modal-set-free">Prost</button>
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
      const now = new Date();
      return d.toDateString() === now.toDateString();
    }

    async function loadSlots() {
      const dateStr = formatDate(currentDate);
      const label = document.getElementById('dateTitle');
      label.textContent = formatDateSl(currentDate) + (isToday(currentDate) ? ' · danes' : '');

      const dayKey = getDayKey(currentDate);
      const daySchedule = schedule[dayKey];
      const container = document.getElementById('slots-container');

      if (!daySchedule || !daySchedule.open) {
        container.innerHTML = \`
          <div class="closed-banner">
            <div class="closed-icon">🚫</div>
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
        <div class="stat-chip"><div class="stat-value">\${hours.length}</div><div class="stat-label">Skupaj</div></div>
        <div class="stat-chip"><div class="stat-value" style="color:var(--green)">\${freeCount}</div><div class="stat-label">Prostih</div></div>
        <div class="stat-chip"><div class="stat-value" style="color:var(--red)">\${busyCount}</div><div class="stat-label">Zasedenih</div></div>
        <div class="stat-chip"><div class="stat-value" style="color:var(--blue)">\${botCount}</div><div class="stat-label">Bot rezervacij</div></div>
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
        card.innerHTML = \`
          <div class="slot-time">\${hour}</div>
          <div class="slot-status">\${isBusy ? (isBot ? 'Bot' : 'Zaseden') : 'Prost'}</div>
          \${slot && slot.customer_name ? \`<div class="slot-name">\${slot.customer_name}</div>\` : ''}
          \${slot && slot.service ? \`<div class="slot-service">\${slot.service}</div>\` : ''}
        \`;
        card.addEventListener('click', () => openModal(hour, slot));
        grid.appendChild(card);
      });
    }

    function openModal(time, slot) {
      currentSlot = time;
      document.getElementById('modal-time-display').textContent = time;
      document.getElementById('modal-date-label').textContent = formatDateSl(currentDate);
      document.getElementById('modal-customer').value = slot?.customer_name || '';
      document.getElementById('modal-service').value = slot?.service || '';

      const infoCard = document.getElementById('modal-info-card');
      if (slot && slot.customer_email) {
        infoCard.className = 'modal-info-card visible';
        infoCard.innerHTML = \`
          <div class="modal-info-row"><span>✉️</span><span>\${slot.customer_email}</span></div>
          <div class="modal-info-row"><span>📞</span><span>\${slot.customer_phone || '–'}</span></div>
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
      const timesEl = document.getElementById('times-' + key);
      timesEl.className = 'day-times' + (isOpen ? '' : ' disabled');
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
      currentDate.setDate(currentDate.getDate() - 1);
      loadSlots();
    });
    document.getElementById('next').addEventListener('click', () => {
      currentDate.setDate(currentDate.getDate() + 1);
      loadSlots();
    });
    document.getElementById('today').addEventListener('click', () => {
      currentDate = new Date();
      loadSlots();
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