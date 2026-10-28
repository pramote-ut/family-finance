/* Money Monitor — PWA frontend */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const TYPE_LABEL = { income: 'รายรับ', expense: 'รายจ่าย', transfer: 'โอนระหว่างบัญชี' };
const SOURCE_LABEL = {
  slip: 'สลิป', statement: 'Statement', email: 'อีเมล', manual: 'กรอกเอง',
  telegram: 'Telegram', line: 'LINE', whatsapp: 'WhatsApp',
};
const CHUNK_CHARS = 8000; // ขนาดข้อความ Statement ต่อการเรียก Claude หนึ่งครั้ง

const state = {
  cfg: loadCfg(),
  meta: { categories: [], members: [], accounts: [], funds: [] },
  funds: null,
  month: '',
  monthPicked: false,
  catMode: (() => { try { return localStorage.getItem('mm_cat_mode') || 'pct'; } catch { return 'pct'; } })(),
  goalFilter: (() => { try { return localStorage.getItem('mm_goal_filter') || 'all'; } catch { return 'all'; } })(),
  dashMember: (() => { try { return localStorage.getItem('mm_dash_member') || ''; } catch { return ''; } })(),
  txs: [],
  drafts: [],
  charts: {},
};

// ---------------------------------------------------------------- utils

function loadCfg() {
  try { return JSON.parse(localStorage.getItem('mm_cfg')) || {}; } catch { return {}; }
}
function saveCfg(cfg) {
  try { localStorage.setItem('mm_cfg', JSON.stringify(cfg)); } catch { /* private mode */ }
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const fmt = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = n => (n < 0 ? '−' : '') + '฿' + fmt.format(Math.abs(n || 0));
function thaiDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });
}
function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}
function progress(msg) {
  const el = $('#progress');
  el.hidden = !msg;
  el.textContent = msg || '';
}

// ---------------------------------------------------------------- API

async function api(action, payload) {
  if (!state.cfg.url) throw new Error('ยังไม่ได้ตั้งค่า URL ของ Backend (ไปที่แท็บตั้งค่า)');
  if (state.cfg.url === 'demo') return demoApi(action, payload);
  // ใช้ text/plain เพื่อไม่ให้เบราว์เซอร์ส่ง CORS preflight ไปที่ Apps Script
  const res = await fetch(state.cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, passcode: state.cfg.passcode, payload }),
  });
  if (!res.ok) throw new Error('เชื่อมต่อ Backend ไม่ได้ (' + res.status + ')');
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  return j.data;
}

// ---------------------------------------------------------------- navigation

function go(view) {
  if (view === 'funds') loadFunds();
  if (view === 'plan') loadPlan();
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tabbar button, .top-nav button').forEach(b => b.classList.toggle('active', b.dataset.goto === view));
  document.body.dataset.view = view;
  // กราฟที่ถูกซ่อนไว้ตอนหน้าจอเปลี่ยนขนาดจะไม่ปรับตัวเอง — สั่งปรับเมื่อกลับมาหน้าภาพรวม
  if (view === 'dashboard') requestAnimationFrame(() => Object.values(state.charts).forEach(c => c.resize()));
  window.scrollTo(0, 0);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-goto]');
  if (b) go(b.dataset.goto);
});

// ---------------------------------------------------------------- meta & options

function categoryOptions(type, selected) {
  const cats = state.meta.categories.filter(c => c.type === type).map(c => c.name);
  if (selected && !cats.includes(selected)) cats.push(selected);
  return cats.map(n => `<option ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
function memberOptions(selected, withBlank) {
  const names = state.meta.members.map(m => m.name);
  if (selected && !names.includes(selected)) names.push(selected);
  return (withBlank ? '<option value="">-</option>' : '') +
    names.map(n => `<option ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
function accountOptions(selected) {
  const names = state.meta.accounts.map(a => a.name);
  if (selected && !names.includes(selected)) names.push(selected);
  return '<option value="">-</option>' +
    names.map(n => `<option ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
function bindCategoryToType(form) {
  form.type.addEventListener('change', () => { form.category.innerHTML = categoryOptions(form.type.value); });
}

/** ตัวเลือกเงินเก็บแบบรวม: "deposit|ชื่อ" / "withdraw|ชื่อ" */
function fundOptions(fund, action) {
  const cur = fund && (action === 'deposit' || action === 'withdraw') ? action + '|' + fund : '';
  const names = (state.meta.funds || []).map(f => f.name);
  if (fund && !names.includes(fund)) names.push(fund);
  return '<option value="">- ไม่เกี่ยวกับเงินเก็บ -</option>' + names.map(n =>
    ['deposit', 'withdraw'].map(a => {
      const v = a + '|' + n;
      return `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${a === 'deposit' ? 'ฝากเข้า' : 'ถอนจาก'} ${esc(n)}</option>`;
    }).join('')).join('');
}
function parseFundSel(v) {
  const i = String(v || '').indexOf('|');
  return i < 0 ? { fund: '', fundAction: '' } : { fundAction: v.slice(0, i), fund: v.slice(i + 1) };
}

// ---------------------------------------------------------------- รอบเดือน (เริ่มวันที่ cycleStartDay)

const cycleDay = () => Number(state.meta.cycleStartDay) || 1;
function isoUTC(y, m0, d) { return new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10); }
/** รอบ 'YYYY-MM' → { from, to, days } */
function periodRange(key) {
  const sd = cycleDay();
  const [y, m] = key.split('-').map(Number);
  return { from: isoUTC(y, m - 1, sd), to: isoUTC(y, m, sd - 1), days: Math.round((Date.UTC(y, m, sd) - Date.UTC(y, m - 1, sd)) / 864e5) };
}
function currentPeriod() {
  const t = today();
  const back = Number(t.slice(8, 10)) >= cycleDay() ? 0 : 1;
  return isoUTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1 - back, 1).slice(0, 7);
}
const dayIndex = (iso, from) => Math.round((Date.parse(iso) - Date.parse(from)) / 864e5);
function shortTh(iso) { return Number(iso.slice(8, 10)) + ' ' + THAI_MONTHS[Number(iso.slice(5, 7)) - 1]; }
function periodText(key) { const r = periodRange(key); return shortTh(r.from) + ' – ' + shortTh(r.to); }
function syncPeriodUi() {
  $('#month').value = state.month;
  $('#period-range').textContent = cycleDay() === 1 ? '' : 'รอบ ' + periodText(state.month);
}

async function loadMeta() {
  state.meta = await api('meta');
  if (!state.monthPicked) state.month = state.meta.currentPeriod || currentPeriod();
  syncPeriodUi();
  renderMemberTabs();
  $$('#cat-mode button').forEach(x => x.classList.toggle('on', x.dataset.mode === state.catMode));
  const cs = $('#cycle-day');
  cs.innerHTML = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${i + 1 === cycleDay() ? 'selected' : ''}>วันที่ ${i + 1}</option>`).join('');
  const s = $('#settings-form');
  s.member.innerHTML = memberOptions(state.cfg.member);
  $('#filter-member').innerHTML = '<option value="">ทุกคน</option>' + memberOptions();
  $('#statement-account').innerHTML = accountOptions();
  const m = $('#mode-manual');
  m.category.innerHTML = categoryOptions(m.type.value);
  m.account.innerHTML = accountOptions();
  m.fundSel.innerHTML = fundOptions();
  $('#member-names').innerHTML = state.meta.members.map(x => `<option value="${esc(x.name)}">`).join('');
}

// ---------------------------------------------------------------- dashboard & list

async function loadMonth() {
  try {
    // backend รุ่นใหม่ส่งรายการของรอบมากับ dashboard เพื่อลดการอ่านทั้งชีตซ้ำ
    const dash = await api('dashboard', { month: state.month, member: state.dashMember }).catch(() => null);
    state.txs = dash && Array.isArray(dash.transactions)
      ? dash.transactions
      : await api('list', { month: state.month }); // รองรับ backend รุ่นเก่า
    state.dash = dash;
    if (dash) state.funds = dash.funds;
    renderDashboard();
    $('#last-updated').textContent = new Date().toLocaleString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    renderList();
  } catch (err) {
    toast(err.message);
  }
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const monthLabel = ym => THAI_MONTHS[Number(ym.slice(5, 7)) - 1] + ' ' + String(Number(ym.slice(0, 4)) + 543).slice(-2);
const pct = (a, b) => (b ? (a - b) / Math.abs(b) * 100 : null);
const fundDelta = t => (t.fundAction === 'deposit' ? t.amount : t.fundAction === 'withdraw' ? -t.amount : 0);

/** delta เทียบเดือนก่อน — สีตาม "ขึ้นแล้วดีไหม" พร้อมลูกศร (ไม่พึ่งสีอย่างเดียว) */
function deltaHtml(cur, prev, upIsGood) {
  const p = pct(cur, prev);
  if (p === null || !isFinite(p)) return '<span class="delta flat">ไม่มีข้อมูลรอบก่อน</span>';
  if (Math.abs(p) < 0.5) return '<span class="delta flat">≈ เท่ารอบก่อน</span>';
  const up = p > 0;
  const cls = up === upIsGood ? 'good' : 'bad';
  return `<span class="delta ${cls}">${up ? '▲' : '▼'} ${Math.abs(p).toFixed(0)}% จากรอบก่อน</span>`;
}

const EXPENSE_PERIOD_META = {
  day: { label: 'วันนี้', icon: '☀', compare: 'เมื่อวาน' },
  week: { label: 'สัปดาห์นี้', icon: '▦', compare: 'สัปดาห์ก่อน' },
  month: { label: 'เดือนนี้', icon: '◫', compare: 'เดือนก่อน' },
  year: { label: 'ปีนี้', icon: '◷', compare: 'ปีก่อน' },
};

function expensePeriodDelta(cur, prev, compare) {
  if (!prev) return cur
    ? `<span class="delta flat">${compare}ยังไม่มีรายจ่าย</span>`
    : '<span class="delta flat">ยังไม่มีรายจ่าย</span>';
  const p = (cur - prev) / prev * 100;
  if (Math.abs(p) < 0.5) return `<span class="delta flat">≈ เท่า${compare}</span>`;
  const up = p > 0;
  return `<span class="delta ${up ? 'bad' : 'good'}">${up ? '▲' : '▼'} ${Math.abs(p).toFixed(0)}% จาก${compare}</span>`;
}

function expensePeriodRange(p, key) {
  if (!p || !p.from || !p.to) return '';
  const text = p.from === p.to ? shortTh(p.from) : `${shortTh(p.from)} – ${shortTh(p.to)}`;
  return key === 'year' ? `${text} ${Number(p.to.slice(0, 4)) + 543}` : text;
}

function renderExpensePeriods(periods) {
  const el = $('#expense-period-grid');
  el.innerHTML = Object.entries(EXPENSE_PERIOD_META).map(([key, meta]) => {
    const p = periods && periods[key] ? periods[key] : { value: 0, previous: 0 };
    return `<article class="expense-period-card ep-${key}">
      <div class="ep-head"><span class="ep-icon" aria-hidden="true">${meta.icon}</span><span>${meta.label}</span></div>
      <strong class="ep-value">${money(p.value)}</strong>
      ${expensePeriodDelta(p.value, p.previous, meta.compare)}
      <small class="ep-range">${expensePeriodRange(p, key)}</small>
    </article>`;
  }).join('');
}

/** กราฟแท่งเล็ก 6 รอบในการ์ด — รอบล่าสุดเข้มสุด */
function minibars(svg, values, color) {
  const n = values.length;
  if (!n || values.every(v => v === 0)) { svg.innerHTML = ''; return; }
  const max = Math.max(...values.map(v => Math.max(v, 0)), 1);
  const w = 60 / n;
  svg.innerHTML = values.map((v, i) => {
    const h = Math.max(2, Math.max(v, 0) / max * 34);
    return `<rect x="${(i * w + w * 0.18).toFixed(1)}" y="${(36 - h).toFixed(1)}" width="${(w * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" opacity="${i === n - 1 ? 1 : 0.3 + 0.1 * i}"/>`;
  }).join('');
}

function sparkline(svg, values, color) {
  const n = values.length;
  if (n < 2 || values.every(v => v === 0)) { svg.innerHTML = ''; return; }
  const min = Math.min(0, ...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [i / (n - 1) * 100, 26 - (v - min) / span * 24]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const last = pts[n - 1];
  svg.innerHTML = `<path d="${d} L100 28 L0 28 Z" fill="${color}" opacity=".1"/>` +
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${last[0]}" cy="${last[1]}" r="3" fill="${color}" stroke="var(--surface)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
}

const catMode = $('#cat-mode');
if (catMode) catMode.addEventListener('click', e => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  state.catMode = b.dataset.mode;
  try { localStorage.setItem('mm_cat_mode', state.catMode); } catch { /* ไม่เป็นไร */ }
  $$('#cat-mode button').forEach(x => x.classList.toggle('on', x === b));
  renderDashboard();
});
/** โหลดทั้งหน้าใหม่พร้อม query กันแคช เพื่อรับ UI รุ่นล่าสุดจาก Apps Script */
function reloadLatestApp() {
  const embeddedUrl = window.MM_EMBED && window.MM_EMBED.url;
  const url = new URL(embeddedUrl || location.href);
  if (embeddedUrl) url.searchParams.set('page', 'app');
  url.searchParams.set('v', Date.now().toString(36));
  if (embeddedUrl) {
    try { window.top.location.href = url.toString(); return; } catch { /* fallback ด้านล่าง */ }
  }
  location.href = url.toString();
}
$('#refresh-btn').addEventListener('click', reloadLatestApp);
document.body.dataset.view = 'dashboard';

/** แถบ ทั้งบ้าน | พ่อ | แม่ | … บนหน้าภาพรวม */
function renderMemberTabs() {
  const names = state.meta.members.map(m => m.name);
  if (state.dashMember && !names.includes(state.dashMember)) state.dashMember = '';
  $('#member-tabs').innerHTML = ['', ...names].map(n =>
    `<button role="tab" data-member="${esc(n)}" aria-selected="${n === state.dashMember}">${n ? esc(n) : 'ทั้งบ้าน'}</button>`).join('');
  $('#member-tabs').hidden = names.length < 2;
}
$('#member-tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-member]');
  if (!b || b.dataset.member === state.dashMember) return;
  state.dashMember = b.dataset.member;
  try { localStorage.setItem('mm_dash_member', state.dashMember); } catch { /* ไม่เป็นไร */ }
  $$('#member-tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  loadMonth();
});

function renderDashboard() {
  // ทั้งหน้าคิดเฉพาะคนที่เลือก ยกเว้นตาราง "แยกตามสมาชิก" และเงินเก็บ (ทั้งบ้าน)
  const txs = state.dashMember ? state.txs.filter(t => t.member === state.dashMember) : state.txs;
  const dash = state.dash;
  const sum = type => txs.filter(t => t.type === type).reduce((a, t) => a + t.amount, 0);
  const income = sum('income');
  const expense = sum('expense');
  const saving = txs.reduce((a, t) => a + fundDelta(t), 0);
  const net = income - expense;
  const months = dash ? dash.months : [];
  const prev = months.length > 1 ? months[months.length - 2] : null;
  const col = { income: cssVar('--s-income'), expense: cssVar('--s-expense'), saving: cssVar('--s-saving') };

  // ---- hero
  $('#trend-sub').textContent = 'รายรับและรายจ่าย' + (cycleDay() === 1 ? 'รายเดือน' : ' · แต่ละรอบเริ่มวันที่ ' + cycleDay());
  $('#hero-month').textContent = (state.dashMember ? state.dashMember + ' · ' : '') + (cycleDay() === 1 ? monthLabel(state.month) : 'รอบ ' + periodText(state.month));
  $('#hero-net').textContent = money(net);
  const rate = income > 0 ? Math.round(saving / income * 100) : null;
  $('#hero-rate').textContent = income > 0 ? `ใช้ไป ${Math.round(expense / income * 100)}% ของรายรับ` : 'ยังไม่มีรายรับ';
  $('#hero-sub').textContent = income > 0
    ? (net >= 0 ? `ออมได้ ${rate}% ของรายรับ` : `ใช้เกินรายรับ ${money(-net)}`)
    : 'เพิ่มรายการเพื่อดูภาพรวม';
  const base = Math.max(income, expense + Math.max(saving, 0), 1);
  const parts = [
    ['a-expense', expense, 'รายจ่าย'],
    ['a-saving', Math.max(saving, 0), 'ออม'],
    ['a-left', Math.max(income - expense - Math.max(saving, 0), 0), 'เหลือใช้'],
  ].filter(p => p[1] > 0);
  $('#hero-alloc').innerHTML = parts.map(p => `<i class="${p[0]}" style="flex:${p[1] / base}"></i>`).join('');
  $('#hero-alloc-legend').innerHTML = parts.map(p =>
    `<div class="al ${p[0]}"><span>${p[2]} ${Math.round(p[1] / base * 100)}%</span><b>${money(p[1])}</b></div>`).join('');

  // ---- KPI tiles
  $('#kpi-income').textContent = money(income);
  $('#kpi-expense').textContent = money(expense);
  $('#kpi-saving').textContent = money(net);
  $('#kpi-income-delta').outerHTML = `<span id="kpi-income-delta">${prev ? deltaHtml(income, prev.income, true) : ''}</span>`;
  $('#kpi-expense-delta').outerHTML = `<span id="kpi-expense-delta">${prev ? deltaHtml(expense, prev.expense, false) : ''}</span>`;
  $('#kpi-saving-delta').outerHTML = `<span id="kpi-saving-delta">${prev ? deltaHtml(net, prev.income - prev.expense, true) : ''}</span>`;
  minibars($('#spark-income'), months.map(m => m.income), col.income);
  minibars($('#spark-expense'), months.map(m => m.expense), col.expense);
  minibars($('#spark-saving'), months.map(m => m.income - m.expense), col.saving);
  const funds = dash ? dash.funds : null;
  $('#kpi-funds').textContent = funds ? money(funds.totalBalance) : '–';
  $('#kpi-funds-sub').textContent = funds ? `${funds.funds.length} กอง` : '';
  renderExpensePeriods(dash && dash.expensePeriods);

  // ---- expense by category: doughnut + compact legend (ตามหน้าอ้างอิง)
  const byCat = groupSum(txs.filter(t => t.type === 'expense'), 'category');
  const prevByCat = dash ? dash.prevByCat : {};
  const catList = topWithOther(byCat, 6);
  const catColors = ['#ea765f', '#3aa6b7', '#e4a13a', '#8c73b8', '#d87b9a', '#aeb7b2'];
  $('#cat-total').textContent = money(expense);
  $('#cat-bars').innerHTML = catList.length ? catList.map(([name, v], i) => {
    const share = expense ? v / expense * 100 : 0;
    return `<div class="cat-legend-row" title="${esc(name)}: ${money(v)}">
      <span class="cat-dot" style="background:${catColors[i]}"></span>
      <span class="cat-name">${catIcon(name)} ${esc(name)}</span>
      <b>${share.toFixed(0)}%</b>
    </div>`;
  }).join('') : '<p class="empty">ยังไม่มีรายจ่ายรอบนี้</p>';
  const donutValues = catList.length ? catList.map(c => c[1]) : [1];
  drawChart('cats', {
    type: 'doughnut',
    data: {
      labels: catList.length ? catList.map(c => c[0]) : ['ยังไม่มีรายจ่าย'],
      datasets: [{
        data: donutValues,
        backgroundColor: catList.length ? catColors.slice(0, catList.length) : ['#e8e5dd'],
        borderWidth: 0,
        hoverOffset: catList.length ? 4 : 0,
      }],
    },
    options: {
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: catList.length > 0,
          callbacks: { label: c => ` ${c.label}: ${money(c.parsed)}` },
        },
      },
    },
  });

  // ---- income sources
  const byInc = groupSum(txs.filter(t => t.type === 'income'), 'category');
  const incList = topWithOther(byInc, 5);
  const incMax = Math.max(1, ...incList.map(c => c[1]));
  $('#inc-bars').innerHTML = incList.length ? incList.map(([name, v]) => `<div class="hbar-row">
      <span class="hbar-name">${esc(name)}</span><span class="hbar-val">${money(v)}<small>${(v / income * 100).toFixed(0)}%</small></span>
      <span class="hbar-track income"><i style="width:${v / incMax * 100}%"></i></span></div>`).join('')
    : '<p class="empty">ยังไม่มีรายรับรอบนี้</p>';

  // ---- 6-month trend
  const grid = cssVar('--grid');
  const muted = cssVar('--muted');
  const font = { family: 'IBM Plex Sans Thai' };
  const barDs = (label, key, color) => ({
    label, data: months.map(m => m[key]), backgroundColor: color,
    borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start', maxBarThickness: 18, categoryPercentage: 0.7, barPercentage: 0.9,
  });
  drawChart('trend', {
    type: 'bar',
    data: {
      labels: months.map(m => monthLabel(m.month)),
      datasets: [barDs('รายรับ', 'income', col.income), barDs('รายจ่าย', 'expense', col.expense)],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: grid }, ticks: { color: muted, font } },
        y: { grid: { color: grid }, border: { display: false }, ticks: { color: muted, font, callback: v => compact.format(v) } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ' ' + c.dataset.label + ': ' + money(c.parsed.y) } },
      },
    },
  });

  // ---- cumulative daily spend vs previous period
  const range = periodRange(state.month);
  const days = range.days;
  const daily = Array(days).fill(0);
  txs.filter(t => t.type === 'expense').forEach(t => {
    const i = dayIndex(t.date, range.from);
    if (i >= 0 && i < days) daily[i] += t.amount;
  });
  const now = today();
  const lastDay = now > range.to ? days : now < range.from ? 0 : dayIndex(now, range.from) + 1;
  const dayLabels = Array.from({ length: days }, (_, i) => isoUTC(+range.from.slice(0, 4), +range.from.slice(5, 7) - 1, +range.from.slice(8, 10) + i));
  let run = 0;
  const cum = daily.map((v, i) => (i < lastDay ? (run += v) : null));
  const prevCum = dash ? dash.prevDaily : [];
  const prevAtSameDay = lastDay && prevCum.length ? prevCum[Math.min(lastDay, prevCum.length) - 1] : null;
  $('#pace-sub').innerHTML = prevAtSameDay !== null && lastDay
    ? (Math.abs(run - prevAtSameDay) < 1 ? `ถึง ${shortTh(dayLabels[lastDay - 1])} (วันที่ ${lastDay} ของรอบ) ใช้เท่ากับรอบก่อน`
      : run > prevAtSameDay
      ? `ถึง ${shortTh(dayLabels[lastDay - 1])} (วันที่ ${lastDay} ของรอบ) ใช้มากกว่ารอบก่อน ${money(run - prevAtSameDay)}`
      : `ถึง ${shortTh(dayLabels[lastDay - 1])} (วันที่ ${lastDay} ของรอบ) ใช้น้อยกว่ารอบก่อน ${money(prevAtSameDay - run)}`)
    : 'เทียบกับรอบก่อน ณ วันเดียวกันของรอบ';
  drawChart('cum', {
    type: 'line',
    data: {
      labels: dayLabels.map(d => Number(d.slice(8, 10))),
      datasets: [
        { label: 'รอบนี้', data: cum, borderColor: col.expense, backgroundColor: hexA(col.expense, 0.1), fill: 'origin',
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.25, spanGaps: false },
        { label: 'รอบก่อน', data: prevCum.slice(0, days), borderColor: cssVar('--s-compare'), borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 4, tension: 0.25, fill: false },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: grid }, ticks: { color: muted, font, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { grid: { color: grid }, border: { display: false }, ticks: { color: muted, font, callback: v => compact.format(v) } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: c => shortTh(dayLabels[c[0].dataIndex]), label: c => ' ' + c.dataset.label + ': ' + money(c.parsed.y) } },
      },
    },
  });

  // ---- funds
  const FI = { child: '👶', emergency: '🛟', family: '🏠', gold: '🪙', other: '🎯' };
  $('#dash-funds-sub').textContent = funds ? `รวม ${money(funds.totalBalance)} · รอบนี้ ${saving >= 0 ? '+' : ''}${money(saving)}` : '';
  $('#dash-funds').innerHTML = funds && funds.funds.length ? funds.funds.map(f => {
    const p = f.target > 0 ? Math.max(0, Math.min(100, f.balance / f.target * 100)) : null;
    const g = f.kind === 'gold' && funds.gold;
    if (g) {
      return `<div class="fmini">
      <span class="fi">🪙</span>
      <span class="fn">${esc(f.name)}</span><span class="fv">${money(g.value !== null ? g.value : g.cost)}</span>
      <span class="fbar"><small>${fmtGold(g.grams)}${g.profit !== null ? ` · ${g.profit >= 0 ? '▲' : '▼'} ${money(Math.abs(g.profit))} จากต้นทุน` : ''}</small></span>
    </div>`;
    }
    return `<div class="fmini">
      <span class="fi">${FI[f.kind] || '🎯'}</span>
      <span class="fn">${esc(f.name)}</span><span class="fv">${money(f.balance)}</span>
      <span class="fbar">${p === null
        ? '<small>ยังไม่ตั้งเป้าหมาย</small>'
        : `<span class="hbar-track"><i style="width:${p}%"></i></span><small>${p.toFixed(0)}% ของ ${compact.format(f.target)}</small>`}</span>
    </div>`;
  }).join('') : '<p class="empty">ยังไม่มีเงินเก็บ</p>';

  // ---- members (ทั้งบ้านเสมอ)
  const byMember = {};
  state.txs.forEach(t => {
    const k = t.member || '-';
    byMember[k] = byMember[k] || { income: 0, expense: 0, saving: 0 };
    if (t.type === 'income') byMember[k].income += t.amount;
    if (t.type === 'expense') byMember[k].expense += t.amount;
    byMember[k].saving += fundDelta(t);
  });
  const rows = Object.entries(byMember).sort((a, b) => b[1].expense - a[1].expense);
  const mMax = Math.max(1, ...rows.map(r => Math.max(r[1].income, r[1].expense)));
  const cell = (v, c) => `<td>${money(v)}<span class="mini"><i style="width:${Math.max(0, v) / mMax * 100}%;background:${c}"></i></span></td>`;
  $('#member-table').innerHTML = rows.length
    ? '<tr><th>สมาชิก</th><th>รายรับ</th><th>รายจ่าย</th><th>ออม</th></tr>' +
      rows.map(([k, v]) => `<tr class="${k === state.dashMember ? 'me' : ''}"><td>${esc(k)}</td>${cell(v.income, col.income)}${cell(v.expense, col.expense)}<td>${money(v.saving)}</td></tr>`).join('')
    : '<tr><td class="empty">ยังไม่มีข้อมูล</td></tr>';

  renderUpcomingBox(dash && dash.plan);
  renderBudgetBox(dash && dash.plan);

  $('#recent-list').innerHTML = txs.slice(0, 4).map(txItem).join('') || '<li class="empty">ยังไม่มีรายการรอบนี้</li>';

  renderInsights({ income, expense, saving, net, prev, byCat, prevByCat, funds, rate, run, prevAtSameDay, lastDay });
}

function renderInsights(d) {
  const out = []; // [ไอคอน, หัวข้อ, คำอธิบาย]
  if (d.net < 0) out.push(['🚨', `ใช้เกินรายรับ ${money(-d.net)}`, 'รอบนี้รายจ่ายมากกว่ารายรับ']);
  if (d.prev && d.prev.expense > 0) {
    const p = pct(d.expense, d.prev.expense);
    out.push(p > 0 ? ['📈', `รายจ่ายเพิ่มขึ้น ${p.toFixed(0)}%`, 'จากรอบก่อน'] : ['📊', `รายจ่ายลดลง ${Math.abs(p).toFixed(0)}%`, 'จากรอบก่อน']);
  }
  const diffs = Object.keys(d.byCat).map(c => [c, d.byCat[c] - (d.prevByCat[c] || 0)]).sort((a, b) => b[1] - a[1]);
  if (diffs.length && diffs[0][1] > 0 && d.prev) out.push(['💡', 'หมวดที่จ่ายเพิ่มมากที่สุด', `${esc(diffs[0][0])} (+${money(diffs[0][1])})`]);
  if (d.rate !== null) {
    out.push(d.rate >= 20 ? ['🌱', `ออมได้ ${d.rate}% ของรายรับ`, 'อยู่ในเกณฑ์ดี (เป้าหมาย ≥ 20%)']
      : ['🎯', `ออมได้ ${d.rate}% ของรายรับ`, 'ลองตั้งเป้าให้ถึง 20%']);
  }
  if (d.funds) {
    const em = d.funds.funds.find(f => f.kind === 'emergency');
    const sug = d.funds.emergencySuggest;
    if (em && sug && sug.monthlyAvg > 0) {
      const mo = em.balance / sug.monthlyAvg;
      out.push([mo >= 6 ? '🛟' : '⚠️', `เงินสำรองฉุกเฉินพอใช้ ${mo.toFixed(1)} เดือน`, mo >= 6 ? 'ถึงเป้าที่แนะนำแล้ว' : '(แนะนำ 6 เดือน)']);
    }
  }
  $('#insights').innerHTML = out.slice(0, 4).map(([ic, t, sub]) =>
    `<div class="insight"><span class="iic">${ic}</span><div><div class="it">${t}</div><div class="is">${sub}</div></div></div>`).join('');
  $('#insights').hidden = !out.length;
}

function groupSum(list, key) {
  const o = {};
  list.forEach(t => { o[t[key]] = (o[t[key]] || 0) + t.amount; });
  return o;
}

/** top N หมวด ที่เหลือรวมเป็น "อื่นๆ (รวม)" — ไม่สร้างสี/แถวใหม่ไม่รู้จบ */
function topWithOther(obj, n) {
  const e = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (e.length <= n) return e;
  const rest = e.slice(n - 1).reduce((a, x) => a + x[1], 0);
  return [...e.slice(0, n - 1), ['อื่นๆ (รวม)', rest]];
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

/** วันที่/เวลาตามสลิป เช่น "28 ก.ย. 69 12:40" */
function txWhen(t) {
  if (!t.date) return '';
  const [y, m, d] = t.date.split('-').map(Number);
  return `${d} ${THAI_MONTHS[m - 1]} ${String(y + 543).slice(-2)}` + (t.time ? ' ' + t.time : '');
}
/** เวลาที่บันทึกเข้าระบบ (createdAt) */
function recordedWhen(t) {
  const d = t.createdAt ? new Date(t.createdAt) : null;
  return d && !isNaN(d) ? d.toLocaleString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

/** ไอคอนตามชื่อหมวด (จับคำในชื่อ ใช้กับหมวดที่ผู้ใช้ตั้งเองได้ด้วย) */
const CAT_ICONS = [
  [/อาหาร|เครื่องดื่ม|กาแฟ/, '🍴'], [/เดินทาง|น้ำมัน|รถ/, '🚗'], [/ที่พัก|ค่าเช่า|บ้าน|คอนโด/, '🏠'],
  [/บิล|สาธารณูปโภค|ค่าไฟ|ค่าน้ำ|เน็ต|โทรศัพท์/, '💡'],
  [/ประกัน/, '🛡️'], [/สุขภาพ|ยา|โรงพยาบาล/, '💊'], [/ช้อป/, '🛍️'], [/การศึกษา|เรียน/, '🎓'],
  [/บันเทิง/, '🎬'], [/ครอบครัว|บุตร|ลูก/, '👨‍👩‍👧'], [/ทอง/, '🪙'], [/ลงทุน/, '📈'], [/ออม/, '🐷'], [/ภาษี|ค่าธรรมเนียม/, '🧾'],
  [/โอน/, '🔁'], [/เงินเดือน/, '💼'], [/ธุรกิจ|ขาย/, '🏪'], [/ดอกเบี้ย|ปันผล/, '🏦'],
];
function catIcon(name) {
  const hit = CAT_ICONS.find(([re]) => re.test(name || ''));
  return hit ? hit[1] : '•';
}

function txItem(t) {
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
  return `<li class="tx" data-id="${esc(t.id)}">
    <span class="tico">${t.fund && t.goldGrams > 0 ? '🪙' : catIcon(t.category)}</span>
    <span class="title">${esc(t.counterparty || t.category)}${t.slipUrl ? '<span class="clip" title="มีหลักฐาน">📎</span>' : ''}</span>
    <span class="amt ${esc(t.type)}">${sign}${money(t.amount)}</span>
    <span class="sub">${esc(t.category)} · ${esc(SOURCE_LABEL[t.source] || t.source)}${t.member ? ' · ' + esc(t.member) : ''}</span>
    <span class="sub when" title="วันที่ตามสลิป/รายการ">${esc(txWhen(t))}</span>
  </li>`;
}

function renderList() {
  const q = $('#filter-text').value.trim().toLowerCase();
  const type = $('#filter-type').value;
  const member = $('#filter-member').value;
  const list = state.txs.filter(t =>
    (!type || t.type === type) && (!member || t.member === member) &&
    (!q || [t.counterparty, t.category, t.note, t.account].join(' ').toLowerCase().includes(q)));
  let html = '';
  let lastDate = '';
  list.forEach(t => {
    if (t.date !== lastDate) { html += `<li class="day-head">${esc(thaiDate(t.date))}</li>`; lastDate = t.date; }
    html += txItem(t);
  });
  $('#tx-list').innerHTML = html || '<li class="empty" style="padding:16px 4px">ไม่พบรายการ</li>';
}
['#filter-text', '#filter-type', '#filter-member'].forEach(s => $(s).addEventListener('input', renderList));

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function drawChart(key, config) {
  if (!window.Chart) return;
  if (state.charts[key]) state.charts[key].destroy();
  state.charts[key] = new Chart($('#chart-' + key), config);
}

// ---------------------------------------------------------------- edit dialog

let editing = null;
const isGoldFund = name => !!name && (state.meta.funds || []).some(x => x.name === name && x.kind === 'gold');
function syncGoldField() {
  const show = isGoldFund(parseFundSel(editForm.fundSel.value).fund);
  editForm.querySelector('.gold-only').hidden = !show;
}
const editForm = $('#edit-form');
bindCategoryToType(editForm);
editForm.fundSel.addEventListener('change', syncGoldField);

document.addEventListener('click', e => {
  const li = e.target.closest('.tx[data-id]');
  if (!li) return;
  const t = state.txs.find(x => x.id === li.dataset.id);
  if (!t) return;
  editing = t;
  const f = editForm;
  f.type.value = t.type;
  f.amount.value = t.amount;
  f.date.value = t.date;
  f.time.value = t.time;
  f.category.innerHTML = categoryOptions(t.type, t.category);
  f.member.innerHTML = memberOptions(t.member, true);
  f.account.innerHTML = accountOptions(t.account);
  f.counterparty.value = t.counterparty;
  f.note.value = t.note;
  f.fundSel.innerHTML = fundOptions(t.fund, t.fundAction);
  f.goldGrams.value = Number(t.goldGrams) > 0 ? t.goldGrams : '';
  syncGoldField();
  $('#edit-evidence-label').textContent = t.slipUrl ? '📎 เปลี่ยนรูปหลักฐาน' : '📎 แนบรูปหลักฐาน';
  $('#edit-meta').innerHTML = `วันที่ตามสลิป: <b>${esc(txWhen(t))}</b>` +
    (recordedWhen(t) ? ` · บันทึกเข้าระบบ: ${esc(recordedWhen(t))}` : '') + '<br>' +
    `ที่มา: ${esc(SOURCE_LABEL[t.source] || t.source)}` +
    (t.ref ? ` · เลขอ้างอิง ${esc(t.ref)}` : '') +
    (t.slipUrl ? ` · <a href="${esc(t.slipUrl)}" target="_blank" rel="noopener">เปิดหลักฐาน ↗</a>` : '');
  $('#edit-dialog').showModal();
});

$('#edit-dialog').addEventListener('close', async () => {
  if ($('#edit-dialog').returnValue !== 'save' || !editing) return;
  const f = editForm;
  const fields = {
    type: f.type.value, amount: Number(f.amount.value), date: f.date.value, time: f.time.value,
    category: f.category.value, member: f.member.value, account: f.account.value,
    counterparty: f.counterparty.value, note: f.note.value, ...parseFundSel(f.fundSel.value),
    goldGrams: isGoldFund(parseFundSel(f.fundSel.value).fund) ? Number(f.goldGrams.value) || 0 : 0,
  };
  try {
    await api('update', { id: editing.id, fields });
    toast('บันทึกแล้ว');
    loadMonth();
  } catch (err) { toast(err.message); }
});

$('#edit-evidence').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !editing) return;
  $('#edit-evidence-label').textContent = 'กำลังอัปโหลด …';
  try {
    const r = await api('attachEvidence', { id: editing.id, ...(await evidencePayload(file)) });
    editing.slipUrl = r.slipUrl;
    editing.slipId = r.slipId;
    $('#edit-evidence-label').textContent = '✓ แนบแล้ว';
    $('#edit-meta').innerHTML = `ที่มา: ${esc(SOURCE_LABEL[editing.source] || editing.source)} · <a href="${esc(r.slipUrl)}" target="_blank" rel="noopener">เปิดหลักฐาน ↗</a>`;
    renderList();
  } catch (err) {
    $('#edit-evidence-label').textContent = '📎 แนบรูปหลักฐาน';
    toast(err.message);
  }
});

$('#edit-delete').addEventListener('click', async () => {
  if (!editing || !confirm('ลบรายการนี้?')) return;
  $('#edit-dialog').close();
  try {
    await api('remove', { id: editing.id });
    toast('ลบแล้ว');
    loadMonth();
  } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------------- add: modes

$$('.seg').forEach(b => b.addEventListener('click', () => {
  $$('.seg').forEach(x => x.classList.toggle('active', x === b));
  $$('.mode').forEach(m => { m.hidden = m.id !== 'mode-' + b.dataset.mode; });
}));

// ---- manual
const manual = $('#mode-manual');
bindCategoryToType(manual);
manual.date.value = today();
manual.addEventListener('submit', async e => {
  e.preventDefault();
  const tx = Object.fromEntries(new FormData(manual));
  tx.amount = Number(tx.amount);
  tx.source = 'manual';
  Object.assign(tx, parseFundSel(tx.fundSel));
  delete tx.fundSel;
  delete tx.evidence;
  tx.member = state.cfg.member;
  const file = manual.evidence.files[0];
  try {
    if (file) {
      toast('กำลังอัปโหลดหลักฐาน …');
      Object.assign(tx, await api('attachEvidence', await evidencePayload(file)));
    }
    await api('add', { txs: [tx], member: state.cfg.member });
    toast('บันทึกแล้ว');
    manual.amount.value = '';
    manual.counterparty.value = '';
    manual.note.value = '';
    manual.evidence.value = '';
    loadMonth();
  } catch (err) { toast(err.message); }
});

// ---- slips
$('#slip-input').addEventListener('change', async e => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  for (let i = 0; i < files.length; i++) {
    progress(`กำลังอ่านสลิป ${i + 1}/${files.length} …`);
    try {
      const img = await loadImage(files[i]);
      const qr = decodeQR(img);
      const { base64, dataUrl } = resizeToJpeg(img, 1600);
      const res = await api('parseSlip', { image: base64, mediaType: 'image/jpeg', qr, member: state.cfg.member });
      if (!res.isTransaction || !res.transactions.length) {
        toast(`รูปที่ ${i + 1} ไม่ใช่สลิปรายการเงิน`);
        continue;
      }
      res.transactions.forEach(t => addDraft(t, dataUrl));
    } catch (err) {
      toast(`รูปที่ ${i + 1}: ${err.message}`);
    }
  }
  progress('');
});

/** เตรียมไฟล์หลักฐานสำหรับอัปโหลด: รูปย่อเหลือ ≤1600px (JPEG), PDF ส่งตามเดิม */
async function evidencePayload(file) {
  if (file.type === 'application/pdf') {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { image: btoa(bin), mediaType: 'application/pdf' };
  }
  const img = await loadImage(file);
  return { image: resizeToJpeg(img, 1600).base64, mediaType: 'image/jpeg' };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => reject(new Error('เปิดรูปไม่ได้'));
    img.src = url;
  });
}

function drawScaled(img, max) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { c, ctx };
}

/** อ่าน QR มุมสลิป (ใช้เป็นกุญแจกันสลิปซ้ำ) ลองหลายขนาดเพราะ QR ในสลิปมักเล็ก */
function decodeQR(img) {
  if (!window.jsQR) return '';
  for (const size of [1200, 2000, 800]) {
    const { c, ctx } = drawScaled(img, size);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const r = jsQR(data.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
    if (r && r.data) return r.data;
  }
  return '';
}

function resizeToJpeg(img, max) {
  const { c } = drawScaled(img, max);
  const dataUrl = c.toDataURL('image/jpeg', 0.85);
  return { dataUrl, base64: dataUrl.split(',')[1] };
}

// ---- statements
const PDF_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const PDF_WORKER_SRI = 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2';
let pdfWorkerReady;
async function ensurePdfWorker() {
  if (!window.pdfjsLib) throw new Error('โหลดตัวอ่าน PDF ไม่สำเร็จ');
  if (!pdfWorkerReady) {
    pdfWorkerReady = fetch(PDF_WORKER_URL, {
      integrity: PDF_WORKER_SRI, mode: 'cors', credentials: 'omit', cache: 'force-cache',
    }).then(r => {
      if (!r.ok) throw new Error('โหลด PDF worker ไม่สำเร็จ (' + r.status + ')');
      return r.blob();
    }).then(blob => {
      const url = URL.createObjectURL(blob);
      pdfjsLib.GlobalWorkerOptions.workerSrc = url;
      return url;
    });
  }
  return pdfWorkerReady;
}

$('#statement-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const account = $('#statement-account').value;
  try {
    progress('กำลังอ่านไฟล์ …');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const chunks = isPdf ? chunkPages(await pdfPages(file)) : chunkCsv(await readTextSmart(file));
    let found = 0;
    for (let i = 0; i < chunks.length; i++) {
      progress(`กำลังให้ AI แยกรายการ ส่วนที่ ${i + 1}/${chunks.length} …`);
      const res = await api('parseStatement', { text: chunks[i], account, member: state.cfg.member });
      res.transactions.forEach(t => addDraft(t));
      found += res.transactions.length;
    }
    toast(`พบ ${found} รายการ ตรวจสอบแล้วกดบันทึก`);
  } catch (err) {
    toast(err.message);
  }
  progress('');
});

async function pdfPages(file) {
  await ensurePdfWorker();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({ data });
  // Statement ธนาคารไทยมักติดรหัส (เช่น วันเดือนปีเกิด) — ถามรหัสแล้วถอดในเครื่อง ไม่ส่งรหัสออกไป
  task.onPassword = (update, reason) => {
    const msg = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? 'รหัสไม่ถูกต้อง ลองใหม่:' : 'ไฟล์นี้ติดรหัสผ่าน กรอกรหัส:';
    const pw = prompt(msg);
    if (pw === null) task.destroy(); else update(pw);
  };
  const pdf = await task.promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // จัดข้อความเป็นบรรทัดตามตำแหน่งแนวตั้ง เพื่อให้แถวตารางยังอยู่ด้วยกัน
    const lines = new Map();
    content.items.forEach(it => {
      const y = Math.round(it.transform[5] / 3);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: it.transform[4], s: it.str });
    });
    const text = Array.from(lines.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) => items.sort((a, b) => a.x - b.x).map(i => i.s).join('  ').trim())
      .filter(Boolean)
      .join('\n');
    pages.push(text);
  }
  return pages;
}

function chunkPages(pages) {
  const chunks = [];
  let cur = '';
  pages.forEach(p => {
    if (cur && cur.length + p.length > CHUNK_CHARS) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + p;
  });
  if (cur) chunks.push(cur);
  return chunks;
}

/** CSV จากธนาคารไทยบางแห่งเป็น TIS-620 — ถ้าอ่านเป็น UTF-8 แล้วเพี้ยนให้ลอง windows-874 */
async function readTextSmart(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('windows-874').decode(buf);
}

function chunkCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const header = lines.shift() || '';
  const chunks = [];
  let cur = [];
  let len = 0;
  lines.forEach(l => {
    if (cur.length && len + l.length > CHUNK_CHARS) { chunks.push([header, ...cur].join('\n')); cur = []; len = 0; }
    cur.push(l);
    len += l.length;
  });
  if (cur.length) chunks.push([header, ...cur].join('\n'));
  return chunks;
}

// ---- drafts (รายการร่างให้ตรวจก่อนบันทึก)

function addDraft(t, imgUrl) {
  state.drafts.push({ ...t, _key: Math.random().toString(36).slice(2), _img: imgUrl || '', _checked: !t.dupOf });
  renderDrafts();
}

function renderDrafts() {
  const box = $('#drafts');
  box.innerHTML = state.drafts.map(d => `
    <div class="card draft ${esc(d.type)}" data-key="${d._key}">
      <div class="draft-head">
        <input type="checkbox" data-f="_checked" ${d._checked ? 'checked' : ''} aria-label="เลือกบันทึก">
        <strong>${money(d.amount)}</strong>
        ${d.dupOf ? `<span class="badge">${d.dupSure ? 'ซ้ำกับรายการเดิม' : 'อาจซ้ำ'}</span>` : ''}
        <span class="src">${esc(SOURCE_LABEL[d.source] || d.source)}</span>
      </div>
      ${d._img ? `<img src="${d._img}" alt="สลิป">` : ''}
      <div class="grid2">
        <label class="field">ประเภท
          <select data-f="type">${['expense', 'income', 'transfer'].map(k =>
            `<option value="${k}" ${k === d.type ? 'selected' : ''}>${TYPE_LABEL[k]}</option>`).join('')}</select>
        </label>
        <label class="field">จำนวนเงิน<input data-f="amount" type="number" step="0.01" value="${esc(d.amount)}"></label>
        <label class="field">วันที่<input data-f="date" type="date" value="${esc(d.date)}"></label>
        <label class="field">เวลา<input data-f="time" type="time" value="${esc(d.time)}"></label>
        <label class="field">หมวดหมู่<select data-f="category">${categoryOptions(d.type, d.category)}</select></label>
        <label class="field">สมาชิก<select data-f="member">${memberOptions(d.member, true)}</select></label>
      </div>
      <label class="field">บัญชี/ช่องทาง<select data-f="account">${accountOptions(d.account)}</select></label>
      <label class="field">ผู้รับ/ผู้จ่าย<input data-f="counterparty" value="${esc(d.counterparty)}"></label>
      <label class="field">บันทึก<input data-f="note" value="${esc(d.note)}"></label>
      <label class="field">เงินเก็บ<select data-f="fundSel">${fundOptions(d.fund, d.fundAction)}</select></label>
      ${isGoldFund(d.fund) ? `<label class="field">น้ำหนักทอง (กรัม)<input data-f="goldGrams" type="number" step="0.001" value="${esc(Number(d.goldGrams) > 0 ? d.goldGrams : '')}" placeholder="1 บาท = 15.244 · 1 สลึง = 3.811"></label>` : ''}
    </div>`).join('');
  $('#drafts-actions').hidden = state.drafts.length === 0;
}

$('#drafts').addEventListener('change', e => {
  const el = e.target.closest('[data-f]');
  const card = e.target.closest('.draft');
  if (!el || !card) return;
  const d = state.drafts.find(x => x._key === card.dataset.key);
  const f = el.dataset.f;
  if (f === 'fundSel') { Object.assign(d, parseFundSel(el.value)); return renderDrafts(); }
  if (f === 'goldGrams') { d.goldGrams = Number(el.value) || 0; return; }
  d[f] = f === '_checked' ? el.checked : f === 'amount' ? Number(el.value) : el.value;
  if (f === 'type') {
    d.category = '';
    card.className = 'card draft ' + d.type;
    card.querySelector('[data-f=category]').innerHTML = categoryOptions(d.type);
    d.category = card.querySelector('[data-f=category]').value;
  }
});

$('#drafts-clear').addEventListener('click', () => { state.drafts = []; renderDrafts(); });

$('#drafts-save').addEventListener('click', async () => {
  const chosen = state.drafts.filter(d => d._checked);
  if (!chosen.length) return toast('ยังไม่ได้เลือกรายการ');
  const btn = $('#drafts-save');
  btn.disabled = true;
  try {
    const txs = chosen.map(({ _key, _img, _checked, dupOf, dupSure, ...t }) => t);
    const res = await api('add', { txs, member: state.cfg.member });
    toast(`บันทึก ${res.added} รายการ` + (res.skipped ? ` (ข้ามที่ซ้ำ ${res.skipped})` : '') +
      (res.billsPaid ? ` · ตรงกับรายจ่ายล่วงหน้า ${res.billsPaid} รายการ (ทำเครื่องหมายจ่ายแล้ว)` : ''));
    state.drafts = state.drafts.filter(d => !d._checked);
    renderDrafts();
    loadMonth();
  } catch (err) {
    toast(err.message);
  }
  btn.disabled = false;
});

// ---------------------------------------------------------------- settings

const settings = $('#settings-form');
settings.url.value = state.cfg.url || '';
settings.passcode.value = state.cfg.passcode || '';

settings.addEventListener('submit', async e => {
  e.preventDefault();
  state.cfg = { url: settings.url.value.trim(), passcode: settings.passcode.value, member: settings.member.value };
  saveCfg(state.cfg);
  $('#settings-status').textContent = 'กำลังเชื่อมต่อ …';
  try {
    await loadMeta();
    if (!state.cfg.member && state.meta.members[0]) {
      state.cfg.member = state.meta.members[0].name;
      saveCfg(state.cfg);
      settings.member.value = state.cfg.member;
    }
    $('#settings-status').textContent = 'เชื่อมต่อสำเร็จ ✓';
    loadMonth();
  } catch (err) {
    $('#settings-status').textContent = err.message;
  }
});

$('#sync-gmail').addEventListener('click', async () => {
  $('#gmail-status').textContent = 'กำลังดึงอีเมล …';
  try {
    const r = await api('syncGmail');
    $('#gmail-status').textContent = `ตรวจ ${r.checked} ฉบับ นำเข้าใหม่ ${r.imported} รายการ`;
    loadMonth();
  } catch (err) { $('#gmail-status').textContent = err.message; }
});

$('#reload-meta').addEventListener('click', () => loadMeta().then(() => toast('โหลดแล้ว')).catch(err => toast(err.message)));

// ---------------------------------------------------------------- boot

$('#month').addEventListener('change', e => {
  state.month = e.target.value;
  state.monthPicked = true;
  syncPeriodUi();
  loadMonth();
});

$('#cycle-save').addEventListener('click', async () => {
  $('#cycle-status').textContent = 'กำลังบันทึก …';
  try {
    await api('setCycleStartDay', { day: Number($('#cycle-day').value) });
    state.monthPicked = false;
    await loadMeta();
    $('#cycle-status').textContent = 'บันทึกแล้ว ✓ รอบปัจจุบัน: ' + periodText(state.month);
    loadMonth();
    loadFunds();
  } catch (err) { $('#cycle-status').textContent = err.message; }
});

// ---------------------------------------------------------------- วางแผน (งบ + รายจ่ายล่วงหน้า)

const REPEAT_LABEL = { once: 'ครั้งเดียว', monthly: 'ทุกเดือน', yearly: 'ทุกปี' };
const repeatText = b => (b.repeat === 'months' ? `ทุก ${b.everyMonths} เดือน` : REPEAT_LABEL[b.repeat] || '');
const termText = b => Number(b.termMonths) > 0
  ? ` · <span class="term-left">เหลือ ${Math.max(0, Number(b.remainingMonths) || 0)} เดือน จาก ${Number(b.termMonths)} เดือน</span>`
  : '';
const monthName = ym => THAI_MONTHS[Number(ym.slice(5, 7)) - 1] + ' ' + String(Number(ym.slice(0, 4)) + 543).slice(-2);
function duePill(days) {
  if (days < 0) return `<span class="pill-s red">เลยกำหนด ${-days} วัน</span>`;
  if (days === 0) return '<span class="pill-s red">วันนี้</span>';
  return `<span class="pill-s ${days <= 7 ? 'red' : days <= 14 ? 'amber' : ''}">อีก ${days} วัน</span>`;
}
function groupBy(list, keyFn) {
  const out = [];
  list.forEach(x => {
    const k = keyFn(x);
    let g = out.find(o => o.key === k);
    if (!g) out.push(g = { key: k, items: [] });
    g.items.push(x);
  });
  return out;
}

/** กล่อง "รายจ่ายที่ต้องจ่าย" บน Dashboard: จัดกลุ่มตามเดือนที่ต้องจ่าย */
function renderUpcomingBox(plan) {
  const box = $('#dash-upcoming');
  const up = plan ? plan.upcoming : [];
  const thisMonth = today().slice(0, 7);
  $('#up-sub').textContent = up.length ? `4 เดือนข้างหน้า · รวม ${money(up.reduce((a, u) => a + u.amount, 0))}` : '';
  if (!up.length) {
    box.innerHTML = '<p class="empty">ยังไม่มีรายจ่ายล่วงหน้า — เพิ่มได้ที่เมนูวางแผน เช่น ค่าประกัน ผ่อนบ้าน ค่าเทอม</p>';
    return;
  }
  box.innerHTML = groupBy(up, u => u.date.slice(0, 7)).map(g => {
    // เดือนที่มีรายการครบกำหนดภายใน 31 วัน: แสดงเต็มพร้อมนับถอยหลัง
    // เดือนถัด ๆ ไป: รายการประจำทุกเดือนรวมเป็นบรรทัดเดียว กล่องจะได้ไม่ยาว
    const isNow = g.key <= thisMonth || g.items.some(u => u.daysLeft <= 31);
    const monthly = isNow ? [] : g.items.filter(u => u.repeat === 'monthly');
    const shown = isNow ? g.items : g.items.filter(u => u.repeat !== 'monthly');
    return `<div class="mgroup"><span>${monthName(g.key)}${g.key === thisMonth ? '<span class="pill-s red now">เดือนนี้</span>' : ''}</span>
        <span>${money(g.items.reduce((a, u) => a + u.amount, 0))}</span></div>` +
      shown.map(u => `<div class="brow">
        <span class="cico">${catIcon(u.category || u.name)}</span>
        <span class="bname">${esc(u.name)}</span>
        <span class="bamt">${money(u.amount)}</span>
        <span class="bsub">${esc(shortTh(u.date))} · ${esc(repeatText(u))}${termText(u)}${u.member ? ' · ' + esc(u.member) : ''}${u.fund ? ' · จาก' + esc(u.fund) : ''}</span>
        <span class="bright">${isNow && u.daysLeft <= 31 ? duePill(u.daysLeft) : ''}</span>
      </div>`).join('') +
      (monthly.length ? `<div class="brow"><span class="cico">🔁</span>
        <span class="bname">${esc(monthly.map(u => u.name).join(' · '))}</span>
        <span class="bamt">${money(monthly.reduce((a, u) => a + u.amount, 0))}</span>
        <span class="bsub">รายการประจำเดือน ${monthly.length} รายการ</span><span></span></div>` : '');
  }).join('');
}

/** กล่อง "งบรอบนี้" บน Dashboard: แสดงเฉพาะหมวดที่ต้องระวัง */
function renderBudgetBox(plan) {
  const box = $('#dash-budget');
  if (!plan || !plan.budgetTotal) {
    $('#bud-sub').textContent = '';
    box.innerHTML = '<p class="empty">ยังไม่ได้ตั้งงบ — ตั้งงบต่อหมวดได้ที่เมนูวางแผน</p>';
    return;
  }
  const p = plan.budgetSpent / plan.budgetTotal;
  const st = p > 1 ? 'over' : p >= 0.8 ? 'warn' : 'ok';
  $('#bud-sub').textContent = `ใช้ ${money(plan.budgetSpent)} จาก ${money(plan.budgetTotal)} · ${Math.round(p * 100)}%`;
  box.innerHTML = `<span class="hbar-track ${st}" style="height:10px;display:block;margin:4px 0 12px"><i style="width:${Math.min(100, p * 100)}%"></i></span>` +
    (plan.watch.length ? '<div class="hint" style="margin:0 0 4px">ต้องระวัง</div>' + plan.watch.map(b => `
      <div style="padding:6px 0">
        <div class="row-between"><span>${catIcon(b.category)} ${esc(b.category)}</span>
          <span class="bst ${b.status}">${b.status === 'over' ? '! เกิน ' + money(b.spent - b.budget) : '⚠ ' + Math.round(b.pct * 100) + '%'}</span></div>
        <span class="hbar-track ${b.status}" style="display:block;margin-top:4px"><i style="width:${Math.min(100, b.pct * 100)}%"></i></span>
      </div>`).join('') : '<p class="hint">✓ ทุกหมวดอยู่ในงบ</p>') +
    (plan.okCount && plan.watch.length ? `<p class="hint">อีก ${plan.okCount} หมวดอยู่ในงบ</p>` : '');
}

async function loadPlan() {
  if (!state.cfg.url) return;
  try {
    state.plan = await api('plan', { month: state.month });
    renderPlan();
  } catch (err) { toast(err.message); }
}

function renderPlan() {
  const d = state.plan;
  if (!d) return;
  const pace = d.period.days ? d.elapsed / d.period.days : 0;
  const used = d.budgetTotal ? d.budgetSpent / d.budgetTotal : 0;
  $('#pm-total').textContent = d.budgetTotal ? money(d.budgetTotal) : '–';
  $('#pm-period').textContent = `รอบ ${shortTh(d.period.from)} – ${shortTh(d.period.to)} · ผ่านมา ${d.elapsed} จาก ${d.period.days} วัน`;
  $('#pm-spent').textContent = d.budgetTotal ? money(d.budgetSpent) : '–';
  $('#pm-pace').textContent = d.budgetTotal ? `${Math.round(used * 100)}% · ตามเวลาควรอยู่ที่ ${Math.round(pace * 100)}%` : 'ยังไม่ได้ตั้งงบ';
  const due30 = d.upcoming.filter(u => u.daysLeft >= 0 && u.daysLeft <= 30);
  $('#pm-due').textContent = money(due30.reduce((a, u) => a + u.amount, 0));
  $('#pm-due-n').textContent = `${due30.length} รายการ`;

  const daysLeft = Math.max(1, d.period.days - d.elapsed + 1);
  $('#plan-budgets').innerHTML = d.budgets.length ? d.budgets.map(b => `
    <div class="budget-row" data-cat="${esc(b.category)}">
      <div class="crow">
        <span class="cico">${catIcon(b.category)}</span>
        <span class="hbar-name">${esc(b.category)}</span>
        <span class="cval">${money(b.spent)} / ${money(b.budget)}<small class="bst ${b.status}">${b.status === 'ok' ? '✓' : b.status === 'warn' ? '⚠' : '!'} ${Math.round(b.pct * 100)}%</small></span>
        <span class="cbar"><span class="hbar-meta">${b.spent <= b.budget
          ? `เหลือ ${money(b.budget - b.spent)}` + (d.elapsed < d.period.days ? ` · ใช้ได้วันละ ${money((b.budget - b.spent) / daysLeft)}` : '')
          : `เกินงบ ${money(b.spent - b.budget)}`}</span>
          <span class="hbar-track ${b.status}"><i style="width:${Math.min(100, b.pct * 100)}%"></i></span></span>
      </div>
    </div>`).join('') : '<p class="empty">ยังไม่ได้ตั้งงบ กด "ตั้งงบ" หรือใช้งบแนะนำด้านล่าง</p>';

  const sug = d.budgetSuggestions || [];
  $('#plan-budget-suggest').innerHTML = sug.length ? `<div class="hint" style="margin-top:10px">💡 งบแนะนำจากค่าเฉลี่ยรายจ่าย ${Math.max(...sug.map(s => s.periods))} รอบก่อนหน้า</div>` +
    sug.map(s => `<div class="suggest-row"><span>${catIcon(s.category)} ${esc(s.category)}</span>
      <button class="ghost" data-sugcat="${esc(s.category)}" data-amt="${s.amount}">ตั้งงบ ${money(s.amount)}</button></div>`).join('') : '';

  const active = d.bills.filter(b => b.active && b.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const todayIso = today();
  $('#plan-bills').innerHTML = active.length ? groupBy(active, b => b.dueDate.slice(0, 7)).map(g =>
    `<div class="mgroup"><span>${monthName(g.key)}</span><span>${money(g.items.reduce((a, b) => a + b.amount, 0))}</span></div>` +
    g.items.map(b => `<div class="brow">
      <span class="cico">${catIcon(b.category || b.name)}</span>
      <span class="bname">${esc(b.name)}</span>
      <span class="bamt">${money(b.amount)}</span>
      <span class="bsub">${esc(shortTh(b.dueDate))} · ${esc(repeatText(b))}${termText(b)}${b.member ? ' · ' + esc(b.member) : ''}${b.fund ? ' · จาก' + esc(b.fund) : ''}${b.lastPaid ? ' · จ่ายล่าสุด ' + esc(shortTh(b.lastPaid)) : ''}</span>
      <span class="bright">${duePill(dayIndex(b.dueDate, todayIso))}
        <div class="bactions"><button class="ghost" data-pay="${esc(b.id)}">✅ จ่ายแล้ว</button><button class="ghost" data-editbill="${esc(b.id)}">แก้ไข</button></div></span>
    </div>`).join('')).join('') : '<p class="empty">ยังไม่มีรายจ่ายล่วงหน้า กด "เพิ่ม" เช่น ต่อประกันรถ ค่าเทอม ประกันสุขภาพ</p>';

  const bs = d.billSuggestions || [];
  $('#plan-bill-suggest-card').hidden = !bs.length;
  $('#plan-bill-suggest').innerHTML = bs.map((s, i) => `<div class="suggest-row">
    <span>${catIcon(s.category)} ${esc(s.name)} · ${money(s.amount)} <span class="hint">(ล่าสุด ${esc(shortTh(s.lastDate))})</span></span>
    <button class="ghost" data-sugbill="${i}">＋ เพิ่ม</button></div>`).join('');
}

// ---- งบ: เปิด/บันทึก
function openBudget(category, amount) {
  const f = $('#budget-form');
  const cats = state.meta.categories.filter(c => c.type === 'expense').map(c => c.name);
  f.category.innerHTML = cats.map(n => `<option ${n === category ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const cur = state.plan && state.plan.budgets.find(b => b.category === category);
  f.amount.value = amount || (cur ? cur.budget : '');
  const s = state.plan && state.plan.budgetSuggestions.find(x => x.category === (category || f.category.value));
  $('#budget-hint').textContent = s ? `ค่าเฉลี่ยรอบก่อน ๆ ประมาณ ${money(s.amount)}` : '';
  $('#budget-delete').hidden = !cur;
  $('#budget-dialog').showModal();
}
$('#budget-add').addEventListener('click', () => openBudget());
$('#plan-budgets').addEventListener('click', e => {
  const r = e.target.closest('[data-cat]');
  if (r) openBudget(r.dataset.cat);
});
$('#plan-budget-suggest').addEventListener('click', async e => {
  const b = e.target.closest('[data-sugcat]');
  if (!b) return;
  b.disabled = true;
  try {
    await api('saveBudget', { category: b.dataset.sugcat, amount: Number(b.dataset.amt) });
    toast('ตั้งงบแล้ว');
    loadPlan();
  } catch (err) { toast(err.message); b.disabled = false; }
});
$('#budget-dialog').addEventListener('close', async () => {
  if ($('#budget-dialog').returnValue !== 'save') return;
  const f = $('#budget-form');
  try {
    await api('saveBudget', { category: f.category.value, amount: Number(f.amount.value) });
    toast('บันทึกงบแล้ว');
    loadPlan();
  } catch (err) { toast(err.message); }
});
$('#budget-delete').addEventListener('click', async () => {
  const f = $('#budget-form');
  $('#budget-dialog').close();
  try {
    await api('saveBudget', { category: f.category.value, amount: 0 });
    toast('ยกเลิกงบแล้ว');
    loadPlan();
  } catch (err) { toast(err.message); }
});

// ---- รายจ่ายล่วงหน้า: เปิด/บันทึก/จ่ายแล้ว
let billEditing = null;
function openBill(b) {
  billEditing = b && b.id ? b : null;
  const f = $('#bill-form');
  f.reset();
  $('#bill-title').textContent = billEditing ? 'แก้ไขรายจ่ายล่วงหน้า' : 'เพิ่มรายจ่ายล่วงหน้า';
  f.category.innerHTML = '<option value="">-</option>' + categoryOptions('expense', b && b.category);
  f.member.innerHTML = '<option value="">ทั้งบ้าน</option>' + memberOptions(b && b.member);
  f.fund.innerHTML = '<option value="">-</option>' + (state.meta.funds || []).map(x => `<option ${b && b.fund === x.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  if (b) ['name', 'amount', 'dueDate', 'repeat', 'everyMonths', 'termMonths', 'keyword', 'note'].forEach(k => { if (b[k] !== undefined && b[k] !== '' && b[k] !== 0) f[k].value = b[k]; });
  if (b && !b.category) f.category.value = '';
  if (b && !b.member) f.member.value = '';
  syncBillFields();
  $('#bill-term-status').textContent = b && b.termMonths
    ? `ชำระไปแล้ว ${Math.max(0, b.termMonths - b.remainingMonths)} เดือน · เหลือ ${b.remainingMonths} เดือน`
    : 'เว้นว่างหากจ่ายต่อเนื่องไม่มีกำหนด';
  $('#bill-delete').hidden = !billEditing;
  $('#bill-dialog').showModal();
}
function syncBillFields() {
  const repeat = $('#bill-form').repeat.value;
  $('#bill-every').hidden = repeat !== 'months';
  $('#bill-term').hidden = repeat === 'once';
}
$('#bill-form').repeat.addEventListener('change', syncBillFields);
$('#bill-add').addEventListener('click', () => openBill(null));
$('#plan-bills').addEventListener('click', async e => {
  const pay = e.target.closest('[data-pay]');
  const edit = e.target.closest('[data-editbill]');
  if (edit) return openBill(state.plan.bills.find(b => b.id === edit.dataset.editbill));
  if (!pay) return;
  const b = state.plan.bills.find(x => x.id === pay.dataset.pay);
  if (!confirm(`ทำเครื่องหมาย "${b.name}" ว่าจ่ายแล้ว?` + (b.repeat === 'once' ? '' : ` ระบบจะเลื่อนไปรอบถัดไป`))) return;
  try {
    const result = await api('payBill', { id: b.id });
    toast(result.completed ? 'บันทึกแล้ว · ชำระครบกำหนด' : result.remainingMonths > 0
      ? `บันทึกแล้ว · เหลือ ${result.remainingMonths} เดือน` : 'บันทึกว่าจ่ายแล้ว');
    loadPlan();
  } catch (err) { toast(err.message); }
});
$('#plan-bill-suggest').addEventListener('click', e => {
  const b = e.target.closest('[data-sugbill]');
  if (b) openBill(state.plan.billSuggestions[Number(b.dataset.sugbill)]);
});
$('#bill-dialog').addEventListener('close', async () => {
  if ($('#bill-dialog').returnValue !== 'save') return;
  const bill = Object.fromEntries(new FormData($('#bill-form')));
  bill.amount = Number(bill.amount);
  bill.everyMonths = Number(bill.everyMonths) || 1;
  bill.termMonths = Number(bill.termMonths) || 0;
  if (billEditing) bill.id = billEditing.id;
  try {
    await api('saveBill', { bill });
    toast('บันทึกแล้ว');
    loadPlan();
  } catch (err) { toast(err.message); }
});
$('#bill-delete').addEventListener('click', async () => {
  if (!billEditing || !confirm('ลบ "' + billEditing.name + '"?')) return;
  $('#bill-dialog').close();
  try {
    await api('deleteBill', { id: billEditing.id });
    toast('ลบแล้ว');
    loadPlan();
  } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------------- funds (เงินเก็บ)

const GRAMS_PER_BAHT = 15.244;
const GOLD_UNIT = { gram: 1, salung: GRAMS_PER_BAHT / 4, baht: GRAMS_PER_BAHT };
const fmtGold = g => `${(g / GRAMS_PER_BAHT).toFixed(3)} บาท · ${g.toFixed(3)} ก.`;
const FUND_KIND = {
  gold: { icon: '🪙', label: 'ออมทอง' },
  child: { icon: '👶', label: 'เงินเก็บลูก' },
  emergency: { icon: '🛟', label: 'เงินสำรองฉุกเฉิน' },
  family: { icon: '🏠', label: 'เงินเก็บครอบครัว' },
  other: { icon: '🎯', label: 'เป้าหมายอื่น' },
};

async function loadFunds() {
  if (!state.cfg.url) return;
  try {
    state.funds = await api('funds');
    renderFunds();
  } catch (err) { toast(err.message); }
}

function monthsUntil(iso) {
  const now = new Date();
  const d = new Date(iso + 'T00:00:00');
  return (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth()) + (d.getDate() >= now.getDate() ? 0 : -1);
}

function goalMonthlyNeed(f) {
  const remaining = Math.max(0, Number(f.target) - Number(f.balance));
  if (!remaining || !f.targetDate) return 0;
  const months = monthsUntil(f.targetDate);
  return months < 0 ? 0 : remaining / Math.max(1, months);
}

function renderFunds() {
  const r = state.funds;
  if (!r) return;
  $('#funds-total').textContent = money(r.totalBalance);
  const goalFunds = r.funds.filter(f => f.kind !== 'gold' && f.target > 0);
  const activeGoals = goalFunds.filter(f => f.balance < f.target);
  $('#goals-active').textContent = `${activeGoals.length} เป้าหมาย`;
  $('#goals-monthly').textContent = money(activeGoals.reduce((sum, f) => sum + goalMonthlyNeed(f), 0));
  $$('#goal-filter button').forEach(b => {
    const on = b.dataset.goalFilter === state.goalFilter;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  const sug = r.emergencySuggest || {};
  const visible = r.funds.filter(f => state.goalFilter === 'all' ||
    (state.goalFilter === 'active' && f.target > 0 && f.balance < f.target) ||
    (state.goalFilter === 'completed' && f.target > 0 && f.balance >= f.target));
  $('#funds-list').innerHTML = visible.map(f => {
    if (f.kind === 'gold' && r.gold) return goldCard(f, r.gold);
    const k = FUND_KIND[f.kind] || FUND_KIND.other;
    const pct = f.target > 0 ? Math.max(0, Math.min(100, f.balance / f.target * 100)) : 0;
    const goalStatus = f.target <= 0
      ? '<span class="goal-status neutral">ยังไม่ได้ตั้งเป้า</span>'
      : f.balance >= f.target
        ? '<span class="goal-status done">✓ ถึงเป้าแล้ว</span>'
        : f.targetDate && monthsUntil(f.targetDate) < 0
          ? '<span class="goal-status late">เลยกำหนด</span>'
          : '<span class="goal-status active">กำลังออม</span>';
    const lines = [];
    if (f.target > 0) {
      lines.push(`เป้าหมาย ${money(f.target)} · ${pct.toFixed(0)}%` + (f.balance >= f.target ? ' 🎉 ถึงเป้าแล้ว' : ` · ขาดอีก ${money(f.target - f.balance)}`));
      if (f.targetDate && f.balance < f.target) {
        const m = monthsUntil(f.targetDate);
        lines.push(m > 0
          ? `ภายใน ${esc(thaiDate(f.targetDate))} ต้องออมเดือนละ ${money((f.target - f.balance) / m)}`
          : `เลยกำหนด ${esc(thaiDate(f.targetDate))} แล้ว`);
      }
    }
    if (f.thisMonth) lines.push(`รอบนี้ ${f.thisMonth > 0 ? '+' : ''}${money(f.thisMonth)}`);
    if (f.kind === 'emergency' && sug.monthlyAvg > 0) {
      lines.push(`พอใช้จ่ายได้ประมาณ ${(f.balance / sug.monthlyAvg).toFixed(1)} เดือน`);
    }
    let suggest = '';
    if (f.kind === 'emergency' && sug.target > 0 && Math.abs(sug.target - f.target) >= 1000) {
      suggest = `<div class="suggest">แนะนำให้มีเงินสำรอง ${sug.multiplier} เท่าของรายจ่ายต่อเดือน
        (เฉลี่ย ${money(sug.monthlyAvg)} จาก ${sug.months} เดือนล่าสุด) = <strong>${money(sug.target)}</strong><br>
        <button class="ghost" data-fund-act="use-suggest" data-id="${esc(f.id)}">ตั้งเป็นเป้าหมาย</button></div>`;
    }
    return `<div class="card fund ${esc(f.kind)}">
      <div class="fund-head">
        <span class="fund-icon">${k.icon}</span>
        <div><h2>${esc(f.name)}</h2><span class="kind">${k.label}${f.owner ? ' · ' + esc(f.owner) : ''}${f.account ? ' · ' + esc(f.account) : ''}</span></div>
        ${goalStatus}
      </div>
      <div class="fund-balance">${money(f.balance)} ${f.target > 0 ? `<small>/ ${money(f.target)}</small>` : ''}</div>
      ${f.target > 0 ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      <div class="fund-lines">${lines.map(l => `<div>${l}</div>`).join('')}</div>
      ${suggest}
      <div class="fund-actions">
        <button class="primary" data-fund-act="deposit" data-id="${esc(f.id)}">ฝากเข้าเป้าหมาย</button>
        <button class="ghost" data-fund-act="withdraw" data-id="${esc(f.id)}">ถอน</button>
        <button class="ghost" data-fund-act="history" data-id="${esc(f.id)}">ประวัติ</button>
        <button class="ghost" data-fund-act="edit" data-id="${esc(f.id)}">แก้ไข</button>
      </div>
    </div>`;
  }).join('') || `<div class="card goal-empty"><span>🌱</span><h2>ยังไม่มีเป้าหมายในกลุ่มนี้</h2><p>สร้างเป้าหมายใหม่หรือเลือกดูทั้งหมด</p></div>`;
}

$('#goal-filter').addEventListener('click', e => {
  const b = e.target.closest('[data-goal-filter]');
  if (!b || b.dataset.goalFilter === state.goalFilter) return;
  state.goalFilter = b.dataset.goalFilter;
  try { localStorage.setItem('mm_goal_filter', state.goalFilter); } catch { /* private mode */ }
  renderFunds();
});

function goldCard(f, g) {
  const pr = g.price;
  const pl = g.profit;
  return `<div class="card fund gold">
    <div class="fund-head">
      <span class="fund-icon">🪙</span>
      <div><h2>${esc(f.name)}</h2><span class="kind">ออมทอง${f.owner ? ' · ' + esc(f.owner) : ''}</span></div>
    </div>
    <div class="fund-balance">${(g.grams / GRAMS_PER_BAHT).toFixed(3)} <small>บาททอง · ${g.grams.toFixed(3)} กรัม</small></div>
    <div class="gold-stats">
      <div><span>ต้นทุนรวม</span><b>${money(g.cost)}</b></div>
      <div><span>มูลค่าถ้าขายวันนี้</span><b>${g.value !== null ? money(g.value) : '–'}</b></div>
      <div><span>กำไร/ขาดทุน</span><b class="${pl === null ? '' : pl >= 0 ? 'up' : 'down'}">${pl === null ? '–' : (pl >= 0 ? '▲ ' : '▼ ') + money(Math.abs(pl)) + (g.cost ? ` (${(pl / g.cost * 100).toFixed(1)}%)` : '')}</b></div>
      <div><span>ต้นทุนเฉลี่ย / บาททอง</span><b>${g.avgCostPerBaht ? money(g.avgCostPerBaht) : '–'}</b></div>
    </div>
    ${g.missingWeight ? `<div class="suggest">มี ${g.missingWeight} รายการที่ยังไม่มีน้ำหนักทอง — กด "ประวัติ" แล้วแก้ไขใส่น้ำหนัก เพื่อให้คำนวณมูลค่าถูกต้อง</div>` : ''}
    <div class="gold-price">${pr
      ? `ราคาทองแท่ง รับซื้อ ${money(pr.barBuy)} · ขายออก ${money(pr.barSell)} / บาท — ${esc(pr.updated)}${pr.stale ? ' (ราคาล่าสุดที่เก็บไว้)' : ''} · ${esc(pr.source)}`
      : 'ยังไม่มีราคาทอง'} · <button type="button" data-fund-act="gold-price" data-id="${esc(f.id)}">ตั้งราคาเอง</button></div>
    <div class="fund-actions">
      <button class="primary" data-fund-act="gold-buy" data-id="${esc(f.id)}">ซื้อทอง</button>
      <button class="ghost" data-fund-act="gold-sell" data-id="${esc(f.id)}">ขายทอง</button>
      <button class="ghost" data-fund-act="history" data-id="${esc(f.id)}">ประวัติ</button>
      <button class="ghost" data-fund-act="edit" data-id="${esc(f.id)}">แก้ไข</button>
    </div>
  </div>`;
}

let goldAction = 'buy';
function openGold(action) {
  goldAction = action;
  const form = $('#gold-form');
  form.reset();
  form.date.value = today();
  form.account.innerHTML = accountOptions();
  $('#gold-title').textContent = action === 'buy' ? 'ซื้อทอง' : 'ขายทอง';
  $('#gold-amount-label').firstChild.textContent = action === 'buy' ? 'จำนวนเงินที่จ่าย' : 'จำนวนเงินที่ได้รับ';
  const g = state.funds.gold;
  const pr = g && g.price;
  $('#gold-hint').textContent = action === 'sell' && g ? `มีอยู่ ${fmtGold(g.grams)}`
    : pr ? `ราคาขายออกวันนี้ ${money(pr.barSell)} / บาททอง` : '';
  $('#gold-dialog').showModal();
}
/** ช่วยกรอก: พิมพ์น้ำหนักแล้วเติมจำนวนเงินจากราคาวันนี้ให้ (แก้ได้) */
['weight', 'unit'].forEach(n => $('#gold-form')[n].addEventListener('input', () => {
  const form = $('#gold-form');
  const pr = state.funds && state.funds.gold && state.funds.gold.price;
  const grams = Number(form.weight.value) * GOLD_UNIT[form.unit.value];
  if (pr && grams && !form.amount.dataset.touched) {
    form.amount.value = (grams / GRAMS_PER_BAHT * (goldAction === 'buy' ? pr.barSell : pr.barBuy)).toFixed(2);
  }
}));
$('#gold-form').amount.addEventListener('input', e => { e.target.dataset.touched = '1'; });
$('#gold-dialog').addEventListener('close', async () => {
  const form = $('#gold-form');
  delete form.amount.dataset.touched;
  if ($('#gold-dialog').returnValue !== 'save') return;
  try {
    await api('goldMove', {
      action: goldAction, grams: Number(form.weight.value) * GOLD_UNIT[form.unit.value], amount: Number(form.amount.value),
      date: form.date.value, vendor: form.vendor.value, account: form.account.value, note: form.note.value, member: state.cfg.member,
    });
    toast(goldAction === 'buy' ? 'บันทึกการซื้อทองแล้ว 🪙' : 'บันทึกการขายทองแล้ว');
    loadFunds();
    loadMonth();
  } catch (err) { toast(err.message); }
});
$('#gold-price-dialog').addEventListener('close', async () => {
  if ($('#gold-price-dialog').returnValue !== 'save') return;
  const form = $('#gold-price-form');
  try {
    await api('setGoldPrice', { barBuy: Number(form.barBuy.value), barSell: Number(form.barSell.value) });
    toast('ตั้งราคาทองแล้ว');
    loadFunds();
  } catch (err) { toast(err.message); }
});

let fundMoving = null;
let fundEditing = null;

$('#funds-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-fund-act]');
  if (!b) return;
  const f = state.funds.funds.find(x => x.id === b.dataset.id);
  const act = b.dataset.fundAct;
  if (act === 'gold-buy' || act === 'gold-sell') return openGold(act === 'gold-buy' ? 'buy' : 'sell');
  if (act === 'gold-price') {
    const pr = state.funds.gold && state.funds.gold.price;
    const form = $('#gold-price-form');
    form.barBuy.value = pr ? pr.barBuy : '';
    form.barSell.value = pr ? pr.barSell : '';
    return $('#gold-price-dialog').showModal();
  }
  if (act === 'deposit' || act === 'withdraw') {
    fundMoving = { fund: f, action: act };
    const form = $('#fund-move-form');
    form.reset();
    form.date.value = today();
    form.account.innerHTML = accountOptions(f.account);
    $('#fund-move-title').textContent = (act === 'deposit' ? 'ฝากเข้า ' : 'ถอนจาก ') + f.name;
    $('#fund-move-balance').textContent = 'คงเหลือ ' + money(f.balance);
    $('#fund-move-dialog').showModal();
  } else if (act === 'edit') {
    openFundEdit(f);
  } else if (act === 'history') {
    $('#fund-history-title').textContent = 'ประวัติ ' + f.name;
    $('#fund-history-list').innerHTML = '<li class="empty">กำลังโหลด …</li>';
    $('#fund-history-dialog').showModal();
    try {
      const list = await api('fundHistory', { fund: f.name });
      $('#fund-history-list').innerHTML = list.map(t => `<li class="tx">
        <span class="title">${esc(t.note || t.counterparty || t.category)}</span>
        <span class="amt ${t.fundAction === 'deposit' ? 'income' : 'expense'}">${t.fundAction === 'deposit' ? '+' : '−'}${money(t.amount)}</span>
        <span class="sub">${esc(thaiDate(t.date))}${t.member ? ' · ' + esc(t.member) : ''} · ${esc(SOURCE_LABEL[t.source] || t.source)}${Number(t.goldGrams) > 0 ? ' · ' + Number(t.goldGrams).toFixed(3) + ' ก.' : ''}</span>
        <span class="sub"></span></li>`).join('') || '<li class="empty">ยังไม่มีรายการ</li>';
    } catch (err) { $('#fund-history-list').innerHTML = `<li class="empty">${esc(err.message)}</li>`; }
  } else if (act === 'use-suggest') {
    try {
      await api('saveFund', { fund: { ...f, target: state.funds.emergencySuggest.target } });
      toast('ตั้งเป้าหมายแล้ว');
      loadFunds();
    } catch (err) { toast(err.message); }
  }
});

$('#fund-move-dialog').addEventListener('close', async () => {
  if ($('#fund-move-dialog').returnValue !== 'save' || !fundMoving) return;
  const form = $('#fund-move-form');
  try {
    await api('fundMove', {
      fund: fundMoving.fund.name, action: fundMoving.action, amount: Number(form.amount.value),
      date: form.date.value, account: form.account.value, note: form.note.value, member: state.cfg.member,
    });
    toast(fundMoving.action === 'deposit' ? 'ฝากแล้ว 🐷' : 'ถอนแล้ว');
    loadFunds();
    loadMonth();
  } catch (err) { toast(err.message); }
});

function openFundEdit(f) {
  fundEditing = f || null;
  const form = $('#fund-edit-form');
  form.reset();
  $('#fund-edit-title').textContent = f ? 'แก้ไขเป้าหมายเงินเก็บ' : 'สร้างเป้าหมายเงินเก็บ';
  $('#fund-delete').hidden = !f;
  form.account.innerHTML = accountOptions(f && f.account);
  if (f) ['name', 'kind', 'owner', 'targetDate', 'note'].forEach(k => { form[k].value = f[k] || ''; });
  form.target.value = f && f.target ? f.target : '';
  $('#fund-edit-dialog').showModal();
}
$('#fund-new').addEventListener('click', () => openFundEdit(null));

$('#fund-edit-dialog').addEventListener('close', async () => {
  if ($('#fund-edit-dialog').returnValue !== 'save') return;
  const form = $('#fund-edit-form');
  const fund = Object.fromEntries(new FormData(form));
  fund.target = Number(fund.target) || 0;
  if (fundEditing) fund.id = fundEditing.id;
  try {
    await api('saveFund', { fund });
    toast('บันทึกแล้ว');
    await loadMeta();
    loadFunds();
  } catch (err) { toast(err.message); }
});

$('#fund-delete').addEventListener('click', async () => {
  if (!fundEditing || !confirm('ลบ "' + fundEditing.name + '"?')) return;
  $('#fund-edit-dialog').close();
  try {
    await api('deleteFund', { id: fundEditing.id });
    toast('ลบแล้ว');
    await loadMeta();
    loadFunds();
  } catch (err) { toast(err.message); }
});

(async function boot() {
  // ลิงก์เชิญจากคนในบ้าน: ?b=<deployment id> → จำ URL backend ไว้ แล้วลบออกจากแถบที่อยู่
  // (โค้ดบน GitHub Pages เป็น public จึงไม่ฝัง URL backend ไว้ในไฟล์)
  const invite = new URLSearchParams(location.search).get('b');
  if (invite && /^AKfyc[\w-]{20,}$/.test(invite)) {
    state.cfg.url = `https://script.google.com/macros/s/${invite}/exec`;
    saveCfg(state.cfg);
    settings.url.value = state.cfg.url;
    const clean = new URL(location.href);
    clean.searchParams.delete('b');
    history.replaceState(null, '', clean.toString());
  }
  if (window.MM_EMBED && window.MM_EMBED.url && !state.cfg.url) {
    // เปิดจาก Apps Script (/exec?page=app): ใส่ URL backend ให้เลย เหลือแค่รหัสครอบครัว
    state.cfg.url = window.MM_EMBED.url;
    settings.url.value = state.cfg.url;
  }
  if (!state.cfg.url || !state.cfg.passcode) { go('settings'); return; }
  try {
    await loadMeta();
    await loadMonth();
  } catch (err) {
    toast(err.message);
    go('settings');
  }
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.MM_EMBED) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------------------------------------------------------------- demo mode (URL = "demo")

function demoApi(action, p) {
  const db = demoApi.db || (demoApi.db = seedDemo());
  demoApi.funds = demoApi.funds || demoFunds();
  const meta = {
    categories: [
      ...['อาหาร/เครื่องดื่ม', 'เดินทาง/น้ำมัน', 'ช้อปปิ้ง', 'บิล/สาธารณูปโภค', 'สุขภาพ', 'อื่นๆ'].map(name => ({ type: 'expense', name })),
      ...['เงินเดือน', 'รับโอน', 'อื่นๆ'].map(name => ({ type: 'income', name })),
      { type: 'transfer', name: 'โอนระหว่างบัญชีตัวเอง' },
    ],
    members: [{ name: 'พ่อ', bankNames: '' }, { name: 'แม่', bankNames: '' }],
    accounts: [{ name: 'กสิกร ออมทรัพย์', bank: 'KBANK', last4: '1234', member: 'พ่อ' }],
    funds: demoApi.funds.map(f => ({ name: f.name, kind: f.kind, owner: f.owner, account: f.account })),
    cycleStartDay: demoApi.cycle || 28,
  };
  const inP = (t, key) => { const r = periodRange(key); return t.date >= r.from && t.date <= r.to; };
  const bal = name => db.filter(t => t.fund === name).reduce((a, t) => a + (t.fundAction === 'deposit' ? t.amount : -t.amount), 0);
  switch (action) {
    case 'meta': return meta;
    case 'setCycleStartDay': demoApi.cycle = p.day; state.meta.cycleStartDay = p.day; return { cycleStartDay: p.day };
    case 'list': return db.filter(t => inP(t, p.month)).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    case 'add': p.txs.forEach(t => db.push({ ...t, id: Math.random().toString(36).slice(2), source: t.source || 'manual' })); return { added: p.txs.length, skipped: 0 };
    case 'update': Object.assign(db.find(t => t.id === p.id), p.fields); return {};
    case 'remove': db.splice(db.findIndex(t => t.id === p.id), 1); return {};
    case 'parseSlip': return { isTransaction: true, transactions: [{ date: today(), time: '12:30', type: 'expense', amount: 120, category: 'อาหาร/เครื่องดื่ม', account: 'กสิกร ออมทรัพย์', counterparty: 'ร้านตัวอย่าง', member: p.member, ref: 'DEMO' + Date.now(), note: '', source: 'slip', qr: p.qr, dupOf: '' }] };
    case 'parseStatement': return { transactions: [] };
    case 'syncGmail': return { checked: 0, imported: 0 };
    case 'funds': {
      const month = currentPeriod();
      const funds = demoApi.funds.map(f => ({ ...f, balance: bal(f.name),
        thisMonth: db.filter(t => t.fund === f.name && inP(t, month)).reduce((a, t) => a + (t.fundAction === 'deposit' ? t.amount : -t.amount), 0) }));
      const gtx = db.filter(t => t.fund === 'ออมทอง');
      const grams = gtx.reduce((a, t) => a + (t.fundAction === 'deposit' ? 1 : -1) * (Number(t.goldGrams) || 0), 0);
      const cost = bal('ออมทอง');
      const bought = gtx.filter(t => t.fundAction === 'deposit');
      const bg = bought.reduce((a, t) => a + (Number(t.goldGrams) || 0), 0);
      const price = demoApi.goldPrice || { barBuy: 65950, barSell: 66150, updated: '28/09/2569 16:52', source: 'ตัวอย่าง' };
      const value = grams / GRAMS_PER_BAHT * price.barBuy;
      const gold = { fund: 'ออมทอง', grams, cost, value, profit: value - cost, price, missingWeight: bought.filter(t => !(t.goldGrams > 0)).length,
        avgCostPerBaht: bg ? bought.reduce((a, t) => a + t.amount, 0) / (bg / GRAMS_PER_BAHT) : 0 };
      return { funds, gold, totalBalance: funds.reduce((a, f) => a + f.balance, 0), emergencySuggest: { monthlyAvg: 18500, months: 3, target: 111000, multiplier: 6 } };
    }
    case 'goldMove': {
      const act = p.action === 'sell' ? 'withdraw' : 'deposit';
      db.push({ id: Math.random().toString(36).slice(2), date: p.date, time: '', type: 'transfer', amount: p.amount, category: act === 'deposit' ? 'ออมทอง' : 'ขายทอง',
        counterparty: p.vendor || 'ร้านทอง', member: p.member, source: 'manual', account: p.account, note: p.note, fund: 'ออมทอง', fundAction: act, goldGrams: p.grams });
      return { added: 1 };
    }
    case 'setGoldPrice': demoApi.goldPrice = { barBuy: p.barBuy, barSell: p.barSell || p.barBuy, updated: 'กรอกเอง', source: 'กรอกเอง' }; return demoApi.goldPrice;
    case 'gold': return demoApi('funds').gold;
    case 'saveFund': {
      const f = demoApi.funds.find(x => x.id === p.fund.id);
      if (f) Object.assign(f, p.fund); else demoApi.funds.push({ ...p.fund, id: Math.random().toString(36).slice(2) });
      return {};
    }
    case 'deleteFund': demoApi.funds = demoApi.funds.filter(f => f.id !== p.id); return {};
    case 'fundMove':
      if (p.action === 'withdraw' && p.amount > bal(p.fund)) throw new Error('ยอดในเงินเก็บมีไม่พอ');
      db.push({ id: Math.random().toString(36).slice(2), date: p.date, time: '', type: 'transfer', amount: p.amount,
        category: p.action === 'deposit' ? 'ออมเงิน' : 'ถอนเงินออม', counterparty: p.fund, member: p.member, source: 'manual',
        account: p.account, note: p.note, fund: p.fund, fundAction: p.action });
      return { added: 1 };
    case 'dashboard': {
      const D = p.member ? db.filter(t => t.member === p.member) : db;
      const [y, mo] = p.month.split('-').map(Number);
      const key = b => isoUTC(y, mo - 1 - b, 1).slice(0, 7);
      const s = (l, ty) => l.filter(t => t.type === ty).reduce((a, t) => a + t.amount, 0);
      const fd = t => (t.fundAction === 'deposit' ? t.amount : t.fundAction === 'withdraw' ? -t.amount : 0);
      const months = [5, 4, 3, 2, 1, 0].map(b => { const l = D.filter(t => inP(t, key(b))); return { month: key(b), income: s(l, 'income'), expense: s(l, 'expense'), saving: l.reduce((a, t) => a + fd(t), 0) }; });
      const pr = periodRange(key(1));
      const prev = D.filter(t => inP(t, key(1)) && t.type === 'expense');
      const prevByCat = {};
      prev.forEach(t => { prevByCat[t.category] = (prevByCat[t.category] || 0) + t.amount; });
      const prevDaily = Array(pr.days).fill(0);
      prev.forEach(t => { prevDaily[dayIndex(t.date, pr.from)] += t.amount; });
      for (let i = 1; i < prevDaily.length; i++) prevDaily[i] += prevDaily[i - 1];
      const pl = demoPlan('plan', { month: p.month }, db);
      return { months, prevByCat, prevDaily, expensePeriods: demoExpensePeriods(D), funds: demoApi('funds'), plan: {
        budgetTotal: pl.budgetTotal, budgetSpent: pl.budgetSpent, period: pl.period, elapsed: pl.elapsed,
        watch: pl.budgets.filter(b => b.status !== 'ok'), okCount: pl.budgets.filter(b => b.status === 'ok').length, upcoming: pl.upcoming } };
    }
    case 'plan': case 'saveBudget': case 'saveBill': case 'deleteBill': case 'payBill':
      return demoPlan(action, p, db);
    case 'attachEvidence': {
      const r = { slipId: 'demo-file', slipUrl: 'https://drive.google.com/' };
      if (p.id) Object.assign(db.find(t => t.id === p.id), r);
      return r;
    }
    case 'fundHistory': return db.filter(t => t.fund === p.fund).sort((a, b) => b.date.localeCompare(a.date));
  }
}

/** สรุปรายจ่าย demo ตามวัน/สัปดาห์/เดือน/ปี พร้อมช่วงเปรียบเทียบ */
function demoExpensePeriods(db) {
  const at = value => new Date(value + 'T00:00:00Z');
  const shift = (d, days) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
  const lastDay = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  const now = at(today());
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), day = now.getUTCDate();
  const weekOffset = (now.getUTCDay() + 6) % 7;
  const ranges = {
    day: [now, now, shift(now, -1), shift(now, -1)],
    week: [shift(now, -weekOffset), now, shift(now, -weekOffset - 7), shift(now, -7)],
    month: [new Date(Date.UTC(y, m, 1)), now, new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m - 1, Math.min(day, lastDay(y, m - 1))))],
    year: [new Date(Date.UTC(y, 0, 1)), now, new Date(Date.UTC(y - 1, 0, 1)), new Date(Date.UTC(y - 1, m, Math.min(day, lastDay(y - 1, m))))],
  };
  const expenses = db.filter(t => t.type === 'expense');
  const sum = (from, to) => expenses.filter(t => t.date >= from && t.date <= to).reduce((a, t) => a + t.amount, 0);
  return Object.fromEntries(Object.entries(ranges).map(([key, values]) => {
    const r = values.map(d => d.toISOString().slice(0, 10));
    return [key, { value: sum(r[0], r[1]), previous: sum(r[2], r[3]), from: r[0], to: r[1], previousFrom: r[2], previousTo: r[3] }];
  }));
}
/** โหมด demo: งบ + รายจ่ายล่วงหน้า (ตรรกะเดียวกับ Plan.gs แบบย่อ) */
function demoPlan(action, p, db) {
  const S = demoPlan.s || (demoPlan.s = {
    budgets: { 'อาหาร/เครื่องดื่ม': 600, 'ช้อปปิ้ง': 1000, 'เดินทาง/น้ำมัน': 4000, 'บิล/สาธารณูปโภค': 3000 },
    bills: [
      { id: 'b1', name: 'ต่อประกันรถ', category: 'ประกัน', amount: 18900, dueDate: isoUTC(+today().slice(0, 4), +today().slice(5, 7) - 1, +today().slice(8, 10) + 7), repeat: 'yearly', everyMonths: 1, termMonths: 0, remainingMonths: 0, member: 'พ่อ', fund: '', keyword: '', lastPaid: '', note: '', active: true },
      { id: 'b2', name: 'ประกันสุขภาพ', category: 'ประกัน', amount: 2374, dueDate: isoUTC(+today().slice(0, 4), +today().slice(5, 7) - 1, +today().slice(8, 10) + 12), repeat: 'monthly', everyMonths: 1, termMonths: 0, remainingMonths: 0, member: 'พ่อ', fund: '', keyword: 'เจนเนอราลี่', lastPaid: '', note: '', active: true },
      { id: 'b3', name: 'ผ่อนบ้าน ธอส.', category: 'ที่พัก/ค่าเช่า', amount: 34900, dueDate: isoUTC(+today().slice(0, 4), +today().slice(5, 7) - 1, +today().slice(8, 10) + 27), repeat: 'monthly', everyMonths: 1, termMonths: 60, remainingMonths: 60, member: 'พ่อ', fund: '', keyword: 'GHBANK', lastPaid: '', note: '', active: true },
      { id: 'b4', name: 'ค่าเทอมน้องมิว', category: 'การศึกษา', amount: 45000, dueDate: isoUTC(+today().slice(0, 4), +today().slice(5, 7) - 1, +today().slice(8, 10) + 48), repeat: 'months', everyMonths: 6, termMonths: 0, remainingMonths: 0, member: 'แม่', fund: 'เงินเก็บน้องมิว', keyword: '', lastPaid: '', note: '', active: true },
    ],
  });
  const step = b => (b.repeat === 'monthly' ? 1 : b.repeat === 'months' ? b.everyMonths : b.repeat === 'yearly' ? 12 : 0);
  const next = (b, d) => { const k = step(b); return k ? isoUTC(+d.slice(0, 4), +d.slice(5, 7) - 1 + k, +d.slice(8, 10)) : ''; };
  if (action === 'saveBudget') { if (p.amount > 0) S.budgets[p.category] = p.amount; else delete S.budgets[p.category]; return {}; }
  if (action === 'saveBill') {
    const i = S.bills.findIndex(x => x.id === p.bill.id);
    const old = i >= 0 ? S.bills[i] : null;
    const termMonths = p.bill.repeat === 'once' ? 0 : Math.max(0, Math.floor(Number(p.bill.termMonths) || 0));
    const paidMonths = old && old.termMonths ? Math.max(0, old.termMonths - old.remainingMonths) : 0;
    const b = { everyMonths: 1, active: true, lastPaid: '', ...p.bill, everyMonths: Math.max(1, Math.floor(Number(p.bill.everyMonths) || 1)),
      termMonths, remainingMonths: termMonths ? Math.max(0, termMonths - paidMonths) : 0, amount: Number(p.bill.amount) };
    if (termMonths && !b.remainingMonths) b.active = false;
    if (i >= 0) S.bills[i] = { ...S.bills[i], ...b }; else S.bills.push({ ...b, id: 'b' + Date.now() });
    return {};
  }
  if (action === 'deleteBill') { S.bills = S.bills.filter(b => b.id !== p.id); return {}; }
  if (action === 'payBill') {
    const b = S.bills.find(x => x.id === p.id); b.lastPaid = today(); const n = next(b, b.dueDate);
    if (b.termMonths) b.remainingMonths = Math.max(0, b.remainingMonths - (step(b) || b.remainingMonths));
    if (n && (!b.termMonths || b.remainingMonths > 0)) b.dueDate = n; else b.active = false;
    return { dueDate: b.dueDate, remainingMonths: b.remainingMonths, completed: !b.active };
  }
  const month = p.month || currentPeriod();
  const r = periodRange(month);
  const t0 = today();
  const spent = {};
  db.filter(t => t.type === 'expense' && t.date >= r.from && t.date <= r.to).forEach(t => { spent[t.category] = (spent[t.category] || 0) + t.amount; });
  const budgets = Object.entries(S.budgets).map(([category, budget]) => {
    const s = spent[category] || 0; const pct = s / budget;
    return { category, budget, spent: s, pct, status: pct > 1 ? 'over' : pct >= 0.8 ? 'warn' : 'ok' };
  }).sort((a, b) => b.pct - a.pct);
  const horizon = isoUTC(+t0.slice(0, 4), +t0.slice(5, 7) + 3, 0);
  const upcoming = [];
  S.bills.filter(b => b.active).forEach(b => {
    let remaining = b.termMonths ? b.remainingMonths : Infinity;
    for (let d = b.dueDate, n = 0; d && d <= horizon && n < 40 && remaining > 0; d = next(b, d), n++) {
      upcoming.push({ ...b, date: d, daysLeft: dayIndex(d, t0) });
      remaining -= step(b) || 1;
    }
  });
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  const elapsed = t0 < r.from ? 0 : t0 > r.to ? r.days : dayIndex(t0, r.from) + 1;
  return { period: r, elapsed, budgets, budgetTotal: budgets.reduce((a, b) => a + b.budget, 0), budgetSpent: budgets.reduce((a, b) => a + b.spent, 0),
    budgetSuggestions: [{ category: 'สุขภาพ', amount: 1000, periods: 3 }].filter(s => !S.budgets[s.category]),
    bills: S.bills, upcoming,
    billSuggestions: [{ name: 'ICBC(Thai) Leasing', category: 'บิล/สาธารณูปโภค', amount: 2531, member: 'พ่อ', lastDate: t0, dueDate: isoUTC(+t0.slice(0, 4), +t0.slice(5, 7), +t0.slice(8, 10)), repeat: 'monthly', keyword: 'ICBC' }]
      .filter(s => !S.bills.some(b => b.keyword === s.keyword)) };
}

function demoFunds() {
  return [
  { id: 'f1', name: 'เงินเก็บน้องมิว', kind: 'child', owner: 'น้องมิว', target: 200000, targetDate: '2030-05-01', account: '', note: '' },
  { id: 'f2', name: 'เงินสำรองฉุกเฉิน', kind: 'emergency', owner: '', target: 60000, targetDate: '', account: '', note: '' },
  { id: 'f3', name: 'เงินเก็บครอบครัว', kind: 'family', owner: '', target: 50000, targetDate: '2026-12-31', account: '', note: 'เที่ยวปีใหม่' },
  { id: 'f4', name: 'ออมทอง', kind: 'gold', owner: '', target: 0, targetDate: '', account: '', note: '' },
  ];
}
function seedDemo() {
  const m = new Date().toISOString().slice(0, 7);
  const rows = [
    ['01', '09:00', 'income', 45000, 'เงินเดือน', 'บริษัท ABC', 'พ่อ', 'email'],
    ['02', '12:15', 'expense', 85, 'อาหาร/เครื่องดื่ม', 'ร้านข้าวมันไก่', 'พ่อ', 'slip'],
    ['03', '18:40', 'expense', 1250, 'ช้อปปิ้ง', 'Big C', 'แม่', 'slip'],
    ['05', '07:30', 'expense', 1500, 'เดินทาง/น้ำมัน', 'ปตท.', 'พ่อ', 'statement'],
    ['07', '10:00', 'expense', 890, 'บิล/สาธารณูปโภค', 'การไฟฟ้านครหลวง', 'แม่', 'email'],
    ['10', '15:20', 'income', 3000, 'รับโอน', 'สมหญิง', 'แม่', 'slip'],
    ['12', '19:05', 'expense', 420, 'อาหาร/เครื่องดื่ม', 'MK', 'แม่', 'slip'],
  ];
  const txs = rows.map(([d, time, type, amount, category, counterparty, member, source], i) => ({
    id: 'demo' + i, date: `${m}-${d}`, time, type, amount, category, counterparty, member, source,
    account: 'กสิกร ออมทรัพย์', note: '', ref: '', qr: '', slipUrl: '', fund: '', fundAction: '',
  }));
  [['2026-01-10', 'เงินเก็บน้องมิว', 45000, 'deposit', 'ยอดยกมา'], [`${m}-01`, 'เงินเก็บน้องมิว', 2000, 'deposit', 'ออมประจำเดือน'],
    ['2026-03-01', 'เงินสำรองฉุกเฉิน', 42000, 'deposit', 'ยอดยกมา'], [`${m}-08`, 'เงินสำรองฉุกเฉิน', 3500, 'withdraw', 'ค่าหมอ'],
    [`${m}-02`, 'เงินเก็บครอบครัว', 5000, 'deposit', ''], ['2026-06-15', 'ออมทอง', 31800, 'deposit', 'ทอง 2 สลึง'], ['2026-09-20', 'ออมทอง', 66457.48, 'deposit', 'ทอง 1 บาท']].forEach(([date, fund, amount, fundAction, note], i) => txs.push({
    id: 'dfund' + i, date, time: '', type: 'transfer', amount, category: fundAction === 'deposit' ? 'ออมเงิน' : 'ถอนเงินออม',
    counterparty: fund === 'ออมทอง' ? 'ออโรร่า เทรดดิ้ง' : fund, member: 'พ่อ', source: 'manual', account: '', note, ref: '', qr: '', slipUrl: '', fund, fundAction,
    goldGrams: fund === 'ออมทอง' ? (amount > 50000 ? 15.244 : 7.622) : 0 }));
  // ประวัติย้อนหลัง 5 เดือน (ค่าคงที่ ไม่สุ่ม เพื่อให้ demo เหมือนเดิมทุกครั้ง)
  const now = new Date();
  const cats = [['อาหาร/เครื่องดื่ม', 6200], ['เดินทาง/น้ำมัน', 3800], ['บิล/สาธารณูปโภค', 2900], ['ช้อปปิ้ง', 4100], ['สุขภาพ', 900], ['อื่นๆ', 1200]];
  for (let b = 1; b <= 5; b++) {
    const d = new Date(now.getFullYear(), now.getMonth() - b, 1);
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const k = 1 + ((b * 7) % 5) / 10;
    const add = (day, type, amount, category, counterparty, extra) => txs.push({
      id: `h${b}-${txs.length}`, date: `${ym}-${String(day).padStart(2, '0')}`, time: '', type, amount: Math.round(amount), category,
      counterparty, member: day % 2 ? 'พ่อ' : 'แม่', source: 'statement', account: '', note: '', ref: '', qr: '', slipUrl: '', fund: '', fundAction: '', ...extra });
    add(1, 'income', 45000, 'เงินเดือน', 'บริษัท ABC');
    if (b % 2) add(15, 'income', 3000 * k, 'รับโอน', 'ลูกค้า');
    cats.forEach(([c, v], i) => { add(3 + i * 4, 'expense', v * k * 0.55, c, c); add(5 + i * 4, 'expense', v * k * 0.45, c, c); });
    add(2, 'transfer', 2000, 'ออมเงิน', 'เงินเก็บน้องมิว', { fund: 'เงินเก็บน้องมิว', fundAction: 'deposit' });
    add(2, 'transfer', 3000 + b * 250, 'ออมเงิน', 'เงินสำรองฉุกเฉิน', { fund: 'เงินสำรองฉุกเฉิน', fundAction: 'deposit' });
  }
  return txs;
}
