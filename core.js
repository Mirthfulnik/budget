/* finance core utilities (testable, no DOM). UMD: window.FinanceCore + CommonJS export */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FinanceCore = factory();
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const MONTHS_SHORT_RU = ["янв","фев","март","апр","май","июн","июл","авг","сент","окт","нояб","дек"];

  function pad2(n){ return String(n).padStart(2,"0"); }

  function isoDate(d){
    const x = (d instanceof Date) ? d : new Date(d);
    return `${x.getFullYear()}-${pad2(x.getMonth()+1)}-${pad2(x.getDate())}`;
  }

  function fmtMonthShort(date){
    const d = (date instanceof Date) ? date : new Date(date);
    return MONTHS_SHORT_RU[d.getMonth()] || "";
  }

  function fmtMonthYear(date){
    const d = (date instanceof Date) ? date : new Date(date);
    return `${fmtMonthShort(d)} ${d.getFullYear()}`;
  }

  function fmtDayMonth(date){
    const d = (date instanceof Date) ? date : new Date(date);
    return `${pad2(d.getDate())} ${fmtMonthShort(d)}`;
  }

  function fmtWeekdayShort(date){
    const d = (date instanceof Date) ? date : new Date(date);
    // Intl short can return "пн" or "пн." depending on engine; normalize by stripping trailing dot(s)
    let w = "";
    try{
      w = d.toLocaleDateString("ru-RU", { weekday: "short" });
    }catch{ w = ""; }
    return String(w).trim().replace(/\.+$/,"");
  }

  function fmtOpDateHeader(date){
    const d = (date instanceof Date) ? date : new Date(date);
    const w = fmtWeekdayShort(d);
    return `${w} · ${fmtDayMonth(d)}`;
  }

  function defaultOpsFiltersLast7Days(today){
    const t = (today instanceof Date) ? today : new Date(today);
    const end = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const start = new Date(end.getTime() - 6*24*60*60*1000);
    return {
      type: "all",
      acc: "all",
      from: isoDate(start),
      to: isoDate(end),
    };
  }

  function sanitizeOpsFilters(obj){
    const o = obj && typeof obj === "object" ? obj : {};
    const type = ["all","income","expense","transfer"].includes(o.type) ? o.type : "all";
    const acc  = (o.acc == null || o.acc === "") ? "all" : String(o.acc);
    const from = typeof o.from === "string" ? o.from.trim() : "";
    const to   = typeof o.to === "string" ? o.to.trim() : "";
    return { type, acc, from, to };
  }

  const OPS_FILTERS_KEY = "finance2026_opsFilters_v1";

  function loadOpsFilters(storage, today){
    try{
      const raw = storage && storage.getItem ? storage.getItem(OPS_FILTERS_KEY) : "";
      if (raw){
        const parsed = JSON.parse(raw);
        return sanitizeOpsFilters(parsed);
      }
    }catch{ /* ignore */ }
    const def = defaultOpsFiltersLast7Days(today || new Date());
    saveOpsFilters(storage, def);
    return def;
  }

  function saveOpsFilters(storage, filters){
    try{
      if (!storage || !storage.setItem) return;
      storage.setItem(OPS_FILTERS_KEY, JSON.stringify(sanitizeOpsFilters(filters)));
    }catch{ /* ignore */ }
  }

  // Pure HTML renderer for operation item. Keeps "right" controls container.
  function renderOperationItemHTML({ op, catName, subName, accName, currency, amountText, sign, note, showMetaDash = true, editOnclick = "", deleteOnclick = "" }){
    const esc = (s)=> String(s ?? "").replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
    const typeLabel = op.type==="expense" ? "Расход" : (op.type==="income" ? "Доход" : "Перевод");
    const metaSub = subName ? esc(subName) : (showMetaDash ? "—" : "");
    const metaNote = note ? esc(note) : (showMetaDash ? "—" : "");
    const metaCur = esc(currency || "");
    const metaAcc = esc(accName || "Счёт");

    return `
      <div class="item op-item" data-op-id="${esc(op.id||"")}">
        <div class="left">
          <div class="opRowTop">
            <span class="tag ${esc(op.type)}">${typeLabel}</span>
            <span class="opAmtMobile">${esc(sign)} ${esc(amountText)}</span>
          </div>
          <div class="opTitle">${esc(catName || "Без категории")}</div>
          <div class="opMeta">${metaAcc} · ${metaSub} · ${metaNote} · ${metaCur}</div>
        </div>
        <div class="right">
          <div class="opAmtDesk" style="font-weight:950">${esc(sign)} ${esc(amountText)}</div>
          <button class="icon-btn edit" aria-label="Редактировать" data-action="edit" ${editOnclick ? `onclick="${editOnclick}"` : ""}>⚙️</button>
          <button class="icon-btn danger" aria-label="Удалить" data-action="delete" ${deleteOnclick ? `onclick="${deleteOnclick}"` : ""}>✕</button>
        </div>
      </div>
    `.trim();
  }

  return {
    MONTHS_SHORT_RU,
    isoDate,
    fmtMonthShort,
    fmtMonthYear,
    fmtDayMonth,
    fmtWeekdayShort,
    fmtOpDateHeader,
    defaultOpsFiltersLast7Days,
    loadOpsFilters,
    saveOpsFilters,
    renderOperationItemHTML,
    OPS_FILTERS_KEY,
  };
});
