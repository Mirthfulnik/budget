/**
 * Finance 2026 — Cloudflare Worker + D1
 * Перенос бэкенда с Yandex Cloud Function + Object Storage.
 * Протокол (actions, формат запросов и ответов, токены) полностью совместим
 * с прежней функцией — фронтенду нужно поменять только API_URL.
 *
 * ─── Secrets (wrangler secret put …) ─────────────────────────────────
 *   TOKEN_SECRET   — секрет подписи токенов
 *   AUTH_LOGIN     — логин (desktop)
 *   AUTH_PASSWORD  — пароль (desktop)
 *   AUTH_PIN       — 6-значный PIN (mobile)
 *   GAS_FEEDBACK_URL (необязательно) — URL Google Apps Script для формы обратной связи
 *
 * ─── Vars (wrangler.toml) ─────────────────────────────────────────────
 *   AUTH_TTL_HOURS            — срок жизни токена, часов (по умолчанию 12)
 *   ALLOWED_ORIGINS           — разрешённые origins через запятую (пусто = *)
 *   ALLOWED_REFERER_PREFIXES  — разрешённые префиксы Referer через запятую (пусто = не проверять)
 *
 * ─── Хранение ─────────────────────────────────────────────────────────
 *   D1, таблица items(coll, id, json). Каждая запись коллекции — отдельная строка,
 *   поэтому изменение одной операции не перезаписывает весь файл, как было в S3.
 *   Порядок записей = порядок вставки (rowid), как порядок элементов в JSON-файлах.
 *
 * ─── Пересчёт в лари ──────────────────────────────────────────────────
 *   Коллекция fxGel: курсы Нацбанка Грузии, одна запись на дату
 *   {id: "YYYY-MM-DD", date, rates: {USD: 2.6091, RUB: 0.031007, …}} — лари за 1 единицу.
 *   Каждой операции сервер дописывает поля:
 *     amountGel    — сумма в лари
 *     gelRate      — использованный курс (лари за 1 единицу валюты операции)
 *     gelRateSrc   — "gel" (операция в лари) | "fact" (курс вашей конвертации) | "nbg" (курс НБГ)
 *     gelRateDate  — дата курса
 *     gelFactOpId  — id конвертации, курс которой взят (для "fact")
 *     amountToGel  — только для переводов: зачисленная сумма в лари по НБГ;
 *                    amountGel − amountToGel = потеря на переводе/конвертации
 *   Доходы и расходы: курс последней вашей конвертации этой валюты в лари
 *   (не старше 30 дней), иначе курс НБГ на дату операции. Переводы — всегда НБГ.
 *   USDT/USDC считаются как USD.
 */

const ALLOW_METHODS = "GET,POST,OPTIONS";
const ALLOW_HEADERS = "Content-Type, X-Auth-Token";

const COLLECTIONS = [
  "categories", "subcategories", "accounts", "operations",
  "limits", "goals", "stages", "quotes", "fx", "fxGel",
];

// ─── utils ────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

function genId(prefix = "") {
  const ts = Date.now();
  const rand = String(Math.floor(Math.random() * 100000)).padStart(5, "0");
  return prefix ? `${prefix}_${ts}_${rand}` : crypto.randomUUID();
}

// У курсов ЦБ нет id — ключ строим из даты и валюты
const itemId = (coll, x) => (coll === "fx" ? `${x.asOf}_${x.quote}` : String(x.id));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ─── CORS ─────────────────────────────────────────────────────────────

function corsHeaders(env, origin) {
  const allowed = list(env.ALLOWED_ORIGINS);
  let allowOrigin = "*";
  if (allowed.length) allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(status, obj, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

// ─── Tokens (формат совместим со старой функцией) ─────────────────────

const enc = new TextEncoder();

function b64urlBytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
const b64urlStr = (s) => b64urlBytes(enc.encode(s));

function b64urlDecodeStr(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signToken(obj, secret) {
  const payload = b64urlStr(JSON.stringify(obj));
  return `${payload}.${b64urlBytes(await hmac(secret, payload))}`;
}

async function verifyToken(token, secret) {
  try {
    if (!token) return { ok: false, error: "no token" };
    const [payload, sig] = String(token).split(".");
    if (!payload || !sig) return { ok: false, error: "bad token format" };
    const expected = b64urlBytes(await hmac(secret, payload));
    if (!safeEqual(sig, expected)) return { ok: false, error: "bad signature" };
    const obj = JSON.parse(b64urlDecodeStr(payload));
    if (obj.exp && Date.now() > obj.exp) return { ok: false, error: "expired" };
    return { ok: true, data: obj };
  } catch {
    return { ok: false, error: "token verify error" };
  }
}

// ─── D1 helpers ───────────────────────────────────────────────────────

async function readColl(db, coll) {
  const { results } = await db
    .prepare("SELECT json FROM items WHERE coll = ? ORDER BY rowid")
    .bind(coll).all();
  return results.map((r) => JSON.parse(r.json));
}

async function getItem(db, coll, id) {
  const row = await db
    .prepare("SELECT json FROM items WHERE coll = ? AND id = ?")
    .bind(coll, String(id)).first();
  return row ? JSON.parse(row.json) : null;
}

const putStmt = (db, coll, id, obj) => db
  .prepare(
    "INSERT INTO items (coll, id, json) VALUES (?, ?, ?) " +
    "ON CONFLICT(coll, id) DO UPDATE SET json = excluded.json"
  )
  .bind(coll, String(id), JSON.stringify(obj));

async function putItem(db, coll, id, obj) {
  await putStmt(db, coll, id, obj).run();
}

/** Upsert как в старой функции: merge существующей записи или вставка новой. */
async function upsert(db, coll, data, idPrefix = "") {
  const now = nowIso();
  let id = String(data.id || "").trim();
  const existing = id ? await getItem(db, coll, id) : null;
  if (existing) {
    await putItem(db, coll, id, { ...existing, ...data, id, updatedAt: now });
  } else {
    if (!id) id = genId(idPrefix);
    await putItem(db, coll, id, { ...data, id, createdAt: now, updatedAt: now });
  }
  return { id };
}

async function del(db, coll, id) {
  const res = await db
    .prepare("DELETE FROM items WHERE coll = ? AND id = ?")
    .bind(coll, String(id)).run();
  if (!res.meta || !res.meta.changes) throw new HttpError(404, `Not found: ${id}`);
  return { id };
}

// ─── Курсы НБГ и пересчёт в лари ─────────────────────────────────────

const NBG_URL = "https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/";
const NBG_CODES = ["USD", "EUR", "RUB", "CNY", "GBP", "TRY", "AMD", "KZT", "AED", "CHF", "UAH", "AZN"];
const FACT_WINDOW_DAYS = 30;   // сколько дней действует курс вашей конвертации
const FACT_MAX_DEVIATION = 0.15; // факт. курс, отличающийся от НБГ сильнее, считаем ошибкой ввода
const NBG_FALLBACK_DAYS = 10;  // если на дату курса нет — ближайший в пределах N дней
const SYNC_BATCH = 25;         // дат за один вызов (лимит подзапросов бесплатного Worker — 50)
const GEL_KEYS = ["amountGel", "gelRate", "gelRateSrc", "gelRateDate", "gelFactOpId", "amountToGel"];

const rateCur = (c) => {
  const x = String(c || "").trim().toUpperCase();
  return x === "USDT" || x === "USDC" ? "USD" : x;
};
const round2 = (x) => Math.round(x * 100) / 100;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const opDate = (o) => String(o.date || o.createdAt || "").slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const tbilisiToday = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

async function fetchNbg(env, date) {
  const base = env.NBG_URL || NBG_URL;
  const r = await fetch(`${base}?date=${date}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`NBG ${date}: HTTP ${r.status}`);
  const arr = await r.json();
  const list = (Array.isArray(arr) && arr[0] && Array.isArray(arr[0].currencies)) ? arr[0].currencies : [];
  const rates = {};
  let validFrom = null;
  for (const c of list) {
    const q = Number(c.quantity), v = Number(c.rate);
    if (!NBG_CODES.includes(c.code) || !(q > 0) || !(v > 0)) continue;
    rates[c.code] = Number((v / q).toFixed(8));
    if (!validFrom && c.validFromDate) validFrom = String(c.validFromDate).slice(0, 10);
  }
  return { id: date, date, validFrom, rates, source: "NBG", fetchedAt: nowIso() };
}

/** Поиск курса НБГ: точная дата → ближайшая раньше → ближайшая позже (в пределах NBG_FALLBACK_DAYS). */
function makeNbgLookup(fxGel) {
  const rows = fxGel.filter((r) => r && r.date && r.rates && Object.keys(r.rates).length)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return (cur, date) => {
    const c = rateCur(cur);
    if (c === "GEL") return { rate: 1, date };
    const has = (r) => Number(r.rates[c]) > 0;
    let lo = 0, hi = rows.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].date <= date) { idx = m; lo = m + 1; } else hi = m - 1; }
    const minD = addDays(date, -NBG_FALLBACK_DAYS), maxD = addDays(date, NBG_FALLBACK_DAYS);
    for (let i = idx; i >= 0 && rows[i].date >= minD; i--) if (has(rows[i])) return { rate: rows[i].rates[c], date: rows[i].date };
    for (let i = idx + 1; i < rows.length && rows[i].date <= maxD; i++) if (has(rows[i])) return { rate: rows[i].rates[c], date: rows[i].date };
    return null;
  };
}

/** Ваши конвертации валюта↔лари: из них берётся фактический курс. */
function makeFactLookup(ops, accCur) {
  const facts = {};
  for (const o of ops) {
    if (o.type !== "transfer") continue;
    const fromC = rateCur(o.currency || accCur.get(o.fromAccountId || o.accountId));
    const toC = rateCur(accCur.get(o.toAccountId));
    const a = Number(o.amount), b = Number(o.amountTo);
    if (!(a > 0) || !(b > 0) || !fromC || !toC || fromC === toC) continue;
    if (toC === "GEL") (facts[fromC] ||= []).push({ date: opDate(o), rate: b / a, id: o.id });
    else if (fromC === "GEL") (facts[toC] ||= []).push({ date: opDate(o), rate: a / b, id: o.id });
  }
  for (const k in facts) facts[k].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return (cur, date) => {
    const list = facts[rateCur(cur)];
    if (!list) return null;
    const minD = addDays(date, -FACT_WINDOW_DAYS);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].date > date) continue;
      return list[i].date >= minD ? list[i] : null;
    }
    return null;
  };
}

function gelFieldsFor(op, ctx) {
  const out = Object.fromEntries(GEL_KEYS.map((k) => [k, null]));
  const date = opDate(op);
  const cur = rateCur(op.currency || ctx.accCur.get(op.accountId || op.fromAccountId) || "RUB");
  const amt = Number(op.amount);
  if (!date || !Number.isFinite(amt)) return out;

  if (op.type === "transfer") {
    const r1 = ctx.nbg(cur, date);
    if (r1) Object.assign(out, { amountGel: round2(amt * r1.rate), gelRate: round6(r1.rate),
      gelRateSrc: cur === "GEL" ? "gel" : "nbg", gelRateDate: r1.date });
    const toC = rateCur(ctx.accCur.get(op.toAccountId) || cur);
    const amtTo = Number(op.amountTo ?? op.amount);
    const r2 = ctx.nbg(toC, date);
    if (r2 && Number.isFinite(amtTo)) out.amountToGel = round2(amtTo * r2.rate);
    return out;
  }

  if (cur === "GEL") return Object.assign(out, { amountGel: round2(amt), gelRate: 1, gelRateSrc: "gel", gelRateDate: date });

  const nb = ctx.nbg(cur, date);
  const f = ctx.fact(cur, date);
  if (f && (!nb || Math.abs(f.rate / nb.rate - 1) <= FACT_MAX_DEVIATION)) {
    return Object.assign(out, { amountGel: round2(amt * f.rate), gelRate: round6(f.rate),
      gelRateSrc: "fact", gelRateDate: f.date, gelFactOpId: f.id });
  }
  if (nb) Object.assign(out, { amountGel: round2(amt * nb.rate), gelRate: round6(nb.rate),
    gelRateSrc: "nbg", gelRateDate: nb.date });
  return out;
}

async function loadGelData(db) {
  const { results } = await db
    .prepare("SELECT coll, json FROM items WHERE coll IN ('operations','accounts','fxGel') ORDER BY rowid").all();
  const d = { operations: [], accounts: [], fxGel: [] };
  for (const r of results) d[r.coll].push(JSON.parse(r.json));
  return d;
}

/** Пересчитывает поля в лари у всех операций и записывает только изменившиеся. */
async function recalcGel(db, d) {
  const accCur = new Map(d.accounts.map((a) => [a.id, a.currency || "RUB"]));
  const ctx = { accCur, nbg: makeNbgLookup(d.fxGel), fact: makeFactLookup(d.operations, accCur) };
  const patches = [];
  for (const op of d.operations) {
    const f = gelFieldsFor(op, ctx);
    if (GEL_KEYS.some((k) => (op[k] ?? null) !== f[k])) {
      patches.push({ id: op.id, patch: f });
      for (const k of GEL_KEYS) { if (f[k] === null) delete op[k]; else op[k] = f[k]; }
    }
  }
  // Одним-двумя SQL-запросами: json_patch дописывает поля, null удаляет ключ
  const stmts = [];
  for (let i = 0; i < patches.length; i += 300) {
    const chunk = JSON.stringify(patches.slice(i, i + 300));
    stmts.push(db.prepare(
      "UPDATE items SET json = json_patch(json, (SELECT json_extract(p.value, '$.patch') FROM json_each(?1) p " +
      "WHERE json_extract(p.value, '$.id') = items.id)) " +
      "WHERE coll = 'operations' AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))"
    ).bind(chunk));
  }
  if (stmts.length) await db.batch(stmts);
  return patches.length;
}

async function saveFxGel(db, rows) {
  if (!rows.length) return;
  await db.prepare(
    "INSERT INTO items (coll, id, json) SELECT 'fxGel', json_extract(value, '$.id'), value FROM json_each(?1) WHERE true " +
    "ON CONFLICT(coll, id) DO UPDATE SET json = excluded.json"
  ).bind(JSON.stringify(rows)).run();
}

/** Догружает недостающие курсы НБГ (даты операций + сегодня), затем пересчитывает операции. */
async function syncGel(env, { dates = null, limit = SYNC_BATCH } = {}) {
  const db = env.DB;
  const d = await loadGelData(db);
  const have = new Set(d.fxGel.map((r) => r.date));
  const today = tbilisiToday();
  const need = new Set(dates || d.operations.map(opDate));
  if (!dates) need.add(today);
  const missing = [...need].filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x) && x <= today && !have.has(x)).sort().reverse();
  const batch = missing.slice(0, limit);
  const res = await Promise.allSettled(batch.map((x) => fetchNbg(env, x)));
  const rows = [], errors = [];
  res.forEach((r, i) => {
    if (r.status === "rejected") { errors.push(String(r.reason?.message || r.reason)); return; }
    // пустой ответ за свежую дату не сохраняем — курс могут ещё не опубликовать
    if (!Object.keys(r.value.rates).length && batch[i] >= addDays(today, -1)) return;
    rows.push(r.value);
  });
  await saveFxGel(db, rows);
  d.fxGel.push(...rows);
  const updatedOps = await recalcGel(db, d);
  return { fetched: rows.length, failed: errors.length, remaining: missing.length - rows.length,
    updatedOps, errors: errors.slice(0, 3) };
}

/** После изменения операций: курс на дату (если ещё нет) + пересчёт. Ошибки НБГ не мешают сохранению. */
async function afterOpsChange(env, date) {
  try { await syncGel(env, { dates: date ? [date] : [], limit: 1 }); }
  catch (e) { console.log("gel recalc failed:", e?.message || e); }
}

// ─── Bootstrap ────────────────────────────────────────────────────────

async function buildBootstrap(db) {
  const { results } = await db
    .prepare("SELECT coll, json FROM items ORDER BY rowid").all();
  const data = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
  for (const r of results) if (data[r.coll]) data[r.coll].push(JSON.parse(r.json));

  // Баланс по валютам — так же, как считала старая функция
  const balanceByCurrency = {};
  for (const acc of data.accounts) {
    const cur = acc.currency || "RUB";
    if (!balanceByCurrency[cur]) balanceByCurrency[cur] = 0;
  }
  const accCur = new Map(data.accounts.map((a) => [a.id, a.currency || "RUB"]));
  for (const op of data.operations) {
    const cur = op.currency || "RUB";
    if (!balanceByCurrency[cur]) balanceByCurrency[cur] = 0;
    if (op.type === "income") balanceByCurrency[cur] += op.amount || 0;
    if (op.type === "expense") balanceByCurrency[cur] -= op.amount || 0;
    if (op.type === "transfer") {
      const toCur = accCur.get(op.toAccountId) || "RUB";
      balanceByCurrency[cur] = (balanceByCurrency[cur] || 0) - (op.amount || 0);
      balanceByCurrency[toCur] = (balanceByCurrency[toCur] || 0) + (op.amountTo || op.amount || 0);
    }
  }
  return { ok: true, data: { ...data, balanceByCurrency } };
}

// ─── Actions ──────────────────────────────────────────────────────────

const require_ = (cond, msg) => { if (!cond) throw new HttpError(500, msg); };

async function crud(db, coll, action, data, prefix, validate) {
  if (action.startsWith("upsert")) {
    validate && validate(data);
    const out = await upsert(db, coll, data, prefix);
    return { ok: true, data: { updated: out, [coll]: await readColl(db, coll) } };
  }
  require_(data.id, "Missing id");
  const out = await del(db, coll, data.id);
  return { ok: true, data: { deleted: out, [coll]: await readColl(db, coll) } };
}

async function handleAction(action, data, env) {
  const db = env.DB;
  switch (action) {
    // — Operations —
    case "addOperation": {
      const now = nowIso();
      // Читаемый id вида op_YYYYMMDD_NNN (как в старой функции)
      const dateKey = (data.date || now.slice(0, 10)).replace(/-/g, "");
      const prefix = `op_${dateKey}_`;
      const { results } = await db
        .prepare("SELECT id FROM items WHERE coll = 'operations' AND id LIKE ?")
        .bind(prefix + "%").all();
      let maxSeq = 0;
      for (const { id } of results) {
        if (id.includes("_tmp_")) continue;
        const seq = parseInt(id.split("_")[2] || "0", 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
      const id = `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
      await putItem(db, "operations", id, { ...data, id, createdAt: now });
      await afterOpsChange(env, opDate(data) || now.slice(0, 10));
      return { ok: true, data: { created: { id }, operations: await readColl(db, "operations") } };
    }

    case "updateOperation": {
      require_(data.id, "Missing id");
      const existing = await getItem(db, "operations", data.id);
      if (!existing) throw new HttpError(500, `Operation not found: ${data.id}`);
      await putItem(db, "operations", data.id, { ...existing, ...data, updatedAt: nowIso() });
      await afterOpsChange(env, opDate({ ...existing, ...data }));
      return { ok: true, data: { updated: { id: data.id }, operations: await readColl(db, "operations") } };
    }

    case "deleteOperation": {
      require_(data.id, "Missing id");
      const out = await del(db, "operations", data.id);
      await afterOpsChange(env, null);
      return { ok: true, data: { deleted: out, operations: await readColl(db, "operations") } };
    }

    // — Справочники —
    case "upsertCategory":
    case "deleteCategory":
      return crud(db, "categories", action, data, "cat",
        (d) => require_(d.name, "Category name is required"));

    case "upsertSubcategory":
    case "deleteSubcategory":
      return crud(db, "subcategories", action, data, "subcat", (d) => {
        require_(d.name, "Subcategory name is required");
        require_(d.categoryId, "categoryId is required");
      });

    case "upsertAccount":
    case "deleteAccount":
      return crud(db, "accounts", action, data, "acc",
        (d) => require_(d.name, "Account name is required"));

    case "upsertLimit": {
      require_(data.categoryId, "categoryId is required");
      require_(data.month, "month is required");
      // Один лимит на (categoryId + month)
      let id = String(data.id || "").trim();
      if (!id) {
        const same = (await readColl(db, "limits")).find(
          (x) => String(x.categoryId) === String(data.categoryId) && String(x.month) === String(data.month)
        );
        if (same) id = same.id;
      }
      const out = await upsert(db, "limits", { ...data, id }, "lim");
      return { ok: true, data: { updated: out, limits: await readColl(db, "limits") } };
    }
    case "deleteLimit":
      return crud(db, "limits", action, data, "lim");

    case "upsertGoal":
    case "deleteGoal":
      return crud(db, "goals", action, data, "goal", (d) => {
        require_(d.name, "Goal name is required");
        require_(d.target, "Goal target is required");
      });

    case "upsertStage":
    case "deleteStage":
      return crud(db, "stages", action, data, "stage", (d) => {
        require_(d.name, "Stage name is required");
        require_(d.amount, "Stage amount is required");
      });

    case "upsertQuote":
    case "deleteQuote":
      return crud(db, "quotes", action, data, "q",
        (d) => require_(d.text, "Quote text is required"));

    // — Курсы НБГ и пересчёт в лари —
    case "fxGelSync": {
      const r = await syncGel(env);
      return { ok: true, data: { ...r, fxGel: await readColl(db, "fxGel"), operations: await readColl(db, "operations") } };
    }

    // — Курсы ЦБ РФ —
    case "fxUpdateToday": {
      const t = new Date();
      const dd = String(t.getUTCDate()).padStart(2, "0");
      const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
      const yyyy = t.getUTCFullYear();
      const asOf = `${yyyy}-${mm}-${dd}`;
      const cbrUrl = `https://www.cbr.ru/scripts/XML_daily.asp?date_req=${encodeURIComponent(`${dd}/${mm}/${yyyy}`)}`;
      const resp = await fetch(cbrUrl);
      if (!resp.ok) throw new HttpError(500, `CBR fetch failed: ${resp.status}`);
      const xml = await resp.text();
      const parsed = [];
      for (const code of ["USD", "EUR", "CNY"]) {
        const m = xml.match(new RegExp(`<CharCode>${code}</CharCode>[^]*?<Nominal>(\\d+)</Nominal>[^]*?<Value>([\\d,\\.]+)</Value>`));
        if (!m) continue;
        parsed.push({ asOf, base: "RUB", quote: code, nominal: Number(m[1]),
          official: Number(m[2].replace(",", ".")), spreadPct: null, buy: null, sell: null,
          source: `CBR: ${cbrUrl}` });
      }
      parsed.push({ asOf, base: "RUB", quote: "RUB", nominal: 1, official: 1,
        spreadPct: null, buy: null, sell: null, source: "self" });
      await db.batch([
        db.prepare("DELETE FROM items WHERE coll = 'fx' AND id LIKE ?").bind(`${asOf}_%`),
        ...parsed.map((x) => putStmt(db, "fx", itemId("fx", x), x)),
      ]);
      return { ok: true, data: { fxRates: await readColl(db, "fx") } };
    }

    default:
      throw new HttpError(400, `Unknown action: ${action}`);
  }
}

// ─── Feedback form proxy (замена третьей Yandex-функции) ──────────────

async function proxyFeedback(request, env, cors) {
  if (!env.GAS_FEEDBACK_URL) return json(500, { ok: false, error: "GAS_FEEDBACK_URL missing" }, cors);
  const r = await fetch(env.GAS_FEEDBACK_URL, {
    method: "POST",
    headers: { "Content-Type": request.headers.get("content-type") || "application/octet-stream" },
    body: await request.arrayBuffer(),
  });
  return new Response(await r.text(), {
    status: 200,
    headers: { ...cors, "Content-Type": r.headers.get("content-type") || "text/plain; charset=utf-8" },
  });
}

// ─── Entry point ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const origin = request.headers.get("origin") || "";
    const referer = request.headers.get("referer") || "";
    const cors = corsHeaders(env, origin);
    const ok = (obj) => json(200, obj, cors);
    const err = (code, msg) => json(code, { ok: false, error: msg }, cors);

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/feedback") {
      if (method !== "POST") return err(405, "Method not allowed");
      try { return await proxyFeedback(request, env, cors); }
      catch (e) { return err(502, String(e?.message || e)); }
    }

    if (!env.TOKEN_SECRET) return err(500, "Misconfigured: TOKEN_SECRET missing");
    if (!env.DB) return err(500, "Misconfigured: D1 binding DB missing");

    const prefixes = list(env.ALLOWED_REFERER_PREFIXES);
    if (prefixes.length && !prefixes.some((p) => referer.startsWith(p)))
      return err(403, "Forbidden (referer)");

    let action = "";
    let payload = {};
    try {
      if (method === "GET") action = String(url.searchParams.get("action") || "");
      else if (method === "POST") {
        const text = await request.text();
        payload = text.trim() ? JSON.parse(text) : {};
        action = String(payload?.action || "");
      } else return err(405, `Method not allowed: ${method}`);
    } catch (e) {
      return err(400, `Invalid JSON: ${e.message}`);
    }

    const ttlHours = Number(env.AUTH_TTL_HOURS || 12);
    const token = (request.headers.get("x-auth-token") || "").trim();

    // — Вход —
    if (action === "auth_login") {
      const d = payload?.data || payload || {};
      const mode = String(d.mode || "");
      const okPass = mode === "password" && env.AUTH_LOGIN && env.AUTH_PASSWORD
        && String(d.login || "") === env.AUTH_LOGIN && String(d.password || "") === env.AUTH_PASSWORD;
      const pin = String(d.pin || "");
      const okPin = mode === "pin" && /^\d{6}$/.test(pin) && env.AUTH_PIN && pin === env.AUTH_PIN;
      if (!okPass && !okPin) return err(401, "invalid credentials");
      const t = await signToken(
        { sub: okPin ? "pin" : "password", iat: Date.now(), exp: Date.now() + ttlHours * 3_600_000 },
        env.TOKEN_SECRET
      );
      return ok({ ok: true, token: t, ttl_hours: ttlHours });
    }

    if (action === "auth_check") {
      const v = await verifyToken(token, env.TOKEN_SECRET);
      return v.ok ? ok({ ok: true }) : err(401, v.error);
    }

    // — Всё остальное только с токеном —
    if (!(await verifyToken(token, env.TOKEN_SECRET)).ok) return err(401, "unauthorized");

    if (method === "GET" && action === "bootstrap") {
      try { return ok(await buildBootstrap(env.DB)); }
      catch (e) { return err(502, `Bootstrap error: ${e.message}`); }
    }

    if (method === "POST") {
      try { return ok(await handleAction(action, payload?.data || {}, env)); }
      catch (e) { return err(e instanceof HttpError ? e.status : 500, e.message); }
    }

    return err(405, `Method not allowed: ${method}`);
  },

  // Ежедневно (см. [triggers] в wrangler.toml): курс НБГ на сегодня + догрузка пропущенных дат
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncGel(env).then((r) => console.log("fxGel cron:", JSON.stringify(r))));
  },
};
