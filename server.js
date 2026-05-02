if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const sgMail = require('@sendgrid/mail');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
app.use(cors());

// ─── STRIPE WEBHOOK (mora biti PRED express.json!) ────────────────────────────
app.post('/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      if (process.env.STRIPE_WEBHOOK_SECRET && sig) {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
      } else {
        event = JSON.parse(req.body);
      }
    } catch (err) {
      console.error('❌ Webhook signature error:', err.message);
      return res.status(400).send('Webhook Error: ' + err.message);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerEmail = session.customer_details?.email || session.customer_email || '';
      const customerName = session.customer_details?.name || '';
      const amount = Math.round(session.amount_total) / 100;

      let plan = 'pro';
      if (amount <= 29.99) plan = 'starter';
      else if (amount <= 49.99) plan = 'pro';
      else plan = 'agency';

      console.log(`✅ Novo plačilo: ${customerEmail} — ${plan} — ${amount}€`);

      const salonId = 'salon_' + Date.now();
      const slug = (customerEmail.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase() || 'salon') + '_' + Date.now();

      try {
        await pool.query(`
          INSERT INTO salons (id, name, address, phone, hours, services, notification_email, schedule, plan, billing_period_start, stripe_customer_id, stripe_session_id, slug)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE,$10,$11,$12)
        `, [
          salonId,
          customerName ? customerName + ' — Salon' : 'Moj Salon',
          'Naslov še ni nastavljen',
          '',
          '',
          '- Dodajte storitve v admin panelu',
          customerEmail,
          JSON.stringify(DEFAULT_SCHEDULE),
          plan,
          session.customer || '',
          session.id,
          slug
        ]);

        await pool.query(`
          INSERT INTO subscriptions (salon_id, stripe_session_id, stripe_customer_id, plan, amount, customer_email, customer_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [salonId, session.id, session.customer || '', plan, amount, customerEmail, customerName]);

        const salonUrl = `${process.env.API_URL || 'https://bookwell.si'}/salon/${slug}`;
        const adminUrl = `${process.env.API_URL || 'https://bookwell.si'}/admin/${slug}`;
        const planNames = { starter: 'Starter', pro: 'Pro', agency: 'Agency' };
        const chatLimits = { starter: '1.000', pro: '3.000', agency: '10.000' };

        await sgMail.send({
          to: customerEmail,
          from: process.env.SENDGRID_FROM_EMAIL || 'info@bookwell.si',
          subject: `🎉 Dobrodošli v BookWell — Vaš AI asistent je pripravljen`,
          html: `
            <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <div style="background:#0a0a0a;padding:28px;text-align:center;">
                <h1 style="color:#c9984a;margin:0;font-size:28px;font-family:Georgia,serif;">BookWell</h1>
                <p style="color:rgba(255,255,255,.35);margin:8px 0 0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;">Plan: ${planNames[plan]} · ${chatLimits[plan]} sporočil/mes</p>
              </div>
              <div style="background:#fff;padding:36px;border:1px solid #e0e0e0;border-top:none;">
                <p style="font-size:16px;margin:0 0 12px;">Pozdravljeni${customerName ? ' ' + customerName : ''}!</p>
                <p style="color:#666;font-size:14px;line-height:1.7;margin:0 0 28px;">Vaše plačilo je uspešno. AI asistent za vaš salon je pripravljen za delo.</p>
                <div style="background:#f7f7f5;border-left:3px solid #c9984a;padding:18px 20px;margin-bottom:28px;">
                  <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0a0a0a;">Naslednji koraki:</p>
                  <p style="margin:0 0 8px;font-size:13px;color:#444;">1. Odprite admin panel in nastavite ime, naslov in telefon salona</p>
                  <p style="margin:0 0 8px;font-size:13px;color:#444;">2. Dodajte storitve s cenami in delovni čas</p>
                  <p style="margin:0;font-size:13px;color:#444;">3. Delite chat link na Instagram, Facebook ali spletni strani</p>
                </div>
                <a href="${adminUrl}" style="display:block;background:#0a0a0a;color:#c9984a;padding:15px 24px;text-decoration:none;font-weight:700;font-size:13px;text-align:center;letter-spacing:.08em;margin-bottom:10px;">→ Odpri Admin Panel</a>
                <a href="${salonUrl}" style="display:block;background:#f7f7f5;color:#0a0a0a;padding:14px 24px;text-decoration:none;font-size:13px;text-align:center;border:1px solid #e0e0e0;">→ Vaš Chat Link (za stranke)</a>
                <p style="margin:28px 0 0;font-size:11px;color:#aaa;line-height:1.6;">
                  Vprašanja? Pišite na <a href="mailto:info@bookwell.si" style="color:#c9984a;">info@bookwell.si</a>
                </p>
              </div>
              <div style="text-align:center;padding:16px;font-size:11px;color:#bbb;">BookWell.si · AI Recepcionist za salone</div>
            </div>
          `
        });
        console.log('✅ Welcome email poslan:', customerEmail);
      } catch (err) {
        console.error('❌ Webhook DB/email napaka:', err.message);
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const customerEmail = invoice.customer_email;
      
      if (customerEmail) {
        await pool.query(`
          UPDATE salons 
          SET billing_period_start = CURRENT_DATE, chat_count = 0
          WHERE notification_email = $1
        `, [customerEmail]);
        
        console.log(`✅ Obnovitev plačila: ${customerEmail}`);
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const customerEmail = invoice.customer_email;
      
      if (customerEmail) {  // ← preveri da email obstaja
        await pool.query(`
          UPDATE salons SET plan = 'suspended' WHERE notification_email = $1
        `, [customerEmail]);
        
        try {
          await sgMail.send({
            to: customerEmail,
            from: process.env.SENDGRID_FROM_EMAIL || 'info@bookwell.si',  // ← manjkalo!
            subject: 'BookWell — Plačilo ni uspelo',
            html: `...`
          });
        } catch(e) {
          console.error('❌ Payment failed email napaka:', e.message);
        }
      }
    }

    res.json({ received: true });
  }
);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'bookwell-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ─── PLAN CONFIG ──────────────────────────────────────────────────────────────
const PLANS = {
  trial:   { name: 'Trial',   price: 0,     chatLimit: 20 },
  starter: { name: 'Starter', price: 29.99, chatLimit: 1000 },
  pro:     { name: 'Pro',     price: 49.99, chatLimit: 3000 },
  agency:  { name: 'Agency',  price: 99.99, chatLimit: 10000 }
};

// Zamenjaj z resničnimi Stripe Payment Linki ko jih kreiraš v dashboardu
const STRIPE_LINKS = {
  starter: process.env.STRIPE_LINK_STARTER || 'https://buy.stripe.com/ZAMENJAJ_STARTER',
  pro:     process.env.STRIPE_LINK_PRO     || 'https://buy.stripe.com/ZAMENJAJ_PRO',
  agency:  process.env.STRIPE_LINK_AGENCY  || 'https://buy.stripe.com/ZAMENJAJ_AGENCY'
};

const DEFAULT_SCHEDULE = {
  mon: { open: true,  from: '08:00', to: '20:00' },
  tue: { open: true,  from: '08:00', to: '20:00' },
  wed: { open: true,  from: '08:00', to: '20:00' },
  thu: { open: true,  from: '08:00', to: '20:00' },
  fri: { open: true,  from: '08:00', to: '20:00' },
  sat: { open: true,  from: '08:00', to: '14:00' },
  sun: { open: false, from: '08:00', to: '16:00' }
};

function getHoursForDate(schedule, dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dayMap = ['sun','mon','tue','wed','thu','fri','sat'];
  const dayKey = dayMap[d.getDay()];
  const daySchedule = (schedule && schedule[dayKey]) || DEFAULT_SCHEDULE[dayKey];
  if (!daySchedule || !daySchedule.open) return [];
  return generateHalfHourSlots(daySchedule.from, daySchedule.to);
}

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

function scheduleToText(schedule) {
  const s = schedule || DEFAULT_SCHEDULE;
  const dayNames = { mon: 'Ponedeljek', tue: 'Torek', wed: 'Sreda', thu: 'Četrtek', fri: 'Petek', sat: 'Sobota', sun: 'Nedelja' };
  return Object.entries(dayNames).map(([key, name]) => {
    const d = s[key] || DEFAULT_SCHEDULE[key];
    if (!d || !d.open) return name + ': zaprto';
    return name + ': ' + d.from + ' - ' + d.to;
  }).join('\n');
}
function convertToCSV(data) {
  const rows = [];
  
  // Header
  if (data.salon) {
    rows.push('TIP,POLJE,VREDNOST');
    rows.push(`SALON,ID,${data.salon.id}`);
    rows.push(`SALON,IME,${data.salon.name}`);
    rows.push(`SALON,NASLOV,${data.salon.address}`);
    rows.push(`SALON,TELEFON,${data.salon.phone}`);
    rows.push(`SALON,USTVARJENO,${data.salon.created_at}`);
  }
  
  // Timeslots
  if (data.timeslots && data.timeslots.length) {
    rows.push('\nTERMINI');
    rows.push('DATUM,ČAS,STRANKA,E-POŠTA,STORITEV');
    data.timeslots.forEach(ts => {
      rows.push(`${ts.date},${ts.time},"${ts.customer_name}",${ts.customer_email},"${ts.service}"`);
    });
  }
  
  return rows.join('\n');
}
 
async function sendBreachNotificationToAuthority(breachData) {
  // V praksi: Pošlji na IP-RS obrazec
  console.log('📧 Obvestilo URADY o kršitvi:', breachData);
  
  // Lahko tudi pošlješ e-mail
  try {
    await sgMail.send({
      to: 'gp.ip@ip-rs.si', // URADY email
      from: process.env.SENDGRID_FROM_EMAIL || 'info@bookwell.si',
      subject: `[GDPR BREACH NOTIFICATION] ${breachData.type} - BookWell.si`,
      html: `
        <h2>GDPR Breach Notification</h2>
        <p><strong>Vrsta kršitve:</strong> ${breachData.type}</p>
        <p><strong>Opis:</strong> ${breachData.description}</p>
        <p><strong>Število prizadetih oseb:</strong> ${breachData.affectedCount}</p>
        <p><strong>Vrste podatkov:</strong> ${breachData.affectedTypes}</p>
        <p><strong>Čas odkritja:</strong> ${new Date().toISOString()}</p>
        <p>Polna dokumentacija je dostopna na info@bookwell.si</p>
      `,
    });
    console.log('✅ Obvestilo URADY je bilo poslano');
  } catch (err) {
    console.error('❌ Napaka pri pošiljanju obvestila URADY:', err);
  }
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
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS schedule JSONB DEFAULT NULL`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'salon'`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS admin_username TEXT`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS admin_password TEXT`);
  // Stripe / plan stolpci
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'pro'`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS chat_count INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS billing_period_start DATE DEFAULT CURRENT_DATE`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS stripe_session_id TEXT`);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      salon_id TEXT REFERENCES salons(id),
      stripe_session_id TEXT,
      stripe_customer_id TEXT,
      plan TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      amount INTEGER,
      customer_email TEXT,
      customer_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE timeslots ADD COLUMN IF NOT EXISTS cancel_token TEXT UNIQUE`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS breach_log (
      id SERIAL PRIMARY KEY,
      breach_type TEXT NOT NULL,
      description TEXT,
      affected_users INTEGER,
      affected_data_types TEXT,
      discovered_at TIMESTAMP,
      reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'pending_authority_report',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gdpr_tokens (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      action TEXT NOT NULL, -- 'access', 'deletion', 'portability'
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query('SELECT id FROM salons WHERE id = $1', ['salon_1']);
  if (rows.length === 0) {
    await pool.query(`
      INSERT INTO salons (id, name, address, phone, hours, services, notification_email, schedule, plan)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      'salon_1', 'Salon Aurora', 'Copova 5, Ljubljana', '01 234 5678',
      'Pon-Pet: 8:00-20:00, Sob: 8:00-14:00, Ned: zaprto',
      '- Ženski haircut: 25-45 EUR\n- Moški haircut: 15-20 EUR\n- Barvanje (celo): 60-120 EUR\n- Balayage/highlights: 80-150 EUR\n- Trajni kodri: 70-100 EUR\n- Frizura za posebne priložnosti: 40-65 EUR\n- Manikura: 20-30 EUR\n- Pedikura: 25-35 EUR',
      'salon@aurora.si',
      JSON.stringify(DEFAULT_SCHEDULE),
      'agency'
    ]);
  }
  console.log('DB inicializiran');
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
async function requireAdminAuth(req, res, next) {
  const salonId = req.params.id;
  const { rows } = await pool.query('SELECT id FROM salons WHERE (id = $1 OR slug = $1)', [salonId]);
  const salon = rows[0];
  if (!salon) return res.status(404).send('<h1>Salon not found</h1>');
  if (req.session.adminSalonId === salon.id) return next();
  res.redirect(`/admin-login/${salonId}`);
}

// ─── EMAIL FUNKCIJE ───────────────────────────────────────────────────────────
async function sendConfirmationEmail(customerEmail, customerName, salon, date, time, service, cancelToken) {
  try {
    const dateLj = new Date(date + 'T00:00:00');
    const dateFormatted = dateLj.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const cancelUrl = cancelToken
      ? `${process.env.API_URL || 'https://bookwell.si'}/cancel/${cancelToken}`
      : null;

    await sgMail.send({
      to: customerEmail,
      from: process.env.SENDGRID_FROM_EMAIL || 'info@bookwell.si',
      subject: `✅ Rezervacija potrjena - ${salon.name}`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#2d2520;">
          <div style="background:#1a1410;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
            <h1 style="color:#c9a84c;margin:0;font-size:24px;">✅ Rezervacija Potrjena</h1>
          </div>
          <div style="background:#fff;padding:30px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
            <p style="margin:0 0 20px;font-size:16px;">Pozdravljeni <strong>${customerName}</strong>,</p>
            <div style="background:#f5f0eb;padding:20px;border-radius:8px;margin-bottom:25px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;"><span style="color:#6b5f52;">📅 Datum:</span><strong>${dateFormatted}</strong></div>
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;"><span style="color:#6b5f52;">🕐 Ura:</span><strong>${time}</strong></div>
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;"><span style="color:#6b5f52;">💇 Storitev:</span><strong>${service}</strong></div>
              <div style="display:flex;justify-content:space-between;font-size:14px;border-top:1px solid rgba(0,0,0,0.1);padding-top:12px;"><span style="color:#6b5f52;">📍 Naslov:</span><strong>${salon.address}</strong></div>
            </div>
            <div style="background:#dcfce7;border-left:4px solid #4ade80;padding:15px;border-radius:4px;font-size:13px;color:#16a34a;margin-bottom:${cancelUrl ? '20px' : '0'};">
              <strong>💡 Nasvet:</strong> Prosimo, pridite 5 minut prej. Če morate odpovedati, nas pokličite na ${salon.phone}.
            </div>
            ${cancelUrl ? `
            <div style="text-align:center;padding-top:4px;">
              <a href="${cancelUrl}" style="display:inline-block;background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;padding:11px 24px;text-decoration:none;font-size:13px;font-weight:600;border-radius:6px;">
                ✕ Odpovej rezervacijo
              </a>
              <p style="margin:8px 0 0;font-size:11px;color:#aaa;">Gumb deluje samo enkrat in samo za to rezervacijo.</p>
            </div>` : ''}
          </div>
          <div style="text-align:center;padding:15px;font-size:11px;color:#aaa;"><p style="margin:0;">Poganja BookWell.si</p></div>
        </div>
      `
    });
    console.log('✅ Potrditveni e-mail poslan stranki:', customerEmail);
  } catch (err) {
    console.error('❌ Napaka pri pošiljanju e-maila stranki:', err);
  }
}

async function sendNotificationToSalon(salon, customerName, customerEmail, customerPhone, date, service, time) {
  try {
    const dateLj = new Date(date + 'T00:00:00');
    const dateFormatted = dateLj.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    await sgMail.send({
      to: salon.notification_email,
      from: process.env.SENDGRID_FROM_EMAIL || 'info@bookwell.si',
      subject: `🔔 Nova Rezervacija - ${salon.name} (${dateFormatted} ${time})`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#2d2520;">
          <div style="background:#1a1410;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
            <h1 style="color:#c9a84c;margin:0;font-size:24px;">🔔 Nova Rezervacija</h1>
          </div>
          <div style="background:#fff;padding:30px;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
            <p style="margin:0 0 20px;font-size:16px;">Nova rezervacija v salonu <strong>${salon.name}</strong>!</p>
            <div style="background:#f5f0eb;padding:20px;border-radius:8px;margin-bottom:25px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;"><span style="color:#6b5f52;">👤 Ime:</span><strong>${customerName}</strong></div>
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;"><span style="color:#6b5f52;">📞 Telefon:</span><strong><a href="tel:${customerPhone}" style="color:#1a1410;text-decoration:none;">${customerPhone}</a></strong></div>
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;"><span style="color:#6b5f52;">📧 E-pošta:</span><strong>${customerEmail}</strong></div>
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;"><span style="color:#6b5f52;">📅 Datum:</span><strong>${dateFormatted}</strong></div>
              <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px;"><span style="color:#6b5f52;">🕐 Ura:</span><strong>${time}</strong></div>
              <div style="display:flex;justify-content:space-between;font-size:14px;border-top:1px solid rgba(0,0,0,0.1);padding-top:12px;"><span style="color:#6b5f52;">💇 Storitev:</span><strong>${service}</strong></div>
            </div>
            <div style="text-align:center;">
              <a href="${process.env.API_URL || 'https://bookwell.si'}/admin/${salon.id}" style="background:#1a1410;color:#c9a84c;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;font-size:14px;">Odpri Admin Panel</a>
            </div>
          </div>
          <div style="text-align:center;padding:15px;font-size:11px;color:#aaa;"><p style="margin:0;">Poganja BookWell.si</p></div>
        </div>
      `
    });
    console.log('✅ Obvestilo e-mail poslano salonu:', salon.notification_email);
  } catch (err) {
    console.error('❌ Napaka pri pošiljanju obvestila salonu:', err);
  }
}

// ─── PRICING ENDPOINT ─────────────────────────────────────────────────────────
app.get('/pricing', (req, res) => {
  res.json({
    plans: [
      { id: 'starter', ...PLANS.starter, stripeLink: STRIPE_LINKS.starter },
      { id: 'pro',     ...PLANS.pro,     stripeLink: STRIPE_LINKS.pro },
      { id: 'agency',  ...PLANS.agency,  stripeLink: STRIPE_LINKS.agency }
    ]
  });
});

// ─── SALON SETTINGS ───────────────────────────────────────────────────────────
app.get('/admin/:id/settings', requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  res.json(rows[0]);
});

app.post('/admin/:id/settings', requireAdminAuth, async (req, res) => {
  const { name, address, phone, services, notificationEmail } = req.body;
  const { rows: salonRows } = await pool.query('SELECT id FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salonId = salonRows[0]?.id;
  await pool.query(
    'UPDATE salons SET name=$1, address=$2, phone=$3, services=$4, notification_email=$5 WHERE id=$6',
    [name, address, phone, services, notificationEmail, salonId]
  );
  res.json({ success: true });
});

app.post('/admin/:id/change-password', requireAdminAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).json({ error: 'Not found' });
  const valid = await bcrypt.compare(currentPassword, salon.admin_password);
  if (!valid) return res.status(401).json({ error: 'Trenutno geslo je napačno' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Novo geslo mora biti vsaj 6 znakov' });
  const hashed = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE salons SET admin_password = $1 WHERE id = $2', [hashed, salon.id]);
  res.json({ success: true });
});

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

// ─── LOGIN / LOGOUT ───────────────────────────────────────────────────────────
app.get('/admin-login/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).send('<h1>Salon not found</h1>');
  if (!salon.admin_password) return res.send(buildSetupPage(salon));
  res.send(buildLoginPage(salon));
});

// Obstoječi chatLimiter ostane
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { reply: 'Preveč zahtevkov. Počakajte minuto.', bookingDetected: null }
});

// NOVO — mesečni IP limiter
const monthlyIpLimiter = rateLimit({
  windowMs: 30 * 24 * 60 * 60 * 1000, // 30 dni
  max: 1000,
  keyGenerator: (req) => req.ip,
  message: { reply: 'Mesečna omejitev demo chata je dosežena.', bookingDetected: null },
  skip: (req) => {
    // Preskoči limiter za prave salone (ne za salon_1 demo)
    const { salonId } = req.body || {};
    return salonId && salonId !== 'salon_1';
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Preveč neuspešnih poskusov. Počakajte 15 minut.' },
  standardHeaders: true,
  legacyHeaders: false
});

const gdprLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Preveč zahtevkov. Poskusite čez uro.' }
});

// ─── TRIAL ENDPOINT ───────────────────────────────────────────────────────────
const trialLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24h
  max: 3,
  keyGenerator: (req) => req.ip,
  message: { error: 'Preveč trial zahtevkov. Poskusite jutri.' }
});

app.post('/trial', trialLimiter, async (req, res) => {
  const { email, salonName } = req.body;
  
  if (!email || !salonName) {
    return res.status(400).json({ error: 'Vpišite email in ime salona.' });
  }
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Neveljaven e-poštni naslov.' });
  }

  // Preveri obstoječi račun
  const { rows: existing } = await pool.query(
    'SELECT id, plan FROM salons WHERE notification_email = $1', [email]
  );
  if (existing.length > 0) {
    const p = existing[0].plan;
    if (p === 'trial') return res.status(409).json({ error: 'Ta email že ima aktiven preizkus. Preverite e-pošto.' });
    return res.status(409).json({ error: 'Ta email je že registriran. Prijavite se v admin panel.' });
  }

  const salonId = 'trial_' + Date.now();
  const slug = email.split('@')[0].replace(/[^a-z0-9]/gi,'').toLowerCase() + '_' + Date.now();

  try {
    await pool.query(`
      INSERT INTO salons (id, name, address, phone, services, notification_email, schedule, plan, slug, billing_period_start)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'trial',$8,CURRENT_DATE)
    `, [
      salonId,
      salonName,
      'Naslov še ni nastavljen',
      '',
      '- Dodajte storitve v admin panelu',
      email,
      JSON.stringify(DEFAULT_SCHEDULE),
      slug
    ]);

    const chatUrl = `${process.env.API_URL || 'https://bookwell.si'}/salon/${slug}`;
    const adminUrl = `${process.env.API_URL || 'https://bookwell.si'}/admin/${slug}`;

    await sgMail.send({
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL || 'info@bookwell.si',
      subject: '🎉 Vaš brezplačni preizkus BookWell je pripravljen',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <div style="background:#0a0a0a;padding:28px;text-align:center;">
            <h1 style="color:#c9984a;margin:0;font-size:28px;font-family:Georgia,serif;">BookWell</h1>
            <p style="color:rgba(255,255,255,.35);margin:8px 0 0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;">Brezplačni preizkus · 20 sporočil</p>
          </div>
          <div style="background:#fff;padding:36px;border:1px solid #e0e0e0;border-top:none;">
            <p style="font-size:16px;margin:0 0 12px;">Pozdravljeni!</p>
            <p style="color:#666;font-size:14px;line-height:1.7;margin:0 0 28px;">
              Vaš AI asistent za salon <strong>${salonName}</strong> je pripravljen. Na voljo imate <strong>20 brezplačnih sporočil</strong>.
            </p>
            <div style="background:#f7f7f5;border-left:3px solid #c9984a;padding:18px 20px;margin-bottom:28px;">
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0a0a0a;">Naslednji koraki:</p>
              <p style="margin:0 0 8px;font-size:13px;color:#444;">1. Odprite admin panel in nastavite storitve ter delovni čas</p>
              <p style="margin:0 0 8px;font-size:13px;color:#444;">2. Preizkusite chat kot bi ga videla vaša stranka</p>
              <p style="margin:0;font-size:13px;color:#444;">3. Če vam je všeč — nadgradite za 29.99€/mes</p>
            </div>
            <a href="${adminUrl}" style="display:block;background:#0a0a0a;color:#c9984a;padding:15px 24px;text-decoration:none;font-weight:700;font-size:13px;text-align:center;letter-spacing:.08em;margin-bottom:10px;">→ Odpri Admin Panel</a>
            <a href="${chatUrl}" style="display:block;background:#f7f7f5;color:#0a0a0a;padding:14px 24px;text-decoration:none;font-size:13px;text-align:center;border:1px solid #e0e0e0;">→ Preizkusi Chat (kot stranka)</a>
            <p style="margin:28px 0 0;font-size:11px;color:#aaa;line-height:1.6;">
              Vprašanja? Pišite na <a href="mailto:info@bookwell.si" style="color:#c9984a;">info@bookwell.si</a> ali nas kontaktirajte na WhatsApp.
            </p>
          </div>
          <div style="text-align:center;padding:16px;font-size:11px;color:#bbb;">BookWell.si · AI Recepcionist za salone</div>
        </div>
      `
    });

    console.log(`✅ Trial ustvarjen: ${email} — ${salonId}`);
    res.json({ success: true, chatUrl, adminUrl });

  } catch (err) {
    console.error('❌ Trial napaka:', err.message);
    res.status(500).json({ error: 'Napaka pri ustvarjanju preizkusa.' });
  }
});

app.post('/admin-login/:id', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).json({ error: 'Not found' });
  if (!salon.admin_password) return res.status(400).json({ error: 'Račun še ni nastavljen' });
  const validUser = username === salon.admin_username;
  const validPass = await bcrypt.compare(password, salon.admin_password);
  if (!validUser || !validPass) return res.status(401).json({ error: 'Napačno uporabniško ime ali geslo' });
  req.session.adminSalonId = salon.id;
  res.json({ success: true, redirect: `/admin/${req.params.id}` });
});

app.post('/admin-setup/:id', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).json({ error: 'Not found' });
  if (salon.admin_password) return res.status(400).json({ error: 'Račun je že nastavljen' });
  if (!username || !password || password.length < 6) return res.status(400).json({ error: 'Geslo mora biti vsaj 6 znakov' });
  const hashed = await bcrypt.hash(password, 10);
  await pool.query('UPDATE salons SET admin_username = $1, admin_password = $2 WHERE id = $3', [username, hashed, salon.id]);
  req.session.adminSalonId = salon.id;
  res.json({ success: true, redirect: `/admin/${req.params.id}` });
});

app.get('/admin-logout/:id', (req, res) => {
  req.session.destroy();
  res.redirect(`/admin-login/${req.params.id}`);
});

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
app.get('/admin/:id', requireAdminAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salon = rows[0];
  if (!salon) return res.status(404).send('<h1>Salon not found</h1>');
  res.send(buildAdminPage(salon));
});

app.get('/admin/:id/timeslots', requireAdminAuth, async (req, res) => {
  const { date } = req.query;
  const { rows: salonRows } = await pool.query('SELECT id FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salonId = salonRows[0]?.id || req.params.id;
  const { rows } = await pool.query('SELECT * FROM timeslots WHERE salon_id = $1 AND date = $2 ORDER BY time', [salonId, date]);
  res.json(rows);
});

app.post('/admin/:id/timeslots', requireAdminAuth, async (req, res) => {
  const { date, time, status, customerName, customerEmail, service } = req.body;
  const { rows: salonRows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salon = salonRows[0];
  if (!salon) return res.status(404).json({ error: 'Not found' });
  const salonId = salon.id;

  if (status === 'busy') {
    const cleanEmail = (customerEmail || '').trim();
    await pool.query(`
      INSERT INTO timeslots (salon_id, date, time, status, customer_name, customer_email, service)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (salon_id, date, time) DO UPDATE
      SET status = $4, customer_name = $5, customer_email = $6, service = $7
    `, [salonId, date, time, status, customerName, cleanEmail, service]);

    if (cleanEmail) {
      const cancelToken = crypto.randomBytes(20).toString('hex');
      await pool.query('UPDATE timeslots SET cancel_token = $1 WHERE salon_id = $2 AND date = $3 AND time = $4', [cancelToken, salonId, date, time]);
      await sendConfirmationEmail(cleanEmail, customerName || 'Stranka', salon, date, time, service || '', cancelToken);
    }
  } else {
    await pool.query('DELETE FROM timeslots WHERE salon_id = $1 AND date = $2 AND time = $3', [salonId, date, time]);
  }
  res.json({ success: true });
});

// ─── SCHEDULE ─────────────────────────────────────────────────────────────────
app.get('/admin/:id/schedule', requireAdminAuth, async (req, res) => {
  const { rows: salonRows } = await pool.query('SELECT id FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salonId = salonRows[0]?.id || req.params.id;
  const { rows } = await pool.query('SELECT schedule FROM salons WHERE id = $1', [salonId]);
  res.json(rows[0]?.schedule || DEFAULT_SCHEDULE);
});

app.post('/admin/:id/schedule', requireAdminAuth, async (req, res) => {
  const { rows: salonRows } = await pool.query('SELECT id FROM salons WHERE (id = $1 OR slug = $1)', [req.params.id]);
  const salonId = salonRows[0]?.id || req.params.id;
  await pool.query('UPDATE salons SET schedule = $1 WHERE id = $2', [JSON.stringify(req.body), salonId]);
  res.json({ success: true });
});

// ─── BOOKING ENDPOINT ─────────────────────────────────────────────────────────
app.post('/booking', async (req, res) => {
  const { salonId, date, time, customerName, customerEmail, customerPhone, service } = req.body;
  if (!salonId || !date || !time || !customerName || !service) return res.status(400).json({ error: 'Manjkajo podatki' });
  const { rows: salonRows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1)', [salonId]);
  const salon = salonRows[0];
  if (!salon) return res.status(404).json({ error: 'Salon not found' });
  const { rows: existing } = await pool.query(
    "SELECT * FROM timeslots WHERE salon_id=$1 AND date=$2 AND time=$3 AND status='busy'",
    [salon.id, date, time]
  );
  if (existing.length > 0) return res.status(409).json({ error: 'Ta termin je že zaseden.' });
  await pool.query(`
    INSERT INTO timeslots (salon_id, date, time, status, customer_name, customer_email, customer_phone, service)
    VALUES ($1,$2,$3,'busy',$4,$5,$6,$7)
    ON CONFLICT (salon_id, date, time) DO UPDATE
    SET status='busy', customer_name=$4, customer_email=$5, customer_phone=$6, service=$7
  `, [salon.id, date, time, customerName, customerEmail || '', customerPhone || '', service]);
  if (customerEmail) {
    const cancelToken = crypto.randomBytes(20).toString('hex');
    await pool.query('UPDATE timeslots SET cancel_token = $1 WHERE salon_id = $2 AND date = $3 AND time = $4', [cancelToken, salon.id, date, time]);
    await sendConfirmationEmail(customerEmail, customerName, salon, date, time, service, cancelToken);
  }
  if (salon.notification_email) await sendNotificationToSalon(salon, customerName, customerEmail || '', customerPhone || '', date, service, time);
  res.json({ success: true });
});



// ─── CHAT ─────────────────────────────────────────────────────────────────────

app.post('/chat', monthlyIpLimiter, chatLimiter, async (req, res) => {
  const { salonId, messages, customerInfo } = req.body;
  const filteredMessages = (messages || []).filter(m => m && m.content && m.content.trim() !== '');

  const { rows } = await pool.query('SELECT * FROM salons WHERE (id = $1 OR slug = $1) AND active = true', [salonId]);
  const salon = rows[0];
  if (!salon) return res.status(404).json({ error: 'Salon not found' });

  const actualSalonId = salon.id;

  // ─── PLAN LIMIT CHECK ────────────────────────────────────────────────────────
  const plan = PLANS[salon.plan] || PLANS.pro;

  if (salon.plan === 'suspended') {
    return res.status(402).json({
      reply: 'Salon trenutno nima aktivne naročnine.',
      bookingDetected: null
    });
  }

  if (salon.billing_period_start) {
    const billingStart = new Date(salon.billing_period_start);
    const now = new Date();
    const monthsPassed = (now.getFullYear() - billingStart.getFullYear()) * 12
      + (now.getMonth() - billingStart.getMonth());
    if (monthsPassed >= 1) {
      await pool.query('UPDATE salons SET chat_count = 0, billing_period_start = CURRENT_DATE WHERE id = $1', [actualSalonId]);
      salon.chat_count = 0;
    }
  }

  if ((salon.chat_count || 0) >= plan.chatLimit) {
    const isT = salon.plan === 'trial';
    return res.status(429).json({
      reply: isT
        ? 'Vaš brezplačni preizkus je končan (20 sporočil). Vam je všeč? Nadaljujte na bookwell.si'
        : 'Salon je dosegel mesečni limit sporočil. Kontaktirajte lastnika salona.',
      bookingDetected: null,
      trialEnded: isT
    });
  }

  await pool.query('UPDATE salons SET chat_count = chat_count + 1 WHERE id = $1', [actualSalonId]);

  const usage = (salon.chat_count || 0) + 1;
  const limit = plan.chatLimit;

  if (usage === Math.floor(limit * 0.8)) {
    await sgMail.send({
      to: salon.notification_email,
      from: process.env.SENDGRID_FROM_EMAIL || 'info@bookwell.si',
      subject: 'BookWell — 80% mesečnih sporočil porabljenih',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
          <div style="background:#0a0a0a;padding:24px;text-align:center;">
            <h1 style="color:#c9984a;margin:0;font-size:22px;">BookWell</h1>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #e0e0e0;border-top:none;">
            <p style="font-size:15px;margin:0 0 16px;">⚠️ Porabili ste <strong>${usage}/${limit}</strong> sporočil ta mesec.</p>
            <p style="font-size:13px;color:#666;line-height:1.6;">Pri ${limit} sporočilih bo chat začasno onemogočen do naslednjega obračunskega obdobja.</p>
            <p style="font-size:13px;color:#666;margin-top:12px;">Razmislite o nadgradnji paketa na <a href="https://bookwell.si/#pricing" style="color:#c9984a;">bookwell.si</a>.</p>
          </div>
        </div>
      `
    }).catch(e => console.error('❌ 80% email napaka:', e.message));
  }
  // ─────────────────────────────────────────────────────────────────────────
  const todayLj = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Ljubljana' }));
  const nextWeek = new Date(todayLj.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { rows: busySlots } = await pool.query(
    "SELECT date, time FROM timeslots WHERE salon_id=$1 AND date>=$2 AND date<=$3 AND status='busy' ORDER BY date, time",
    [actualSalonId, todayLj.toISOString().split('T')[0], nextWeek.toISOString().split('T')[0]]
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
          const result = await pool.query('DELETE FROM timeslots WHERE salon_id=$1 AND date=$2 AND time=$3', [actualSalonId, date, time]);
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
        "SELECT * FROM timeslots WHERE salon_id=$1 AND date=$2 AND time=$3 AND status='busy'",
        [actualSalonId, booking.date, booking.time]
      );

      const cInfo = customerInfo || {};
      const finalName = booking.customerName || cInfo.name || 'Neznano';
      const finalEmail = cInfo.email || booking.customerEmail || '';
      const finalPhone = cInfo.phone || booking.customerPhone || '';
      const finalService = booking.service || 'Storitev';

      if (existing.length > 0) {
        if (existing[0].customer_email === finalEmail) {
          await pool.query('UPDATE timeslots SET service=$1 WHERE salon_id=$2 AND date=$3 AND time=$4', [finalService, actualSalonId, booking.date, booking.time]);
          const reply = raw.replace(/\[\[DELETE:[^\]]*\]\]/g, '').replace(/\[\[BOOKING:[\s\S]*?\]\]/g, '').trim();
          return res.json({ reply, bookingDetected: { date: booking.date, time: booking.time, customerName: finalName, service: finalService, email: finalEmail, phone: finalPhone } });
        }
        return res.json({ reply: 'Oprostite, ta termin je bil ravnokar zaseden. Izberite drug termin.', bookingDetected: null });
      }

      await pool.query(`
        INSERT INTO timeslots (salon_id, date, time, status, customer_name, customer_email, customer_phone, service)
        VALUES ($1,$2,$3,'busy',$4,$5,$6,$7)
        ON CONFLICT (salon_id, date, time) DO UPDATE
        SET status='busy', customer_name=$4, customer_email=$5, customer_phone=$6, service=$7
      `, [actualSalonId, booking.date, booking.time, finalName, finalEmail, finalPhone, finalService]);

      if (finalEmail) {
        const cancelToken = crypto.randomBytes(20).toString('hex');
        await pool.query('UPDATE timeslots SET cancel_token = $1 WHERE salon_id = $2 AND date = $3 AND time = $4', [cancelToken, actualSalonId, booking.date, booking.time]);
        await sendConfirmationEmail(finalEmail, finalName, salon, booking.date, booking.time, finalService, cancelToken);
      }
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
    'INSERT INTO salons (id,name,address,phone,hours,services,notification_email,schedule,type,plan) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, name, address, phone, hours, services, notificationEmail, JSON.stringify(DEFAULT_SCHEDULE), type || 'salon', 'pro']
  );
  res.json({ success: true, salonId: id });
});

app.put('/salons/:id', async (req, res) => {
  const { name, address, phone, hours, services, notificationEmail, active } = req.body;
  await pool.query(
    'UPDATE salons SET name=$1,address=$2,phone=$3,hours=$4,services=$5,notification_email=$6,active=$7 WHERE id=$8',
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
    if (allHours.length === 0) continue;
    const busy = busyByDate[dateStr] || new Set();
    let free = allHours.filter(h => !busy.has(h));
    if (dateStr === todayDateStr) {
      free = free.filter(h => {
        const [hh, mm] = h.split(':').map(Number);
        if (hh > currentHour) return true;
        if (hh === currentHour && mm > currentMinute) return true;
        return false;
      });
    }
    if (free.length > 0) days.push(dateStr + ' (' + dayName + '): ' + free.join(', '));
  }

  const slotsText = days.length > 0 ? days.join('\n') : 'Trenutno ni prostih terminov v naslednjih 7 dneh.';

  if (customerInfo) {
    const safeName = (customerInfo.name || '').replace(/"/g, '').replace(/\\/g, '');
    return `Si AI asistent za frizerski salon ${salon.name}. Odgovarjaš VEDNO in SAMO v slovenščini.
NIKOLI ne uporabi markdown formatiranja - piši navadno besedilo.
Si prijazen, profesionalen in jedrnat.
Piši brezhibno in slovnično pravilno slovensko. ABSOLUTNO PREPOVEDANO je pisanje v kateremkoli drugem jeziku — niti ene besede hrvaško, angleško ali v kateremkoli drugem jeziku.

PREPOVEDANE FRAZE (nikoli ne uporabi):
- "do viđenja" → VEDNO "nasvidenje"
- "svidenja" / "viđenja" → "nasvidenje"
- "razumijem" → "razumem"
- "potvrjena" → "potrjena"
- "hvala na" → "hvala za"
- "naravno" (kot seveda) → "seveda" ali "gotovo"

DOVOLJENI POZDRAVI: "Nasvidenje!", "Lep pozdrav!", "Se vidimo!", "Hvala in nasvidenje!"

ČE STRANKA POŠLJE SAMO "ok", "v redu" ali podobno brez vsebine:
- 1. krat: kratko povzemi kaj lahko narediš
- 2. krat: povabi naj se oglasite ko bodo pripravljeni
- 3. krat in naprej: odgovori samo z "👍" ali sploh ne odgovarjaj z novo vsebino

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
Piši brezhibno in slovnično pravilno slovensko. ABSOLUTNO PREPOVEDANO je pisanje v kateremkoli drugem jeziku — niti ene besede hrvaško, angleško ali v kateremkoli drugem jeziku.

PREPOVEDANE FRAZE (nikoli ne uporabi):
- "do viđenja" → VEDNO "nasvidenje"
- "svidenja" / "viđenja" → "nasvidenje"
- "razumijem" → "razumem"
- "potvrjena" → "potrjena"
- "hvala na" → "hvala za"
- "naravno" (kot seveda) → "seveda" ali "gotovo"

DOVOLJENI POZDRAVI: "Nasvidenje!", "Lep pozdrav!", "Se vidimo!", "Hvala in nasvidenje!"

ČE STRANKA POŠLJE SAMO "ok", "v redu" ali podobno brez vsebine:
- 1. krat: kratko povzemi kaj lahko narediš
- 2. krat: povabi naj se oglasite ko bodo pripravljeni
- 3. krat in naprej: odgovori samo z "👍" ali sploh ne odgovarjaj z novo vsebino
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

function buildLoginPage(salon) {
  return `<!DOCTYPE html>
<html lang="sl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prijava · ${salon.name}</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: system-ui, sans-serif; background: #f7f7f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border: 1px solid #e0e0e0; width: 100%; max-width: 380px; overflow: hidden; }
    .card-head { background: #0a0a0a; padding: 32px 36px; }
    .card-head h1 { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 4px; }
    .card-head p { font-size: 12px; color: rgba(255,255,255,0.4); letter-spacing: 0.08em; text-transform: uppercase; }
    .card-body { padding: 32px 36px; }
    .field { margin-bottom: 20px; }
    .field label { display: block; font-size: 10px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #888; margin-bottom: 6px; }
    .field input { width: 100%; padding: 10px 14px; border: 1px solid #e0e0e0; font-size: 14px; font-family: inherit; background: #f7f7f5; outline: none; transition: border 0.15s; }
    .field input:focus { border-color: #0a0a0a; background: #fff; }
    .btn { width: 100%; padding: 12px; background: #c9984a; border: none; color: #fff; font-size: 13px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; font-family: inherit; cursor: pointer; transition: opacity 0.15s; }
    .btn:hover { opacity: 0.85; }
    .err { background: #fee2e2; border-left: 3px solid #ef4444; padding: 10px 14px; font-size: 13px; color: #991b1b; margin-bottom: 18px; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-head">
      <h1>${salon.name}</h1>
      <p>Admin Panel · Prijava</p>
    </div>
    <div class="card-body">
      <div class="err" id="err"></div>
      <div class="field">
        <label>Uporabniško ime</label>
        <input type="text" id="username" autocomplete="username" />
      </div>
      <div class="field">
        <label>Geslo</label>
        <input type="password" id="password" autocomplete="current-password" />
      </div>
      <button class="btn" onclick="doLogin()">Prijava</button>
    </div>
  </div>
  <script>
    document.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    async function doLogin() {
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      const err = document.getElementById('err');
      err.style.display = 'none';
      if (!username || !password) { err.textContent = 'Izpolnite vsa polja.'; err.style.display = 'block'; return; }
      const res = await fetch(window.location.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (data.success) { window.location.href = data.redirect; }
      else { err.textContent = data.error || 'Napaka pri prijavi.'; err.style.display = 'block'; }
    }
  </script>
</body>
</html>`;
}

function buildSetupPage(salon) {
  return `<!DOCTYPE html>
<html lang="sl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nastavitev računa · ${salon.name}</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: system-ui, sans-serif; background: #f7f7f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border: 1px solid #e0e0e0; width: 100%; max-width: 400px; overflow: hidden; }
    .card-head { background: #0a0a0a; padding: 32px 36px; }
    .card-head h1 { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 4px; }
    .card-head p { font-size: 12px; color: rgba(255,255,255,0.4); letter-spacing: 0.08em; text-transform: uppercase; }
    .notice { background: #fef9c3; border-left: 3px solid #ca8a04; padding: 12px 16px; margin: 24px 36px 0; font-size: 13px; color: #713f12; line-height: 1.5; }
    .card-body { padding: 24px 36px 32px; }
    .field { margin-bottom: 18px; }
    .field label { display: block; font-size: 10px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #888; margin-bottom: 6px; }
    .field input { width: 100%; padding: 10px 14px; border: 1px solid #e0e0e0; font-size: 14px; font-family: inherit; background: #f7f7f5; outline: none; transition: border 0.15s; }
    .field input:focus { border-color: #0a0a0a; background: #fff; }
    .btn { width: 100%; padding: 12px; background: #c9984a; border: none; color: #fff; font-size: 13px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; font-family: inherit; cursor: pointer; transition: opacity 0.15s; }
    .btn:hover { opacity: 0.85; }
    .err { background: #fee2e2; border-left: 3px solid #ef4444; padding: 10px 14px; font-size: 13px; color: #991b1b; margin-bottom: 16px; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-head">
      <h1>${salon.name}</h1>
      <p>Prvič: nastavite admin račun</p>
    </div>
    <div class="notice">To storite samo enkrat. Po nastavitvi bo ta stran zahtevala geslo.</div>
    <div class="card-body">
      <div class="err" id="err"></div>
      <div class="field">
        <label>Uporabniško ime</label>
        <input type="text" id="username" autocomplete="username" />
      </div>
      <div class="field">
        <label>Geslo (min. 6 znakov)</label>
        <input type="password" id="password" autocomplete="new-password" />
      </div>
      <div class="field">
        <label>Potrdite geslo</label>
        <input type="password" id="password2" autocomplete="new-password" />
      </div>
      <button class="btn" onclick="doSetup()">Ustvari račun in vstopi</button>
    </div>
  </div>
  <script>
    async function doSetup() {
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      const password2 = document.getElementById('password2').value;
      const err = document.getElementById('err');
      err.style.display = 'none';
      if (!username || !password) { err.textContent = 'Izpolnite vsa polja.'; err.style.display = 'block'; return; }
      if (password !== password2) { err.textContent = 'Gesli se ne ujemata.'; err.style.display = 'block'; return; }
      if (password.length < 6) { err.textContent = 'Geslo mora biti vsaj 6 znakov.'; err.style.display = 'block'; return; }
      const res = await fetch('/admin-setup/${salon.id}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (data.success) { window.location.href = data.redirect; }
      else { err.textContent = data.error || 'Napaka.'; err.style.display = 'block'; }
    }
  </script>
</body>
</html>`;
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
          if (data.reply && data.reply.trim()) messages.push({ role: 'assistant', content: data.reply });
          showContactForm();
        } else if (data.bookingDetected) {
          addBotMsg(data.reply, data.bookingDetected);
          if (data.reply && data.reply.trim()) messages.push({ role: 'assistant', content: data.reply });
          messages.push({ role: 'user', content: '[SISTEM: Rezervacija uspešno shranjena.]' });
          messages.push({ role: 'assistant', content: 'Rezervacija je potrjena.' });
        } else {
          addBotMsg(data.reply);
          if (data.reply && data.reply.trim()) messages.push({ role: 'assistant', content: data.reply });
          if (data.trialEnded) {
            setTimeout(() => {
              const msgs = document.getElementById('messages');
              const div = document.createElement('div');
              div.className = 'msg bot';
              div.innerHTML = \`
                <div style="background:#0a0a0a;border-radius:16px;padding:20px;max-width:280px;">
                  <div style="color:#c9a84c;font-size:13px;font-weight:700;margin-bottom:8px;">Preizkus končan 🎉</div>
                  <div style="color:rgba(255,255,255,.7);font-size:12px;line-height:1.6;margin-bottom:16px;">Všeč vam je? Začnite za samo 29.99€/mes — brez omejitev.</div>
                  <a href="https://bookwell.si/#pricing" style="display:block;background:#c9984a;color:#0a0a0a;padding:10px 16px;text-decoration:none;font-size:12px;font-weight:700;text-align:center;border-radius:8px;">Nadgradite zdaj →</a>
                </div>
                <div class="msg-time">\` + getTime() + \`</div>
              \`;
              msgs.appendChild(div);
              msgs.scrollTop = msgs.scrollHeight;
            }, 500);
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
      --black: #0a0a0a; --white: #ffffff; --off-white: #f7f7f5; --rule: #e0e0e0;
      --muted: #888888; --ink-light: #444444; --gold: #c9984a; --gold-hover: #b8863a;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--off-white); color: var(--black); font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
    .masthead { background: var(--white); border-bottom: 2px solid var(--black); padding: 0 40px; display: flex; align-items: stretch; height: 60px; }
    .masthead-title { font-family: 'Playfair Display', serif; font-size: 20px; font-weight: 700; color: var(--black); display: flex; align-items: center; padding-right: 32px; border-right: 1px solid var(--rule); white-space: nowrap; }
    .masthead-label { display: flex; align-items: center; padding: 0 24px; font-size: 10px; font-weight: 600; letter-spacing: 0.15em; text-transform: uppercase; color: var(--muted); border-right: 1px solid var(--rule); }
    .masthead-spacer { flex: 1; }
    .masthead-link { display: flex; align-items: center; gap: 6px; padding: 0 20px; font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); text-decoration: none; border-left: 1px solid var(--rule); transition: color 0.15s; }
    .masthead-link:hover { color: var(--black); }
    .masthead-link svg { width: 10px; height: 10px; }
    .nav { background: var(--white); border-bottom: 1px solid var(--rule); padding: 0 40px; display: flex; gap: 0; }
    .nav-tab { display: flex; align-items: center; gap: 8px; padding: 14px 24px 12px; font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s; user-select: none; }
    .nav-tab:hover { color: var(--black); }
    .nav-tab.active { color: var(--black); border-bottom-color: var(--gold); }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .page { max-width: 880px; margin: 0 auto; padding: 40px 32px; }
    .date-nav { display: flex; align-items: baseline; gap: 20px; margin-bottom: 8px; }
    .date-heading { font-family: 'Playfair Display', serif; font-size: 32px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; color: var(--black); flex: 1; }
    .date-heading em { font-style: italic; font-weight: 400; color: var(--muted); }
    .nav-arrow { background: none; border: none; cursor: pointer; color: var(--muted); padding: 4px 2px; font-size: 20px; line-height: 1; transition: color 0.12s; font-family: 'Playfair Display', serif; }
    .nav-arrow:hover { color: var(--black); }
    .today-btn { font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); background: none; border: 1px solid var(--rule); padding: 5px 12px; cursor: pointer; transition: all 0.12s; }
    .today-btn:hover { border-color: var(--black); color: var(--black); }
    .section-rule { border: none; border-top: 1px solid var(--rule); margin: 16px 0 28px; }
    .section-rule.thick { border-top: 2px solid var(--black); margin: 0 0 28px; }
    .stats-row { font-size: 12px; font-weight: 500; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 32px; display: flex; align-items: center; gap: 0; flex-wrap: wrap; }
    .stat-item { display: flex; align-items: center; gap: 6px; }
    .stat-item .num { font-family: 'Playfair Display', serif; font-size: 18px; font-weight: 700; color: var(--black); letter-spacing: -0.01em; }
    .stat-item .num.green { color: #2a7a2a; }
    .stat-item .num.red { color: #8a1a1a; }
    .stat-item .num.blue { color: #1a3a7a; }
    .stat-sep { margin: 0 14px; color: var(--rule); font-size: 16px; font-weight: 300; }
    .closed-banner { border: 1px solid var(--rule); background: var(--white); padding: 56px 40px; text-align: center; }
    .closed-title { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 400; font-style: italic; color: var(--muted); margin-bottom: 6px; }
    .closed-sub { font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--rule); font-weight: 600; }
    .slots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); }
    .slot-card { background: var(--white); padding: 16px 18px 14px; cursor: pointer; transition: background 0.1s; position: relative; }
    .slot-card:hover { background: var(--off-white); }
    .slot-card.busy { background: var(--black); }
    .slot-card.busy:hover { background: #1a1a1a; }
    .slot-card.bot { background: var(--black); }
    .slot-card.bot:hover { background: #1a1a1a; }
    .slot-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .slot-time { font-family: 'Playfair Display', serif; font-size: 19px; font-weight: 700; letter-spacing: -0.01em; color: var(--black); line-height: 1; }
    .slot-card.busy .slot-time, .slot-card.bot .slot-time { color: var(--white); }
    .slot-dot { width: 6px; height: 6px; border-radius: 50%; background: #ccc; flex-shrink: 0; }
    .slot-card:not(.busy):not(.bot) .slot-dot { background: #b0b0b0; }
    .slot-card.busy .slot-dot { background: var(--white); }
    .slot-card.bot .slot-dot { background: var(--gold); }
    .slot-name { font-size: 11px; font-weight: 400; color: var(--ink-light); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; }
    .slot-card.busy .slot-name, .slot-card.bot .slot-name { color: rgba(255,255,255,0.55); }
    .slot-label { font-size: 9px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-top: 2px; }
    .slot-card.busy .slot-label { color: rgba(255,255,255,0.3); }
    .slot-card.bot .slot-label { color: var(--gold); }
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 200; align-items: center; justify-content: center; padding: 24px; }
    .modal-overlay.open { display: flex; }
    .modal { background: var(--white); width: 100%; max-width: 360px; box-shadow: 0 32px 80px rgba(0,0,0,0.3); overflow: hidden; }
    .modal-header { background: var(--black); padding: 24px 28px 20px; border-bottom: 1px solid #222; }
    .modal-time-display { font-family: 'Playfair Display', serif; font-size: 36px; font-weight: 700; color: var(--white); letter-spacing: -0.02em; line-height: 1; }
    .modal-date-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.3); margin-top: 6px; }
    .modal-body { padding: 22px 28px; }
    .modal-info-card { background: var(--off-white); border-left: 2px solid var(--gold); padding: 10px 14px; margin-bottom: 18px; font-size: 12px; color: var(--ink-light); line-height: 1.8; display: none; }
    .modal-info-card.visible { display: block; }
    .modal-field-label { font-size: 9px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); margin-bottom: 5px; margin-top: 14px; }
    .modal-field-label:first-child { margin-top: 0; }
    .modal-field-label .optional { font-weight: 400; letter-spacing: 0; text-transform: none; font-size: 9px; color: #bbb; margin-left: 4px; }
    .modal-input { width: 100%; padding: 9px 12px; border: 1px solid var(--rule); background: var(--off-white); font-size: 13px; font-family: system-ui, sans-serif; color: var(--black); outline: none; transition: border-color 0.12s; border-radius: 0; }
    .modal-input:focus { border-color: var(--black); background: var(--white); }
    .modal-email-hint { font-size: 10px; color: var(--muted); margin-top: 4px; }
    .modal-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--rule); }
    .modal-btn { padding: 9px 10px; border: 1px solid var(--rule); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; font-family: system-ui, sans-serif; cursor: pointer; background: var(--white); color: var(--black); transition: all 0.12s; border-radius: 0; }
    .modal-btn:hover { background: var(--off-white); }
    .modal-btn.btn-busy { background: var(--black); color: var(--white); border-color: var(--black); }
    .modal-btn.btn-busy:hover { background: #222; }
    .schedule-card { background: var(--white); border: 1px solid var(--rule); }
    .schedule-head { padding: 22px 28px; border-bottom: 2px solid var(--black); display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    .schedule-head-title { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700; color: var(--black); }
    .schedule-head-sub { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 500; }
    .day-row { display: flex; align-items: center; gap: 20px; padding: 15px 28px; border-bottom: 1px solid var(--rule); transition: background 0.1s; }
    .day-row:last-child { border-bottom: none; }
    .day-row:hover { background: var(--off-white); }
    .day-name { width: 110px; font-size: 13px; font-weight: 500; color: var(--black); flex-shrink: 0; }
    .toggle-wrap { position: relative; width: 36px; height: 18px; flex-shrink: 0; }
    .toggle-wrap input { opacity: 0; width: 0; height: 0; }
    .toggle-slider { position: absolute; inset: 0; background: var(--rule); cursor: pointer; transition: 0.2s; border-radius: 0; }
    .toggle-wrap input:checked + .toggle-slider { background: var(--gold); }
    .toggle-slider::before { content: ''; position: absolute; height: 12px; width: 12px; left: 3px; top: 3px; background: var(--white); transition: 0.2s; }
    .toggle-wrap input:checked + .toggle-slider::before { transform: translateX(18px); }
    .day-times { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }
    .day-times.disabled { opacity: 0.25; pointer-events: none; }
    .day-times input[type=time] { padding: 5px 10px; border: 1px solid var(--rule); font-size: 13px; font-family: system-ui, sans-serif; color: var(--black); background: var(--off-white); outline: none; transition: border-color 0.12s; border-radius: 0; }
    .day-times input[type=time]:focus { border-color: var(--black); background: var(--white); }
    .day-sep { color: var(--rule); font-weight: 300; }
    .schedule-footer { padding: 18px 28px; border-top: 2px solid var(--black); display: flex; align-items: center; justify-content: space-between; }
    .save-btn { background: var(--gold); color: var(--white); border: none; padding: 10px 28px; font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; font-family: system-ui, sans-serif; cursor: pointer; transition: background 0.15s; border-radius: 0; }
    .save-btn:hover { background: var(--gold-hover); }
    .save-msg { display: none; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #2a7a2a; }
    .save-msg.visible { display: flex; align-items: center; gap: 6px; }
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--rule); }
    @media (max-width: 600px) {
      .masthead { padding: 0 20px; } .nav { padding: 0 20px; } .page { padding: 24px 20px; }
      .date-heading { font-size: 24px; } .slots-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
      .day-row { padding: 12px 20px; gap: 12px; } .day-name { width: 90px; }
      .schedule-head, .schedule-footer { padding: 16px 20px; } .modal-body { padding: 18px 22px; }
    }
  </style>
</head>
<body>
  <div class="masthead">
    <div class="masthead-title">${salon.name}</div>
    <div class="masthead-label">Admin Panel</div>
    <div class="masthead-spacer"></div>
    <a href="https://bookwell.si" target="_blank" class="masthead-link">
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 1.5H2a.5.5 0 0 0-.5.5v8c0 .28.22.5.5.5h8a.5.5 0 0 0 .5-.5V7.5M7 1.5h3.5m0 0v3.5m0-3.5L5 7"/></svg>
      BookWell.si
    </a>
    <a href="${salon.plan === 'trial' ? 'https://bookwell.si/#pricing' : '/' + (salon.type || 'salon') + '/' + (salon.slug || salon.id)}" class="masthead-link">
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 1.5H2a.5.5 0 0 0-.5.5v8c0 .28.22.5.5.5h8a.5.5 0 0 0 .5-.5V7.5M7 1.5h3.5m0 0v3.5m0-3.5L5 7"/></svg>
      ${salon.plan === 'trial' ? 'Nadgradi plan →' : 'Javna stran'}
    </a>
  </div>
  <nav class="nav">
    <div class="nav-tab active" onclick="switchTab('termini')">Termini</div>
    <div class="nav-tab" onclick="switchTab('urnik')">Delovni čas</div>
    <div class="nav-tab" onclick="switchTab('nastavitve')">Nastavitve</div>
  </nav>
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
  <div class="tab-content" id="tab-urnik">
    <div class="page">
      <div class="schedule-card">
        <div class="schedule-head">
          <div><div class="schedule-head-title">Delovni čas</div></div>
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
  <div class="tab-content" id="tab-nastavitve">
  <div class="page">
    <div class="schedule-card">
      <div class="schedule-head">
        <div><div class="schedule-head-title">Nastavitve salona</div></div>
        <div class="schedule-head-sub">Podatki & storitve</div>
      </div>
      <div style="padding:28px;">
        <div id="settings-saved" style="display:none;color:#2a7a2a;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:16px;">✓ Shranjeno</div>
        <div style="background:#f7f7f5;border-left:3px solid #c9984a;padding:16px 20px;margin-bottom:24px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#888;margin-bottom:8px;">Poraba sporočil ta mesec</div>
          <div style="font-family:'Playfair Display',serif;font-size:32px;font-weight:700;color:#0a0a0a;" id="s-chat-count">—</div>
          <div style="font-size:11px;color:#aaa;margin-top:4px;" id="s-chat-limit"></div>
        </div>
        <div class="modal-field-label">Ime salona</div>
        <input class="modal-input" type="text" id="s-name" style="margin-bottom:14px;" />
        <div class="modal-field-label">Naslov</div>
        <input class="modal-input" type="text" id="s-address" style="margin-bottom:14px;" />
        <div class="modal-field-label">Telefon</div>
        <input class="modal-input" type="text" id="s-phone" style="margin-bottom:14px;" />
        <div class="modal-field-label">E-pošta za obvestila</div>
        <input class="modal-input" type="email" id="s-email" style="margin-bottom:14px;" />
        <div class="modal-field-label">Storitve in cenik</div>
        <textarea class="modal-input" id="s-services" rows="10" style="resize:vertical;font-family:system-ui,sans-serif;line-height:1.6;margin-bottom:14px;"></textarea>
        <div style="font-size:11px;color:#aaa;margin-bottom:20px;">Vsaka storitev v svoji vrstici, npr: - Ženski haircut: 25-45 EUR</div>
      </div>
      <div class="schedule-footer">
        <div></div>
        <button class="save-btn" onclick="saveSettings()">Shrani nastavitve</button>
      </div>
      <div style="padding:0 28px 28px;">
        <div style="border-top:1px solid #e0e0e0;padding-top:24px;margin-top:8px;">
          <div style="font-family:'Playfair Display',serif;font-size:16px;font-weight:700;margin-bottom:16px;">Sprememba gesla</div>
          <div id="pw-err" style="display:none;background:#fee2e2;border-left:3px solid #ef4444;padding:10px 14px;font-size:12px;color:#991b1b;margin-bottom:12px;"></div>
          <div id="pw-ok" style="display:none;background:#dcfce7;border-left:3px solid #4ade80;padding:10px 14px;font-size:12px;color:#16a34a;margin-bottom:12px;">✓ Geslo uspešno spremenjeno</div>
          <div class="modal-field-label">Trenutno geslo</div>
          <input class="modal-input" type="password" id="pw-current" style="margin-bottom:10px;" />
          <div class="modal-field-label">Novo geslo (min. 6 znakov)</div>
          <input class="modal-input" type="password" id="pw-new" style="margin-bottom:10px;" />
          <div class="modal-field-label">Potrdi novo geslo</div>
          <input class="modal-input" type="password" id="pw-new2" style="margin-bottom:16px;" />
          <button class="save-btn" onclick="changePassword()">Spremeni geslo</button>
        </div>
      </div>
    </div>
  </div>
</div>
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
        <div class="modal-field-label">E-pošta stranke <span class="optional">(neobvezno — za potrditveni e-mail)</span></div>
        <input class="modal-input" type="email" id="modal-email" placeholder="stranka@email.com" />
        <div class="modal-email-hint" id="modal-email-hint"></div>
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

    async function changePassword() {
      const current = document.getElementById('pw-current').value;
      const newPw = document.getElementById('pw-new').value;
      const newPw2 = document.getElementById('pw-new2').value;
      const err = document.getElementById('pw-err');
      const ok = document.getElementById('pw-ok');
      err.style.display = 'none'; ok.style.display = 'none';
      if (!current || !newPw || !newPw2) { err.textContent = 'Izpolnite vsa polja.'; err.style.display = 'block'; return; }
      if (newPw !== newPw2) { err.textContent = 'Novi gesli se ne ujemata.'; err.style.display = 'block'; return; }
      if (newPw.length < 6) { err.textContent = 'Geslo mora biti vsaj 6 znakov.'; err.style.display = 'block'; return; }
      const res = await fetch(API_URL + '/admin/' + SALON_ID + '/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: newPw })
      });
      const data = await res.json();
      if (data.success) {
        ok.style.display = 'block';
        document.getElementById('pw-current').value = '';
        document.getElementById('pw-new').value = '';
        document.getElementById('pw-new2').value = '';
      } else {
        err.textContent = data.error || 'Napaka.';
        err.style.display = 'block';
      }
    }
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

    function getDayKey(d) { return ['sun','mon','tue','wed','thu','fri','sat'][d.getDay()]; }

    function switchTab(name) {
      document.querySelectorAll('.nav-tab').forEach((t, i) => t.classList.toggle('active', ['termini','urnik','nastavitve'][i] === name));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-' + name).classList.add('active');
    }

    function formatDate(d) { return d.toISOString().split('T')[0]; }
    function formatDateSl(d) { return d.toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
    function isToday(d) { return d.toDateString() === new Date().toDateString(); }
    // Naloži nastavitve
    async function loadSettings() {
      const res = await fetch(API_URL + '/admin/' + SALON_ID + '/settings');
      const data = await res.json();
      document.getElementById('s-name').value = data.name || '';
      document.getElementById('s-address').value = data.address || '';
      document.getElementById('s-phone').value = data.phone || '';
      document.getElementById('s-email').value = data.notification_email || '';
      document.getElementById('s-services').value = data.services || '';
      const planLimits = { starter: 1000, pro: 3000, agency: '10000' };
      const limit = planLimits[data.plan] || 3000;
      document.getElementById('s-chat-count').textContent = (data.chat_count || 0) + ' sporočil';
      document.getElementById('s-chat-limit').textContent = 'Plan: ' + (data.plan || 'pro') + ' · Limit: ' + limit;
    }

    async function saveSettings() {
      const res = await fetch(API_URL + '/admin/' + SALON_ID + '/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('s-name').value.trim(),
          address: document.getElementById('s-address').value.trim(),
          phone: document.getElementById('s-phone').value.trim(),
          notificationEmail: document.getElementById('s-email').value.trim(),
          services: document.getElementById('s-services').value.trim()
        })
      });
      const data = await res.json();
      if (data.success) {
        const msg = document.getElementById('settings-saved');
        msg.style.display = 'block';
        setTimeout(() => msg.style.display = 'none', 2500);
      }
    }

    loadSettings();
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
        container.innerHTML = \`<div class="closed-banner"><div class="closed-title">Salon je zaprt</div><div class="closed-sub">Ta dan ni delovnega časa</div></div>\`;
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
        const nameHtml = slot && slot.customer_name ? \`<div class="slot-name">\${slot.customer_name}</div>\` : \`<div class="slot-name">&nbsp;</div>\`;
        card.innerHTML = \`<div class="slot-top"><div class="slot-time">\${hour}</div><div class="slot-dot"></div></div>\${nameHtml}<div class="slot-label">\${statusLabel}</div>\`;
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
      document.getElementById('modal-email').value = slot?.customer_email || '';
      document.getElementById('modal-email-hint').textContent = '';
      const infoCard = document.getElementById('modal-info-card');
      if (slot && slot.customer_email) {
        infoCard.className = 'modal-info-card visible';
        infoCard.innerHTML = \`<div>✉ \${slot.customer_email}</div><div>☏ \${slot.customer_phone || '–'}</div>\`;
      } else {
        infoCard.className = 'modal-info-card';
        infoCard.innerHTML = '';
      }
      document.getElementById('modal-overlay').classList.add('open');
    }

    async function saveSlot(status) {
      const customerName = document.getElementById('modal-customer').value.trim();
      const service = document.getElementById('modal-service').value.trim();
      const customerEmail = document.getElementById('modal-email').value.trim();
      if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
        document.getElementById('modal-email-hint').textContent = '⚠ Vpišite veljaven e-poštni naslov.';
        document.getElementById('modal-email-hint').style.color = '#c0392b';
        return;
      }
      const res = await fetch(API_URL + '/admin/' + SALON_ID + '/timeslots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: formatDate(currentDate), time: currentSlot, status, customerName, customerEmail, service })
      });
      const data = await res.json();
      document.getElementById('modal-overlay').classList.remove('open');
      if (status === 'busy' && customerEmail && data.success) {
        setTimeout(() => {
          const hint = document.createElement('div');
          hint.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#0a0a0a;color:#fff;padding:12px 20px;font-size:12px;z-index:999;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
          hint.textContent = '✅ Potrditveni e-mail poslan na ' + customerEmail;
          document.body.appendChild(hint);
          setTimeout(() => hint.remove(), 3500);
        }, 200);
      }
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
          <label class="toggle-wrap"><input type="checkbox" id="open-\${key}" \${d.open ? 'checked' : ''} onchange="toggleDay('\${key}')"><span class="toggle-slider"></span></label>
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

    document.getElementById('modal-cancel').addEventListener('click', () => document.getElementById('modal-overlay').classList.remove('open'));
    document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === document.getElementById('modal-overlay')) document.getElementById('modal-overlay').classList.remove('open'); });
    document.getElementById('modal-set-busy').addEventListener('click', () => saveSlot('busy'));
    document.getElementById('modal-set-free').addEventListener('click', () => saveSlot('free'));
    document.getElementById('prev').addEventListener('click', () => { currentDate.setDate(currentDate.getDate() - 1); loadSlots(); });
    document.getElementById('next').addEventListener('click', () => { currentDate.setDate(currentDate.getDate() + 1); loadSlots(); });
    document.getElementById('today').addEventListener('click', () => { currentDate = new Date(); loadSlots(); });

    loadSlots();
    buildScheduleUI();
    setInterval(loadSlots, 30000);
  </script>
</body>
</html>`;
}

// ─── CANCEL ENDPOINT ──────────────────────────────────────────────────────────
app.get('/cancel/:token', async (req, res) => {
  const { token } = req.params;
  const { rows } = await pool.query(
    "SELECT t.*, s.name as salon_name, s.phone as salon_phone, s.notification_email FROM timeslots t JOIN salons s ON t.salon_id = s.id WHERE t.cancel_token = $1 AND t.status = 'busy' AND t.date >= CURRENT_DATE",
    [token]
  );
  if (!rows[0]) {
    return res.send(`<!DOCTYPE html><html lang="sl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odpoved termina</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f7f7f5;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#fff;border:1px solid #e0e0e0;max-width:400px;width:100%;overflow:hidden}.head{background:#0a0a0a;padding:28px 32px}.head h1{font-size:20px;color:#fff;font-weight:700}.body{padding:32px}.icon{font-size:40px;margin-bottom:16px}.msg{font-size:14px;color:#666;line-height:1.6}</style></head><body><div class="card"><div class="head"><h1>BookWell</h1></div><div class="body"><div class="icon">⚠️</div><p class="msg">Ta rezervacija ne obstaja, je že odpovedana ali je termin že minil.</p></div></div></body></html>`);
  }

  const slot = rows[0];
  const dateFormatted = new Date(slot.date).toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  res.send(`<!DOCTYPE html>
<html lang="sl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Odpoved rezervacije</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,sans-serif;background:#f7f7f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
    .card{background:#fff;border:1px solid #e0e0e0;max-width:420px;width:100%;overflow:hidden}
    .head{background:#0a0a0a;padding:28px 32px}
    .head h1{font-size:20px;color:#fff;font-weight:700}
    .head p{font-size:11px;color:rgba(255,255,255,.35);margin-top:4px;letter-spacing:.08em;text-transform:uppercase}
    .body{padding:32px}
    .icon{font-size:36px;margin-bottom:14px}
    .title{font-size:17px;font-weight:700;color:#0a0a0a;margin-bottom:6px}
    .subtitle{font-size:13px;color:#888;margin-bottom:20px;line-height:1.5}
    .details{background:#f5f0eb;border-left:3px solid #c9984a;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#444;line-height:2}
    .warning{background:#fef3c7;border-left:3px solid #f59e0b;padding:12px 16px;font-size:12px;color:#92400e;margin-bottom:24px;line-height:1.6}
    .btn-cancel{display:block;width:100%;padding:13px;background:#dc2626;border:none;color:#fff;font-size:13px;font-weight:700;letter-spacing:.06em;font-family:inherit;cursor:pointer;margin-bottom:10px;transition:background .15s}
    .btn-cancel:hover{background:#b91c1c}
    .btn-cancel:disabled{background:#ccc;cursor:not-allowed}
    .btn-back{display:block;width:100%;padding:12px;background:#f7f7f5;border:1px solid #e0e0e0;color:#444;font-size:13px;font-family:inherit;cursor:pointer;transition:background .15s}
    .btn-back:hover{background:#eee}
  </style>
</head>
<body>
  <div class="card">
    <div class="head">
      <h1>BookWell</h1>
      <p>Odpoved rezervacije</p>
    </div>
    <div class="body">
      <div class="icon">🗓️</div>
      <div class="title">Ali res želite odpovedati?</div>
      <div class="subtitle">Prosimo potrdite odpoved spodnje rezervacije.</div>
      <div class="details">
        <div>📅 ${dateFormatted}</div>
        <div>🕐 ${slot.time}</div>
        <div>💇 ${slot.service || '—'}</div>
        <div>🏠 ${slot.salon_name}</div>
      </div>
      <div class="warning">⚠️ Tega dejanja ni mogoče razveljaviti. Po odpovedi boste morali rezervirati nov termin.</div>
      <form method="POST" action="/cancel/${token}">
        <button type="submit" class="btn-cancel" id="btn-confirm">Potrdi odpoved rezervacije</button>
      </form>
      <button class="btn-back" onclick="history.back()">← Nazaj, ne odpoveduj</button>
    </div>
  </div>
</body>
</html>`);
});

app.post('/cancel/:token', async (req, res) => {
  const { token } = req.params;
  const { rows } = await pool.query(
    "SELECT t.*, s.name as salon_name, s.phone as salon_phone, s.notification_email FROM timeslots t JOIN salons s ON t.salon_id = s.id WHERE t.cancel_token = $1 AND t.status = 'busy' AND t.date >= CURRENT_DATE",
    [token]
  );
  if (!rows[0]) {
    return res.send(`<!DOCTYPE html><html lang="sl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Odpoved termina</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f7f7f5;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#fff;border:1px solid #e0e0e0;max-width:400px;width:100%;overflow:hidden}.head{background:#0a0a0a;padding:28px 32px}.head h1{font-size:20px;color:#fff;font-weight:700}.body{padding:32px}.icon{font-size:40px;margin-bottom:16px}.msg{font-size:14px;color:#666;line-height:1.6}</style></head><body><div class="card"><div class="head"><h1>BookWell</h1></div><div class="body"><div class="icon">⚠️</div><p class="msg">Ta rezervacija ne obstaja, je že odpovedana ali je termin že minil.</p></div></div></body></html>`);
  }

  const slot = rows[0];
  const dateFormatted = new Date(slot.date).toLocaleDateString('sl-SI', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  await pool.query('DELETE FROM timeslots WHERE cancel_token = $1', [token]);

  if (slot.notification_email) {
    try {
      await sgMail.send({
        to: slot.notification_email,
        from: process.env.SENDGRID_FROM_EMAIL || 'info@bookwell.si',
        subject: `❌ Odpoved rezervacije - ${slot.salon_name} (${dateFormatted} ${slot.time})`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#2d2520;">
            <div style="background:#1a1410;padding:20px;border-radius:12px 12px 0 0;text-align:center;">
              <h1 style="color:#c9a84c;margin:0;font-size:22px;">❌ Odpoved Rezervacije</h1>
            </div>
            <div style="background:#fff;padding:30px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0;border-top:none;">
              <p style="font-size:15px;margin:0 0 20px;">Stranka je odpovedala rezervacijo:</p>
              <div style="background:#f5f0eb;padding:16px 20px;border-radius:8px;">
                <div style="margin-bottom:10px;font-size:13px;"><span style="color:#6b5f52;">👤 Ime:</span> <strong>${slot.customer_name}</strong></div>
                <div style="margin-bottom:10px;font-size:13px;"><span style="color:#6b5f52;">📅 Datum:</span> <strong>${dateFormatted}</strong></div>
                <div style="margin-bottom:10px;font-size:13px;"><span style="color:#6b5f52;">🕐 Ura:</span> <strong>${slot.time}</strong></div>
                <div style="font-size:13px;"><span style="color:#6b5f52;">💇 Storitev:</span> <strong>${slot.service || '—'}</strong></div>
              </div>
            </div>
            <div style="text-align:center;padding:16px;font-size:11px;color:#bbb;">BookWell.si</div>
          </div>
        `
      });
    } catch(e) {
      console.error('❌ Odpoved email napaka:', e.message);
    }
  }

  res.send(`<!DOCTYPE html><html lang="sl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rezervacija odpovedana</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f7f7f5;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#fff;border:1px solid #e0e0e0;max-width:420px;width:100%;overflow:hidden}.head{background:#0a0a0a;padding:28px 32px}.head h1{font-size:20px;color:#fff;font-weight:700}.body{padding:32px}.icon{font-size:40px;margin-bottom:16px}.title{font-size:18px;font-weight:700;color:#0a0a0a;margin-bottom:10px}.details{background:#f5f0eb;border-left:3px solid #c9984a;padding:14px 18px;margin:18px 0;font-size:13px;color:#444;line-height:2}.msg{font-size:13px;color:#888;line-height:1.6;margin-top:16px}</style></head><body><div class="card"><div class="head"><h1>BookWell</h1></div><div class="body"><div class="icon">✅</div><div class="title">Rezervacija odpovedana</div><div class="details"><div>📅 ${dateFormatted}</div><div>🕐 ${slot.time}</div><div>💇 ${slot.service || '—'}</div></div><p class="msg">Vaša rezervacija je bila uspešno odpovedana. Salon je bil obveščen.</p></div></div></body></html>`);
});

// ============================================================================
// GDPR — KORAK 1: Zahteva token (skupna vstopna točka)
// ============================================================================
app.post('/api/gdpr/request', gdprLimiter, async (req, res) => {
  const { email, action } = req.body;

  if (!email || !['access', 'deletion', 'portability', 'rectification'].includes(action)) {
    return res.status(400).json({ error: 'Neveljaven zahtevek' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Neveljaven e-poštni naslov' });
  }

  // Preveri da oseba obstaja
  const { rows } = await pool.query(
    'SELECT id FROM salons WHERE notification_email = $1 AND active = true',
    [email]
  );

  // Vedno vrni isti odgovor (security: ne razkrijemo ali email obstaja)
  if (!rows.length) {
    return res.json({ message: 'Če e-naslov obstaja v sistemu, boste prejeli e-mail.' });
  }

  // Izbriši stare neuporabljene tokene za ta email + action
  await pool.query(
    'DELETE FROM gdpr_tokens WHERE email = $1 AND action = $2 AND used = false',
    [email, action]
  );

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    'INSERT INTO gdpr_tokens (email, token, action, expires_at) VALUES ($1,$2,$3,$4)',
    [email, token, action, expiresAt]
  );

  const verifyUrl = `${process.env.API_URL || 'https://bookwell.si'}/api/gdpr/verify/${token}`;
  const actionNames = {
    access: 'dostop do podatkov',
    deletion: 'brisanje računa',
    portability: 'izvoz podatkov',
    rectification: 'popravek podatkov'
  };

  try {
    await sgMail.send({
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL || 'info@bookwell.si',
      subject: `BookWell — Potrdite GDPR zahtevek`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
          <div style="background:#0a0a0a;padding:24px;text-align:center;">
            <h1 style="color:#c9984a;margin:0;font-size:22px;">BookWell</h1>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #e0e0e0;border-top:none;">
            <p style="font-size:15px;margin:0 0 16px;">Prejeli smo vašo zahtevo za <strong>${actionNames[action]}</strong>.</p>
            <p style="font-size:13px;color:#666;margin:0 0 24px;line-height:1.6;">Kliknite spodnjo povezavo za potrditev. Velja <strong>24 ur</strong>.</p>
            <a href="${verifyUrl}" style="display:block;background:#0a0a0a;color:#c9984a;padding:14px 24px;text-decoration:none;font-weight:700;font-size:13px;text-align:center;letter-spacing:.06em;">
              Potrdi zahtevek →
            </a>
            <p style="margin:20px 0 0;font-size:11px;color:#aaa;line-height:1.6;">
              Če tega niste zahtevali, ignorirajte ta e-mail. Vaši podatki so varni.
            </p>
          </div>
        </div>
      `
    });
  } catch (err) {
    console.error('❌ GDPR email napaka:', err.message);
    return res.status(500).json({ error: 'Napaka pri pošiljanju e-maila' });
  }

  res.json({ message: 'Če e-naslov obstaja v sistemu, boste prejeli e-mail.' });
});

// ============================================================================
// GDPR — KORAK 2: Verifikacija in izvedba
// ============================================================================
app.get('/api/gdpr/verify/:token', async (req, res) => {
  const { token } = req.params;

  const { rows } = await pool.query(
    'SELECT * FROM gdpr_tokens WHERE token = $1 AND used = false AND expires_at > NOW()',
    [token]
  );

  if (!rows[0]) {
    return res.send(buildGdprPage('❌ Napaka', 'Povezava ni veljavna ali je potekla. Zahtevajte novo na info@bookwell.si'));
  }

  const { email, action, id } = rows[0];

  // Označi kot uporabljen
  await pool.query('UPDATE gdpr_tokens SET used = true WHERE id = $1', [id]);

  try {
    if (action === 'access') {
      await handleGdprAccess(email, res);
    } else if (action === 'deletion') {
      await handleGdprDeletion(email, res);
    } else if (action === 'portability') {
      await handleGdprPortability(email, res);
    } else if (action === 'rectification') {
      res.send(buildGdprPage('✏️ Popravek podatkov',
        'Za popravek podatkov pišite na <a href="mailto:info@bookwell.si">info@bookwell.si</a> z navedbo katere podatke želite popraviti. Odgovorili vam bomo v 30 dneh.'
      ));
    }
  } catch (err) {
    console.error('❌ GDPR verify napaka:', err.message);
    res.send(buildGdprPage('❌ Napaka', 'Prišlo je do tehnične napake. Pišite na info@bookwell.si'));
  }
});

async function handleGdprAccess(email, res) {
  const { rows: salons } = await pool.query(
    'SELECT id, name, address, phone, notification_email, plan, chat_count, created_at FROM salons WHERE notification_email = $1',
    [email]
  );

  if (!salons.length) {
    return res.send(buildGdprPage('⚠️ Ni podatkov', 'Ni podatkov za ta e-naslov.'));
  }

  const salon = salons[0];
  const { rows: timeslots } = await pool.query(
    'SELECT date, time, customer_name, customer_email, customer_phone, service, created_at FROM timeslots WHERE salon_id = $1 ORDER BY date DESC',
    [salon.id]
  );
  const { rows: subscriptions } = await pool.query(
    'SELECT plan, amount, customer_email, created_at FROM subscriptions WHERE salon_id = $1',
    [salon.id]
  );

  const csvContent = convertToCSV({ salon, timeslots, subscriptions });

  console.log(`✅ GDPR Access: ${email}`);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="moji-podatki-bookwell.csv"`);
  res.send(csvContent);
}

async function handleGdprDeletion(email, res) {
  const { rows: salons } = await pool.query(
    'SELECT id, plan FROM salons WHERE notification_email = $1',
    [email]
  );

  if (!salons.length) {
    return res.send(buildGdprPage('⚠️ Ni podatkov', 'Ni podatkov za ta e-naslov.'));
  }

  const salon = salons[0];

  const { rows: activeSubs } = await pool.query(
    "SELECT id FROM subscriptions WHERE salon_id = $1 AND status = 'active'",
    [salon.id]
  );

  if (activeSubs.length > 0) {
    return res.send(buildGdprPage(
      '⚠️ Aktivna naročnina',
      'Najprej odpovejte naročnino (prek Stripe ali na info@bookwell.si), nato zahtevajte brisanje.'
    ));
  }

  // Izbriši termine
  await pool.query('DELETE FROM timeslots WHERE salon_id = $1', [salon.id]);

  // Anonimiziraj salon (ohrani davčne zapise)
  await pool.query(`
    UPDATE salons SET
      active = false,
      name = '[Izbrisano]',
      address = '[Izbrisano]',
      phone = '[Izbrisano]',
      notification_email = $1,
      services = '[Izbrisano]',
      admin_username = NULL,
      admin_password = NULL
    WHERE id = $2
  `, [`deleted-${Date.now()}@deleted.local`, salon.id]);

  console.log(`✅ GDPR Deletion: ${email} (salon ${salon.id})`);

  res.send(buildGdprPage(
    '✅ Račun izbrisan',
    'Vaši osebni podatki so bili izbrisani. Davčni zapisi ostanejo 6 let po zakonu (ZDDV-1).'
  ));
}

async function handleGdprPortability(email, res) {
  const { rows: salons } = await pool.query(
    'SELECT id, name, address, phone, created_at FROM salons WHERE notification_email = $1',
    [email]
  );

  if (!salons.length) {
    return res.send(buildGdprPage('⚠️ Ni podatkov', 'Ni podatkov za ta e-naslov.'));
  }

  const salon = salons[0];
  const { rows: timeslots } = await pool.query(
    'SELECT date, time, customer_name, customer_email, service FROM timeslots WHERE salon_id = $1 ORDER BY date DESC',
    [salon.id]
  );

  const exportData = {
    exportDate: new Date().toISOString(),
    exportedBy: 'BookWell.si — GDPR čl. 20',
    salon: {
      id: salon.id,
      name: salon.name,
      address: salon.address,
      phone: salon.phone,
      createdAt: salon.created_at
    },
    timeslots: timeslots.map(ts => ({
      date: ts.date,
      time: ts.time,
      customerName: ts.customer_name,
      customerEmail: ts.customer_email,
      service: ts.service
    }))
  };

  console.log(`✅ GDPR Portability: ${email}`);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="podatki-bookwell.json"`);
  res.json(exportData);
}

// ─── GDPR STRAN HELPER ────────────────────────────────────────────────────────
function buildGdprPage(title, message) {
  return `<!DOCTYPE html>
<html lang="sl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — BookWell</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,sans-serif;background:#f7f7f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
    .card{background:#fff;border:1px solid #e0e0e0;max-width:460px;width:100%;overflow:hidden}
    .head{background:#0a0a0a;padding:24px 32px}
    .head h1{font-size:18px;color:#fff;font-weight:700}
    .body{padding:32px}
    .icon{font-size:36px;margin-bottom:14px}
    .title{font-size:18px;font-weight:700;color:#0a0a0a;margin-bottom:12px}
    .msg{font-size:14px;color:#555;line-height:1.7}
    .msg a{color:#c9984a}
    .back{display:inline-block;margin-top:24px;font-size:12px;color:#888;text-decoration:none;border-bottom:1px solid #ddd}
  </style>
</head>
<body>
  <div class="card">
    <div class="head"><h1>BookWell — GDPR</h1></div>
    <div class="body">
      <div class="title">${title}</div>
      <div class="msg">${message}</div>
      <a href="/" class="back">← Nazaj na domačo stran</a>
    </div>
  </div>
</body>
</html>`;
}

 
// ============================================================================
// 6. BREACH NOTIFICATION (Čl. 33 GDPR)
// ============================================================================
/*
Logiranje kršitve podatkov (dostopa, goljufije, itd.).
Mora biti sporočeno URADY v 72 urah.
*/
 
app.post('/api/gdpr/report-breach', gdprLimiter, async (req, res) => {
  try {
    const { breachType, description, affectedUsers, affectedDataTypes, discoveredDate } = req.body;

    if (!breachType || !description) {
      return res.status(400).json({ error: 'Podatki so obvezni' });
    }

    await pool.query(`
      INSERT INTO breach_log (breach_type, description, affected_users, affected_data_types, discovered_at, status)
      VALUES ($1, $2, $3, $4, $5, 'pending_authority_report')
    `, [breachType, description, affectedUsers, affectedDataTypes, discoveredDate]);

    await sendBreachNotificationToAuthority({
      type: breachType,
      description,
      affectedCount: affectedUsers,
      affectedTypes: affectedDataTypes,
    });

    console.log(`🚨 GDPR Breach: ${breachType}`);
    res.json({ success: true, message: 'Kršitev poročana. URADY bo obveščena v 72 urah.' });

  } catch (err) {
    console.error('❌ GDPR Breach napaka:', err.message);
    res.status(500).json({ error: 'Napaka pri poročanju' });
  }
});

app.get('/privacy', (req, res) => {
  res.sendFile(__dirname + '/privacy-policy.html');
});

app.get('/terms', (req, res) => {
  res.sendFile(__dirname + '/terms-of-service.html');
});

app.get('/dpa', (req, res) => {
  res.sendFile(__dirname + '/dpa.html');
});

app.get('/gdpr', (req, res) => {
  res.sendFile(__dirname + '/gdpr.html');
});

app.get('/contact', (req, res) => {
  res.sendFile(__dirname + '/contact.html');
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/landing.html');
});

app.get('/robots.txt', (req, res) => {
  res.sendFile(__dirname + '/robots.txt');
});

app.get('/google8ff95608da7fc974.html', (req, res) => {
  res.sendFile(__dirname + '/google8ff95608da7fc974.html');
});

app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://bookwell.si/</loc><priority>1.0</priority></url>
  <url><loc>https://bookwell.si/privacy</loc><priority>0.5</priority></url>
  <url><loc>https://bookwell.si/terms</loc><priority>0.5</priority></url>
  <url><loc>https://bookwell.si/dpa</loc><priority>0.3</priority></url>
  <url><loc>https://bookwell.si/contact</loc><priority>0.6</priority></url>
</urlset>`);
});

app.use((req, res) => {
  res.status(404).sendFile(__dirname + '/404.html');
}); 

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
});