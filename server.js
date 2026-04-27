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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${salon.name} · Admin</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

    :root {
      --blue:    #007AFF;
      --blue-bg: rgba(0,122,255,0.10);
      --green:   #34C759;
      --green-bg:rgba(52,199,89,0.12);
      --red:     #FF3B30;
      --red-bg:  rgba(255,59,48,0.10);
      --gray-1:  #8E8E93;
      --gray-2:  #C7C7CC;
      --gray-3:  #D1D1D6;
      --gray-4:  #E5E5EA;
      --gray-5:  #F2F2F7;
      --gray-6:  #F9F9FB;
      --ink:     #1C1C1E;
      --ink-2:   #3A3A3C;
      --ink-3:   #636366;
      --white:   #FFFFFF;
      --radius-sm: 8px;
      --radius:    12px;
      --radius-lg: 16px;
      --radius-xl: 22px;
    }

    html, body { height: 100%; background: var(--gray-5); }

    body {
      font-family: -apple-system, "SF Pro Display", "SF Pro Text", BlinkMacSystemFont, system-ui, sans-serif;
      color: var(--ink);
      font-size: 15px;
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
    }

    /* ── HEADER ────────────────────────────── */
    .header {
      position: sticky; top: 0; z-index: 100;
      background: rgba(255,255,255,0.85);
      backdrop-filter: saturate(180%) blur(20px);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      border-bottom: 0.5px solid var(--gray-3);
      padding: 0 20px;
      height: 52px;
      display: flex; align-items: center; gap: 12px;
    }
    .header-salon {
      font-size: 17px; font-weight: 600; color: var(--ink);
      letter-spacing: -0.3px;
    }
    .header-spacer { flex: 1; }
    .header-view-btn {
      display: flex; align-items: center; gap: 5px;
      font-size: 15px; color: var(--blue);
      text-decoration: none; font-weight: 400;
      padding: 5px 0;
    }
    .header-view-btn svg { width: 13px; height: 13px; }

    /* ── SEGMENT CONTROL ───────────────────── */
    .segment-wrap {
      padding: 10px 20px 0;
      background: rgba(255,255,255,0.85);
      backdrop-filter: saturate(180%) blur(20px);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      border-bottom: 0.5px solid var(--gray-3);
      position: sticky; top: 52px; z-index: 90;
    }
    .segment {
      display: flex;
      background: var(--gray-4);
      border-radius: 9px;
      padding: 2px;
      max-width: 240px;
      margin-bottom: 10px;
    }
    .seg-btn {
      flex: 1; padding: 6px 0;
      font-size: 13px; font-weight: 500;
      color: var(--ink-3); border: none;
      background: none; border-radius: 7px;
      cursor: pointer; transition: all 0.18s ease;
      font-family: inherit; letter-spacing: -0.1px;
    }
    .seg-btn.active {
      background: var(--white);
      color: var(--ink);
      box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 0.5px 1px rgba(0,0,0,0.06);
    }

    /* ── PAGE CONTENT ──────────────────────── */
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .page { max-width: 700px; margin: 0 auto; padding: 20px 20px 40px; }

    /* ── DATE NAVIGATION ───────────────────── */
    .date-nav {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 16px;
    }
    .chev-btn {
      width: 32px; height: 32px;
      border-radius: 50%; border: none;
      background: var(--white);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; color: var(--blue);
      box-shadow: 0 1px 3px rgba(0,0,0,0.10);
      transition: background 0.12s;
      flex-shrink: 0;
    }
    .chev-btn:active { background: var(--gray-4); }
    .chev-btn svg { width: 16px; height: 16px; }
    .date-center { flex: 1; text-align: center; }
    .date-big {
      font-size: 19px; font-weight: 700;
      color: var(--ink); letter-spacing: -0.5px;
    }
    .date-sub {
      font-size: 12px; color: var(--gray-1);
      margin-top: 1px; letter-spacing: -0.1px;
    }
    .today-pill {
      font-size: 12px; font-weight: 500; color: var(--blue);
      background: var(--blue-bg); border: none;
      border-radius: 100px; padding: 4px 12px;
      cursor: pointer; font-family: inherit;
      transition: opacity 0.12s; white-space: nowrap;
    }
    .today-pill:active { opacity: 0.65; }

    /* ── STAT DOTS ─────────────────────────── */
    .stats-row {
      display: flex; gap: 16px; align-items: center;
      margin-bottom: 16px; flex-wrap: wrap;
    }
    .stat-dot-item {
      display: flex; align-items: center; gap: 6px;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    }
    .dot-free  { background: var(--green); }
    .dot-busy  { background: var(--red); }
    .dot-bot   { background: var(--blue); }
    .dot-total { background: var(--gray-2); }
    .stat-count {
      font-size: 14px; font-weight: 600; color: var(--ink);
      letter-spacing: -0.3px;
    }
    .stat-lbl {
      font-size: 12px; color: var(--gray-1);
    }

    /* ── CLOSED BANNER ─────────────────────── */
    .closed-banner {
      background: var(--white); border-radius: var(--radius-lg);
      padding: 40px 24px; text-align: center;
      box-shadow: 0 1px 0 rgba(0,0,0,0.04);
    }
    .closed-icon { font-size: 36px; margin-bottom: 10px; }
    .closed-title { font-size: 17px; font-weight: 600; color: var(--ink); margin-bottom: 4px; }
    .closed-sub { font-size: 14px; color: var(--gray-1); }

    /* ── SLOT CHIPS GRID ───────────────────── */
    .slots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
      gap: 8px;
    }
    .slot-chip {
      background: var(--white);
      border: none; border-radius: 100px;
      padding: 10px 8px;
      display: flex; flex-direction: column;
      align-items: center; gap: 4px;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 0.5px 0 rgba(0,0,0,0.04);
      transition: transform 0.12s, box-shadow 0.12s;
      position: relative; overflow: hidden;
    }
    .slot-chip::before {
      content: '';
      position: absolute; top: 0; left: 0; right: 0;
      height: 3px;
      background: var(--green);
    }
    .slot-chip.busy::before  { background: var(--red); }
    .slot-chip.bot::before   { background: var(--blue); }
    .slot-chip:active {
      transform: scale(0.95);
      box-shadow: 0 0.5px 2px rgba(0,0,0,0.08);
    }
    .chip-time {
      font-size: 15px; font-weight: 600;
      color: var(--ink); letter-spacing: -0.3px;
    }
    .chip-badge {
      font-size: 10px; font-weight: 600;
      letter-spacing: 0.3px; text-transform: uppercase;
      padding: 2px 8px; border-radius: 100px;
    }
    .slot-chip:not(.busy):not(.bot) .chip-badge { color: var(--green); background: var(--green-bg); }
    .slot-chip.busy  .chip-badge { color: var(--red);  background: var(--red-bg); }
    .slot-chip.bot   .chip-badge { color: var(--blue); background: var(--blue-bg); }
    .chip-name {
      font-size: 10px; color: var(--gray-1);
      white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; max-width: 84px;
      text-align: center;
    }

    /* ── MODAL SHEET ───────────────────────── */
    .sheet-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.35);
      z-index: 300; align-items: flex-end;
      justify-content: center;
    }
    .sheet-overlay.open { display: flex; }
    .sheet {
      background: var(--gray-5);
      border-radius: 20px 20px 0 0;
      width: 100%; max-width: 540px;
      overflow: hidden;
      animation: slideUp 0.28s cubic-bezier(0.32,0.72,0,1);
    }
    @keyframes slideUp {
      from { transform: translateY(100%); }
      to   { transform: translateY(0); }
    }
    .sheet-handle {
      width: 36px; height: 4px; border-radius: 2px;
      background: var(--gray-3); margin: 10px auto 0;
    }
    .sheet-header {
      padding: 16px 20px 12px;
      border-bottom: 0.5px solid var(--gray-4);
      display: flex; align-items: center; justify-content: space-between;
    }
    .sheet-title {
      font-size: 20px; font-weight: 700;
      color: var(--ink); letter-spacing: -0.5px;
    }
    .sheet-date-lbl {
      font-size: 13px; color: var(--gray-1); margin-top: 2px;
    }
    .sheet-close {
      width: 30px; height: 30px; border-radius: 50%;
      background: var(--gray-4); border: none;
      font-size: 16px; color: var(--gray-1);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-family: inherit;
    }
    .sheet-body { padding: 16px 20px 32px; display: flex; flex-direction: column; gap: 12px; }

    .sheet-info-card {
      background: var(--blue-bg);
      border-radius: var(--radius);
      padding: 12px 14px;
      display: none; gap: 6px; flex-direction: column;
    }
    .sheet-info-card.visible { display: flex; }
    .info-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); }
    .info-row span:first-child { font-size: 15px; }

    .field-group { display: flex; flex-direction: column; gap: 4px; }
    .field-label {
      font-size: 12px; font-weight: 500;
      color: var(--gray-1); letter-spacing: 0.04em; text-transform: uppercase;
      padding-left: 4px;
    }
    .field-input {
      width: 100%; padding: 11px 14px;
      background: var(--white);
      border: none; border-radius: var(--radius);
      font-size: 15px; font-family: inherit;
      color: var(--ink); outline: none;
      box-shadow: 0 1px 3px rgba(0,0,0,0.07);
      transition: box-shadow 0.15s;
    }
    .field-input:focus { box-shadow: 0 0 0 3px rgba(0,122,255,0.18), 0 1px 3px rgba(0,0,0,0.07); }

    .sheet-actions {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 10px; margin-top: 4px;
    }
    .action-btn {
      padding: 13px 0; border-radius: var(--radius);
      font-size: 15px; font-weight: 600;
      border: none; cursor: pointer; font-family: inherit;
      transition: opacity 0.12s, transform 0.1s;
      letter-spacing: -0.2px;
    }
    .action-btn:active { opacity: 0.7; transform: scale(0.98); }
    .btn-mark-free { background: var(--green-bg); color: var(--green); }
    .btn-mark-busy { background: var(--red-bg);   color: var(--red); }
    .btn-cancel-full {
      grid-column: 1 / -1;
      background: var(--gray-4); color: var(--ink-3);
    }

    /* ── SCHEDULE ──────────────────────────── */
    .sched-card {
      background: var(--white); border-radius: var(--radius-lg);
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .sched-section-title {
      font-size: 13px; font-weight: 600; color: var(--gray-1);
      letter-spacing: 0.03em; text-transform: uppercase;
      padding: 16px 20px 8px;
    }
    .day-row {
      display: flex; align-items: center; gap: 14px;
      padding: 12px 20px;
      border-top: 0.5px solid var(--gray-4);
    }
    .day-row:first-child { border-top: none; }
    .day-name {
      width: 90px; font-size: 15px;
      color: var(--ink); font-weight: 400;
    }
    .ios-toggle { position: relative; width: 51px; height: 31px; flex-shrink: 0; }
    .ios-toggle input { opacity: 0; width: 0; height: 0; }
    .ios-track {
      position: absolute; inset: 0;
      background: var(--gray-3); border-radius: 31px;
      cursor: pointer; transition: background 0.22s;
    }
    .ios-toggle input:checked + .ios-track { background: var(--green); }
    .ios-track::before {
      content: '';
      position: absolute;
      width: 27px; height: 27px;
      background: #fff; border-radius: 50%;
      top: 2px; left: 2px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
      transition: transform 0.22s cubic-bezier(0.34,1.56,0.64,1);
    }
    .ios-toggle input:checked + .ios-track::before { transform: translateX(20px); }
    .day-times {
      display: flex; align-items: center; gap: 8px;
      flex: 1; justify-content: flex-end; font-size: 14px; color: var(--ink);
    }
    .day-times.disabled { opacity: 0.3; pointer-events: none; }
    .time-input {
      padding: 5px 10px;
      border: none; border-radius: 8px;
      background: var(--gray-5);
      font-size: 14px; font-family: inherit; color: var(--ink);
      outline: none; transition: background 0.12s;
    }
    .time-input:focus { background: var(--gray-4); }
    .time-sep { color: var(--gray-2); font-size: 16px; }

    .sched-footer {
      border-top: 0.5px solid var(--gray-4);
      padding: 14px 20px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .saved-label {
      font-size: 14px; color: var(--green);
      font-weight: 500; display: none;
    }
    .saved-label.show { display: block; }
    .save-btn {
      background: var(--blue); color: #fff;
      border: none; border-radius: var(--radius);
      padding: 9px 22px; font-size: 15px;
      font-weight: 600; font-family: inherit;
      cursor: pointer; transition: opacity 0.12s;
      letter-spacing: -0.2px;
    }
    .save-btn:active { opacity: 0.7; }

    /* ── SCROLLBAR ─────────────────────────── */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-thumb { background: var(--gray-3); border-radius: 4px; }

    /* ── RESPONSIVE ────────────────────────── */
    @media (max-width: 480px) {
      .slots-grid { grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 6px; }
      .date-big { font-size: 16px; }
    }
  </style>
</head>
<body>

  <!-- HEADER -->
  <div class="header">
    <div class="header-salon">${salon.name}</div>
    <div class="header-spacer"></div>
    <a href="/${salon.type || 'salon'}/${salon.slug || salon.id}" class="header-view-btn">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M9 2h5v5M14 2L8 8M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/>
      </svg>
      Salon
    </a>
  </div>

  <!-- SEGMENT TABS -->
  <div class="segment-wrap">
    <div class="segment">
      <button class="seg-btn active" onclick="switchTab('termini')">Termini</button>
      <button class="seg-btn" onclick="switchTab('urnik')">Delovni čas</button>
    </div>
  </div>

  <!-- TAB: TERMINI -->
  <div class="tab-content active" id="tab-termini">
    <div class="page">

      <div class="date-nav">
        <button class="chev-btn" id="prev">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 3L5 8l5 5"/>
          </svg>
        </button>
        <div class="date-center">
          <div class="date-big" id="dateTitle"></div>
          <div class="date-sub" id="dateSub"></div>
        </div>
        <button class="today-pill" id="today">Danes</button>
        <button class="chev-btn" id="next">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 3l5 5-5 5"/>
          </svg>
        </button>
      </div>

      <div class="stats-row" id="stats-row"></div>

      <div id="slots-container"></div>
    </div>
  </div>

  <!-- TAB: URNIK -->
  <div class="tab-content" id="tab-urnik">
    <div class="page">
      <div class="sched-card">
        <div class="sched-section-title">Delovni čas salona</div>
        <div id="schedule-rows"></div>
        <div class="sched-footer">
          <div class="saved-label" id="save-msg">✓ Shranjeno</div>
          <button class="save-btn" onclick="saveSchedule()">Shrani</button>
        </div>
      </div>
    </div>
  </div>

  <!-- BOTTOM SHEET MODAL -->
  <div class="sheet-overlay" id="sheet-overlay">
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <div>
          <div class="sheet-title" id="sheet-time"></div>
          <div class="sheet-date-lbl" id="sheet-date"></div>
        </div>
        <button class="sheet-close" id="sheet-close">✕</button>
      </div>
      <div class="sheet-body">
        <div class="sheet-info-card" id="sheet-info"></div>
        <div class="field-group">
          <div class="field-label">Ime stranke</div>
          <input class="field-input" type="text" id="modal-customer" placeholder="Ime Priimek" autocomplete="name">
        </div>
        <div class="field-group">
          <div class="field-label">Storitev</div>
          <input class="field-input" type="text" id="modal-service" placeholder="npr. Ženski haircut" autocomplete="off">
        </div>
        <div class="sheet-actions">
          <button class="action-btn btn-mark-free" id="modal-set-free">Prost</button>
          <button class="action-btn btn-mark-busy" id="modal-set-busy">Zaseden</button>
          <button class="action-btn btn-cancel-full" id="modal-cancel">Preklic</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const API_URL   = '${apiUrl}';
    const SALON_ID  = '${salon.id}';
    const DAY_KEYS  = ['mon','tue','wed','thu','fri','sat','sun'];
    const DAY_SL    = { mon:'Ponedeljek', tue:'Torek', wed:'Sreda', thu:'Četrtek', fri:'Petek', sat:'Sobota', sun:'Nedelja' };

    let currentDate = new Date();
    let currentSlot = null;
    let slotsData   = {};
    let schedule    = ${scheduleJson};

    /* ── HELPERS ─────────────────────────────── */
    function pad(n) { return String(n).padStart(2,'0'); }

    function formatISO(d) { return d.toISOString().split('T')[0]; }

    function isToday(d) {
      const n = new Date();
      return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
    }

    function getDayKey(d) { return ['sun','mon','tue','wed','thu','fri','sat'][d.getDay()]; }

    function generateSlots(from, to) {
      const slots = [];
      let [h, m] = from.split(':').map(Number);
      const [eh, em] = to.split(':').map(Number);
      while (h < eh || (h === eh && m < em)) {
        slots.push(pad(h) + ':' + pad(m));
        m += 30; if (m >= 60) { m -= 60; h++; }
      }
      return slots;
    }

    function formatDateFull(d) {
      return d.toLocaleDateString('sl-SI', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    }

    function formatDateShort(d) {
      return d.toLocaleDateString('sl-SI', { weekday:'long', day:'numeric', month:'long' });
    }

    /* ── TAB SWITCHING ───────────────────────── */
    function switchTab(name) {
      document.querySelectorAll('.seg-btn').forEach((b, i) =>
        b.classList.toggle('active', ['termini','urnik'][i] === name));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
    }

    /* ── SLOT LOADING ────────────────────────── */
    async function loadSlots() {
      const dateStr  = formatISO(currentDate);
      const dayKey   = getDayKey(currentDate);
      const daySched = schedule[dayKey];

      // Date header
      document.getElementById('dateTitle').textContent = formatDateShort(currentDate);
      document.getElementById('dateSub').textContent   = isToday(currentDate) ? 'Danes' : currentDate.getFullYear();

      const container = document.getElementById('slots-container');

      if (!daySched || !daySched.open) {
        container.innerHTML = \`
          <div class="closed-banner">
            <div class="closed-icon">🚫</div>
            <div class="closed-title">Salon je zaprt</div>
            <div class="closed-sub">Ta dan ni delovnega časa</div>
          </div>\`;
        document.getElementById('stats-row').innerHTML = '';
        return;
      }

      const res  = await fetch(API_URL + '/admin/' + SALON_ID + '/timeslots?date=' + dateStr);
      const data = await res.json();
      slotsData  = {};
      data.forEach(s => { slotsData[s.time] = s; });

      const hours    = generateSlots(daySched.from, daySched.to);
      const busyList = hours.filter(h => slotsData[h]?.status === 'busy');
      const botList  = busyList.filter(h => slotsData[h]?.customer_email);
      const freeCount = hours.length - busyList.length;

      document.getElementById('stats-row').innerHTML = \`
        <div class="stat-dot-item"><div class="dot dot-total"></div><span class="stat-count">\${hours.length}</span><span class="stat-lbl">terminov</span></div>
        <div class="stat-dot-item"><div class="dot dot-free"></div><span class="stat-count">\${freeCount}</span><span class="stat-lbl">prostih</span></div>
        <div class="stat-dot-item"><div class="dot dot-busy"></div><span class="stat-count">\${busyList.length - botList.length}</span><span class="stat-lbl">zasedenih</span></div>
        <div class="stat-dot-item"><div class="dot dot-bot"></div><span class="stat-count">\${botList.length}</span><span class="stat-lbl">bot</span></div>
      \`;

      container.innerHTML = '<div class="slots-grid" id="slots"></div>';
      const grid = document.getElementById('slots');

      hours.forEach(hour => {
        const slot  = slotsData[hour];
        const isBusy = slot?.status === 'busy';
        const isBot  = isBusy && slot?.customer_email;
        const cls    = isBusy ? (isBot ? 'bot' : 'busy') : '';

        const chip = document.createElement('button');
        chip.className = 'slot-chip ' + cls;
        chip.innerHTML = \`
          <div class="chip-time">\${hour}</div>
          <div class="chip-badge">\${isBusy ? (isBot ? 'Bot' : 'Zaseden') : 'Prost'}</div>
          \${slot?.customer_name ? \`<div class="chip-name">\${slot.customer_name}</div>\` : ''}
        \`;
        chip.addEventListener('click', () => openSheet(hour, slot));
        grid.appendChild(chip);
      });
    }

    /* ── SHEET MODAL ─────────────────────────── */
    function openSheet(time, slot) {
      currentSlot = time;
      document.getElementById('sheet-time').textContent = time;
      document.getElementById('sheet-date').textContent = formatDateFull(currentDate);
      document.getElementById('modal-customer').value   = slot?.customer_name || '';
      document.getElementById('modal-service').value    = slot?.service || '';

      const info = document.getElementById('sheet-info');
      if (slot?.customer_email) {
        info.className = 'sheet-info-card visible';
        info.innerHTML = \`
          <div class="info-row"><span>✉️</span><span>\${slot.customer_email}</span></div>
          <div class="info-row"><span>📞</span><span>\${slot.customer_phone || '–'}</span></div>
        \`;
      } else {
        info.className = 'sheet-info-card';
        info.innerHTML = '';
      }
      document.getElementById('sheet-overlay').classList.add('open');
    }

    function closeSheet() { document.getElementById('sheet-overlay').classList.remove('open'); }

    async function saveSlot(status) {
      await fetch(API_URL + '/admin/' + SALON_ID + '/timeslots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: formatISO(currentDate),
          time: currentSlot,
          status,
          customerName: document.getElementById('modal-customer').value,
          service:      document.getElementById('modal-service').value
        })
      });
      closeSheet();
      loadSlots();
    }

    /* ── SCHEDULE UI ─────────────────────────── */
    function buildScheduleUI() {
      const container = document.getElementById('schedule-rows');
      container.innerHTML = '';
      DAY_KEYS.forEach(key => {
        const d   = schedule[key] || { open: false, from: '08:00', to: '20:00' };
        const row = document.createElement('div');
        row.className = 'day-row';
        row.innerHTML = \`
          <div class="day-name">\${DAY_SL[key]}</div>
          <label class="ios-toggle">
            <input type="checkbox" id="open-\${key}" \${d.open ? 'checked' : ''} onchange="toggleDay('\${key}')">
            <div class="ios-track"></div>
          </label>
          <div class="day-times \${d.open ? '' : 'disabled'}" id="times-\${key}">
            <input class="time-input" type="time" id="from-\${key}" value="\${d.from}" step="1800">
            <span class="time-sep">–</span>
            <input class="time-input" type="time" id="to-\${key}" value="\${d.to}" step="1800">
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
      const newSched = {};
      DAY_KEYS.forEach(key => {
        newSched[key] = {
          open: document.getElementById('open-' + key).checked,
          from: document.getElementById('from-' + key).value || '08:00',
          to:   document.getElementById('to-' + key).value   || '20:00'
        };
      });
      await fetch(API_URL + '/admin/' + SALON_ID + '/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSched)
      });
      schedule = newSched;
      const msg = document.getElementById('save-msg');
      msg.classList.add('show');
      setTimeout(() => msg.classList.remove('show'), 2200);
      loadSlots();
    }

    /* ── EVENTS ──────────────────────────────── */
    document.getElementById('modal-cancel').addEventListener('click', closeSheet);
    document.getElementById('sheet-close').addEventListener('click', closeSheet);
    document.getElementById('sheet-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('sheet-overlay')) closeSheet();
    });
    document.getElementById('modal-set-free').addEventListener('click', () => saveSlot('free'));
    document.getElementById('modal-set-busy').addEventListener('click', () => saveSlot('busy'));

    document.getElementById('prev').addEventListener('click', () => {
      currentDate.setDate(currentDate.getDate() - 1); loadSlots();
    });
    document.getElementById('next').addEventListener('click', () => {
      currentDate.setDate(currentDate.getDate() + 1); loadSlots();
    });
    document.getElementById('today').addEventListener('click', () => {
      currentDate = new Date(); loadSlots();
    });

    /* ── INIT ────────────────────────────────── */
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