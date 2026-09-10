/**
 * ============================
 *  PIXEL PET — «Лесной дух»
 * ============================
 * Попап в правом верхнем углу: пиксельный питомец + таймер до конца дня.
 *
 * Состояние живёт ровно один день. Утром питомец всегда на 100 HP, в течение
 * дня HP тает, к полуночи доходит до нуля. Чтобы он дожил до завтра, день нужно
 * «закрыть»: либо внести операцию, либо нажать «Операций нет» — это честный
 * вариант для дней, когда трат действительно не было. Кнопка открывается
 * только после NO_OPS_UNLOCK_HOUR, чтобы ей не закрывали день с утра.
 * Не закрыл до полуночи — питомец умирает. Закрытие любого следующего дня
 * возвращает его к жизни на полные 100 HP.
 *
 * Клик по попапу → модалка с полным состоянием.
 *
 * Данные читаются из window.__FIN__.state.operations (см. патч в app.js),
 * с запасным вариантом — кеш bootstrap в localStorage.
 */
(function () {
  "use strict";

  /* ============================
   *  НАСТРОЙКИ (крути тут)
   * ============================ */
  const CFG = {
    MAX_HP: 100,
    HUNGER_START_HOUR: 10,      // до этого часа питомец полон сил, дальше HP тает
    PANIC_HOURS: 3,             // за сколько часов до полуночи включается паника
    NO_OPS_UNLOCK_HOUR: 23,     // с какого часа доступна кнопка «Операций нет»
    TRACK_WINDOW_DAYS: 30,      // насколько глубоко смотреть историю операций
    EPOCH: "2026-09-11",        // раньше этой даты дни не судим (день выката фичи),
                                // иначе старая история задним числом хоронит духов
    STORAGE_KEY: "finance2026_pet_v3",
    PIXEL_SCALE: 3              // размер пикселя спрайта в попапе (16*3 = 48px)
  };

  /* Имя и цвет листа выводятся из даты рождения духа, а не выбираются
     случайно — иначе на телефоне и на компьютере родились бы разные духи. */
  const NAMES = [
    "Мшуня", "Пухля", "Уголёк", "Тиша", "Кувшинка", "Ворсик", "Клёцка", "Хмурик",
    "Бусинка", "Пыжик", "Тучка", "Лапушь", "Совик", "Крошка", "Дымок", "Пенёк"
  ];

  /* Цвет листа — «паспорт» духа. Виден, пока он здоров;
     при падении HP лист всё равно желтеет и буреет. */
  const LEAVES = [
    { L: "#41d38d", s: "#2f8f63" },  // изумруд
    { L: "#57a6ff", s: "#2f6aa8" },  // незабудка
    { L: "#c98bff", s: "#7b4da8" },  // сирень
    { L: "#ff8fb1", s: "#a85472" },  // вереск
    { L: "#7fe3d4", s: "#3f8d84" },  // мята
    { L: "#ffd166", s: "#a8853f" },  // янтарь
    { L: "#a3e635", s: "#61892a" },  // липа
    { L: "#ff9f6e", s: "#a85f3c" }   // рябина
  ];

  /* Стабильный хеш строки — одинаковый на всех устройствах */
  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  function spiritOf(birthISO) {
    const h = hashStr(birthISO);
    return {
      birth: birthISO,
      name: NAMES[h % NAMES.length],
      leaf: LEAVES[Math.floor(h / NAMES.length) % LEAVES.length]
    };
  }

  /* ============================
   *  СПРАЙТ 16×16
   * ============================
   * Хочешь своего персонажа — просто перепиши эту матрицу
   * и палитру PALETTE ниже. Один символ = один пиксель.
   *   . прозрачный   B контур     G шерсть
   *   W живот        g тень       E белок глаза
   *   P зрачок       N нос        L лист
   *   s стебель      w ус
   */
  const SPRITE = [
    "................",
    ".........LLL....",
    "........LLLL....",
    "...BB...sLLBB...",
    "..BGGB..s.BGGB..",
    "...BGGBBBBGGB...",
    "..BGGGGGGGGGGB..",
    ".BGEEGGGGGGEEGB.",
    ".BGEPGGGGGGPEGB.",
    ".BGGGGGNNGGGGGB.",
    ".BGGGGGNNGGGGGB.",
    ".BGGGWWWWWWGGGB.",
    "..BGWWWWWWWWGB..",
    "..BGWgWWWWgWGB..",
    "...BGWWWWWWGB...",
    "....BBBBBBBB...."
  ];

  const PAL_BASE = {
    B: "#12151c", G: "#8b93a5", g: "#c3cad8", W: "#e9eef6",
    E: "#ffffff", P: "#12151c", N: "#394052",
    L: "#41d38d", s: "#2f8f63", w: "#6c7482"
  };

  /* Палитры под настроение */
  function paletteFor(mood, leaf) {
    const p = Object.assign({}, PAL_BASE);
    if (leaf) { p.L = leaf.L; p.s = leaf.s; }
    if (mood === "ok" && leaf) { p.L = mix(leaf.L, "#9aa3b2", 0.25); }
    if (mood === "sad") {
      p.G = "#7b8294"; p.W = "#d5dae4"; p.L = "#ffcc66"; p.s = "#a8853f";
    }
    // sad / critical / dead перебивают цвет духа — увядание одинаково для всех
    if (mood === "critical") {
      p.G = "#6e7383"; p.W = "#c4c9d3"; p.L = "#e08a4a"; p.s = "#8a5a2f";
    }
    if (mood === "dead") {
      p.G = "#4a4e5a"; p.g = "#6a6f7d"; p.W = "#7f8593";
      p.L = "#5a5f6b"; p.s = "#4a4e5a"; p.E = "#9aa3b2"; p.w = "#4a4e5a";
    }
    return p;
  }

  function mix(hexA, hexB, t) {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const a = p(hexA), b = p(hexB);
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  }

  /* Патчи глаз/лица под настроение: [row, col, char] */
  function facePatch(mood, blink) {
    const px = [];
    if (blink && mood !== "dead") {
      // закрытые глаза — горизонтальные чёрточки
      px.push([7, 3, "G"], [7, 4, "G"], [7, 11, "G"], [7, 12, "G"]);
      px.push([8, 3, "P"], [8, 4, "P"], [8, 11, "P"], [8, 12, "P"]);
      return px;
    }
    if (mood === "happy") {
      // глаза-дуги ^ ^
      px.push([7, 3, "G"], [7, 4, "P"], [7, 11, "P"], [7, 12, "G"]);
      px.push([8, 3, "P"], [8, 4, "G"], [8, 11, "G"], [8, 12, "P"]);
    }
    if (mood === "sad" || mood === "critical") {
      // зрачки вниз + приподнятые «брови»
      px.push([7, 3, "E"], [7, 4, "E"], [7, 11, "E"], [7, 12, "E"]);
      px.push([8, 3, "P"], [8, 4, "E"], [8, 11, "E"], [8, 12, "P"]);
      px.push([6, 3, "B"], [6, 12, "B"]);
    }
    if (mood === "dead") {
      // глаза-крестики
      px.push([7, 3, "P"], [7, 4, "E"], [7, 11, "E"], [7, 12, "P"]);
      px.push([8, 3, "E"], [8, 4, "P"], [8, 11, "P"], [8, 12, "E"]);
      // лист опадает, остаётся голый стебель
      px.push([1, 9, "."], [1, 10, "."], [1, 11, "."],
              [2, 8, "."], [2, 9, "."], [2, 10, "."], [2, 11, "."],
              [3, 9, "."], [3, 10, "."]);
    }
    return px;
  }

  /* ============================
   *  ДАТЫ
   * ============================ */
  const pad2 = (n) => String(n).padStart(2, "0");
  const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayISO = () => isoOf(new Date());

  function nextISO(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + 1);
    return isoOf(dt);
  }

  function shiftISO(iso, delta) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta);
    return isoOf(dt);
  }

  function daysBetween(a, b) {
    const p = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
    return Math.round((p(b) - p(a)) / 86400000);
  }

  function prevISO(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() - 1);
    return isoOf(dt);
  }

  function msUntilMidnight() {
    const now = new Date();
    const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return Math.max(0, mid - now);
  }

  function fmtHMS(ms) {
    const s = Math.floor(ms / 1000);
    return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  }

  /* Имена в списке разного рода — подставляем окончание */
  function fem(name) {
    return /[ая]$/i.test(name) ? "а" : "";
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  /* ============================
   *  ДОСТУП К ОПЕРАЦИЯМ
   * ============================ */
  function getOps() {
    const st = window.__FIN__ && window.__FIN__.state;
    if (st && Array.isArray(st.operations) && st.lastBootstrapAt) return st.operations;
    // запасной путь — кеш bootstrap
    try {
      const raw = localStorage.getItem("finance2026_bootstrap_v1");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const ops = parsed && parsed.data && parsed.data.operations;
      return Array.isArray(ops) ? ops : null;
    } catch (e) { return null; }
  }

  function opDateISO(o) {
    const raw = o.date || o.createdAt || "";
    if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const d = new Date(raw);
    return isNaN(d) ? "" : isoOf(d);
  }

  function dayOps(iso, ops) {
    if (!ops) return [];
    return ops.filter((o) => opDateISO(o) === iso);
  }

  /* ============================
   *  ЛОКАЛЬНОЕ СОСТОЯНИЕ
   * ============================
   * Здесь лежит только то, чего нет на сервере: дни, закрытые кнопкой
   * «Операций нет», ручные переименования и свёрнутость попапа.
   * Всё остальное — жив ли дух, как его зовут, сколько дней он прожил —
   * ВЫЧИСЛЯЕТСЯ из операций. Операции синхронизируются, поэтому телефон
   * и компьютер приходят к одному и тому же ответу.
   */
  function defaultState() {
    return {
      manualDays: [],   // ["YYYY-MM-DD"] — дни, закрытые вручную
      names: {},        // { "дата рождения духа": "имя" } — ручные переименования
      collapsed: false
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(CFG.STORAGE_KEY);
      if (!raw) return defaultState();
      const s = Object.assign(defaultState(), JSON.parse(raw));
      if (!Array.isArray(s.manualDays)) s.manualDays = [];
      if (!s.names || typeof s.names !== "object") s.names = {};
      return s;
    } catch (e) { return defaultState(); }
  }

  function save(s) {
    try { localStorage.setItem(CFG.STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  let pet = load();

  function canDeclareEmpty() {
    return new Date().getHours() >= CFG.NO_OPS_UNLOCK_HOUR;
  }

  /* Закрыть сегодняшний день вручную — кнопка «Операций нет» */
  function closeTodayManually() {
    if (!canDeclareEmpty()) return false;   // рано — день ещё может случиться
    const t = todayISO();
    if (!pet.manualDays.includes(t)) pet.manualDays.push(t);
    save(pet);
    refresh(true);
    return true;
  }

  /* ============================
   *  ВЫВОД СОСТОЯНИЯ ИЗ ОПЕРАЦИЙ
   * ============================ */
  let cache = { key: "", value: null };

  function analyze(ops) {
    const today = todayISO();
    const key = today + "|" + (ops ? ops.length : "x") + "|" + pet.manualDays.join(",");
    if (cache.key === key) return cache.value;

    const withOps = new Set();
    let earliest = null;
    if (ops) {
      for (const o of ops) {
        const d = opDateISO(o);
        if (!d) continue;
        withOps.add(d);
        if (!earliest || d < earliest) earliest = d;
      }
    }
    const manual = new Set(pet.manualDays);
    const closed = (iso) => withOps.has(iso) || manual.has(iso);

    /* Окно наблюдения ограничено с трёх сторон:
       — не глубже TRACK_WINDOW_DAYS,
       — не раньше EPOCH (иначе прошлое задним числом убивает духов),
       — не раньше первой операции (иначе новый пользователь стартует с кладбищем). */
    let start = shiftISO(today, -CFG.TRACK_WINDOW_DAYS);
    if (CFG.EPOCH > start) start = CFG.EPOCH;
    const anchor = earliest || today;
    if (anchor > start) start = anchor;
    if (start > today) start = today;

    // все незакрытые дни до сегодня — это смерти
    const deaths = [];
    for (let d = start; d < today; d = nextISO(d)) {
      if (!closed(d)) deaths.push(d);
    }

    const yesterday = prevISO(today);
    const todayClosed = closed(today);
    const diedLastNight = yesterday >= start && !closed(yesterday);
    const isDead = diedLastNight && !todayClosed;

    // дата рождения текущего духа
    let birth;
    if (isDead) {
      // показываем того, кто вчера погиб: он родился после предыдущей смерти
      const prevDeath = deaths.length > 1 ? deaths[deaths.length - 2] : null;
      birth = prevDeath ? nextISO(prevDeath) : start;
    } else if (deaths.length) {
      birth = nextISO(deaths[deaths.length - 1]);
    } else {
      birth = start;
    }
    if (birth > today) birth = today;

    // серия закрытых дней подряд, заканчивая вчерашним, плюс сегодня
    let streak = 0;
    for (let d = yesterday; d >= birth && closed(d); d = prevISO(d)) streak++;
    if (todayClosed && !isDead) streak++;

    const lifeEnd = isDead ? yesterday : today;
    const lifeDays = Math.max(1, daysBetween(birth, lifeEnd) + 1);

    const sp = spiritOf(birth);
    if (pet.names[birth]) sp.name = pet.names[birth];

    const value = {
      spirit: sp, isDead, todayClosed,
      hasOpsToday: withOps.has(today),
      manualToday: manual.has(today),
      deaths: deaths.length, streak, lifeDays,
      diedAt: isDead ? yesterday : null
    };
    cache = { key, value };
    return value;
  }

  /* ============================
   *  ЖИВОЙ РАСЧЁТ
   * ============================ */
  function compute() {
    const ops = getOps();
    const a = analyze(ops);

    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    let shownHp;
    if (a.isDead) {
      shownHp = 0;
    } else if (a.todayClosed || hour <= CFG.HUNGER_START_HOUR) {
      shownHp = CFG.MAX_HP;
    } else {
      const span = 24 - CFG.HUNGER_START_HOUR;
      const spent = Math.min(1, (hour - CFG.HUNGER_START_HOUR) / span);
      shownHp = Math.max(0, Math.round(CFG.MAX_HP * (1 - spent)));
    }

    const msLeft = msUntilMidnight();
    const panic = !a.todayClosed && !a.isDead && msLeft < CFG.PANIC_HOURS * 3600 * 1000;

    let mood = "happy";
    if (a.isDead) mood = "dead";
    else if (shownHp < 25) mood = "critical";
    else if (shownHp < 55) mood = "sad";
    else if (shownHp < 80) mood = "ok";

    const todays = dayOps(todayISO(), ops);
    return {
      ops, todays, shownHp, mood, msLeft, panic,
      closed: a.todayClosed, hasOps: a.hasOpsToday, manual: a.manualToday,
      dead: a.isDead, spirit: a.spirit, deaths: a.deaths,
      streak: a.streak, lifeDays: a.lifeDays, diedAt: a.diedAt,
      canDeclare: canDeclareEmpty(),
      dataReady: !!ops
    };
  }

  /* ============================
   *  ОТРИСОВКА СПРАЙТА
   * ============================ */
  function drawSprite(canvas, mood, opts) {
    opts = opts || {};
    const scale = opts.scale || CFG.PIXEL_SCALE;
    const w = 16 * scale;
    const h = 17 * scale; // +1 ряд запаса под покачивание, иначе срезает лапы
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);

    const grid = SPRITE.map((r) => r.split(""));
    facePatch(mood, opts.blink).forEach(([r, c, ch]) => {
      if (grid[r] && grid[r][c] !== undefined) grid[r][c] = ch;
    });

    const pal = paletteFor(mood, opts.leaf);
    const bob = opts.bob || 0;

    for (let r = 0; r < 16; r++) {
      for (let c = 0; c < 16; c++) {
        const ch = grid[r][c];
        if (ch === "." || !pal[ch]) continue;
        ctx.fillStyle = pal[ch];
        ctx.fillRect(c * scale, (r + bob) * scale, scale, scale);
      }
    }

    // «zzz» когда спит-грустит, и капелька пота в панике — мелкие детали
    if (opts.tear && mood !== "dead") {
      ctx.fillStyle = "#57a6ff";
      ctx.fillRect(4 * scale, (9 + bob) * scale, scale, scale);
    }
  }

  /* ============================
   *  ПОПАП
   * ============================ */
  const el = {};

  function buildDock() {
    const dock = document.createElement("div");
    dock.id = "petDock";
    dock.className = "petDock";
    dock.setAttribute("role", "button");
    dock.setAttribute("tabindex", "0");
    dock.setAttribute("aria-label", "Питомец — состояние дня");
    dock.innerHTML = `
      <button class="petDockHide" id="petDockHide" title="Свернуть" aria-label="Свернуть">−</button>
      <canvas class="petCanvas" id="petCanvas" width="48" height="51" aria-hidden="true"></canvas>
      <div class="petDockInfo">
        <div class="petDockName" id="petDockName"></div>
        <div class="petDockTimer" id="petDockTimer">--:--:--</div>
        <div class="petHpBar"><i id="petHpFill"></i></div>
      </div>
    `;
    document.body.appendChild(dock);

    const bubble = document.createElement("button");
    bubble.id = "petBubble";
    bubble.className = "petBubble";
    bubble.setAttribute("aria-label", "Показать питомца");
    bubble.innerHTML = `<canvas class="petCanvasMini" id="petCanvasMini" width="32" height="34"></canvas>`;
    document.body.appendChild(bubble);

    el.dock = dock;
    el.bubble = bubble;
    el.canvas = dock.querySelector("#petCanvas");
    el.canvasMini = bubble.querySelector("#petCanvasMini");
    el.name = dock.querySelector("#petDockName");
    el.timer = dock.querySelector("#petDockTimer");
    el.hpFill = dock.querySelector("#petHpFill");

    dock.addEventListener("click", (e) => {
      if (e.target.closest("#petDockHide")) return;
      openPetModal();
    });
    dock.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPetModal(); }
    });
    dock.querySelector("#petDockHide").addEventListener("click", (e) => {
      e.stopPropagation();
      pet.collapsed = true; save(pet); applyCollapsed();
    });
    bubble.addEventListener("click", () => {
      pet.collapsed = false; save(pet); applyCollapsed();
    });

    applyCollapsed();
  }

  function applyCollapsed() {
    if (!el.dock) return;
    el.dock.classList.toggle("hidden", !!pet.collapsed);
    el.bubble.classList.toggle("show", !!pet.collapsed);
  }

  /* ============================
   *  МОДАЛКА СОСТОЯНИЯ
   * ============================ */
  let modalOpen = false;

  function statusLine(c) {
    if (!c.dataReady) return "Жду данные с сервера…";
    if (c.dead) return "Дух ушёл насовсем. Закрой сегодняшний день — придёт новый.";
    if (c.manual && !c.hasOps) return "День отмечен как пустой. Это тоже считается — всё в порядке.";
    if (c.closed) return "День закрыт. Завтра начнём заново.";
    if (c.mood === "critical") {
      return c.canDeclare
        ? "Совсем плохо. Внеси операцию или отметь день пустым."
        : "Совсем плохо. День всё ещё не закрыт.";
    }
    if (c.mood === "sad") return "Грустит и косится на часы.";
    return "Ждёт, когда ты закроешь сегодняшний день.";
  }

  function moodWord(m) {
    return { happy: "Отлично", ok: "Нормально", sad: "Грустит", critical: "Критично", dead: "Погиб" }[m] || "—";
  }

  function modalHtml(c) {
    const hpColor = c.shownHp >= 55 ? "var(--ok)" : c.shownHp >= 25 ? "var(--warn)" : "var(--danger)";
    const closedBy = c.hasOps ? "операциями" : c.manual ? "вручную" : "";
    const leafDot = `<i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${c.spirit.leaf.L};vertical-align:middle;margin-right:6px"></i>`;
    return `
      <div class="petModal">
        <div class="petModalTop">
          <canvas id="petModalCanvas" class="petModalCanvas"></canvas>
          <div class="petModalMeta">
            <div class="petModalName">${leafDot}${esc(c.spirit.name)}</div>
            <div class="petModalMood" style="color:${c.dead ? "var(--danger)" : hpColor}">${moodWord(c.mood)}</div>
            <div class="petModalHint">${statusLine(c)}</div>
          </div>
        </div>

        <div class="petHpBar big"><i style="width:${c.shownHp}%;background:${hpColor}"></i></div>
        <div class="petHpNum">${c.shownHp} / ${CFG.MAX_HP} HP · состояние только за сегодня</div>

        <div class="petStats">
          <div class="petStat">
            <span class="k">До конца дня</span>
            <b class="${c.panic ? "danger" : ""}">${fmtHMS(c.msLeft)}</b>
          </div>
          <div class="petStat">
            <span class="k">Операций сегодня</span>
            <b class="${c.hasOps ? "ok" : ""}">${c.todays.length}</b>
          </div>
          <div class="petStat">
            <span class="k">День закрыт</span>
            <b class="${c.closed ? "ok" : "danger"}">${c.closed ? "да · " + closedBy : "нет"}</b>
          </div>
          <div class="petStat">
            <span class="k">${c.dead ? "Прожил" : "Живёт"}</span>
            <b>${c.lifeDays} ${plural(c.lifeDays, "день", "дня", "дней")}</b>
          </div>
          <div class="petStat">
            <span class="k">Дней подряд</span><b>${c.streak}</b>
          </div>
          <div class="petStat">
            <span class="k">Духов потеряно</span>
            <b class="${c.deaths ? "danger" : ""}">${c.deaths}</b>
          </div>
        </div>

        <div class="petWarn ${c.dead ? "dead" : c.closed ? "ok" : "warn"}">
          ${c.dead
            ? `${esc(c.spirit.name)} не пережил${fem(c.spirit.name)} ${fmtDate(c.diedAt)} и ушёл${fem(c.spirit.name)} навсегда — воскресить нельзя. Закрой сегодняшний день, и придёт новый дух, со своим именем и цветом листа.`
            : c.closed
              ? "Сегодня всё в порядке. В полночь HP снова станет полным."
              : c.canDeclare
                ? "HP тает до полуночи. Если трат сегодня правда не было — нажми «Операций нет», это закроет день честно."
                : `HP тает до полуночи. Если трат сегодня так и не будет, после ${CFG.NO_OPS_UNLOCK_HOUR}:00 появится кнопка «Операций нет», чтобы закрыть день без операции.`}
        </div>

        <div class="petActions">
          <button class="btn" id="petGoAdd">Внести операцию</button>
          ${!c.closed && c.canDeclare
            ? '<button class="btn secondary" id="petNoOps">Операций нет</button>'
            : ""}
        </div>
        <div class="petActions petActionsSub">
          ${!c.dead ? '<button class="btn ghost small" id="petRename">Переименовать</button>' : ""}
          ${c.manual && !c.hasOps ? '<button class="btn ghost small" id="petUndoNoOps">Отменить «нет операций»</button>' : ""}
        </div>
      </div>
    `;
  }

  function openPetModal() {
    const c = compute();
    const api = window.__FIN__;
    if (api && typeof api.openModal === "function") {
      api.openModal("Питомец", modalHtml(c));
    } else {
      return;
    }
    modalOpen = true;
    wireModal();
    paintModalSprite(c);
  }

  function wireModal() {
    const go = document.getElementById("petGoAdd");
    if (go) go.addEventListener("click", () => {
      const api = window.__FIN__;
      if (api && typeof api.closeModal === "function") api.closeModal();
      modalOpen = false;
      const navBtn = document.querySelector('.btnNav[data-page="pult"]');
      if (navBtn) navBtn.click();
      const amount = document.getElementById("op-amount");
      const toggle = document.getElementById("btnToggleOpForm");
      if (toggle && !document.querySelector(".opFormWrap.open")) toggle.click();
      setTimeout(() => { if (amount) { amount.focus(); amount.scrollIntoView({ behavior: "smooth", block: "center" }); } }, 120);
    });

    const noOps = document.getElementById("petNoOps");
    if (noOps) noOps.addEventListener("click", () => {
      closeTodayManually();
      openPetModal();   // перерисовываем модалку в новом состоянии
    });

    const undo = document.getElementById("petUndoNoOps");
    if (undo) undo.addEventListener("click", () => {
      pet.manualDays = pet.manualDays.filter((d) => d !== todayISO());
      save(pet);
      refresh(true);
      openPetModal();
    });

    const ren = document.getElementById("petRename");
    if (ren) ren.addEventListener("click", () => {
      const cur = compute().spirit;
      const v = prompt("Как его зовут?", cur.name);
      if (v && v.trim()) {
        pet.names[cur.birth] = v.trim().slice(0, 24);
        save(pet);
        refresh(true);
        openPetModal();
      }
    });
  }

  function paintModalSprite(c) {
    const cv = document.getElementById("petModalCanvas");
    if (cv) drawSprite(cv, c.mood, { scale: 6, bob: 0, leaf: c.spirit.leaf });
  }

  /* ============================
   *  ЦИКЛ
   * ============================ */
  let tick = 0;
  let blinkUntil = 0;
  let lastCanDeclare = null;

  function refresh(force) {
    if (!el.dock) return;
    const c = compute();

    // таймер + hp-бар
    el.name.textContent = c.spirit.name;
    el.timer.textContent = c.closed ? "день закрыт" : fmtHMS(c.msLeft);
    el.timer.classList.toggle("ok", c.closed);
    el.timer.classList.toggle("danger", c.panic || c.mood === "dead");
    el.hpFill.style.width = c.shownHp + "%";
    el.hpFill.style.background =
      c.shownHp >= 55 ? "var(--ok)" : c.shownHp >= 25 ? "var(--warn)" : "var(--danger)";

    el.dock.classList.toggle("panic", c.panic || c.mood === "critical");
    el.dock.classList.toggle("dead", c.dead);
    el.dock.classList.toggle("fed", c.closed);

    // моргание
    const now = Date.now();
    if (c.mood !== "dead" && now > blinkUntil && Math.random() < 0.06) blinkUntil = now + 180;
    const blink = now < blinkUntil;

    // покачивание
    const bob = c.mood === "dead" ? 1 : (Math.sin(tick / 8) > 0 ? 0 : 1);

    drawSprite(el.canvas, c.mood, { scale: CFG.PIXEL_SCALE, bob, blink, leaf: c.spirit.leaf, tear: c.mood === "critical" });
    if (pet.collapsed) drawSprite(el.canvasMini, c.mood, { scale: 2, bob, blink, leaf: c.spirit.leaf });

    if (modalOpen && document.getElementById("petModalCanvas")) {
      // кнопка «Операций нет» могла разблокироваться прямо сейчас — пересобираем
      if (lastCanDeclare !== null && lastCanDeclare !== c.canDeclare) {
        lastCanDeclare = c.canDeclare;
        openPetModal();
        return;
      }
      lastCanDeclare = c.canDeclare;
      const t = document.querySelector(".petStat b");
      if (t) t.textContent = fmtHMS(c.msLeft);
      paintModalSprite(c);
    } else if (modalOpen && !document.getElementById("petModalCanvas")) {
      modalOpen = false;
      lastCanDeclare = null;
    }

    if (force) { /* ничего дополнительно */ }
  }

  function start() {
    if (document.getElementById("petDock")) return;
    buildDock();
    refresh(true);
    setInterval(() => { tick++; refresh(false); }, 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(true); });
  }

  /* публичный хук — app.js дёргает после загрузки/изменения данных */
  window.PixelPet = {
    refresh: () => refresh(true),
    closeToday: closeTodayManually,   // вернёт false, если ещё рано
    canCloseToday: canDeclareEmpty,
    open: openPetModal,
    reset: () => { pet = defaultState(); cache = { key: "", value: null }; save(pet); refresh(true); },
    _state: () => pet,
    _compute: () => compute()
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
