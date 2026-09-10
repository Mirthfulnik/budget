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
    STORAGE_KEY: "finance2026_pet_v2",
    PIXEL_SCALE: 3              // размер пикселя спрайта в попапе (16*3 = 48px)
  };

  const NAMES = ["Мшуня", "Пухля", "Уголёк", "Тиша", "Кувшинка"];

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
  function paletteFor(mood) {
    const p = Object.assign({}, PAL_BASE);
    if (mood === "happy") { p.L = "#41d38d"; p.s = "#2f8f63"; }
    if (mood === "ok") { p.L = "#7fce7a"; p.s = "#4d8f4a"; }
    if (mood === "sad") {
      p.G = "#7b8294"; p.W = "#d5dae4"; p.L = "#ffcc66"; p.s = "#a8853f";
    }
    if (mood === "critical") {
      p.G = "#6e7383"; p.W = "#c4c9d3"; p.L = "#e08a4a"; p.s = "#8a5a2f";
    }
    if (mood === "dead") {
      p.G = "#4a4e5a"; p.g = "#6a6f7d"; p.W = "#7f8593";
      p.L = "#5a5f6b"; p.s = "#4a4e5a"; p.E = "#9aa3b2"; p.w = "#4a4e5a";
    }
    return p;
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
   *  ПЕРСИСТЕНТНОЕ СОСТОЯНИЕ
   * ============================ */
  function defaultState() {
    return {
      name: NAMES[Math.floor(Math.random() * NAMES.length)],
      lastDay: todayISO(),
      manualCloseDay: null,   // день, закрытый кнопкой «Операций нет» (YYYY-MM-DD)
      streak: 0,
      bestStreak: 0,
      missedTotal: 0,
      dead: false,
      diedAt: null,
      revives: 0,
      collapsed: false
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(CFG.STORAGE_KEY);
      if (!raw) return defaultState();
      return Object.assign(defaultState(), JSON.parse(raw));
    } catch (e) { return defaultState(); }
  }

  function save(s) {
    try { localStorage.setItem(CFG.STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  let pet = load();

  /* День считается закрытым, если по нему есть операции
     ИЛИ владелец явно нажал «Операций нет». */
  function isDayClosed(iso, ops) {
    if (pet.manualCloseDay === iso) return true;
    return dayOps(iso, ops).length > 0;
  }

  /* Закрыть сегодняшний день вручную — кнопка «Операций нет» */
  function canDeclareEmpty() {
    return new Date().getHours() >= CFG.NO_OPS_UNLOCK_HOUR;
  }

  function closeTodayManually() {
    if (!canDeclareEmpty()) return false;   // рано — день ещё может случиться
    pet.manualCloseDay = todayISO();
    if (pet.dead) { pet.dead = false; pet.diedAt = null; pet.revives += 1; }
    save(pet);
    refresh(true);
    return true;
  }

  /* Подводим итог прошедшим дням.
     Состояние живёт один день, поэтому HP не переносится: важен только
     факт «последний прошедший день закрыт или нет». */
  function settleDays(ops) {
    if (!ops) return false;               // данных нет — судить не за что
    const today = todayISO();
    if (pet.lastDay === today) return false;
    if (!pet.lastDay || pet.lastDay > today) { pet.lastDay = today; save(pet); return true; }

    let cursor = pet.lastDay;
    let guard = 0;
    let lastClosed = false;
    while (cursor < today && guard++ < 400) {
      if (isDayClosed(cursor, ops)) {
        pet.streak += 1;
        pet.bestStreak = Math.max(pet.bestStreak, pet.streak);
        lastClosed = true;
      } else {
        pet.streak = 0;
        pet.missedTotal += 1;
        lastClosed = false;
      }
      cursor = nextISO(cursor);
    }

    // жив ровно тогда, когда закрыт последний прошедший день
    if (lastClosed) {
      pet.dead = false;
      pet.diedAt = null;
    } else {
      pet.dead = true;
      pet.diedAt = pet.diedAt || prevISO(today);
    }

    pet.lastDay = today;
    if (pet.manualCloseDay && pet.manualCloseDay < today) pet.manualCloseDay = null;
    save(pet);
    return true;
  }

  /* ============================
   *  ЖИВОЙ РАСЧЁТ
   * ============================ */
  function compute() {
    const ops = getOps();
    settleDays(ops);

    const today = todayISO();
    const todays = dayOps(today, ops);
    const hasOps = todays.length > 0;
    const manual = pet.manualCloseDay === today;
    const closed = hasOps || manual;

    // закрыли день — мёртвый оживает на полные силы
    if (pet.dead && closed) {
      pet.dead = false;
      pet.diedAt = null;
      pet.revives += 1;
      save(pet);
    }

    // HP — чисто функция текущего дня, ничего не копится
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    let shownHp;
    if (pet.dead) {
      shownHp = 0;
    } else if (closed) {
      shownHp = CFG.MAX_HP;
    } else if (hour <= CFG.HUNGER_START_HOUR) {
      shownHp = CFG.MAX_HP;
    } else {
      const span = 24 - CFG.HUNGER_START_HOUR;
      const spent = Math.min(1, (hour - CFG.HUNGER_START_HOUR) / span);
      shownHp = Math.max(0, Math.round(CFG.MAX_HP * (1 - spent)));
    }

    const msLeft = msUntilMidnight();
    const panic = !closed && !pet.dead && msLeft < CFG.PANIC_HOURS * 3600 * 1000;

    let mood = "happy";
    if (pet.dead) mood = "dead";
    else if (shownHp < 25) mood = "critical";
    else if (shownHp < 55) mood = "sad";
    else if (shownHp < 80) mood = "ok";

    return {
      ops, closed, hasOps, manual, todays, shownHp, mood, msLeft, panic,
      canDeclare: canDeclareEmpty(),
      dataReady: !!ops,
      todayAmount: todays.reduce((a, o) => a + (Number(o.amount) || 0), 0)
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

    const pal = paletteFor(mood);
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
    if (c.mood === "dead") return "Не дождался. Закрой сегодняшний день — вернётся.";
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
    return { happy: "Отлично", ok: "Нормально", sad: "Грустит", critical: "Критично", dead: "Мёртв" }[m] || "—";
  }

  function modalHtml(c) {
    const hpColor = c.shownHp >= 55 ? "var(--ok)" : c.shownHp >= 25 ? "var(--warn)" : "var(--danger)";
    const closedBy = c.hasOps ? "операциями" : c.manual ? "вручную" : "";
    return `
      <div class="petModal">
        <div class="petModalTop">
          <canvas id="petModalCanvas" class="petModalCanvas"></canvas>
          <div class="petModalMeta">
            <div class="petModalName">${pet.name}</div>
            <div class="petModalMood" style="color:${hpColor}">${moodWord(c.mood)}</div>
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
            <span class="k">Дней подряд</span><b>${pet.streak}${pet.bestStreak ? ` <span style="color:var(--muted);font-weight:600">/ ${pet.bestStreak}</span>` : ""}</b>
          </div>
        </div>

        <div class="petWarn ${c.mood === "dead" ? "dead" : c.closed ? "ok" : "warn"}">
          ${c.mood === "dead"
            ? "Питомец умер. Закрой сегодняшний день — он вернётся на полные " + CFG.MAX_HP + " HP."
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
          <button class="btn ghost small" id="petRename">Переименовать</button>
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
      pet.manualCloseDay = null;
      save(pet);
      refresh(true);
      openPetModal();
    });

    const ren = document.getElementById("petRename");
    if (ren) ren.addEventListener("click", () => {
      const v = prompt("Как его зовут?", pet.name);
      if (v && v.trim()) { pet.name = v.trim().slice(0, 24); save(pet); refresh(true); }
    });
  }

  function paintModalSprite(c) {
    const cv = document.getElementById("petModalCanvas");
    if (cv) drawSprite(cv, c.mood, { scale: 6, bob: 0 });
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
    el.name.textContent = pet.name;
    el.timer.textContent = c.closed ? "день закрыт" : fmtHMS(c.msLeft);
    el.timer.classList.toggle("ok", c.closed);
    el.timer.classList.toggle("danger", c.panic || c.mood === "dead");
    el.hpFill.style.width = c.shownHp + "%";
    el.hpFill.style.background =
      c.shownHp >= 55 ? "var(--ok)" : c.shownHp >= 25 ? "var(--warn)" : "var(--danger)";

    el.dock.classList.toggle("panic", c.panic || c.mood === "critical");
    el.dock.classList.toggle("dead", c.mood === "dead");
    el.dock.classList.toggle("fed", c.closed);

    // моргание
    const now = Date.now();
    if (c.mood !== "dead" && now > blinkUntil && Math.random() < 0.06) blinkUntil = now + 180;
    const blink = now < blinkUntil;

    // покачивание
    const bob = c.mood === "dead" ? 1 : (Math.sin(tick / 8) > 0 ? 0 : 1);

    drawSprite(el.canvas, c.mood, { scale: CFG.PIXEL_SCALE, bob, blink, tear: c.mood === "critical" });
    if (pet.collapsed) drawSprite(el.canvasMini, c.mood, { scale: 2, bob, blink });

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
    reset: () => { pet = defaultState(); save(pet); refresh(true); },
    _state: () => pet
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
