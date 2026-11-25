// Objednávání pro ordinace (Castable weby, zadání ../OBJEDNAVANI.md).
// Pacient si vybere druh návštěvy a volný čas, ordinace potvrdí nebo odmítne, den předem přijde připomínka,
// termín může zrušit pacient i ordinace a druhá strana dostane e-mail.
// Časy jsou místní čas Praha ve tvaru 'YYYY-MM-DDTHH:MM', aby se daly porovnávat jako text.

import { WorkerEntrypoint } from 'cloudflare:workers';

const TZ = 'Europe/Prague';
const DNY = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
const DNY_KRATCE = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
const AKTIVNI = ['ceka', 'potvrzeno'];

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      console.error(e && e.stack || e);
      return html(stranka('Něco se nepovedlo', '<p>Něco se nepovedlo. Zkuste to prosím znovu, nebo ordinaci zavolejte.</p>'), 500);
    }
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(hodinovaUdrzba(env));
  },
};

// ---------- čas ----------
function nyni() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function rozloz(t) {
  const [d, h] = t.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [hh, mm] = (h || '00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, dd, hh, mm);
}
function slozit(ms) {
  const d = new Date(ms);
  const z = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}T${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`;
}
const pridej = (t, min) => slozit(rozloz(t) + min * 60000);
const denTydne = den => new Date(rozloz(den + 'T00:00')).getUTCDay(); // 0 = neděle
function hezkyDen(t) {
  const d = new Date(rozloz(t));
  return `${DNY[d.getUTCDay()]} ${d.getUTCDate()}. ${d.getUTCMonth() + 1}.`;
}
const hezkyCas = t => t.slice(11, 16).replace(/^0/, '');
const hezky = t => `${hezkyDen(t)} v ${hezkyCas(t)}`;

// ---------- pomocné ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function html(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer', ...extra } });
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function token() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const zaklad = (env, req) => (env.ZAKLAD && !env.ZAKLAD.includes('DOPLNIT')) ? env.ZAKLAD.replace(/\/$/, '') : new URL(req.url).origin;

async function nactiOrdinaci(env, slug) {
  const o = await env.DB.prepare('SELECT * FROM ordinace WHERE slug = ?').bind(slug).first();
  if (!o) return null;
  o.n = JSON.parse(o.nastaveni);
  return o;
}

// ---------- volné časy ----------
async function obsazene(env, slug, den) {
  const r = await env.DB.prepare(
    `SELECT zacatek, konec FROM termin WHERE ordinace = ? AND stav IN ('ceka','potvrzeno') AND zacatek < ? AND konec > ?`
  ).bind(slug, den + 'T23:59', den + 'T00:00').all();
  return r.results || [];
}
function casyDne(o, typ, den, obs) {
  const n = o.n;
  if ((n.zavreno || []).includes(den)) return [];
  const dow = denTydne(den) || 7; // 1 = pondělí … 7 = neděle
  const okna = (n.hodiny || {})[String(dow)] || [];
  const nejdriv = pridej(nyni(), (n.predem_hodin ?? 2) * 60);
  const out = [];
  for (const [od, doo] of okna) {
    let t = `${den}T${od}`;
    const konecOkna = `${den}T${doo}`;
    while (pridej(t, typ.min) <= konecOkna) {
      const k = pridej(t, typ.min);
      if (t >= nejdriv && !obs.some(x => x.zacatek < k && x.konec > t)) out.push(t);
      t = k;
    }
  }
  return out;
}
function dnyDopredu(o) {
  const dnes = nyni().slice(0, 10);
  const out = [];
  for (let i = 0; i <= (o.n.dopredu_dni ?? 28); i++) out.push(pridej(dnes + 'T00:00', i * 1440).slice(0, 10));
  return out;
}

// ---------- e-maily ----------
function tlacitkoMail(href, text, barva) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${esc(barva)};color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${esc(text)}</a>`;
}
function mailHtml(radky, tlacitko, pata) {
  const p = radky.map(r => `<p style="margin:0 0 12px">${esc(r)}</p>`).join('');
  const f = pata ? `<p style="margin:24px 0 0;font-size:13px;color:#6b7280">${esc(pata)}</p>` : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1f2937;max-width:560px">${p}${tlacitko ? `<p style="margin:20px 0">${tlacitko}</p>` : ''}${f}</div>`;
}
// Odesílatel: adresa z nastavení ordinace (až bude jejich doména ověřená v Resendu), jinak z ODESILATEL.
// Jméno odesílatele: pacient vidí název ordinace, ordinace vidí „Online objednávání“.
function odesilatel(env, o, pro) {
  const m = String(env.ODESILATEL || '').match(/<([^>]+)>/);
  const adresa = (o && o.n && o.n.odesilatel) || (m ? m[1] : env.ODESILATEL);
  const jmeno = pro === 'pacient' ? o.nazev : 'Online objednávání';
  return `"${jmeno.replace(/["\\]/g, '')}" <${adresa}>`;
}
// pro: 'pacient' | 'ordinace'. U ukázkové ordinace dostanou oba maily Pepa, proto je v ukázce označíme.
async function posli(env, { o, pro, komu, predmet, radky, odkaz, popisek, odpovedet }) {
  const ukazka = o.n.ukazka || o.slug === 'ukazka';
  if (ukazka) {
    predmet = `[ukázka: ${pro === 'pacient' ? 'pro pacienta' : 'pro ordinaci'}] ${predmet}`;
    radky = [pro === 'pacient' ? 'UKÁZKA: tenhle e-mail dostane pacient.' : 'UKÁZKA: tenhle e-mail dostane ordinace.', ...radky];
  }
  const pata = pro === 'pacient' ? 'Když na tento e-mail odpovíte, odpověď přijde přímo ordinaci.'
    : 'E-mail poslalo online objednávání na vašem webu. Odpovědí napíšete přímo pacientovi.';
  const text = radky.join('\n\n') + (odkaz ? `\n\n${popisek}: ${odkaz}` : '') + `\n\n${pata}`;
  const telo = mailHtml(radky, odkaz ? tlacitkoMail(odkaz, popisek, o.barva || '#0f766e') : '', pata);
  let vysledek = 'jen-zapsano';
  if (env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: odesilatel(env, o, pro), to: [komu], subject: predmet, text, html: telo, ...(odpovedet ? { reply_to: odpovedet } : {}) }),
    });
    vysledek = r.ok ? 'odeslano' : `chyba ${r.status}: ${(await r.text()).slice(0, 200)}`;
    if (!r.ok) console.error('Resend', vysledek);
  }
  await env.DB.prepare('INSERT INTO posta (cas, komu, predmet, telo, vysledek) VALUES (?, ?, ?, ?, ?)')
    .bind(nyni(), komu, predmet, env.RESEND_API_KEY ? null : text, vysledek).run();
}

// ---------- směrování ----------
async function route(req, env, ctx) {
  const url = new URL(req.url);
  const cesta = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const m = req.method;

  if (m === 'GET' && cesta[0] === 'o' && cesta.length === 2) return strankaObjednani(env, cesta[1]);
  if (cesta[0] === 'api' && cesta[1] === 'o' && cesta.length === 4) {
    const o = await nactiOrdinaci(env, cesta[2]);
    if (!o) return json({ chyba: 'Ordinace nenalezena.' }, 404);
    if (m === 'GET' && cesta[3] === 'dny') return apiDny(env, o, url);
    if (m === 'GET' && cesta[3] === 'casy') return apiCasy(env, o, url);
    if (m === 'POST' && cesta[3] === 'objednat') return apiObjednat(env, req, o);
  }
  if (cesta[0] === 't' && cesta.length === 2 && m === 'GET') return strankaTerminu(env, cesta[1]);
  if (cesta[0] === 't' && cesta.length === 2 && m === 'POST') return akceTerminu(env, req, cesta[1]);
  if (m === 'GET' && cesta[0] === 'prehled' && cesta.length === 2) return prehled(env, cesta[1], url.searchParams.get('k'));
  return html(stranka('Stránka nenalezena', '<p>Tahle stránka neexistuje.</p>'), 404);
}

// ---------- API pro stránku objednání ----------
function najdiTyp(o, id) {
  const typy = o.n.typy || [];
  return typy.find(t => t.id === id) || (typy.length === 1 ? typy[0] : null);
}
async function apiDny(env, o, url) {
  const typ = najdiTyp(o, url.searchParams.get('typ'));
  if (!typ) return json({ chyba: 'Vyberte druh návštěvy.' }, 400);
  const dny = dnyDopredu(o);
  const r = await env.DB.prepare(
    `SELECT zacatek, konec FROM termin WHERE ordinace = ? AND stav IN ('ceka','potvrzeno') AND konec > ? AND zacatek < ?`
  ).bind(o.slug, dny[0] + 'T00:00', dny[dny.length - 1] + 'T23:59').all();
  const vse = r.results || [];
  const out = [];
  for (const den of dny) {
    const obs = vse.filter(x => x.zacatek < den + 'T23:59' && x.konec > den + 'T00:00');
    const casy = casyDne(o, typ, den, obs);
    if (casy.length) out.push({ den, popis: hezkyDen(den + 'T00:00'), kratce: DNY_KRATCE[denTydne(den)], volnych: casy.length });
  }
  return json({ dny: out });
}
async function apiCasy(env, o, url) {
  const typ = najdiTyp(o, url.searchParams.get('typ'));
  const den = url.searchParams.get('den') || '';
  if (!typ || !/^\d{4}-\d{2}-\d{2}$/.test(den) || !dnyDopredu(o).includes(den)) return json({ chyba: 'Neplatný den.' }, 400);
  const casy = casyDne(o, typ, den, await obsazene(env, o.slug, den));
  return json({ casy: casy.map(t => ({ t, popis: hezkyCas(t) })) });
}
async function apiObjednat(env, req, o) {
  let d;
  try { d = await req.json(); } catch { return json({ chyba: 'Neplatná žádost.' }, 400); }
  if (d.web) return json({ ok: true }); // past na roboty
  const typ = najdiTyp(o, d.typ);
  const zacatek = String(d.zacatek || '');
  const jmeno = String(d.jmeno || '').trim().replace(/\s+/g, ' ');
  const telefon = String(d.telefon || '').trim();
  const email = String(d.email || '').trim().toLowerCase();
  if (!typ || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(zacatek)) return json({ chyba: 'Vyberte druh návštěvy a čas.' }, 400);
  if (jmeno.length < 3 || jmeno.length > 80) return json({ chyba: 'Napište prosím jméno a příjmení.' }, 400);
  if ((telefon.match(/\d/g) || []).length < 9 || telefon.length > 25) return json({ chyba: 'Napište prosím telefon.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return json({ chyba: 'Napište prosím platný e-mail.' }, 400);
  const den = zacatek.slice(0, 10);
  if (!dnyDopredu(o).includes(den) || !casyDne(o, typ, den, await obsazene(env, o.slug, den)).includes(zacatek)) {
    return json({ chyba: 'Tento čas už není volný. Vyberte prosím jiný.', obsazeno: true }, 409);
  }
  const konec = pridej(zacatek, typ.min);
  const id = crypto.randomUUID(), tp = token(), to = token();
  // vložit jen když se čas mezitím nikdo jiný nevzal (jeden příkaz, žádný souběh)
  const r = await env.DB.prepare(
    `INSERT INTO termin (id, ordinace, typ, zacatek, konec, jmeno, telefon, email, stav, token_p, token_o, vytvoreno)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'ceka', ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM termin WHERE ordinace = ? AND stav IN ('ceka','potvrzeno') AND zacatek < ? AND konec > ?)`
  ).bind(id, o.slug, typ.id, zacatek, konec, jmeno, telefon, email, tp, to, nyni(), o.slug, konec, zacatek).run();
  if (!r.meta || !r.meta.changes) return json({ chyba: 'Tento čas si mezitím vzal někdo jiný. Vyberte prosím jiný.', obsazeno: true }, 409);

  const z = zaklad(env, req);
  await posli(env, {
    o, pro: 'ordinace', komu: o.email, predmet: `Nová objednávka: ${jmeno}, ${hezky(zacatek)}`, odpovedet: email,
    radky: [`${jmeno} se přes web objednal(a) na ${hezky(zacatek)}.`, `Druh návštěvy: ${typ.nazev} (${typ.min} minut).`, `Telefon: ${telefon}. E-mail: ${email}.`,
      'Termín čeká na vaše potvrzení. Do té doby ho nikdo jiný nedostane.'],
    odkaz: `${z}/t/${to}`, popisek: 'Potvrdit nebo odmítnout',
  });
  await posli(env, {
    o, pro: 'pacient', komu: email, predmet: `Čeká na potvrzení: ${hezky(zacatek)}`, odpovedet: o.email,
    radky: ['Dobrý den,', `děkujeme za objednání na ${hezky(zacatek)} (${typ.nazev}).`,
      'Termín ještě musíme potvrdit. Potvrzení vám přijde dalším e-mailem.',
      'Když nebudete moct přijít, termín zrušíte tlačítkem níže.'],
    odkaz: `${z}/t/${tp}`, popisek: 'Zobrazit nebo zrušit termín',
  });
  return json({ ok: true, popis: hezky(zacatek) });
}

// ---------- odkaz z e-mailu: pacient i ordinace ----------
async function terminPodleTokenu(env, t) {
  const r = await env.DB.prepare('SELECT * FROM termin WHERE token_p = ? OR token_o = ?').bind(t, t).first();
  if (!r) return null;
  r.kdo = r.token_o === t ? 'ordinace' : 'pacient';
  r.o = await nactiOrdinaci(env, r.ordinace);
  r.typNazev = ((r.o.n.typy || []).find(x => x.id === r.typ) || {}).nazev || r.typ;
  return r;
}
const POPIS_STAVU = {
  ceka: 'Čeká na potvrzení ordinací', potvrzeno: 'Potvrzeno', odmitnuto: 'Ordinace termín odmítla',
  zrusil_pacient: 'Zrušeno pacientem', zrusila_ordinace: 'Zrušeno ordinací',
};
function tlacitko(akce, text, druhe = false) {
  return `<form method="post"><input type="hidden" name="akce" value="${akce}"><button class="btn${druhe ? ' btn2' : ''}">${esc(text)}</button></form>`;
}
async function strankaTerminu(env, t) {
  const r = await terminPodleTokenu(env, t);
  if (!r) return html(stranka('Termín nenalezen', '<p>Odkaz neplatí. Termín možná už byl smazán.</p>'), 404, { 'x-robots-tag': 'noindex' });
  const probehl = r.zacatek <= nyni();
  let tela = `<p class="velky">${esc(hezky(r.zacatek))}</p><p>${esc(r.typNazev)} · ${esc(r.o.nazev)}</p><p class="stav stav-${r.stav}">${esc(POPIS_STAVU[r.stav] || r.stav)}</p>`;
  if (r.kdo === 'ordinace') {
    tela += `<p class="mensi">${esc(r.jmeno)} · ${esc(r.telefon)} · ${esc(r.email)}</p>`;
    if (!probehl && r.stav === 'ceka') tela += `<div class="akce">${tlacitko('potvrdit', 'Potvrdit termín')}${tlacitko('odmitnout', 'Odmítnout', true)}</div>`;
    if (!probehl && r.stav === 'potvrzeno') tela += `<div class="akce">${tlacitko('zrusit', 'Zrušit termín', true)}</div><p class="mensi">Pacientovi hned přijde e-mail, že byl termín zrušen, s odkazem na výběr jiného času.</p>`;
  } else {
    if (!probehl && AKTIVNI.includes(r.stav)) tela += `<div class="akce">${tlacitko('zrusit', 'Zrušit termín', true)}</div><p class="mensi">Ordinaci hned přijde zpráva, že se čas uvolnil.</p>`;
    if (['odmitnuto', 'zrusila_ordinace', 'zrusil_pacient'].includes(r.stav)) tela += `<p><a class="btn" href="/o/${esc(r.ordinace)}">Vybrat jiný čas</a></p>`;
  }
  return html(stranka(r.o.nazev, tela, r.o.barva), 200, { 'x-robots-tag': 'noindex' });
}
async function akceTerminu(env, req, t) {
  const r = await terminPodleTokenu(env, t);
  if (!r) return html(stranka('Termín nenalezen', '<p>Odkaz neplatí.</p>'), 404);
  const akce = (await req.formData()).get('akce');
  const z = zaklad(env, req);
  const probehl = r.zacatek <= nyni();
  const zmen = async (z1, na) => (await env.DB.prepare('UPDATE termin SET stav = ? WHERE id = ? AND stav = ?').bind(na, r.id, z1).run()).meta.changes;
  let hlaska = 'S termínem se už nic udělat nedá.';

  if (!probehl && r.kdo === 'ordinace' && akce === 'potvrdit' && await zmen('ceka', 'potvrzeno')) {
    // když je do termínu méně než den, potvrzení slouží zároveň jako připomínka
    if (r.zacatek <= pridej(nyni(), 24 * 60)) await env.DB.prepare('UPDATE termin SET pripomenuto = 1 WHERE id = ?').bind(r.id).run();
    await posli(env, {
      o: r.o, pro: 'pacient', komu: r.email, predmet: `Termín potvrzen: ${hezky(r.zacatek)}`, odpovedet: r.o.email,
      radky: ['Dobrý den,', `váš termín ${hezky(r.zacatek)} (${r.typNazev}) je potvrzený.`,
        r.o.adresa ? `Adresa: ${r.o.adresa}.` : '', 'Den předem vám pošleme připomínku. Když nebudete moct přijít, termín prosím zrušte tlačítkem níže.'].filter(Boolean),
      odkaz: `${z}/t/${r.token_p}`, popisek: 'Zobrazit nebo zrušit termín',
    });
    hlaska = 'Termín je potvrzený. Pacientovi přišel e-mail.';
  } else if (!probehl && r.kdo === 'ordinace' && akce === 'odmitnout' && await zmen('ceka', 'odmitnuto')) {
    await posli(env, {
      o: r.o, pro: 'pacient', komu: r.email, predmet: `Termín ${hezky(r.zacatek)} nemůžeme potvrdit`, odpovedet: r.o.email,
      radky: ['Dobrý den,', `termín ${hezky(r.zacatek)} vám bohužel nemůžeme potvrdit.`, 'Vyberte si prosím jiný čas.'],
      odkaz: `${z}/o/${r.ordinace}`, popisek: 'Vybrat jiný čas',
    });
    hlaska = 'Termín je odmítnutý a čas je zase volný. Pacientovi přišel e-mail s odkazem na jiný čas.';
  } else if (!probehl && r.kdo === 'ordinace' && akce === 'zrusit' && (await zmen('potvrzeno', 'zrusila_ordinace') || await zmen('ceka', 'zrusila_ordinace'))) {
    await posli(env, {
      o: r.o, pro: 'pacient', komu: r.email, predmet: `Termín ${hezky(r.zacatek)} je zrušený`, odpovedet: r.o.email,
      radky: ['Dobrý den,', `váš termín ${hezky(r.zacatek)} jsme bohužel museli zrušit. Omlouváme se.`, 'Vyberte si prosím jiný čas.'],
      odkaz: `${z}/o/${r.ordinace}`, popisek: 'Vybrat jiný čas',
    });
    hlaska = 'Termín je zrušený a čas je zase volný. Pacientovi přišel e-mail.';
  } else if (!probehl && r.kdo === 'pacient' && akce === 'zrusit' && (await zmen('potvrzeno', 'zrusil_pacient') || await zmen('ceka', 'zrusil_pacient'))) {
    await posli(env, {
      o: r.o, pro: 'ordinace', komu: r.o.email, predmet: `Zrušeno: ${r.jmeno}, ${hezky(r.zacatek)}`, odpovedet: r.email,
      radky: [`${r.jmeno} zrušil(a) termín ${hezky(r.zacatek)} (${r.typNazev}).`, 'Čas je zase volný a dá se na něj objednat.'],
    });
    hlaska = 'Termín je zrušený. Ordinaci přišla zpráva, že se čas uvolnil.';
  }
  return html(stranka(r.o.nazev, `<p class="velky">${esc(hlaska)}</p><p><a href="/t/${esc(t)}">Zpět na termín</a></p>`, r.o.barva), 200, { 'x-robots-tag': 'noindex' });
}

// ---------- přehled pro ordinaci ----------
async function prehled(env, slug, k) {
  const o = await nactiOrdinaci(env, slug);
  if (!o || !k || k !== o.admin_klic) return html(stranka('Přehled', '<p>Odkaz neplatí.</p>'), 403, { 'x-robots-tag': 'noindex' });
  const dnes = nyni().slice(0, 10);
  const r = await env.DB.prepare(`SELECT * FROM termin WHERE ordinace = ? AND zacatek >= ? ORDER BY zacatek`).bind(slug, dnes + 'T00:00').all();
  const rows = r.results || [];
  let den = '', tela = `<h1>${esc(o.nazev)}</h1><p class="mensi">Termíny od dneška. Klepnutím otevřete termín a potvrdíte, odmítnete nebo zrušíte ho.</p>`;
  if (!rows.length) tela += '<p>Zatím žádné termíny.</p>';
  for (const x of rows) {
    const d = x.zacatek.slice(0, 10);
    if (d !== den) { den = d; tela += `<h2>${esc(hezkyDen(x.zacatek))}</h2>`; }
    tela += `<a class="radek stav-${x.stav}" href="/t/${esc(x.token_o)}"><b>${esc(hezkyCas(x.zacatek))}</b> ${esc(x.jmeno)}<span>${esc(POPIS_STAVU[x.stav])}</span></a>`;
  }
  return html(stranka(o.nazev, tela, o.barva), 200, { 'x-robots-tag': 'noindex', 'cache-control': 'no-store' });
}

// ---------- připomínky a mazání (cron) ----------
async function hodinovaUdrzba(env) {
  const ted = nyni();
  const zaDen = pridej(ted, 24 * 60);
  const zakladOk = env.ZAKLAD && !env.ZAKLAD.includes('DOPLNIT');
  if (!zakladOk) console.error('ZAKLAD není nastavený: připomínky by měly rozbitý odkaz, posílám je až po nastavení.');
  const r = zakladOk ? await env.DB.prepare(`SELECT * FROM termin WHERE stav = 'potvrzeno' AND pripomenuto = 0 AND zacatek > ? AND zacatek <= ?`).bind(ted, zaDen).all() : { results: [] };
  for (const x of r.results || []) {
    const o = await nactiOrdinaci(env, x.ordinace);
    const typ = ((o.n.typy || []).find(t => t.id === x.typ) || {}).nazev || x.typ;
    const z = env.ZAKLAD.replace(/\/$/, '');
    await posli(env, {
      o, pro: 'pacient', komu: x.email, predmet: `Připomínka: ${hezky(x.zacatek)}`, odpovedet: o.email,
      radky: ['Dobrý den,', `připomínáme váš termín ${hezky(x.zacatek)} (${typ}).`, o.adresa ? `Adresa: ${o.adresa}.` : '',
        'Když nemůžete přijít, termín prosím zrušte tlačítkem níže, ať ho může dostat někdo jiný.'].filter(Boolean),
      odkaz: `${z}/t/${x.token_p}`, popisek: 'Zrušit termín',
    });
    await env.DB.prepare('UPDATE termin SET pripomenuto = 1 WHERE id = ?').bind(x.id).run();
  }
  // osobní údaje mažeme 30 dní po termínu
  const pred30 = pridej(ted, -30 * 1440);
  await env.DB.prepare('DELETE FROM termin WHERE zacatek < ?').bind(pred30).run();
  await env.DB.prepare('DELETE FROM posta WHERE cas < ?').bind(pred30).run();
}

// ---------- vzhled ----------
function stranka(titulek, obsah, barva = '#0f766e') {
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(titulek)}</title><style>${CSS(barva)}</style></head>
<body><main class="box">${obsah}</main></body></html>`;
}
const CSS = barva => `
:root{--a:${barva};--t:#1f2937;--m:#6b7280;--l:#e5e7eb;--b:#f8fafc}
a{color:var(--a)}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--t);background:var(--b)}
.box{max-width:560px;margin:0 auto;padding:24px 18px 48px}
h1{font-size:24px;line-height:1.25;margin:0 0 4px}h2{font-size:16px;margin:26px 0 10px}
.mensi{color:var(--m);font-size:14px}.velky{font-size:22px;font-weight:700;margin:0 0 6px}
.btn{display:inline-block;width:100%;border:0;border-radius:12px;padding:15px 18px;font-weight:600;font-size:17px;line-height:1.2;font-family:inherit;background:var(--a);color:#fff;text-align:center;text-decoration:none;cursor:pointer;margin:6px 0}
.btn2{background:#fff;color:var(--t);border:1.5px solid var(--l)}
.akce form{margin:0}
.stav{display:inline-block;padding:4px 10px;border-radius:99px;background:#eef2f7;font-size:14px;font-weight:600}
.stav-potvrzeno{background:#dcfce7}.stav-ceka{background:#fef9c3}.stav-odmitnuto,.stav-zrusil_pacient,.stav-zrusila_ordinace{background:#fee2e2}
.radek{display:flex;gap:10px;align-items:center;padding:12px 14px;margin:6px 0;background:#fff;border:1px solid var(--l);border-radius:12px;color:var(--t);text-decoration:none}
.radek span{margin-left:auto;font-size:13px;color:var(--m)}
.volby{display:flex;flex-wrap:wrap;gap:8px}
.volba{border:1.5px solid var(--l);background:#fff;border-radius:12px;padding:11px 14px;font:inherit;color:var(--t);cursor:pointer}
.volba[aria-pressed=true]{border-color:var(--a);background:var(--a);color:#fff}
.dny{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;scroll-snap-type:x mandatory}
.den{flex:0 0 auto;min-width:68px;text-align:center;scroll-snap-align:start}.den small{display:block;font-size:12px;opacity:.8}
.casy{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px}
label{display:block;font-weight:600;margin:14px 0 6px}
input{width:100%;padding:13px 14px;border:1.5px solid var(--l);border-radius:12px;font:inherit;background:#fff}
input:focus,.volba:focus-visible,.btn:focus-visible{outline:3px solid color-mix(in srgb,var(--a) 35%,transparent);outline-offset:1px}
.chyba{color:#b91c1c;font-weight:600}.ok{background:#fff;border:1px solid var(--l);border-radius:14px;padding:18px}
.krok{margin-top:22px}.skryt{display:none}.hp{position:absolute;left:-9999px}
`;

async function strankaObjednani(env, slug) {
  const o = await nactiOrdinaci(env, slug);
  if (!o) return html(stranka('Ordinace nenalezena', '<p>Tahle ordinace tu objednávání nemá.</p>'), 404);
  const typy = o.n.typy || [];
  const data = { slug: o.slug, typy: typy.map(t => ({ id: t.id, nazev: t.nazev, min: t.min })) };
  const obsah = `
<h1>Objednání: ${esc(o.nazev)}</h1>
${o.adresa ? `<p class="mensi">${esc(o.adresa)}${o.telefon ? ` · <a href="tel:${esc(o.telefon.replace(/\s/g, ''))}">${esc(o.telefon)}</a>` : ''}</p>` : ''}
<div id="k1" class="krok ${typy.length === 1 ? 'skryt' : ''}"><h2>Druh návštěvy</h2><div class="volby" id="typy"></div></div>
<div id="k2" class="krok skryt"><h2>Den</h2><div class="dny" id="dny"></div><p id="zadneDny" class="mensi skryt">V nejbližších týdnech už není volný čas. Zavolejte prosím do ordinace.</p></div>
<div id="k3" class="krok skryt"><h2>Čas</h2><div class="casy" id="casy"></div></div>
<form id="k4" class="krok skryt" novalidate>
  <h2 id="vybrano"></h2>
  <label for="jmeno">Jméno a příjmení</label><input id="jmeno" name="jmeno" autocomplete="name" required>
  <label for="telefon">Telefon</label><input id="telefon" name="telefon" type="tel" autocomplete="tel" required>
  <label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" required>
  <input class="hp" name="web" tabindex="-1" autocomplete="off" aria-hidden="true">
  <p class="mensi">Na e-mail vám přijde potvrzení a den předem připomínka. Údaje použije jen ordinace k objednání a 30 dní po termínu se smažou.</p>
  <p id="chyba" class="chyba" role="alert"></p>
  <button class="btn" id="odeslat">Odeslat žádost o termín</button>
</form>
<div id="hotovo" class="krok ok skryt" role="status"></div>
<script>
const D=${JSON.stringify(data).replace(/</g, '\\u003c')};
let typ=D.typy.length===1?D.typy[0].id:null, cas=null, casPopis='';
const $=id=>document.getElementById(id);
function tl(text,fn,cls){const b=document.createElement('button');b.type='button';b.className='volba '+(cls||'');b.innerHTML=text;b.setAttribute('aria-pressed','false');b.onclick=()=>{[...b.parentNode.children].forEach(x=>x.setAttribute('aria-pressed','false'));b.setAttribute('aria-pressed','true');fn();};return b;}
D.typy.forEach(t=>$('typy').appendChild(tl(t.nazev+' <small>· '+t.min+' min</small>',()=>{typ=t.id;nactiDny();})));
async function nactiDny(){cas=null;['k3','k4'].forEach(k=>$(k).classList.add('skryt'));$('k2').classList.remove('skryt');$('dny').innerHTML='';
 const r=await (await fetch('/api/o/'+D.slug+'/dny?typ='+encodeURIComponent(typ))).json();
 $('zadneDny').classList.toggle('skryt',!!(r.dny&&r.dny.length));
 (r.dny||[]).forEach(d=>$('dny').appendChild(tl(d.kratce+'<small>'+d.popis.split(' ').slice(1).join(' ')+'</small>',()=>nactiCasy(d.den,d.popis),'den')));
 $('k2').scrollIntoView({behavior:'smooth',block:'start'});}
async function nactiCasy(den,popisDne){cas=null;$('k4').classList.add('skryt');$('k3').classList.remove('skryt');$('casy').innerHTML='';
 const r=await (await fetch('/api/o/'+D.slug+'/casy?typ='+encodeURIComponent(typ)+'&den='+den)).json();
 (r.casy||[]).forEach(c=>$('casy').appendChild(tl(c.popis,()=>{cas=c.t;casPopis=popisDne+' v '+c.popis;$('vybrano').textContent=casPopis;$('k4').classList.remove('skryt');$('k4').scrollIntoView({behavior:'smooth',block:'start'});})));
 $('k3').scrollIntoView({behavior:'smooth',block:'start'});}
$('k4').onsubmit=async e=>{e.preventDefault();$('chyba').textContent='';$('odeslat').disabled=true;
 const f=new FormData($('k4'));const body=Object.fromEntries(f);body.typ=typ;body.zacatek=cas;
 try{const res=await fetch('/api/o/'+D.slug+'/objednat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const r=await res.json();
  if(r.ok){['k1','k2','k3','k4'].forEach(k=>$(k).classList.add('skryt'));$('hotovo').classList.remove('skryt');
   $('hotovo').innerHTML='<p class="velky">Žádost je odeslaná.</p><p>Termín '+casPopis+' čeká na potvrzení ordinací. Jakmile ho potvrdí, přijde vám e-mail.</p>';}
  else{$('chyba').textContent=r.chyba||'Něco se nepovedlo.';if(r.obsazeno)nactiDny();}}
 catch(_){$('chyba').textContent='Nepodařilo se odeslat. Zkuste to prosím znovu.';}
 $('odeslat').disabled=false;};
if(typ)nactiDny();
</script>`;
  return html(stranka(`Objednání: ${o.nazev}`, obsah, o.barva), 200, { 'cache-control': 'no-store' });
}

// ---------- pošta pro další Workery ----------
// E-shop Antikvariát Ichtys posílá e-maily přes tuto vazbu (service binding s entrypointem Posta).
// Přes HTTP se sem nedá dostat, klíč Resendu zůstává jen tady. Odesílat jde jen z domény castablestudio.com.
export class Posta extends WorkerEntrypoint {
  async posli({ odesilatel, komu, predmet, text, odpovedet }) {
    if (!this.env.RESEND_API_KEY) return 'neodeslano: chybi RESEND_API_KEY';
    if (!/@castablestudio\.com>?$/.test(String(odesilatel || ''))) return 'chyba: odesilatel mimo castablestudio.com';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(komu || ''))) return 'chyba: adresat';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: odesilatel, to: [komu], subject: String(predmet).slice(0, 200), text: String(text), ...(odpovedet ? { reply_to: odpovedet } : {}) }),
    });
    return r.ok ? 'odeslano' : `chyba ${r.status}: ${(await r.text()).slice(0, 200)}`;
  }
}

