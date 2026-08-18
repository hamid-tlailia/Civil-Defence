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
 *   2) الأسرار:  wrangler secret put SMS_USER / SMS_PASS / ADMIN_PHONE / SESSION_SECRET
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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'content-type': 'application/json; charset=utf-8'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST')    return json({ ok: false, error: 'method' }, 405, cors);

    let body = {};
    try { body = await request.json(); } catch (_) {}

    try {
      if (url.pathname === '/send')   return await handleSend(body, env, request, cors);
      if (url.pathname === '/verify') return await handleVerify(body, env, cors);
      if (url.pathname === '/check')  return await handleCheck(body, env, cors);
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

  const text = `رمز الدخول لتطبيق أسطول الدفاع المدني: ${code}\nصالح 5 دقائق. لا تشاركه مع أحد.`;
  await sendSms(phone, text, env);

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
  let d = String(v || '').replace(/\D/g, '');
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
