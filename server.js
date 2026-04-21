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
      customer_email TEXT,
      customer_phone TEXT,
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

// ─── EMAIL FUNKCIJE ──────────────────────────────────────────────────────────
async function sendConfirmationEmail(customerEmail, customerName, salon, date, time, service) {
  try {
    const dateLj = new Date(date + 'T00:00:00');
    const dateFormatted = dateLj.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    
    const msg = {
      to: customerEmail,
      from: process.env.SENDGRID_FROM_EMAIL || 'noreply@frizerbot.si',
      subject: `✅ Rezervacija potrjena - ${salon.name}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #2d2520;">
          <div style="background: #1a1410; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #c9a84c; margin: 0; font-size: 24px;">✅ Rezervacija Potrjena</h1>
          </div>
          
          <div style="background: #fff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <p style="margin: 0 0 20px 0; font-size: 16px;">Pozdravljeni <strong>${customerName}</strong>,</p>
            
            <p style="margin: 0 0 25px 0; font-size: 14px; color: #6b5f52;">Vaša rezervacija je uspješno potvrjena. Pogledajte detalje ispod:</p>
            
            <div style="background: #f5f0eb; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">📅 Datum:</span>
                <strong style="color: #1a1410;">${dateFormatted}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">🕐 Vrijeme:</span>
                <strong style="color: #1a1410;">${time}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">💇 Usluga:</span>
                <strong style="color: #1a1410;">${service}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 14px; border-top: 1px solid rgba(0,0,0,0.1); padding-top: 12px;">
                <span style="color: #6b5f52;">📍 Lokacija:</span>
                <strong style="color: #1a1410;">${salon.address}</strong>
              </div>
            </div>
            
            <div style="background: #dcfce7; border-left: 4px solid #4ade80; padding: 15px; border-radius: 4px; margin-bottom: 25px; font-size: 13px; color: #16a34a;">
              <strong>💡 Savjet:</strong> Pojavite se 5 minuta ranije. Ako trebate otkazati, slobodno nas pozovite na ${salon.phone}.
            </div>
            
            <div style="border-top: 1px solid #e5e7eb; padding-top: 20px;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                Ako trebate pomoć ili trebate otkazati, slobodno nas kontaktirajte:<br>
                📞 <strong>${salon.phone}</strong><br>
                📧 <strong>${salon.notification_email}</strong>
              </p>
            </div>
          </div>
          
          <div style="text-align: center; padding: 15px; font-size: 11px; color: #aaa;">
            <p style="margin: 0;">Powered by FrizerBot.si</p>
          </div>
        </div>
      `
    };

    await sgMail.send(msg);
    console.log('✅ Potvrda email poslana klijentu:', customerEmail);
  } catch (err) {
    console.error('❌ Error sending confirmation email:', err);
  }
}

async function sendNotificationToSalon(salon, customerName, customerEmail, customerPhone, date, service, time) {
  try {
    const dateLj = new Date(date + 'T00:00:00');
    const dateFormatted = dateLj.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    
    const msg = {
      to: salon.notification_email,
      from: process.env.SENDGRID_FROM_EMAIL || 'noreply@frizerbot.si',
      subject: `🔔 Nova Rezervacija - ${salon.name} (${dateFormatted} ${time})`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #2d2520;">
          <div style="background: #1a1410; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: #c9a84c; margin: 0; font-size: 24px;">🔔 Nova Rezervacija</h1>
          </div>
          
          <div style="background: #fff; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <p style="margin: 0 0 20px 0; font-size: 16px;">Imate novu rezervaciju u <strong>${salon.name}</strong>!</p>
            
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
                <span style="color: #6b5f52;">📧 Email:</span>
                <strong style="color: #1a1410;"><a href="mailto:${customerEmail}" style="color: #1a1410; text-decoration: none;">${customerEmail}</a></strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">📅 Datum:</span>
                <strong style="color: #1a1410;">${dateFormatted}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b5f52;">🕐 Vrijeme:</span>
                <strong style="color: #1a1410;">${time}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 14px; border-top: 1px solid rgba(0,0,0,0.1); padding-top: 12px;">
                <span style="color: #6b5f52;">💇 Usluga:</span>
                <strong style="color: #1a1410;">${service}</strong>
              </div>
            </div>
            
            <div style="text-align: center;">
              <a href="${process.env.API_URL || 'https://frizerbot-backend-production.up.railway.app'}/admin/${salon.id}" style="background: #1a1410; color: #c9a84c; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600; font-size: 14px;">
                Otvori Admin Panel
              </a>
            </div>
          </div>
          
          <div style="text-align: center; padding: 15px; font-size: 11px; color: #aaa;">
            <p style="margin: 0;">Powered by FrizerBot.si</p>
          </div>
        </div>
      `
    };

    await sgMail.send(msg);
    console.log('✅ Notifikacija email poslana salonu:', salon.notification_email);
  } catch (err) {
    console.error('❌ Error sending notification email to salon:', err);
  }
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
    await pool.query('DELETE FROM timeslots WHERE salon_id = $1 AND date = $2 AND time = $3', [req.params.id, date, time]);
  }
  res.json({ success: true });
});

// ─── BOOKING ENDPOINT ─────────────────────────────────────────────────────────
app.post('/booking', async (req, res) => {
  const { salonId, date, time, customerName, customerEmail, customerPhone, service } = req.body;
  if (!salonId || !date || !time || !customerName || !service) {
    return res.status(400).json({ error: 'Manjkajo podatki' });
  }
  const { rows: existing } = await pool.query(
    "SELECT * FROM timeslots WHERE salon_id = $1 AND date = $2 AND time = $3 AND status = 'busy'",
    [salonId, date, time]
  );
  if (existing.length > 0) {
    return res.status(409).json({ error: 'Ta termin je že zaseden.' });
  }

  const { rows: salonRows } = await pool.query('SELECT * FROM salons WHERE id = $1', [salonId]);
  const salon = salonRows[0];

  await pool.query(`
    INSERT INTO timeslots (salon_id, date, time, status, customer_name, customer_email, customer_phone, service)
    VALUES ($1, $2, $3, 'busy', $4, $5, $6, $7)
    ON CONFLICT (salon_id, date, time) DO UPDATE
    SET status = 'busy', customer_name = $4, customer_email = $5, customer_phone = $6, service = $7
  `, [salonId, date, time, customerName, customerEmail || '', customerPhone || '', service]);

  // Pošalji email-e
  if (customerEmail) {
    await sendConfirmationEmail(customerEmail, customerName, salon, date, time, service);
  }
  if (salon.notification_email) {
    await sendNotificationToSalon(salon, customerName, customerEmail || '', customerPhone || '', date, service, time);
  }

  console.log('Nova rezervacija:', { salonId, date, time, customerName, customerEmail, customerPhone, service });
  res.json({ success: true });
});

// ─── CHAT ─────────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { salonId, messages, customerInfo } = req.body;
  const { rows } = await pool.query('SELECT * FROM salons WHERE id = $1 AND active = true', [salonId]);
  const salon = rows[0];
  if (!salon) return res.status(404).json({ error: 'Salon not found' });

  const todayLj = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Ljubljana' }));
  const nextWeek = new Date(todayLj.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { rows: busySlots } = await pool.query(
    "SELECT date, time FROM timeslots WHERE salon_id = $1 AND date >= $2 AND date <= $3 AND status = 'busy' ORDER BY date, time",
    [salonId, todayLj.toISOString().split('T')[0], nextWeek.toISOString().split('T')[0]]
  );

  try {
    console.log('📤 Slanje Anthropic API - customerInfo:', customerInfo);
    
    const data = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: buildSystemPrompt(salon, busySlots, customerInfo),
      messages: messages
    });

    const raw = data.content[0].text;
    console.log('✅ Bot raw response:', raw);

    // ── FIX 1: NAJPREJ obdelajmo DELETE ──
    console.log('🔍 DELETE regex test:', raw.match(/\[\[DELETE:([^\]]+)\]\]/));
    const deleteMatch = raw.match(/\[\[DELETE:([^\]]+)\]\]/);
    if (deleteMatch) {
      try {
        const dateTimeStr = deleteMatch[1].trim();
        console.log('📝 Parsed DELETE dateTime:', dateTimeStr);
        // Format je: 2026-04-20T15:00 ali 2026-04-20T08:00
        const [date, time] = dateTimeStr.split('T');
        
        console.log('📅 Parsed date:', date, '⏰ time:', time);
        
        if (date && time) {
          console.log('✅ Brišem termin:', date, time);
          
          const result = await pool.query(
            'DELETE FROM timeslots WHERE salon_id = $1 AND date = $2 AND time = $3',
            [salonId, date, time]
          );
          console.log('✅ Termin obrisan - deleted rows:', result.rowCount);
        } else {
          console.error('❌ Date ali time missing - date:', date, 'time:', time);
        }
      } catch (e) {
        console.error('❌ DELETE error:', e.message);
      }
    } else {
      console.log('ℹ️ Ni DELETE taga u odgovoru');
    }
    // ── FIX 2: Bolj robustni regex – ujame tudi če je presledek ali newline v JSON-u ──
    const bookingMatch = raw.match(/\[\[BOOKING:\s*(\{[\s\S]*?\})\s*\]\]/);
    if (bookingMatch) {
      let booking;
      try {
        booking = JSON.parse(bookingMatch[1]);
        console.log('✅ Parsed booking:', booking);
      } catch (e) {
        console.error('❌ Booking JSON parse error:', e, '\nRaw match:', bookingMatch[1]);
        const reply = raw.replace(/\[\[DELETE:[^\]]*\]\]/g, '').replace(/\[\[BOOKING:[\s\S]*?\]\]/g, '').trim();
        return res.json({
          reply: reply + '\n\nOprostite, prišlo je do tehnične napake pri rezervaciji. Pokličite nas na ' + salon.phone,
          bookingDetected: null
        });
      }

      // Preveri termin
      const { rows: existing } = await pool.query(
        "SELECT * FROM timeslots WHERE salon_id = $1 AND date = $2 AND time = $3 AND status = 'busy'",
        [salonId, booking.date, booking.time]
      );
      if (existing.length > 0) {
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
      `, [salonId, booking.date, booking.time, finalName, finalEmail, finalPhone, finalService]);

      // Pošalji email-e
      if (finalEmail) {
        await sendConfirmationEmail(finalEmail, finalName, salon, booking.date, booking.time, finalService);
      }
      if (salon.notification_email) {
        await sendNotificationToSalon(salon, finalName, finalEmail, finalPhone, booking.date, finalService, booking.time);
      }

      console.log('✅ Bot rezervirao:', { date: booking.date, time: booking.time, name: finalName, email: finalEmail, phone: finalPhone, service: finalService });

      const reply = raw.replace(/\[\[DELETE:[^\]]*\]\]/g, '').replace(/\[\[BOOKING:[\s\S]*?\]\]/g, '').trim();
      return res.json({
        reply,
        bookingDetected: {
          date: booking.date,
          time: booking.time,
          customerName: finalName,
          service: finalService,
          email: finalEmail,
          phone: finalPhone
        }
      });
    }

    // Zaznaj NEED_INFO tag
    const needInfo = raw.includes('[[NEED_INFO]]');
    const cleanReply = raw.replace('[[NEED_INFO]]', '').replace(/\[\[DELETE:[^\]]*\]\]/g, '').trim();
    res.json({ reply: cleanReply, needInfo, bookingDetected: null });

  } catch (err) {
    console.error('❌ Chat API error:');
    console.error('   Status:', err.status);
    console.error('   Message:', err.message);
    console.error('   Error:', JSON.stringify(err, null, 2));
    
    let errorMsg = err.message || 'Unknown error';
    res.status(500).json({ error: 'API error: ' + errorMsg });
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
function buildSystemPrompt(salon, busySlots, customerInfo) {
  const todayLj = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Ljubljana' }));
  const todayStr = todayLj.toLocaleDateString('sl-SI', {
    timeZone: 'Europe/Ljubljana', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  const busyByDate = {};
  busySlots.forEach(s => {
    const d = typeof s.date === 'string' 
  ? s.date.split('T')[0] 
  : s.date.toISOString().split('T')[0];
    if (!busyByDate[d]) busyByDate[d] = new Set();
    busyByDate[d].add(s.time);
  });

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Ljubljana' }));
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const dayName = d.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'numeric' });
    const busy = busyByDate[dateStr] || new Set();
    const free = HOURS.filter(h => !busy.has(h));
    if (free.length > 0) {
      days.push(dateStr + ' (' + dayName + '): ' + free.join(', '));
    }
  }

  const slotsText = days.length > 0 ? days.join('\n') : 'Vsi termini so prosti.';

  if (customerInfo) {
    const safeName = (customerInfo.name || '').replace(/"/g, '').replace(/\\/g, '');

return `Si AI asistent za frizerski salon ${salon.name}. Odgovarjas VEDNO in SAMO v slovenscini.
NIKOLI ne uporabi markdown formatiranja - pisi navadno besedilo.
Si prijazen, profesionalen in jedrnat.

Danasnji datum: ${todayStr}
DATUM ZA TAGE: ${todayLj.toISOString().split('T')[0]}

INFORMACIJE O SALONU:
- Ime: ${salon.name}
- Naslov: ${salon.address}
- Telefon: ${salon.phone}
- Delovni cas: ${salon.hours}

STORITVE IN CENIK:
${salon.services}

PROSTI TERMINI (oblika YYYY-MM-DD):
${slotsText}

PODATKI STRANKE (ze vpisani - NE sprašuj znova):
- Ime: ${safeName}
- Email: ${customerInfo.email}
- Telefon: ${customerInfo.phone}

REZERVACIJE - PRAVILA:
- Stranka JE ze vpisala podatke
- Ko stranka izbere termin in storitev, TAKOJ potrdi rezervacijo brez dodatnih vprašanj

BRISANJE TERMINA:
- Ako stranka želi IZBRISATI termin, VEDNO dodaj [[DELETE:YYYY-MM-DDTHH:MM]] tag na KONEC odgovora
- Primer samo brisanje: "Termin ob 18:00 sem ti izbrisal.[[DELETE:2026-04-20T18:00]]"
- KRITIČNO: Brez tega taga se brisanje NE zgodi - vedno ga dodaj!

BRISANJE IN PRESELITEV (DELETE + nova rezervacija):
- Dodaj NAJPREJ [[DELETE:...]] nato [[BOOKING:{...}]]
- Primer: "Prestavil sem tvoj termin.[[DELETE:2026-04-20T16:00]][[BOOKING:{...}]]"

NOVA REZERVACIJA:
- Na KONEC odgovora dodaj:
[[BOOKING:{"date":"YYYY-MM-DD","time":"HH:MM","customerName":"${safeName}","service":"ime storitve"}]]
- Zamenjaj YYYY-MM-DD z dejanskim datumom, HH:MM s terminom, ime storitve z izbrano storitvijo
- Primer: [[BOOKING:{"date":"2025-06-15","time":"10:00","customerName":"${safeName}","service":"Zenski haircut"}]]
- Tagovi morajo biti na koncu sporocila, brez nicesar za njim

POTEK:
1. Stranka pove kaj hoce → predlagaj proste termine
2. Stranka izbere termin → takoj dodaj [[BOOKING:...]] tag
3. AKO ZAHTEVA BRISANJE: dodaj [[DELETE:...]] tag PRED [[BOOKING:...]] tagom
4. V sporocilu potrdi rezervacijo

KRITIČNO:
- Nikoli si ne izmisljuj prostih terminov - uporabi samo termine iz seznama
- NE POSTAVLJAJ VPRASANJ po brisanju - TAKOJ naredi novo rezervacijo ce je stranka ca prej sporocila kateri termin ji ugaja
- Ako stranka samo zeli izbrisati brez nove rezervacije, naredi SAMO DELETE
- Ce ne ves, preusmeri na telefon: ${salon.phone}`;

  } else {
return `Si AI asistent za frizerski salon ${salon.name}. Odgovarjas VEDNO in SAMO v slovenscini.
NIKOLI ne uporabi markdown formatiranja - pisi navadno besedilo.
Si prijazen, profesionalen in jedrnat.

Danasnji datum: ${todayStr}
DATUM ZA TAGE: ${todayLj.toISOString().split('T')[0]}

INFORMACIJE O SALONU:
- Ime: ${salon.name}
- Naslov: ${salon.address}
- Telefon: ${salon.phone}
- Delovni cas: ${salon.hours}

STORITVE IN CENIK:
${salon.services}

PROSTI TERMINI (oblika YYYY-MM-DD):
${slotsText}

STRANKA NI VPISALA PODATKOV.

REZERVACIJE - PRAVILA:
- Ko stranka hoce rezervirati termin, dodaj [[NEED_INFO]] na KONEC odgovora
- Primer: "Odlicno! Pred rezervacijo potrebujem se vase podatke.[[NEED_INFO]]"
- [[NEED_INFO]] mora biti ZADNJA stvar v odgovoru, brez nicesar za njim

POTEK:
1. Stranka pove kaj hoce → predlagaj proste termine
2. Stranka izbere termin → dodaj [[NEED_INFO]]
3. Ko dobiš podatke stranke → potrdi rezervacijo z [[BOOKING:...]] tagom

PRAVILA:
- Nikoli si ne izmisljuj prostih terminov
- Ce ne ves, preusmeri na telefon: ${salon.phone}`;
  }
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
      <span>🕐 ${salon.hours}</span>
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
    <div class="powered">Poganja FrizerBot.si</div>
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
      if (booking) {
        extra = '<div class="booking-confirm">✅ Rezervacija potrjena: ' + booking.service + ', ' + booking.date + ' ob ' + booking.time + '</div>';
      }
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
          <input type="email" id="cf-email" placeholder="Email naslov" />
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
      if (!name || !email || !phone) {
        alert('Prosimo izpolnite vsa polja.');
        return;
      }
      customerInfo = { name, email, phone };
      document.getElementById('contact-form-msg')?.remove();
      document.getElementById('customer-bar').style.display = 'block';
      document.getElementById('customer-bar-text').textContent = '👤 ' + name + ' · ' + phone;

      // ── FIX 5: Prikaži potrditev obrazca, BREZ dodajanja v messages history ──
      // Namesto tega dodamo sistem sporočilo ki botu pove da nadaljuje z rezervacijo
      addUserMsg('✓ ' + name + ' | ' + email + ' | ' + phone);
      messages.push({
        role: 'user',
        content: 'Moji podatki so: Ime: ' + name + ', Email: ' + email + ', Telefon: ' + phone + '. Prosim nadaljuj z rezervacijo termina ki sva se ga dogovorila.'
      });
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
          messages.push({ role: 'assistant', content: data.reply });
          showContactForm();
        } else if (data.bookingDetected) {
          addBotMsg(data.reply, data.bookingDetected);
          messages.push({ role: 'assistant', content: data.reply });
          // Obvesti bota da je rezervacija potrjena
          messages.push({ role: 'user', content: '[SISTEM: Rezervacija uspešno shranjena.]' });
          messages.push({ role: 'assistant', content: 'Rezervacija je potrjena.' });
        } else {
          addBotMsg(data.reply);
          messages.push({ role: 'assistant', content: data.reply });
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
    .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .slot { background: #fff; border-radius: 10px; padding: 12px; text-align: center; cursor: pointer; border: 2px solid #4ade80; transition: all 0.15s; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .slot.busy { border-color: #f87171; background: #fff5f5; }
    .slot.bot-booking { border-color: #60a5fa; background: #eff6ff; }
    .slot .time { font-size: 18px; font-weight: 600; color: #1a1410; }
    .slot .status { font-size: 11px; margin-top: 4px; color: #16a34a; }
    .slot.busy .status { color: #dc2626; }
    .slot.bot-booking .status { color: #2563eb; }
    .slot .customer { font-size: 11px; color: #6b5f52; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .legend { display: flex; gap: 16px; margin-bottom: 16px; font-size: 12px; color: #6b5f52; flex-wrap: wrap; }
    .legend span { display: flex; align-items: center; gap: 6px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.free { background: #4ade80; }
    .dot.busy { background: #f87171; }
    .dot.bot { background: #60a5fa; }
    .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center; }
    .modal.open { display: flex; }
    .modal-box { background: #fff; border-radius: 16px; padding: 24px; width: 320px; }
    .modal-box h3 { margin-bottom: 16px; color: #1a1410; }
    .modal-box label { display: block; font-size: 12px; color: #6b5f52; margin-bottom: 4px; margin-top: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    .modal-box input { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
    .modal-info { background: #f9fafb; border-radius: 8px; padding: 10px 12px; font-size: 12px; color: #6b5f52; margin-top: 8px; line-height: 1.6; }
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
      <p>Klikni termin za urejanje · Modri = rezerviral bot</p>
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
      <span><div class="dot free"></div> Prost</span>
      <span><div class="dot busy"></div> Zaseden (ročno)</span>
      <span><div class="dot bot"></div> Rezerviral bot</span>
    </div>
    <div class="slots" id="slots"></div>
  </div>
  <div class="modal" id="modal">
    <div class="modal-box">
      <h3 id="modal-title">Termin</h3>
      <div id="modal-info-section"></div>
      <label>Ime stranke</label>
      <input type="text" id="modal-customer" placeholder="Ime Priimek" />
      <label>Storitev</label>
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
        const isBot = isBusy && slot.customer_email;
        const div = document.createElement('div');
        div.className = 'slot' + (isBusy ? (isBot ? ' bot-booking' : ' busy') : '');
        div.innerHTML = '<div class="time">' + hour + '</div>' +
          '<div class="status">' + (isBusy ? (isBot ? 'Bot rezervacija' : 'Zaseden') : 'Prost') + '</div>' +
          (slot && slot.customer_name ? '<div class="customer">' + slot.customer_name + '</div>' : '') +
          (slot && slot.service ? '<div class="customer">' + slot.service + '</div>' : '');
        div.addEventListener('click', () => openModal(hour, slot));
        container.appendChild(div);
      });
    }

    function openModal(time, slot) {
      currentSlot = time;
      document.getElementById('modal-title').textContent = 'Termin ob ' + time;
      document.getElementById('modal-customer').value = slot ? (slot.customer_name || '') : '';
      document.getElementById('modal-service').value = slot ? (slot.service || '') : '';
      const infoSection = document.getElementById('modal-info-section');
      if (slot && slot.customer_email) {
        infoSection.innerHTML = '<div class="modal-info">' +
          '📧 ' + (slot.customer_email || '-') + '<br>' +
          '📞 ' + (slot.customer_phone || '-') +
          '</div>';
      } else {
        infoSection.innerHTML = '';
      }
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

    document.getElementById('modal-cancel').addEventListener('click', () => document.getElementById('modal').classList.remove('open'));
    document.getElementById('modal-set-busy').addEventListener('click', () => saveSlot('busy'));
    document.getElementById('modal-set-free').addEventListener('click', () => saveSlot('free'));
    document.getElementById('prev').addEventListener('click', () => { currentDate.setDate(currentDate.getDate() - 1); loadSlots(); });
    document.getElementById('next').addEventListener('click', () => { currentDate.setDate(currentDate.getDate() + 1); loadSlots(); });

    loadSlots();
    setInterval(loadSlots, 30000);
  </script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log('FrizerBot backend running on port ' + PORT);
});