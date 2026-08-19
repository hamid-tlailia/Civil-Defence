/**
 * QCD Fleet — OTP Worker
 * وظيفته: توليد رمز تحقق، إرساله رسالةً قصيرة لرقم المدير فقط، ثم التحقق منه.
 * الرمز لا يُرسل للتطبيق أبدًا — يُخزَّن في KV ويُقارن هنا.
 *
 * المسارات:
 *   POST /send    { phone }            → { ok:true }
 *   POST /verify  { phone, code }      → { ok:true, token }  عند النجاح
 *   POST /check    { token }           → { ok:true }  للتحقق من صلاحية الجلسة
 *
 * الإعداد في Cloudflare:
 *   1) wrangler kv namespace create OTP    ثم اربطه باسم OTP في wrangler.toml
 *   2) الأسرار:  wrangler secret put RESEND_KEY / ADMIN_PHONE
 *
 * wrangler.toml
 *   name = "qcd-otp"
 *   main = "worker.js"
 *   compatibility_date = "2026-01-01"
 *   kv_namespaces = [{ binding = "OTP", id = "<KV_ID>" }]
 *   [vars]
 *   ALLOWED_ORIGIN = "https://<حسابك>.github.io"
 *   SMS_PROVIDER   = "vodafone"     # أو "twilio"
 *   SMS_SENDER     = "QCD"          # اسم المرسل المسجَّل لدى المزوّد
 */

const CODE_TTL   = 5 * 60;            // صلاحية الرمز: 5 دقائق
const RATE_TTL   = 60;                // لا أكثر من رسالة كل 60 ثانية
const SESSION_TTL = 30 * 24 * 3600;   // صلاحية جلسة المدير: 30 يومًا

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'content-type': 'application/json; charset=utf-8'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // فحص الحالة من المتصفح: يوضّح ما إذا كانت الإعدادات مضبوطة دون كشف أي سرّ
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/status')) {
      return json({
        ok: true,
        service: 'qcd-otp',
        channel: env.CHANNEL || 'email',
        kv_bound:      !!env.OTP,
        resend_key:    !!env.RESEND_KEY,
        admin_set:     !!env.ADMIN_PHONE,
        allowed_origin: env.ALLOWED_ORIGIN || '(غير مضبوط)',
        mail_from:      env.MAIL_FROM || '(الافتراضي)'
      }, 200, cors);
    }

    // البيانات المشتركة: يقرأها الجميع
    if (request.method === 'GET' && url.pathname === '/data') {
      const raw = await env.OTP.get('fleet');
      if (!raw) return json({ ok: true, updated: 0, data: null }, 200, cors);
      const imgRaw = await env.OTP.get('fleet_img');
      return json({
        ok: true,
        updated: Number(await env.OTP.get('fleet_at')) || 0,
        data: JSON.parse(raw),
        images: imgRaw ? JSON.parse(imgRaw) : {}
      }, 200, cors);
    }

    if (request.method !== 'POST')    return json({ ok: false, error: 'method' }, 405, cors);

    let body = {};
    try { body = await request.json(); } catch (_) {}

    try {
      if (url.pathname === '/send')   return await handleSend(body, env, request, cors);
      if (url.pathname === '/verify') return await handleVerify(body, env, cors);
      if (url.pathname === '/check')  return await handleCheck(body, env, cors);
      if (url.pathname === '/publish') return await handlePublish(body, env, cors);
    } catch (err) {
      return json({ ok: false, error: 'server' }, 500, cors);
    }
    return json({ ok: false, error: 'not_found' }, 404, cors);
  }
};

/* ============ المسارات ============ */

async function handleSend(body, env, request, cors) {
  const phone = normalise(body.phone);

  // رقم المدير وحده مسموح — نردّ ok دائمًا حتى لا يُستدل على الرقم الصحيح
  if (phone !== normalise(env.ADMIN_PHONE)) {
    return json({ ok: true }, 200, cors);
  }

  // حدّ المعدل: رسالة واحدة كل دقيقة لكل رقم ولكل IP
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  if (await env.OTP.get('rate:' + phone) || await env.OTP.get('rate:' + ip)) {
    return json({ ok: false, error: 'rate' }, 429, cors);
  }
  await env.OTP.put('rate:' + phone, '1', { expirationTtl: RATE_TTL });
  await env.OTP.put('rate:' + ip,    '1', { expirationTtl: RATE_TTL });

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
  await env.OTP.put('code:' + phone, await sha256(code), { expirationTtl: CODE_TTL });

  if (env.CHANNEL === 'sms') {
    const text = `رمز الدخول لتطبيق أسطول الدفاع المدني: ${code}\nصالح 5 دقائق. لا تشاركه مع أحد.`;
    await sendSms(phone, text, env);
  } else {
    await sendEmail(phone, code, env);   // phone هنا هو البريد
  }

  return json({ ok: true }, 200, cors);
}

async function handleVerify(body, env, cors) {
  const phone = normalise(body.phone);
  const code  = String(body.code || '').replace(/\D/g, '');
  const saved = await env.OTP.get('code:' + phone);

  if (!saved || !code || saved !== await sha256(code)) {
    return json({ ok: false, error: 'bad_code' }, 401, cors);
  }
  await env.OTP.delete('code:' + phone);

  const token = crypto.randomUUID();
  await env.OTP.put('sess:' + token, phone, { expirationTtl: SESSION_TTL });
  return json({ ok: true, token }, 200, cors);
}

/** نشر البيانات للجميع — للمدير الموثَّق فقط */
async function handlePublish(body, env, cors) {
  const token = String(body.token || '');
  const phone = token ? await env.OTP.get('sess:' + token) : null;
  if (!phone) return json({ ok: false, error: 'unauthorised' }, 401, cors);
  if (!body.data || !body.data.vehicles) return json({ ok: false, error: 'bad_data' }, 400, cors);

  const at = Date.now();
  await env.OTP.put('fleet', JSON.stringify(body.data));
  await env.OTP.put('fleet_at', String(at));
  if (body.images) await env.OTP.put('fleet_img', JSON.stringify(body.images));

  return json({ ok: true, updated: at }, 200, cors);
}

async function handleCheck(body, env, cors) {
  const token = String(body.token || '');
  const phone = token ? await env.OTP.get('sess:' + token) : null;
  return json({ ok: !!phone }, phone ? 200 : 401, cors);
}

/* ============ إرسال الرسالة ============ */

async function sendSms(phone, text, env) {
  if (env.SMS_PROVIDER === 'twilio') return sendTwilio(phone, text, env);
  return sendVodafone(phone, text, env);
}

/* ============ إرسال البريد (الطريقة المجانية الموصى بها) ============ */
/**
 * Resend — الخطة المجانية تكفي تمامًا (آلاف الرسائل شهريًا).
 * سجّل في resend.com، وثّق نطاقك أو استعمل نطاق التجربة، ثم:
 *   wrangler secret put RESEND_KEY
 * وفي wrangler.toml:  MAIL_FROM = "QCD Fleet <onboarding@resend.dev>"
 */
async function sendEmail(to, code, env) {
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial;background:#F4F1EB;padding:24px">
    <div style="max-width:480px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;
                border:1px solid #E7DFD4">
      <div style="height:6px;background:#A81B2D"></div>
      <div style="padding:22px;text-align:center">
        <h2 style="margin:0 0 6px;color:#1F1A16">أسطول الدفاع المدني</h2>
        <p style="margin:0 0 18px;color:#7C6F64;font-size:14px">رمز الدخول لحساب المدير</p>
        <div style="font-size:30px;letter-spacing:10px;font-weight:bold;color:#A81B2D;
                    background:#FDF3D6;border-radius:12px;padding:14px">${code}</div>
        <p style="margin:18px 0 0;color:#7C6F64;font-size:12.5px">
          صالح 5 دقائق. إن لم تطلب هذا الرمز فتجاهل الرسالة ولا تشاركه مع أحد.</p>
      </div>
    </div></div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + env.RESEND_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'QCD Fleet <onboarding@resend.dev>',
      to: [to],
      subject: 'رمز الدخول — أسطول الدفاع المدني',
      html
    })
  });
  if (!res.ok) throw new Error('mail_failed:' + res.status);
}

/**
 * فودافون قطر — خدمة SMS Connect للشركات.
 * الحساب يُفتح من Vodafone Business، ومعه تحصل على:
 *   المستخدم وكلمة المرور (أو مفتاح API)، ورابط الـAPI، واسم المرسل المسجَّل لدى هيئة تنظيم الاتصالات.
 * ضع الرابط الوارد في عقدك مكان SMS_URL — الشكل أدناه هو النمط الشائع لواجهاتهم.
 */
async function sendVodafone(phone, text, env) {
  const url = env.SMS_URL || 'https://smsconnect.vodafone.qa/api/v1/send';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Basic ' + btoa(`${env.SMS_USER}:${env.SMS_PASS}`)
    },
    body: JSON.stringify({
      from: env.SMS_SENDER || 'QCD',
      to: phone,                 // بصيغة 974XXXXXXXX
      text,
      type: 'unicode'            // ضروري للنص العربي
    })
  });
  if (!res.ok) throw new Error('sms_failed:' + res.status);
}

/** بديل جاهز فورًا للتجربة قبل اعتماد حساب فودافون */
async function sendTwilio(phone, text, env) {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'authorization': 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`)
      },
      body: new URLSearchParams({
        To: '+' + phone,
        From: env.TWILIO_FROM,
        Body: text
      })
    }
  );
  if (!res.ok) throw new Error('sms_failed:' + res.status);
}

/* ============ أدوات ============ */

function normalise(v) {
  const raw = String(v || '').trim().toLowerCase();
  if (raw.includes('@')) return raw;          // بريد إلكتروني
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 8) d = '974' + d;          // رقم محلي بدون مفتاح الدولة
  if (d.startsWith('0974')) d = d.slice(1);
  return d;
}

async function sha256(v) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}
