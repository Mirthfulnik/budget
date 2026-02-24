/**
 * ============================
 *  CONFIG
 * ============================
 * 1) Разверни Google Apps Script как Web App (/exec)
 * 2) Вставь URL сюда
 * 3) (опционально) включи API_KEY если ты его проверяешь в GAS
 *
 * ОЖИДАЕМЫЙ BOOTSTRAP:
 * GET  ?action=bootstrap&key=...
 * -> { ok:true, data:{ categories, accounts, limits, operations, goals, stages, quotes } }
 *
 * ОЖИДАЕМЫЕ ACTIONS (POST JSON):
 * { key, action:"addOperation"|"deleteOperation"|... , data:{...} }
 */
const API_URL = "https://functions.yandexcloud.net/d4erf4fjsbkvu1mr27il";
const RECEIPT_OCR_URL = "https://functions.yandexcloud.net/d4ecuv3nah5abpbc5qnj";
const API_KEY = ""; // если используешь ключ в GAS — вставь сюда



/**
 * ============================
 *  AUTH (Yandex Function)
 * ============================
 * - Secrets are stored in Yandex Function ENV (AUTH_LOGIN/AUTH_PASSWORD/AUTH_PIN/TOKEN_SECRET)
 * - Frontend stores only a short-lived token in localStorage
 */
const AUTH_TOKEN_KEY = "finance2026_token";

/**
 * ============================
 *  BOOTSTRAP CACHE (localStorage)
 * ============================
 * Стратегия: stale-while-revalidate
 *  1. При открытии страницы — мгновенно рендерим данные из кеша (если есть и не старше CACHE_MAX_AGE_MS)
 *  2. В фоне всегда запускаем запрос к API
 *  3. Когда API ответил — обновляем кеш и тихо перерисовываем интерфейс
 *
 * Таким образом пользователь видит данные немедленно, а не ждёт сети.
 */
const BOOTSTRAP_CACHE_KEY = "finance2026_bootstrap_v1";
const CACHE_MAX_AGE_MS    = 5 * 60 * 1000; // 5 минут — максимальный возраст "мгновенных" данных
const CACHE_BG_INTERVAL_MS = 60 * 1000;    // фоновое обновление раз в минуту (если вкладка открыта)

function cacheBootstrapSave(data) {
  try {
    localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify({
      data,
      savedAt: Date.now(),
    }));
  } catch (e) {}
}

function cacheBootstrapLoad() {
  try {
    const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    if (!raw) return null;
    const { data, savedAt } = JSON.parse(raw);
    const age = Date.now() - (savedAt || 0);
    if (age > CACHE_MAX_AGE_MS) return null; // устарело — не отдаём как «мгновенные»
    return { data, age };
  } catch (e) { return null; }
}

function cacheBootstrapLoadStale() {
  // Читает кеш без проверки возраста — для отображения пока идёт фоновый запрос
  try {
    const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    if (!raw) return null;
    const { data, savedAt } = JSON.parse(raw);
    return { data, age: Date.now() - (savedAt || 0) };
  } catch (e) { return null; }
}

function cacheBootstrapInvalidate() {
  try { localStorage.removeItem(BOOTSTRAP_CACHE_KEY); } catch (e) {}
}

const authGetToken_ = ()=> {
  try { return localStorage.getItem(AUTH_TOKEN_KEY) || ""; } catch(e){ return ""; }
};
const authSetToken_ = (t)=> {
  try { localStorage.setItem(AUTH_TOKEN_KEY, t || ""); } catch(e){}
};
const authClearToken_ = ()=> {
  try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch(e){}
};

const isMobileAuthMode_ = ()=> {
  // phone-like UX: small screens
  return !!(window.matchMedia && window.matchMedia("(max-width: 560px)").matches);
};

const authHeaders_ = ()=> {
  const t = authGetToken_();
  return t ? { "X-Auth-Token": t } : {};
};

const authShow_ = ()=> {
  const o = document.getElementById("authOverlay");
  if (!o) return;
  o.classList.add("show");
  document.documentElement.classList.add("auth-locked");
  document.body.classList.add("auth-locked");

  // switch mode
  const isMob = isMobileAuthMode_();
  o.querySelectorAll("[data-auth-mode]").forEach(el=>{
    el.style.display = (el.getAttribute("data-auth-mode") === (isMob ? "pin" : "password")) ? "" : "none";
  });

  if (isMob){
    authPinReset_();
  } else {
    const login = document.getElementById("authLogin");
    if (login) login.focus();
  }
};

const authHide_ = ()=> {
  const o = document.getElementById("authOverlay");
  if (!o) return;
  o.classList.remove("show");
  document.documentElement.classList.remove("auth-locked");
  document.body.classList.remove("auth-locked");
};

async function authPostNoAuth_(action, data){
  const payload = { action, data };
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type":"text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=>({ ok:false, error:"Invalid JSON" }));
  if (!r.ok || j.ok===false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

async function authCheck_(){
  const t = authGetToken_();
  if (!t) return false;
  try{
    const payload = { action: "auth_check", data: {} };
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type":"text/plain;charset=utf-8", ...authHeaders_() },
      body: JSON.stringify(payload)
    });
    if (r.status === 401) return false;
    const j = await r.json().catch(()=>({ ok:false }));
    return !!(r.ok && j.ok);
  }catch(e){
    return false;
  }
}

async function authGate_(){
  const ok = await authCheck_();
  if (ok) { authHide_(); return true; }
  authClearToken_();
  authShow_();
  return false;
}

// --- PIN UI ---
let __pinValue = "";
function authPinReset_(){
  __pinValue = "";
  const dots = document.querySelectorAll("#authPinDots span");
  dots.forEach((d)=> d.classList.remove("on"));
  const err = document.getElementById("authError");
  if (err) err.textContent = "";
}
function authPinPush_(digit){
  if (!/^[0-9]$/.test(String(digit))) return;
  if (__pinValue.length >= 6) return;
  __pinValue += String(digit);
  const dots = document.querySelectorAll("#authPinDots span");
  if (dots[__pinValue.length-1]) dots[__pinValue.length-1].classList.add("on");
  if (__pinValue.length === 6){
    authDoLoginPin_().catch(()=>{});
  }
}
function authPinBack_(){
  if (!__pinValue.length) return;
  const dots = document.querySelectorAll("#authPinDots span");
  if (dots[__pinValue.length-1]) dots[__pinValue.length-1].classList.remove("on");
  __pinValue = __pinValue.slice(0, -1);
}
async function authDoLoginPin_(){
  const err = document.getElementById("authError");
  if (err) err.textContent = "";
  try{
    const j = await authPostNoAuth_("auth_login", { mode:"pin", pin: __pinValue });
    if (!j.token) throw new Error("No token");
    authSetToken_(j.token);
    authHide_();
    // reload bootstrap after login — кеш сбрасывается внутри syncAll("afterLogin")
    try { await syncAll("afterLogin"); startBgSync(); } catch(e){}
    return true;
  }catch(e){
    if (err) err.textContent = "Неверный PIN";
    authClearToken_();
    authPinReset_();
    return false;
  }
}

// --- Password UI ---
async function authDoLoginPassword_(){
  const err = document.getElementById("authError");
  if (err) err.textContent = "";
  const login = (document.getElementById("authLogin")?.value || "").trim();
  const pass = (document.getElementById("authPassword")?.value || "").trim();
  if (!login || !pass){
    if (err) err.textContent = "Введите логин и пароль";
    return false;
  }
  try{
    const j = await authPostNoAuth_("auth_login", { mode:"password", login, password: pass });
    if (!j.token) throw new Error("No token");
    authSetToken_(j.token);
    authHide_();
    try { await syncAll("afterLogin"); startBgSync(); } catch(e){}
    return true;
  }catch(e){
    if (err) err.textContent = "Неверный логин или пароль";
    authClearToken_();
    return false;
  }
}

// Attach auth UI listeners once DOM is ready
document.addEventListener("click", (ev)=>{
  const t = ev.target;
  if (!t) return;
  const k = t.getAttribute?.("data-pin");
  if (k != null){
    if (k === "back") return authPinBack_();
    if (k === "clear") return authPinReset_();
    return authPinPush_(k);
  }
  if (t.id === "authBtnLogin") authDoLoginPassword_();
});

document.addEventListener("keydown", (ev)=>{
  const o = document.getElementById("authOverlay");
  if (!o || !o.classList.contains("show")) return;
  if (!isMobileAuthMode_()){
    if (ev.key === "Enter") authDoLoginPassword_();
    return;
  }
  if (/^[0-9]$/.test(ev.key)) authPinPush_(ev.key);
  if (ev.key === "Backspace") authPinBack_();
  if (ev.key === "Escape") authPinReset_();
});

/**
 * ============================
 *  CORE (must be defined BEFORE usage)
 * ============================
 */
const Core = (typeof window !== "undefined" && window.FinanceCore) ? window.FinanceCore : null;

/**
 * ============================
 *  STATE
 * ============================
 */
const state = {
  categories: [],     // {id,name,type} type: income|expense|transfer(optional)
  subcategories: [],  // {id,name,categoryId,type} type inherited from category (income|expense)
  accounts: [],       // {id,name}
  limits: [],         // {id, categoryId, month, amount} month: YYYY-MM
  operations: [],     // {id, createdAt, date, type, amount, categoryId, subcategoryId, accountId, comment}
  goals: [],          // {id, name, target, saved, deadline, accountId}
  stages: [],         // {id, name, amount} amount: monthly income threshold
  quotes: [],         // {id, text, author}
  balanceByCurrency: null, // optional from server
  period: { kind:"week", from:null, to:null },
  // Фильтры операций (единственный источник истины — не DOM)
  opsFilters: { type:"all", from:"", to:"", acc:"all" },
  ui: {
    dashSubcatCategoryId: "", // выбранная категория для графика подкатегорий
    barModel: null,
    pieExpenseModel: null,
    pieIncomeModel: null,
    chartsInited: false,
    barPickIdx: null,
    piePickKey: "",
    opFormOpen: false   // состояние toggle формы "Новая операция"
  },
  lastBootstrapAt: null
};

// Инициализируем фильтр операций: последние 7 дней включая сегодня
// Состояние сохраняется в localStorage между сессиями
(function initOpsFiltersDefault(){
  try {
    const saved = localStorage.getItem("finance2026_ops_filters");
    if (saved) {
      const parsed = JSON.parse(saved);
      // Базовая валидация
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        state.opsFilters = parsed;
        return;
      }
    }
  } catch(e) {}

  // Первый запуск — дефолт: последние 7 дней
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from  = new Date(today);
  from.setDate(from.getDate() - 6); // -6 дней + сегодня = 7 дней
  const pad = n => String(n).padStart(2, "0");
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  state.opsFilters = { type: "all", from: toISO(from), to: toISO(today), acc: "all" };
})();


/**
 * ============================
 *  UTIL
 * ============================
 */
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const ruMoney = (n, cur='RUB') => {
  const v = Number(n || 0);
  try{
    return new Intl.NumberFormat('ru-RU', { style:'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  }catch(e){
    const sym = cur==='USD'?'$':cur==='EUR'?'€':cur==='CNY'?'¥':'₽';
    return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + sym;
  }
};

const parseDateToMs_ = (v) => {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  const s = String(v).trim();
  if (!s) return NaN;

  // YYYY-MM-DD (or ISO with time)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m){
    const [_, yy, mm, dd] = m;
    return new Date(Number(yy), Number(mm)-1, Number(dd)).getTime();
  }

  // DD.MM.YYYY (common RU format)
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m){
    const [_, dd, mm, yy] = m;
    return new Date(Number(yy), Number(mm)-1, Number(dd)).getTime();
  }

  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
};

const opTimeMs_ = (o) => {
  const t = parseDateToMs_(o?.date || o?.createdAt || o?.updatedAt);
  return Number.isFinite(t) ? t : 0;
};


const isoDate = (d) => {
  const ms = parseDateToMs_(d);
  const x = new Date(Number.isFinite(ms) ? ms : Date.now());
  const yyyy = x.getFullYear();
  const mm = String(x.getMonth()+1).padStart(2,"0");
  const dd = String(x.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
};
// Normalizes many month representations to a stable key: "YYYY-MM".
// Why: in your current dataset, limits.month comes as "2025-12-31" for January 2026
// (typical timezone / month-marker issue). We treat "last day of month" as a marker
// for the *next* month.
const yyyymm = (d) => {
  if (!d) return "";
  if (typeof d === 'string'){
    const s = d.trim();
    if (/^\d{4}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m){
      const y = Number(m[1]);
      const mo = Number(m[2]); // 1..12
      const day = Number(m[3]);
      const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      let t = Date.UTC(y, mo-1, day);
      if (day === lastDay) t += 86400000; // +1 day => next month
      const dt = new Date(t);
      const yyyy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth()+1).padStart(2,"0");
      return `${yyyy}-${mm}`;
    }
  }
  const x = new Date(d);
  if (isNaN(x.getTime())) return "";
  const yyyy = x.getFullYear();
  const mm = String(x.getMonth()+1).padStart(2,"0");
  return `${yyyy}-${mm}`;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * ============================
 *  COLLAPSIBLE LISTS (UI)
 * ============================
 * Показываем первые 3 записи, остальные — по кнопке «Показать ещё / Свернуть»
 */
const COLLAPSE_LIMIT = 3;
const collapseState = {}; // key: containerId -> boolean (expanded)

function applyCollapsible(containerId, limit=COLLAPSE_LIMIT){
  const el = document.getElementById(containerId);
  if (!el) return;

  const expanded = !!collapseState[containerId];
  const items = Array.from(el.querySelectorAll('.item'));

  items.forEach((it, idx)=>{
    it.style.display = (!expanded && idx >= limit) ? 'none' : '';
  });

  // Special handling for operations: hide empty date blocks (header row + list)
  if (containerId === 'ops-view'){
    const rows = Array.from(el.querySelectorAll('.op-date-header-row'));
    rows.forEach(row=>{
      const list = row.nextElementSibling;
      if (!list || !list.classList.contains('list')) return;

      const anyVisible = Array.from(list.querySelectorAll('.item'))
        .some(it => it.style.display !== 'none');

      row.style.display  = anyVisible ? '' : 'none';
      list.style.display = anyVisible ? '' : 'none';
    });
  }

}

function ensureToggle(containerId, limit=COLLAPSE_LIMIT){
  const el = document.getElementById(containerId);
  if (!el) return;

  const itemsCount = el.querySelectorAll('.item').length;
  const btnId = 'toggle-' + containerId;
  let btn = document.getElementById(btnId);

  if (itemsCount <= limit){
    if (btn) btn.remove();
    collapseState[containerId] = false;
    return;
  }

  if (!btn){
    btn = document.createElement('button');
    btn.id = btnId;
    btn.className = 'btn secondary';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', ()=>{
      collapseState[containerId] = !collapseState[containerId];
      btn.textContent = collapseState[containerId] ? 'Свернуть' : 'Показать ещё';
      applyCollapsible(containerId, limit);
    });
    el.insertAdjacentElement('afterend', btn);
  }

  btn.textContent = collapseState[containerId] ? 'Свернуть' : 'Показать ещё';
  applyCollapsible(containerId, limit);
}

function today() {
  const d = new Date();
  d.setHours(0,0,0,0);
  return d;
}
function startOfWeek(d){
  const x = new Date(d);
  const day = (x.getDay()+6)%7; // Mon=0
  x.setDate(x.getDate()-day);
  x.setHours(0,0,0,0);
  return x;
}
function endOfWeek(d){
  const s = startOfWeek(d);
  const e = new Date(s);
  e.setDate(e.getDate()+6);
  e.setHours(23,59,59,999);
  return e;
}
function startOfMonth(d){
  const x = new Date(d);
  x.setDate(1); x.setHours(0,0,0,0);
  return x;
}
function endOfMonth(d){
  const s = startOfMonth(d);
  const e = new Date(s);
  e.setMonth(e.getMonth()+1);
  e.setDate(0);
  e.setHours(23,59,59,999);
  return e;
}
function startOfYear(d){
  const x = new Date(d);
  x.setMonth(0,1); x.setHours(0,0,0,0);
  return x;
}
function endOfYear(d){
  const s = startOfYear(d);
  const e = new Date(s);
  e.setFullYear(e.getFullYear()+1);
  e.setDate(0);
  e.setHours(23,59,59,999);
  return e;
}
function daysBetween(a,b){
  const ms = 24*3600*1000;
  const x = new Date(a); x.setHours(0,0,0,0);
  const y = new Date(b); y.setHours(0,0,0,0);
  return Math.round((y-x)/ms);
}
function sum(arr){ return arr.reduce((s,x)=>s+Number(x||0),0); }

function catById(id){ return state.categories.find(c=>String(c.id)===String(id)); }
function subcatById(id){ return state.subcategories.find(sc=>String(sc.id)===String(id)); }
function accCurrency(accId){
  const a = accById(accId);
  return (a && a.currency) ? a.currency : 'RUB';
}

function opCurrency(op){
  return op?.currency || accCurrency(op?.accountId || op?.fromAccountId || '');
}

function computeDayTotals_(opsInDay){
  const incomeByCur = {};
  const expenseByCur = {};
  const transferByCur = {};

  for (const o of opsInDay){
    const cur = opCurrency(o);
    const amt = Number(o.amount || 0);
    if (!Number.isFinite(amt)) continue;

    if (o.type === "income"){
      incomeByCur[cur] = (incomeByCur[cur] || 0) + amt;
    }else if (o.type === "expense"){
      expenseByCur[cur] = (expenseByCur[cur] || 0) + amt;
    }else if (o.type === "transfer"){
      transferByCur[cur] = (transferByCur[cur] || 0) + Math.abs(amt);
    }
  }

  const currencies = Array.from(new Set([
    ...Object.keys(incomeByCur),
    ...Object.keys(expenseByCur),
    ...Object.keys(transferByCur),
  ]));

  const balanceParts = [];
  const transferParts = [];

  for (const cur of currencies){
    const inc = Number(incomeByCur[cur] || 0);
    const exp = Number(expenseByCur[cur] || 0);
    const bal = inc - exp;
    if (bal !== 0){
      const sign = bal > 0 ? "+" : "−";
      balanceParts.push(`${sign}${ruMoney(Math.abs(bal), cur)}`);
    }else if ((inc !== 0) || (exp !== 0)){
      balanceParts.push(`0 ${cur}`);
    }

    const tr = Number(transferByCur[cur] || 0);
    if (tr){
      transferParts.push(`↔${ruMoney(tr, cur)}`);
    }
  }

  const balanceText = balanceParts.length ? balanceParts.join(" · ") : "0";
  const transferText = transferParts.length ? transferParts.join(" · ") : "";

  return { balanceText, transferText };
}





function accById(id){ return state.accounts.find(a=>String(a.id)===String(id)); }

function toast(title, body, type="info", autoHideMs=2500){
  const t = $("#toast");
  $("#toastTitle").textContent = title;
  $("#toastBody").textContent = body || "";
  t.classList.add("show");
  if (autoHideMs){
    window.clearTimeout(toast._tm);
    toast._tm = window.setTimeout(()=>t.classList.remove("show"), autoHideMs);
  }
}
$("#toastClose").addEventListener("click", ()=>$("#toast").classList.remove("show"));

function openModal(title, html){
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  $("#modalBack").classList.add("show");
}
function closeModal(){ $("#modalBack").classList.remove("show"); }
$("#modalClose").addEventListener("click", closeModal);
$("#modalBack").addEventListener("click", (e)=>{ if(e.target.id==="modalBack") closeModal(); });

/**
 * ============================
 *  HELP POPUP SYSTEM (П5)
 * ============================
 * Единый всплывающий попап для всех ❓ подсказок.
 * Позиционируется рядом с anchor-элементом, не выходит за viewport.
 */
let _helpPopupAnchor = null;

function showHelp(text, anchorEl){
  const popup = $("#help-popup");
  const textEl = $("#help-popup-text");
  if (!popup || !textEl) return;

  textEl.textContent = text;
  popup.style.display = "block";

  // Позиционирование: сначала рендерим чтобы знать размеры
  popup.style.left = "0px";
  popup.style.top  = "0px";

  requestAnimationFrame(()=>{
    const anchor = anchorEl.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    // Пробуем снизу anchor
    let top  = anchor.bottom + margin;
    let left = anchor.left;

    // Не уходим за правый край
    if (left + pw > vw - margin) left = vw - pw - margin;
    if (left < margin) left = margin;

    // Если снизу не влезает — показываем сверху
    if (top + ph > vh - margin) top = anchor.top - ph - margin;
    if (top < margin) top = margin;

    popup.style.left = `${Math.round(left)}px`;
    popup.style.top  = `${Math.round(top)}px`;
  });

  _helpPopupAnchor = anchorEl;
}

function hideHelp(){
  const popup = $("#help-popup");
  if (popup) popup.style.display = "none";
  _helpPopupAnchor = null;
}

// Закрытие по кнопке ✕
document.addEventListener("click", (e)=>{
  // Кнопка закрытия попапа
  if (e.target.id === "help-popup-close" || e.target.closest?.("#help-popup-close")){
    hideHelp();
    return;
  }

  // Клик по ❓ кнопке
  const helpBtn = e.target.closest?.(".help-btn");
  if (helpBtn){
    const text = helpBtn.getAttribute("data-help") || "";
    // Если уже открыт для этой же кнопки — закрываем (toggle)
    if (_helpPopupAnchor === helpBtn){
      hideHelp();
    } else {
      showHelp(text, helpBtn);
    }
    e.stopPropagation();
    return;
  }

  // Клик вне попапа — закрываем
  const popup = $("#help-popup");
  if (popup && popup.style.display !== "none" && !popup.contains(e.target)){
    hideHelp();
  }
}, true); // capture phase чтобы перехватить раньше других handlers

// Закрытие по Escape
document.addEventListener("keydown", (e)=>{
  if (e.key === "Escape") hideHelp();
});

async function apiGet(params){
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k,v])=> url.searchParams.set(k, v));
  if (API_KEY) url.searchParams.set("key", API_KEY);
  const r = await fetch(url.toString(), { method:"GET", headers: authHeaders_() });
  if (r.status === 401){ authClearToken_(); authShow_(); throw new Error("Unauthorized"); }
  const j = await r.json().catch(()=>({ok:false, error:"Invalid JSON"}));
  if (!r.ok || j.ok===false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
async function apiPost(action, data){
  const payload = { action, data };
  if (API_KEY) payload.key = API_KEY;
  const r = await fetch(API_URL, {
    method:"POST",
    headers: { "Content-Type":"text/plain;charset=utf-8", ...authHeaders_() }, // GAS-friendly + auth
    body: JSON.stringify(payload)
  });
  if (r.status === 401){ authClearToken_(); authShow_(); throw new Error("Unauthorized"); }
  const j = await r.json().catch(()=>({ok:false, error:"Invalid JSON"}));
  if (!r.ok || j.ok===false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/**
 * ============================
 *  NAV
 * ============================
 */
function showPage(name){
  $$(".page").forEach(p=>p.classList.remove("active"));
  $("#page-"+name).classList.add("active");
  $$(".btnNav").forEach(b=>b.classList.remove("active"));
  $(`.btnNav[data-page="${name}"]`)?.classList.add("active");

  // lazy rerender
  if (name==="dashboard") renderDashboard();
  if (name==="goals") renderGoals();
  if (name==="settings") renderSettings();
}
$$(".btnNav").forEach(btn=>{
  const p = btn.getAttribute("data-page");
  if (!p) return;
  btn.addEventListener("click", ()=>showPage(p));
});
$("#btn-sync").addEventListener("click", ()=>syncAll("manual"));

/**
 * ============================
 *  OP FORM TOGGLE (П2)
 * ============================
 */
function setOpFormOpen(open){
  const body = $("#op-form-body");
  const btn  = $("#btn-toggle-op-form");
  if (!body || !btn) return;

  state.ui.opFormOpen = open;
  body.style.display = open ? "" : "none";
  btn.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", String(open));
  btn.textContent = open ? "▾" : "▸";

  try { localStorage.setItem("finance2026_op_form_open", open ? "1" : "0"); } catch(e){}
}

// Восстанавливаем состояние из localStorage
(function restoreOpFormState(){
  try {
    const saved = localStorage.getItem("finance2026_op_form_open");
    // дефолт — закрыто (null), если явно открыто — открываем
    if (saved === "1") setOpFormOpen(true);
  } catch(e){}
})();

const _btnToggleOpForm = $("#btn-toggle-op-form");
if (_btnToggleOpForm){
  _btnToggleOpForm.addEventListener("click", ()=> setOpFormOpen(!state.ui.opFormOpen));
}

// При запуске OCR — автоматически раскрываем форму
function ensureOpFormOpen(){
  if (!state.ui.opFormOpen) setOpFormOpen(true);
}

/**
 * ============================
 *  OPS FILTER MODAL (П3)
 * ============================
 */
function opsFilterHasActive(){
  const f = state.opsFilters;
  return f.type !== "all" || f.from !== "" || f.to !== "" || f.acc !== "all";
}

function updateOpsFilterBtnState(){
  const btn = $("#btn-ops-filter");
  if (!btn) return;
  btn.classList.toggle("active", opsFilterHasActive());
}

function openOpsFilterModal(){
  const accsOptions = ['<option value="all">Все счета</option>']
    .concat(state.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`))
    .join("");

  const f = state.opsFilters;
  const html = `
    <div class="field">
      <label>Тип операции</label>
      <select id="mf-type">
        <option value="all"${f.type==="all"?" selected":""}>Все</option>
        <option value="expense"${f.type==="expense"?" selected":""}>Расходы</option>
        <option value="income"${f.type==="income"?" selected":""}>Доходы</option>
        <option value="transfer"${f.type==="transfer"?" selected":""}>Переводы</option>
      </select>
    </div>
    <div class="row">
      <div class="field">
        <label>Дата с</label>
        <input id="mf-from" type="date" value="${esc(f.from)}" />
      </div>
      <div class="field">
        <label>Дата по</label>
        <input id="mf-to" type="date" value="${esc(f.to)}" />
      </div>
    </div>
    <div class="field">
      <label>Счёт</label>
      <select id="mf-acc">${accsOptions}</select>
    </div>
    <div class="row modalActions" style="margin-top:8px">
      <button class="btn" id="mf-apply">Применить</button>
      <button class="btn secondary" id="mf-reset">Сброс</button>
    </div>
  `;

  openModal("🔍 Фильтры операций", html);

  // Восстанавливаем значение счёта
  const accSel = $("#mf-acc");
  if (accSel && [...accSel.options].some(o=>o.value===f.acc)) accSel.value = f.acc;

  $("#mf-apply").addEventListener("click", ()=>{
    state.opsFilters = {
      type: $("#mf-type")?.value || "all",
      from: $("#mf-from")?.value || "",
      to:   $("#mf-to")?.value   || "",
      acc:  $("#mf-acc")?.value  || "all"
    };
    closeModal();
    try { localStorage.setItem("finance2026_ops_filters", JSON.stringify(state.opsFilters)); } catch(e){}
    updateOpsFilterBtnState();
    renderOperations();
  }, {once:true});

  $("#mf-reset").addEventListener("click", ()=>{
    // Сброс = последние 7 дней включая сегодня
    const _now   = new Date();
    const _today = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
    const _from  = new Date(_today); _from.setDate(_from.getDate() - 6);
    const _pad   = n => String(n).padStart(2, "0");
    const _iso   = d => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}`;
    state.opsFilters = { type: "all", from: _iso(_from), to: _iso(_today), acc: "all" };
    closeModal();
    try { localStorage.setItem("finance2026_ops_filters", JSON.stringify(state.opsFilters)); } catch(e){}
    updateOpsFilterBtnState();
    renderOperations();
  }, {once:true});
}

const _btnOpsFilter = $("#btn-ops-filter");
if (_btnOpsFilter){
  _btnOpsFilter.addEventListener("click", openOpsFilterModal);
}

/**
 * ============================
 *  BOOTSTRAP / SYNC
 * ============================
 */

/**
 * Применяет данные bootstrap к state и перерисовывает интерфейс.
 * Используется и при загрузке из кеша, и при получении от API.
 */
function applyBootstrapData(d, { silent = false } = {}) {
  state.categories    = Array.isArray(d.categories)    ? d.categories    : [];
  state.subcategories = Array.isArray(d.subcategories) ? d.subcategories : [];
  state.accounts      = Array.isArray(d.accounts)      ? d.accounts      : defaultAccounts();
  state.fxRates       = Array.isArray(d.fxRates)       ? d.fxRates       : [];
  state.accounts = state.accounts.map(a => ({
    ...a,
    currency: a.currency || "RUB",
    kind:     a.kind || a.type || a.accountType || "",
  }));
  state.limits = Array.isArray(d.limits)
    ? d.limits.map(l => ({ ...l, month: yyyymm(l?.month || "") }))
    : [];
  state.operations = Array.isArray(d.operations) ? d.operations : [];
  state.goals      = Array.isArray(d.goals)      ? d.goals      : [];
  state.stages     = Array.isArray(d.stages)     ? d.stages     : defaultStages();
  state.quotes     = Array.isArray(d.quotes)     ? d.quotes     : defaultQuotes();
  state.lastBootstrapAt = new Date();

  normalizeState();
  if (!silent) renderAll();
}

/**
 * Основная функция синхронизации.
 *
 * reason:
 *   "init"      — первая загрузка страницы: сначала кеш (мгновенно), потом API (фоново)
 *   "manual"    — кнопка «Синхр.»: всегда идём в сеть, показываем тост
 *   "afterLogin"— после логина: сбрасываем кеш и загружаем свежее
 *   прочее      — после мутаций: сбрасываем кеш, идём в сеть
 */
async function syncAll(reason = "auto") {
  const isInit   = reason === "init";
  const isManual = reason === "manual";
  const isAfterLogin = reason === "afterLogin";

  // После логина и после мутаций — кеш уже не актуален
  if (isAfterLogin || (!isInit && !isManual)) {
    cacheBootstrapInvalidate();
  }

  // ── Шаг 1: мгновенный рендер из кеша (только при первой загрузке) ──
  if (isInit) {
    const stale = cacheBootstrapLoadStale();
    if (stale) {
      const ageMin = Math.round(stale.age / 60000);
      applyBootstrapData(stale.data, { silent: false });
      toast(
        "Данные из кеша",
        ageMin < 1 ? "Обновляю в фоне…" : `${ageMin} мин. назад · Обновляю…`,
        "info",
        2000
      );
    }
  } else if (!isInit) {
    // Для ручной и мутационных синхронизаций — показываем тост
    toast("Синхронизация", "Запрашиваю данные…", "info", 0);
  }

  // ── Шаг 2: запрос к API (всегда, но визуально "фоновый" при isInit с кешем) ──
  try {
    const j = await apiGet({ action: "bootstrap" });
    const d = j.data || {};

    // Сохраняем в localStorage-кеш
    cacheBootstrapSave(d);

    applyBootstrapData(d);

    if (!isInit) {
      toast("Синхронизация", "Готово ✅", "ok", 1800);
    } else {
      // При init тихо обновили — коротко сообщаем
      toast("Данные обновлены", "✅", "ok", 1200);
    }
  } catch (err) {
    const msg = String(err.message || err);
    if (isInit && cacheBootstrapLoadStale()) {
      // Данные из кеша уже показаны — не блокируем интерфейс
      toast("Нет связи", "Показаны кешированные данные", "warn", 3000);
    } else {
      toast("Ошибка синхронизации", msg, "error", 0);
    }
  }
}

// ── Фоновое обновление пока вкладка открыта ─────────────────────────
let _bgSyncTimer = null;
function startBgSync() {
  if (_bgSyncTimer) return; // уже запущен
  _bgSyncTimer = setInterval(async () => {
    // Только если вкладка видима и пользователь авторизован
    if (document.hidden) return;
    const token = authGetToken_();
    if (!token) return;
    try {
      const j = await apiGet({ action: "bootstrap" });
      const d = j.data || {};
      cacheBootstrapSave(d);
      applyBootstrapData(d, { silent: true }); // тихо, без тоста
    } catch { /* игнорируем сетевые ошибки в фоне */ }
  }, CACHE_BG_INTERVAL_MS);
}

function defaultAccounts(){
  return [
    {id:"main", name:"Заначка"},
    {id:"card", name:"Карта Сбер Золотая"},
    {id:"cash", name:"Наличные"}
  ];
}
function defaultStages(){
  return [
    {id:"st160", name:"❌ Выживание", amount:160000},
    {id:"st180", name:"⚠️ Не все цели", amount:180000},
    {id:"st200", name:"✔️ Почти все цели", amount:200000},
    {id:"st250", name:"✔️ Все цели", amount:250000},
    {id:"st300", name:"✔️ Резерв", amount:300000}
  ];
}

function defaultQuotes(){
  return [
    {id:"q1", text:"Дисциплина сегодня создаёт свободу завтра.", author:"Джеймс Клир"},
    {id:"q2", text:"Маленькие шаги ежедневно меняют жизнь.", author:"Питер Друкер"},
    {id:"q3", text:"Фокус определяет результат.", author:"Робин Шарма"},
    {id:"q4", text:"Прогресс важнее идеала.", author:"Наполеон Хилл"},
    {id:"q5", text:"Действие побеждает страх.", author:"Уоррен Баффет"}
  ];
}

function normalizeState(){
  // ensure ids exist
  state.categories.forEach((c,i)=>{ if(!c.id) c.id = "cat_"+i; if(!c.type) c.type="expense"; });
  state.subcategories.forEach((sc,i)=>{
    if(!sc.id) sc.id = "subcat_"+i;
    if(!sc.categoryId) sc.categoryId = sc.parentCategoryId || "";
    const parent = state.categories.find(c=>String(c.id)===String(sc.categoryId));
    if(!sc.type) sc.type = parent?.type || "expense";
  });

  state.accounts.forEach((a,i)=>{ if(!a.id) a.id = "acc_"+i; if(!a.name) a.name = "Счёт "+(i+1); });

  // П4: операции без id получают временный читаемый id на основе даты + timestamp
  // Серверные id (op_YYYYMMDD_NNN) сохраняются как есть
  state.operations.forEach((o,i)=>{
    if(!o.id){
      // Генерируем временный локальный id: op_YYYYMMDD_tmp_<timestamp+i>
      const dateStr = (o.date || "").replace(/-/g,"") || String(Date.now()).slice(0,8);
      o.id = `op_${dateStr}_tmp_${Date.now()}_${i}`;
    }
    if(!o.currency){
      o.currency = accCurrency(o.accountId);
    }
  });

  state.goals.forEach((g,i)=>{ if(!g.id) g.id = "g_"+i; });
  state.stages.forEach((s,i)=>{ if(!s.id) s.id = "st_"+i; });
  state.quotes.forEach((q,i)=>{ if(!q.id) q.id = "q_"+i; });

  // sort stages asc by amount
  state.stages.sort((a,b)=>Number(a.amount)-Number(b.amount));

  // fill today date
  const d = isoDate(today());
  $("#op-date").value = $("#op-date").value || d;

  // pill month
  $("#pill-month").textContent = (Core && Core.fmtMonthYear) ? Core.fmtMonthYear(new Date()) : new Date().toLocaleString("ru-RU", {month:"long", year:"numeric"});
}

/**
 * ============================
 *  RENDER: COMMON
 * ============================
 */

const LAST_OP_PREFS_KEY = "finance2026_last_op_prefs_v1";

function getLastOpPrefs_(){
  try { return JSON.parse(localStorage.getItem(LAST_OP_PREFS_KEY) || "null"); }
  catch(e){ return null; }
}

function saveLastOpPrefs_(){
  const prefs = {
    type: $("#op-type")?.value || "",
    categoryId: $("#op-category")?.value || "",
    subcategoryId: $("#op-subcategory")?.value || "",
    accountId: $("#op-account")?.value || "",
    currency: $("#op-currency")?.value || ""
  };
  localStorage.setItem(LAST_OP_PREFS_KEY, JSON.stringify(prefs));
}

function renderAll(){
  renderSelects();
  updateTransferRateVisibility_();
  renderPult();
  if ($("#page-dashboard").classList.contains("active")) renderDashboard();
  if ($("#page-goals").classList.contains("active")) renderGoals();
  if ($("#page-settings").classList.contains("active")) renderSettings();
}

function updateOpCurrencyBadge(){
  const accId = $('#op-account')?.value || '';
  const accCur = accCurrency(accId);
  const curSel = $('#op-currency');
  // по умолчанию подтягиваем валюту счёта, но пользователь может поменять вручную
  if (curSel && !curSel._userTouched){
    curSel.value = accCur;
  }
}

function getAccountById_(id){
  return (state.accounts || []).find(a => String(a.id) === String(id));
}

function updateTransferRateVisibility_(){
  const type = $("#op-type")?.value || "";
  const trRow = $("#op-transfer-row");
  if (!trRow) return;

  // если не перевод — ничего не делаем
  if (type !== "transfer") return;

  const fromId = $("#op-from-account")?.value || "";
  const toId   = $("#op-to-account")?.value || "";

  const fromAcc = getAccountById_(fromId);
  const toAcc   = getAccountById_(toId);

  const fromCur = (fromAcc?.currency || "RUB").toUpperCase();
  const toCur   = (toAcc?.currency || "RUB").toUpperCase();

  const fxField = $("#op-fx-rate")?.closest(".field");
  const amtToField = $("#op-amount-to")?.closest(".field");

  const needFx = fromCur !== toCur;

  // показываем/скрываем "Курс" и "Сумма зачисления"
  if (fxField) fxField.style.display = needFx ? "" : "none";
  if (amtToField) amtToField.style.display = needFx ? "" : "none";

  // если валюта одинаковая — курс=1, суммы равны
  if (!needFx){
    if ($("#op-fx-rate")) $("#op-fx-rate").value = "1";
    const a = Number($("#op-amount")?.value || 0);
    if ($("#op-amount-to")) $("#op-amount-to").value = a > 0 ? String(round2_(a)) : "";
    updateFxHint_();
    return;
  }

  // разные валюты — считаем в нужную сторону
  if (state.ui?.transferLastChanged === "to") recalcTransferFrom_();
  else recalcTransferTo_();

  updateFxHint_();

}

function renderSelects(){
  const prefs = getLastOpPrefs_();

  const type = $("#op-type")?.value || (prefs?.type || "expense");

  if ($("#op-type") && !$("#op-type").value) $("#op-type").value = type;

  // categories by type
  const cats = state.categories.filter(c => (c.type===type) || (type==="transfer" && c.type==="transfer"));
  const catSel = $("#op-category");
  catSel.innerHTML = cats.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")
    || `<option value="">— нет категорий —</option>`;

  if (prefs?.categoryId && cats.some(c=>String(c.id)===String(prefs.categoryId))){
    catSel.value = prefs.categoryId;
  }
  
  // accounts
  const accSel = $("#op-account");
  accSel.innerHTML = state.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.currency||'RUB')}</option>`).join("");
    if (prefs?.accountId) accSel.value = prefs.accountId;
  if (!accSel.value) accSel.value = state.accounts[0]?.id || "";
  updateOpCurrencyBadge();

  const fromSel = $("#op-from-account");
  const toSel = $("#op-to-account");
    if (fromSel && toSel){
  const opts = state.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.currency||'RUB')}</option>`).join("");
  fromSel.innerHTML = opts;
  toSel.innerHTML = opts;

  // дефолт: первый и второй счёт, чтобы не были одинаковые
  if (!fromSel.value) fromSel.value = state.accounts[0]?.id || "";
  if (!toSel.value)   toSel.value = state.accounts[1]?.id || state.accounts[0]?.id || "";
}

  // subcategories for selected category
  renderSubcategorySelect();
    if (prefs?.subcategoryId) $("#op-subcategory").value = prefs.subcategoryId;

  if (prefs?.currency && $("#op-currency")) {
    $("#op-currency").value = prefs.currency;
    $("#op-currency")._userTouched = true; // чтобы не перетиралось валютой счета
  }

}

function toggleOpFieldsByType_(){
  const type = $("#op-type")?.value || "expense";

  const rowCommon = $("#op-category")?.closest(".row");   // строка Кат/Подкат/Счет/Валюта
  const trRow = $("#op-transfer-row");

  if (type === "transfer"){
    if (rowCommon) rowCommon.style.display = "none";
    if (trRow) trRow.style.display = "flex";
    // подкатегория уже отключается renderSubcategorySelect(), ок
  } else {
    if (rowCommon) rowCommon.style.display = "";
    if (trRow) trRow.style.display = "none";
  }
}

function renderSubcategorySelect(){
  const catId = $("#op-category")?.value || "";
  const type = $("#op-type").value;
  const subSel = $("#op-subcategory");
  if (!subSel) return;

  // no subcats for transfer
  if (type==="transfer" || !catId){
    subSel.innerHTML = `<option value="">—</option>`;
    subSel.value = "";
    subSel.disabled = true;
    return;
  }

  const subcats = state.subcategories
    .filter(sc => String(sc.categoryId)===String(catId))
    .sort((a,b)=>(a.name||"").localeCompare(b.name||""));

  subSel.disabled = false;
  subSel.innerHTML = [`<option value="">— без подкатегории —</option>`]
    .concat(subcats.map(sc=>`<option value="${esc(sc.id)}">${esc(sc.name)}</option>`))
    .join("");

  if (!subSel.value) subSel.value = "";
}

$("#op-type").addEventListener("change", ()=>{
  saveLastOpPrefs_();
  renderSelects();
  renderSubcategorySelect();
  toggleOpFieldsByType_();
  updateTransferRateVisibility_();
});
$("#op-category").addEventListener("change", renderSubcategorySelect);
renderSubcategorySelect();
toggleOpFieldsByType_();
saveLastOpPrefs_();
$("#op-account").addEventListener("change", ()=>{ const s = $("#op-currency"); if (s) s._userTouched = false; updateOpCurrencyBadge(); saveLastOpPrefs_();});
$("#op-currency").addEventListener("change", (e)=>{ e.target._userTouched = true; saveLastOpPrefs_(); });


/**
 * ============================
 *  PULT
 * ============================
 */
function renderPult(){
  renderQuoteOfDay();
  renderOperations();
  renderCanSpend();
  renderLimitsView();
  renderSavingPlan();
}

function renderCanSpend(){
  const el = document.getElementById("can-spend");
  const pill = document.getElementById("pill-can-spend");
  if (!el) return;
  const month = yyyymm(new Date());
  let bal = state.balanceByCurrency;
  if (!bal){
    const byCur = {RUB:0, USD:0, EUR:0, CNY:0};
    for (const a of state.accounts){
      const cur = (a && a.currency) ? a.currency : "RUB";
      byCur[cur] = (byCur[cur]||0) + Number(a.balance||0);
    }
    const monthOps = getMonthOps(month).filter(o=>o.type==="expense");
    for (const o of monthOps){
      const cur = opCurrency(o);
      byCur[cur] = (byCur[cur]||0) - Number(o.amount||0);
    }
    bal = byCur;
  }
  const order = ["RUB","USD","EUR","CNY"];
  const symbols = {RUB:"RUB", USD:"USD", EUR:"EUR", CNY:"CNY"};
  const rows = order.map(cur=>{
    const v = Math.round(Number(bal[cur]||0));
    const sign = v<0 ? "-" : "";
    return `<div class="csItem"><div class="csCur">${symbols[cur]||cur}</div><div class="csVal">${sign}${ruMoney(Math.abs(v), cur)}</div></div>`;
  }).join("");
  el.innerHTML = rows;
  if (pill){
    const rub = Math.round(Number(bal.RUB||0));
    pill.textContent = rub>=0 ? ("RUB " + rub.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : ("RUB -" + Math.abs(rub).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
}

function getMonthOps(monthYYYYMM){
  return state.operations.filter(o => yyyymm(o.date || o.createdAt || new Date()) === monthYYYYMM);
}

function renderLimitsView(){
  const month = yyyymm(new Date());
  const monthOps = getMonthOps(month).filter(o=>o.type==="expense");
  const spentByCat = {};
  for (const o of monthOps){
    const k = String(o.categoryId||"");
    spentByCat[k] = (spentByCat[k]||0) + Number(o.amount||0);
  }

  const monthLimits = state.limits.filter(l => {
  if (String(l.month) !== String(month)) return false;
  return Number(l.amount) > 0;
});
  const limitsMap = {};
  monthLimits.forEach(l=>limitsMap[String(l.categoryId)] = l);
  // categories that actually have a limit set (>0) this month
const catsWithLimit = new Set(
  monthLimits
    .filter(l => l.amount != null && Number(l.amount) > 0)
    .map(l => String(l.categoryId))
);
  
  const expCats = state.categories
  .filter(c => c.type === "expense")
  .filter(c => catsWithLimit.has(String(c.id)));

  const rows = expCats.map(cat=>{
  const lim = limitsMap[String(cat.id)];
  const limitAmount = lim ? Number(lim.amount||0) : 0;
  const spent = Number(spentByCat[String(cat.id)]||0);
  const remaining = limitAmount > 0 ? (limitAmount - spent) : null;
  const pct = (limitAmount>0) ? clamp((spent/limitAmount)*100, 0, 160) : 0;

  const barColor = (limitAmount===0)
    ? "rgba(255,255,255,.25)"
    : (spent>limitAmount ? "rgba(255,91,110,.85)" : "rgba(87,166,255,.85)");
  const status = (limitAmount===0) ? "Лимит не задан" : (spent>limitAmount ? "Превышено" : "Потрачено");

  const catName = cat?.name || "Без категории";
  const spentTxt = ruMoney(spent);
  const limitTxt = ruMoney(limitAmount);
  const remTxt = (remaining==null)
    ? "—"
    : (remaining>=0 ? ruMoney(remaining) : ("-" + ruMoney(Math.abs(remaining))));

  return `
    <div class="item">
      <div class="left" style="gap:6px">
        <div class="t" title="${esc(catName)}">${esc(catName)}</div>
        <div class="d">${esc(status)} · ${spentTxt} из ${limitTxt}</div>
        <div class="progress"><i style="width:${pct}%; background:${barColor}"></i></div>
      </div>
      <div class="right" style="flex-direction:column; align-items:flex-end">
        <div style="font-weight:950">${remTxt}</div>
        <div class="d">Осталось</div>
      </div>
    </div>
  `;
});

$("#limits-view")
.innerHTML = rows.join("") || `<div class="muted">Нет категорий расходов.</div>`;

  // summary pill
  const totalLimit = sum(monthLimits.map(l=>Number(l.amount||0)));
  const totalSpent = sum(Object.values(spentByCat));
  const left = totalLimit>0 ? (totalLimit-totalSpent) : null;
  $("#pill-limits").textContent = totalLimit>0
    ? (left>=0 ? `Можно потратить: ${ruMoney(left)}` : `Превышено: -${ruMoney(Math.abs(left))}`)
    : "Лимиты не заданы";
}


// renderOpsFilters_ теперь только обновляет индикатор кнопки — фильтры живут в state.opsFilters
function renderOpsFilters_(){
  updateOpsFilterBtnState();
}

function getOpsFilters_(){
  return { ...state.opsFilters };
}

function renderOperations(){
  renderOpsFilters_();
  const f = getOpsFilters_();
  let ops = [...state.operations];

  // Filters
  if (f.type !== "all") ops = ops.filter(o=>o.type===f.type);
  if (f.acc !== "all") ops = ops.filter(o=>String(o.accountId||"")===String(f.acc));

  const fromMs = f.from ? parseDateToMs_(f.from) : NaN;
  const toMs = f.to ? parseDateToMs_(f.to) : NaN;
  if (Number.isFinite(fromMs)) ops = ops.filter(o=>opTimeMs_(o) >= fromMs);
  if (Number.isFinite(toMs))   ops = ops.filter(o=>opTimeMs_(o) <= (toMs + 24*60*60*1000 - 1));

  // Sort: newest first
  ops.sort((a,b)=>opTimeMs_(b)-opTimeMs_(a));

if (!ops.length){
    $("#ops-view").innerHTML = `<div class="muted">Нет операций за выбранный период. Измени фильтр (🔍) или добавь операцию.</div>`;
    return;
  }

  const groups = {};
  for (const o of ops){
    const d = isoDate(o.date || o.createdAt || new Date());
    (groups[d] ||= []).push(o);
  }

  const dates = Object.keys(groups).sort((a,b)=> (a<b?1:-1));
  const html = dates.map(d=>{
    // П4: внутри каждых суток — сортируем по id (op_YYYYMMDD_NNN — лексикографический порядок = порядок добавления)
    const dayOps = groups[d].slice().sort((a,b)=>{
      const aId = String(a.id||"");
      const bId = String(b.id||"");
      return aId.localeCompare(bId);
    });

    const items = dayOps.map(o=>{
      const cat = catById(o.categoryId);
      const sub = subcatById(o.subcategoryId);
      const acc = accById(o.accountId);

      const sign = o.type==="expense" ? "−" : (o.type==="income" ? "+" : "↔");
      const cur = opCurrency(o);
      const amt = ruMoney(Math.abs(Number(o.amount||0)), cur);
      const note = (o.comment||"").trim();
      const safeTrim = (v) => (v == null ? "" : String(v)).trim();

      return `
        <div class="item">
          <div class="left">
            <div class="t">
              <span class="tag ${o.type}">${o.type==="expense"?"Расход":o.type==="income"?"Доход":"Перевод"}</span>
              <span style="margin-left:6px">${esc(cat?.name || "Без категории")}${sub ? ` / ${esc(sub.name)}` : ""}</span>
            </div>
            <div class="d">${esc(acc?.name || "Счёт")} · ${esc(cur)} · ${note ? esc(note) : "—"}</div>
          </div>
          <div class="right">
            <div style="font-weight:950">${sign} ${amt}</div>
            <button class="icon-btn edit" aria-label="Редактировать" onclick="openOpEdit('${esc(o.id)}')">⚙️</button>
            <button class="icon-btn danger" aria-label="Удалить" onclick="confirmDeleteOp('${esc(o.id)}')">✕</button>
          </div>
        </div>
      `;
    }).join("");

    const pretty = (Core && Core.fmtOpDateHeader) ? Core.fmtOpDateHeader(new Date(d+"T00:00:00")) : new Date(d+"T00:00:00").toLocaleDateString("ru-RU", {weekday:"short", day:"2-digit", month:"long"});
    const totals = computeDayTotals_(dayOps);
    return `
      <div class="op-date-header-row" style="margin: 14px 0 8px;">
        <div class="op-date-header" style="color: var(--muted); font-weight:900; font-size:12px">${esc(pretty)}</div>
        <div class="op-date-total">Итог: ${esc(totals.balanceText)}${totals.transferText ? ` <span class="muted">·</span> ${esc(totals.transferText)}` : ""}</div>
      </div>
      <div class="list">${items}</div>
    `;
  }).join("");

  $("#ops-view").innerHTML = html;
}

function renderSavingPlan(){
  const todayD = today();
  if (!state.goals.length){
    $("#saving-plan").innerHTML = `<div class="muted">Цели не заданы. Добавь их в разделе «Цели».</div>`;
    return;
  }

    const goalsSorted = [...state.goals].sort((a,b)=>{
    const ta = a.deadline ? Date.parse(a.deadline) : Infinity;
    const tb = b.deadline ? Date.parse(b.deadline) : Infinity;
    if (ta !== tb) return ta - tb;
    return String(a.name||"").localeCompare(String(b.name||""), "ru");
  });

  const html = goalsSorted.map(g=>{

    const target = Number(g.target||0);
    const saved = Number(g.saved||0);
    const left = Math.max(0, target - saved);
    const deadline = g.deadline ? new Date(g.deadline) : null;
    const daysLeft = deadline ? Math.max(0, daysBetween(todayD, deadline)) : null;
    const monthsLeft = (daysLeft && daysLeft>0) ? Math.max(1, Math.ceil(daysLeft/30)) : null;
    const perMonth = (monthsLeft) ? (left / monthsLeft) : null;
    const pct = target>0 ? clamp((saved/target)*100, 0, 100) : 0;

    return `
      <div class="item">
        <div class="left">
          <div class="t">${esc(g.name||"Цель")}</div>
          <div class="d">${ruMoney(saved)} / ${ruMoney(target)} · ${deadline ? ("Дедлайн: "+deadline.toLocaleDateString("ru-RU")) : "Без дедлайна"}</div>
          <div class="progress"><i style="width:${pct}%; background: rgba(65,211,141,.85)"></i></div>
          <div class="d">
            ${left===0 ? "Цель закрыта ✅" :
              `Рекомендация: ${perMonth ? (ruMoney(perMonth)+" / мес") : "задай дедлайн для расчёта"}`
            }
          </div>
        </div>
        <div class="right" style="flex-direction:column; align-items:flex-end">
          <div style="font-weight:900">${left===0 ? "0 ₽" : ruMoney(left)}</div>
          <button class="icon-btn edit" aria-label="Редактировать" onclick="openGoalEdit('${esc(g.id)}')">⚙️</button>
        </div>
      </div>
    `;
  }).join("");

  $("#saving-plan").innerHTML = html;
}

/**
 * Add / Delete operations
 */
$("#btn-add-op").addEventListener("click", async ()=>{
  const type = $("#op-type").value;
  const amount = Number($("#op-amount").value);
  const categoryId = $("#op-category").value;
  const subcategoryId = $("#op-subcategory").value || "";
  const accountId = $("#op-account").value;
  const currency = $("#op-currency")?.value || accCurrency(accountId);
  const date = $("#op-date").value;
  const comment = $("#op-comment").value || "";
  const fromAccountId = $("#op-from-account")?.value || "";
  const toAccountId   = $("#op-to-account")?.value || "";
  const fxRate        = Number($("#op-fx-rate")?.value || 0);
  const amountTo      = Number($("#op-amount-to")?.value || 0);


  if (!amount || amount<=0){
    toast("Проверь сумму", "Сумма должна быть больше 0", "warn", 2000);
    return;
  }
  if (!date){
    toast("Проверь дату", "Выбери дату операции", "warn", 2000);
    return;
  }

  try{
    toast("Операция", "Сохраняю…", "info", 0);
    let payload;

if (type === "transfer") {
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) {
    toast("Проверь счета", "Выбери разные счета «Откуда» и «Куда»", "warn", 2500);
    return;
  }

  const fromCur = getAccCurrencyById_(fromAccountId);
  const toCur   = getAccCurrencyById_(toAccountId);
  const needFx  = fromCur !== toCur;

  let fx = 1;
  let toAmt = amount;

  if (needFx) {
    if (!fxRate || fxRate <= 0) {
      toast("Проверь курс", "Курс должен быть больше 0", "warn", 2500);
      return;
    }
    fx = fxRate;
    toAmt = amountTo > 0 ? amountTo : round2_(amount * bankRateToMultiplier_(fx, fromCur, toCur));
    if (!toAmt || toAmt <= 0) {
      toast("Проверь сумму зачисления", "Не удалось посчитать сумму зачисления", "warn", 2500);
      return;
    }
  }

  payload = {
    type,
    amount,
    // совместимость: accountId хранит from
    accountId: fromAccountId,
    currency: getAccCurrencyById_(fromAccountId),
    fromAccountId,
    toAccountId,
    fxRate: fx,
    amountTo: toAmt,
    date,
    comment
  };

} else {
  payload = {
    type,
    amount,
    categoryId,
    subcategoryId,
    accountId,
    currency,
    date,
    comment
  };
}

await apiPost("addOperation", payload);
    $("#op-amount").value = "";
    $("#op-comment").value = "";
    saveLastOpPrefs_();
    await syncAll("afterAdd");
  }catch(err){
    toast("Ошибка", String(err.message || err), "error", 0);
  }
});

function openOpEdit(id){
  const op = state.operations.find(o=>String(o.id)===String(id));
  if (!op){ toast("Не найдено", "Операция не найдена", "error", 2000); return; }

  const title = "Редактировать операцию";
  const dateVal = isoDate(op.date || op.createdAt || new Date());

  const html = `
    <div class="field"><label>Тип</label>
      <select id="edit-op-type">
        <option value="expense">Расход</option>
        <option value="income">Доход</option>
        <option value="transfer">Перевод</option>
      </select>
    </div>

    <!-- Блок для income/expense -->
    <div id="edit-op-normal">
      <div class="row">
        <div class="field"><label>Счёт</label><select id="edit-op-account"></select></div>
        <div class="field"><label>Категория</label><select id="edit-op-category"></select></div>
      </div>
      <div class="field"><label>Подкатегория</label><select id="edit-op-subcategory"></select></div>
    </div>

    <!-- Блок для transfer -->
    <div id="edit-op-transfer" style="display:none">
      <div class="row">
        <div class="field"><label>Откуда</label><select id="edit-op-from"></select></div>
        <div class="field"><label>Куда</label><select id="edit-op-to"></select></div>
      </div>
      <div class="row" id="edit-op-transfer-fxrow">
        <div class="field"><label>Курс</label><input id="edit-op-fx" type="number" step="0.0001" inputmode="decimal" placeholder="например 93.5" /></div>
        <div class="field"><label>Сумма зачисления</label><input id="edit-op-amount-to" type="number" step="0.01" inputmode="decimal" placeholder="0" /></div>
        <button class="help-btn" data-help="«Сумма» — это сумма списания со счёта отправителя. «Сумма зачисления» считается по курсу автоматически, но можно ввести вручную." aria-label="Подсказка" style="align-self:center">❓</button>
      </div>
    </div>

    <div class="row op-date-row">
      <div class="field"><label>Сумма</label><input id="edit-op-amount" type="number" inputmode="numeric" placeholder="0" /></div>
      <div class="field"><label>Дата</label><input id="edit-op-date" type="date" lang="ru" /></div>
    </div>

    <div class="field"><label>Комментарий</label><input id="edit-op-comment" type="text" placeholder="необязательно" /></div>

    <div class="row">
      <button class="btn" id="btn-save-op">Сохранить изменения</button>
      <button class="btn secondary" id="btn-cancel-op">Отмена</button>
    </div>
  `;

  openModal(title, html);

  // helpers
  const getAcc = (id)=> (state.accounts || []).find(a=>String(a.id)===String(id));
  const fillAccountsOptions = (sel, selectedId="")=>{
    sel.innerHTML = state.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.name||"Счёт")} (${esc((a.currency||"RUB").toUpperCase())})</option>`).join("");
    if (selectedId) sel.value = selectedId;
  };

  const typeSel = $("#edit-op-type");
  const normalBox = $("#edit-op-normal");
  const trBox = $("#edit-op-transfer");

  const accSel = $("#edit-op-account");
  const catSel = $("#edit-op-category");
  const subSel = $("#edit-op-subcategory");

  const fromSel = $("#edit-op-from");
  const toSel = $("#edit-op-to");
  const fxInput = $("#edit-op-fx");
  const amtToInput = $("#edit-op-amount-to");

  // fill normal selects
  if (accSel) fillAccountsOptions(accSel, op.accountId || "");
  if (catSel) catSel.innerHTML = state.categories.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");

  function fillSubs(){
    const catId = catSel.value;
    const subs = state.subcategories.filter(sc=>String(sc.categoryId)===String(catId));
    subSel.innerHTML = `<option value="">—</option>` + subs.map(sc=>`<option value="${esc(sc.id)}">${esc(sc.name)}</option>`).join("");
  }

  if (catSel){
    catSel.value = op.categoryId || (state.categories[0] ? state.categories[0].id : "");
    fillSubs();
  }
  if (subSel) subSel.value = op.subcategoryId || "";

  // fill transfer selects
  if (fromSel) fillAccountsOptions(fromSel, op.fromAccountId || op.accountId || "");
  if (toSel) fillAccountsOptions(toSel, op.toAccountId || "");

  // values
  typeSel.value = op.type || "expense";
  $("#edit-op-amount").value = Number(op.amount||0);
  $("#edit-op-date").value = dateVal;
  $("#edit-op-comment").value = op.comment||"";
  if (fxInput) fxInput.value = op.fxRate ? String(op.fxRate) : "";
  if (amtToInput) amtToInput.value = op.amountTo ? String(op.amountTo) : "";

  function recalcEditTransferTo_(){
    if (!amtToInput) return;
    const amt = Number($("#edit-op-amount").value || 0);
    const fx = Number(fxInput?.value || 0);
    if (!amt || amt<=0){ amtToInput.value = ""; return; }
    if (!fx || fx<=0){ return; }
    amtToInput.value = String(Math.round(amt * fx * 100) / 100);
  }

  function updateEditTransferRateVisibility_(){
    if (typeSel.value !== "transfer") return;

    const fromAcc = getAcc(fromSel?.value || "");
    const toAcc = getAcc(toSel?.value || "");
    const fromCur = (fromAcc?.currency || "RUB").toUpperCase();
    const toCur = (toAcc?.currency || "RUB").toUpperCase();

    const needFx = fromCur !== toCur;
    const fxRow = $("#edit-op-transfer-fxrow");
    if (fxRow) fxRow.style.display = needFx ? "" : "none";

    if (!needFx){
      if (fxInput) fxInput.value = "1";
      if (amtToInput) amtToInput.value = String(Number($("#edit-op-amount").value || 0) || "");
    } else {
      recalcEditTransferTo_();
    }
  }

  function applyTypeUI_(){
    const t = typeSel.value;
    const isTr = (t === "transfer");
    if (normalBox) normalBox.style.display = isTr ? "none" : "";
    if (trBox) trBox.style.display = isTr ? "" : "none";
    if (isTr) updateEditTransferRateVisibility_();
  }

  // listeners
  if (catSel) catSel.addEventListener("change", ()=>{ fillSubs(); subSel.value=""; });
  if (typeSel) typeSel.addEventListener("change", applyTypeUI_);
  if (fromSel) fromSel.addEventListener("change", updateEditTransferRateVisibility_);
  if (toSel) toSel.addEventListener("change", updateEditTransferRateVisibility_);
  if (fxInput) fxInput.addEventListener("input", recalcEditTransferTo_);
  $("#edit-op-amount").addEventListener("input", ()=>{ if (typeSel.value==="transfer") updateEditTransferRateVisibility_(); });

  applyTypeUI_();

  $("#btn-cancel-op").addEventListener("click", closeModal, {once:true});

  $("#btn-save-op").addEventListener("click", async ()=>{
    const amount = Number($("#edit-op-amount").value || 0);
    const date = $("#edit-op-date").value;
    if (!amount || amount<=0){ toast("Проверь сумму", "Сумма должна быть больше 0", "warn", 2000); return; }
    if (!date){ toast("Проверь дату", "Выбери дату операции", "warn", 2000); return; }

    const t = typeSel.value;

    let data = {
      id: op.id,
      type: t,
      amount,
      date,
      comment: $("#edit-op-comment").value || ""
    };

    if (t === "transfer"){
      const fromId = fromSel.value || "";
      const toId = toSel.value || "";
      if (!fromId || !toId){ toast("Перевод", "Выбери «Откуда» и «Куда»", "warn", 2000); return; }
      if (fromId === toId){ toast("Перевод", "Счета должны быть разными", "warn", 2000); return; }

      const fromCur = (getAcc(fromId)?.currency || "RUB").toUpperCase();
      const toCur = (getAcc(toId)?.currency || "RUB").toUpperCase();
      const needFx = fromCur !== toCur;

      let fx = 1;
      let amtTo = amount;

      if (needFx){
        fx = Number(fxInput?.value || 0);
        amtTo = Number(amtToInput?.value || 0);
        if (!fx || fx<=0){ toast("Перевод", "Введи курс конвертации", "warn", 2000); return; }
        if (!amtTo || amtTo<=0){ toast("Перевод", "Введи сумму зачисления", "warn", 2000); return; }
      }

      data = {
        ...data,
        // совместимость: accountId хранит from
        accountId: fromId,
        categoryId: "",
        subcategoryId: "",
        fromAccountId: fromId,
        toAccountId: toId,
        fxRate: fx,
        amountTo: amtTo
      };
    } else {
      data = {
        ...data,
        accountId: accSel.value,
        categoryId: catSel.value,
        subcategoryId: subSel.value || "",
        currency: opCurrency(op)
      };
    }

    try{
      toast("Операция", "Сохраняю...", "info", 0);
      await apiPost("updateOperation", data);
      closeModal();
      await syncAll("afterUpdate");
    }catch(err){
      toast("Ошибка", String(err.message || err), "error", 0);
    }
  });
}


function confirmDeleteOp(id){
  const op = state.operations.find(o=>String(o.id)===String(id));
  if (!op){ toast("Не найдено", "Операция не найдена", "error", 2000); return; }
  const cat = catById(op.categoryId);
  const sign = op.type==="expense" ? "−" : (op.type==="income" ? "+" : "↔");
  const html = `
    <div class="muted" style="margin-bottom:10px">
      Удалить операцию?
      <div style="margin-top:8px; color:var(--text); font-weight:900">
        ${sign} ${ruMoney(op.amount, opCurrency(op))} · ${esc(cat?.name||"Без категории")} · ${esc(isoDate(op.date||op.createdAt))}
      </div>
    </div>
    <div class="row">
      <button class="btn danger" id="modalYes">Удалить</button>
      <button class="btn secondary" id="modalNo">Отмена</button>
    </div>
  `;
  openModal("Подтверждение", html);
  $("#modalNo").addEventListener("click", closeModal, {once:true});
  $("#modalYes").addEventListener("click", async ()=>{
    try{
      toast("Удаление", "Удаляю…", "info", 0);
      await apiPost("deleteOperation", { id });
      closeModal();
      await syncAll("afterDelete");
    }catch(err){
      toast("Ошибка", String(err.message || err), "error", 0);
    }
  }, {once:true});
}

// btn-refresh removed (П8)

/**
 * Jump to limit edit for category
 */
function openLimitForCategory(categoryId){
  showPage("settings");
  // scroll hint: open modal editor directly
  const cat = catById(categoryId);
  openLimitEditor({ id:null, categoryId, month: yyyymm(new Date()), amount: "" }, `Лимит: ${cat?.name||"Категория"}`);
}

/**
 * ============================
 *  DASHBOARD
 * ============================
 */
function setPeriod(kind){
  state.period.kind = kind;
  if (kind!=="custom"){
    const now = new Date();
    if (kind==="week"){ state.period.from = startOfWeek(now); state.period.to = endOfWeek(now); }
    if (kind==="month"){ state.period.from = startOfMonth(now); state.period.to = endOfMonth(now); }
    if (kind==="year"){ state.period.from = startOfYear(now); state.period.to = endOfYear(now); }
  }
  $("#custom-range").style.display = (kind==="custom") ? "flex" : "none";
  renderDashboard();
}

$("#period-tabs").addEventListener("click", (e)=>{
  const tab = e.target.closest(".tab");
  if (!tab) return;
  $$("#period-tabs .tab").forEach(t=>t.classList.remove("active"));
  tab.classList.add("active");
  const kind = tab.getAttribute("data-period");
  setPeriod(kind);
});

$("#btn-apply-range").addEventListener("click", ()=>{
  const f = $("#range-from").value;
  const t = $("#range-to").value;
  if (!f || !t){ toast("Период", "Выбери обе даты", "warn", 2000); return; }
  const from = new Date(f+"T00:00:00");
  const to = new Date(t+"T23:59:59");
  if (from>to){ toast("Период", "Дата «С» должна быть раньше «По»", "warn", 2200); return; }
  state.period.from = from; state.period.to = to;
  renderDashboard();
});

function opsInRange(from,to){
  const a = new Date(from); const b = new Date(to);
  return state.operations.filter(o=>{
    const d = new Date((o.date||o.createdAt));
    return d>=a && d<=b;
  });
}
function previousAnalogRange(from,to){
  const days = Math.max(1, daysBetween(from,to)+1);
  const prevTo = new Date(from);
  prevTo.setMilliseconds(prevTo.getMilliseconds()-1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (days-1));
  prevFrom.setHours(0,0,0,0);
  return {from:prevFrom, to:prevTo};
}

function sumsForOps(ops){
  let income=0, expense=0;
  for (const o of ops){
    const t = o.type;
    const amt = Number(o.amount||0);
    if (t==='income') income += amt;
    else if (t==='expense') expense += amt;
  }
  return {income, expense, balance: income-expense};
}

function renderSummaryByCurrency(opsInPeriod){
  const curSel = $('#dash-cur');
  const cur = curSel ? curSel.value : 'ALL';
  const box = $('#summary-box');
  if (!box) return;

  const kv = (k,v)=>`<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;

  if (cur==='ALL'){
    const rows = currenciesInUse().map(c=>{
      const ops = filterOpsByCurrency(opsInPeriod, c);
      const s = sumsForOps(ops);
      return `<div class="item"><div class="t">${c}</div>${kv('Доходы', ruMoney(s.income, c))}${kv('Расходы', ruMoney(s.expense, c))}${kv('Баланс', ruMoney(s.balance, c))}</div>`;
    }).join('');
    box.innerHTML = `<div class="grid3">${rows}</div>`;
  }else{
    const ops = filterOpsByCurrency(opsInPeriod, cur);
    const s = sumsForOps(ops);
    box.innerHTML = `<div class="grid3"><div class="item"><div class="t">Доходы</div><div class="v">${ruMoney(s.income, cur)}</div></div><div class="item"><div class="t">Расходы</div><div class="v">${ruMoney(s.expense, cur)}</div></div><div class="item"><div class="t">Баланс</div><div class="v">${ruMoney(s.balance, cur)}</div></div></div>`;
  }
}

function renderDashboard(){
  // init default period if not set
  if (!state.period.from || !state.period.to){
    setPeriod(state.period.kind || "week");
    return;
  }
  const from = state.period.from, to = state.period.to;
  const pretty = `${from.toLocaleDateString("ru-RU")} — ${to.toLocaleDateString("ru-RU")}`;
  $("#pill-period").textContent = pretty;

  const curOps = opsInRange(from,to);
  const prev = previousAnalogRange(from,to);
  const prevOps = opsInRange(prev.from, prev.to);

  const curIncome = sum(curOps.filter(o=>o.type==="income").map(o=>Number(o.amount||0)));
  const curExpense = sum(curOps.filter(o=>o.type==="expense").map(o=>Number(o.amount||0)));
  const curBalance = curIncome - curExpense;

  const prevIncome = sum(prevOps.filter(o=>o.type==="income").map(o=>Number(o.amount||0)));
  const prevExpense = sum(prevOps.filter(o=>o.type==="expense").map(o=>Number(o.amount||0)));
  const prevBalance = prevIncome - prevExpense;

  const kpis = [
    { label:"Доходы", val:curIncome, prev:prevIncome },
    { label:"Расходы", val:curExpense, prev:prevExpense },
    { label:"Баланс",  val:curBalance, prev:prevBalance }
  ];
  $("#kpi-row").innerHTML = kpis.map(k=>{
    const deltaPct = (k.prev===0) ? (k.val===0 ? 0 : 100) : ((k.val-k.prev)/Math.abs(k.prev))*100;
    const dir = (k.val>k.prev) ? "up" : (k.val<k.prev) ? "down" : "flat"; // фактическое направление
    const arrow = (dir==="up") ? "↑" : (dir==="down") ? "↓" : "→";

    // цвет: для расходов — наоборот
    const cls = (k.label === "Расходы")
    ? (dir==="up" ? "down" : dir==="down" ? "up" : "flat")
    : dir;

    return `
      <div class="kpi">
        <div class="sub">${esc(k.label)} · <span class="delta ${cls}">${arrow} ${Math.round(deltaPct)}%</span></div>
        <div class="val">${ruMoney(k.val)}</div>
        <div class="sub">пред. период: ${ruMoney(k.prev)}</div>
      </div>
    `;
  }).join("");

  // charts
  drawBarChart($("#bar-chart"), from,to, curOps);
  drawPie($("#pie-expense"), curOps.filter(o=>o.type==="expense"), "expense");
  drawPie($("#pie-income"), curOps.filter(o=>o.type==="income"), "income");

  initChartInteractivityOnce();
  renderMobileDashboardPickers();

  renderTopCategories(curOps);
  renderSubcategoryDashboard(curOps);
  renderCurrencyStructure();
}

function bucketLabel(d, kind){
  const x = new Date(d);
  const mShort = (Core && Core.fmtMonthShort) ? Core.fmtMonthShort(x) : x.toLocaleString("ru-RU", {month:"short"});
    const dmShort = (Core && Core.fmtDayMonth) ? Core.fmtDayMonth(x) : x.toLocaleDateString("ru-RU", {day:"2-digit", month:"short"});
  const wd = (Core && Core.fmtWeekdayShort) ? Core.fmtWeekdayShort(x) : x.toLocaleDateString("ru-RU", {weekday:"short"});
  if (kind==="year") return mShort;
  if (kind==="month") return dmShort;
  if (kind==="week") return String(wd).trim().replace(/\.+$/,"");
  return dmShort;
}

function drawBarChart(canvas, from, to, ops){
  const ctx = canvas.getContext("2d");
  const DPR = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.floor(w*DPR);
  canvas.height = Math.floor(h*DPR);
  ctx.setTransform(DPR,0,0,DPR,0,0);

  ctx.clearRect(0,0,w,h);

  // determine buckets count based on range
  const days = Math.max(1, daysBetween(from,to)+1);
  let bucket = "day";
  if (state.period.kind==="year") bucket="month";
  else if (days<=7) bucket="dow";
  else bucket="day";

  // build buckets
  const buckets = [];
  const map = new Map(); // label -> {income,expense}
  const cur = new Date(from);
  cur.setHours(0,0,0,0);

  if (bucket==="month"){
    const s = new Date(from); s.setDate(1);
    const e = new Date(to);
    let it = new Date(s);
    while (it<=e){
      const lab = (Core && Core.fmtMonthShort) ? Core.fmtMonthShort(it) : it.toLocaleString("ru-RU", {month:"short"});
      map.set(lab, {income:0, expense:0});
      buckets.push({key: lab});
      it.setMonth(it.getMonth()+1);
    }
    for (const o of ops){
      const d = new Date(o.date||o.createdAt);
      const lab = (Core && Core.fmtMonthShort) ? Core.fmtMonthShort(d) : d.toLocaleString("ru-RU", {month:"short"});
      const b = map.get(lab);
      if (!b) continue;
      if (o.type==="income") b.income += Number(o.amount||0);
      if (o.type==="expense") b.expense += Number(o.amount||0);
    }
  } else if (bucket==="dow"){
    const labs = ["пн","вт","ср","чт","пт","сб","вс"];
    labs.forEach(l=>{ map.set(l,{income:0, expense:0}); buckets.push({key:l}); });
    for (const o of ops){
      const d = new Date(o.date||o.createdAt);
      const idx = (d.getDay()+6)%7;
      const lab = labs[idx];
      const b = map.get(lab);
      if (o.type==="income") b.income += Number(o.amount||0);
      if (o.type==="expense") b.expense += Number(o.amount||0);
    }
  } else {
    // day labels from range, but cap max to 14 labels for readability
    const maxLabels = 14;
    if (days > maxLabels){
      // step
      const step = Math.ceil(days / maxLabels);
      let it = new Date(from);
      let i=0;
      while (it<=to){
        const lab = (Core && Core.fmtDayMonth) ? Core.fmtDayMonth(it) : it.toLocaleDateString("ru-RU", {day:"2-digit", month:"short"});
        map.set(lab,{income:0, expense:0});
        buckets.push({key: lab, date: new Date(it)});
        it.setDate(it.getDate()+step);
        i++;
        if (i>maxLabels+2) break;
      }
      // aggregate ops into nearest label by step bins
      for (const o of ops){
        const d = new Date(o.date||o.createdAt);
        // find bin by step
        const idx = Math.floor(daysBetween(from, d)/step);
        const bKey = buckets[Math.min(idx, buckets.length-1)]?.key;
        if (!bKey) continue;
        const b = map.get(bKey);
        if (o.type==="income") b.income += Number(o.amount||0);
        if (o.type==="expense") b.expense += Number(o.amount||0);
      }
    } else {
      let it = new Date(from);
      while (it<=to){
        const lab = (Core && Core.fmtDayMonth) ? Core.fmtDayMonth(it) : it.toLocaleDateString("ru-RU", {day:"2-digit", month:"short"});
        map.set(lab,{income:0, expense:0});
        buckets.push({key: lab});
        it.setDate(it.getDate()+1);
      }
      for (const o of ops){
        const d = new Date(o.date||o.createdAt);
        const lab = (Core && Core.fmtDayMonth) ? Core.fmtDayMonth(d) : d.toLocaleDateString("ru-RU", {day:"2-digit", month:"short"});
        const b = map.get(lab);
        if (!b) continue;
        if (o.type==="income") b.income += Number(o.amount||0);
        if (o.type==="expense") b.expense += Number(o.amount||0);
      }
    }
  }

  const data = buckets.map(b=>({label:b.key, ...map.get(b.key)}));
  const maxVal = Math.max(1, ...data.map(x=>Math.max(x.income, x.expense)));
  const pad = 12;
  const topPad = 18;
  const rotateLabels = (state.period.kind==="month" || state.period.kind==="year" || state.period.kind==="custom");
  const bottomPad = rotateLabels ? 70 : 28;
  const chartW = w - pad*2;
  const chartH = h - topPad - bottomPad;
// axis baseline
  ctx.strokeStyle = "rgba(255,255,255,.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, topPad+chartH);
  ctx.lineTo(pad+chartW, topPad+chartH);
  ctx.stroke();

  const n = data.length;
  const groupW = chartW / Math.max(1, n);
  const barW = Math.max(6, groupW * 0.28);
  const gap = groupW * 0.12;

  const hit = []; // интерактивные зоны для tooltip/выбора

  for (let i=0;i<n;i++){
    const x0 = pad + i*groupW + groupW/2;
    const incH = (data[i].income / maxVal) * (chartH-10);
    const expH = (data[i].expense / maxVal) * (chartH-10);


    // income bar
    ctx.fillStyle = "rgba(65,211,141,.85)";
    const incX = x0 - barW - gap/2;
    const incY = topPad+chartH - incH;
    ctx.fillRect(incX, incY, barW, incH);

    // expense bar
    ctx.fillStyle = "rgba(255,91,110,.85)";
    const expX = x0 + gap/2;
    const expY = topPad+chartH - expH;
    ctx.fillRect(expX, expY, barW, expH);

    // hit zones
    hit.push({kind:"income", idx:i, x:incX, y:incY, w:barW, h:incH, label:data[i].label, value:data[i].income, income:data[i].income, expense:data[i].expense, balance:data[i].income-data[i].expense});
    hit.push({kind:"expense", idx:i, x:expX, y:expY, w:barW, h:expH, label:data[i].label, value:data[i].expense, income:data[i].income, expense:data[i].expense, balance:data[i].income-data[i].expense});

    // labels
    ctx.fillStyle = "rgba(255,255,255,.70)";
    ctx.font = "12px Inter, system-ui, sans-serif";
    if (!rotateLabels){
      ctx.textAlign = "center";
      ctx.fillText(data[i].label, x0, topPad+chartH + 18);
    } else {
      ctx.save();
      ctx.translate(x0, topPad+chartH + 18);
      ctx.rotate(-Math.PI/2);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(data[i].label, 0, 0);
      ctx.restore();
      ctx.textBaseline = "alphabetic";
    }
  }

// legend
  ctx.textAlign = "left";
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.fillStyle = "rgba(65,211,141,.9)";
  ctx.fillText("Доходы", pad, 16);
  ctx.fillStyle = "rgba(255,91,110,.9)";
  ctx.fillText("Расходы", pad+72, 16);

  // сохраняем модель для tooltip/моб.селекта
  state.ui.barModel = {
    bucket,
    from: new Date(from),
    to: new Date(to),
    buckets: data.map(x=>({label:x.label, income:x.income, expense:x.expense, balance:(x.income-x.expense)})),
    hit
  };
  return state.ui.barModel;
}

function drawPie(canvas, ops, kind){
  const ctx = canvas.getContext("2d");
  const DPR = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.floor(w*DPR);
  canvas.height = Math.floor(h*DPR);
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.clearRect(0,0,w,h);

  const byCat = {};
  for (const o of ops){
    const k = String(o.categoryId||"");
    byCat[k] = (byCat[k]||0) + Number(o.amount||0);
  }
  const entries = Object.entries(byCat)
    .map(([cid, val])=>({cid, val, name: (catById(cid)?.name || "Без категории")}))
    .sort((a,b)=>b.val-a.val);

  if (!entries.length){
    ctx.fillStyle = "rgba(255,255,255,.60)";
    ctx.font = "14px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Нет данных", w/2, h/2);
    return;
  }

  const total = sum(entries.map(e=>e.val));
  const cx = w*0.5, cy = h*0.5;
  const r = Math.min(w,h)*0.32;

  let ang = -Math.PI/2;
  const palette = [
    "rgba(87,166,255,.85)","rgba(65,211,141,.85)","rgba(255,204,102,.85)","rgba(255,91,110,.85)",
    "rgba(173,140,255,.85)","rgba(255,145,92,.85)","rgba(120,220,255,.85)"
  ];

  const hit = []; // сектора для tooltip/выбора

  for (let i=0;i<entries.length;i++){
    const frac = entries[i].val/total;
    const a2 = ang + frac*2*Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,ang,a2);
    ctx.closePath();
    ctx.fillStyle = palette[i % palette.length];
    ctx.fill();

    hit.push({
      idx:i,
      color: palette[i % palette.length],
      cid: entries[i].cid,
      name: entries[i].name,
      val: entries[i].val,
      pct: (entries[i].val/total)*100,
      a1: ang,
      a2: a2,
      cx, cy,
      rOuter: r,
      rInner: r*0.55,
      color: palette[i % palette.length]
    });

    ang = a2;
  }

  // donut hole
  ctx.beginPath();
  ctx.arc(cx,cy,r*0.55,0,2*Math.PI);
  ctx.fillStyle = "rgba(15,17,21,1)";
  ctx.fill();

  // legend (HTML, wraps on mobile)
  const legendEl = document.getElementById(`pie-${kind}-legend`);
  if (legendEl){
    const maxItems = 18; // safety for very long lists
    legendEl.innerHTML = entries.slice(0, maxItems).map((e, i)=>{
      const pct = Math.round((e.val/total)*100);
      const color = palette[i % palette.length];
      // data-kind: expense|income
      return `<div class="pieItem" data-kind="${esc(kind)}" data-idx="${i}" data-cid="${esc(e.cid)}" data-val="${e.val}" data-pct="${pct}" data-color="${esc(color)}">`+
             `<span class="swatch" style="background:${esc(color)}"></span>`+
             `<span class="label">${esc(e.name)} — ${pct}%</span>`+
             `</div>`;
    }).join("");
  }

// сохраняем модель
  const model = {
    kind,
    total,
    entries: entries.map((e,i)=>({cid:e.cid, name:e.name, val:e.val, pct:(e.val/total)*100, color: palette[i % palette.length]})),
    hit
  };
  if (kind==="expense") state.ui.pieExpenseModel = model;
  if (kind==="income") state.ui.pieIncomeModel = model;
  return model;

}


/**
 * ============================
 *  DASHBOARD CHART INTERACTIVITY
 * ============================
 */
function initChartInteractivityOnce(){
  if (state.ui.chartsInited) return;
  const tip = $("#chartTip");
  if (!tip) { state.ui.chartsInited = true; return; }

  const hoverOK = !!(window.matchMedia && window.matchMedia("(hover: hover)").matches);
  let tipHideTimer = null;

  const hideTip = ()=>{
    tip.style.display = "none";
    if (tipHideTimer){ clearTimeout(tipHideTimer); tipHideTimer = null; }
  };

  const showTip = (html, clientX, clientY, stickyMs)=>{
    tip.innerHTML = html;
    tip.style.display = "block";

    // keep on screen
    const pad = 10;
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = tip.getBoundingClientRect();
    let x = clientX + 12;
    let y = clientY + 12;
    if (x + rect.width + pad > vw) x = Math.max(pad, clientX - rect.width - 12);
    if (y + rect.height + pad > vh) y = Math.max(pad, clientY - rect.height - 12);
    tip.style.left = x + "px";
    tip.style.top = y + "px";

    if (tipHideTimer){ clearTimeout(tipHideTimer); tipHideTimer = null; }
    if (stickyMs && stickyMs>0){
      tipHideTimer = setTimeout(hideTip, stickyMs);
    }
  };

  const pickBarHit = (mx, my)=>{
    const model = state.ui.barModel;
    if (!model || !model.hit) return null;
    for (let i=0;i<model.hit.length;i++){
      const r = model.hit[i];
      if (mx>=r.x && mx<=r.x+r.w && my>=r.y && my<=r.y+r.h){
        return r;
      }
    }
    return null;
  };

  const norm2pi = (a)=>{
    const two = Math.PI*2;
    let x = a % two;
    if (x<0) x += two;
    return x;
  };
  const angleIn = (a, a1, a2)=>{
    const A = norm2pi(a), A1 = norm2pi(a1), A2 = norm2pi(a2);
    if (A1<=A2) return A>=A1 && A<=A2;
    return (A>=A1) || (A<=A2);
  };
  const pickPieHit = (model, mx, my)=>{
    if (!model || !model.hit || !model.hit.length) return null;
    // all sectors share same center/r (we stored per sector too)
    const any = model.hit[0];
    const dx = mx - any.cx;
    const dy = my - any.cy;
    const rr = Math.sqrt(dx*dx + dy*dy);
    if (rr < any.rInner || rr > any.rOuter) return null;
    const ang = Math.atan2(dy, dx);
    for (let i=0;i<model.hit.length;i++){
      const s = model.hit[i];
      if (angleIn(ang, s.a1, s.a2)) return s;
    }
    return null;
  };

  const bindCanvas = (canvas, onMove)=>{
    if (!canvas) return;

    // Hover interactions (desktop)
    if (hoverOK){
      canvas.addEventListener("mousemove", (e)=>{
        const r = canvas.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        onMove(e, mx, my, 0);
      });
      canvas.addEventListener("mouseleave", hideTip);
    }

    // Tap/click interactions (mobile + desktop)
    canvas.addEventListener("pointerdown", (e)=>{
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      onMove(e, mx, my, 2500);
    });
  };

  // bar chart
  bindCanvas($("#bar-chart"), (e, mx, my, stickyMs)=>{
    const h = pickBarHit(mx, my);
    if (!h){ hideTip(); return; }
    const title = `<div style="font-weight:900; margin-bottom:4px">${esc(h.label)}</div>`;
    const type = h.kind==="income" ? "Доход" : "Расход";
    const line1 = `<div>${esc(type)}: <span style="font-weight:900">${ruMoney(h.value)}</span></div>`;
    const line2 = `<div style="color:rgba(255,255,255,.72); margin-top:3px">Баланс: ${ruMoney(h.balance)}</div>`;
    showTip(title + line1 + line2, e.clientX, e.clientY, stickyMs);
  });

  // pie expense
  bindCanvas($("#pie-expense"), (e, mx, my, stickyMs)=>{
    const s = pickPieHit(state.ui.pieExpenseModel, mx, my);
    if (!s){ hideTip(); return; }
    const pct = Math.round(s.pct);
    const html = `<div style="font-weight:900; margin-bottom:4px">${esc(s.name)}</div>` +
      `<div>Расход: <span style="font-weight:900">${ruMoney(s.val)}</span></div>` +
      `<div style="color:rgba(255,255,255,.72); margin-top:3px">${pct}% от расходов</div>`;
    showTip(html, e.clientX, e.clientY, stickyMs);
  });

  // pie income
  bindCanvas($("#pie-income"), (e, mx, my, stickyMs)=>{
    const s = pickPieHit(state.ui.pieIncomeModel, mx, my);
    if (!s){ hideTip(); return; }
    const pct = Math.round(s.pct);
    const html = `<div style="font-weight:900; margin-bottom:4px">${esc(s.name)}</div>` +
      `<div>Доход: <span style="font-weight:900">${ruMoney(s.val)}</span></div>` +
      `<div style="color:rgba(255,255,255,.72); margin-top:3px">${pct}% от доходов</div>`;
    showTip(html, e.clientX, e.clientY, stickyMs);
  });

  
  // HTML legend clicks (for wrapped legend under pie charts)
  const bindLegend = (el, kind)=>{
    if (!el || el.dataset.bound) return;
    el.dataset.bound = "1";
    el.addEventListener("pointerdown", (e)=>{
      const item = e.target.closest(".pieItem");
      if (!item) return;
      const name = item.querySelector(".label") ? item.querySelector(".label").textContent.split(" — ")[0] : "";
      const val = Number(item.dataset.val||0);
      const pct = Number(item.dataset.pct||0);
      const isExpense = (item.dataset.kind==="expense");
      const head = `<div style="font-weight:900; margin-bottom:4px">${esc(name||"")}</div>`;
      const line1 = `<div>${isExpense ? "Расход" : "Доход"}: <span style="font-weight:900">${ruMoney(val)}</span></div>`;
      const line2 = `<div style="color:rgba(255,255,255,.72); margin-top:3px">${Math.round(pct)}% от ${isExpense ? "расходов" : "доходов"}</div>`;
      showTip(head + line1 + line2, e.clientX, e.clientY, 2500);
    });
  };
  bindLegend(document.getElementById("pie-expense-legend"), "expense");
  bindLegend(document.getElementById("pie-income-legend"), "income");

state.ui.chartsInited = true;
}

function renderMobileDashboardPickers(){
  renderBarPicker();
  renderPiePicker();
}

function renderBarPicker(){
  const sel = $("#dash-bar-pick");
  const box = $("#dash-bar-details");
  const model = state.ui.barModel;
  if (!sel || !box || !model || !model.buckets) return;

  const prev = (state.ui.barPickIdx!=null) ? String(state.ui.barPickIdx) : "";
  sel.innerHTML = model.buckets.map((b, idx)=>`<option value="${idx}">${esc(b.label)}</option>`).join("");

  // default: last bucket (обычно ближе к текущему)
  let idx = model.buckets.length ? (model.buckets.length-1) : 0;
  if (prev && Number.isFinite(Number(prev))) idx = Math.min(model.buckets.length-1, Math.max(0, Number(prev)));
  sel.value = String(idx);
  state.ui.barPickIdx = idx;

  renderBarDetails(idx);

  if (!sel.dataset.bound){
    sel.addEventListener("change", ()=>{
      const i = Number(sel.value||0);
      state.ui.barPickIdx = i;
      renderBarDetails(i);
    });
    sel.dataset.bound = "1";
  }
}

function renderBarDetails(idx){
  const box = $("#dash-bar-details");
  const model = state.ui.barModel;
  if (!box || !model || !model.buckets || !model.buckets[idx]) return;
  const b = model.buckets[idx];
  box.innerHTML = `
    <div class="kpiItem"><div class="k">Доходы</div><div class="v">${ruMoney(b.income)}</div></div>
    <div class="kpiItem"><div class="k">Расходы</div><div class="v">${ruMoney(b.expense)}</div></div>
    <div class="kpiItem"><div class="k">Баланс</div><div class="v">${ruMoney(b.balance)}</div></div>
  `;
}

function renderPiePicker(){
  const sel = $("#dash-pie-pick");
  const box = $("#dash-pie-details");
  const mE = state.ui.pieExpenseModel;
  const mI = state.ui.pieIncomeModel;
  if (!sel || !box) return;

  const opts = [];
  if (mE && mE.entries){
    for (const e of mE.entries){
      opts.push({key:`expense|${e.cid}`, text:`Расходы: ${e.name}`, kind:"expense", entry:e});
    }
  }
  if (mI && mI.entries){
    for (const e of mI.entries){
      opts.push({key:`income|${e.cid}`, text:`Доходы: ${e.name}`, kind:"income", entry:e});
    }
  }

  if (!opts.length){
    sel.innerHTML = `<option value="">Нет данных</option>`;
    box.innerHTML = `<div class="muted">Нет данных для выбранного периода.</div>`;
    return;
  }

  sel.innerHTML = opts.map(o=>`<option value="${esc(o.key)}">${esc(o.text)}</option>`).join("");

  // default: сохраняем прошлый выбор, иначе самый крупный расход/доход (первый в списке каждой модели — уже отсортирован)
  const prevKey = state.ui.piePickKey || "";
  let key = prevKey && opts.some(o=>o.key===prevKey) ? prevKey : opts[0].key;
  sel.value = key;
  state.ui.piePickKey = key;

  renderPieDetails(key);

  if (!sel.dataset.bound){
    sel.addEventListener("change", ()=>{
      const k = String(sel.value||"");
      state.ui.piePickKey = k;
      renderPieDetails(k);
    });
    sel.dataset.bound = "1";
  }
}

function renderPieDetails(key){
  const box = $("#dash-pie-details");
  if (!box || !key) return;
  const parts = key.split("|");
  const kind = parts[0];
  const cid = parts[1] ?? "";
  const model = (kind==="expense") ? state.ui.pieExpenseModel : state.ui.pieIncomeModel;
  if (!model || !model.entries) return;
  const e = model.entries.find(x=>String(x.cid)===String(cid));
  if (!e) return;

  const title = (kind==="expense") ? "Расход" : "Доход";
  const pct = Math.round(e.pct);
  box.innerHTML = `
    <div class="kpiItem"><div class="k">Категория</div><div class="v">${esc(e.name)}</div></div>
    <div class="kpiItem"><div class="k">${esc(title)}</div><div class="v">${ruMoney(e.val)}</div></div>
    <div class="kpiItem"><div class="k">Доля</div><div class="v">${pct}%</div></div>
  `;
}

function drawSubcategoryChart(canvas, rows){
  const ctx = canvas.getContext("2d");
  const DPR = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.floor(w*DPR);
  canvas.height = Math.floor(h*DPR);
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.clearRect(0,0,w,h);

  if (!rows.length){
    ctx.fillStyle = "rgba(255,255,255,.60)";
    ctx.font = "14px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Нет данных", w/2, h/2);
    return;
  }

  const pad = 12;
  const topPad = 18;
  const chartW = w - pad*2;
  const chartH = h - topPad - 18;
  const maxVal = Math.max(1, ...rows.map(r=>r.val));

  const barH = Math.max(10, Math.min(18, chartH / rows.length - 6));
  const gap = 8;

  ctx.font = "12px Inter, system-ui, sans-serif";
  for (let i=0;i<rows.length;i++){
    const y = topPad + i*(barH+gap);
const frac = rows[i].val / maxVal;

// Разметка строки: [label | bar | value]
const labelW = Math.min(220, Math.max(120, Math.round(chartW * 0.38)));
const valueW = 90;     // место справа под "2 853 ₽"
const barGap  = 12;    // отступ перед значением

const bx = pad + labelW;
const barMaxW = Math.max(40, (w - pad) - valueW - barGap - bx);
const bw = Math.max(2, frac * barMaxW);

// bar
ctx.fillStyle = "rgba(87,166,255,.85)";
ctx.fillRect(bx, y, bw, barH);

    // value
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,.70)";
    ctx.fillText(ruMoney(rows[i].val), w - pad - 4, y + barH - 2);
  }
}

function renderTopCategories(curOps){
  const elE = $("#top-expense");
  const elI = $("#top-income");
  if (!elE || !elI) return;
  const exp = curOps.filter(o=>o.type==="expense");
  const inc = curOps.filter(o=>o.type==="income");
  const top5 = (ops)=>{
    const byCat = {};
    for (const o of ops){
      const k = String(o.categoryId||"");
      byCat[k] = (byCat[k]||0) + Number(o.amount||0);
    }
    return Object.entries(byCat)
      .map(([cid,val])=>({cid,val, name: (catById(cid)?.name || "Без категории")}))
      .sort((a,b)=>b.val-a.val)
      .slice(0,5);
  };

  const topE = top5(exp);
  const topI = top5(inc);

  elE.innerHTML = topE.length ? topE.map((x,i)=>`
    <div class="item">
      <div class="left">
        <div class="t">${i+1}. ${esc(x.name)}</div>
        <div class="d">Сумма: ${ruMoney(x.val)}</div>
      </div>
      <div class="right"><span class="tag expense">расход</span></div>
    </div>
  `).join("") : `<div class="muted">Нет расходов в выбранном периоде.</div>`;

  elI.innerHTML = topI.length ? topI.map((x,i)=>`
    <div class="item">
      <div class="left">
        <div class="t">${i+1}. ${esc(x.name)}</div>
        <div class="d">Сумма: ${ruMoney(x.val)}</div>
      </div>
      <div class="right"><span class="tag income">доход</span></div>
    </div>
  `).join("") : `<div class="muted">Нет доходов в выбранном периоде.</div>`;
}

function renderSubcategoryDashboard(curOps){
  const sel = $("#dash-subcat-category");
  const listEl = $("#subcat-list");
  if (!sel || !listEl) return;

  const cats = state.categories
    .filter(c => c.type==="expense" || c.type==="income")
    .sort((a,b)=>(a.type||"").localeCompare(b.type||"") || (a.name||"").localeCompare(b.name||""));

  sel.innerHTML = cats.map(c=>{
    const prefix = c.type==="expense" ? "Расход · " : "Доход · ";
    return `<option value="${esc(c.id)}">${esc(prefix + c.name)}</option>`;
  }).join("") || `<option value="">— нет категорий —</option>`;

  if (!state.ui.dashSubcatCategoryId && cats[0]) state.ui.dashSubcatCategoryId = cats[0].id;
  if (state.ui.dashSubcatCategoryId) sel.value = String(state.ui.dashSubcatCategoryId);

  const catId = sel.value || "";
  state.ui.dashSubcatCategoryId = catId;

  const cat = catById(catId);
  if (!catId || !cat){
    listEl.innerHTML = `<div class="muted">Выбери категорию.</div>`;

    return;
  }

  const ops = curOps.filter(o => String(o.categoryId)===String(catId) && String(o.type)===String(cat.type));
  const bySub = {};
  for (const o of ops){
    const key = String(o.subcategoryId || "");
    bySub[key] = (bySub[key]||0) + Number(o.amount||0);
  }

  const rows = Object.entries(bySub)
    .map(([sid,val])=>{
      const sc = sid ? subcatById(sid) : null;
      return { id: sid, name: sc?.name || (sid ? "Подкатегория" : "Без подкатегории"), val };
    })
    .sort((a,b)=>b.val-a.val)
    .slice(0,10);

  // chart отключён: оставляем только список (без canvas)

  const totalVal = sum(rows.map(r=>Number(r.val||0)));
  const maxVal = Math.max(0, ...rows.map(r=>Number(r.val||0)));

  listEl.innerHTML = rows.length ? rows.map((r,i)=>{
    const pct = totalVal>0 ? Math.round((r.val/totalVal)*100) : 0;
    const w = maxVal>0 ? Math.round((r.val/maxVal)*100) : 0;
    return `
      <div class="item">
        <div class="left">
          <div class="subrow">
            <div class="subrowTop">
              <div class="subrowName">${i+1}. ${esc(r.name)}</div>
              <div class="subrowMeta">${ruMoney(r.val)} · ${pct}%</div>
            </div>
            <div class="subbar"><i style="width:${w}%"></i></div>
          </div>
        </div>
        <div class="right"><span class="tag ${cat.type}">${cat.type==="expense"?"расход":"доход"}</span></div>
      </div>
    `;
  }).join("") : `<div class="muted">Нет операций по выбранной категории в периоде.</div>`;
}


function renderCurrencyStructure(){
  const box = $("#currency-structure");
  if (!box) return;

  if (!state.accounts.length){
    box.innerHTML = `<div class="muted">Счета не заданы.</div>`;
    return;
  }

  // Считаем остаток по каждому счёту: стартовый баланс + доходы - расходы + переводы
  const balByAcc = {};
  for (const a of state.accounts){
    balByAcc[String(a.id)] = Number(a.balance ?? a.startBalance ?? 0);
  }

  for (const o of state.operations){
    const t = String(o.type || "");
    const amt = Number(o.amount || 0);

    if (t === "income" || t === "expense"){
      const accId = String(o.accountId || "");
      if (!accId || !(accId in balByAcc)) continue;
      if (t === "income") balByAcc[accId] += amt;
      else balByAcc[accId] -= amt;
      continue;
    }

    if (t === "transfer"){
      const fromId = String(o.fromAccountId || o.accountId || "");
      const toId   = String(o.toAccountId || "");
      const amtTo  = Number(o.amountTo || 0);
      if (fromId && (fromId in balByAcc)) balByAcc[fromId] -= amt;
      if (toId   && (toId   in balByAcc)) balByAcc[toId]   += (amtTo || 0);
      continue;
    }
  }

  // П7: суммарный положительный баланс всех счетов — для расчёта доли
  const totalPositive = Object.values(balByAcc).reduce((s, v) => s + Math.max(0, v), 0);

  const groups = {};
  for (const a of state.accounts){
    const cur = a.currency || "RUB";
    (groups[cur] ||= []).push({
      id: a.id,
      name: a.name || "Счёт",
      val: balByAcc[String(a.id)] ?? 0
    });
  }

  const order = ["RUB","USD","EUR","CNY"];
  const curs = Object.keys(groups).sort((a,b)=> (order.indexOf(a) - order.indexOf(b)));

  /**
   * П7: вычисляет inline-стили border + background для .item счёта
   *  - val > 0  → зелёный, интенсивность пропорциональна доле от totalPositive
   *  - val === 0 → оранжевый border
   *  - val < 0  → красный border
   */
  function accItemStyle(val){
    if (val > 0){
      const ratio = totalPositive > 0 ? Math.min(1, val / totalPositive) : 0;
      // alpha от 0.10 (маленькая доля) до 0.45 (большая доля)
      const bgAlpha     = 0.07 + ratio * 0.33;
      const borderAlpha = 0.25 + ratio * 0.55;
      return `border-color:rgba(65,211,141,${borderAlpha.toFixed(2)});background:rgba(65,211,141,${bgAlpha.toFixed(2)});`;
    }
    if (val === 0){
      return `border-color:rgba(255,204,102,0.55);background:rgba(255,204,102,0.07);`;
    }
    // val < 0
    return `border-color:rgba(255,91,110,0.60);background:rgba(255,91,110,0.09);`;
  }

  const html = curs.map(cur=>{
    const rows = groups[cur].slice().sort((a,b)=>b.val-a.val);
    const total = rows.reduce((s,r)=>s+r.val, 0);
    const items = rows.map(r=>{
      const style = accItemStyle(r.val);
      const valColor = r.val > 0
        ? "color:rgba(65,211,141,.95)"
        : r.val < 0
          ? "color:rgba(255,91,110,.95)"
          : "color:rgba(255,204,102,.95)";
      return `
        <div class="item" style="padding:10px 12px;${style}">
          <div class="left">
            <div class="t">${esc(r.name)}</div>
          </div>
          <div class="right">
            <div style="font-weight:900;font-size:15px;${valColor}">${ruMoney(r.val, cur)}</div>
          </div>
        </div>
      `;
    }).join("");

    return `
      <div style="margin:10px 0 6px;color:var(--muted);font-weight:900;font-size:12px;letter-spacing:.3px">${esc(cur)} · Итого: ${ruMoney(total, cur)}</div>
      <div class="list" style="gap:6px">${items || `<div class="muted">Нет счетов.</div>`}</div>
    `;
  }).join("");

  box.innerHTML = html || `<div class="muted">Нет данных.</div>`;
}


document.addEventListener("change", (e)=>{
  if (e.target && e.target.id==="dash-subcat-category"){
    state.ui.dashSubcatCategoryId = e.target.value || "";
    if ($("#page-dashboard").classList.contains("active")) renderDashboard();
  }
});


/**
 * ============================
 *  GOALS + MOTIVATION
 * ============================
 */
function renderGoals(){
  // goals list
  if (!state.goals.length){
    $("#goals-list").innerHTML = `<div class="muted">Целей пока нет. Нажми «+ Цель».</div>`;
  } else {
        const goalsSorted = [...state.goals].sort((a,b)=>{
      const ta = a.deadline ? Date.parse(a.deadline) : Infinity;
      const tb = b.deadline ? Date.parse(b.deadline) : Infinity;
      if (ta !== tb) return ta - tb;
      return String(a.name||"").localeCompare(String(b.name||""), "ru");
    });

    $("#goals-list").innerHTML = goalsSorted.map(g=>{

      const target = Number(g.target||0);
      const saved = Number(g.saved||0);
      const pct = target>0 ? clamp((saved/target)*100, 0, 100) : 0;
      const d = g.deadline ? new Date(g.deadline) : null;
      const left = Math.max(0, target - saved);
      return `
        <div class="item">
          <div class="left">
            <div class="t">${esc(g.name||"Цель")}</div>
            <div class="d">${ruMoney(saved)} / ${ruMoney(target)} · ${d ? ("до "+d.toLocaleDateString("ru-RU")) : "без дедлайна"}</div>
            <div class="progress"><i style="width:${pct}%; background: rgba(87,166,255,.85)"></i></div>
            <div class="d">Осталось: ${ruMoney(left)}</div>
          </div>
          <div class="right" style="align-items:center">
            <button class="icon-btn edit" aria-label="Редактировать"
            onclick="openGoalEdit('${esc(g.id)}')">⚙️</button>

            <button class="icon-btn danger" aria-label="Удалить"
      onclick="deleteGoalConfirm('${esc(g.id)}')">✕</button>
  </div>

        </div>
      `;
    }).join("");
  }

  // motivation: current avg monthly income from last 30 days incomes
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate()-29); from.setHours(0,0,0,0);
  const to = new Date(now); to.setHours(23,59,59,999);
  const ops = opsInRange(from,to).filter(o=>o.type==="income");
  const totalIncome30 = sum(ops.map(o=>Number(o.amount||0)));
  const curMonthly = Math.round(totalIncome30); // simple approx for MVP
  $("#mot-cur").textContent = ruMoney(curMonthly);

  // next stage
  const stages = [...state.stages].sort((a,b)=>Number(a.amount)-Number(b.amount));
  const next = stages.find(s=>Number(s.amount) > curMonthly) || stages[stages.length-1];
  $("#mot-next").textContent = next ? `${next.name} · ${ruMoney(next.amount)}` : "—";
  const gap = next ? Math.max(0, Number(next.amount)-curMonthly) : 0;
  $("#mot-gap").textContent = ruMoney(gap);

  drawMotivationBar($("#motivation-bar"), stages, curMonthly);
}

function drawMotivationBar(canvas, stages, current){
  const ctx = canvas.getContext("2d");
  const DPR = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.floor(w*DPR);
  canvas.height = Math.floor(h*DPR);
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.clearRect(0,0,w,h);

  if (!stages.length){
    ctx.fillStyle="rgba(255,255,255,.65)";
    ctx.font="14px Inter, system-ui, sans-serif";
    ctx.textAlign="center";
    ctx.fillText("Нет этапов шкалы", w/2, h/2);
    return;
  }

  const min = Number(stages[0].amount);
  const max = Number(stages[stages.length-1].amount);
  const padY = 16;

  const isMobile = w <= 420;

  // Helper: fit long labels to canvas width (single line with ellipsis)
  function ellipsize(text, maxWidth){
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ell = "…";
    let lo = 0, hi = text.length;
    while (lo < hi){
      const mid = Math.floor((lo + hi) / 2);
      const s = text.slice(0, mid) + ell;
      if (ctx.measureText(s).width <= maxWidth) lo = mid + 1;
      else hi = mid;
    }
    const cut = Math.max(0, lo - 1);
    return text.slice(0, cut) + ell;
  }

  // Layout: desktop — текущий текст слева, подписи справа; mobile — компактнее
  const leftTextW = isMobile ? 0 : Math.min(170, Math.max(110, w*0.32));
  const barW = isMobile ? Math.min(72, w*0.22) : Math.min(90, w*0.18);
  const barX = (isMobile ? 22 : leftTextW) + barW/2;
  const labelsX = barX + (barW/2) + (isMobile ? 12 : 18);
  const currentX = barX - (barW/2) - (isMobile ? 0 : 18);

  const barTop = padY + 10;
  const barBottom = h - padY - 10;
  const barH = barBottom - barTop;

  // background
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(barX, barBottom);
  ctx.lineTo(barX, barTop);
  ctx.stroke();

  // fill to current
  const curClamped = clamp(current, min, max);
  const frac = (curClamped - min) / Math.max(1,(max-min));
  const yCur = barBottom - frac * barH;

  ctx.strokeStyle = "rgba(87,166,255,.90)";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(barX, barBottom);
  ctx.lineTo(barX, yCur);
  ctx.stroke();

  // markers for stages + labels on right
  const fontSize = isMobile ? 10 : 12;
  ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "left";

  for (let i=0;i<stages.length;i++){
    const amt = Number(stages[i].amount);
    const f = (amt - min)/Math.max(1,(max-min));
    const y = barBottom - f*barH;

    // marker
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.beginPath();
    ctx.arc(barX, y, 4, 0, 2*Math.PI);
    ctx.fill();

    // label
    ctx.fillStyle = "rgba(255,255,255,.78)";
    const name = stages[i].name || "Этап";
    const label = `${name} — ${ruMoney(amt)}`;
    const maxW = Math.max(60, w - labelsX - 8);
    ctx.fillText(ellipsize(label, maxW), labelsX, y+4);
  }

  // current marker + label
  ctx.fillStyle = "rgba(65,211,141,.95)";
  ctx.beginPath();
  ctx.arc(barX, yCur, 6, 0, 2*Math.PI);
  ctx.fill();

  ctx.fillStyle = "rgba(65,211,141,.95)";
  if (isMobile){
    // on narrow screens keep "Сейчас" readable and prevent clipping
    ctx.textAlign = "center";
    ctx.fillText(`Сейчас — ${ruMoney(current)}`, w/2, Math.min(h-8, yCur + 18));
  } else {
    ctx.textAlign = "right";
    ctx.fillText(`Сейчас — ${ruMoney(current)}`, currentX, yCur + 4);
  }
}

$("#btn-new-goal").addEventListener("click", ()=>openGoalEdit(null));

function openGoalEdit(id){
  const g = id ? state.goals.find(x=>String(x.id)===String(id)) : null;
  const html = `
    <div class="field">
      <label>Название</label>
      <input id="g-name" value="${escAttr(g?.name||"")}" placeholder="Например: отпуск, подушка, техника" />
    </div>
    <div class="row">
      <div class="field">
        <label>Цель (сумма)</label>
        <input id="g-target" type="number" value="${escAttr(g?.target||"")}" placeholder="0" />
      </div>
      <div class="field">
        <label>Накоплено</label>
        <input id="g-saved" type="number" value="${escAttr(g?.saved||"")}" placeholder="0" />
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Дедлайн</label>
        <input id="g-deadline" type="date" value="${escAttr(g?.deadline ? isoDate(g.deadline) : "")}" />
      </div>
      <div class="field">
        <label>Счёт (необязательно)</label>
        <select id="g-acc">
          <option value="">—</option>
          ${state.accounts.map(a=>`<option value="${esc(a.id)}" ${String(a.id)===String(g?.accountId||"")?"selected":""}>${esc(a.name)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="row">
      <button class="btn" id="g-save">Сохранить</button>
      <button class="btn secondary" id="g-cancel">Отмена</button>
      <button class="help-btn" data-help="Рекомендации по ежемесячному накоплению отображаются в разделе «Пульт → План накоплений»." aria-label="Подсказка" style="flex:0 0 auto">❓</button>
    </div>
  `;
  openModal(g ? "Редактировать цель" : "Новая цель", html);
  $("#g-cancel").addEventListener("click", closeModal, {once:true});
  $("#g-save").addEventListener("click", async ()=>{
    const data = {
      id: g?.id || null,
      name: $("#g-name").value.trim(),
      target: Number($("#g-target").value||0),
      saved: Number($("#g-saved").value||0),
      deadline: $("#g-deadline").value || "",
      accountId: $("#g-acc").value || ""
    };
    if (!data.name){ toast("Цель", "Укажи название", "warn", 2000); return; }
    if (!data.target || data.target<=0){ toast("Цель", "Цель (сумма) должна быть > 0", "warn", 2200); return; }

    try{
      toast("Цели", "Сохраняю…", "info", 0);
      await apiPost("upsertGoal", data);
      closeModal();
      await syncAll("goalSave");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}

function deleteGoalConfirm(id){
  const g = state.goals.find(x=>String(x.id)===String(id));
  if (!g) return;
  const html = `
    <div class="muted" style="margin-bottom:12px">
      Удалить цель «${esc(g.name||"") }»?
    </div>
    <div class="row">
      <button class="btn danger" id="yes">Удалить</button>
      <button class="btn secondary" id="no">Отмена</button>
    </div>
  `;
  openModal("Подтверждение", html);
  $("#no").addEventListener("click", closeModal, {once:true});
  $("#yes").addEventListener("click", async ()=>{
    try{
      toast("Цели", "Удаляю…", "info", 0);
      await apiPost("deleteGoal", { id });
      closeModal();
      await syncAll("goalDelete");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}

/**
 * ============================
 *  SETTINGS
 * ============================
 */
function renderSettings(){
  // categories list
  const cats = [...state.categories].sort((a,b)=>(a.type||"").localeCompare(b.type||"") || (a.name||"").localeCompare(b.name||""));
  $("#cats-list").innerHTML = cats.length ? cats.map(c=>`
    <div class="item">
      <div class="left">
        <div class="t">${esc(c.name)} <span class="tag ${esc(c.type)}" style="margin-left:8px">${c.type==="expense"?"расход":c.type==="income"?"доход":"перевод"}</span></div>
        <div class="d">ID: ${esc(String(c.id))}</div>
      </div>
      <div class="right">
        <button class="icon-btn edit" aria-label="Редактировать" onclick="openCategoryEditor('${esc(c.id)}')">⚙️</button>
        <button class="btn inline small danger" onclick="deleteCategoryConfirm('${esc(c.id)}')">✕</button>
      </div>
    </div>
  `).join("") : `<div class="muted">Категорий пока нет. Добавь первую.</div>`;


  // subcategories list
  const subcats = [...state.subcategories].sort((a,b)=>{
    const ca = catById(a.categoryId);
    const cb = catById(b.categoryId);
    return (ca?.type||"").localeCompare(cb?.type||"") ||
           (ca?.name||"").localeCompare(cb?.name||"") ||
           (a.name||"").localeCompare(b.name||"");
  });

  $("#subcats-list").innerHTML = subcats.length ? subcats.map(sc=>{
    const parent = catById(sc.categoryId);
    const parentLbl = parent ? `${parent.type==="expense"?"Расход":"Доход"} · ${parent.name}` : "Без категории";
    return `
      <div class="item">
        <div class="left">
          <div class="t">${esc(sc.name)} <span class="tag" style="margin-left:8px">${esc(parentLbl)}</span></div>
          <div class="d">ID: ${esc(String(sc.id))}</div>
        </div>
        <div class="right">
          <button class="icon-btn edit" aria-label="Редактировать" onclick="openSubcategoryEditor('${esc(sc.id)}')">⚙️</button>
          <button class="btn inline small danger" onclick="deleteSubcategoryConfirm('${esc(sc.id)}')">✕</button>
        </div>
      </div>
    `;
  }).join("") : `<div class="muted">Подкатегорий пока нет. Добавь первую и привяжи к категории.</div>`;

  // accounts list
  const accs = [...state.accounts].sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const accHint = accs.length ? accs.map(a=>`
    <div class="item">
      <div class="left">
        <div class="t">${esc(a.name)} <span class="tag">${esc((a.currency||"RUB"))}</span> <span class="tag">${esc(a.kind||"")}</span></div>
        <div class="d">ID: ${esc(String(a.id))}</div>
      </div>
      <div class="right">
        <button class="icon-btn edit" aria-label="Редактировать" onclick="openAccountEditor('${esc(a.id)}')">⚙️</button>
        <button class="btn inline small danger" onclick="deleteAccountConfirm('${esc(a.id)}')">✕</button>
      </div>
    </div>
  `).join("") : `<div class="muted">Счетов пока нет. Добавь первый (например «Карта», «Наличные»).</div>`;
  const accEl = $("#accounts-list");
  if (accEl) accEl.innerHTML = accHint;
  ensureToggle("accounts-list");


  // limits settings list for current month
  const month = yyyymm(new Date());
  const lms = state.limits.filter(l=>String(l.month)===String(month));
  const byCat = {};
  lms.forEach(l=>byCat[String(l.categoryId)] = l);

  const expCats = state.categories.filter(c=>c.type==="expense");
  $("#limits-settings").innerHTML = expCats.length ? expCats.map(c=>{
    const lim = byCat[String(c.id)];
    return `
      <div class="item">
        <div class="left">
          <div class="t">${esc(c.name)}</div>
          <div class="d">Месяц: ${month} · Лимит: ${lim ? ruMoney(lim.amount) : "не задан"}</div>
        </div>
        <div class="right">
          <button class="icon-btn edit" aria-label="Настроить лимит" onclick="openLimitEditor({id:'${esc(lim?.id||"")}', categoryId:'${esc(c.id)}', month:'${month}', amount:'${esc(lim?.amount||"")}'}, 'Лимит: ${esc(c.name)}')">⚙️</button>
        </div>
      </div>
    `;
  }).join("") : `<div class="muted">Сначала добавь категории расходов.</div>`;

  // stages list
  $("#stages-list").innerHTML = state.stages.length ? state.stages.map(s=>`
    <div class="item">
      <div class="left">
        <div class="t">${esc(s.name)} — ${ruMoney(s.amount)}</div>
        <div class="d">ID: ${esc(String(s.id))}</div>
      </div>
      <div class="right">
        <button class="icon-btn edit" aria-label="Редактировать" onclick="openStageEditor('${esc(s.id)}')">⚙️</button>
        <button class="btn inline small danger" onclick="deleteStageConfirm('${esc(s.id)}')">✕</button>
      </div>
    </div>
  `).join("") : `<div class="muted">Этапов нет. Добавь минимум «Стабильность» и «Цель 2026».</div>`;

  // quotes list
  $("#quotes-list").innerHTML = state.quotes.length ? state.quotes.map(q=>`
    <div class="item">
      <div class="left">
        <div class="t">“${esc(q.text)}”</div>
        <div class="d">${esc(q.author||"")}</div>
      </div>
      <div class="right">
        <button class="icon-btn edit" aria-label="Редактировать" onclick="openQuoteEditor('${esc(q.id)}')">⚙️</button>
        <button class="btn inline small danger" onclick="deleteQuoteConfirm('${esc(q.id)}')">✕</button>
      </div>
    </div>
  `).join("") : `<div class="muted">Цитат нет. Добавь несколько.</div>`;

  // collapsible controls (show first 7, rest behind toggle)
  ensureToggle("cats-list");
  ensureToggle("subcats-list");
  ensureToggle("accounts-list");
  ensureToggle("limits-settings");
  ensureToggle("stages-list");
  ensureToggle("quotes-list");

  // update selects for Pult
  renderSelects();
}

$("#btn-new-cat").addEventListener("click", ()=>openCategoryEditor(null));
$("#btn-new-acc").addEventListener("click", ()=>openAccountEditor(null));
$("#btn-new-limit").addEventListener("click", ()=>openLimitEditor({id:null, categoryId:"", month: yyyymm(new Date()), amount:""}, "Новый лимит"));
$("#btn-new-stage").addEventListener("click", ()=>openStageEditor(null));
$("#btn-new-quote").addEventListener("click", ()=>openQuoteEditor(null));
$("#btn-new-subcat").addEventListener("click", ()=>openSubcategoryEditor(null));

function openCategoryEditor(id){
  const c = id ? state.categories.find(x=>String(x.id)===String(id)) : null;
  const html = `
    <div class="field">
      <label>Название</label>
      <input id="c-name" value="${escAttr(c?.name||"")}" placeholder="Например: Еда, Транспорт" />
    </div>
    <div class="field">
      <label>Тип</label>
      <select id="c-type">
        <option value="expense" ${c?.type==="expense"?"selected":""}>Расход</option>
        <option value="income" ${c?.type==="income"?"selected":""}>Доход</option>
        <option value="transfer" ${c?.type==="transfer"?"selected":""}>Перевод</option>
      </select>
    </div>
    <div class="row">
      <button class="btn" id="c-save">Сохранить</button>
      <button class="btn secondary" id="c-cancel">Отмена</button>
      <button class="help-btn" data-help="После сохранения категория появится в форме «Новая операция» на Пульте." aria-label="Подсказка" style="flex:0 0 auto">❓</button>
    </div>
  `;
  openModal(c ? "Редактировать категорию" : "Новая категория", html);
  $("#c-cancel").addEventListener("click", closeModal, {once:true});
  $("#c-save").addEventListener("click", async ()=>{
    const name = $("#c-name").value.trim();
    const type = $("#c-type").value;
    if (!name){ toast("Категории", "Укажи название", "warn", 2000); return; }
    try{
      toast("Категории", "Сохраняю…", "info", 0);
      await apiPost("upsertCategory", { id: c?.id || null, name, type });
      closeModal();
      await syncAll("catSave");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}
function deleteCategoryConfirm(id){
  const c = state.categories.find(x=>String(x.id)===String(id));
  if (!c) return;
  const html = `
    <div class="muted" style="margin-bottom:12px">
      Удалить категорию «${esc(c.name)}»?
      <div style="margin-top:8px; font-size:12px; color:var(--warn)">⚠️ Если в операциях есть эта категория, они могут стать «Без категории».</div>
    </div>
    <div class="row">
      <button class="btn danger" id="yes">Удалить</button>
      <button class="btn secondary" id="no">Отмена</button>
    </div>
  `;
  openModal("Подтверждение", html);
  $("#no").addEventListener("click", closeModal, {once:true});
  $("#yes").addEventListener("click", async ()=>{
    try{
      toast("Категории", "Удаляю…", "info", 0);
      await apiPost("deleteCategory", { id });
      closeModal();
      await syncAll("catDelete");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}


function openSubcategoryEditor(id){
  const sc = id ? state.subcategories.find(x=>String(x.id)===String(id)) : null;

  const allowedCats = state.categories
    .filter(c=>c.type==="expense" || c.type==="income")
    .sort((a,b)=>(a.type||"").localeCompare(b.type||"") || (a.name||"").localeCompare(b.name||""));

  const html = `
    <div class="field">
      <label>Подкатегория</label>
      <input id="sc-name" value="${escAttr(sc?.name||"")}" placeholder="Например: Кафе, Продукты, Такси" />
    </div>
    <div class="field">
      <label>Категория-родитель</label>
      <select id="sc-cat">
        ${allowedCats.map(c=>{
          const prefix = c.type==="expense" ? "Расход · " : "Доход · ";
          const sel = String(c.id)===String(sc?.categoryId||"") ? "selected" : "";
          return `<option value="${esc(c.id)}" ${sel}>${esc(prefix + c.name)}</option>`;
        }).join("")}
      </select>
    </div>
    <div class="row">
      <button class="btn" id="sc-save">Сохранить</button>
      <button class="btn secondary" id="sc-cancel">Отмена</button>
      <button class="help-btn" data-help="Подкатегории используются при добавлении операции: выбирается «Категория + Подкатегория»." aria-label="Подсказка" style="flex:0 0 auto">❓</button>
    </div>
  `;
  openModal(sc ? "Редактировать подкатегорию" : "Новая подкатегория", html);
  $("#sc-cancel").addEventListener("click", closeModal, {once:true});
  $("#sc-save").addEventListener("click", async ()=>{
    const name = $("#sc-name").value.trim();
    const categoryId = $("#sc-cat").value || "";
    if (!name){ toast("Подкатегории", "Укажи название", "warn", 2000); return; }
    if (!categoryId){ toast("Подкатегории", "Выбери категорию-родитель", "warn", 2000); return; }
    try{
      toast("Подкатегории", "Сохраняю…", "info", 0);
      await apiPost("upsertSubcategory", { id: sc?.id || null, name, categoryId });
      closeModal();
      await syncAll("subcatSave");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}

function deleteSubcategoryConfirm(id){
  const sc = state.subcategories.find(x=>String(x.id)===String(id));
  if (!sc) return;
  const parent = catById(sc.categoryId);
  const html = `
    <div class="muted" style="margin-bottom:12px">
      Удалить подкатегорию «${esc(sc.name)}»?
      <div style="margin-top:8px; font-size:12px; color:var(--warn)">⚠️ Категория: ${esc(parent?.name||"—")}. Операции с этой подкатегорией станут «без подкатегории».</div>
    </div>
    <div class="row">
      <button class="btn danger" id="yes">Удалить</button>
      <button class="btn secondary" id="no">Отмена</button>
    </div>
  `;
  openModal("Подтверждение", html);
  $("#no").addEventListener("click", closeModal, {once:true});
  $("#yes").addEventListener("click", async ()=>{
    try{
      toast("Подкатегории", "Удаляю…", "info", 0);
      await apiPost("deleteSubcategory", { id });
      closeModal();
      await syncAll("subcatDelete");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}

function openAccountEditor(id){
  const a = id ? state.accounts.find(x=>String(x.id)===String(id)) : null;
  const html = `
    <div class="field">
      <label>Название счёта</label>
      <input id="a-name" value="${escAttr(a?.name||"")}" placeholder="Например: Карта, Наличные, Вклад" />
    </div>
    <div class="field">
      <label>Тип (необязательно)</label>
      <select id="a-kind">
        <option value="" ${!a?.kind?"selected":""}>—</option>
        <option value="card" ${a?.kind==="card"?"selected":""}>Карта</option>
        <option value="cash" ${a?.kind==="cash"?"selected":""}>Наличные</option>
        <option value="bank" ${a?.kind==="bank"?"selected":""}>Банк/Вклад</option>
        <option value="other" ${a?.kind==="other"?"selected":""}>Другое</option>
      </select>
    </div>
    <div class="field">
      <label>Валюта счёта</label>
      <select id="a-currency">
        <option value="RUB">RUB · ₽</option>
        <option value="USD">USD · $</option>
        <option value="EUR">EUR · €</option>
        <option value="CNY">CNY · ¥</option>
      </select>
    </div>
    <div class="row">
      <button class="btn" id="a-save">Сохранить</button>
      <button class="btn secondary" id="a-cancel">Отмена</button>
      <button class="help-btn" data-help="После сохранения счёт появится в выборе «Счёт» при добавлении операции и в разделе аналитики." aria-label="Подсказка" style="flex:0 0 auto">❓</button>
    </div>
  `;
  openModal(a ? "Редактировать счёт" : "Новый счёт", html);
  const curSel = $("#a-currency");
  if (curSel) curSel.value = (a?.currency || 'RUB');

  $("#a-cancel").addEventListener("click", closeModal, {once:true});
  $("#a-save").addEventListener("click", async ()=>{
    const name = $("#a-name").value.trim();
    const kind = $("#a-kind").value || "";
    const currency = $("#a-currency")?.value || 'RUB';
    if (!name){ toast("Укажи название счёта"); return; }
    try{
      const res = await apiPost("upsertAccount", { id: a?.id || "", name, kind, currency });
      // update local state from response if provided, else re-sync
      if (res?.account){
        const idx = state.accounts.findIndex(x=>String(x.id)===String(res.account.id));
        if (idx >= 0) state.accounts[idx] = res.account; else state.accounts.push(res.account);
      } else {
        await syncAll();
      }
      closeModal();
      renderSettings();
      renderSelects();
      toast("Счёт сохранён");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}

function deleteAccountConfirm(id){
  const a = state.accounts.find(x=>String(x.id)===String(id));
  if (!a){ toast("Счёт не найден"); return; }
  // Prevent deleting account used in operations/goals (soft check)
  const usedOp = state.operations.some(o=>String(o.accountId)===String(id));
  const usedGoal = state.goals.some(g=>String(g.accountId)===String(id));
  const warn = (usedOp || usedGoal) ? `<div style="margin-top:8px; font-size:12px; color:var(--warn)">⚠️ Этот счёт используется в операциях или целях. Рекомендуем сначала перенести данные на другой счёт.</div>` : "";
  const html = `
    <div class="muted" style="margin-bottom:12px">
      Удалить счёт <b>${esc(a.name)}</b>?
    </div>
    ${warn}
    <div class="row" style="margin-top:12px">
      <button class="btn danger" id="a-del">Удалить</button>
      <button class="btn secondary" id="a-cancel2">Отмена</button>
    </div>
  `;
  openModal("Удаление счёта", html);
  $("#a-cancel2").addEventListener("click", closeModal, {once:true});
  $("#a-del").addEventListener("click", async ()=>{
    try{
      await apiPost("deleteAccount", { id });
      state.accounts = state.accounts.filter(x=>String(x.id)!==String(id));
      // if selected in form - reset select will happen in renderSelects
      closeModal();
      renderSettings();
      renderSelects();
      toast("Счёт удалён");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}


function openLimitEditor(lim, title="Лимит"){
  const month = lim.month || yyyymm(new Date());
  const expCats = state.categories.filter(c=>c.type==="expense");
  const html = `
    <div class="field">
      <label>Категория (расход)</label>
      <select id="l-cat">
        ${expCats.map(c=>`<option value="${esc(c.id)}" ${String(c.id)===String(lim.categoryId)?"selected":""}>${esc(c.name)}</option>`).join("")}
      </select>
    </div>
    <div class="row">
      <div class="field">
        <label>Месяц</label>
        <input id="l-month" value="${escAttr(month)}" placeholder="YYYY-MM" />
      </div>
      <div class="field">
        <label>Лимит (₽)</label>
        <input id="l-amount" type="number" value="${escAttr(lim.amount||"")}" placeholder="0" />
      </div>
    </div>
    <div class="row">
      <button class="btn" id="l-save">Сохранить</button>
      <button class="btn secondary" id="l-cancel">Отмена</button>
      <button class="help-btn" data-help="Лимит задаётся на конкретный месяц (YYYY-MM) и категорию расходов. Чтобы отключить лимит — поставь 0." aria-label="Подсказка" style="flex:0 0 auto">❓</button>
    </div>
  `;
  openModal(title, html);
  $("#l-cancel").addEventListener("click", closeModal, {once:true});
  $("#l-save").addEventListener("click", async ()=>{
    const categoryId = $("#l-cat").value;
    const month = $("#l-month").value.trim();
    const amount = Number($("#l-amount").value||0);
    if (!categoryId){ toast("Лимиты", "Выбери категорию", "warn", 2000); return; }
    if (!/^\d{4}-\d{2}$/.test(month)){ toast("Лимиты", "Месяц в формате YYYY-MM", "warn", 2200); return; }
    try{
      toast("Лимиты", "Сохраняю…", "info", 0);
      await apiPost("upsertLimit", { id: lim.id || null, categoryId, month, amount });
      closeModal();
      await syncAll("limitSave");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}

function openStageEditor(id){
  const s = id ? state.stages.find(x=>String(x.id)===String(id)) : null;
  const html = `
    <div class="field">
      <label>Название этапа</label>
      <input id="s-name" value="${escAttr(s?.name||"")}" placeholder="Например: Стабильность" />
    </div>
    <div class="field">
      <label>Сумма (среднемесячный доход, ₽)</label>
      <input id="s-amount" type="number" value="${escAttr(s?.amount||"")}" placeholder="150000" />
    </div>
    <div class="row">
      <button class="btn" id="s-save">Сохранить</button>
      <button class="btn secondary" id="s-cancel">Отмена</button>
    </div>
  `;
  openModal(s ? "Редактировать этап" : "Новый этап", html);
  $("#s-cancel").addEventListener("click", closeModal, {once:true});
  $("#s-save").addEventListener("click", async ()=>{
    const name = $("#s-name").value.trim();
    const amount = Number($("#s-amount").value||0);
    if (!name){ toast("Этапы", "Укажи название", "warn", 2000); return; }
    if (!amount || amount<=0){ toast("Этапы", "Сумма должна быть > 0", "warn", 2200); return; }
    try{
      toast("Этапы", "Сохраняю…", "info", 0);
      await apiPost("upsertStage", { id: s?.id || null, name, amount });
      closeModal();
      await syncAll("stageSave");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}
function deleteStageConfirm(id){
  const s = state.stages.find(x=>String(x.id)===String(id));
  if (!s) return;
  const html = `
    <div class="muted" style="margin-bottom:12px">
      Удалить этап «${esc(s.name)}»?
    </div>
    <div class="row">
      <button class="btn danger" id="yes">Удалить</button>
      <button class="btn secondary" id="no">Отмена</button>
    </div>
  `;
  openModal("Подтверждение", html);
  $("#no").addEventListener("click", closeModal, {once:true});
  $("#yes").addEventListener("click", async ()=>{
    try{
      toast("Этапы", "Удаляю…", "info", 0);
      await apiPost("deleteStage", { id });
      closeModal();
      await syncAll("stageDelete");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}

function openQuoteEditor(id){
  const q = id ? state.quotes.find(x=>String(x.id)===String(id)) : null;
  const html = `
    <div class="field">
      <label>Цитата</label>
      <textarea id="q-text" placeholder="Текст цитаты">${esc(q?.text||"")}</textarea>
    </div>
    <div class="field">
      <label>Автор (необязательно)</label>
      <input id="q-author" value="${escAttr(q?.author||"")}" placeholder="Имя автора" />
    </div>
    <div class="row">
      <button class="btn" id="q-save">Сохранить</button>
      <button class="btn secondary" id="q-cancel">Отмена</button>
    </div>
  `;
  openModal(q ? "Редактировать цитату" : "Новая цитата", html);
  $("#q-cancel").addEventListener("click", closeModal, {once:true});
  $("#q-save").addEventListener("click", async ()=>{
    const text = $("#q-text").value.trim();
    const author = $("#q-author").value.trim();
    if (!text){ toast("Цитаты", "Текст цитаты обязателен", "warn", 2200); return; }
    try{
      toast("Цитаты", "Сохраняю…", "info", 0);
      await apiPost("upsertQuote", { id: q?.id || null, text, author });
      closeModal();
      await syncAll("quoteSave");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}
function deleteQuoteConfirm(id){
  const q = state.quotes.find(x=>String(x.id)===String(id));
  if (!q) return;
  const html = `
    <div class="muted" style="margin-bottom:12px">
      Удалить цитату?
      <div style="margin-top:8px; color:var(--text); font-weight:900">“${esc(q.text)}”</div>
    </div>
    <div class="row">
      <button class="btn danger" id="yes">Удалить</button>
      <button class="btn secondary" id="no">Отмена</button>
    </div>
  `;
  openModal("Подтверждение", html);
  $("#no").addEventListener("click", closeModal, {once:true});
  $("#yes").addEventListener("click", async ()=>{
    try{
      toast("Цитаты", "Удаляю…", "info", 0);
      await apiPost("deleteQuote", { id });
      closeModal();
      await syncAll("quoteDelete");
    }catch(err){
      toast("Ошибка", String(err.message||err), "error", 0);
    }
  }, {once:true});
}

/**
 * ============================
 *  QUOTE OF THE DAY (используй где захочешь)
 * ============================
 * Сейчас мы выводим её на странице «Пульт» в самом верху.
 * Если захочешь — добавим блок на Дашборд рядом со шкалой/целями.
 */
function renderQuoteOfDay(){
  const q = quoteOfTheDay();
  const textEl = $("#quote-day-text");
  const authEl = $("#quote-day-author");
  if (!textEl || !authEl) return;
  if (!q){
    textEl.textContent = "Добавь цитаты в «Настройки → Мотивации (цитаты)».";
    authEl.textContent = "";
    return;
  }
  textEl.textContent = "“" + (q.text || "").trim() + "”";
  authEl.textContent = (q.author || "").trim() ? ("— " + q.author.trim()) : "";
}

function quoteOfTheDay(){
  const q = state.quotes;
  if (!q.length) return null;
  // daily rotation: index by days since epoch
  const dayIndex = Math.floor(Date.now() / (24*3600*1000));
  return q[dayIndex % q.length];
}

/**
 * ============================
 *  SECURITY / ESCAPING
 * ============================
 */
function esc(s){
  return String(s??"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function escAttr(s){ return esc(s).replaceAll("\n"," "); }

/**
 * ============================
 *  INIT
 * ============================
 */
(async function init(){
  // set default pills
  $("#pill-month").textContent = (Core && Core.fmtMonthYear) ? Core.fmtMonthYear(new Date()) : new Date().toLocaleString("ru-RU", {month:"long", year:"numeric"});

  // auth gate
  await authGate_();

  // initial period
  setPeriod("week");

  // resize redraw charts
  let resizeT = null;
  window.addEventListener("resize", ()=>{
    clearTimeout(resizeT);
    resizeT = setTimeout(()=>{
      if ($("#page-dashboard").classList.contains("active")) renderDashboard();
      if ($("#page-goals").classList.contains("active")) renderGoals();
    }, 120);
  });

  if (!API_URL || API_URL.includes("PASTE_YOUR_GAS_WEBAPP_URL_HERE")){
    toast(
      "Настрой API_URL",
      "Вставь ссылку Web App Google Apps Script в константу API_URL (внизу файла). После этого нажми «Синхр.»",
      "warn",
      4500
    );
  } else {
    // Загружаем данные (мгновенно из кеша + фоновый запрос к API)
    await syncAll("init");
    // Запускаем фоновое обновление раз в минуту
    startBgSync();
  }

})();


function currenciesInUse(){
  const set = new Set();
  (state.accounts||[]).forEach(a=>set.add(a.currency||'RUB'));
  (state.operations||[]).forEach(o=>set.add(opCurrency(o)));
  return [...set].filter(Boolean);
}

function filterOpsByCurrency(ops, cur){
  if (!cur || cur==='ALL') return ops;
  return ops.filter(o=>opCurrency(o)===cur);
}


// ===============================
// Expose handlers for inline onclick (module-safe)
// ===============================
try{
  window.__FinanceExpose = true;
  Object.assign(window, {
    openLimitForCategory,
    openLimitEditor,
    openOpEdit,
    confirmDeleteOp,
    openGoalEdit,
    deleteGoalConfirm,
    openCategoryEditor,
    deleteCategoryConfirm,
    openSubcategoryEditor,
    deleteSubcategoryConfirm,
    openAccountEditor,
    deleteAccountConfirm,
    openStageEditor,
    deleteStageConfirm,
    openQuoteEditor,
    deleteQuoteConfirm
  });
}catch(e){}


function round2_(n){
  const v = Number(n||0);
  return Math.round(v * 100) / 100;
}

/**
 * Пользователь вводит "курс" вручную.
 * Логика:
 * - если одна из валют — RUB, то курс понимаем как "RUB за 1 единицу НЕ-RUB валюты" (типичная котировка банка).
 *   Тогда:
 *     USD -> RUB: multiplier = rate
 *     RUB -> USD: multiplier = 1/rate
 * - если RUB не участвует (USD<->EUR и т.п.) — считаем, что введён прямой курс "to за 1 from".
 */
function bankRateToMultiplier_(bankRate, fromCur, toCur){
  const r = Number(bankRate||0);
  if (!r || r <= 0) return 0;
  const f = String(fromCur||"").toUpperCase();
  const t = String(toCur||"").toUpperCase();
  if (!f || !t || f === t) return 1;

  const fIsRub = (f === "RUB");
  const tIsRub = (t === "RUB");

  if (fIsRub && !tIsRub) return 1 / r; // RUB -> USD : USD per 1 RUB
  if (!fIsRub && tIsRub) return r;     // USD -> RUB : RUB per 1 USD

  // no RUB in pair → treat as direct "to per 1 from"
  return r;
}

function getAccCurrencyById_(accId){
  const a = (state.accounts || []).find(x=>String(x.id)===String(accId));
  return (a?.currency || "RUB").toUpperCase();
}

// remembers what the user edited last: "from" or "to"
state.ui = state.ui || {};
state.ui.transferLastChanged = state.ui.transferLastChanged || "from";

function recalcTransferTo_(){
  const type = $("#op-type")?.value || "expense";
  if (type !== "transfer") return;

  const amountFrom = Number($("#op-amount")?.value || 0);

  const fromId = $("#op-from-account")?.value || "";
  const toId   = $("#op-to-account")?.value || "";
  const fromCur = getAccCurrencyById_(fromId);
  const toCur   = getAccCurrencyById_(toId);

  const out = $("#op-amount-to");
  if (!out) return;

  // одна валюта → amountTo = amountFrom
  if (fromCur === toCur){
    out.value = (amountFrom > 0) ? String(round2_(amountFrom)) : "";
    return;
  }

  const bankRate = Number($("#op-fx-rate")?.value || 0);
  const mult = bankRateToMultiplier_(bankRate, fromCur, toCur);
  if (amountFrom > 0 && mult > 0){
    out.value = String(round2_(amountFrom * mult));
  } else {
    out.value = "";
  }
}

function recalcTransferFrom_(){
  const type = $("#op-type")?.value || "expense";
  if (type !== "transfer") return;

  const amountTo = Number($("#op-amount-to")?.value || 0);

  const fromId = $("#op-from-account")?.value || "";
  const toId   = $("#op-to-account")?.value || "";
  const fromCur = getAccCurrencyById_(fromId);
  const toCur   = getAccCurrencyById_(toId);

  const inp = $("#op-amount");
  if (!inp) return;

  // одна валюта → amountFrom = amountTo
  if (fromCur === toCur){
    inp.value = (amountTo > 0) ? String(round2_(amountTo)) : "";
    return;
  }

  const bankRate = Number($("#op-fx-rate")?.value || 0);
  const mult = bankRateToMultiplier_(bankRate, fromCur, toCur);
  if (amountTo > 0 && mult > 0){
    inp.value = String(round2_(amountTo / mult));
  }
}

function updateFxHint_(){
  const type = $("#op-type")?.value || "";
  const el = $("#fx-hint");
  const fx = $("#op-fx-rate");
  if (!el || !fx) return;

  if (type !== "transfer"){
    el.textContent = "";
    return;
  }

  const fromId = $("#op-from-account")?.value || "";
  const toId   = $("#op-to-account")?.value || "";
  const fromCur = getAccCurrencyById_(fromId);
  const toCur   = getAccCurrencyById_(toId);

  if (!fromCur || !toCur || fromCur === toCur){
    el.textContent = "";
    fx.placeholder = "1";
    return;
  }

  const fIsRub = fromCur === "RUB";
  const tIsRub = toCur === "RUB";

  if (fIsRub && !tIsRub){
    el.textContent = `Курс: RUB за 1 ${toCur} (например 85). Чтобы получить ${toCur}, сумма делится на курс.`;
    fx.placeholder = "85";
    return;
  }
  if (!fIsRub && tIsRub){
    el.textContent = `Курс: RUB за 1 ${fromCur} (например 85). Чтобы получить RUB, сумма умножается на курс.`;
    fx.placeholder = "85";
    return;
  }

  el.textContent = `Курс: ${toCur} за 1 ${fromCur} (например 1.05).`;
  fx.placeholder = "1.05";
}

// --- listeners (2-way) ---
$("#op-amount")?.addEventListener("input", ()=>{
  state.ui.transferLastChanged = "from";
  recalcTransferTo_();
});

$("#op-amount-to")?.addEventListener("input", ()=>{
  state.ui.transferLastChanged = "to";
  recalcTransferFrom_();
});

$("#op-fx-rate")?.addEventListener("input", ()=>{
  // пересчитываем "в ту сторону", которую пользователь НЕ редактирует сейчас
  if (state.ui.transferLastChanged === "to") recalcTransferFrom_();
  else recalcTransferTo_();
});

$("#op-from-account")?.addEventListener("change", ()=>{
  updateTransferRateVisibility_();
  updateFxHint_();
});

$("#op-to-account")?.addEventListener("change", ()=>{
  updateTransferRateVisibility_();
  updateFxHint_();
});

$("#op-type")?.addEventListener("change", ()=>{
  updateTransferRateVisibility_();
  updateFxHint_();
});
$("#op-to-account")?.addEventListener("change", ()=>{
  updateTransferRateVisibility_();
});

$("#op-amount")?.addEventListener("input", ()=>{
  recalcTransferTo_();
});

$("#op-fx-rate")?.addEventListener("input", ()=>{
  recalcTransferTo_();
});
// ============================================================
//  OCR — сканирование чека
// ============================================================

const RECEIPT_CONFIDENCE_THRESHOLD = 0.65; // ниже — подсвечиваем жёлтым

/**
 * Сжимает изображение до maxPx по длинной стороне,
 * конвертирует в JPEG и возвращает base64 без префикса.
 */
async function resizeImageToBase64(file, maxPx = 1200, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale  = Math.min(1, maxPx / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      resolve(dataUrl.split(",")[1]); // только base64, без префикса
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Не удалось прочитать изображение")); };
    img.src = url;
  });
}

/**
 * Устанавливает поля формы по результату OCR.
 * Переиспользует существующие render-функции приложения.
 */
function fillFormFromReceipt(parsed) {
  // Тип — всегда расход
  const typeSel = $("#op-type");
  if (typeSel) { typeSel.value = "expense"; toggleOpFieldsByType_(); }

  // Сумма
  if (parsed.amount != null && parsed.amount > 0) {
    $("#op-amount").value = parsed.amount;
  }

  // Дата
  if (parsed.date) {
    $("#op-date").value = parsed.date;
  }

  // Категория
  const catSel = $("#op-category");
  if (parsed.categoryId && catSel) {
    catSel.value = parsed.categoryId;
    renderSubcategorySelect(); // существующая функция
    if (parsed.subcategoryId) {
      const subSel = $("#op-subcategory");
      if (subSel) subSel.value = parsed.subcategoryId;
    }
    // Подсвечиваем жёлтым если низкая уверенность
    const isLowConfidence = (parsed.confidence ?? 1) < RECEIPT_CONFIDENCE_THRESHOLD;
    catSel.style.outline = isLowConfidence ? "2px solid #f0a500" : "";
    catSel.title = isLowConfidence
      ? `AI не уверен в категории (уверенность: ${Math.round((parsed.confidence ?? 0) * 100)}%)`
      : "";
  }

  // Комментарий
  if (parsed.comment) {
    $("#op-comment").value = parsed.comment;
  }

  // Валюта
  if (parsed.currency) {
    const cur = $("#op-currency");
    if (cur) { cur.value = parsed.currency; cur._userTouched = true; }
  }

  saveLastOpPrefs_();
}

/**
 * Сбрасывает подсветку категории когда пользователь меняет её вручную.
 */
function resetCategoryHighlight() {
  const catSel = $("#op-category");
  if (catSel) { catSel.style.outline = ""; catSel.title = ""; }
}

/**
 * Главный оркестратор: file → resize → OCR → fillForm.
 */
async function parseReceiptFromFile(file) {
  // Раскрываем форму если закрыта (П2)
  ensureOpFormOpen();

  const addBtn    = $("#btn-add-op");
  const statusEl  = $("#receipt-ocr-status");
  const previewWrap = $("#receipt-preview-wrap");
  const previewImg  = $("#receipt-preview-img");

  // Показываем превью
  if (previewWrap && previewImg) {
    previewImg.src = URL.createObjectURL(file);
    previewWrap.style.display = "";
  }

  // Блокируем форму
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = "Читаю чек…"; }
  if (statusEl) statusEl.textContent = "Распознаю текст…";

  try {
    // 1. Resize
    const imageBase64 = await resizeImageToBase64(file);

    // 2. Промежуточный статус
    if (statusEl) statusEl.textContent = "Определяю категорию…";

    // 3. Вызов parseReceipt Function
    const token = authGetToken_();
    const resp  = await fetch(RECEIPT_OCR_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({
        imageBase64,
        categories:    state.categories    || [],
        subcategories: state.subcategories || [],
      }),
    });

    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || "Ошибка OCR");

    // 4. Заполняем форму
    fillFormFromReceipt(json.data);

    // 5. Статус результата
    const conf = json.data.confidence ?? 0;
    if (statusEl) {
      statusEl.textContent = json.warning
        ? json.warning
        : `Готово · уверенность: ${Math.round(conf * 100)}%`;
      statusEl.style.color = conf < RECEIPT_CONFIDENCE_THRESHOLD ? "#f0a500" : "var(--muted)";
    }

    if (json.data.amount == null) {
      toast("Чек", "Сумма не найдена — введи вручную", "warn", 3000);
    }

  } catch (e) {
    if (statusEl) { statusEl.textContent = "Ошибка: " + e.message; statusEl.style.color = "var(--danger, #e55)"; }
    toast("Ошибка чека", e.message, "error", 0);
  } finally {
    // Разблокируем форму
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = "Добавить операцию"; }
  }
}

// ─── Обработчики событий ─────────────────────────────────────────────

// Кнопка 📷 открывает скрытый input
const btnScan = $("#btn-scan-receipt");
if (btnScan) {
  btnScan.addEventListener("click", () => {
    // Сбрасываем предыдущий выбор чтобы onChange сработал даже для того же файла
    const inp = $("#receipt-input");
    if (inp) { inp.value = ""; inp.click(); }
  });
}

// Выбор файла → запуск OCR
const receiptInput = $("#receipt-input");
if (receiptInput) {
  receiptInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    parseReceiptFromFile(file);
  });
}

// Сброс подсветки при ручном изменении категории
const opCategory = $("#op-category");
if (opCategory) {
  opCategory.addEventListener("change", resetCategoryHighlight);
}

// Кнопка удаления чека
function clearReceipt() {
  const previewWrap = $("#receipt-preview-wrap");
  const previewImg  = $("#receipt-preview-img");
  const statusEl    = $("#receipt-ocr-status");
  const inp         = $("#receipt-input");
  if (previewWrap) previewWrap.style.display = "none";
  if (previewImg)  { URL.revokeObjectURL(previewImg.src); previewImg.src = ""; }
  if (statusEl)    { statusEl.textContent = ""; statusEl.style.color = ""; }
  if (inp)         inp.value = "";
  resetCategoryHighlight();
}

const btnClear = $("#btn-clear-receipt");
if (btnClear) {
  btnClear.addEventListener("click", clearReceipt);
}
