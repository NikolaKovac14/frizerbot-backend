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
  <title>${salon.name} · Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --honey:       #E8A020;
      --honey-light: #FEF3DC;
      --honey-mid:   #FDE9B0;
      --ink:         #141110;
      --ink-2:       #2E2A26;
      --ink-3:       #72675C;
      --ink-4:       #A89E95;
      --bg:          #F8F6F3;
      --surface:     #FFFFFF;
      --surface-2:   #F3F0EC;
      --border:      rgba(20,17,16,0.07);
      --border-md:   rgba(20,17,16,0.12);
      --green:       #12A05C;
      --green-bg:    #E8F8EF;
      --red:         #D63A2F;
      --red-bg:      #FDECEA;
      --blue:        #2B6CB0;
      --blue-bg:     #E8F0FB;
      --r-sm: 8px;
      --r-md: 12px;
      --r-lg: 18px;
      --r-xl: 24px;
      --shadow-sm: 0 1px 3px rgba(20,17,16,0.06), 0 1px 2px rgba(20,17,16,0.04);
      --shadow-md: 0 4px 12px rgba(20,17,16,0.08), 0 2px 4px rgba(20,17,16,0.04);
      --shadow-lg: 0 12px 32px rgba(20,17,16,0.1), 0 4px 12px rgba(20,17,16,0.06);
    }

    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html { height: 100%; }
    body {
      font-family: 'Outfit', sans-serif;
      background: var(--bg);
      color: var(--ink-2);
      font-size: 14px;
      line-height: 1.55;
      min-height: 100%;
    }

    /* ══ SIDEBAR ══════════════════════════════════════════════════════ */
    .layout { display: flex; min-height: 100vh; }

    .sidebar {
      width: 220px;
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      position: fixed;
      top: 0; left: 0; bottom: 0;
      z-index: 40;
      padding: 0;
    }

    .sidebar-brand {
      padding: 24px 20px 20px;
      border-bottom: 1px solid var(--border);
    }
    .sidebar-brand .bw {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--honey);
      margin-bottom: 4px;
    }
    .sidebar-brand .salon-name {
      font-family: 'Lora', serif;
      font-size: 17px;
      font-weight: 600;
      color: var(--ink);
      line-height: 1.2;
    }

    .sidebar-nav {
      flex: 1;
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .nav-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--ink-4);
      padding: 8px 8px 4px;
      margin-top: 8px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 10px;
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: 14px;
      font-weight: 400;
      color: var(--ink-3);
      text-decoration: none;
      transition: all 0.15s;
      user-select: none;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }
    .nav-item:hover { background: var(--surface-2); color: var(--ink-2); }
    .nav-item.active {
      background: var(--honey-light);
      color: var(--ink);
      font-weight: 500;
    }
    .nav-item svg {
      width: 16px; height: 16px;
      flex-shrink: 0;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.7;
    }
    .nav-item.active svg { opacity: 1; }

    .sidebar-footer {
      padding: 16px 12px;
      border-top: 1px solid var(--border);
    }
    .view-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 10px;
      border-radius: var(--r-sm);
      background: none;
      border: 1px solid var(--border-md);
      color: var(--ink-3);
      font-size: 13px;
      font-family: 'Outfit', sans-serif;
      cursor: pointer;
      width: 100%;
      text-align: left;
      text-decoration: none;
      transition: all 0.15s;
    }
    .view-btn:hover { border-color: var(--honey); color: var(--ink); background: var(--honey-light); }
    .view-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; flex-shrink: 0; }

    /* ══ MAIN ═════════════════════════════════════════════════════════ */
    .main {
      margin-left: 220px;
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }

    /* ══ TOPBAR ═══════════════════════════════════════════════════════ */
    .topbar {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 0 32px;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 30;
    }
    .topbar-title {
      font-size: 15px;
      font-weight: 500;
      color: var(--ink);
    }
    .topbar-right { display: flex; align-items: center; gap: 8px; }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
      color: var(--green);
      background: var(--green-bg);
      padding: 5px 12px;
      border-radius: 100px;
    }
    .status-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ══ PAGE CONTENT ═════════════════════════════════════════════════ */
    .page-body { padding: 28px 32px; flex: 1; }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    /* ══ DATE NAV ═════════════════════════════════════════════════════ */
    .date-strip {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .date-arrow {
      width: 34px; height: 34px;
      border-radius: var(--r-sm);
      background: var(--surface);
      border: 1px solid var(--border-md);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      color: var(--ink-3);
      transition: all 0.12s;
      flex-shrink: 0;
    }
    .date-arrow:hover { background: var(--surface-2); color: var(--ink); border-color: var(--border-md); }
    .date-arrow svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; }
    .date-text {
      flex: 1;
      font-family: 'Lora', serif;
      font-size: 20px;
      font-weight: 600;
      color: var(--ink);
      letter-spacing: -0.01em;
    }
    .date-text .today-tag {
      font-family: 'Outfit', sans-serif;
      font-size: 11px;
      font-weight: 500;
      background: var(--honey);
      color: #fff;
      padding: 2px 8px;
      border-radius: 100px;
      margin-left: 10px;
      letter-spacing: 0.02em;
      vertical-align: middle;
    }
    .today-btn {
      font-size: 12px;
      font-weight: 500;
      font-family: 'Outfit', sans-serif;
      color: var(--ink-3);
      background: var(--surface);
      border: 1px solid var(--border-md);
      border-radius: var(--r-sm);
      padding: 6px 14px;
      cursor: pointer;
      transition: all 0.12s;
    }
    .today-btn:hover { color: var(--ink); background: var(--surface-2); }

    /* ══ STAT CARDS ═══════════════════════════════════════════════════ */
    .stats-row {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 14px;
      box-shadow: var(--shadow-sm);
      min-width: 130px;
    }
    .stat-icon {
      width: 36px; height: 36px;
      border-radius: var(--r-sm);
      display: flex; align-items: center; justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
    }
    .stat-icon.total  { background: var(--surface-2); }
    .stat-icon.free   { background: var(--green-bg); }
    .stat-icon.busy   { background: var(--red-bg); }
    .stat-icon.bot    { background: var(--blue-bg); }
    .stat-val {
      font-family: 'Lora', serif;
      font-size: 24px;
      font-weight: 600;
      line-height: 1;
      color: var(--ink);
    }
    .stat-val.green { color: var(--green); }
    .stat-val.red   { color: var(--red); }
    .stat-val.blue  { color: var(--blue); }
    .stat-lbl {
      font-size: 11px;
      font-weight: 500;
      color: var(--ink-4);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-top: 2px;
    }

    /* ══ LEGEND ═══════════════════════════════════════════════════════ */
    .legend {
      display: flex;
      gap: 20px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      color: var(--ink-4);
      font-weight: 500;
    }
    .legend-pip {
      width: 10px; height: 10px;
      border-radius: 3px;
    }
    .legend-pip.free   { background: var(--green); }
    .legend-pip.busy   { background: var(--red); }
    .legend-pip.bot    { background: var(--blue); }

    /* ══ CLOSED BANNER ════════════════════════════════════════════════ */
    .closed-banner {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 64px 24px;
      text-align: center;
      box-shadow: var(--shadow-sm);
    }
    .closed-banner .icon { font-size: 36px; margin-bottom: 16px; }
    .closed-banner h3 {
      font-family: 'Lora', serif;
      font-size: 20px;
      color: var(--ink);
      margin-bottom: 6px;
    }
    .closed-banner p { font-size: 14px; color: var(--ink-4); }

    /* ══ SLOTS GRID ═══════════════════════════════════════════════════ */
    .slots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 10px;
    }
    .slot {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-md);
      padding: 16px;
      cursor: pointer;
      transition: all 0.15s;
      position: relative;
      box-shadow: var(--shadow-sm);
    }
    .slot:hover {
      border-color: var(--honey);
      box-shadow: 0 0 0 3px var(--honey-mid), var(--shadow-sm);
      transform: translateY(-1px);
    }
    .slot-indicator {
      position: absolute;
      top: 12px; right: 12px;
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--green);
    }
    .slot.busy .slot-indicator  { background: var(--red); }
    .slot.bot  .slot-indicator  { background: var(--blue); }
    .slot-time {
      font-family: 'Lora', serif;
      font-size: 22px;
      font-weight: 600;
      color: var(--ink);
      margin-bottom: 4px;
      letter-spacing: -0.02em;
    }
    .slot-badge {
      display: inline-flex;
      align-items: center;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: 4px;
    }
    .slot:not(.busy):not(.bot) .slot-badge { background: var(--green-bg); color: var(--green); }
    .slot.busy .slot-badge { background: var(--red-bg);   color: var(--red);   }
    .slot.bot  .slot-badge { background: var(--blue-bg);  color: var(--blue);  }
    .slot-person {
      font-size: 12px;
      color: var(--ink-3);
      margin-top: 8px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .slot-service {
      font-size: 11px;
      color: var(--ink-4);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* ══ MODAL ════════════════════════════════════════════════════════ */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(20,17,16,0.35);
      backdrop-filter: blur(4px);
      z-index: 200;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .modal-overlay.open { display: flex; }

    .modal {
      background: var(--surface);
      border-radius: var(--r-xl);
      width: 100%;
      max-width: 400px;
      box-shadow: var(--shadow-lg);
      overflow: hidden;
      animation: modalIn 0.2s cubic-bezier(0.34,1.56,0.64,1) both;
    }
    @keyframes modalIn {
      from { opacity: 0; transform: scale(0.92) translateY(12px); }
      to   { opacity: 1; transform: scale(1)    translateY(0); }
    }

    .modal-top {
      padding: 24px 24px 20px;
      background: linear-gradient(135deg, #1C1916 0%, #2E2A26 100%);
      position: relative;
    }
    .modal-time-big {
      font-family: 'Lora', serif;
      font-size: 36px;
      font-weight: 600;
      color: var(--honey-light);
      line-height: 1;
      letter-spacing: -0.02em;
    }
    .modal-date-small {
      font-size: 13px;
      color: rgba(255,255,255,0.4);
      margin-top: 4px;
    }
    .modal-close {
      position: absolute;
      top: 16px; right: 16px;
      width: 28px; height: 28px;
      border-radius: 50%;
      background: rgba(255,255,255,0.08);
      border: none;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      color: rgba(255,255,255,0.5);
      font-size: 16px;
      transition: background 0.15s;
    }
    .modal-close:hover { background: rgba(255,255,255,0.15); color: #fff; }

    .modal-body { padding: 20px 24px 24px; }

    .contact-info-box {
      background: var(--surface-2);
      border-radius: var(--r-sm);
      padding: 12px 14px;
      margin-bottom: 18px;
      display: none;
      flex-direction: column;
      gap: 6px;
    }
    .contact-info-box.show { display: flex; }
    .contact-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--ink-3);
    }
    .contact-row .ci { font-size: 14px; }

    .field-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-4);
      margin-bottom: 6px;
      margin-top: 16px;
    }
    .field-label:first-of-type { margin-top: 0; }
    .field-input {
      width: 100%;
      padding: 10px 13px;
      border: 1px solid var(--border-md);
      border-radius: var(--r-sm);
      font-size: 14px;
      font-family: 'Outfit', sans-serif;
      color: var(--ink);
      background: #fff;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .field-input:focus {
      border-color: var(--honey);
      box-shadow: 0 0 0 3px var(--honey-light);
    }

    .modal-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
    }
    .modal-actions .row-3 { grid-column: 1 / -1; }
    .m-btn {
      padding: 11px 14px;
      border-radius: var(--r-sm);
      border: none;
      font-size: 13px;
      font-weight: 600;
      font-family: 'Outfit', sans-serif;
      cursor: pointer;
      transition: all 0.12s;
      letter-spacing: 0.02em;
    }
    .m-btn:hover { filter: brightness(0.93); transform: translateY(-1px); }
    .m-btn:active { transform: translateY(0); }
    .m-btn.cancel { background: var(--surface-2); color: var(--ink-3); }
    .m-btn.set-free { background: var(--green-bg); color: #0D7A47; }
    .m-btn.set-busy { background: var(--ink); color: var(--honey-light); grid-column: 1/-1; }

    /* ══ SCHEDULE ═════════════════════════════════════════════════════ */
    .schedule-wrap {
      max-width: 640px;
    }
    .section-heading {
      margin-bottom: 20px;
    }
    .section-heading h2 {
      font-family: 'Lora', serif;
      font-size: 20px;
      font-weight: 600;
      color: var(--ink);
      margin-bottom: 4px;
    }
    .section-heading p { font-size: 13px; color: var(--ink-4); }

    .schedule-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }

    .day-row {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      transition: background 0.1s;
    }
    .day-row:last-of-type { border-bottom: none; }
    .day-row:hover { background: var(--bg); }

    .day-label {
      width: 110px;
      font-size: 14px;
      font-weight: 500;
      color: var(--ink-2);
      flex-shrink: 0;
    }

    /* Toggle */
    .toggle {
      position: relative;
      width: 40px; height: 22px;
      flex-shrink: 0;
    }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle-track {
      position: absolute;
      inset: 0;
      background: var(--surface-2);
      border: 1px solid var(--border-md);
      border-radius: 11px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .toggle input:checked ~ .toggle-track {
      background: var(--honey);
      border-color: var(--honey);
    }
    .toggle-thumb {
      position: absolute;
      width: 16px; height: 16px;
      background: #fff;
      border-radius: 50%;
      top: 3px; left: 3px;
      transition: transform 0.2s cubic-bezier(0.34,1.4,0.64,1);
      box-shadow: 0 1px 3px rgba(0,0,0,0.15);
      pointer-events: none;
    }
    .toggle input:checked ~ .toggle-track ~ .toggle-thumb { transform: translateX(18px); }

    .day-times {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--ink-3);
      flex: 1;
    }
    .day-times.off { opacity: 0.28; pointer-events: none; }
    .day-times input[type="time"] {
      padding: 7px 12px;
      border: 1px solid var(--border-md);
      border-radius: var(--r-sm);
      font-size: 13px;
      font-family: 'Outfit', sans-serif;
      color: var(--ink);
      background: #fff;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
      width: 100px;
    }
    .day-times input[type="time"]:focus {
      border-color: var(--honey);
      box-shadow: 0 0 0 3px var(--honey-light);
    }
    .day-times .sep { color: var(--ink-4); font-size: 15px; }
    .day-closed {
      font-size: 12px;
      color: var(--ink-4);
      font-weight: 500;
    }

    .sched-footer {
      padding: 16px 24px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--bg);
    }
    .save-status {
      font-size: 13px;
      color: var(--green);
      font-weight: 500;
      display: none;
      align-items: center;
      gap: 6px;
    }
    .save-status.show { display: flex; }
    .save-status svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.5; }

    .save-btn {
      background: var(--ink);
      color: var(--honey-light);
      border: none;
      border-radius: var(--r-sm);
      padding: 10px 24px;
      font-size: 13px;
      font-weight: 600;
      font-family: 'Outfit', sans-serif;
      cursor: pointer;
      letter-spacing: 0.02em;
      transition: all 0.15s;
    }
    .save-btn:hover { opacity: 0.85; transform: translateY(-1px); }

    /* ══ SCROLLBAR ════════════════════════════════════════════════════ */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border-md); border-radius: 10px; }

    /* ══ RESPONSIVE ═══════════════════════════════════════════════════ */
    @media (max-width: 768px) {
      .sidebar { display: none; }
      .main { margin-left: 0; }
      .page-body { padding: 20px 16px; }
      .topbar { padding: 0 16px; }
      .date-text { font-size: 16px; }
      .slots-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
      .day-row { padding: 14px 16px; }
      .day-label { width: 90px; font-size: 13px; }
    }
  </style>
</head>
<body>

<div class="layout">

  <!-- SIDEBAR -->
  <aside class="sidebar">
    <div class="sidebar-brand">
      <div class="bw">BookWell</div>
      <div class="salon-name">${salon.name}</div>
    </div>
    <nav class="sidebar-nav">
      <div class="nav-label">Upravljanje</div>
      <button class="nav-item active" onclick="switchTab('termini', this)">
        <svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1v3M11 1v3M2 7h12"/></svg>
        Termini
      </button>
      <button class="nav-item" onclick="switchTab('urnik', this)">
        <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2 1.5"/></svg>
        Delovni čas
      </button>
    </nav>
    <div class="sidebar-footer">
      <a href="/${salon.type || 'salon'}/${salon.slug || salon.id}" class="view-btn">
        <svg viewBox="0 0 16 16"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9M9 2h5m0 0v5m0-5L7 10"/></svg>
        Stran stranke
      </a>
    </div>
  </aside>

  <!-- MAIN -->
  <div class="main">

    <div class="topbar">
      <span class="topbar-title" id="topbar-title">Termini</span>
      <div class="topbar-right">
        <div class="status-pill">
          <div class="status-dot"></div>
          AI Asistent aktiven
        </div>
      </div>
    </div>

    <div class="page-body">

      <!-- ═══ TERMINI ═══ -->
      <div class="tab-pane active" id="tab-termini">

        <div class="date-strip">
          <button class="date-arrow" id="prev">
            <svg viewBox="0 0 16 16" stroke-linecap="round"><path d="M10 4L6 8l4 4"/></svg>
          </button>
          <div class="date-text" id="dateTitle"></div>
          <button class="today-btn" id="today">Danes</button>
          <button class="date-arrow" id="next">
            <svg viewBox="0 0 16 16" stroke-linecap="round"><path d="M6 4l4 4-4 4"/></svg>
          </button>
        </div>

        <div class="stats-row" id="stats-row"></div>

        <div class="legend">
          <div class="legend-item"><div class="legend-pip free"></div> Prost</div>
          <div class="legend-item"><div class="legend-pip busy"></div> Zaseden (ročno)</div>
          <div class="legend-item"><div class="legend-pip bot"></div> Rezerviral AI</div>
        </div>

        <div id="slots-container"></div>

      </div>

      <!-- ═══ URNIK ═══ -->
      <div class="tab-pane" id="tab-urnik">
        <div class="schedule-wrap">
          <div class="section-heading">
            <h2>Delovni čas</h2>
            <p>Nastavljeni urniki določajo, kdaj so termini na voljo strankam.</p>
          </div>
          <div class="schedule-card">
            <div id="schedule-rows"></div>
            <div class="sched-footer">
              <div class="save-status" id="save-status">
                <svg viewBox="0 0 16 16"><path d="M3 8l3.5 3.5L13 4"/></svg>
                Shranjeno
              </div>
              <button class="save-btn" onclick="saveSchedule()">Shrani spremembe</button>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>

</div>

<!-- MODAL -->
<div class="modal-overlay" id="modal-overlay">
  <div class="modal">
    <div class="modal-top">
      <div class="modal-time-big" id="m-time"></div>
      <div class="modal-date-small" id="m-date"></div>
      <button class="modal-close" id="modal-close">✕</button>
    </div>
    <div class="modal-body">
      <div class="contact-info-box" id="m-contact">
        <div class="contact-row"><span class="ci">✉️</span><span id="m-email"></span></div>
        <div class="contact-row"><span class="ci">📞</span><span id="m-phone"></span></div>
      </div>
      <div class="field-label">Ime stranke</div>
      <input class="field-input" type="text" id="m-name" placeholder="Ime in priimek" />
      <div class="field-label">Storitev</div>
      <input class="field-input" type="text" id="m-service" placeholder="npr. Ženski haircut" />
      <div class="modal-actions">
        <button class="m-btn cancel" id="m-cancel">Preklic</button>
        <button class="m-btn set-free" id="m-free">Označi kot prost</button>
        <button class="m-btn set-busy" id="m-busy">Shrani & Zaseden</button>
      </div>
    </div>
  </div>
</div>

<script>
  const API_URL  = '${apiUrl}';
  const SALON_ID = '${salon.id}';

  const DAY_KEYS = ['mon','tue','wed','thu','fri','sat','sun'];
  const DAY_SL   = { mon:'Ponedeljek', tue:'Torek', wed:'Sreda', thu:'Četrtek', fri:'Petek', sat:'Sobota', sun:'Nedelja' };

  let currentDate = new Date();
  let currentSlot = null;
  let slotsData   = {};
  let schedule    = ${scheduleJson};

  // ── helpers ───────────────────────────────────────────────────────
  function fmt(d)    { return d.toISOString().split('T')[0]; }
  function fmtSl(d)  { return d.toLocaleDateString('sl-SI', { weekday:'long', day:'numeric', month:'long', year:'numeric' }); }
  function isToday(d){ return d.toDateString() === new Date().toDateString(); }
  function getDayKey(d){ return ['sun','mon','tue','wed','thu','fri','sat'][d.getDay()]; }
  function genSlots(from, to){
    const s = [];
    let [h,m] = from.split(':').map(Number);
    const [eh,em] = to.split(':').map(Number);
    while(h < eh || (h===eh && m<em)){
      s.push(String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'));
      m+=30; if(m>=60){m-=60;h++;}
    }
    return s;
  }

  // ── tab switch ────────────────────────────────────────────────────
  function switchTab(name, el){
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    document.getElementById('topbar-title').textContent = name === 'termini' ? 'Termini' : 'Delovni čas';
  }

  // ── load slots ────────────────────────────────────────────────────
  async function loadSlots(){
    const dateStr  = fmt(currentDate);
    const titleEl  = document.getElementById('dateTitle');
    const todayTag = isToday(currentDate) ? '<span class="today-tag">Danes</span>' : '';
    titleEl.innerHTML = fmtSl(currentDate) + todayTag;

    const dayKey = getDayKey(currentDate);
    const day    = schedule[dayKey];
    const cont   = document.getElementById('slots-container');

    if(!day || !day.open){
      cont.innerHTML = \`<div class="closed-banner"><div class="icon">🚫</div><h3>Salon je zaprt</h3><p>Ta dan ni delovnega časa.</p></div>\`;
      document.getElementById('stats-row').innerHTML = '';
      return;
    }

    const res  = await fetch(API_URL + '/admin/' + SALON_ID + '/timeslots?date=' + dateStr);
    const data = await res.json();
    slotsData  = {};
    data.forEach(s => { slotsData[s.time] = s; });

    const hours     = genSlots(day.from, day.to);
    const busyCount = hours.filter(h => slotsData[h]?.status === 'busy').length;
    const botCount  = hours.filter(h => slotsData[h]?.status === 'busy' && slotsData[h]?.customer_email).length;
    const freeCount = hours.length - busyCount;

    document.getElementById('stats-row').innerHTML = \`
      <div class="stat-card"><div class="stat-icon total">📋</div><div><div class="stat-val">\${hours.length}</div><div class="stat-lbl">Skupaj</div></div></div>
      <div class="stat-card"><div class="stat-icon free">✅</div><div><div class="stat-val green">\${freeCount}</div><div class="stat-lbl">Prostih</div></div></div>
      <div class="stat-card"><div class="stat-icon busy">🔴</div><div><div class="stat-val red">\${busyCount}</div><div class="stat-lbl">Zasedenih</div></div></div>
      <div class="stat-card"><div class="stat-icon bot">🤖</div><div><div class="stat-val blue">\${botCount}</div><div class="stat-lbl">AI rezerv.</div></div></div>
    \`;

    cont.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'slots-grid';
    hours.forEach(hour => {
      const s     = slotsData[hour];
      const busy  = s?.status === 'busy';
      const isBot = busy && s?.customer_email;
      const cls   = busy ? (isBot ? 'bot' : 'busy') : '';
      const badge = busy ? (isBot ? 'AI' : 'Zaseden') : 'Prost';
      const card  = document.createElement('div');
      card.className = 'slot ' + cls;
      card.innerHTML = \`
        <div class="slot-indicator"></div>
        <div class="slot-time">\${hour}</div>
        <span class="slot-badge">\${badge}</span>
        \${s?.customer_name ? \`<div class="slot-person">\${s.customer_name}</div>\` : ''}
        \${s?.service       ? \`<div class="slot-service">\${s.service}</div>\`       : ''}
      \`;
      card.addEventListener('click', () => openModal(hour, s));
      grid.appendChild(card);
    });
    cont.appendChild(grid);
  }

  // ── modal ─────────────────────────────────────────────────────────
  function openModal(time, slot){
    currentSlot = time;
    document.getElementById('m-time').textContent = time;
    document.getElementById('m-date').textContent = fmtSl(currentDate);
    document.getElementById('m-name').value    = slot?.customer_name || '';
    document.getElementById('m-service').value = slot?.service       || '';

    const box = document.getElementById('m-contact');
    if(slot?.customer_email){
      document.getElementById('m-email').textContent = slot.customer_email;
      document.getElementById('m-phone').textContent = slot.customer_phone || '–';
      box.classList.add('show');
    } else {
      box.classList.remove('show');
    }
    document.getElementById('modal-overlay').classList.add('open');
  }

  function closeModal(){ document.getElementById('modal-overlay').classList.remove('open'); }

  async function saveSlot(status){
    await fetch(API_URL + '/admin/' + SALON_ID + '/timeslots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: fmt(currentDate),
        time: currentSlot,
        status,
        customerName: document.getElementById('m-name').value,
        service: document.getElementById('m-service').value
      })
    });
    closeModal();
    loadSlots();
  }

  // ── schedule ──────────────────────────────────────────────────────
  function buildScheduleUI(){
    const cont = document.getElementById('schedule-rows');
    cont.innerHTML = '';
    DAY_KEYS.forEach(key => {
      const d   = schedule[key] || { open:false, from:'08:00', to:'20:00' };
      const row = document.createElement('div');
      row.className = 'day-row';
      row.innerHTML = \`
        <div class="day-label">\${DAY_SL[key]}</div>
        <label class="toggle">
          <input type="checkbox" id="open-\${key}" \${d.open ? 'checked' : ''}>
          <div class="toggle-track"></div>
          <div class="toggle-thumb"></div>
        </label>
        <div class="day-times \${d.open ? '' : 'off'}" id="times-\${key}">
          <input type="time" id="from-\${key}" value="\${d.from}" step="1800">
          <span class="sep">–</span>
          <input type="time" id="to-\${key}"   value="\${d.to}"   step="1800">
        </div>
        \${!d.open ? '<span class="day-closed">Zaprto</span>' : ''}
      \`;
      cont.appendChild(row);
      document.getElementById('open-' + key).addEventListener('change', () => toggleDay(key));
    });
  }

  function toggleDay(key){
    const open  = document.getElementById('open-' + key).checked;
    const times = document.getElementById('times-' + key);
    if(times) times.className = 'day-times' + (open ? '' : ' off');
    const closed = times?.nextElementSibling;
    if(closed?.classList.contains('day-closed')) closed.style.display = open ? 'none' : '';
  }

  async function saveSchedule(){
    const ns = {};
    DAY_KEYS.forEach(key => {
      ns[key] = {
        open: document.getElementById('open-' + key).checked,
        from: document.getElementById('from-' + key)?.value || '08:00',
        to:   document.getElementById('to-' + key)?.value   || '20:00'
      };
    });
    await fetch(API_URL + '/admin/' + SALON_ID + '/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ns)
    });
    schedule = ns;
    const st = document.getElementById('save-status');
    st.classList.add('show');
    setTimeout(() => st.classList.remove('show'), 2400);
    loadSlots();
  }

  // ── events ────────────────────────────────────────────────────────
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('m-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => { if(e.target === document.getElementById('modal-overlay')) closeModal(); });
  document.getElementById('m-busy').addEventListener('click', () => saveSlot('busy'));
  document.getElementById('m-free').addEventListener('click', () => saveSlot('free'));
  document.getElementById('prev').addEventListener('click', () => { currentDate.setDate(currentDate.getDate()-1); loadSlots(); });
  document.getElementById('next').addEventListener('click', () => { currentDate.setDate(currentDate.getDate()+1); loadSlots(); });
  document.getElementById('today').addEventListener('click', () => { currentDate = new Date(); loadSlots(); });

  // ── init ──────────────────────────────────────────────────────────
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