/*
 * 避难所 Playtest · 玩家端
 *
 * 个人记录的主要来源：物品（含实例状态）、生命与状态、携带装备、搜刮、身份与分数。
 * 不加入联机房间时与主持人端互不同步：主持人发物资后玩家手动添加；交公、赠予、治疗他人都生成交接文本。
 * 加入了主持人的联机房间（见「联机」一节）后，补给、赠予、交公、治疗直接送到对方页面，公开信息实时显示。
 * 玩家可以编辑自己的全部数据；超容量只警告，不阻断主持人裁定。
 */
(function () {
  'use strict';

  var C = window.ShelterCore;
  var U = window.ShelterUI;
  var h = U.h;

  var KEY_MAIN = 'shelter-playtest:player:v1';
  var KEY_DEMO = 'shelter-playtest:player-demo:v1';
  var KEY_SLOT = 'shelter-playtest:player:slot';
  var KEY_TAB = 'shelter-playtest:player:tab';
  var KEY_SORT = 'shelter-playtest:player:inv-sort';
  var DEFAULT_CARRY_TICKS = 4; // 携带模式默认上限 2 单位（规则里填了就用规则）

  /* primary：手机底栏常驻；其余收进「更多」。电脑端全部显示在侧栏。 */
  var TABS = [
    { id: 'dashboard', name: '总览', primary: true },
    { id: 'status', name: '状态', primary: true },
    { id: 'inventory', name: '库存', full: '库存与携带', primary: true },
    { id: 'scavenge', name: '搜刮', primary: true },
    { id: 'action', name: '行动', full: '行动与身份', primary: true },
    { id: 'net', name: '联机', full: '联机房间' },
    { id: 'score', name: '分数' },
    { id: 'save', name: '存档' }
  ];
  /* 旧版的独立页已经合并：携带 → 库存与携带，身份 → 行动与身份 */
  var TAB_ALIASES = { loadout: 'inventory', identity: 'action' };

  var THIRST = ['不渴', '口渴', '脱水'];
  var HUNGER_ZONES = ['充盈', '普通', '饥饿', '饥荒'];

  var slot = U.readKey(KEY_SLOT) === 'demo' ? 'demo' : 'main';
  var store = null;
  var state = null;
  var notices = [];
  var wiping = false;
  var undo = new U.UndoStack(40);
  var KEY_HIDE_ID = 'shelter-playtest:player:hide-identity';
  var ui = { tab: 'dashboard', filter: 'all', sort: U.readKey(KEY_SORT) === 'default' ? 'default' : 'category', drafts: {}, keep: {}, transfer: {}, moreOpen: false, hideIdentity: U.readKey(KEY_HIDE_ID) === '1' };

  // ================================================================ 演示

  function buildDemoState() {
    var s = C.newPlayerState();
    s.isDemo = true;
    s.name = '演示·小周';
    s.loveName = 'A·老陈';
    s.hateName = 'E·二狗';
    s.publicInfo = { day: 2, seat: '3', notes: '【演示】公共池还剩不少面包；D 想用子弹换水。' };
    var opts = { rules: s.rules };
    C.addItem(s.inventory, 'bread', 1, opts);
    C.addItem(s.inventory, 'water', 1, opts);
    var bars = C.addItem(s.inventory, 'energy_bar', 2, opts);
    bars[0].uses = 1;
    var map = C.addItem(s.inventory, 'map', 1, opts)[0];
    map.notes = [{ text: '北门外有辆翻倒的补给车', day: 1 }, { text: '地铁站B口积水，别走', day: 2 }];
    C.addItem(s.inventory, 'canteen', 1, opts)[0].water = 1;
    C.addItem(s.inventory, 'vest', 1, opts)[0].condition = 'damaged';
    C.addItem(s.inventory, 'rifle', 1, opts);
    C.addItem(s.inventory, 'ammo', 1, opts);
    C.addItem(s.inventory, 'cash', 3, opts);
    C.addItem(s.inventory, 'jewel', 2, opts);
    s.statuses = [{ id: C.uid('st'), statusId: 'bleeding', name: '流血伤口', startDay: 1, nextDay: 3, note: '【演示】第1天在超市割伤' }];
    s.temporaryEffects = [{ id: C.uid('fx'), text: '下一次行动判定视为充盈（功能饮料）', day: 2, attack: null }];
    log(s, '载入演示存档（与正式存档完全分开）');
    return U.localizeDemo(s);
  }

  // ================================================================ 存档与提交

  function loadState() {
    store = new U.Store(slot === 'demo' ? KEY_DEMO : KEY_MAIN);
    notices = [];
    var r = store.read();
    if (r.status === 'ok') {
      var v = C.validateSave(r.data, 'shelter-player');
      if (v.ok) return C.normalizeSave(r.data, 'shelter-player');
      store.backup(r.raw, '读取时校验失败：' + v.errors[0]);
      notices.push({ kind: 'danger', text: '本地存档无法读取（' + v.errors[0] + '）。原数据已另存为备份，当前是空白存档，可在「存档」页查看备份。' });
    } else if (r.status === 'corrupt') {
      store.backup(r.raw, '存档损坏');
      notices.push({ kind: 'danger', text: '本地存档已损坏。原数据已另存为备份，当前是空白存档。' });
    } else if (r.status === 'unavailable' || r.status === 'error') {
      notices.push({ kind: 'danger', text: '浏览器本地保存不可用（可能是隐私模式或存储被禁用）：页面仍在内存中运行，刷新即丢失——请随时在「存档」页导出 JSON。' });
    }
    return slot === 'demo' ? buildDemoState() : C.newPlayerState();
  }

  function save() {
    state.updatedAt = Date.now();
    if (wiping || !store.available) return;
    if (!store.write(state)) {
      var msg = '自动保存失败（' + ((store.lastError && store.lastError.name) || '未知错误') + '），可能是存储空间已满：请立即导出 JSON。';
      if (!notices.some(function (n) { return n.text === msg; })) notices.push({ kind: 'danger', text: msg });
    }
  }

  function commit(label, fn, opts) {
    opts = opts || {};
    var before = C.clone(state);
    try {
      if (fn(state) === false) {
        state = before;
        return false;
      }
    } catch (e) {
      state = before;
      U.toast(e && e.message ? e.message : String(e), 'warn');
      render();
      return false;
    }
    if (opts.undo !== false) {
      undo.push(label, before);
      undo.peek().netSeq = net.seq;
    }
    save();
    render();
    return true;
  }

  /**
   * 撤销：恢复上一步之前的存档。之后从联机来的修改（收到的物品、私信、同步的天数……）不在撤销栈里，
   * 恢复后按顺序重新套用一遍，不会被一起撤掉。
   */
  function undoLast() {
    var item = undo.pop();
    if (!item) return;
    var prev = state;
    var next = item.snapshot;
    var since = item.netSeq == null ? net.seq : item.netSeq;
    net.journal.forEach(function (j) {
      if (j.seq <= since) return;
      var trial = C.clone(next);
      try { if (j.fn(trial) !== false) next = trial; } catch (e) { /* 撤销后不再成立：跳过 */ }
    });
    state = next;
    log(state, '撤销：' + item.label);
    save();
    render();
    U.toast('已撤销：' + item.label, 'ok');
    // 撤销改到了今天的行动：主持人页也跟着改
    var a0 = prev.action;
    var a1 = state.action;
    if ((a0.day === today() && a0.used ? a0.type : null) !== (a1.day === today() && a1.used ? a1.type : null)) netReportAction(a1.day === today() && a1.used ? a1.type || 'other' : null);
  }

  function log(s, text) {
    s.log.unshift({ id: C.uid('log'), at: Date.now(), day: s.publicInfo ? s.publicInfo.day : null, text: text });
    if (s.log.length > 1500) s.log.length = 1500;
  }

  /** 交接文本：都写明「需要对方手动修改」，并存入交接记录。 */
  function handoff(s, kind, text) {
    s.handoffs.unshift({ id: C.uid('ho'), at: Date.now(), day: s.publicInfo.day, kind: kind, text: text });
    if (s.handoffs.length > 200) s.handoffs.length = 200;
    return text;
  }

  function showHandoff(text, title) {
    U.modal({ title: title || '交接文本（需要对方手动修改）', body: h('div', { class: 'stack' }, U.copyBlock(text, { note: '复制后发到 Discord' }), h('p', { class: 'muted small' }, '玩家端不会自动同步到任何人的页面。')) });
  }

  // ================================================================ 查询

  function defOf(entry) {
    return C.getDef(entry.defId, state.customItems);
  }

  function describe(entry) {
    return C.describeEntry(entry, state.customItems);
  }

  function myName() {
    return state.name || '我';
  }

  function today() {
    return state.publicInfo.day;
  }

  function invTicks() {
    return C.listTicks(state.inventory, state.customItems, state.rules);
  }

  function carriedQty(entryId) {
    if (!state.loadout) return 0;
    var row = state.loadout.items.find(function (r) { return r.entryId === entryId; });
    return row ? row.qty : 0;
  }

  /** 库存变化后，把携带数量收缩到库存实际数量以内（携带只引用库存，不复制物品）。 */
  function syncLoadout(s) {
    if (!s.loadout) return;
    s.loadout.items = s.loadout.items.map(function (r) {
      var e = C.findEntry(s.inventory, r.entryId);
      return e ? { entryId: r.entryId, qty: Math.min(r.qty, e.qty) } : null;
    }).filter(function (r) { return r && r.qty > 0; });
  }

  function tempAttack() {
    return state.temporaryEffects.reduce(function (sum, fx) { return sum + (C.isNum(fx.attack) ? fx.attack : 0); }, 0);
  }

  function setTab(id) {
    id = TAB_ALIASES[id] || id;
    ui.tab = id;
    ui.moreOpen = false;
    U.writeKey(KEY_TAB, id);
    render();
    window.scrollTo(0, 0);
  }

  function chip(text, cls) {
    return h('span', { class: 'chip ' + (cls || '') }, text);
  }

  // ================================================================ 渲染骨架

  var PAGE_TITLE = document.title;

  /** 切换语言：只换显示文字，存档不变；页面标题与 <html lang> 一起换。 */
  function onLangChange() {
    document.title = U.T(PAGE_TITLE);
    render();
  }

  /** 联机消息随时会来：正在输入时只重画顶栏，离开输入框后再重画主体，避免打字被打断。 */
  function render() {
    renderBanner();
    renderTop();
    renderTabs();
    if (ui.quietRender && isTyping()) { ui.mainStale = true; return; }
    ui.mainStale = false;
    renderMain();
  }

  function flushStale() {
    if (!ui.mainStale || ui.pointerDown || isTyping()) return;
    renderMain();
    ui.mainStale = false;
  }

  function isTyping() {
    var el = document.activeElement;
    if (!el || !document.getElementById('main').contains(el)) return false;
    return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color|file)$/i.test(el.type));
  }

  function renderBanner() {
    var el = U.clear(document.getElementById('banner'));
    if (slot === 'demo') {
      el.appendChild(h('div', { class: 'banner demo' }, h('b', null, '演示存档'), h('span', null, '仅供试用，与正式存档完全分开。'),
        h('button', { type: 'button', class: 'btn small', onclick: exitDemo }, '返回正式存档'),
        h('button', { type: 'button', class: 'btn small danger', onclick: clearDemo }, '清空演示')));
    }
    notices.forEach(function (n, i) {
      el.appendChild(h('div', { class: 'banner ' + n.kind }, U.icon('warn'), h('span', { class: 'grow' }, n.text),
        h('button', { type: 'button', class: 'btn small ghost', onclick: function () { notices.splice(i, 1); render(); } }, '关闭')));
    });
    if (/\.vercel\.app$/.test(location.hostname)) {
      el.appendChild(h('div', { class: 'banner info' }, '你正在通过上游部署地址访问。正式入口是 www.xxxmnalx.com/game/shelter ——两个地址的存档互不相通。'));
    }
  }

  /** 简要面板：除总览页外常驻顶部。每格「名称＋数值＋小进度」，颜色之外都有文字，点一下去对应页。 */
  function renderTop() {
    var top = U.clear(document.getElementById('topbar'));
    var r = state.rules;
    var used = invTicks();
    var cap = r.inventoryCapacityTicks;
    var over = C.isInt(cap) && used > cap;
    var hw = hungerWord();
    var thirstIdx = THIRST.indexOf(state.thirst);
    function cell(key, label, value, level, viz, tab) {
      return h('button', { type: 'button', class: 'vcell lv-' + level, 'data-vital': key, onclick: function () { setTab(tab); } },
        h('span', { class: 'vcell-label' }, label),
        h('span', { class: 'vcell-value' }, value),
        viz || h('span', { class: 'vcell-viz-empty' }));
    }
    top.appendChild(h('div', { class: 'p-top' + (ui.tab === 'dashboard' ? ' on-dashboard' : '') },
      h('div', { class: 'p-top-row' },
        h('div', { class: 'p-name' }, h('b', null, state.name || '未命名玩家'), state.alive ? null : chip('已死亡', 'danger')),
        h('div', { class: 'p-day' },
          h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': '前一天', onclick: function () { setDay(today() - 1); } }, '‹'),
          h('span', null, '第 ', h('b', null, String(today())), ' 天'),
          h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': '后一天', onclick: function () { setDay(today() + 1); } }, '›')),
        h('div', { class: 'p-top-tools' },
          netChip(),
          U.langToggle(onLangChange),
          h('button', { type: 'button', class: 'btn small', onclick: undoLast, disabled: !undo.peek(), title: undo.peek() ? '撤销：' + undo.peek().label : '' }, U.icon('undo'), '撤销'))),
      h('div', { class: 'p-vitals', role: 'group', 'aria-label': '简要状态' },
        cell('hp', '生命', h('b', null, String(state.hp), C.isInt(r.hpMax) ? h('small', null, '／' + r.hpMax) : null),
          state.hp <= 0 ? 'crit' : state.hp <= 2 ? 'warn' : 'ok',
          C.isInt(r.hpMax) ? meter(state.hp, r.hpMax, state.hp <= 0 ? 'critical' : 'ok', '生命') : pips(state.hp), 'status'),
        cell('hunger', U.TC('label', '饥饿'), h('b', null, hw, C.isNum(state.hunger) ? h('small', null, ' ' + state.hunger) : null),
          hw === '饥荒' ? 'crit' : hw === '饥饿' ? 'warn' : hw === '未记录' ? 'info' : 'ok',
          stepsBar(HUNGER_ZONES, HUNGER_ZONES.indexOf(hw), hw === '饥荒' ? 'critical' : hw === '饥饿' ? 'warning' : 'ok'), 'status'),
        cell('thirst', U.TC('label', '口渴'), h('b', null, state.thirst),
          thirstIdx >= 2 ? 'crit' : thirstIdx === 1 ? 'warn' : 'ok',
          stepsBar(THIRST, thirstIdx, thirstIdx >= 2 ? 'critical' : thirstIdx === 1 ? 'warning' : 'ok'), 'status'),
        cell('mind', '意识', h('b', null, state.consciousness), state.consciousness === '昏迷' ? 'crit' : 'ok', null, 'status'),
        cell('inventory', '库存', h('b', null, C.fmtUnits(used), h('small', null, '／' + C.fmtUnits(cap))),
          over ? 'warn' : 'ok', meter(used, cap || used || 1, over ? 'warning' : 'ok', '库存占位'), 'inventory'),
        cell('statuses', state.loadout && state.loadout.confirmed ? '携带中' : '负面状态',
          state.loadout && state.loadout.confirmed ? h('b', null, C.fmtUnits(C.loadoutTicks(state)), h('small', null, ' 单位')) : h('b', null, state.statuses.length ? state.statuses.length + ' 个' : '无'),
          state.loadout && state.loadout.confirmed ? 'info' : state.statuses.length ? 'warn' : 'ok', null,
          state.loadout && state.loadout.confirmed ? 'inventory' : 'status'))));
    // 标签栏吸附在状态栏下方：按状态栏实际高度定位
    document.documentElement.style.setProperty('--top-h', top.offsetHeight + 'px');
  }

  function hungerWord() {
    return C.hungerZone(state.hunger, state.rules) || state.hungerManual || '未记录';
  }

  function setDay(d) {
    if (!C.isInt(d) || d < 0) return;
    commit('修改天数', function (s) {
      s.publicInfo.day = d;
      log(s, '记录当前天数：第' + d + '天');
    });
  }

  function tabButton(t) {
    // 手机底栏用短名，平板和电脑用全名
    // 英文短名另取（Home／Items／Loot），手机底栏 6 格放得下
    return h('button', { type: 'button', class: 'tab ' + (ui.tab === t.id ? 'on' : ''), 'data-tab': t.id, 'aria-current': ui.tab === t.id ? 'page' : null, onclick: function () { setTab(t.id); } },
      h('span', { class: 'tab-short' }, U.TC('tab-short', t.name)), h('span', { class: 'tab-full' }, t.full || t.name));
  }

  /** 手机：底栏 5 个常用页 +「更多」；平板：顶部一行；电脑：左侧栏。三种布局共用同一组按钮，由 CSS 排布。 */
  function renderTabs() {
    var nav = U.clear(document.getElementById('tabs'));
    nav.setAttribute('aria-label', U.T('玩家面板'));
    var current = TABS.find(function (t) { return t.id === ui.tab; });
    var inMore = current && !current.primary;
    nav.appendChild(h('div', { class: 'tabs-primary' },
      TABS.filter(function (t) { return t.primary; }).map(tabButton),
      h('button', {
        type: 'button', class: 'tab more-btn ' + (inMore ? 'on' : ''), 'aria-expanded': ui.moreOpen ? 'true' : 'false', 'aria-controls': 'tabs-more',
        onclick: function (e) { e.stopPropagation(); ui.moreOpen = !ui.moreOpen; renderTabs(); }
      }, inMore ? current.name : '更多')));
    nav.appendChild(h('div', { class: 'tabs-secondary' + (ui.moreOpen ? ' open' : ''), id: 'tabs-more' },
      TABS.filter(function (t) { return !t.primary; }).map(tabButton)));
  }

  function renderMain() {
    var main = U.clear(document.getElementById('main'));
    var views = { dashboard: renderDashboard, status: renderStatus, inventory: renderInventory, scavenge: renderScavenge, action: renderAction, net: renderNet, score: renderScore, save: renderSave };
    main.className = 'main p-main tab-' + ui.tab;
    main.appendChild((views[ui.tab] || renderDashboard)());
  }

  // ================================================================ 总览

  var sevBadge = U.sevBadge;
  var meter = U.meter;

  /** 分级条：三档状态（如口渴）按档位填充，2px 间隔分开。 */
  function stepsBar(names, index, level) {
    var cls = { ok: 'ok', info: 'info', warning: 'warn', critical: 'crit' }[level] || 'ok';
    return h('span', { class: 'steps m-' + cls, 'aria-hidden': 'true', style: 'grid-template-columns:repeat(' + names.length + ',minmax(0,1fr))' },
      names.map(function (n, i) { return h('span', { class: 'step' + (i <= index ? ' on' : '') }); }));
  }

  /** 生命没有确定上限时，用「一格一点生命」表示，不暗示上限。 */
  function pips(n) {
    var shown = Math.max(0, Math.min(n, 12));
    var out = [];
    for (var i = 0; i < shown; i++) out.push(h('span', { class: 'pip' }));
    if (n > 12) out.push(h('span', { class: 'pip-more' }, '+' + (n - 12)));
    return h('span', { class: 'pips', 'aria-hidden': 'true' }, out);
  }

  function tile(o) {
    return U.statTile(Object.assign({ onclick: function () { setTab(o.tab); } }, o));
  }

  function renderDashboard() {
    return h('div', { class: 'dash' },
      netLiveCard(),
      vitalsSection(),
      quickActions(),
      h('div', { class: 'dash-cols' },
        h('div', { class: 'dash-col' }, alertsCard(), compositionCard(), recentCard()),
        h('div', { class: 'dash-col' }, todayCard(), conditionsCard(), identityCard())));
  }

  function vitalsSection() {
    var r = state.rules;
    var hp = state.hp;
    var zone = C.hungerZone(state.hunger, r);
    var manual = state.hungerManual;
    var hungerWord = zone || manual || '未记录';
    var hungerLevel = hungerWord === '饥荒' ? 'critical' : hungerWord === '饥饿' ? 'warning' : hungerWord === '未记录' ? 'info' : 'ok';
    var thirstIdx = THIRST.indexOf(state.thirst);
    var thirstLevel = thirstIdx >= 2 ? 'critical' : thirstIdx === 1 ? 'warning' : 'ok';
    var used = invTicks();
    var cap = r.inventoryCapacityTicks;
    var over = C.isInt(cap) && used > cap;
    var counts = C.wealthCounts(state.inventory);
    var w = C.wealthScore(counts, !state.alive);
    var actedToday = state.action.day === today() && state.action.used;
    var carried = state.loadout ? state.loadout.items.reduce(function (n, row) { return n + row.qty; }, 0) : 0;
    return h('section', { class: 'vitals', 'aria-label': '核心状态' },
      tile({
        key: 'hp', cls: 'hero', tab: 'status', label: '生命',
        badge: !state.alive ? sevBadge('info', '已死亡') : hp <= 0 ? sevBadge('critical', '生命为 0') : sevBadge('ok', '存活'),
        value: String(hp), unit: C.isInt(r.hpMax) ? '／' + r.hpMax : '',
        viz: C.isInt(r.hpMax) ? meter(hp, r.hpMax, hp <= 0 ? 'critical' : 'ok', '生命') : pips(hp),
        sub: '基础战斗力 ' + Math.max(0, hp) + (C.isInt(r.hpMax) ? '' : ' · 生命上限待配置')
      }),
      tile({
        key: 'hunger', tab: 'status', label: U.TC('label', '饥饿'), badge: sevBadge(hungerLevel, zone ? '自动' : '手动'),
        value: hungerWord, unit: C.isNum(state.hunger) ? ' ' + state.hunger : '',
        viz: C.isInt(r.hungerMax) && C.isNum(state.hunger) ? meter(state.hunger, r.hungerMax, hungerLevel, '饥饿值') : null,
        sub: zone ? '按阈值自动判定' : '阈值待配置'
      }),
      tile({
        key: 'thirst', tab: 'status', label: U.TC('label', '口渴'), badge: sevBadge(thirstLevel),
        value: state.thirst, viz: stepsBar(THIRST, thirstIdx, thirstLevel), sub: '补水幅度待定'
      }),
      tile({
        key: 'mind', tab: 'status', label: '意识', badge: sevBadge(state.consciousness === '昏迷' ? 'critical' : 'ok'),
        value: state.consciousness, sub: state.statuses.length ? '负面状态 ' + state.statuses.length + ' 个' : '没有负面状态'
      }),
      tile({
        key: 'inventory', tab: 'inventory', label: '库存占位', badge: over ? sevBadge('warning', '超出上限') : sevBadge('ok', '未超出'),
        value: C.fmtUnits(used), unit: '／' + C.fmtUnits(cap) + ' 单位',
        viz: meter(used, cap || used || 1, over ? 'warning' : 'ok', '库存占位'),
        sub: C.countPieces(state.inventory) + ' 件' + (carried ? ' · 携带中 ' + carried + ' 件' : '')
      }),
      tile({
        key: 'wealth', tab: 'score', label: '财富估算',
        badge: !state.alive ? sevBadge('info', '死亡清零') : w.pending ? sevBadge('warning', '待主持人计分') : null,
        value: w.score == null ? '—' : String(w.score), unit: w.score == null ? '' : ' 分',
        sub: '钞票 ' + counts.cash + ' · 名画 ' + counts.painting + ' · 珠宝 ' + counts.jewel + ' · 地图笔记 ' + C.mapNotesTotal(state.inventory)
      }),
      tile({
        key: 'today', tab: 'action', label: '今天', badge: actedToday ? sevBadge('ok', actionName(state.action.type)) : sevBadge('info', '未行动'),
        value: '第 ' + today() + ' 天', sub: state.publicInfo.seat ? '座次 ' + state.publicInfo.seat : '座次未记录'
      }));
  }

  function quickActions() {
    var sc = state.scavenge;
    var scavLive = sc && (sc.status === 'running' || sc.status === 'organize');
    var actedToday = state.action.day === today() && state.action.used;
    return h('div', { class: 'quick', role: 'group', 'aria-label': '快捷操作' },
      h('button', { type: 'button', class: 'btn primary', onclick: addItemDialog }, U.icon('plus'), '添加物品'),
      h('button', { type: 'button', class: 'btn' + (scavLive ? ' risk' : ''), onclick: function () { setTab('scavenge'); } }, scavLive ? '继续搜刮' : '搜刮'),
      h('button', { type: 'button', class: 'btn' + (state.loadout ? ' risk' : ''), onclick: function () { setTab('inventory'); if (!state.loadout) carrySetupDialog(); } }, state.loadout ? '携带中' : '携带模式'),
      h('button', { type: 'button', class: 'btn', onclick: function () { setTab('action'); } }, actedToday ? '今日：' + actionName(state.action.type) : '选择今日行动'));
  }

  function dashCard(title, body, opts) {
    opts = opts || {};
    return h('section', { class: 'card dash-card ' + (opts.cls || ''), 'aria-label': title },
      h('div', { class: 'card-head' }, h('h2', null, title), opts.action || null),
      body);
  }

  function linkBtn(label, tab) {
    return h('button', { type: 'button', class: 'btn small ghost go', onclick: function () { setTab(tab); } }, label, U.icon('arrow'));
  }

  function alertsCard() {
    var alerts = C.playerAlerts(state);
    var body = alerts.length ? h('ul', { class: 'alerts' }, alerts.map(function (a) {
      return h('li', { class: 'alert-row' },
        sevBadge(a.level),
        h('span', { class: 'alert-text' }, a.text),
        h('button', { type: 'button', class: 'btn small', onclick: function () { setTab(a.tab); } }, '查看'));
    })) : h('p', { class: 'all-clear' }, sevBadge('ok', '一切正常'), ' 没有需要处理的提醒。');
    return dashCard('需要留意', body, { cls: 'c-alerts' });
  }

  function compositionCard() {
    var rows = C.capacityByCategory(state.inventory, state.customItems, state.rules);
    var cap = state.rules.inventoryCapacityTicks;
    var used = invTicks();
    var scale = Math.max(cap || 0, used, 1);
    var tip = h('div', { class: 'viz-tip', role: 'status', 'aria-live': 'polite', hidden: true });
    function showTip(el, row) {
      tip.textContent = '';
      tip.appendChild(h('b', null, C.fmtUnits(row.ticks) + ' 单位'));
      tip.appendChild(document.createTextNode(' ' + row.name + ' · ' + row.pieces + ' 件' + (cap ? ' · 占上限 ' + Math.round((row.ticks / cap) * 100) + '%' : '')));
      tip.hidden = false;
      tip.style.top = (el.offsetTop - 6) + 'px';
    }
    var body = rows.length ? h('div', { class: 'bars-wrap' },
      h('ul', { class: 'bars', 'aria-label': '各分类占位（单位）' }, rows.map(function (row) {
        var li = h('li', { class: 'bar-row', tabindex: '0', 'aria-label': row.name + ' ' + C.fmtUnits(row.ticks) + ' 单位，' + row.pieces + ' 件' },
          h('span', { class: 'bar-label' }, row.name),
          h('span', { class: 'bar-track' },
            h('span', { class: 'bar', style: 'width:calc((100% - 6.5em) * ' + (row.ticks / scale).toFixed(4) + ')' }),
            h('span', { class: 'bar-value' }, C.fmtUnits(row.ticks), h('span', { class: 'muted' }, ' · ' + row.pieces + '件'))));
        li.addEventListener('pointerenter', function () { showTip(li, row); });
        li.addEventListener('focus', function () { showTip(li, row); });
        li.addEventListener('pointerleave', function () { tip.hidden = true; });
        li.addEventListener('blur', function () { tip.hidden = true; });
        return li;
      })),
      tip,
      h('p', { class: 'bars-caption' }, '比例尺 0–' + C.fmtUnits(scale) + ' 单位' + (cap ? '（个人总库存上限 ' + C.fmtUnits(cap) + '）' : '') + '；已用 ' + C.fmtUnits(used) + ' 单位')) :
      h('p', { class: 'empty' }, netJoined() ? '库存是空的。领到的补给、别人赠予的物品会自动放进来。' : '库存是空的。主持人发放物资后在「库存」页手动添加。');
    return dashCard('占位构成', body, { cls: 'c-comp', action: linkBtn('库存', 'inventory') });
  }

  function todayCard() {
    var lo = state.loadout;
    var sc = state.scavenge;
    var items = [];
    if (lo) {
      var carriedEntries = [];
      lo.items.forEach(function (row) {
        var e = C.findEntry(state.inventory, row.entryId);
        if (e) for (var i = 0; i < row.qty; i++) carriedEntries.push(e);
      });
      var cs = C.combatSummary(state.hp, carriedEntries, state.customItems, tempAttack());
      items.push(h('li', null, h('b', null, (lo.context === 'event' ? '事件' : '守夜') + '携带中'),
        h('span', null, C.fmtUnits(C.loadoutTicks(state)) + '／' + (lo.limitTicks == null ? '上限待定' : C.fmtUnits(lo.limitTicks)) + ' 单位 · ' +
          lo.items.map(function (row) { var e = C.findEntry(state.inventory, row.entryId); return e ? defOf(e).name + (row.qty > 1 ? '×' + row.qty : '') : ''; }).filter(Boolean).join('、')),
        h('span', { class: 'muted small' }, '战斗力 ' + (cs.multiple ? cs.bestOnly + '～' + cs.stacked + '（叠加待定）' : cs.stacked))));
    }
    if (sc && sc.status !== 'submitted') items.push(h('li', null, h('b', null, '搜刮'), h('span', null, sc.status === 'running' ? '进行中：第 ' + sc.rounds.length + '／' + sc.cfg.rounds + ' 轮' : '待整理提交')));
    state.temporaryEffects.forEach(function (fx) { items.push(h('li', null, h('b', null, '临时效果'), h('span', null, fx.text))); });
    if (state.publicInfo.notes) items.push(h('li', null, h('b', null, '公共笔记'), h('span', { class: 'clamp' }, state.publicInfo.notes)));
    var body = items.length ? h('ul', { class: 'facts' }, items) : h('p', { class: 'empty' }, '没有携带中的物品、进行中的搜刮或临时效果。');
    return dashCard('进行中', body, { cls: 'c-today', action: linkBtn('库存与携带', 'inventory') });
  }

  function conditionsCard() {
    var body = state.statuses.length ? h('ul', { class: 'facts' }, state.statuses.map(function (st) {
      var due = st.statusId === 'bleeding' && C.isInt(st.nextDay) && today() >= st.nextDay;
      return h('li', null, h('b', null, st.name), h('span', null,
        st.statusId === 'bleeding' ? '第 ' + st.startDay + ' 天获得 · 第 ' + (st.nextDay == null ? '?' : st.nextDay) + ' 天提醒' : (st.note || '效果见状态页')),
        due ? sevBadge('warning', '到期') : null);
    })) : h('p', { class: 'all-clear' }, sevBadge('ok', '无'), ' 没有负面状态。');
    return dashCard('负面状态', body, { cls: 'c-cond', action: linkBtn('状态', 'status') });
  }

  function identityCard() {
    var prof = state.rules.professionsEnabled ? C.getProfession(state.professionId) : null;
    var task = state.rules.tasksEnabled ? C.getTask(state.taskId) : null;
    var toggle = h('button', {
      type: 'button', class: 'btn small ghost', 'aria-pressed': ui.hideIdentity ? 'true' : 'false', onclick: function () {
        ui.hideIdentity = !ui.hideIdentity;
        U.writeKey(KEY_HIDE_ID, ui.hideIdentity ? '1' : '0');
        render();
      }
    }, U.icon(ui.hideIdentity ? 'unlock' : 'eyeOff'), ui.hideIdentity ? '显示' : '遮住');
    var body;
    if (ui.hideIdentity) {
      body = h('p', { class: 'muted' }, '身份与目标已遮住（只在这台设备上生效）。');
    } else {
      var rows = [
        ['爱的人', state.loveName || '未填写'],
        ['恨的人', state.hateName || '未填写']
      ];
      if (prof) rows.push(['职业', prof.name + '（草案）']);
      if (task) {
        var progress = task.progress === 'events' ? state.taskProgress.events.length + '／' + task.target : task.progress === 'counter' ? state.taskProgress.count + '／' + task.target : '结算时判断';
        rows.push(['秘密任务', task.name + ' · ' + (state.taskProgress.done ? '已完成' : progress)]);
      }
      body = h('dl', { class: 'kv' }, rows.map(function (r) { return [h('dt', null, r[0]), h('dd', null, r[1])]; }));
    }
    return dashCard('身份与目标', body, { cls: 'c-id', action: toggle });
  }

  function recentCard() {
    var list = state.log.slice(0, 6);
    var body = list.length ? h('ul', { class: 'log-list compact' }, list.map(function (l) {
      return h('li', null, h('span', { class: 'log-meta' }, (l.day != null ? '第' + l.day + '天 ' : '') + U.fmtTime(l.at).slice(6)), l.text);
    })) : h('p', { class: 'empty' }, '还没有记录。');
    return dashCard('最近记录', body, { cls: 'c-recent', action: linkBtn('全部', 'save') });
  }

  // ================================================================ 状态

  function renderStatus() {
    return h('div', { class: 'stack' }, bleedReminders(), hpCard(), hungerCard(), thirstCard(), statusesCard(), effectsCard(), aliveCard());
  }

  function bleedReminders() {
    var due = state.statuses.filter(function (st) { return st.statusId === 'bleeding' && C.isInt(st.nextDay) && today() >= st.nextDay; });
    if (!due.length) return null;
    return h('div', { class: 'stack' }, due.map(function (st) {
      return h('div', { class: 'callout risk' },
        h('p', null, h('b', null, '流血提醒：'), '第 ' + st.nextDay + ' 天到期（获得于第 ' + st.startDay + ' 天）。每两个回合失去1生命——请先与主持人确认，避免两端重复扣血。'),
        h('div', { class: 'row' },
          h('button', {
            type: 'button', class: 'btn small risk', onclick: function () {
              commit('流血扣血', function (s) {
                var x = s.statuses.find(function (y) { return y.id === st.id; });
                s.hp -= 1;
                x.nextDay = today() + 2;
                log(s, '流血伤口：经主持人确认扣1生命 → ' + s.hp + '；下次提醒第' + x.nextDay + '天');
              });
            }
          }, '已确认，扣1生命'),
          h('button', {
            type: 'button', class: 'btn small', onclick: function () {
              commit('流血不扣', function (s) {
                var x = s.statuses.find(function (y) { return y.id === st.id; });
                x.nextDay = today() + 2;
                log(s, '流血伤口：主持人裁定本次不扣血；下次提醒第' + x.nextDay + '天');
              });
            }
          }, '主持人裁定不扣')));
    }));
  }

  function hpCard() {
    var r = state.rules;
    function set(v) {
      if (!C.isInt(v)) { U.toast('生命需为整数', 'warn'); return; }
      commit('修改生命', function (s) {
        var old = s.hp;
        if (old === v) return false;
        s.hp = v;
        log(s, '生命 ' + old + ' → ' + v);
      });
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '生命'), h('span', { class: 'muted small' }, '初始 ' + r.hpInitial + ' · 上限 ' + (r.hpMax == null ? '待配置' : r.hpMax))),
      h('div', { class: 'big-row' },
        h('button', { type: 'button', class: 'btn big', onclick: function () { set(state.hp - 1); }, 'aria-label': '生命减一' }, '−1'),
        h('div', { class: 'big-num ' + (state.hp <= 0 ? 'danger-text' : '') }, String(state.hp)),
        h('button', { type: 'button', class: 'btn big', onclick: function () { set(state.hp + 1); }, 'aria-label': '生命加一' }, '+1')),
      h('p', null, '基础战斗力＝当前生命：', h('b', null, String(Math.max(0, state.hp)))),
      state.hp <= 0 ? h('div', { class: 'callout danger' }, '生命为 0：0 生命的处理与死亡时点尚未确定（' + (r.hpZeroRule || C.PENDING_TEXT) + '）。页面不会自动判定死亡。') : null,
      C.isInt(r.hpMax) && state.hp > r.hpMax ? h('div', { class: 'callout risk' }, '超过生命上限 ' + r.hpMax + '：请确认是否录入有误。') : null);
  }

  function hungerCard() {
    var r = state.rules;
    var zone = C.hungerZone(state.hunger, r);
    var auto = C.isNum(r.hungerFullAt) && C.isNum(r.hungerHungryAt);
    function setValue(v) {
      commit('修改饥饿值', function (s) {
        var old = s.hunger;
        if (old === v) return false;
        s.hunger = v;
        log(s, '饥饿值 ' + (old == null ? '未记录' : old) + ' → ' + (v == null ? '未记录' : v));
      });
    }
    var input = h('input', { type: 'number', class: 'num', value: state.hunger == null ? '' : state.hunger, placeholder: '未记录', 'aria-label': '饥饿值' });
    input.addEventListener('change', function () {
      var n = U.parseNumber(input.value, true);
      if (Number.isNaN(n)) { U.toast('请输入数字或留空', 'warn'); input.value = state.hunger == null ? '' : state.hunger; return; }
      setValue(n);
    });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, U.TC('label', '饥饿')), h('span', { class: 'muted small' }, '充盈／普通／饥饿／饥荒')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: function () { setValue((state.hunger || 0) - 1); } }, '−1'),
        input,
        h('button', { type: 'button', class: 'btn', onclick: function () { setValue((state.hunger || 0) + 1); } }, '+1'),
        h('span', null, '区间：', h('b', null, zone || (state.hungerManual || '未记录')), auto ? h('span', { class: 'muted small' }, '（按阈值自动判定）') : h('span', { class: 'muted small' }, '（手动）'))),
      auto ? null : h('div', { class: 'stack' },
        h('p', { class: 'small' }, U.pendingTag('阈值待配置'), ' 未填阈值时禁用自动判定，保留手动状态：'),
        U.segmented(HUNGER_ZONES.map(function (z) { return [z, z]; }), state.hungerManual || '', function (v) {
          commit('手动饥饿状态', function (s) {
            if (s.hungerManual === v) return false;
            s.hungerManual = v;
            log(s, '饥饿状态（手动）：' + v);
          });
        })),
      auto && !C.isNum(r.hungerFamineAt) ? h('p', { class: 'small' }, U.pendingTag('饥荒阈值待配置'), ' 自动判定只到「饥饿」；饥荒阈值填写后才会自动判为饥荒。') : null,
      h('p', { class: 'muted small' }, '充盈改善力气和相关成功率，饥饿降低相关成功率，饥荒比饥饿更严重（具体修正与后果未定）。按行动消耗前的状态判定，再扣事件消耗；事件开启后不能靠临时进食提升本次状态（提示，不强制）。'));
  }

  function thirstCard() {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '口渴与意识')),
      h('div', { class: 'row' }, h('span', { class: 'field-label' }, '口渴'), U.segmented(THIRST.map(function (t) { return [t, t]; }), state.thirst, setThirst)),
      h('div', { class: 'row' }, h('span', { class: 'field-label' }, '意识'), U.segmented([['清醒', '清醒'], ['昏迷', '昏迷']], state.consciousness, function (v) {
        commit('修改意识', function (s) {
          if (s.consciousness === v) return false;
          log(s, '意识 ' + s.consciousness + ' → ' + v);
          s.consciousness = v;
        });
      })),
      h('p', { class: 'muted small' }, '脱水直接昏迷（已确认）。没有固定的每日口渴扣减，由结算结果触发；补水幅度、昏迷如何解除及能做哪些事尚未确定——请手动切换，不会自动判成死亡。'));
  }

  function setThirst(v) {
    commit('修改口渴', function (s) {
      if (s.thirst === v) return false;
      log(s, '口渴 ' + s.thirst + ' → ' + v);
      s.thirst = v;
      if (v === '脱水' && s.consciousness !== '昏迷') {
        s.consciousness = '昏迷';
        log(s, '脱水直接昏迷');
      }
    });
    if (v === '脱水') U.toast('脱水直接昏迷（已确认规则）', 'warn');
  }

  function statusesCard() {
    var options = C.STATUSES.filter(function (st) { return st.ruleStatus !== 'draft' || state.rules.draftStatusesEnabled; })
      .map(function (st) { return [st.id, st.name + (st.ruleStatus === 'draft' ? '（草案）' : '')]; }).concat([['custom', '自定义状态…']]);
    var sel = U.select(options, 'bleeding', function () {});
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '负面状态')),
      state.statuses.length ? h('ul', { class: 'list-plain' }, state.statuses.map(function (st) {
        var def = st.statusId ? C.getStatusDef(st.statusId) : null;
        return h('li', null,
          h('div', { class: 'row between' },
            h('div', { class: 'grow' }, h('b', null, st.name), ' ', def ? U.ruleBadge(def.ruleStatus) : U.ruleBadge('custom'),
              st.statusId === 'bleeding' ? h('div', { class: 'small' }, '获得于第 ' + st.startDay + ' 天；下次提醒第 ' + (st.nextDay == null ? '?' : st.nextDay) + ' 天（主持人确认后扣血）') : null,
              def ? h('div', { class: 'muted small' }, def.effectText) : null,
              st.note ? h('div', { class: 'muted small' }, st.note) : null),
            h('div', { class: 'row tight' },
              st.statusId === 'bleeding' ? h('button', { type: 'button', class: 'btn small', onclick: function () { editBleed(st); } }, '改日期') : null,
              h('button', {
                type: 'button', class: 'btn small', onclick: function () {
                  commit('移除状态', function (s) { s.statuses = s.statuses.filter(function (x) { return x.id !== st.id; }); log(s, '移除状态：' + st.name); });
                }
              }, '移除'))));
      })) : h('p', { class: 'empty' }, '没有负面状态。'),
      h('div', { class: 'row' }, sel, h('button', { type: 'button', class: 'btn', onclick: function () { addStatus(sel.value); } }, '添加')),
      state.rules.draftStatusesEnabled ? h('p', { class: 'muted small' }, '感染、腹泻、虚弱、拉伤、眩晕：候选状态，效果未被确认。') :
        h('p', { class: 'muted small' }, '感染、腹泻、虚弱、拉伤、眩晕是草案状态，默认停用（可在「存档 → 规则」按主持人通知启用）。'));
  }

  function addStatus(statusId) {
    if (statusId === 'custom') {
      var nameI = h('input', { type: 'text', placeholder: '状态名称', autofocus: true });
      var noteI = h('input', { type: 'text', placeholder: '说明（可选）' });
      U.modal({ title: '自定义状态', body: h('div', { class: 'stack' }, U.field('名称', nameI), U.field('说明', noteI)), actions: [{ label: '取消', value: false }, { label: '添加', kind: 'primary', value: true }] })
        .then(function (ok) {
          if (!ok || !nameI.value.trim()) return;
          commit('添加状态', function (s) {
            s.statuses.push({ id: C.uid('st'), statusId: null, name: nameI.value.trim(), startDay: today(), nextDay: null, note: noteI.value });
            log(s, '添加状态：' + nameI.value.trim());
          });
        });
      return;
    }
    var def = C.getStatusDef(statusId);
    if (!def) return;
    if (statusId !== 'bleeding') {
      commit('添加状态', function (s) {
        s.statuses.push({ id: C.uid('st'), statusId: statusId, name: def.name, startDay: today(), nextDay: null, note: '' });
        log(s, '添加状态：' + def.name + '（草案，效果未确认）');
      });
      return;
    }
    var start = h('input', { type: 'number', class: 'num', value: today() });
    var next = h('input', { type: 'number', class: 'num', value: today() + 2 });
    var exists = state.statuses.some(function (st) { return st.statusId === 'bleeding'; });
    U.modal({
      title: '添加流血伤口',
      body: h('div', { class: 'stack' },
        exists ? h('div', { class: 'callout risk' }, '已经有流血伤口。重复流血是否叠加尚未确定——请先与主持人确认。') : null,
        h('div', { class: 'grid2' }, U.field('获得日期（第几天）', start), U.field('下次触发日期', next)),
        h('p', { class: 'muted small' }, '每两个回合失去1生命，直到清除。获得当天是否计入两回合待定：默认下次为获得日+2，可改。到期只提醒，扣血前与主持人确认。')),
      actions: [{ label: '取消', value: false }, { label: '添加', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var a = parseInt(start.value, 10);
      var b = parseInt(next.value, 10);
      if (!C.isInt(a) || !C.isInt(b)) { U.toast('日期需为整数', 'warn'); return; }
      commit('添加流血', function (s) {
        s.statuses.push({ id: C.uid('st'), statusId: 'bleeding', name: '流血伤口', startDay: a, nextDay: b, note: '' });
        log(s, '添加流血伤口：第' + a + '天获得，第' + b + '天提醒');
      });
    });
  }

  function editBleed(st) {
    var start = h('input', { type: 'number', class: 'num', value: st.startDay });
    var next = h('input', { type: 'number', class: 'num', value: st.nextDay == null ? '' : st.nextDay });
    U.modal({ title: '修改流血日期', body: h('div', { class: 'grid2' }, U.field('获得日期', start), U.field('下次触发日期', next)), actions: [{ label: '取消', value: false }, { label: '保存', kind: 'primary', value: true }] })
      .then(function (ok) {
        if (!ok) return;
        var a = parseInt(start.value, 10);
        var b = U.parseNumber(next.value, false);
        if (!C.isInt(a) || Number.isNaN(b)) { U.toast('日期需为整数', 'warn'); return; }
        commit('修改流血日期', function (s) {
          var x = s.statuses.find(function (y) { return y.id === st.id; });
          x.startDay = a;
          x.nextDay = b;
          log(s, '修改流血日期：第' + a + '天获得，下次第' + (b == null ? '?' : b) + '天');
        });
      });
  }

  function effectsCard() {
    var input = h('input', { type: 'text', placeholder: '例如：下一任务临时攻击+2（酒）' });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '临时效果')),
      state.temporaryEffects.length ? h('ul', { class: 'list-plain' }, state.temporaryEffects.map(function (fx) {
        return h('li', { class: 'row between' }, h('span', { class: 'grow' }, fx.text, h('span', { class: 'muted small' }, ' · 第' + fx.day + '天'), C.isNum(fx.attack) ? chip('攻击+' + fx.attack, 'ok') : null),
          h('button', { type: 'button', class: 'btn small', onclick: function () { commit('清除临时效果', function (s) { s.temporaryEffects = s.temporaryEffects.filter(function (x) { return x.id !== fx.id; }); log(s, '清除临时效果：' + fx.text); }); } }, '清除'));
      })) : h('p', { class: 'empty' }, '没有临时效果。'),
      h('div', { class: 'row' }, input, h('button', {
        type: 'button', class: 'btn', onclick: function () {
          var t = input.value.trim();
          if (!t) return;
          commit('添加临时效果', function (s) { s.temporaryEffects.push({ id: C.uid('fx'), text: t, day: today(), attack: null }); log(s, '添加临时效果：' + t); });
        }
      }, '添加')),
      h('p', { class: 'muted small' }, '临时效果只记录到下一次任务或行动，不自动扩展为全回合加成；用完请手动清除。'));
  }

  function aliveCard() {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '存活')),
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: !state.alive, onchange: function (e) {
          var dead = e.target.checked;
          commit('存活状态', function (s) { s.alive = !dead; log(s, dead ? '标记为死亡（由主持人宣布）' : '恢复为存活'); });
        }
      }), '我已死亡（由主持人宣布）'),
      h('p', { class: 'muted small' }, '死亡后不保留财富分；爱恨与任务分保留，各任务是否仍可继续完成待定。'));
  }

  // ================================================================ 库存

  // ================================================================ 库存与携带
  //
  // 同一页里有三种模式：
  //   平时：每张物品卡有「使用／赠予／修改／删除」；
  //   挑选携带：卡片上换成「带上」，按上限（默认2单位）挑选，超出的选不上；
  //   携带中：只有带上的卡片高亮可操作（事件结束后直接删除或修改），其余卡片暂时锁定。

  function carryMode() {
    var lo = state.loadout;
    return !lo ? 'normal' : lo.confirmed ? 'carrying' : 'selecting';
  }

  function categoryName(id) {
    return (C.CATEGORIES.find(function (c) { return c.id === id; }) || {}).name || '其他';
  }

  function renderInventory() {
    var used = invTicks();
    var cap = state.rules.inventoryCapacityTicks;
    var over = C.isInt(cap) && used > cap;
    var mode = carryMode();
    var list = state.inventory.filter(function (e) { return ui.filter === 'all' || defOf(e).category === ui.filter; });
    var body;
    if (!list.length) {
      body = h('p', { class: 'empty card' }, state.inventory.length ? '这个分类下没有物品。' : '库存是空的。主持人发放物资后，请在这里手动添加。');
    } else if (ui.sort === 'default') {
      body = h('div', { class: 'inv-grid' }, list.map(itemCard));
    } else {
      body = h('div', { class: 'inv-groups' }, C.CATEGORIES.map(function (cat) {
        var rows = list.filter(function (e) { return defOf(e).category === cat.id; });
        if (!rows.length) return null;
        var ticks = rows.reduce(function (n, e) { return n + C.entryTicks(e, state.customItems, state.rules); }, 0);
        return h('section', { class: 'inv-group cat-' + cat.id, 'aria-label': cat.name },
          h('h3', { class: 'inv-group-head' }, h('span', { class: 'cat-dot' }), h('span', { class: 'inv-group-name' }, cat.name), h('span', { class: 'muted small' }, C.countPieces(rows) + ' 件 · ' + C.fmtUnits(ticks) + ' 单位')),
          h('div', { class: 'inv-grid' }, rows.map(itemCard)));
      }));
    }
    return h('div', { class: 'inv-page mode-' + mode },
      h('section', { class: 'card inv-head' },
        h('div', { class: 'row between' }, h('h2', null, '库存与携带'), h('span', { class: 'cap ' + (over ? 'risk-text' : 'ok-text') }, '总占位 ', h('b', null, C.fmtUnits(used) + ' / ' + C.fmtUnits(cap)), ' 单位')),
        U.meter(used, cap || used || 1, over ? 'warning' : 'ok', '库存占位'),
        over ? h('div', { class: 'callout risk' }, '超出总库存上限 ' + C.fmtUnits(used - cap) + ' 单位：只警告，不阻断主持人裁定。') : null,
        C.canteenCapacityPending(state.inventory, state.rules) ? h('p', { class: 'small' }, U.pendingTag('水壶内的水是否额外占容量：待配置'), ' 目前只计算水壶本身。') : null,
        h('div', { class: 'inv-tools' },
          h('div', { class: 'inv-sort' }, h('span', { class: 'muted small' }, '排列'),
            U.segmented([['category', '按类别'], ['default', '默认顺序']], ui.sort, function (v) { ui.sort = v; U.writeKey(KEY_SORT, v); render(); })),
          h('div', { class: 'filters' }, [['all', '全部']].concat(C.CATEGORIES.map(function (c) { return [c.id, c.name]; })).map(function (f) {
            var n = f[0] === 'all' ? state.inventory.length : state.inventory.filter(function (e) { return defOf(e).category === f[0]; }).length;
            if (f[0] !== 'all' && !n) return null;
            return h('button', { type: 'button', class: 'filter ' + (ui.filter === f[0] ? 'on' : ''), 'aria-pressed': ui.filter === f[0] ? 'true' : 'false', onclick: function () { ui.filter = f[0]; render(); } }, f[1] + (n ? ' ' + n : ''));
          }))),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', onclick: addItemDialog }, '+ 添加物品'),
          h('button', { type: 'button', class: 'btn', onclick: customItemDialog }, '添加自定义物品'),
          mode === 'normal' ? h('button', { type: 'button', class: 'btn carry-btn', onclick: carrySetupDialog }, '携带模式') : null)),
      mode !== 'normal' ? carryPanel(mode) : null,
      body);
  }

  /** 物品卡：长方形卡片，按类别着色的顶边；按钮随模式切换。 */
  function itemCard(e) {
    var def = defOf(e);
    var mode = carryMode();
    var carried = carriedQty(e.id);
    var locked = mode === 'carrying' && !carried;
    var task = state.rules.tasksEnabled && state.taskId === 'hoarder';
    var hoardable = mode === 'normal' && task && C.isStackable(def) && e.qty >= 3 && e.defId !== 'bread' && e.defId !== 'water';
    var actions;
    if (mode === 'selecting') {
      actions = carryPicker(e, def, carried);
    } else if (locked) {
      actions = h('p', { class: 'locked-note' }, U.icon('lock'), '携带中：暂不可操作');
    } else {
      actions = h('div', { class: 'card-actions' },
        def.use ? h('button', { type: 'button', class: 'btn small primary', onclick: function () { useItem(e.id); } }, '使用') : null,
        mode === 'normal' ? h('button', { type: 'button', class: 'btn small', 'aria-label': '赠予／交公', title: '赠予他人或交给公共池', onclick: function () { transferDialog(e.id); } }, '赠予') : null,
        h('button', { type: 'button', class: 'btn small', onclick: function () { editItemDialog(e.id); } }, '修改'),
        h('button', { type: 'button', class: 'btn small danger', onclick: function () { deleteDialog(e.id); } }, '删除'));
    }
    return h('article', {
      class: 'inv-card cat-' + def.category + (carried ? ' is-carried' : '') + (locked ? ' is-locked' : ''),
      'data-entry': e.id, 'data-def': e.defId, inert: locked ? '' : null, 'aria-disabled': locked ? 'true' : null
    },
      h('div', { class: 'inv-card-head' },
        h('span', { class: 'item-name' }, def.name),
        C.isStackable(def) ? h('span', { class: 'qty' }, '×' + e.qty) : null),
      h('div', { class: 'inv-card-meta' }, categoryName(def.category) + ' · 每件 ' + C.fmtUnits(def.capacityTicks) + ' · 合计 ' + C.fmtUnits(C.entryTicks(e, state.customItems, state.rules)) + ' 单位'),
      carried ? h('div', null, chip('携带中 ' + (C.isStackable(def) ? carried + ' 件' : ''), 'ok')) : null,
      def.unknown ? chip('未知物品', 'danger') : null,
      instanceLine(e, def),
      h('p', { class: 'small item-effect' }, def.effectText),
      (def.pending || []).length ? h('div', { class: 'pending-row' }, def.pending.map(function (p) { return U.pendingTag(p); })) : null,
      e.remark ? h('p', { class: 'small' }, '备注：' + e.remark) : null,
      hoardable ? h('button', { type: 'button', class: 'btn small', onclick: function () { hoard(e.id); } }, '囤积者：秘密消耗1件记进度') : null,
      actions);
  }

  /** 挑选携带时卡片底部：可叠加的用 −／＋，其余用「带上／已带上」。超出上限的按钮不可点。 */
  function carryPicker(e, def, q) {
    var lo = state.loadout;
    var room = C.isInt(lo.limitTicks) ? lo.limitTicks - C.loadoutTicks(state) : Infinity;
    var fits = (def.capacityTicks || 0) <= room;
    if (C.isStackable(def)) {
      return h('div', { class: 'card-actions carry-pick' },
        h('button', { type: 'button', class: 'btn small', 'aria-label': '少带一件' + def.name, disabled: q <= 0, onclick: function () { setCarry(e.id, q - 1); } }, '−'),
        h('span', { class: 'qty' }, '带 ' + q),
        h('button', { type: 'button', class: 'btn small' + (q ? '' : ' primary'), 'aria-label': '多带一件' + def.name, disabled: q >= e.qty || !fits, onclick: function () { setCarry(e.id, q + 1); } }, '＋'),
        !fits && q < e.qty ? h('span', { class: 'muted small' }, '超出上限') : null);
    }
    return h('div', { class: 'card-actions carry-pick' },
      q ? h('button', { type: 'button', class: 'btn small primary', 'aria-pressed': 'true', onclick: function () { setCarry(e.id, 0); } }, '✓ 已带上')
        : h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', disabled: !fits, onclick: function () { setCarry(e.id, 1); } }, '带上'),
      !q && !fits ? h('span', { class: 'muted small' }, '超出上限') : null);
  }

  function carriedEntries() {
    var out = [];
    (state.loadout ? state.loadout.items : []).forEach(function (r) {
      var e = C.findEntry(state.inventory, r.entryId);
      if (e) for (var i = 0; i < r.qty; i++) out.push(e);
    });
    return out;
  }

  /** 携带面板：挑选时显示上限与确认；携带中显示战斗力与「结束携带」。 */
  function carryPanel(mode) {
    var lo = state.loadout;
    var usedTicks = C.loadoutTicks(state);
    var limit = lo.limitTicks;
    var over = C.isInt(limit) && usedTicks > limit;
    var what = (lo.context === 'event' ? '事件' : '守夜') + (lo.label ? '「' + lo.label + '」' : '');
    var cs = C.combatSummary(state.hp, carriedEntries(), state.customItems, tempAttack());
    var names = lo.items.map(function (r) { var e = C.findEntry(state.inventory, r.entryId); return e ? defOf(e).name + (r.qty > 1 ? '×' + r.qty : '') : ''; }).filter(Boolean);
    var head = h('div', { class: 'carry-head' },
      h('div', null,
        h('div', { class: 'carry-title' }, mode === 'selecting' ? '挑选携带 · ' + what : '携带中 · ' + what),
        h('div', { class: 'carry-amount' }, h('b', null, C.fmtUnits(usedTicks)), ' / ', limit == null ? U.pendingTag('不限（上限未设）') : h('b', null, C.fmtUnits(limit)), ' 单位')),
      limit != null ? U.meter(usedTicks, limit || 1, over ? 'warning' : 'ok', '携带占位') : null);
    if (mode === 'selecting') {
      return h('section', { class: 'card carry-panel selecting' },
        head,
        h('p', { class: 'small carry-help' }, '在下面的物品卡上点「带上」。最多 ', h('b', null, limit == null ? '不限' : C.fmtUnits(limit) + ' 单位'), '，超出的物品选不上；上限可在「设置上限」里改（以主持人或事件规定为准）。'),
        over ? h('div', { class: 'callout risk' }, '已选超出上限：请减少后再确认。') : null,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', disabled: !lo.items.length || over, onclick: confirmCarry }, '确认携带' + (names.length ? '（' + names.length + ' 种）' : '')),
          h('button', { type: 'button', class: 'btn', onclick: carryLimitDialog }, '设置上限'),
          h('button', { type: 'button', class: 'btn ghost', onclick: function () {
            commit('取消携带', function (s) { s.loadout = null; log(s, '取消携带模式'); }, { undo: false });
          } }, '取消')));
    }
    return h('section', { class: 'card carry-panel carrying' },
      head,
      h('p', { class: 'small' }, '带着：', h('b', null, names.join('、') || '（没有物品）'), h('span', { class: 'carry-help' }, '。主持人宣布结果后，直接在高亮的物品卡上「删除」或「修改」；其他物品暂时锁定。')),
      h('p', { class: 'small carry-help' }, '战斗力：基础 ', h('b', null, String(cs.base)),
        cs.weapons.length ? '；' + cs.weapons.map(function (w) { return w.name + (w.bonus ? ' +' + w.bonus : '（' + w.note + '）'); }).join('、') : '；未带武器',
        cs.temp ? '；临时 +' + cs.temp : '',
        cs.multiple ? h('span', null, '；合计 ', h('b', null, cs.bestOnly + '～' + cs.stacked), '（多武器是否叠加待定）') : h('span', null, '；合计 ', h('b', null, String(cs.stacked)))),
      over ? h('div', { class: 'callout risk' }, '携带超出上限 ' + C.fmtUnits(usedTicks - limit) + ' 单位：只警告，由主持人裁定。') : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: endCarry }, '结束携带（返回）'),
        h('button', { type: 'button', class: 'btn', onclick: function () {
          commit('重新挑选携带', function (s) { s.loadout.confirmed = false; log(s, '重新挑选携带物品'); });
        } }, '重新挑选')));
  }

  function carrySetupDialog() {
    var context = 'event';
    var label = h('input', { type: 'text', placeholder: '可选：事件名或第几夜' });
    var limit = h('input', { type: 'number', class: 'num', min: 0, step: 0.5 });
    var segHost = h('div');
    function ruleLimit(ctx) {
      var v = ctx === 'event' ? state.rules.eventCarryTicks : state.rules.watchCarryTicks;
      return C.isInt(v) ? v : DEFAULT_CARRY_TICKS;
    }
    function draw() {
      U.clear(segHost).appendChild(U.segmented([['event', '事件'], ['watch', '守夜']], context, function (v) { context = v; limit.value = ruleLimit(v) / 2; draw(); }));
    }
    draw();
    limit.value = ruleLimit(context) / 2;
    U.modal({
      title: '进入携带模式',
      body: h('div', { class: 'stack' },
        U.field('带去哪里', segHost),
        U.field('说明', label),
        U.field('携带上限（单位）', limit, '默认 2 单位；以主持人或具体事件的规定为准'),
        h('p', { class: 'muted small' }, '携带只是给库存里的物品做标记，不复制物品。确认后其他物品暂时锁定，结束携带时解锁。')),
      actions: [{ label: '取消', value: false }, { label: '开始挑选', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = U.parseNumber(limit.value, true);
      if (Number.isNaN(n) || (n != null && (n < 0 || Math.round(n * 2) !== n * 2))) { U.toast('上限需为 0.5 的倍数或留空', 'warn'); return; }
      commit('准备携带', function (s) {
        s.loadout = { context: context, label: label.value.trim(), day: today(), limitTicks: n == null ? null : Math.round(n * 2), items: [], confirmed: false };
        log(s, '开始挑选' + (context === 'event' ? '事件' : '守夜') + '携带（上限 ' + (n == null ? '不限' : n + ' 单位') + '）');
      }, { undo: false });
      ui.filter = 'all';
    });
  }

  function carryLimitDialog() {
    var lo = state.loadout;
    var input = h('input', { type: 'number', class: 'num', min: 0, step: 0.5, value: lo.limitTicks == null ? '' : lo.limitTicks / 2, autofocus: true });
    U.modal({
      title: '携带上限',
      body: U.field('上限（单位，留空＝不限）', input, '以主持人或具体事件的规定为准'),
      actions: [{ label: '取消', value: false }, { label: '设定', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = U.parseNumber(input.value, true);
      if (Number.isNaN(n) || (n != null && (n < 0 || Math.round(n * 2) !== n * 2))) { U.toast('上限需为 0.5 的倍数或留空', 'warn'); return; }
      commit('修改携带上限', function (s) { s.loadout.limitTicks = n == null ? null : Math.round(n * 2); log(s, '携带上限：' + (n == null ? '不限' : n + ' 单位')); });
    });
  }

  function confirmCarry() {
    commit('确认携带', function (s) {
      var lo = s.loadout;
      var names = lo.items.map(function (r) { var e = C.findEntry(s.inventory, r.entryId); return e ? C.getDef(e.defId, s.customItems).name + '×' + r.qty : ''; }).filter(Boolean);
      lo.confirmed = true;
      log(s, '确认携带（' + (lo.context === 'event' ? '事件' : '守夜') + '）：' + names.join('、'));
    });
    U.toast('已确认携带：其他物品暂时锁定', 'ok');
  }

  function endCarry() {
    U.confirmBox('结束携带？', '只清除携带标记、解锁其他物品。事件中用掉或丢失的物品，请先在高亮的卡片上删除或修改。', '结束携带').then(function (ok) {
      if (!ok) return;
      commit('结束携带', function (s) { log(s, '结束携带（' + (s.loadout.context === 'event' ? '事件' : '守夜') + '），物品不重复添加'); s.loadout = null; });
    });
  }

  function setCarry(entryId, q) {
    commit('调整携带', function (s) {
      var e = C.findEntry(s.inventory, entryId);
      if (!e) return false;
      var n = Math.max(0, Math.min(q, e.qty));
      var before = s.loadout.items.filter(function (r) { return r.entryId === entryId; })[0];
      var delta = (n - (before ? before.qty : 0)) * (C.getDef(e.defId, s.customItems).capacityTicks || 0);
      if (delta > 0 && C.isInt(s.loadout.limitTicks) && C.loadoutTicks(s) + delta > s.loadout.limitTicks) throw new Error('超出携带上限 ' + C.fmtUnits(s.loadout.limitTicks) + ' 单位');
      s.loadout.items = s.loadout.items.filter(function (r) { return r.entryId !== entryId; });
      if (n > 0) s.loadout.items.push({ entryId: entryId, qty: n });
    }, { undo: false });
  }

  /** 删除：从库存移除，不生成交接文本。携带中删除的就是带出去的那几件。 */
  function deleteDialog(entryId) {
    var e = C.findEntry(state.inventory, entryId);
    if (!e) return;
    var def = defOf(e);
    var stack = C.isStackable(def) && e.qty > 1;
    var carried = carriedQty(entryId);
    var qty = h('input', { type: 'number', class: 'num', min: 1, max: e.qty, value: stack && carried ? Math.min(carried, e.qty) : 1 });
    U.modal({
      title: '删除' + def.name,
      body: h('div', { class: 'stack' },
        stack ? U.field('删除数量（现有 ' + e.qty + ' 件）', h('div', { class: 'row tight' }, qty,
          h('button', { type: 'button', class: 'btn small', onclick: function () { qty.value = e.qty; } }, '全部'))) : null,
        h('p', null, '从你的库存移除，可以用顶部的「撤销」恢复。'),
        h('p', { class: 'muted small' }, '交给别人或交公请用「赠予／交公」，那样会生成给对方的交接文本。')),
      actions: [{ label: '取消', value: false }, { label: '删除', kind: 'danger', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = stack ? parseInt(qty.value, 10) : e.qty;
      if (!C.isInt(n) || n < 1 || n > e.qty) { U.toast('数量需在 1～' + e.qty + ' 之间', 'warn'); return; }
      commit('删除物品', function (s) {
        C.removeQty(s.inventory, entryId, n);
        var row = s.loadout ? s.loadout.items.filter(function (r) { return r.entryId === entryId; })[0] : null;
        if (row) row.qty = Math.max(0, row.qty - n);
        syncLoadout(s);
        log(s, '删除：' + def.name + '×' + n + (row ? '（携带中）' : ''));
      });
    });
  }

  function instanceLine(e, def) {
    if (def.instance === 'uses') return h('p', null, '剩余 ', h('b', null, e.uses + ' / ' + (state.rules.itemUses[def.id] || def.defaultUses)), ' 次（用完消失；未用完整件仍占 ' + C.fmtUnits(def.capacityTicks) + '）');
    if (def.instance === 'water') return h('p', null, '储水 ', h('b', null, (e.water || 0) + ' / ' + (def.maxWater || 2)), ' 份');
    if (def.instance === 'condition') return h('p', null, '状态：', h('b', { class: e.condition === 'damaged' ? 'risk-text' : 'ok-text' }, e.condition === 'damaged' ? '破损' : '完好'));
    if (def.instance === 'notes') {
      return h('div', null,
        h('p', null, '笔记 ', h('b', null, String(e.notes.length)), ' 条（每条1分）· 状态：', h('b', { class: e.condition === 'damaged' ? 'risk-text' : 'ok-text' }, e.condition === 'damaged' ? '损坏' : '完好')),
        e.notes.length ? h('ol', { class: 'notes' }, e.notes.map(function (n) { return h('li', null, n.text, h('span', { class: 'muted small' }, ' · 第' + n.day + '天')); })) : null);
    }
    return null;
  }

  function itemOptions() {
    var opts = [];
    C.CATEGORIES.forEach(function (cat) {
      C.allDefs(state.customItems).filter(function (d) { return d.category === cat.id; }).forEach(function (d) {
        opts.push([d.id, cat.name + ' · ' + d.name + '（占' + C.fmtUnits(d.capacityTicks) + '）']);
      });
    });
    return opts;
  }

  function addItemDialog() {
    var defId = 'bread';
    var qty = h('input', { type: 'number', min: 1, value: 1, class: 'num' });
    var remark = h('input', { type: 'text', placeholder: '可选，例如：主持人第2天发放' });
    var extraHost = h('div');
    var uses = h('input', { type: 'number', min: 1, class: 'num' });
    var water = h('input', { type: 'number', min: 0, max: 2, class: 'num', value: 0 });
    var damaged = h('input', { type: 'checkbox' });
    function drawExtra() {
      var def = C.getDef(defId, state.customItems);
      U.clear(extraHost);
      extraHost.appendChild(h('p', { class: 'small muted' }, def.effectText));
      if (def.instance === 'uses') { uses.value = state.rules.itemUses[def.id] || def.defaultUses; extraHost.appendChild(U.field('每件剩余次数', uses)); }
      if (def.instance === 'water') extraHost.appendChild(U.field('每个水壶储水（0～' + (def.maxWater || 2) + '）', water));
      if (def.instance === 'condition' || def.instance === 'notes') extraHost.appendChild(h('label', { class: 'check' }, damaged, def.instance === 'notes' ? '已损坏' : '破损'));
    }
    drawExtra();
    var sel = U.select(itemOptions(), defId, function (v) { defId = v; drawExtra(); });
    U.modal({
      title: '添加物品',
      body: h('div', { class: 'stack' }, U.field('物品', sel), U.field('数量（件）', qty), extraHost, U.field('备注', remark),
        h('p', { class: 'muted small' }, '主持人端不会自动发物资：拿到什么就在这里记什么。超出容量只警告。')),
      actions: [{ label: '取消', value: false }, { label: '添加', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = parseInt(qty.value, 10);
      if (!(n > 0)) { U.toast('数量必须是正整数', 'warn'); return; }
      var def = C.getDef(defId, state.customItems);
      var fields = null;
      if (def.instance === 'uses') {
        var u = parseInt(uses.value, 10);
        if (!(u > 0)) { U.toast('剩余次数需为正整数', 'warn'); return; }
        fields = { uses: u };
      } else if (def.instance === 'water') {
        var w = parseInt(water.value, 10);
        if (!(w >= 0 && w <= (def.maxWater || 2))) { U.toast('储水需在 0～' + (def.maxWater || 2) + ' 之间', 'warn'); return; }
        fields = { water: w };
      } else if (def.instance === 'condition' || def.instance === 'notes') {
        fields = { condition: damaged.checked ? 'damaged' : 'intact' };
      }
      commit('添加物品', function (s) {
        C.addItem(s.inventory, defId, n, { customItems: s.customItems, rules: s.rules, fields: fields, remark: remark.value.trim() || undefined });
        log(s, '添加物品：' + def.name + '×' + n + (remark.value.trim() ? '（' + remark.value.trim() + '）' : ''));
      });
      var after = invTicks();
      if (C.isInt(state.rules.inventoryCapacityTicks) && after > state.rules.inventoryCapacityTicks) U.toast('库存已超出上限（只警告）', 'warn');
    });
  }

  /**
   * 添加自定义物品：新名字＝登记定义并加入库存；已有同名物品＝直接按原有定义加入库存，
   * 不会重复登记，也不会因为同名报错。
   */
  function customItemDialog() {
    var nameI = h('input', { type: 'text', placeholder: '物品名称', autofocus: true });
    var catSel = U.select(C.CATEGORIES.map(function (c) { return [c.id, c.name]; }), 'custom', function () {});
    var units = h('input', { type: 'number', class: 'num', min: 0, step: 0.5, value: 0.5 });
    var effect = h('input', { type: 'text', placeholder: '效果（按主持人说明）' });
    var qty = h('input', { type: 'number', class: 'num', min: 1, value: 1 });
    var remark = h('input', { type: 'text', placeholder: '可选' });
    var hint = h('p', { class: 'callout info small', hidden: true });
    var newFields = h('div', { class: 'stack' }, U.field('分类', catSel), U.field('占位（单位）', units), U.field('效果', effect));
    function existing() { return C.findDefByName(nameI.value.trim(), state.customItems); }
    nameI.addEventListener('input', function () {
      var d = existing();
      hint.hidden = !d;
      newFields.hidden = !!d;
      if (d) hint.textContent = U.T('已有同名物品「' + d.name + '」（' + (d.ruleStatus === 'custom' ? '自定义' : '内置') + '，每件占 ' + C.fmtUnits(d.capacityTicks) + ' 单位）：会按原有定义加入库存。');
    });
    U.modal({
      title: '添加自定义物品',
      body: h('div', { class: 'stack' }, U.field('名称', nameI), hint, newFields,
        h('div', { class: 'grid2' }, U.field('数量（件）', qty), U.field('备注', remark)),
        h('p', { class: 'muted small' }, '主持人也可以把自定义物品放进规则包，你在「存档」页导入即可。')),
      actions: [{ label: '取消', value: false }, { label: '加入库存', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var name = nameI.value.trim();
      var count = parseInt(qty.value, 10);
      var n = U.parseNumber(units.value, true);
      var found = existing();
      if (!name) { U.toast('请输入名称', 'warn'); return; }
      if (!(count > 0)) { U.toast('数量必须是正整数', 'warn'); return; }
      if (!found && (n == null || Number.isNaN(n) || n < 0 || Math.round(n * 2) !== n * 2)) { U.toast('占位需为 0.5 的倍数', 'warn'); return; }
      var note = remark.value.trim() || undefined;
      commit('添加自定义物品', function (s) {
        var def = found;
        if (!def) {
          def = C.newCustomItem({ name: name, category: catSel.value, capacityTicks: Math.round(n * 2), effectText: effect.value });
          s.customItems.push(def);
          log(s, '新建自定义物品：' + def.name + '（每件占 ' + C.fmtUnits(def.capacityTicks) + ' 单位）');
        }
        C.addItem(s.inventory, def.id, count, { customItems: s.customItems, rules: s.rules, remark: note });
        log(s, '添加物品：' + def.name + '×' + count + (note ? '（' + note + '）' : ''));
      });
      U.toast(found ? '已按原有的「' + found.name + '」加入库存 ×' + count : '已创建并加入库存：' + name + ' ×' + count, 'ok');
      ui.filter = 'all';
      render();
    });
  }

  function editItemDialog(entryId) {
    var e = C.findEntry(state.inventory, entryId);
    if (!e) return;
    var def = defOf(e);
    var stack = C.isStackable(def);
    var qty = h('input', { type: 'number', min: 0, class: 'num', value: e.qty });
    var uses = h('input', { type: 'number', min: 0, class: 'num', value: e.uses });
    var water = h('input', { type: 'number', min: 0, max: def.maxWater || 2, class: 'num', value: e.water || 0 });
    var cond = e.condition || 'intact';
    var condHost = h('div');
    function drawCond() { U.clear(condHost).appendChild(U.segmented([['intact', '完好'], ['damaged', def.instance === 'notes' ? '损坏' : '破损']], cond, function (v) { cond = v; drawCond(); })); }
    drawCond();
    var remark = h('input', { type: 'text', value: e.remark || '' });
    var notes = (e.notes || []).map(function (n) { return Object.assign({}, n); });
    var notesHost = h('div');
    function drawNotes() {
      U.clear(notesHost).appendChild(h('div', { class: 'stack' },
        notes.map(function (n, i) {
          var t = h('input', { type: 'text', value: n.text });
          t.addEventListener('input', function () { n.text = t.value; });
          return h('div', { class: 'row' }, t, h('span', { class: 'muted small' }, '第' + n.day + '天'), h('button', { type: 'button', class: 'btn small', onclick: function () { notes.splice(i, 1); drawNotes(); } }, '删除'));
        }),
        h('button', { type: 'button', class: 'btn small', onclick: function () { notes.push({ text: '', day: today() }); drawNotes(); } }, '+ 添加笔记')));
    }
    if (def.instance === 'notes') drawNotes();
    U.modal({
      title: '修改：' + def.name,
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, '手动覆盖用于纠错，会记入日志。'),
        stack ? U.field('数量（0＝删除）', qty) : null,
        def.instance === 'uses' ? U.field('剩余次数（0＝用完，删除）', uses) : null,
        def.instance === 'water' ? U.field('储水（0～' + (def.maxWater || 2) + '）', water) : null,
        def.instance === 'condition' || def.instance === 'notes' ? U.field('状态', condHost) : null,
        def.instance === 'notes' ? U.field('地图笔记', notesHost) : null,
        U.field('备注', remark),
        stack ? null : h('button', {
          type: 'button', class: 'btn small danger', onclick: function () {
            U.confirmBox('删除这件物品？', describe(e), '删除', 'danger').then(function (ok) {
              if (!ok) return;
              commit('删除物品', function (s) {
                C.removeQty(s.inventory, entryId, 1);
                syncLoadout(s);
                log(s, '删除物品：' + describe(e));
              });
            });
          }
        }, '删除这件')),
      actions: [{ label: '取消', value: false }, { label: '保存', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = parseInt(qty.value, 10);
      var u = parseInt(uses.value, 10);
      var w = parseInt(water.value, 10);
      if (stack && !(n >= 0)) { U.toast('数量不能是负数', 'warn'); return; }
      if (def.instance === 'uses' && !(u >= 0)) { U.toast('剩余次数不能是负数', 'warn'); return; }
      if (def.instance === 'water' && !(w >= 0 && w <= (def.maxWater || 2))) { U.toast('储水需在 0～' + (def.maxWater || 2) + ' 之间', 'warn'); return; }
      commit('修改物品', function (s) {
        var x = C.findEntry(s.inventory, entryId);
        var before = describe(x);
        x.remark = remark.value.trim() || undefined;
        if (!x.remark) delete x.remark;
        if (def.instance === 'water') x.water = w;
        if (def.instance === 'condition' || def.instance === 'notes') x.condition = cond;
        if (def.instance === 'notes') x.notes = notes.filter(function (k) { return k.text.trim(); });
        if (def.instance === 'uses') {
          x.uses = u;
          if (u === 0) s.inventory = s.inventory.filter(function (y) { return y.id !== entryId; });
        }
        if (stack) {
          if (n === 0) s.inventory = s.inventory.filter(function (y) { return y.id !== entryId; });
          else x.qty = n;
        }
        syncLoadout(s);
        log(s, '手动修改：' + before + ' → ' + (C.findEntry(s.inventory, entryId) ? describe(x) : '已删除'));
      });
    });
  }

  function hoard(entryId) {
    commit('囤积者进度', function (s) {
      var e = C.findEntry(s.inventory, entryId);
      if (!e || e.qty < 3) throw new Error('需要持有3件相同物品');
      var name = defOf(e).name;
      C.removeQty(s.inventory, entryId, 1);
      syncLoadout(s);
      s.taskProgress.count += 1;
      log(s, '囤积者：秘密消耗1件' + name + '，进度 ' + s.taskProgress.count + '/3');
    });
  }

  // ---------------------------------------------------------------- 赠予与交公

  function transferDialog(entryId) {
    var e = C.findEntry(state.inventory, entryId);
    if (!e) return;
    var def = defOf(e);
    var mode = 'gift';
    var modeHost = h('div');
    var who = h('input', { type: 'text', placeholder: '对方名字' });
    var qty = h('input', { type: 'number', class: 'num', min: 1, max: e.qty, value: 1 });
    // 在联机房间里：从主持人的名单里选人，对方已加入房间时直接送到他的库存
    var targets = netTargets();
    var target = targets && targets.length ? targets[0].id : '';
    var whoHost = h('div', { class: 'stack' });
    var hint = h('p', { class: 'muted small' });
    function direct() {
      return mode === 'gift' ? netCanReach(target) : netLive();
    }
    function drawHint() {
      hint.textContent = U.T(direct()
        ? (mode === 'gift' ? '对方已加入联机房间：从你的库存扣除，直接放进对方的库存。' : '你在联机房间里：从你的库存扣除，直接放进主持人的公共池。')
        : '会从你的库存扣除并生成交接文本：对方（或主持人）需要手动添加，不会自动同步。');
    }
    function drawWho() {
      U.clear(whoHost);
      if (targets && targets.length) {
        whoHost.appendChild(U.select(targets.map(function (p) { return [p.id, p.name + (p.joined ? '' : '（没加入房间）')]; }).concat([['', '名单外（手动填写）']]), target, function (v) { target = v; drawWho(); }));
        if (!target) whoHost.appendChild(who);
      } else {
        whoHost.appendChild(who);
      }
      drawHint();
    }
    function drawMode() {
      U.clear(modeHost).appendChild(U.segmented([['gift', '赠予／交易给玩家'], ['pool', '交给公共池']], mode, function (v) { mode = v; drawMode(); }));
      drawHint();
    }
    drawWho();
    drawMode();
    U.modal({
      title: '转出：' + describe(e),
      body: h('div', { class: 'stack' }, modeHost, U.field('对方（赠予时填写）', whoHost), C.isStackable(def) ? U.field('数量（现有 ' + e.qty + '）', qty) : null, hint),
      actions: [{ label: '取消', value: false }, { label: netJoined() ? '转出' : '转出并生成文本', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = C.isStackable(def) ? parseInt(qty.value, 10) : 1;
      if (!(n > 0) || n > e.qty) { U.toast('数量需在 1～' + e.qty + ' 之间', 'warn'); return; }
      var toName = mode === 'gift' ? (target && targets ? snapName(target) : who.value.trim()) : '';
      if (mode === 'gift' && !toName) { U.toast('请填写对方名字', 'warn'); return; }
      var viaNet = direct();
      var id = viaNet ? ShelterNet.uid('m') : null;
      var packed = null;
      var text = '';
      var fn = function (s) {
        var x = C.findEntry(s.inventory, entryId);
        if (!x || x.qty < n) throw new Error('库存里已经没有这么多了');
        var desc = C.isStackable(def) ? def.name + '×' + n + (x.remark ? '〔' + x.remark + '〕' : '') : describe(x);
        var notes = def.instance === 'notes' && x.notes.length ? '（地图笔记：' + x.notes.map(function (k) { return k.text; }).join('；') + '）' : '';
        packed = C.packItem(x, n, s.customItems);
        C.removeQty(s.inventory, entryId, n);
        syncLoadout(s);
        if (viaNet) {
          recordOutgoing(s, id, mode === 'gift' ? 'gift' : 'deposit', mode === 'gift' ? target : 'host', toName, [packed]);
          log(s, (mode === 'gift' ? '交给 ' + toName : '交给公共池') + '：' + desc + '（通过联机房间）');
        } else if (mode === 'gift') {
          text = handoff(s, 'gift', '【赠予／交易·第' + today() + '天】' + myName() + ' 把「' + desc + '」交给了 ' + toName + notes + '。请 ' + toName + ' 在玩家页「库存」手动添加。');
          log(s, '转出给 ' + toName + '：' + desc);
        } else {
          text = handoff(s, 'pool', '【交公·第' + today() + '天】' + myName() + ' 交出「' + desc + '」' + notes + '。请主持人在公共池手动加入。');
          log(s, '交给公共池：' + desc);
        }
      };
      // 直接送出的不能撤销（对方已经收到了）
      var done = viaNet ? netCommit(mode === 'gift' ? '赠予（联机）' : '交公（联机）', fn) : commit(mode === 'gift' ? '赠予' : '交公', fn);
      if (!done) return;
      if (viaNet) {
        netPostItems(id, mode === 'gift' ? 'gift' : 'deposit', target, [packed]);
        U.toast(mode === 'gift' ? '已交给房间：' + toName + ' 的库存会自动加上' : '已交给房间：主持人页自动加入公共池', 'ok');
      } else {
        showHandoff(text);
      }
    });
  }

  // ---------------------------------------------------------------- 使用物品

  function useItem(entryId) {
    var e = C.findEntry(state.inventory, entryId);
    if (!e) return;
    var def = defOf(e);
    var handlers = { drink: useDrink, energyDrink: useDrink, eat: useEat, eatDrink: useEat, eatMulti: useEat, bandage: useBandage, medkit: useMedkit, map: useMap, canteen: useCanteen, liquor: useLiquor, vest: useVest, record: useRecord };
    (handlers[def.use] || useRecord)(e, def);
  }

  function thirstPicker(holder) {
    var host = h('div');
    function draw() { U.clear(host).appendChild(U.segmented(THIRST.map(function (t) { return [t, t]; }), holder.thirst, function (v) { holder.thirst = v; draw(); })); }
    draw();
    return host;
  }

  function hungerInput() {
    return h('input', { type: 'number', class: 'num', placeholder: '不改', step: 'any' });
  }

  function useDrink(e, def) {
    var holder = { thirst: state.thirst };
    U.modal({
      title: '饮用：' + def.name,
      body: h('div', { class: 'stack' },
        h('p', null, '消耗 1 件。补水幅度待定——请按主持人裁定手动设置口渴状态：'),
        thirstPicker(holder),
        def.use === 'energyDrink' ? h('div', { class: 'callout ok' }, '已确认：下一次行动判定视为充盈（实际饥饿值不变）。会记录为临时效果。') : null),
      actions: [{ label: '取消', value: false }, { label: '饮用', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      commit('饮用' + def.name, function (s) {
        C.removeQty(s.inventory, e.id, 1);
        syncLoadout(s);
        var t0 = s.thirst;
        s.thirst = holder.thirst;
        if (def.use === 'energyDrink') s.temporaryEffects.push({ id: C.uid('fx'), text: '下一次行动判定视为充盈（功能饮料）', day: today(), attack: null });
        log(s, '饮用' + def.name + '：口渴 ' + t0 + ' → ' + s.thirst + (def.use === 'energyDrink' ? '；下一次行动视为充盈' : ''));
      });
    });
  }

  function useEat(e, def) {
    var amount = hungerInput();
    var holder = { thirst: state.thirst };
    var multi = def.use === 'eatMulti';
    U.modal({
      title: (multi ? '吃一次：' : '食用：') + def.name,
      body: h('div', { class: 'stack' },
        multi ? h('p', null, '剩余 ' + e.uses + ' 次 → 用后 ' + (e.uses - 1) + ' 次' + (e.uses - 1 === 0 ? '（用完消失）' : '') + '。每次约等于一份普通食物／面包。') : h('p', null, '消耗 1 件。'),
        U.field('饥饿值变化（恢复量待定：按主持人裁定手动填写，留空＝不改）', amount),
        def.use === 'eatDrink' ? U.field('口渴（补水幅度待定，手动设置）', thirstPicker(holder)) : null,
        h('p', { class: 'muted small' }, '提示：事件开启后不能通过临时进食提升本次状态；携带的食物可按事件规则消耗。')),
      actions: [{ label: '取消', value: false }, { label: '确定', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = U.parseNumber(amount.value, true);
      if (Number.isNaN(n)) { U.toast('饥饿值变化需为数字或留空', 'warn'); return; }
      commit('食用' + def.name, function (s) {
        var x = C.findEntry(s.inventory, e.id);
        if (multi) {
          x.uses -= 1;
          if (x.uses <= 0) s.inventory = s.inventory.filter(function (y) { return y.id !== e.id; });
        } else {
          C.removeQty(s.inventory, e.id, 1);
        }
        syncLoadout(s);
        var parts = [];
        if (n != null) {
          var old = s.hunger;
          s.hunger = (C.isNum(old) ? old : 0) + n;
          parts.push('饥饿值 ' + (old == null ? '未记录' : old) + ' → ' + s.hunger);
        } else {
          parts.push('饥饿值未改（恢复量待定）');
        }
        if (def.use === 'eatDrink' && holder.thirst !== s.thirst) { parts.push('口渴 ' + s.thirst + ' → ' + holder.thirst); s.thirst = holder.thirst; }
        log(s, (multi ? '吃一次' : '食用') + def.name + (multi ? '（剩' + Math.max(0, x.uses) + '次）' : '') + '：' + parts.join('；'));
      });
    });
  }

  function targetPicker(holder) {
    var host = h('div');
    // 在联机房间里：从主持人的名单里选人；对方已加入房间时，治疗在对方页面自动生效
    var targets = netTargets();
    if (targets && targets.length && holder.pid === undefined) { holder.pid = targets[0].id; holder.who = targets[0].name; }
    var who = h('input', { type: 'text', placeholder: '对方名字', value: holder.pid ? '' : holder.who || '' });
    who.addEventListener('input', function () { holder.who = who.value; });
    function draw() {
      var other = null;
      if (holder.target === 'other') {
        other = targets && targets.length ? h('div', { class: 'stack' },
          U.select(targets.map(function (p) { return [p.id, p.name + (p.joined ? '（已加入房间：对方页面自动生效）' : '（没加入房间）')]; }).concat([['', '名单外（手动填写）']]), holder.pid || '', function (v) {
            holder.pid = v || null;
            holder.who = v ? snapName(v) : who.value;
            draw();
          }),
          holder.pid ? null : who) : who;
      }
      U.clear(host).appendChild(h('div', { class: 'stack' },
        U.segmented([['self', '自己'], ['other', '他人']], holder.target, function (v) { holder.target = v; draw(); }),
        other));
    }
    draw();
    return host;
  }

  function useBandage(e, def) {
    var holder = { target: 'self', effect: 'heal', who: '' };
    var effHost = h('div');
    var bleeds = state.statuses.filter(function (st) { return st.statusId === 'bleeding'; });
    function drawEff() { U.clear(effHost).appendChild(U.segmented([['heal', '恢复1生命'], ['stop', '止血']], holder.effect, function (v) { holder.effect = v; drawEff(); })); }
    drawEff();
    U.modal({
      title: '使用绷带',
      body: h('div', { class: 'stack' }, U.field('对象', targetPicker(holder)), U.field('效果（二选一，已确认）', effHost),
        bleeds.length ? null : h('p', { class: 'muted small' }, '你目前没有流血伤口：对自己只能选「恢复1生命」。')),
      actions: [{ label: '取消', value: false }, { label: '使用', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      if (holder.target === 'other' && !holder.who.trim()) { U.toast('请填写对方名字', 'warn'); return; }
      if (holder.target === 'self' && holder.effect === 'stop' && !bleeds.length) { U.toast('没有可以止血的伤口', 'warn'); return; }
      var text = '';
      var direct = holder.target === 'other' && netCanReach(holder.pid);
      var fn = function (s) {
        C.removeQty(s.inventory, e.id, 1);
        syncLoadout(s);
        if (holder.target === 'self') {
          if (holder.effect === 'heal') { s.hp += 1; log(s, '绷带：恢复1生命 → ' + s.hp); }
          else {
            var b = s.statuses.find(function (st) { return st.statusId === 'bleeding'; });
            s.statuses = s.statuses.filter(function (st) { return st.id !== b.id; });
            log(s, '绷带：止血（清除一处流血伤口）');
          }
        } else if (direct) {
          log(s, '对 ' + holder.who.trim() + ' 使用绷带（' + (holder.effect === 'heal' ? '恢复1生命' : '止血') + '）：通过联机房间，对方页面自动生效');
        } else {
          text = handoff(s, 'heal', '【治疗·第' + today() + '天】' + myName() + ' 对 ' + holder.who.trim() + ' 使用了绷带：' + (holder.effect === 'heal' ? '恢复1生命' : '止血（清除一处流血伤口）') + '。请 ' + holder.who.trim() + ' 在玩家页手动修改。');
          log(s, '对 ' + holder.who.trim() + ' 使用绷带（' + (holder.effect === 'heal' ? '恢复1生命' : '止血') + '）');
        }
      };
      // 直接送到对方页面的不能撤销（对方已经生效了）
      var ok = direct ? netCommit('使用绷带', fn) : commit('使用绷带', fn);
      if (ok && direct) {
        netSendHeal(holder.pid, holder.effect === 'heal' ? 'bandage-heal' : 'bandage-stop');
        U.toast('已交给房间：' + holder.who.trim() + ' 的页面会自动生效', 'ok');
      }
      if (text) showHandoff(text, '治疗他人：请对方手动修改');
    });
  }

  function useMedkit(e) {
    var holder = { target: 'self', who: '' };
    var checks = {};
    var doctor = state.rules.professionsEnabled && state.professionId === 'doctor';
    var doctorBox = h('input', { type: 'checkbox', checked: doctor });
    var statusList = h('div', { class: 'stack' }, state.statuses.length ? state.statuses.map(function (st) {
      var def = st.statusId ? C.getStatusDef(st.statusId) : null;
      var injury = def ? def.injury : null;
      checks[st.id] = injury === true;
      var box = h('input', { type: 'checkbox', checked: injury === true, onchange: function () { checks[st.id] = box.checked; } });
      return h('label', { class: 'check' }, box, st.name, injury === true ? chip('伤病类', 'ok') : U.pendingTag('是否属伤病类待裁定'));
    }) : h('p', { class: 'muted small' }, '你没有负面状态。'));
    U.modal({
      title: '使用医疗箱',
      body: h('div', { class: 'stack' },
        U.field('对象', targetPicker(holder)),
        h('p', null, '已确认：清除伤病类负面状态，并恢复2生命；不处理饥饿、口渴及脱水昏迷。不会把所有非正常状态清零。'),
        U.field('对自己时清除的状态', statusList),
        doctor ? h('label', { class: 'check' }, doctorBox, '医生（草案）：治疗他人时消耗医疗箱并获得1份绷带') : null),
      actions: [{ label: '取消', value: false }, { label: '使用', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      if (holder.target === 'other' && !holder.who.trim()) { U.toast('请填写对方名字', 'warn'); return; }
      var text = '';
      var direct = holder.target === 'other' && netCanReach(holder.pid);
      var fn = function (s) {
        C.removeQty(s.inventory, e.id, 1);
        syncLoadout(s);
        if (holder.target === 'self') {
          var removed = s.statuses.filter(function (st) { return checks[st.id]; }).map(function (st) { return st.name; });
          s.statuses = s.statuses.filter(function (st) { return !checks[st.id]; });
          s.hp += 2;
          log(s, '医疗箱：恢复2生命 → ' + s.hp + (removed.length ? '；清除 ' + removed.join('、') : ''));
        } else {
          if (direct) log(s, '使用医疗箱治疗 ' + holder.who.trim() + '：通过联机房间，对方页面自动生效');
          else {
            text = handoff(s, 'heal', '【治疗·第' + today() + '天】' + myName() + ' 对 ' + holder.who.trim() + ' 使用了医疗箱：清除伤病类负面状态，并恢复2生命（不处理饥饿、口渴及脱水昏迷）。请 ' + holder.who.trim() + ' 在玩家页手动修改。');
            log(s, '使用医疗箱治疗 ' + holder.who.trim());
          }
          if (doctor && doctorBox.checked) {
            C.addItem(s.inventory, 'bandage', 1, { customItems: s.customItems, rules: s.rules });
            log(s, '医生（草案）：治疗他人后获得1份绷带');
          }
        }
      };
      var ok = direct ? netCommit('使用医疗箱', fn) : commit('使用医疗箱', fn);
      if (ok && direct) {
        netSendHeal(holder.pid, 'medkit');
        U.toast('已交给房间：' + holder.who.trim() + ' 的页面会自动生效', 'ok');
      }
      if (text) showHandoff(text, '治疗他人：请对方手动修改');
    });
  }

  function useMap(e) {
    var text = h('input', { type: 'text', placeholder: '笔记内容：地点、时间或可能的回报', autofocus: true });
    U.modal({
      title: '地图',
      body: h('div', { class: 'stack' },
        h('p', null, '携带参加一次任务加1笔记（已确认），每条笔记1分。'),
        U.field('新笔记', text),
        h('p', { class: 'muted small' }, '移交地图时，笔记会写进交接文本告知对方；转移后笔记归属、损坏后及死亡后的分数由主持人裁定。')),
      actions: [
        { label: '取消', value: null },
        { label: e.condition === 'damaged' ? '标记完好' : '标记损坏', value: 'cond' },
        { label: '加1笔记', kind: 'primary', value: 'note' }
      ]
    }).then(function (v) {
      if (!v) return;
      commit(v === 'note' ? '地图加笔记' : '地图状态', function (s) {
        var x = C.findEntry(s.inventory, e.id);
        if (v === 'note') {
          var t = text.value.trim() || '任务笔记';
          x.notes.push({ text: t, day: today() });
          log(s, '地图加1笔记：' + t + '（共' + x.notes.length + '条）');
        } else {
          x.condition = x.condition === 'damaged' ? 'intact' : 'damaged';
          log(s, '地图标记为' + (x.condition === 'damaged' ? '损坏' : '完好'));
        }
      });
    });
  }

  function useCanteen(e, def) {
    var max = def.maxWater || 2;
    var holder = { thirst: state.thirst };
    U.modal({
      title: '军用水壶（储水 ' + (e.water || 0) + '/' + max + '）',
      body: h('div', { class: 'stack' },
        h('p', null, '水源或下雨条件下可获得1份水，最多储存' + max + '份。取水频率、饮用后是否生成普通水物品未定。'),
        U.field('饮用后的口渴（补水幅度待定，手动设置）', thirstPicker(holder))),
      actions: [
        { label: '取消', value: null },
        { label: '取水 +1', value: 'fill' },
        { label: '饮用 −1', kind: 'primary', value: 'drink' }
      ]
    }).then(function (v) {
      if (!v) return;
      if (v === 'fill' && (e.water || 0) >= max) { U.toast('最多储存 ' + max + ' 份', 'warn'); return; }
      if (v === 'drink' && !(e.water > 0)) { U.toast('水壶是空的', 'warn'); return; }
      commit(v === 'fill' ? '水壶取水' : '水壶饮用', function (s) {
        var x = C.findEntry(s.inventory, e.id);
        if (v === 'fill') {
          x.water = (x.water || 0) + 1;
          log(s, '水壶取水：储水 ' + x.water + '/' + max);
        } else {
          x.water -= 1;
          var t0 = s.thirst;
          s.thirst = holder.thirst;
          log(s, '水壶饮用：储水 ' + x.water + '/' + max + '；口渴 ' + t0 + ' → ' + s.thirst);
        }
      });
    });
  }

  function useLiquor(e) {
    U.confirmBox('事件中使用酒？', '消耗1件。已确认：临时攻击力+2，并承担一次口渴消耗。只记录到下一任务，不扩展为全回合加成；口渴变化请按结算手动修改。', '使用').then(function (ok) {
      if (!ok) return;
      commit('使用酒', function (s) {
        C.removeQty(s.inventory, e.id, 1);
        syncLoadout(s);
        s.temporaryEffects.push({ id: C.uid('fx'), text: '下一任务：临时攻击+2（酒）', day: today(), attack: 2 });
        s.temporaryEffects.push({ id: C.uid('fx'), text: '承担一次口渴消耗（酒，按结算手动修改）', day: today(), attack: null });
        log(s, '使用酒：下一任务临时攻击+2，并承担一次口渴消耗');
      });
    });
  }

  function useVest(e) {
    U.modal({
      title: '防弹背心（' + (e.condition === 'damaged' ? '破损' : '完好') + '）',
      body: h('div', { class: 'stack' },
        h('p', null, '防止任务中一次负面状态或生命损失。损坏时点、伤害范围待定：不会自动判定每次保护都会损坏。'),
        h('p', { class: 'muted small' }, '军人（草案）修复技能需要破损的背心。')),
      actions: [
        { label: '取消', value: null },
        { label: '记录抵挡一次', value: 'block' },
        { label: e.condition === 'damaged' ? '标记完好（已修复）' : '标记破损', kind: 'primary', value: 'toggle' }
      ]
    }).then(function (v) {
      if (!v) return;
      commit(v === 'block' ? '背心抵挡' : '背心状态', function (s) {
        var x = C.findEntry(s.inventory, e.id);
        if (v === 'block') log(s, '防弹背心抵挡一次（是否因此破损由主持人裁定）');
        else {
          x.condition = x.condition === 'damaged' ? 'intact' : 'damaged';
          log(s, '防弹背心标记为' + (x.condition === 'damaged' ? '破损' : '完好'));
        }
      });
    });
  }

  function useRecord(e, def) {
    var deduct = h('input', { type: 'checkbox' });
    var qty = h('input', { type: 'number', class: 'num', min: 1, max: e.qty, value: 1 });
    var note = h('input', { type: 'text', placeholder: '用在哪里（可选）' });
    var configured = state.rules.itemUses[def.id];
    U.modal({
      title: '记录使用：' + def.name,
      body: h('div', { class: 'stack' },
        h('p', null, def.effectText),
        h('p', { class: 'small' }, '使用次数：', configured == null ? U.pendingTag('待配置') : String(configured), '。未确定的使用不会自动扣数量。'),
        U.field('说明', note),
        h('label', { class: 'check' }, deduct, '同时扣除数量'), U.field('扣除件数', qty)),
      actions: [{ label: '取消', value: false }, { label: '记录', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = parseInt(qty.value, 10);
      if (deduct.checked && !(n > 0 && n <= e.qty)) { U.toast('扣除件数需在 1～' + e.qty + ' 之间', 'warn'); return; }
      commit('记录使用' + def.name, function (s) {
        if (deduct.checked) {
          C.removeQty(s.inventory, e.id, n);
          syncLoadout(s);
        }
        log(s, '记录使用' + def.name + (note.value ? '（' + note.value + '）' : '') + (deduct.checked ? '，扣除 ' + n + ' 件' : '，未扣数量'));
      });
    });
  }

  // ================================================================ 携带

  // ================================================================ 搜刮

  var scavTimer = null;

  function renderScavenge() {
    var sc = state.scavenge;
    var r = state.rules;
    var head = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '阶段性搜刮'), chip(r.scavengeRounds + '轮 × ' + r.scavengeOptions + '选项 × ' + r.scavengeSeconds + '秒', '')),
      h('p', { class: 'small' }, '每轮几组物资组合（每组 ' + C.fmtUnits(Math.max(1, r.scavengeComboTicks - 1)) + '～' + C.fmtUnits(r.scavengeComboTicks) + ' 单位；补给之外的物品每组最多一件），超时自动选默认项（第一项，已标明）。计时按截止时间计算，候选与选择立即存档：刷新或切到后台都不会多领一轮。'),
      h('p', { class: 'small' }, '新所得进入待整理区：自留不超过 ' + C.fmtUnits(r.scavengeKeepTicks) + ' 单位，同时检查总库存 ' + C.fmtUnits(r.inventoryCapacityTicks) + ' 单位，其余形成交公清单。'));
    if (!sc || sc.status === 'submitted') {
      return h('div', { class: 'stack' }, head,
        sc ? submittedCard(sc) : null,
        h('section', { class: 'card' },
          h('button', { type: 'button', class: 'btn primary big', onclick: startScavenge }, '开始搜刮（主持人通知后）'),
          h('p', { class: 'muted small' }, '候选从下方的搜刮模板生成，不扣公共池（实现假设，主持人可改）。')),
        scavengeTemplateCard());
    }
    if (sc.status === 'running') return h('div', { class: 'stack' }, head, runningCard(sc));
    return h('div', { class: 'stack' }, head, organizeCard(sc));
  }

  function startScavenge() {
    U.confirmBox('开始搜刮？', '请确认主持人已经通知开始。开始后计时不能暂停，刷新也不会重置。', '开始').then(function (ok) {
      if (!ok) return;
      // 撤销不能回到搜刮开始之前（否则会丢掉进行中的回合）
      undo.clear();
      commit('开始搜刮', function (s) {
        if (s.scavenge && s.scavenge.status === 'submitted') s.scavengeHistory.unshift(s.scavenge);
        s.scavenge = C.startScavenge(s.scavengeTemplate, s.rules, s.customItems, Date.now(), Math.random);
        ui.keep = {};
        ui.transfer = {};
        log(s, '开始搜刮（第' + today() + '天）');
      }, { undo: false });
    });
  }

  function runningCard(sc) {
    var round = C.currentScavengeRound(sc);
    if (!round) return h('p', null, '处理中…');
    var remaining = Math.max(0, round.deadline - Date.now());
    return h('section', { class: 'card scav wide' },
      h('div', { class: 'row between' }, h('h2', null, '第 ' + (round.index + 1) + ' / ' + sc.cfg.rounds + ' 轮'),
        h('div', { class: 'scav-clock', id: 'scav-clock' }, (remaining / 1000).toFixed(1) + ' 秒')),
      h('div', { class: 'meter' }, h('span', { id: 'scav-bar', style: 'width:' + (remaining / (sc.cfg.seconds * 1000)) * 100 + '%' })),
      h('div', { class: 'scav-options' }, round.options.map(function (combo, i) {
        return h('button', { type: 'button', class: 'scav-option ' + (i === 0 ? 'default' : ''), 'data-option': String(i), onclick: function () { chooseOption(round.index, i); } },
          h('div', { class: 'scav-option-head' }, String.fromCharCode(65 + i), i === 0 ? chip('默认：超时自动选择', 'demo') : null),
          combo.length ? h('ul', null, combo.map(function (it) { return h('li', null, C.getDef(it.defId, state.customItems).name + ' ×' + it.qty); })) : h('p', { class: 'muted' }, '（空）'),
          h('div', { class: 'muted small' }, '共 ' + C.fmtUnits(C.comboTicks(combo, state.customItems)) + ' 单位'));
      })),
      sc.rounds.length > 1 ? h('p', { class: 'muted small' }, '已完成：' + sc.rounds.slice(0, -1).map(function (r) { return '第' + (r.index + 1) + '轮选 ' + String.fromCharCode(65 + r.choice) + (r.auto ? '（超时默认）' : ''); }).join('；')) : null);
  }

  function chooseOption(roundIndex, optionIndex) {
    var result = null;
    commit('搜刮选择', function (s) {
      result = C.chooseScavenge(s.scavenge, roundIndex, optionIndex, Date.now(), s.customItems, Math.random);
      if (result.ok) log(s, '搜刮第' + (roundIndex + 1) + '轮选择 ' + String.fromCharCode(65 + optionIndex));
      else log(s, '搜刮第' + (roundIndex + 1) + '轮超时，按默认项记录');
    }, { undo: false });
    if (result && !result.ok) U.toast(result.reason, 'warn');
  }

  function scavTick() {
    var sc = state.scavenge;
    if (!sc || sc.status !== 'running') return;
    var round = C.currentScavengeRound(sc);
    if (round && Date.now() >= round.deadline) {
      commit('搜刮超时', function (s) {
        var before = s.scavenge.rounds.length;
        C.settleScavenge(s.scavenge, Date.now(), s.customItems, Math.random);
        log(s, '搜刮超时：自动选默认项（第一项）' + (s.scavenge.rounds.length > before ? '，进入下一轮' : ''));
      }, { undo: false });
      return;
    }
    if (round && ui.tab === 'scavenge') {
      var remaining = Math.max(0, round.deadline - Date.now());
      var clock = document.getElementById('scav-clock');
      var bar = document.getElementById('scav-bar');
      if (clock) clock.textContent = U.T((remaining / 1000).toFixed(1) + ' 秒');
      if (bar) bar.style.width = (remaining / (sc.cfg.seconds * 1000)) * 100 + '%';
    }
  }

  function organizeCard(sc) {
    var gains = C.scavengeGains(sc);
    var keep = gains.map(function (g) { return { defId: g.defId, qty: Math.min(ui.keep[g.defId] || 0, g.qty) }; });
    var transferTicks = 0;
    var transfers = [];
    Object.keys(ui.transfer).forEach(function (id) {
      var e = C.findEntry(state.inventory, id);
      var q = ui.transfer[id];
      if (e && q > 0) {
        var n = Math.min(q, e.qty);
        transfers.push({ entry: e, qty: n });
        transferTicks += n * (defOf(e).capacityTicks || 0);
      }
    });
    var check = C.checkScavengeKeep(keep.filter(function (k) { return k.qty > 0; }), invTicks(), transferTicks, state.rules, state.customItems);
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '待整理区'), chip('三轮已完成', 'ok')),
        h('p', { class: 'small muted' }, sc.rounds.map(function (r) { return '第' + (r.index + 1) + '轮 ' + String.fromCharCode(65 + r.choice) + (r.auto ? '（超时默认）' : ''); }).join('　')),
        gains.length ? h('ul', { class: 'list-plain' }, gains.map(function (g) {
          var k = Math.min(ui.keep[g.defId] || 0, g.qty);
          var def = C.getDef(g.defId, state.customItems);
          return h('li', { class: 'row between' },
            h('span', { class: 'grow' }, def.name + ' ×' + g.qty, h('span', { class: 'muted small' }, ' · 每件' + C.fmtUnits(def.capacityTicks))),
            h('span', { class: 'row tight' }, '自留',
              h('button', { type: 'button', class: 'btn small', disabled: k <= 0, onclick: function () { ui.keep[g.defId] = k - 1; render(); } }, '−'),
              h('span', { class: 'qty' }, String(k)),
              h('button', { type: 'button', class: 'btn small', disabled: k >= g.qty, onclick: function () { ui.keep[g.defId] = k + 1; render(); } }, '+'),
              h('span', { class: 'muted small' }, '交公 ' + (g.qty - k))));
        })) : h('p', { class: 'empty' }, '这次什么也没搜到。'),
        h('p', { class: check.keepOver ? 'risk-text' : '' }, '本次自留：', h('b', null, C.fmtUnits(check.keepTicks) + ' / ' + C.fmtUnits(check.keepLimit)), ' 单位' + (check.keepOver ? '（超出自留额度）' : '')),
        h('p', { class: check.inventoryOver ? 'risk-text' : '' }, '提交后总库存：', h('b', null, C.fmtUnits(check.inventoryAfter) + ' / ' + C.fmtUnits(check.inventoryLimit)), ' 单位' + (check.inventoryOver ? '（超出总库存，只警告）' : ''))),
      h('details', { class: 'card' },
        h('summary', null, h('b', null, '单独转出旧物品'), h('span', { class: 'muted small' }, ' 腾出库存；不算进本次搜刮所得')),
        state.inventory.length ? h('ul', { class: 'list-plain' }, state.inventory.map(function (e) {
          var q = Math.min(ui.transfer[e.id] || 0, e.qty);
          return h('li', { class: 'row between' }, h('span', { class: 'grow' }, describe(e)),
            h('span', { class: 'row tight' },
              h('button', { type: 'button', class: 'btn small', disabled: q <= 0, onclick: function () { ui.transfer[e.id] = q - 1; render(); } }, '−'),
              h('span', { class: 'qty' }, String(q)),
              h('button', { type: 'button', class: 'btn small', disabled: q >= e.qty, onclick: function () { ui.transfer[e.id] = q + 1; render(); } }, '+')));
        })) : h('p', { class: 'empty' }, '库存是空的。')),
      h('button', { type: 'button', class: 'btn primary big', onclick: function () { previewSubmit(sc, gains, keep, transfers, check); } }, '预览并提交'));
  }

  function previewSubmit(sc, gains, keep, transfers, check) {
    var handIn = gains.map(function (g) {
      var k = keep.find(function (x) { return x.defId === g.defId; });
      return { defId: g.defId, qty: g.qty - (k ? k.qty : 0) };
    }).filter(function (x) { return x.qty > 0; });
    var kept = keep.filter(function (k) { return k.qty > 0; });
    var over = check.keepOver || check.inventoryOver;
    var override = h('input', { type: 'checkbox' });
    U.modal({
      title: '预览：一次性提交',
      body: h('div', { class: 'stack' },
        h('p', null, h('b', null, '自留（加入库存）：'), kept.length ? C.formatItemList(kept, state.customItems) : '无'),
        h('p', null, h('b', null, '本次所得交公：'), handIn.length ? C.formatItemList(handIn, state.customItems) : '无'),
        transfers.length ? h('p', null, h('b', null, '旧物品转出（不算本次所得）：'), transfers.map(function (t) { return describe(t.entry) + (C.isStackable(defOf(t.entry)) ? '（' + t.qty + '件）' : ''); }).join('、')) : null,
        over ? h('div', { class: 'callout risk' }, (check.keepOver ? '自留超过 ' + C.fmtUnits(check.keepLimit) + ' 单位。' : '') + (check.inventoryOver ? '提交后总库存超过 ' + C.fmtUnits(check.inventoryLimit) + ' 单位。' : '') + '只警告，不阻断主持人裁定。') : null,
        over ? h('label', { class: 'check' }, override, '主持人已裁定，仍然提交') : null,
        h('p', { class: 'muted small' }, netLive() ? '提交后只能提交一次：自留物品加入库存，交公的物品通过联机房间直接进主持人的公共池。' : '提交后只能提交一次：自留物品加入库存，交公清单生成交接文本给主持人手动加入公共池。')),
      actions: [{ label: '返回修改', value: false }, { label: '确认提交', kind: 'primary', value: true, validate: function () { return over && !override.checked ? '超出额度：请先勾选「主持人已裁定」' : ''; } }]
    }).then(function (ok) {
      if (!ok) return;
      var text = '';
      // 在联机房间里：交公的物品直接送进主持人的公共池（送出后不能撤销）
      var viaNet = netLive();
      var id = viaNet ? ShelterNet.uid('m') : null;
      var deposit = [];
      var fn = function (s) {
        if (!s.scavenge || s.scavenge.id !== sc.id || s.scavenge.status !== 'organize') throw new Error('本次搜刮已提交，不会重复领取');
        kept.forEach(function (k) { C.addItem(s.inventory, k.defId, k.qty, { customItems: s.customItems, rules: s.rules }); });
        var oldOut = [];
        var oldPacked = [];
        transfers.forEach(function (t) {
          var e = C.findEntry(s.inventory, t.entry.id);
          if (!e) return;
          var n = Math.min(t.qty, e.qty);
          oldOut.push(C.isStackable(defOf(e)) ? defOf(e).name + '×' + t.qty : describe(e));
          oldPacked.push(C.packItem(e, n, s.customItems));
          C.removeQty(s.inventory, e.id, n);
        });
        syncLoadout(s);
        deposit = handIn.map(function (x) { return { defId: x.defId, qty: x.qty }; }).concat(oldPacked);
        var lines = ['【搜刮交公·第' + today() + '天】' + myName() + '：'];
        lines.push('本次所得交公：' + (handIn.length ? C.formatItemList(handIn, s.customItems) : '无'));
        if (oldOut.length) lines.push('另交出旧物品（不算本次所得）：' + oldOut.join('、'));
        lines.push('自留 ' + C.fmtUnits(check.keepTicks) + ' 单位' + (over ? '（超出额度，已由主持人裁定）' : '') + '。' + (viaNet ? '已通过联机房间交给主持人，自动加入公共池。' : '请主持人在公共池手动加入。'));
        text = handoff(s, 'scavenge', lines.join('\n'));
        if (viaNet && deposit.length) recordOutgoing(s, id, 'deposit', 'host', '搜刮交公', deposit);
        s.scavenge.status = 'submitted';
        s.scavenge.submitted = { at: Date.now(), kept: kept, handIn: handIn, oldOut: oldOut, text: text, override: over, viaNet: viaNet };
        log(s, '提交搜刮：自留 ' + (kept.length ? C.formatItemList(kept, s.customItems) : '无') + '；交公 ' + (handIn.length ? C.formatItemList(handIn, s.customItems) : '无') + (oldOut.length ? '；旧物品转出 ' + oldOut.join('、') : ''));
      };
      var done = viaNet ? netCommit('提交搜刮', fn) : commit('提交搜刮', fn);
      if (done) {
        ui.keep = {};
        ui.transfer = {};
        if (viaNet) {
          if (deposit.length) netPostItems(id, 'deposit', 'host', deposit, '搜刮交公');
          U.toast(deposit.length ? '已提交：交公物品已交给房间，主持人页自动加入公共池' : '已提交', 'ok');
        } else {
          showHandoff(text, '交公清单：发给主持人');
        }
      }
    });
  }

  function submittedCard(sc) {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '上一次搜刮'), chip('已提交 ' + U.fmtTime(sc.submitted.at), 'ok')),
      U.copyBlock(sc.submitted.text, { label: '复制交公清单' }));
  }

  function scavengeTemplateCard() {
    var t = state.scavengeTemplate;
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '搜刮模板：' + t.name), ' ', t.isExample ? U.ruleBadge('impl') : chip('自定义', '')),
      h('p', { class: 'section-note' }, t.note || ''),
      h('div', { class: 'weights' }, t.items.map(function (it, i) {
        var input = h('input', { type: 'number', class: 'num', min: 0, step: 'any', value: it.weight });
        input.addEventListener('change', function () {
          var n = U.parseNumber(input.value, true);
          if (n == null || Number.isNaN(n) || n < 0) { U.toast('权重需为非负数字（0＝不出现）', 'warn'); input.value = it.weight; return; }
          commit('修改搜刮模板', function (s) { s.scavengeTemplate.items[i].weight = n; s.scavengeTemplate.isExample = false; s.scavengeTemplate.name = '自定义搜刮模板'; }, { undo: true });
        });
        return h('label', { class: 'weight' }, C.getDef(it.defId, state.customItems).name, input);
      })),
      h('div', { class: 'row' },
        h('button', {
          type: 'button', class: 'btn small', onclick: function () {
            var defs = C.allDefs(state.customItems).filter(function (d) { return !t.items.some(function (it) { return it.defId === d.id; }); });
            if (!defs.length) { U.toast('所有物品都已在模板中', 'warn'); return; }
            commit('模板加入物品', function (s) { defs.forEach(function (d) { s.scavengeTemplate.items.push({ defId: d.id, weight: 0 }); }); });
          }
        }, '加入自定义物品（权重0）'),
        h('button', { type: 'button', class: 'btn small', onclick: function () { commit('恢复示例模板', function (s) { s.scavengeTemplate = C.defaultScavengeTemplate(); }); } }, '恢复示例模板')));
  }

  // ================================================================ 行动

  // ================================================================ 行动与身份

  /* 每天一次、会消耗当日行动的选择。点亮一个即记为今天的行动；再点一次取消。 */
  var ACTIONS = [
    { id: 'plan', name: '计划守夜名单', desc: '为今晚抽两张守夜卡，选一张发给主持人' },
    { id: 'swap', name: '尝试换位', desc: '请求与别人交换实际座位，双方同意才生效' },
    { id: 'skill', name: '使用职业技能', desc: '' },
    { id: 'other', name: '其他行动', desc: '主持人允许的其他行动' },
    { id: 'pass', name: '放弃行动', desc: '今天不行动' }
  ];

  function actionName(type) {
    var a = ACTIONS.find(function (x) { return x.id === type; });
    return a ? a.name : '已使用（未注明）';
  }

  function chooseAction(type) {
    var cur = state.action.day === today() && state.action.used ? state.action.type || null : null;
    var prof = state.rules.professionsEnabled ? C.getProfession(state.professionId) : null;
    var ok = commit('今日行动', function (s) {
      var old = s.action.day === today() ? s.action : null;
      if (old && old.skillLogId) s.skillLog = s.skillLog.filter(function (k) { return k.id !== old.skillLogId; });
      if (cur === type) {
        s.action = { day: today(), used: false, type: null, note: '' };
        log(s, '取消今日行动：' + actionName(type));
        return;
      }
      s.action = { day: today(), used: true, type: type, note: old && old.used ? old.note || '' : '' };
      if (type === 'skill' && prof) {
        var id = C.uid('sk');
        s.skillLog.unshift({ id: id, day: today(), text: prof.name + '技能' });
        s.action.skillLogId = id;
      }
      log(s, '今日行动：' + actionName(type) + (cur ? '（改选，原为' + actionName(cur) + '）' : ''));
    });
    // 在联机房间里：交给主持人页（轮到你时自动记录）
    if (ok) netReportAction(cur === type ? null : type);
  }

  // ---------------------------------------------------------------- 守夜名单（只负责抽取、选择与分享）

  /** 完整名单：自己的名字＋存档里录入的其他玩家，去重。 */
  function fullRoster() {
    var list = [];
    if (state.name && state.name.trim()) list.push(state.name.trim());
    (state.otherNames || []).forEach(function (n) {
      n = String(n || '').trim();
      if (n && list.indexOf(n) < 0) list.push(n);
    });
    return list;
  }

  function todayWatchPlan() {
    var p = state.watchPlan;
    return p && p.v === 2 && p.day === today() ? p : null;
  }

  /** 两张卡按「玩家＋天数＋名单」定种子：撤销后重新抽还是这两张，不能靠重抽挑卡。 */
  function drawWatch() {
    var roster = fullRoster();
    commit('抽取守夜名单', function (s) {
      var seed = C.hashSeed(s.playerId + '|' + today() + '|' + roster.join(','));
      s.watchPlan = { v: 2, day: today(), cards: C.drawWatchPair(roster, C.seededRng(seed), s.rules), chosen: null };
      log(s, '抽取守夜名单：两张卡');
    });
  }

  function choosePlanCard(i) {
    commit('选择守夜卡', function (s) {
      if (s.watchPlan.chosen === i) return false;
      s.watchPlan.chosen = i;
      log(s, '选择守夜卡：第 ' + (i + 1) + ' 张');
    });
  }

  /** 主持人页的地址：与玩家页同一目录下的 host.html。 */
  function hostPageUrl() {
    var u = location.href.replace(/[#?].*$/, '');
    if (/player(\.html)?$/.test(u)) return u.replace(/player(\.html)?$/, 'host.html');
    try { return new URL('host.html', u).href; } catch (e) { return 'host.html'; }
  }

  /** 分享链接带着已选卡片的完整结果，主持人打开后看到同一张卡，不重新随机。 */
  function watchShareLink(plan) {
    return hostPageUrl() + C.watchLinkHash({ v: 2, day: plan.day, from: state.name || '', card: plan.cards[plan.chosen] });
  }

  /** 只在今天的行动是「计划守夜名单」时出现。 */
  function watchSection(current) {
    if (current !== 'plan') return null;
    var plan = todayWatchPlan();
    var roster = fullRoster();
    var parts = [h('div', { class: 'card-head' }, h('h2', null, '守夜名单'), plan && plan.chosen != null ? sevBadge('ok', '已选第 ' + (plan.chosen + 1) + ' 张') : null)];
    if (!plan) {
      parts.push(h('p', { class: 'muted small' }, '点下面的按钮随机抽两张卡，选一张，把分享链接发给主持人。今天抽过就固定，不能重抽。'));
      if (!(state.name && state.name.trim())) parts.push(h('div', { class: 'callout info' }, '先在下方「身份与秘密」填写你的姓名。'));
      if (roster.length < 2) {
        parts.push(h('div', { class: 'callout info' }, '名单里还没有其他玩家：先到「存档 → 玩家名单」录入其他玩家的名字。 ',
          h('button', { type: 'button', class: 'btn-link', onclick: function () { setTab('save'); } }, '去录入')));
      }
      parts.push(h('button', { type: 'button', class: 'btn primary big', disabled: roster.length < 2 || !(state.name && state.name.trim()), onclick: drawWatch }, '确认抽取守夜名单'));
    } else {
      parts.push(h('p', { class: 'muted small' }, '选一张，再复制分享链接发给主持人。主持人打开链接就能看到同一张卡。'));
      parts.push(h('div', { class: 'wcards', role: 'group', 'aria-label': '两张守夜卡' }, plan.cards.map(function (c, i) {
        return U.watchCardFace(C.watchCardFace(c), { id: c.id, selected: plan.chosen === i, caption: '第 ' + (i + 1) + ' 张', onclick: function () { choosePlanCard(i); } });
      })));
      if (plan.chosen != null && netJoined()) {
        var sent = plan.sentAt && plan.sentChoice === plan.chosen;
        parts.push(h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary big', onclick: function () { netSendWatch(plan); } }, sent ? '重新交给主持人' : '直接交给主持人'),
          sent ? sevBadge('ok', '已交给房间 ' + U.fmtTime(plan.sentAt).slice(6)) : h('span', { class: 'muted small' }, '主持人页会自动加入今天的候选。')));
      }
      if (plan.chosen != null) {
        var link = watchShareLink(plan);
        parts.push(h('div', { class: 'share-row' },
          h('input', { type: 'text', readonly: true, value: link, 'aria-label': '分享链接', onclick: function (e) { e.target.select(); } }),
          h('button', { type: 'button', class: 'btn primary', onclick: function () {
            U.copyText(link).then(function (ok) { U.toast(ok ? '已复制分享链接，发给主持人即可' : '复制失败：请长按链接手动复制', ok ? 'ok' : 'warn'); });
          } }, U.icon('copy'), '复制分享链接')));
      }
    }
    return h('section', { class: 'card wide watch-section' }, parts);
  }

  /** 存档页：录入其他玩家的名字，与自己的名字一起组成守夜卡的完整名单。 */
  function rosterCard() {
    var roster = fullRoster();
    var input = h('input', { type: 'text', placeholder: '其他玩家的名字，多个用逗号分开', 'aria-label': '其他玩家的名字' });
    function add() {
      var names = input.value.split(/[，,、;；\n]+/).map(function (n) { return n.trim(); }).filter(Boolean);
      if (!names.length) { U.toast('请输入名字', 'warn'); return; }
      commit('录入玩家名字', function (s) {
        var added = names.filter(function (n) { return n !== s.name && s.otherNames.indexOf(n) < 0; });
        if (!added.length) return false;
        s.otherNames = s.otherNames.concat(added);
        log(s, '录入玩家名字：' + added.join('、'));
      });
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    return h('section', { class: 'card roster-card' },
      h('div', { class: 'card-head' }, h('h2', null, '玩家名单'), chip(roster.length + ' 人', roster.length >= 2 ? 'ok' : '')),
      h('p', { class: 'section-note' }, '守夜卡从这份名单里抽人：你自己的名字加上其他玩家的名字。每张普通卡必定守夜的人数是总人数的三分之一，向上取整。'),
      h('p', null, h('b', null, '我：'), state.name && state.name.trim() ? state.name : h('span', { class: 'muted' }, '还没填姓名'), ' ',
        h('button', { type: 'button', class: 'btn-link', onclick: function () { setTab('action'); } }, '在「行动与身份」修改')),
      (state.otherNames || []).length ? h('ul', { class: 'name-chips' }, state.otherNames.map(function (n) {
        return h('li', { class: 'name-chip' }, h('span', null, n), h('button', {
          type: 'button', class: 'name-chip-x', 'aria-label': '移除 ' + n, onclick: function () {
            commit('移除玩家名字', function (s) { s.otherNames = s.otherNames.filter(function (x) { return x !== n; }); log(s, '移除玩家名字：' + n); });
          }
        }, '×'));
      })) : h('p', { class: 'muted small' }, '还没有录入其他玩家。'),
      h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'btn', onclick: add }, '添加')),
      roster.length >= 2 ? h('p', { class: 'muted small' }, '共 ' + roster.length + ' 人 → 每张普通卡 ' + C.watchCount(roster.length, state.rules) + ' 人必定守夜。') : null,
      h('p', { class: 'muted small' }, '也可以导入主持人的规则包，自动填好名单。'));
  }

  function renderAction() {
    var usedToday = state.action.day === today() && state.action.used;
    var current = usedToday ? state.action.type || null : null;
    var prof = state.rules.professionsEnabled ? C.getProfession(state.professionId) : null;
    var note = h('input', { type: 'text', value: usedToday ? state.action.note || '' : '', placeholder: '可选：对谁、做了什么' });
    note.addEventListener('change', function () { commit('行动备注', function (s) { s.action.note = note.value.trim(); }, { undo: false }); });
    var craftName = h('input', { type: 'text', placeholder: '例如：制造子弹' });
    var craftReq = h('input', { type: 'number', class: 'num', min: 1, placeholder: '回合' });
    return h('div', { class: 'stack' },
      h('section', { class: 'card wide action-card' },
        h('div', { class: 'card-head' }, h('h2', null, '第 ' + today() + ' 天的行动'),
          usedToday ? sevBadge('ok', '已选：' + actionName(current)) : sevBadge('info', '还没选')),
        h('p', { class: 'muted small' }, netJoined()
          ? '每天一次行动。点一个按钮点亮它，就记为今天的行动；再点一次取消，点别的就改选。你在联机房间里：选择会交给主持人页，轮到你时自动记录（记录后要改请找主持人）。'
          : '每天一次行动。点一个按钮点亮它，就记为今天的行动；再点一次取消，点别的就改选。只记在你自己的页面上，不会自动通知主持人。'),
        h('div', { class: 'action-grid', role: 'group', 'aria-label': '今日行动' }, ACTIONS.map(function (a) {
          var on = current === a.id;
          var disabled = a.id === 'skill' && !prof;
          var desc = a.id === 'skill'
            ? (prof ? prof.name + '：' + prof.text : state.rules.professionsEnabled ? '先在下方选择职业' : '职业草案未启用')
            : a.desc;
          return h('button', {
            type: 'button', class: 'action-btn act-' + a.id + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', 'data-action': a.id,
            disabled: disabled, onclick: function () { chooseAction(a.id); }
          },
            h('span', { class: 'action-name' }, on ? U.icon('check') : null, a.name),
            h('span', { class: 'action-desc' }, desc));
        })),
        usedToday && !current ? h('p', { class: 'small' }, '今天已标记使用行动（旧记录，未注明类型）。点一个按钮可补上类型。') : null,
        usedToday ? U.field('备注', note) : null),
      watchSection(current),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '职业技能'), U.ruleBadge('draft')),
        state.rules.professionsEnabled ? h('div', { class: 'stack' },
          U.field('职业', U.select([['', '未选择']].concat(C.PROFESSIONS.map(function (p) { return [p.id, p.name]; })), state.professionId || '', function (v) {
            commit('选择职业', function (s) { s.professionId = v || null; log(s, '职业：' + (v ? C.getProfession(v).name : '未选择')); });
          })),
          prof ? h('div', { class: 'skill-box' }, h('b', null, prof.name + '的技能'), h('p', null, prof.text), U.pendingTag(prof.pending)) : h('p', { class: 'muted' }, '还没有选择职业。'),
          h('p', { class: 'muted small' }, '使用职业技能会占用当天的行动：在上方点亮「使用职业技能」。职业没有专属分数，除非之后确认。'),
          state.skillLog.length ? h('div', null, h('h3', null, '使用记录'), h('ul', { class: 'list-plain' }, state.skillLog.map(function (k) { return h('li', null, '第' + k.day + '天：' + k.text); }))) : null)
          : h('p', { class: 'muted' }, '职业草案未启用（主持人明确启用后，在「存档 → 规则」打开）。')),
      identityCards(),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '制作进度')),
        state.crafting.length ? h('ul', { class: 'list-plain' }, state.crafting.map(function (c) {
          var done = C.isInt(c.required) && c.progress >= c.required;
          return h('li', { class: 'row between' },
            h('span', { class: 'grow' }, h('b', null, c.name), ' ', c.progress + ' / ' + (c.required == null ? '?' : c.required) + ' 回合', done ? chip('完成', 'ok') : null),
            h('span', { class: 'row tight' },
              h('button', { type: 'button', class: 'btn small', onclick: function () { craftStep(c.id, -1); } }, '−1'),
              h('button', { type: 'button', class: 'btn small', onclick: function () { craftStep(c.id, 1); } }, '+1'),
              h('button', { type: 'button', class: 'btn small', onclick: function () { commit('删除制作', function (s) { s.crafting = s.crafting.filter(function (x) { return x.id !== c.id; }); log(s, '删除制作项：' + c.name); }); } }, '删除')));
        })) : h('p', { class: 'empty' }, '没有进行中的制作。'),
        h('div', { class: 'row' }, craftName, craftReq, h('button', {
          type: 'button', class: 'btn', onclick: function () {
            var name = craftName.value.trim();
            var req = U.parseNumber(craftReq.value, false);
            if (!name) { U.toast('请输入制作内容', 'warn'); return; }
            if (Number.isNaN(req) || (req != null && req < 1)) { U.toast('回合数需为正整数或留空', 'warn'); return; }
            commit('新增制作', function (s) { s.crafting.push({ id: C.uid('cr'), name: name, progress: 0, required: req, note: '' }); log(s, '新增制作项：' + name); });
          }
        }, '新增')),
        h('p', { class: 'muted small' }, '例如军人（草案）：持枪两个回合制造1份子弹、两个回合修复破损背心；两回合是否各耗行动未定。完成后请手动修改库存。')));
  }

  function craftStep(id, d) {
    commit('制作进度', function (s) {
      var c = s.crafting.find(function (x) { return x.id === id; });
      c.progress = Math.max(0, c.progress + d);
      log(s, '制作进度：' + c.name + ' ' + c.progress + '/' + (c.required == null ? '?' : c.required));
    });
  }

  // ---------------------------------------------------------------- 身份（与行动同页）

  function identityCards() {
    function textField(label, key, hint, selfBtn) {
      var input = h('input', { type: 'text', value: state[key] || '' });
      input.addEventListener('change', function () { commit('修改' + label, function (s) { s[key] = input.value.trim(); log(s, label + '：' + (input.value.trim() || '（空）')); }); });
      return U.field(label, h('div', { class: 'row' }, input, selfBtn ? h('button', { type: 'button', class: 'btn small', onclick: function () { commit('指向自己', function (s) { s[key] = s.name || '自己'; log(s, label + '：自己'); }); } }, '自己') : null), hint);
    }
    var task = C.getTask(state.taskId);
    return [
      h('section', { class: 'card' },
        h('h2', null, '身份与秘密'),
        textField('姓名', 'name'),
        textField('爱的人', 'loveName', '由主持人私信分配，手动填写；可以是自己', true),
        textField('恨的人', 'hateName', '可以是自己；爱与恨能否是同一人尚未确定', true)),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '秘密任务'), U.ruleBadge('draft')),
        state.rules.tasksEnabled ? h('div', { class: 'stack' },
          U.select([['', '未选择']].concat(C.TASKS.map(function (t) { return [t.id, t.name]; })), state.taskId || '', function (v) {
            commit('选择任务', function (s) { s.taskId = v || null; s.taskProgress = { count: 0, events: [], done: false, note: '' }; log(s, '秘密任务：' + (v ? C.getTask(v).name : '未选择')); });
          }),
          task ? taskBox(task) : null,
          h('p', { class: 'muted small' }, '任务完成后统一固定奖励（奖励值：' + (state.rules.scoreTaskReward == null ? '待配置' : state.rules.scoreTaskReward) + '）。完成即锁定还是结算时判断，按任务与配置处理。停用草案：' + C.RETIRED_DRAFTS.map(function (d) { return d.name; }).join('、') + '（不可选择）。')) :
          h('p', { class: 'muted' }, '秘密任务草案未启用。'))
    ];
  }

  function taskBox(task) {
    var p = state.taskProgress;
    var body = [];
    if (task.progress === 'events') {
      var evInput = h('input', { type: 'text', placeholder: '亲自参与的公共事件名称' });
      body.push(h('p', null, '不同公共事件：', h('b', null, p.events.length + ' / ' + task.target)));
      body.push(p.events.length ? h('ul', null, p.events.map(function (n, i) {
        return h('li', null, n, ' ', h('button', { type: 'button', class: 'btn-link', onclick: function () { commit('移除事件', function (s) { s.taskProgress.events.splice(i, 1); }); } }, '移除'));
      })) : null);
      body.push(h('div', { class: 'row' }, evInput, h('button', {
        type: 'button', class: 'btn small', onclick: function () {
          var n = evInput.value.trim();
          if (!n) return;
          if (p.events.indexOf(n) >= 0) { U.toast('这件事件已记录过（需不同事件）', 'warn'); return; }
          commit('记录参与事件', function (s) { s.taskProgress.events.push(n); log(s, '冒险家：参与事件「' + n + '」（' + s.taskProgress.events.length + '/' + task.target + '）'); });
        }
      }, '记录')));
    } else if (task.progress === 'counter') {
      body.push(h('div', { class: 'row' }, '进度：', h('b', null, p.count + ' / ' + task.target),
        h('button', { type: 'button', class: 'btn small', onclick: function () { commit('任务进度', function (s) { s.taskProgress.count = Math.max(0, s.taskProgress.count - 1); log(s, task.name + '进度 ' + s.taskProgress.count); }); } }, '−1'),
        h('button', { type: 'button', class: 'btn small', onclick: function () { commit('任务进度', function (s) { s.taskProgress.count += 1; log(s, task.name + '进度 ' + s.taskProgress.count); }); } }, '+1')));
      if (task.id === 'hoarder') body.push(h('p', { class: 'muted small' }, '库存里同一物品（面包、普通水除外）持有3件时，物品卡上会出现「囤积者：秘密消耗1件」按钮。'));
    } else {
      body.push(h('p', { class: 'muted small' }, '在营救结算时由主持人判断：初始 ' + state.rules.playerCount + ' 人时最多 ' + Math.floor(state.rules.playerCount * 2 / 3) + ' 人死亡。'));
    }
    body.push(h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: !!p.done, onchange: function (e) {
        var v = e.target.checked;
        commit('任务完成标记', function (s) { s.taskProgress.done = v; log(s, task.name + (v ? '：标记完成' : '：取消完成标记')); });
      }
    }), '已完成（由主持人确认）'));
    return h('div', { class: 'callout info stack' }, h('div', null, h('b', null, task.name + '：'), task.text), body);
  }

  // ================================================================ 分数

  function renderScore() {
    var counts = C.wealthCounts(state.inventory);
    var w = C.wealthScore(counts, !state.alive);
    var mapNotes = C.mapNotesTotal(state.inventory);
    var m = state.manualScores;
    var task = state.rules.tasksEnabled ? C.getTask(state.taskId) : null;
    var tot = C.settlementTotal({ wealth: w.score, map: m.map != null ? m.map : null, loveHate: m.loveHate, survival: m.survival, task: m.task, adjust: m.adjust });
    function manual(key, label, hint) {
      var input = h('input', { type: 'number', class: 'num', step: 'any', value: m[key] == null ? '' : m[key], placeholder: '待定' });
      input.addEventListener('change', function () {
        var n = U.parseNumber(input.value, true);
        if (Number.isNaN(n)) { U.toast('请输入数字或留空', 'warn'); input.value = m[key] == null ? '' : m[key]; return; }
        commit('手动分数', function (s) { s.manualScores[key] = n; log(s, label + '：' + (n == null ? '待定' : n)); });
      });
      return h('div', { class: 'rule-row' }, h('div', { class: 'rule-label' }, label), input, hint ? h('div', { class: 'field-hint' }, hint) : null);
    }
    var report = '【分数上报·第' + today() + '天】' + myName() + '：钞票' + counts.cash + '、名画' + counts.painting + '、珠宝' + counts.jewel +
      ' → 财富分 ' + (w.score == null ? '需主持人计分' : w.score) + (state.alive ? '' : '（已死亡）') + '；地图笔记 ' + mapNotes + ' 条' +
      (task ? '；任务 ' + task.name + (state.taskProgress.done ? '（已完成）' : '（进度 ' + (task.progress === 'events' ? state.taskProgress.events.length : state.taskProgress.count) + '/' + (task.target || '?') + '）') : '') + '。';
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('h2', null, '财富估算'),
        h('p', null, '钞票 ' + counts.cash + ' × 1 ＋ 名画 ' + counts.painting + ' × 6 ＋ 珠宝 ' + counts.jewel + ' 件（查表：' + (C.jewelScore(counts.jewel) == null ? '超过5件' : C.jewelScore(counts.jewel)) + '）'),
        h('div', { class: 'big-num small-big' }, w.score == null ? '需主持人计分' : String(w.score)),
        w.text ? h('p', { class: w.pending ? 'risk-text' : 'muted' }, w.text) : null,
        h('p', { class: 'muted small' }, '珠宝 1～5 件总分依次 1、4、8、11、15；超过5件不自行外推。')),
      h('section', { class: 'card' },
        h('h2', null, '地图分'),
        h('p', null, '笔记合计 ', h('b', null, String(mapNotes)), ' 条（每条1分）'),
        h('p', { class: 'muted small' }, '转移后笔记归属、损坏后分数与死亡后的地图分由主持人裁定，不并入死亡即清零的财富。')),
      h('section', { class: 'card' },
        h('h2', null, '手动分数'),
        h('div', { class: 'rules-grid' },
          manual('map', '地图分（主持人裁定）', '留空＝待定'),
          manual('loveHate', '爱恨分', '分值待配置'),
          manual('survival', '生存分', '分值待配置'),
          manual('task', '任务分', '固定奖励值待配置'),
          manual('adjust', '裁定调整', '')),
        h('p', null, '合计（已知部分）：', h('b', null, String(tot.total)), tot.partial ? h('span', { class: 'pending-tag' }, '部分分数／待裁定：' + tot.missing.join('、')) : null)),
      h('section', { class: 'card' },
        h('h2', null, '上报给主持人'),
        U.copyBlock(report, { label: '复制分数上报', note: '主持人手动录入，不会自动同步' })));
  }

  // ================================================================ 记录与存档

  function renderSave() {
    return h('div', { class: 'stack' }, rosterCard(), publicInfoCard(), rulesCard(), saveCard(), handoffsCard(), logCard());
  }

  function publicInfoCard() {
    var pi = state.publicInfo;
    var seat = h('input', { type: 'text', value: pi.seat || '', placeholder: '例如：3' });
    seat.addEventListener('change', function () { commit('记录座次', function (s) { s.publicInfo.seat = seat.value.trim(); log(s, '记录座次：' + seat.value.trim()); }); });
    var notes = h('textarea', { rows: 4, placeholder: '例如：公共池还剩面包；今晚守夜是 A、B。' });
    notes.value = pi.notes || '';
    notes.addEventListener('change', function () { commit('公共笔记', function (s) { s.publicInfo.notes = notes.value; }, { undo: false }); });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '公共信息记录')),
      h('p', { class: 'section-note' }, '公共库存、座次、日期由主持人维护权威记录；这里只手动记必要信息。'),
      h('div', { class: 'grid2' }, U.field('当前第几天', U.stepper(pi.day, function (v) { setDay(v); }, { label: '天数' })), U.field('我的座次', seat)),
      U.field('公共笔记', notes));
  }

  function rulesCard() {
    var r = state.rules;
    function toggle(key, label) {
      return h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: !!r[key], onchange: function (e) {
          var v = e.target.checked;
          commit('规则开关', function (s) { s.rules[key] = v; log(s, label + '：' + (v ? '开' : '关')); });
        }
      }), label);
    }
    function unitsField(key, label) {
      var input = h('input', { type: 'number', class: 'num', step: 0.5, min: 0, value: r[key] == null ? '' : r[key] / 2, placeholder: '待配置' });
      input.addEventListener('change', function () {
        var n = U.parseNumber(input.value, true);
        if (Number.isNaN(n) || (n != null && (n < 0 || Math.round(n * 2) !== n * 2))) { U.toast('请输入 0.5 的倍数或留空', 'warn'); return; }
        if (n == null && (key === 'inventoryCapacityTicks' || key === 'scavengeKeepTicks')) { U.toast('该项不能留空', 'warn'); return; }
        commit('修改规则', function (s) { s.rules[key] = n == null ? null : Math.round(n * 2); log(s, label + '：' + (n == null ? '待配置' : n + '单位')); });
      });
      return h('div', { class: 'rule-row' }, h('div', { class: 'rule-label' }, label), input);
    }
    function intField(key, label) {
      var input = h('input', { type: 'number', class: 'num', value: r[key] == null ? '' : r[key], placeholder: '待配置' });
      input.addEventListener('change', function () {
        var n = U.parseNumber(input.value, false);
        if (Number.isNaN(n)) { U.toast('请输入整数或留空', 'warn'); return; }
        commit('修改规则', function (s) { s.rules[key] = n; log(s, label + '：' + (n == null ? '待配置' : n)); });
      });
      return h('div', { class: 'rule-row' }, h('div', { class: 'rule-label' }, label), input);
    }
    var pack = h('textarea', { rows: 3, placeholder: '粘贴主持人发来的规则包 JSON' });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '规则（本机副本）'), h('span', { class: 'muted small' }, '以主持人通知为准')),
      h('div', { class: 'row' }, toggle('professionsEnabled', '启用职业草案'), toggle('tasksEnabled', '启用秘密任务草案'), toggle('draftStatusesEnabled', '启用候选负面状态')),
      h('div', { class: 'rules-grid' },
        unitsField('inventoryCapacityTicks', '个人总库存上限（暂定10）'),
        unitsField('scavengeKeepTicks', '搜刮自留额度（4）'),
        unitsField('eventCarryTicks', '事件携带上限默认值'),
        unitsField('watchCarryTicks', '守夜携带上限（待定）'),
        unitsField('canteenWaterTicks', '水壶内每份水占位（待定）'),
        intField('hpMax', '生命上限（待定）'),
        intField('hungerFullAt', '充盈阈值 ≥（待定）'),
        intField('hungerHungryAt', '饥饿阈值 ≤（待定）')),
      h('details', null, h('summary', null, '导入主持人规则包'),
        h('div', { class: 'stack' }, pack, h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', onclick: function () { importRulesPack(pack.value); } }, '校验并导入'),
          U.pasteButton(function (text) { pack.value = text; importRulesPack(text); })),
          h('p', { class: 'muted small' }, '只更新规则、自定义物品与玩家名单（以及包里附带的搜刮模板），不碰你的库存和状态。'))));
  }

  function importRulesPack(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { U.toast('不是有效的 JSON', 'warn'); return; }
    var v = C.validateRulesPack(data);
    if (!v.ok) { U.modal({ title: '导入失败：规则未改动', body: h('p', null, v.errors[0]) }); return; }
    commit('导入规则包', function (s) {
      applyRulesPack(s, data);
      log(s, '导入主持人规则包');
    });
    U.toast('规则包已导入', 'ok');
  }

  /** 规则包：只更新规则、自定义物品、搜刮模板与玩家名单，不碰库存和状态。粘贴导入、联机收到都走这里。 */
  function applyRulesPack(s, data) {
    s.rules = C.normalizeRules(data.rules);
    (data.customItems || []).forEach(function (d) {
      if (!d || !d.id || !d.name) return;
      var idx = s.customItems.findIndex(function (x) { return x.id === d.id; });
      if (idx >= 0) s.customItems[idx] = d;
      else s.customItems.push(d);
    });
    if (data.scavengeTemplate && Array.isArray(data.scavengeTemplate.items)) s.scavengeTemplate = data.scavengeTemplate;
    if (data.roster && Array.isArray(data.roster.players)) {
      s.roster = data.roster;
      s.otherNames = data.roster.players.filter(function (p) { return p && p.name && p.alive !== false && p.name !== s.name; }).map(function (p) { return p.name; });
    }
  }

  function saveCard() {
    var fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'offscreen' });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      U.readFileText(file).then(importSave, function (e) { U.toast(e.message, 'warn'); });
      fileInput.value = '';
    });
    var backups = store.backups();
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '存档'), store.available ? chip('自动保存到本机', 'ok') : chip('本地保存不可用：仅内存', 'danger')),
      h('p', { class: 'section-note' }, '玩家存档与主持人存档使用不同的命名空间。导入前会校验并备份旧存档，导入失败不会覆盖当前存档。'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: function () { U.downloadJSON('shelter-player-' + (state.name || 'me') + '-' + U.stamp() + '.json', state); } }, '导出 JSON'),
        h('button', { type: 'button', class: 'btn', onclick: function () { U.copyText(JSON.stringify(state)).then(function (ok) { U.toast(ok ? '已复制存档 JSON' : '复制失败', ok ? 'ok' : 'warn'); }); } }, '复制 JSON'),
        h('button', { type: 'button', class: 'btn', onclick: function () { fileInput.click(); } }, '导入文件'),
        h('button', { type: 'button', class: 'btn', onclick: pasteImport }, '粘贴导入'),
        h('button', { type: 'button', class: 'btn', onclick: undoLast, disabled: !undo.peek() }, U.icon('undo'), '撤销最近操作'),
        h('button', { type: 'button', class: 'btn danger', onclick: resetSave }, '重置'),
        fileInput),
      h('div', { class: 'card inset reset-box' },
        h('h3', null, '一键重置（删除本机缓存）'),
        h('p', { class: 'muted small' }, '删除这个浏览器里的玩家数据：正式存档、演示存档、自动备份和页面设置，然后重新载入最新页面。页面出错或想从头开始时用。删除后无法恢复。'),
        h('button', { type: 'button', class: 'btn danger', onclick: wipeAll }, '一键重置')),
      backups.length ? h('details', null, h('summary', null, '备份（' + backups.length + '）'), h('ul', { class: 'list-plain' }, backups.map(function (b, i) {
        return h('li', { class: 'row between' }, h('span', null, U.fmtTime(b.at) + ' · ' + (b.reason || '')), h('button', { type: 'button', class: 'btn small', onclick: function () { importSave(store.backups()[i].raw); } }, '恢复'));
      }))) : null,
      h('div', { class: 'card inset' },
        h('h3', null, '演示存档'),
        h('p', { class: 'muted small' }, '独立的存储位置：载入、修改、清空都不会碰到你的正式存档。'),
        slot === 'demo'
          ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: exitDemo }, '返回正式存档'), h('button', { type: 'button', class: 'btn danger', onclick: clearDemo }, '清空演示数据'))
          : h('button', { type: 'button', class: 'btn', onclick: enterDemo }, '打开演示存档')));
  }

  function wipeAll() {
    U.modal({
      title: '一键重置？',
      body: h('div', { class: 'stack' },
        h('p', null, '会删除这个浏览器里的所有玩家数据（正式存档、演示存档、自动备份、页面设置），然后重新载入页面。删除后无法恢复。'),
        h('p', { class: 'muted small' }, '主持人页的数据和语言选择不受影响。需要保留的话先导出：'),
        h('button', { type: 'button', class: 'btn', onclick: function () { U.downloadJSON('shelter-player-' + (state.name || 'me') + '-' + U.stamp() + '.json', state); } }, '先导出 JSON')),
      actions: [{ label: '取消', value: false }, { label: '删除并重新载入', kind: 'danger', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      wiping = true;
      U.wipeLocal(['shelter-playtest:player:', 'shelter-playtest:player-demo:']);
      U.reloadFresh();
    });
  }

  function importSave(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) {
      U.modal({ title: '导入失败', body: h('p', null, '不是有效的 JSON（' + e.message + '）。当前存档未改动。') });
      return;
    }
    var v = C.validateSave(data, 'shelter-player');
    if (!v.ok) {
      U.modal({ title: '导入失败：当前存档未改动', body: h('ul', null, v.errors.slice(0, 10).map(function (e) { return h('li', null, e); })) });
      return;
    }
    U.confirmBox('导入存档？', '将用导入的存档替换当前' + (slot === 'demo' ? '演示' : '正式') + '存档。当前存档会先备份。', '导入').then(function (ok) {
      if (!ok) return;
      store.backup(JSON.stringify(state), '导入前自动备份');
      undo.push('导入存档', C.clone(state));
      state = C.normalizeSave(data, 'shelter-player');
      log(state, '导入存档');
      save();
      render();
      U.toast('导入成功', 'ok');
    });
  }

  function pasteImport() {
    var ta = h('textarea', { rows: 8, placeholder: '把存档 JSON 粘贴到这里', autofocus: true });
    U.modal({ title: '粘贴导入', body: ta, actions: [{ label: '取消', value: null }, { label: '校验并导入', kind: 'primary', value: function () { return ta.value; } }] })
      .then(function (text) { if (text) importSave(text); });
  }

  function resetSave() {
    U.confirmBox('重置存档？', '会清空当前' + (slot === 'demo' ? '演示' : '正式') + '存档（先自动备份）。', '重置', 'danger').then(function (ok) {
      if (!ok) return;
      store.backup(JSON.stringify(state), '重置前自动备份');
      undo.push('重置存档', C.clone(state));
      state = slot === 'demo' ? buildDemoState() : C.newPlayerState();
      log(state, '重置存档');
      save();
      render();
    });
  }

  function switchSlot(next) {
    slot = next;
    U.writeKey(KEY_SLOT, next);
    undo.clear();
    ui.keep = {};
    ui.transfer = {};
    state = loadState();
    netSwitchSlot();
    save();
    render();
  }

  function enterDemo() { switchSlot('demo'); U.toast('已切换到演示存档（正式存档未改动）', 'ok'); }
  function exitDemo() { switchSlot('main'); U.toast('已返回正式存档', 'ok'); }

  function clearDemo() {
    U.confirmBox('清空演示数据？', '只删除演示存档，正式存档不受影响。', '清空', 'danger').then(function (ok) {
      if (!ok) return;
      new U.Store(KEY_DEMO).remove();
      switchSlot('main');
      U.toast('演示数据已清空', 'ok');
    });
  }

  function handoffsCard() {
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '交接记录（' + state.handoffs.length + '）'), h('span', { class: 'muted small' }, ' 赠予、交公、治疗他人、搜刮交公')),
      state.handoffs.length ? h('ul', { class: 'list-plain' }, state.handoffs.slice(0, 50).map(function (x) {
        return h('li', null, h('div', { class: 'muted small' }, U.fmtTime(x.at)), U.copyBlock(x.text));
      })) : h('p', { class: 'empty' }, '暂无。'));
  }

  function logCard() {
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '个人日志（' + state.log.length + '）')),
      h('ul', { class: 'log-list' }, state.log.slice(0, 300).map(function (l) {
        return h('li', null, h('span', { class: 'log-meta' }, U.fmtTime(l.at) + (l.day != null ? ' · 第' + l.day + '天' : '')), l.text);
      })));
  }

  // ================================================================ 联机
  //
  // 主持人开了联机房间时：扫码或点加入链接 → 选自己的名字 → 主持人通过。之后：
  //   - 公开信息（天数、阶段、轮到谁、计时、事件与投票、营救进度、公开结果）实时显示，天数与座次自动同步；
  //   - 轮到自己领补给时直接在页面上选，领到的自动进库存；主持人撤回时自动扣回；
  //   - 赠予已加入房间的玩家：对方库存自动增加；交公自动进公共池；治疗他人在对方页面自动生效；
  //   - 行动、守夜卡、投票直接送到主持人页；私信与事件结果进收件箱。
  // 不加入房间时一切照旧（交接文本）。同一浏览器只让一个标签页联机。

  var NET_KEY = 'shelter-playtest:player:net:';
  var NET_LOCK = 'shelter-playtest:player:netlock';
  var KEY_INBOX_READ = 'shelter-playtest:player:inbox-read:';
  var net = { cfg: null, link: null, lock: null, status: 'idle', info: null, snap: null, snapAt: 0, lobby: null, requested: false, request: null, online: [], hostOnline: false, seq: 0, journal: [], server: '' };

  function netCfgKey() {
    return NET_KEY + slot;
  }

  /** 已被主持人通过（有加入凭证）。 */
  function netJoined() {
    return !!(net.cfg && net.cfg.token && net.cfg.pid);
  }

  /** 可以通过房间发消息（断线时先排队，连上后补发）。 */
  function netLive() {
    return netJoined() && !!net.link;
  }

  function myPid() {
    return net.cfg ? net.cfg.pid : null;
  }

  function snapPlayers() {
    return net.snap && Array.isArray(net.snap.players) ? net.snap.players : [];
  }

  function snapName(pid) {
    var p = snapPlayers().filter(function (x) { return x.id === pid; })[0];
    return p ? p.name : '（不在名单里）';
  }

  /** 对方已加入房间：赠予、治疗直接送到他的页面。 */
  function netCanReach(pid) {
    return !!pid && pid !== myPid() && netLive() && !!net.snap && (net.snap.joined || []).indexOf(pid) >= 0;
  }

  /** 赠予、治疗的对象名单（主持人名单里活着的其他人）；没加入房间时返回 null，照旧手填名字。 */
  function netTargets() {
    if (!netJoined() || !net.snap) return null;
    var joined = net.snap.joined || [];
    return snapPlayers().filter(function (p) { return p.id !== myPid() && p.alive !== false; }).map(function (p) {
      return { id: p.id, name: p.name, joined: joined.indexOf(p.id) >= 0 };
    });
  }

  /**
   * 联机带来的修改（收到的物品、私信、同步的天数、已经发出去的）：不进撤销栈，记进联机日志；
   * 撤销自己的操作时，这些修改会重新套用，不会被一起撤掉。fn 要只改 s、不发消息，校验不过就抛错。
   */
  function netCommit(label, fn) {
    var ok = commit(label, fn, { undo: false });
    if (ok) {
      net.seq += 1;
      net.journal.push({ seq: net.seq, label: label, fn: fn });
      if (net.journal.length > 400) net.journal.shift();
    }
    return ok;
  }

  /** 收到网络事件时重画；正在输入时先只画顶栏，离开输入框后再画主体（不打断打字）。 */
  function netQuietRender() {
    ui.quietRender = true;
    try { render(); } finally { ui.quietRender = false; }
  }

  function inboxAdd(s, entry) {
    s.inbox = s.inbox || [];
    s.inbox.unshift(Object.assign({ id: C.uid('in'), at: Date.now(), day: s.publicInfo.day }, entry));
    if (s.inbox.length > 200) s.inbox.length = 200;
  }

  function inboxReadAt() {
    return Number(U.readKey(KEY_INBOX_READ + slot)) || 0;
  }

  function inboxUnread() {
    var t = inboxReadAt();
    return (state.inbox || []).filter(function (x) { return x.at > t; }).length;
  }

  function markInboxRead() {
    if (inboxUnread()) U.writeKey(KEY_INBOX_READ + slot, String(Date.now()));
  }

  // ---------------------------------------------------------------- 连接

  function netBoot() {
    net.lock = new ShelterNet.TabLock(NET_LOCK + ':' + slot);
    net.cfg = ShelterNet.readJSON(netCfgKey(), null);
    var join = ShelterNet.parseJoin(location.hash);
    if (join) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
      if (!net.cfg || net.cfg.code !== join.code) {
        if (net.cfg && net.cfg.token) {
          var old = net.cfg.code;
          netResume();
          U.confirmBox('加入新房间？', '这台设备已经在房间 ' + old + ' 里。加入 ' + join.code + ' 会离开原来的房间。', '加入新房间', 'primary').then(function (ok) {
            if (!ok) return;
            netLeaveLocal(null);
            netJoin(join.code, join.base);
          });
          return;
        }
        netJoin(join.code, join.base);
        return;
      }
      ui.tab = 'net';
    }
    netResume();
  }

  function netResume() {
    if (!net.cfg || !net.cfg.code) return;
    if (net.lock.mine()) netStart();
    else net.status = 'elsewhere';
  }

  /** 切换正式／演示存档：房间跟着存档走。 */
  function netSwitchSlot() {
    if (net.link) net.link.stop();
    net.link = null;
    net.status = 'idle';
    net.snap = null;
    net.lobby = null;
    net.requested = false;
    net.request = null;
    net.journal = [];
    if (net.lock) net.lock.release();
    netBoot();
  }

  function netJoin(code, base) {
    code = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) { U.toast('房间码是 5 位字母和数字', 'warn'); return; }
    net.cfg = { base: ShelterNet.serverBase(base || net.server), code: code, token: null, pid: null, name: '', at: Date.now() };
    ShelterNet.writeJSON(netCfgKey(), net.cfg);
    net.snap = null;
    net.lobby = null;
    net.requested = false;
    net.request = null;
    netStart();
    setTab('net');
  }

  function netStart() {
    if (net.link) net.link.stop();
    var cfg = net.cfg;
    net.lock.take();
    net.link = new ShelterNet.Link({
      base: cfg.base, code: cfg.code, store: 'shelter-playtest:player:netq:' + slot + ':' + cfg.code,
      hello: function () { return net.cfg && net.cfg.token ? { role: 'player', token: net.cfg.token } : { role: 'guest' }; },
      onMessage: netReceive,
      on: netEvent
    });
    net.link.start();
  }

  function netWriteCfg() {
    if (net.cfg) ShelterNet.writeJSON(netCfgKey(), net.cfg);
  }

  function netEvent(type, d) {
    switch (type) {
      case 'status':
        net.status = d.status;
        net.info = d.info;
        if (d.status === 'stopped') netStopped(d.info);
        else netQuietRender();
        return;
      case 'lobby':
        net.lobby = d;
        // 等待通过时断线重连：新连接是新的访客，自动把同一个请求再提一次
        if (net.request && net.request.gid !== d.gid) netRequest(net.request.pid, net.request.name);
        netQuietRender();
        return;
      case 'requested':
        net.requested = true;
        netQuietRender();
        return;
      case 'approved':
        net.cfg.token = d.token;
        net.cfg.pid = d.pid;
        net.cfg.name = d.name || '';
        netWriteCfg();
        net.requested = false;
        net.request = null;
        net.lobby = null;
        U.toast('主持人通过了：你是 ' + (d.name || ''), 'ok');
        return;
      case 'welcome':
        if (d.you) {
          net.cfg.pid = d.you.pid;
          net.cfg.name = d.you.name;
          netWriteCfg();
        }
        net.online = d.online || [];
        net.hostOnline = !!d.hostOnline;
        if (d.snap) netOnSnap(d.snap, true);
        else netQuietRender();
        return;
      case 'snap':
        netOnSnap(d.s, false);
        return;
      case 'presence':
        net.online = d.online || [];
        net.hostOnline = !!d.hostOnline;
        netQuietRender();
        return;
      case 'sent':
        netSent(d.id);
        return;
      case 'error':
        netError(d);
        return;
    }
  }

  function netStopped(code) {
    if (code === 'replaced') {
      net.link = null;
      net.status = 'elsewhere';
      U.toast('联机转到了另一个标签页或设备：本页不再收发联机消息', 'warn');
      render();
      return;
    }
    if (code === 'bad-token') {
      // 凭证失效（例如主持人移出后又重开）：以访客身份重新加入
      net.cfg.token = null;
      net.cfg.pid = null;
      netWriteCfg();
      U.toast('这台设备的加入凭证已失效：请重新选择你的名字', 'warn');
      netStart();
      render();
      return;
    }
    if (code === 'version') {
      U.toast('页面版本和联机服务器不一致：请刷新页面', 'warn');
      render();
      return;
    }
    var text = {
      kicked: '你被主持人移出了房间。',
      ended: '房间已经关闭。',
      rejected: '主持人没有通过你的加入请求。',
      'no-room': '房间不存在或已经过期：请核对房间码。'
    }[code] || ('联机已停止（' + code + '）');
    netLeaveLocal(text);
  }

  /** 离开房间（本机）：还没送到房间的赠予、交公把物品放回库存，清掉加入凭证。 */
  function netLeaveLocal(reason) {
    var unsent = net.link ? net.link.outbox.filter(function (f) { return f.m && (f.m.kind === 'gift' || f.m.kind === 'deposit'); }) : [];
    if (unsent.length) {
      netCommit('取回没送出的物品', function (s) {
        unsent.forEach(function (f) {
          C.receiveItems(s, f.m.items);
          delete s.netData.outgoing[f.m.id];
        });
        inboxAdd(s, { kind: 'system', from: 'system', text: '离开房间时还有没送出的物品，已放回库存：' + unsent.map(function (f) { return C.describeItems(f.m.items, s.customItems); }).join('；') });
        log(s, '离开房间：没送出的物品放回库存');
      });
    }
    if (net.link) {
      net.link.forget();
      net.link.stop();
    }
    net.link = null;
    net.cfg = null;
    net.snap = null;
    net.lobby = null;
    net.requested = false;
    net.request = null;
    net.status = 'idle';
    ShelterNet.removeKey(netCfgKey());
    if (net.lock) net.lock.release();
    if (reason) U.toast(reason, 'warn');
    render();
  }

  function netLeave() {
    U.confirmBox('离开房间？', '这台设备不再接收公开信息和消息。你的存档不受影响；之后可以用房间码重新加入（需要主持人再次通过）。', '离开房间', 'danger').then(function (ok) {
      if (ok) netLeaveLocal('已离开房间');
    });
  }

  function netRequest(pid, name) {
    if (!net.link || !net.lobby) return;
    net.request = { pid: pid || null, name: name || '', gid: net.lobby.gid };
    net.link.raw({ t: 'request', pid: pid || null, name: name || '' });
  }

  // ---------------------------------------------------------------- 公开信息

  /** 收到主持人公开的信息：天数、座次、生死、名单自动同步到本页存档。 */
  function netOnSnap(snap, first) {
    var prev = net.snap;
    net.snap = snap;
    net.snapAt = Date.now();
    var me = myPid();
    var mine = snapPlayers().filter(function (p) { return p.id === me; })[0];
    var seat = me ? snap.seats.indexOf(me) : -1;
    var others = snapPlayers().filter(function (p) { return p.id !== me && p.alive !== false; }).map(function (p) { return p.name; });
    var changes = [];
    if (snap.started && C.isInt(snap.day) && snap.day !== state.publicInfo.day) changes.push('day');
    if (seat >= 0 && state.publicInfo.seat !== String(seat + 1)) changes.push('seat');
    if (mine && mine.name && mine.name !== state.name) changes.push('name');
    if (mine && (mine.alive !== false) !== (state.alive !== false)) changes.push('alive');
    if (JSON.stringify(others) !== JSON.stringify(state.otherNames || [])) changes.push('roster');
    if (changes.length) {
      ui.quietRender = true;
      try {
        netCommit('同步公开信息', function (s) {
          if (changes.indexOf('day') >= 0) { s.publicInfo.day = snap.day; log(s, '同步主持人的天数：' + '第' + snap.day + '天'); }
          if (changes.indexOf('seat') >= 0) { s.publicInfo.seat = String(seat + 1); log(s, '同步座次：' + '第 ' + (seat + 1) + ' 座'); }
          if (changes.indexOf('name') >= 0) { log(s, '名字按主持人名单改为：' + mine.name); s.name = mine.name; }
          if (changes.indexOf('alive') >= 0) { s.alive = mine.alive !== false; log(s, s.alive ? '主持人记录：你还活着' : '主持人记录：你已死亡'); }
          if (changes.indexOf('roster') >= 0) {
            s.otherNames = others;
            s.roster = { day: snap.day, players: snapPlayers().map(function (p) { return { name: p.name, alive: p.alive !== false }; }) };
          }
        });
      } finally {
        ui.quietRender = false;
      }
    } else {
      netQuietRender();
    }
    if (first || !prev) return;
    // 轮到自己、投票开始：提醒一下
    var a0 = prev.actions;
    var a1 = snap.actions;
    if (me && a1 && a1.current === me && (!a0 || a0.current !== me) && snap.phase === 'actions') U.toast('轮到你行动了', 'info');
    if (snap.vote && snap.vote.open && !(prev.vote && prev.vote.open && prev.vote.flowId === snap.vote.flowId)) U.toast('主持人发起了投票：在「总览」或「联机」页投票', 'info');
  }

  function netTimerLeft() {
    var tm = net.snap && net.snap.timer;
    if (!tm) return null;
    return tm.running ? Math.max(0, tm.remainingMs - (Date.now() - net.snapAt)) : tm.remainingMs;
  }

  function netTick() {
    var left = netTimerLeft();
    if (left == null) return;
    var text = U.fmtClock(left);
    Array.prototype.forEach.call(document.querySelectorAll('[data-net-timer]'), function (el) { el.textContent = text; });
  }

  // ---------------------------------------------------------------- 收到的消息

  function netReceive(e) {
    var m = e.m || {};
    var fromName = e.from === 'host' ? '主持人' : (e.fromName || snapName(e.from));
    ui.quietRender = true;
    try {
      switch (m.kind) {
        case 'text': return netGotText(e, m, fromName);
        case 'rules': return netGotRules(m);
        case 'offer': return netGotOffer(m);
        case 'offer-cancel': return netGotOfferCancel(m);
        case 'grant': return netGotGrant(m);
        case 'revoke': return netGotRevoke(m);
        case 'pick-fail': return netGotPickFail(m);
        case 'effect': return netGotEffect(m);
        case 'gift': return netGotGift(e, m, fromName);
        case 'heal': return netGotHeal(e, m, fromName);
        default:
          netCommit('联机消息', function (s) { inboxAdd(s, { kind: 'system', from: e.from, fromName: fromName, text: '收到看不懂的消息（' + m.kind + '）：可能需要刷新页面' }); });
          return true;
      }
    } finally {
      ui.quietRender = false;
    }
  }

  function netGotText(e, m, fromName) {
    var text = String(m.text || '').slice(0, 2000);
    if (!text) return true;
    netCommit('收到私信', function (s) { inboxAdd(s, { kind: 'text', from: e.from, fromName: fromName, text: text }); });
    U.toast(fromName + '：' + (text.length > 40 ? text.slice(0, 40) + '…' : text), 'info');
    return true;
  }

  function netGotRules(m) {
    var v = C.validateRulesPack(m.pack);
    if (!v.ok) return true;
    netCommit('导入规则包（联机）', function (s) {
      applyRulesPack(s, m.pack);
      inboxAdd(s, { kind: 'system', from: 'host', fromName: '主持人', text: '收到主持人的规则包：规则、自定义物品与玩家名单已自动更新。' });
      log(s, '导入主持人规则包（联机）');
    });
    return true;
  }

  function netGotOffer(m) {
    if (!m.batchId || !Array.isArray(m.items)) return true;
    netCommit('补给候选', function (s) {
      s.netData.offers[m.batchId] = { batchId: m.batchId, label: String(m.label || '补给'), dayText: String(m.dayText || ''), items: m.items, at: Date.now(), pending: null };
    });
    U.toast('轮到你领取补给了：' + (m.label || ''), 'info');
    return true;
  }

  function netGotOfferCancel(m) {
    if (!state.netData.offers[m.batchId]) return true;
    netCommit('补给候选收回', function (s) { delete s.netData.offers[m.batchId]; });
    return true;
  }

  function netGotGrant(m) {
    if (!m.grantId || !Array.isArray(m.items)) return true;
    if (state.netData.grants[m.grantId]) return true; // 同一件补给只入库一次
    var what = C.describeItems(m.items, state.customItems);
    netCommit('收到补给', function (s) {
      if (s.netData.grants[m.grantId]) return false;
      C.receiveItems(s, m.items, m.grantId);
      syncLoadout(s);
      s.netData.grants[m.grantId] = { items: m.items, reason: String(m.reason || ''), at: Date.now() };
      if (m.batchId) delete s.netData.offers[m.batchId];
      inboxAdd(s, { kind: 'grant', from: 'host', fromName: '主持人', text: '收到补给：' + what + (m.reason ? '（' + m.reason + '）' : '') + '，已放进库存。' });
      log(s, '收到补给（联机）：' + what);
    });
    U.toast('收到补给：' + what + '，已放进库存', 'ok');
    return true;
  }

  function netGotRevoke(m) {
    var g = state.netData.grants[m.grantId];
    if (!g) {
      netCommit('补给撤回', function (s) { inboxAdd(s, { kind: 'system', from: 'host', fromName: '主持人', text: '主持人撤回了一件补给，但这台设备没有收到过它，库存没有改动。' }); });
      return true;
    }
    var missing = [];
    netCommit('补给撤回', function (s) {
      var gg = s.netData.grants[m.grantId];
      if (!gg) return false;
      var r = C.takeItems(s, gg.items, m.grantId);
      missing = r.missing;
      syncLoadout(s);
      delete s.netData.grants[m.grantId];
      var what = C.describeItems(gg.items, s.customItems);
      inboxAdd(s, { kind: 'revoke', from: 'host', fromName: '主持人', text: (m.reason || '主持人撤回了补给') + '：' + what + (r.missing.length ? '。库存里已经没有，没能扣回：' + C.describeItems(r.missing, s.customItems) + '（请和主持人确认）' : '，已从库存扣回。') });
      log(s, '补给被撤回（联机）：' + what + (r.missing.length ? '；没能扣回 ' + C.describeItems(r.missing, s.customItems) : ''));
    });
    U.toast(missing.length ? '主持人撤回了补给：有物品已经不在库存里，请看收件箱' : '主持人撤回了补给：已从库存扣回', 'warn');
    return true;
  }

  function netGotPickFail(m) {
    netCommit('领取没成功', function (s) {
      var o = s.netData.offers[m.batchId];
      if (o) o.pending = null;
      inboxAdd(s, { kind: 'system', from: 'host', fromName: '主持人', text: '领取没成功：' + (m.reason || '请重新选择') });
    });
    U.toast('领取没成功：' + (m.reason || '请重新选择'), 'warn');
    return true;
  }

  function netGotEffect(m) {
    netCommit('收到事件结果', function (s) {
      inboxAdd(s, { kind: 'effect', from: 'host', fromName: '主持人', text: String(m.text || ''), personal: m.personal || null, resId: m.resId || null, applied: false });
    });
    U.toast('收到事件结果：到收件箱查看', 'info');
    return true;
  }

  function netGotGift(e, m, fromName) {
    var items = (m.items || []).filter(function (it) { return it && typeof it.defId === 'string' && C.isInt(it.qty) && it.qty > 0; });
    if (!items.length) return true;
    var what = C.describeItems(items, state.customItems);
    netCommit('收到赠予', function (s) {
      C.receiveItems(s, items, 'gift:' + e.from);
      syncLoadout(s);
      inboxAdd(s, { kind: 'gift', from: e.from, fromName: fromName, text: fromName + ' 交给你：' + what + '，已放进库存。' });
      log(s, '收到 ' + fromName + ' 的赠予（联机）：' + what);
    });
    U.toast(fromName + ' 交给你：' + what, 'ok');
    return true;
  }

  var HEAL_TEXT = { 'bandage-heal': '绷带：恢复1生命', 'bandage-stop': '绷带：止血（清除一处流血伤口）', medkit: '医疗箱：清除伤病类负面状态，并恢复2生命' };

  function netGotHeal(e, m, fromName) {
    if (!HEAL_TEXT[m.effect]) return true;
    var notes = [];
    netCommit('被治疗', function (s) {
      notes = applyHeal(s, m.effect);
      inboxAdd(s, { kind: 'heal', from: e.from, fromName: fromName, text: fromName + ' 对你使用了' + HEAL_TEXT[m.effect] + '。' + (notes.length ? notes.join('；') + '。' : '') });
      log(s, fromName + ' 对你使用了' + HEAL_TEXT[m.effect] + (notes.length ? '：' + notes.join('；') : ''));
    });
    U.toast(fromName + ' 对你使用了' + HEAL_TEXT[m.effect], 'ok');
    return true;
  }

  /** 别人对你使用绷带／医疗箱：按已确认的效果自动修改（是否属伤病类待裁定的状态不自动清除）。 */
  function applyHeal(s, effect) {
    var notes = [];
    if (effect === 'bandage-heal') {
      s.hp += 1;
      notes.push('生命 → ' + s.hp);
    } else if (effect === 'bandage-stop') {
      var b = s.statuses.filter(function (st) { return st.statusId === 'bleeding'; })[0];
      if (b) {
        s.statuses = s.statuses.filter(function (st) { return st.id !== b.id; });
        notes.push('清除一处流血伤口');
      } else notes.push('你没有流血伤口：状态没有改动');
    } else if (effect === 'medkit') {
      var pending = [];
      var removed = [];
      s.statuses = s.statuses.filter(function (st) {
        var def = st.statusId ? C.getStatusDef(st.statusId) : null;
        if (def && def.injury === true) { removed.push(st.name); return false; }
        if (!def || def.injury !== false) pending.push(st.name);
        return true;
      });
      s.hp += 2;
      notes.push('生命 → ' + s.hp);
      if (removed.length) notes.push('清除 ' + removed.join('、'));
      if (pending.length) notes.push('是否属伤病类待裁定、没有自动清除：' + pending.join('、'));
    }
    return notes;
  }

  // ---------------------------------------------------------------- 发出去的

  function netSent(id) {
    if (!id || !state.netData.outgoing[id]) return;
    netCommit('送达房间', function (s) { delete s.netData.outgoing[id]; });
  }

  /** 某一条没送出（房间拒收）：赠予、交公的物品放回库存。 */
  function netError(d) {
    var out = d.id ? state.netData.outgoing[d.id] : null;
    if (out) {
      netCommit('取回没送出的物品', function (s) {
        var o = s.netData.outgoing[d.id];
        if (!o) return false;
        C.receiveItems(s, o.items);
        delete s.netData.outgoing[d.id];
        inboxAdd(s, { kind: 'system', from: 'system', text: '没送出（' + (d.message || d.code) + '）：' + C.describeItems(o.items, s.customItems) + ' 已放回库存。' });
        log(s, '联机没送出，物品放回库存：' + C.describeItems(o.items, s.customItems));
      });
      U.toast('没送出：物品已放回库存', 'warn');
      return;
    }
    if (d.code !== 'not-joined') U.toast(d.message || d.code, 'warn');
  }

  function netUp(m) {
    return net.link ? net.link.post({ t: 'up', m: m }) : null;
  }

  /** 今天的行动：发给主持人页（轮到你时自动记录）。 */
  function netReportAction(type) {
    if (!netLive()) return;
    var acts = net.snap && net.snap.actions;
    if (acts && acts.acted.indexOf(myPid()) >= 0) {
      U.toast('主持人已经记录了你今天的行动：要改请直接找主持人', 'warn');
      return;
    }
    if (type) netUp({ kind: 'action', type: type, day: today(), note: state.action.note || '' });
    else netUp({ kind: 'action-cancel', day: today() });
  }

  function netSendWatch(plan) {
    if (!netLive() || plan.chosen == null) return;
    netUp({ kind: 'watch', data: { v: 2, day: plan.day, from: state.name || '', card: plan.cards[plan.chosen] } });
    netCommit('守夜卡已发出', function (s) {
      if (!s.watchPlan) return false;
      s.watchPlan.sentAt = Date.now();
      s.watchPlan.sentChoice = s.watchPlan.chosen;
      log(s, '守夜卡（' + '第 ' + (s.watchPlan.chosen + 1) + ' 张' + '）通过房间交给主持人');
    });
    U.toast('已交给房间：主持人页会自动加入候选', 'ok');
  }

  function netVote(flowId, optionId, label) {
    if (!netLive()) return;
    netUp({ kind: 'vote', flowId: flowId, optionId: optionId });
    netCommit('投票', function (s) {
      s.netData.ballots[flowId] = optionId;
      log(s, '投票：' + label);
    });
  }

  function netPick(offer, piece) {
    U.confirmBox('领取「' + piece.name + '」？', '交给主持人页确认后会自动放进你的库存。', '领取', 'primary').then(function (ok) {
      if (!ok || !netLive()) return;
      netUp({ kind: 'supply-pick', batchId: offer.batchId, pieceId: piece.id });
      netCommit('领取补给', function (s) {
        var o = s.netData.offers[offer.batchId];
        if (!o) return false;
        o.pending = piece.id;
        log(s, '领取补给：选择 ' + piece.name + '（等主持人页确认）');
      });
    });
  }

  /**
   * 赠予、交公直接送出时：在扣库存的同一次 netCommit 里记下 outgoing（房间收下前送不出去就放回库存），
   * commit 成功后再 netPostItems。直接送出的扣库存不能撤销（对方已经收到了），所以走 netCommit。
   */
  function recordOutgoing(s, id, kind, to, toName, items) {
    s.netData.outgoing[id] = { kind: kind, to: to, toName: toName || '', items: items, at: Date.now() };
  }

  function netPostItems(id, kind, to, items, note) {
    if (kind === 'gift') net.link.post({ t: 'p2p', to: to, m: { id: id, kind: 'gift', items: items, day: today() } });
    else net.link.post({ t: 'up', m: { id: id, kind: 'deposit', items: items, day: today(), reason: note || '' } });
  }

  function netSendHeal(pid, effect) {
    net.link.post({ t: 'p2p', to: pid, m: { kind: 'heal', effect: effect, text: HEAL_TEXT[effect], day: today() } });
  }

  function netSendNote(text) {
    if (!netLive() || !text) return;
    netUp({ kind: 'note', text: text });
    netCommit('给主持人留言', function (s) {
      inboxAdd(s, { kind: 'note', from: 'me', fromName: '我', text: '发给主持人：' + text });
      log(s, '给主持人留言：' + text);
    });
    U.toast('已交给房间：主持人页会显示', 'ok');
  }

  /** 收件箱里的事件结果：点「应用」按个人效果改自己的存档（这是自己的操作，可以撤销）。 */
  function applyEffect(entryId) {
    commit('应用事件结果', function (s) {
      var x = s.inbox.filter(function (i) { return i.id === entryId; })[0];
      if (!x || x.applied) return false;
      var notes = C.applyPersonalEffects(s, x.personal, s.publicInfo.day);
      syncLoadout(s);
      x.applied = true;
      log(s, '应用事件结果：' + (notes.length ? notes.join('；') : '没有个人效果'));
    });
  }

  // ---------------------------------------------------------------- 显示

  function netStatusText() {
    var map = {
      online: ['在线', 'ok'], connecting: ['连接中…', 'info'], reconnecting: ['重连中…', 'warn'], lobby: ['加入中', 'info'],
      idle: ['未连接', ''], stopped: ['已停止', 'danger'], elsewhere: ['在另一个标签页联机', 'info']
    };
    var x = map[net.status] || [net.status, ''];
    return { text: x[0], cls: x[1] };
  }

  /** 顶栏小标签：在房间里时显示状态和未读消息数。 */
  function netChip() {
    if (!net.cfg) return null;
    var unread = inboxUnread();
    var st = netStatusText();
    // 手机上只显示圆点和未读数（文字收起，读屏软件读 aria-label）
    return h('button', { type: 'button', class: 'net-chip st-' + net.status, onclick: function () { setTab('net'); }, title: '联机房间 ' + net.cfg.code, 'aria-label': '联机房间 ' + net.cfg.code + '：' + st.text + (unread ? '，' + unread + ' 条未读' : '') },
      h('span', { class: 'net-dot' }), h('span', { class: 'net-chip-text' }, net.status === 'online' ? '联机' : st.text),
      unread ? h('span', { class: 'net-unread' }, String(unread)) : null);
  }

  function renderNet() {
    markInboxRead();
    if (!net.cfg) return h('div', { class: 'stack' }, netJoinCard(), netHelpCard());
    if (!netJoined()) return h('div', { class: 'stack' }, netLobbyCard(), netHelpCard());
    return h('div', { class: 'stack' },
      netRoomCard(),
      netLivePanel(true),
      netInboxCard(),
      netNoteCard(),
      netHelpCard());
  }

  function netJoinCard() {
    var code = h('input', { type: 'text', class: 'net-code-input', placeholder: '例如 K7M2Q', maxlength: 8, autocapitalize: 'characters', autocomplete: 'off', 'aria-label': '房间码' });
    var server = h('input', { type: 'text', value: net.server || '', placeholder: ShelterNet.DEFAULT_SERVER });
    server.addEventListener('change', function () { net.server = server.value.trim(); });
    code.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); netJoin(code.value, net.server); } });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '加入联机房间')),
      h('p', null, '主持人开了房间时，扫主持人给的二维码或点加入链接就能进来；也可以在这里输入房间码。'),
      h('div', { class: 'row' }, code, h('button', { type: 'button', class: 'btn primary', onclick: function () { netJoin(code.value, net.server); } }, '加入')),
      h('p', { class: 'muted small' }, '加入后：公开信息实时显示；领到的补给、别人赠予的物品自动进库存；行动、投票、守夜卡直接交给主持人。不加入也能照常使用本页。'),
      ShelterNet.lan() ? null : h('details', null, h('summary', null, '自定义服务器地址（一般不用改）'), U.field('服务器', server, '留空＝默认云端服务器')));
  }

  function netLobbyCard() {
    var st = netStatusText();
    var lobby = net.lobby;
    var head = h('div', { class: 'card-head' }, h('h2', null, '加入房间 ' + net.cfg.code), chip(st.text, st.cls));
    var cancel = h('button', { type: 'button', class: 'btn small', onclick: function () { netLeaveLocal(null); } }, '取消加入');
    if (net.status === 'elsewhere') {
      return h('section', { class: 'card' }, head, h('p', null, '另一个标签页正在用这个房间。'),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: function () { netStart(); render(); } }, '改在本页联机'), cancel));
    }
    if (net.requested) {
      return h('section', { class: 'card' }, head,
        h('p', { class: 'net-wait' }, '已经提出加入请求，等主持人通过…'),
        h('p', { class: 'muted small' }, '主持人通过后自动进入；可以先去别的页看看。'),
        h('div', { class: 'row' }, cancel));
    }
    if (!lobby) {
      return h('section', { class: 'card' }, head, h('p', null, net.status === 'reconnecting' ? '连不上联机服务器，正在重试…' : '正在连接…'),
        h('p', { class: 'muted small' }, '服务器：' + net.cfg.base.replace(/^https?:\/\//, '')), h('div', { class: 'row' }, cancel));
    }
    var roster = lobby.roster || [];
    var nameInput = h('input', { type: 'text', placeholder: '你的名字', value: state.name || '' });
    return h('section', { class: 'card' }, head,
      roster.length ? h('p', null, '你是谁？点自己的名字，主持人通过后就加入了。') : h('p', null, '主持人还没公布玩家名单：填上你的名字提出请求，由主持人对上号。'),
      roster.length ? h('div', { class: 'net-roster' }, roster.map(function (p) {
        return h('button', { type: 'button', class: 'btn net-name' + (p.name === state.name ? ' primary' : ''), 'data-roster': p.id, onclick: function () { netRequest(p.id, p.name); } },
          p.name, p.joined ? h('span', { class: 'muted small' }, '（已有设备）') : null, p.alive === false ? h('span', { class: 'muted small' }, '（已死亡）') : null);
      })) : h('div', { class: 'row' }, nameInput, h('button', {
        type: 'button', class: 'btn primary', onclick: function () {
          if (!nameInput.value.trim()) { U.toast('请填写名字', 'warn'); return; }
          netRequest(null, nameInput.value.trim());
        }
      }, '提出请求')),
      lobby.hostOnline ? null : h('p', { class: 'muted small' }, '主持人现在不在线：请求会在主持人回来后显示。'),
      h('p', { class: 'muted small' }, '选了已有设备的名字：主持人通过后，那台设备会断开（换手机时用）。'),
      h('div', { class: 'row' }, cancel));
  }

  function netRoomCard() {
    var st = netStatusText();
    var pending = net.link && net.status !== 'online' ? net.link.pending() : 0;
    return h('section', { class: 'card net-room' },
      h('div', { class: 'card-head' }, h('h2', null, '联机房间 ' + net.cfg.code), chip(st.text, st.cls)),
      h('p', null, '你是 ', h('b', null, net.cfg.name || state.name || '?'), net.hostOnline ? '' : h('span', { class: 'muted small' }, '（主持人暂时不在线：消息会先存在房间里）')),
      pending ? h('p', { class: 'muted small' }, '待发 ' + pending + ' 条：连上后自动补发。') : null,
      h('div', { class: 'row' },
        net.status === 'elsewhere' || net.status === 'stopped' ? h('button', { type: 'button', class: 'btn primary', onclick: function () { netStart(); render(); } }, '改在本页联机') : null,
        h('button', { type: 'button', class: 'btn small', onclick: netLeave }, '离开房间')));
  }

  /** 公开信息面板。full：联机页的完整版；否则是总览页上的精简版（只放要你动手的和最要紧的）。 */
  function netLivePanel(full) {
    var snap = net.snap;
    if (!snap) return h('section', { class: 'card pn-live' }, h('p', { class: 'muted' }, '等主持人公开信息…'));
    var me = myPid();
    var parts = [];
    var phase = snap.started ? '第 ' + snap.day + ' 天' + ' · ' + (snap.phaseNo != null ? '阶段' + snap.phaseNo + ' ' : '') + snap.phaseName : '游戏还没开始';
    parts.push(h('div', { class: 'pn-head' },
      h('div', { class: 'pn-phase' }, phase),
      snap.timer && (snap.timer.running || snap.timer.remainingMs !== snap.timer.durationMs) ? h('div', { class: 'pn-timer' + (snap.timer.running ? ' running' : '') }, U.icon('timer'), h('span', { 'data-net-timer': '1' }, U.fmtClock(netTimerLeft() || 0))) : null));
    if (full && snap.phaseDesc) parts.push(h('p', { class: 'muted small' }, snap.phaseDesc));
    var acts = snap.actions;
    if (acts && snap.phase === 'actions') {
      var myTurn = acts.current === me;
      var done = acts.acted.indexOf(me) >= 0;
      parts.push(h('div', { class: 'pn-turn' + (myTurn ? ' me' : '') },
        myTurn ? h('b', null, '轮到你行动了') : h('span', null, acts.current ? '正在行动：' + snapName(acts.current) : '本轮行动已结束'),
        done ? chip('你的行动已记录', 'ok') : state.action.day === today() && state.action.used ? chip('已选：' + actionName(state.action.type) + '（轮到你时自动记录）', 'info') : null,
        myTurn && !(state.action.day === today() && state.action.used) ? h('button', { type: 'button', class: 'btn small primary', onclick: function () { setTab('action'); } }, '去选择行动') : null));
      if (full) {
        parts.push(h('ol', { class: 'pn-order' }, acts.order.map(function (id) {
          var cls = (acts.acted.indexOf(id) >= 0 ? 'done' : id === acts.current ? 'current' : '') + (id === me ? ' me' : '');
          return h('li', { class: cls }, snapName(id), acts.acted.indexOf(id) >= 0 ? ' ✓' : '');
        })));
      }
    }
    var offers = Object.keys(state.netData.offers).map(function (k) { return state.netData.offers[k]; });
    offers.forEach(function (o) {
      parts.push(h('div', { class: 'pn-offer', 'data-offer': o.batchId },
        h('div', null, h('b', null, '轮到你领取：' + o.label), o.dayText ? h('span', { class: 'muted small' }, ' ' + o.dayText) : null),
        o.pending ? h('p', { class: 'small' }, '已选，等主持人页确认…') : h('p', { class: 'muted small' }, '点一件领取；领到的自动放进库存。'),
        h('div', { class: 'pn-items' }, o.items.map(function (p) {
          return h('button', { type: 'button', class: 'btn' + (o.pending === p.id ? ' primary' : ''), disabled: !!o.pending, 'data-piece': p.id, onclick: function () { netPick(o, p); } }, p.name);
        }))));
    });
    if (full && snap.batches && snap.batches.length) {
      parts.push(h('ul', { class: 'list-plain pn-batches' }, snap.batches.map(function (b) {
        return h('li', null, h('b', null, b.label), ' · ' + (b.next ? '下一位领取：' + snapName(b.next) : '已领完') + '（已领 ' + b.picked.length + '／' + b.order.length + '）');
      })));
    }
    if (snap.event) parts.push(netEventBlock(snap, full));
    if (full) {
      parts.push(h('div', { class: 'pn-rescue' }, h('b', null, '营救进度 '), String(snap.rescue.progress), snap.rescue.target != null ? '／' + snap.rescue.target : '（阈值未知）'));
      if (snap.watch) parts.push(h('p', null, h('b', null, '今晚守夜：'), snap.watch.names.join('、') || '（无）'));
      if (snap.seats && snap.seats.length) {
        parts.push(h('div', null, h('b', null, '座次 '), h('span', { class: 'pn-seats' }, snap.seats.map(function (id, i) {
          return h('span', { class: 'pn-seat' + (id === me ? ' me' : '') }, (i + 1) + '. ' + snapName(id));
        }))));
      }
      if (snap.poolCount != null) parts.push(h('p', { class: 'muted small' }, '公共池剩余 ' + snap.poolCount + ' 件'));
      if (snap.feed && snap.feed.length) {
        parts.push(h('div', null, h('h3', null, '公开结果'), h('ul', { class: 'pn-feed' }, snap.feed.slice().reverse().slice(0, 12).map(function (f) {
          return h('li', null, h('span', { class: 'muted small' }, '第' + f.day + '天'), ' ', f.text);
        }))));
      }
    }
    return h('section', { class: 'card pn-live' + (full ? ' full' : '') }, full ? h('div', { class: 'card-head' }, h('h2', null, '公开信息'), chip(netStatusText().text, netStatusText().cls)) : null, parts);
  }

  function netEventBlock(snap, full) {
    var ev = snap.event;
    var vote = snap.vote && snap.vote.flowId === ev.flowId ? snap.vote : null;
    var mine = vote ? state.netData.ballots[vote.flowId] : null;
    var alive = snapPlayers().filter(function (p) { return p.alive !== false; }).length;
    var meAlive = state.alive !== false;
    return h('div', { class: 'pn-event' },
      h('div', { class: 'pn-event-title' }, h('b', null, '公共事件：' + ev.name), ev.location ? h('span', { class: 'muted small' }, ' · ' + ev.location) : null),
      full || !vote || !vote.open ? (ev.body ? h('p', { class: 'small' }, ev.body) : null) : null,
      vote ? h('div', { class: 'pn-vote' },
        vote.open
          ? h('p', { class: 'small' }, '投票中：已投 ' + vote.voters.length + '／' + alive + (vote.voters.indexOf(myPid()) >= 0 ? '（你已投，可以改票）' : ''))
          : h('p', { class: 'small' }, '投票结束' + (vote.result ? '：结果「' + (vote.options.filter(function (o) { return o.id === vote.result; })[0] || { label: '?' }).label + '」' : '')),
        h('div', { class: 'pn-vote-btns' }, vote.options.map(function (o) {
          var count = vote.counts ? vote.counts[o.id] : null;
          return h('button', {
            type: 'button', class: 'btn pn-vote-btn' + (mine === o.id ? ' primary' : ''), 'data-vote': o.id,
            disabled: !vote.open || !meAlive, 'aria-pressed': mine === o.id ? 'true' : 'false',
            onclick: function () { netVote(vote.flowId, o.id, o.letter + '. ' + o.label); }
          }, h('b', null, o.letter), ' ' + o.label, count != null ? h('span', { class: 'pn-count' }, count + ' 票') : null);
        })),
        meAlive ? null : h('p', { class: 'muted small' }, '已死亡的玩家不能投票。'))
        : (ev.options && ev.options.length ? h('p', { class: 'muted small' }, '投票选项：' + ev.options.map(function (o, i) { return String.fromCharCode(65 + i) + '. ' + o; }).join(' ／ ') + '（在 Discord 投票）') : null));
  }

  /** 总览页顶部：在房间里时显示现场情况（要你动手的排在前面）。 */
  function netLiveCard() {
    if (!netJoined()) return null;
    var unread = inboxUnread();
    var panel = netLivePanel(false);
    panel.insertBefore(h('div', { class: 'card-head' }, h('h2', null, '联机 · 现场'),
      h('span', { class: 'row tight' },
        unread ? h('button', { type: 'button', class: 'btn small primary', onclick: function () { setTab('net'); } }, '收件箱 ' + unread + ' 条新消息') : null,
        linkBtn('详情', 'net'))), panel.firstChild);
    return panel;
  }

  function netInboxCard() {
    var list = state.inbox || [];
    var kindNames = { text: '私信', grant: '补给', revoke: '已撤回', gift: '收到赠予', heal: '治疗', effect: '事件结果', system: '系统', note: '留言' };
    return h('section', { class: 'card pn-inbox' },
      h('div', { class: 'card-head' }, h('h2', null, '收件箱'), h('span', { class: 'muted small' }, list.length + ' 条')),
      list.length ? h('ul', { class: 'list-plain' }, list.slice(0, 80).map(function (x) {
        return h('li', { class: 'pn-msg k-' + x.kind, 'data-inbox': x.id },
          h('div', { class: 'pn-msg-meta' }, chip(kindNames[x.kind] || x.kind, x.kind === 'grant' || x.kind === 'gift' || x.kind === 'heal' ? 'ok' : x.kind === 'revoke' ? 'warn' : ''),
            h('span', { class: 'muted small' }, (x.fromName ? x.fromName + ' · ' : '') + U.fmtTime(x.at))),
          h('div', { class: 'pn-msg-text' }, x.text),
          x.kind === 'effect' && x.personal ? (x.applied ? chip('已应用', 'ok')
            : h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small primary', onclick: function () { applyEffect(x.id); } }, '应用到我的存档'),
              h('span', { class: 'muted small' }, '不是给你的效果就不用点'))) : null);
      })) : h('p', { class: 'empty' }, '还没有消息。主持人的私信、领到的补给、别人的赠予都会出现在这里。'));
  }

  function netNoteCard() {
    var box = h('textarea', { rows: 2, placeholder: '例如：我想用子弹换水，可以吗？' });
    box.value = ui.drafts.netNote || '';
    box.addEventListener('input', function () { ui.drafts.netNote = box.value; });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '给主持人留言')),
      box,
      h('div', { class: 'row' }, h('button', {
        type: 'button', class: 'btn', onclick: function () {
          var text = (ui.drafts.netNote || '').trim();
          if (!text) { U.toast('请先输入内容', 'warn'); return; }
          ui.drafts.netNote = '';
          netSendNote(text);
        }
      }, '发送')),
      h('p', { class: 'muted small' }, '只有主持人看得到。主持人不在线时先存在房间里。'));
  }

  function netHelpCard() {
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '联机怎么用')),
      h('ul', null,
        h('li', null, '扫主持人的二维码或点加入链接 → 选自己的名字 → 主持人通过。'),
        h('li', null, '天数、座次、名单自动和主持人同步；轮到你行动、领补给、投票时页面会提醒。'),
        h('li', null, '领到的补给、别人赠予的物品自动放进库存；交公、赠予已加入房间的玩家时自动从你的库存扣除并送到对方。'),
        h('li', null, '对方没加入房间时，照旧生成交接文本。'),
        h('li', null, '断线不要紧：消息先存在房间里，重新连上后自动补收、补发。')));
  }


  // ================================================================ 启动

  function boot() {
    var tab = U.readKey(KEY_TAB);
    tab = TAB_ALIASES[tab] || tab;
    U.i18n.setLang(U.i18n.getLang());
    document.title = U.T(PAGE_TITLE);
    if (tab && TABS.some(function (t) { return t.id === tab; })) ui.tab = tab;
    state = loadState();
    netBoot();
    // 点击「更多」面板以外的地方时收起
    document.addEventListener('click', function (e) {
      // 点击后被重绘掉的按钮已脱离文档，不能据此判断是「点在外面」
      if (ui.moreOpen && e.target.isConnected && !e.target.closest('#tabs')) { ui.moreOpen = false; renderTabs(); }
    });
    if (state.scavenge && state.scavenge.status === 'running') {
      if (C.settleScavenge(state.scavenge, Date.now(), state.customItems, Math.random)) log(state, '搜刮：离开期间已超时的回合按默认项记录');
    }
    save();
    render();
    scavTimer = setInterval(scavTick, 100);
    setInterval(netTick, 500);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      scavTick();
      if (net.link) net.link.wake();
    });
    window.addEventListener('online', function () { if (net.link) net.link.wake(); });
    // 联机消息来时正在输入：离开输入框（且没在点按钮）后再补画主体
    document.addEventListener('focusout', function () { if (ui.mainStale) setTimeout(flushStale, 300); });
    document.addEventListener('pointerdown', function () { ui.pointerDown = true; }, true);
    document.addEventListener('pointerup', function () { ui.pointerDown = false; if (ui.mainStale) setTimeout(flushStale, 80); }, true);
    window.addEventListener('storage', function (e) {
      if (e.key === (slot === 'demo' ? KEY_DEMO : KEY_MAIN)) {
        notices.push({ kind: 'risk', text: '另一个标签页修改了同一份玩家存档。请只保留一个标签页，然后刷新本页。' });
        render();
      }
    });
  }

  boot();
})();
