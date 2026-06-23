/* =====================================================================
 *  NEURON · Centro de Mando Neuronal — lógica principal
 * ===================================================================== */
(function () {
  "use strict";
  const C = window.NEURON, H = window.NEURON_H, AGENTS = window.NEURON_AGENTS;
  const $ = (s) => document.querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "neuron-auth" }
  });

  // ---------- estado ----------
  const state = {
    data: {}, agg: {}, findings: [], byClient: {}, byAgentSev: {},
    lastRefresh: 0, autoTimer: null, autoOn: true, realtimeOk: false, channel: null, charts: {},
  };
  const LS = {
    off: new Set(JSON.parse(localStorage.getItem("neuron-agents-off") || "[]")),
    ack: new Set(JSON.parse(localStorage.getItem("neuron-acks") || "[]")),
    saveOff() { localStorage.setItem("neuron-agents-off", JSON.stringify([...this.off])); },
    saveAck() { localStorage.setItem("neuron-acks", JSON.stringify([...this.ack])); },
  };
  let findFilter = { sev: "all", agent: "all" };
  const SEV = { crit: 4, high: 3, med: 2, info: 1 };
  const SEVNAME = { crit: "Crítico", high: "Alto", med: "Medio", info: "Info" };
  const SEVCOLOR = { crit: "var(--crit)", high: "var(--high)", med: "var(--med)", info: "var(--info)" };

  /* ================= AUTH ================= */
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#loginBtn"), err = $("#loginErr");
    err.textContent = ""; btn.disabled = true; btn.textContent = "Entrando…";
    const { error } = await sb.auth.signInWithPassword({
      email: $("#email").value.trim(), password: $("#password").value });
    btn.disabled = false; btn.textContent = "Entrar al panel";
    if (error) { err.textContent = traducirError(error.message); return; }
    await boot();
  });
  function traducirError(m) {
    if (/invalid login/i.test(m)) return "Correo o contraseña incorrectos.";
    if (/email not confirmed/i.test(m)) return "Email sin confirmar.";
    return m;
  }
  $("#logoutBtn").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });

  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); return; }
    // verificar rol
    state.userId = session.user.id;
    const { data: prof } = await sb.from("profiles").select("role,full_name").eq("id", session.user.id).maybeSingle();
    if (!prof || prof.role !== "admin") {
      await sb.auth.signOut();
      $("#login").classList.remove("hidden"); $("#app").classList.add("hidden");
      const err = $("#loginErr"); if (err) err.textContent = "Acceso reservado a administración.";
      return;
    }
    state.adminName = prof.full_name || "";
    $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
    buildToolbarFilters(); renderRoster(); setupRealtime(); startAuto(); tickClock(); initJarvis();
    $("#directive").value = localStorage.getItem("neuron-directive") || "";
    $("#directive").addEventListener("input", (e) => localStorage.setItem("neuron-directive", e.target.value));
    pingSites();
    await refresh();
  }

  /* ================= FETCH ================= */
  const sel = (t, cols, opts) => sb.from(t).select(cols).limit((opts && opts.limit) || 5000)
    .order((opts && opts.order) || "created_at", { ascending: false });

  async function fetchAll() {
    const q = await Promise.allSettled([
      sb.from("profiles").select("id,full_name,email,role,status,created_at"),
      sb.from("clients").select("id,user_id,assigned_agent_id,full_name,email,status,crm_status,initial_capital,current_balance,total_profit,created_at"),
      sb.from("movements").select("id,client_id,type,amount,currency,status,created_at,proof_path").limit(5000),
      sb.from("withdrawals").select("id,client_id,amount,currency,status,requested_at,reviewed_at,destination_account,created_at").limit(5000),
      sb.from("operations").select("id,client_id,agent_id,asset_name,operation_type,invested_amount,profit_loss,profitability,status,opened_at,closed_at,created_at").limit(5000),
      sb.from("support_tickets").select("id,client_id,subject,status,created_at,updated_at"),
      sb.from("audit_logs").select("id,user_id,action,entity_type,entity_id,created_at").order("created_at", { ascending: false }).limit(80),
      sb.from("documents").select("client_id"),
      sb.from("market_prices").select("symbol,price,updated_at"),
      // --- backend 24/7 (tablas neuron_*; vacías si no se aplicó la migración) ---
      sb.from("neuron_findings").select("id,agent_id,severity,title,detail,status,created_at").in("status", ["open", "ack"]).order("created_at", { ascending: false }).limit(500),
      sb.from("neuron_metrics_daily").select("day,aum,total_profit,deposited,withdrawn,net_flow,clients_total").order("day", { ascending: true }).limit(400),
      sb.from("neuron_agents").select("id,last_run_at,enabled"),
      sb.from("leads").select("id,email,full_name,status,source,created_at").order("created_at", { ascending: false }).limit(5000),
      sb.from("neuron_action_requests").select("id,source,action_type,summary,params,risk,status,result,created_at").order("created_at", { ascending: false }).limit(60),
      sb.from("agent_tasks").select("id,agent_id,title,detail,status,priority,due,created_at").order("created_at", { ascending: false }).limit(200),
    ]);
    const val = (i) => (q[i].status === "fulfilled" && !q[i].value.error) ? (q[i].value.data || []) : [];
    state.data = {
      profiles: val(0), clients: val(1), movements: val(2), withdrawals: val(3),
      operations: val(4), tickets: val(5), audit: val(6), documents: val(7), market_prices: val(8),
      serverFindings: val(9), metricsDaily: val(10), neuronAgents: val(11), leads: val(12), actions: val(13), tasks: val(14),
    };
    state.byClient = {}; state.data.clients.forEach(c => state.byClient[c.id] = c);
    state.loaded = true;
  }

  /* ================= AGREGADOS ================= */
  function computeAgg() {
    const d = state.data, b = H.bucket, today = H.isToday, A = {};
    const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

    const deps = d.movements.filter(m => /deposit|ingreso/i.test(m.type || "deposit"));
    const depsToday = deps.filter(m => today(m.created_at));
    A.depositsTodayCount = depsToday.length;
    A.depositedTodayConfirmed = sum(depsToday.filter(m => b(m.status) === "done"), m => m.amount);
    const depsPend = deps.filter(m => b(m.status) === "pending");
    A.depositsPendingCount = depsPend.length;
    A.depositsPendingEur = sum(depsPend, m => m.amount);
    const inflowToday = sum(depsToday.filter(m => b(m.status) !== "rejected"), m => m.amount);

    const wToday = d.withdrawals.filter(w => today(w.requested_at || w.created_at));
    A.withdrawalsTodayCount = wToday.length;
    A.withdrawalsTodayEur = sum(wToday, w => w.amount);
    const wPend = d.withdrawals.filter(w => b(w.status) === "pending");
    A.withdrawalsPendingCount = wPend.length;
    A.withdrawalsPendingEur = sum(wPend, w => w.amount);
    const outflowToday = sum(wToday.filter(w => b(w.status) !== "rejected"), w => w.amount);
    A.netFlowToday = inflowToday - outflowToday;

    A.aum = sum(d.clients, c => c.current_balance);
    A.totalInitial = sum(d.clients, c => c.initial_capital);
    A.totalProfit = sum(d.clients, c => c.total_profit);
    A.clientCount = d.clients.length;
    A.activeClients = d.clients.filter(c => /active|activo/i.test(c.status || "")).length;
    A.potentialCount = d.clients.filter(c => /potential|potencial|lead/i.test((c.status || "") + (c.crm_status || ""))).length;
    A.newClientsToday = d.clients.filter(c => today(c.created_at)).length;
    A.clientsNoAgent = d.clients.filter(c => !c.assigned_agent_id).length;

    A.activeAgents = d.profiles.filter(p => p.role === "agent" && /active|activo/i.test(p.status || "")).length;
    A.totalAgents = d.profiles.filter(p => p.role === "agent").length;

    A.opsOpen = d.operations.filter(o => b(o.status) !== "done" && (o.status || "").toLowerCase() !== "closed").length;
    A.opsClosed = d.operations.length - A.opsOpen;
    A.opsToday = d.operations.filter(o => today(o.opened_at || o.created_at)).length;
    A.opsPnl = sum(d.operations, o => o.profit_loss);
    A.avgProfit = d.operations.length ? (sum(d.operations, o => o.profitability) / d.operations.length) : 0;

    A.ticketsOpen = d.tickets.filter(t => /abierto|open|pendiente|pending/i.test(t.status || "")).length;
    A.activityToday = d.audit.filter(a => today(a.created_at)).length;

    A.docsByClient = {}; d.documents.forEach(x => A.docsByClient[x.client_id] = (A.docsByClient[x.client_id] || 0) + 1);
    const leads = d.leads || [];
    A.leadsTotal = leads.length;
    A.leadsToday = leads.filter(l => today(l.created_at)).length;
    A.leadsNew = leads.filter(l => /new|nuevo/i.test(l.status || "")).length;

    A.sitePings = state.agg.sitePings || [];
    A.realtimeOk = state.realtimeOk;
    A.goal = computeGoal();
    state.agg = A;
  }

  function computeGoal() {
    const G = C.GOAL; if (!G) return null;
    const today = new Date();
    const start = new Date(G.startDate + "T00:00:00");
    const end = new Date(G.deadline + "T23:59:59");
    const DAY = 86400000;
    const totalDays = Math.max(1, Math.round((end - start) / DAY));
    const elapsed = Math.max(1, Math.min(totalDays, Math.round((today - start) / DAY)));
    const remaining = Math.max(0, Math.round((end - today) / DAY));
    // personas logradas desde el inicio = clientes + leads, sin duplicar por email
    const since = (arr) => (arr || []).filter(x => x.created_at && new Date(x.created_at) >= start);
    const clientsSince = since(state.data.clients);
    const emails = new Set();
    clientsSince.forEach(c => { if (c.email) emails.add(c.email.toLowerCase()); });
    since(state.data.leads).forEach(l => { if (l.email) emails.add(l.email.toLowerCase()); });
    const clientsNoEmail = clientsSince.filter(c => !c.email).length;
    const current = emails.size + clientsNoEmail;
    const target = G.target, left = Math.max(0, target - current);
    const perDayNeeded = remaining > 0 ? left / remaining : left;
    const expected = Math.round(target * (elapsed / totalDays));
    const paceDay = current / elapsed;
    const projection = Math.round(paceDay * totalDays);
    const pct = Math.min(100, (current / target) * 100);
    let status = "ok";
    if (current < expected * 0.7) status = "bad"; else if (current < expected) status = "warn";
    return { target, current, left, remaining, totalDays, elapsed, expected, projection, pct, paceDay,
      perDayNeeded, perWeekNeeded: perDayNeeded * 7, perMonthNeeded: perDayNeeded * 30, status };
  }

  /* ================= AGENTES ================= */
  function runAgents() {
    const ctx = { data: state.data, agg: state.agg, SLA: C.SLA, byClient: state.byClient, GOAL: C.GOAL, ICP: C.ICP };
    // 1) hallazgos EN VIVO (motor del navegador)
    const live = [];
    AGENTS.forEach(a => {
      if (LS.off.has(a.id)) return;
      let res = [];
      try { res = a.run(ctx) || []; } catch (e) { console.error("Agente", a.id, e); }
      res.forEach(fnd => {
        fnd.agentId = a.id; fnd.agentName = a.name; fnd.agentIcon = a.icon;
        fnd.source = "live"; fnd.key = a.id + "|" + fnd.title;
        fnd.acked = LS.ack.has(fnd.key);
        live.push(fnd);
      });
    });
    // 2) hallazgos PERSISTIDOS por el backend 24/7
    const agMap = {}; AGENTS.forEach(a => agMap[a.id] = a);
    const server = (state.data.serverFindings || [])
      .filter(s => !LS.off.has(s.agent_id))
      .map(s => { const a = agMap[s.agent_id] || { name: s.agent_id, icon: "🛰️" };
        return { sev: s.severity, title: s.title, detail: s.detail || "", agentId: s.agent_id,
          agentName: a.name, agentIcon: a.icon, source: "server", dbId: s.id,
          status: s.status, acked: s.status !== "open", key: "srv|" + s.id }; });
    // 3) dedup: si un hallazgo en vivo coincide con uno del backend (mismo agente y
    //    título normalizado), nos quedamos con el del backend (persiste y se resuelve en BD)
    const norm = (t) => (t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/\d+/g, "#").replace(/[^a-z#]+/g, " ").trim();
    const serverKeys = new Set(server.map(s => s.agentId + "::" + norm(s.title)));
    const liveFiltered = live.filter(f => !serverKeys.has(f.agentId + "::" + norm(f.title)));
    const merged = [...server, ...liveFiltered];
    // 4) contadores y severidad por agente (solo lo NO revisado, para el mapa neuronal)
    const counts = {}, sevMap = {};
    merged.forEach(f => { if (f.acked) return;
      counts[f.agentId] = (counts[f.agentId] || 0) + 1;
      sevMap[f.agentId] = Math.max(sevMap[f.agentId] || 0, SEV[f.sev] || 0); });
    AGENTS.forEach(a => { if (LS.off.has(a.id)) sevMap[a.id] = null; else if (sevMap[a.id] === undefined) sevMap[a.id] = 0; });
    state.agentCounts = counts; state.byAgentSev = sevMap;
    merged.sort((x, y) => (x.acked - y.acked) || (SEV[y.sev] - SEV[x.sev]));
    state.findings = merged;
  }

  /* ================= RENDER ================= */
  function kpi(label, val, sub, o) {
    o = o || {};
    const d = el("div", "kpi" + (o.alert ? " alert" : ""));
    d.style.setProperty("--accent", o.accent || "var(--cyan)");
    d.appendChild(el("div", "k-label", `${o.ico ? `<span class="k-ico">${o.ico}</span>` : ""}${label}`));
    d.appendChild(el("div", "k-val", val));
    d.appendChild(el("div", "k-sub", sub || ""));
    return d;
  }
  function renderKPIs() {
    const A = state.agg, e = H.eur;
    const today = $("#kpisToday"); today.innerHTML = "";
    today.append(
      kpi("Depositado hoy", e(A.depositedTodayConfirmed), `${A.depositsTodayCount} depósito(s) hoy`, { ico: "💶", accent: "var(--green)" }),
      kpi("Retiros solicitados hoy", A.withdrawalsTodayCount, e(A.withdrawalsTodayEur), { ico: "📤", accent: "var(--amber)" }),
      kpi("Flujo neto hoy", e(A.netFlowToday), A.netFlowToday >= 0 ? "entran más fondos" : "salen más fondos",
        { ico: "🔁", accent: A.netFlowToday >= 0 ? "var(--green)" : "var(--red)" }),
      kpi("Clientes nuevos hoy", A.newClientsToday, "altas del día", { ico: "✨", accent: "var(--violet)" }),
      kpi("Operaciones nuevas hoy", A.opsToday, "aperturas del día", { ico: "📈", accent: "var(--blue)" }),
      kpi("Leads captados hoy", A.leadsToday, `${A.leadsTotal} en total`, { ico: "🧲", accent: "var(--green)" }),
      kpi("Actividad hoy", A.activityToday, "eventos auditados", { ico: "⚡", accent: "var(--cyan)" }),
    );
    const act = $("#kpisAction"); act.innerHTML = "";
    act.append(
      kpi("Depósitos pendientes", A.depositsPendingCount, e(A.depositsPendingEur), { ico: "⏳", alert: A.depositsPendingCount > 0, accent: "var(--amber)" }),
      kpi("Retiros pendientes", A.withdrawalsPendingCount, e(A.withdrawalsPendingEur), { ico: "🏦", alert: A.withdrawalsPendingCount > 0, accent: "var(--amber)" }),
      kpi("Tickets abiertos", A.ticketsOpen, "soporte por atender", { ico: "🎧", alert: A.ticketsOpen > 0 }),
      kpi("Clientes sin agente", A.clientsNoAgent, "sin asesor asignado", { ico: "🧭", alert: A.clientsNoAgent > 0 }),
      kpi("Potenciales", A.potentialCount, "leads sin convertir", { ico: "🌱", accent: "var(--green)" }),
      kpi("Leads por contactar", A.leadsNew, "nuevos sin gestionar", { ico: "🧲", alert: A.leadsNew > 0, accent: "var(--green)" }),
      kpi("Hallazgos críticos", state.findings.filter(f => f.sev === "crit" && !f.acked).length, "requieren acción ya", { ico: "🚨", alert: state.findings.some(f => f.sev === "crit" && !f.acked), accent: "var(--red)" }),
    );
    const g = $("#kpisGlobal"); g.innerHTML = "";
    g.append(
      kpi("Capital gestionado (AUM)", e(A.aum), `inicial ${e(A.totalInitial)}`, { ico: "💎", accent: "var(--cyan)" }),
      kpi("Beneficio total", e(A.totalProfit), "de los clientes", { ico: "📊", accent: A.totalProfit >= 0 ? "var(--green)" : "var(--red)" }),
      kpi("Clientes", A.clientCount, `${A.activeClients} activos · ${A.potentialCount} potenciales`, { ico: "👥", accent: "var(--violet)" }),
      kpi("Agentes activos", A.activeAgents, `${A.totalAgents} en plantilla`, { ico: "🧑‍💼", accent: "var(--blue)" }),
      kpi("Operaciones", `${A.opsOpen} abiertas`, `${A.opsClosed} cerradas`, { ico: "📈" }),
      kpi("P&L operaciones", e(A.opsPnl), `rentab. media ${A.avgProfit.toFixed(1)}%`, { ico: "⚖️", accent: A.opsPnl >= 0 ? "var(--green)" : "var(--red)" }),
    );
  }

  function renderMision() {
    const box = $("#mission"); if (!box) return;
    const g = state.agg.goal, I = C.ICP || {};
    if (!g) { box.innerHTML = '<p class="muted">Objetivo no configurado.</p>'; return; }
    const statusTxt = g.status === "ok" ? "En ritmo ✅" : g.status === "warn" ? "Algo por detrás ⚠️" : "Por detrás 🔴";
    const statusCls = g.status === "ok" ? "status-ok" : g.status === "warn" ? "status-warn" : "status-bad";
    const needPct = Math.min(100, (g.expected / g.target) * 100);
    box.innerHTML = `
      <div class="m-top">
        <div class="m-goal">🎯 <b>${g.current.toLocaleString("es-ES")}</b> / ${g.target.toLocaleString("es-ES")} registros
          <span class="muted">· objetivo antes de 2027</span></div>
        <div class="${statusCls}" style="font-weight:700">${statusTxt}</div>
      </div>
      <div class="bar"><span style="width:${g.pct}%"></span><div class="need" style="left:${needPct}%" title="Objetivo proporcional a hoy"></div></div>
      <div class="muted" style="font-size:12px">Marcador ámbar = dónde deberías ir hoy (${g.expected.toLocaleString("es-ES")}). Faltan <b>${g.remaining}</b> días.</div>
      <div class="m-stats">
        <div class="m-stat"><div class="l">Ritmo necesario</div><div class="v">${g.perDayNeeded.toFixed(1)}/día</div></div>
        <div class="m-stat"><div class="l">A la semana</div><div class="v">${Math.ceil(g.perWeekNeeded)}</div></div>
        <div class="m-stat"><div class="l">Al mes</div><div class="v">${Math.ceil(g.perMonthNeeded)}</div></div>
        <div class="m-stat"><div class="l">Faltan</div><div class="v">${g.left.toLocaleString("es-ES")}</div></div>
        <div class="m-stat"><div class="l">Proyección 2027</div><div class="v ${g.projection >= g.target ? "status-ok" : "status-bad"}">${g.projection.toLocaleString("es-ES")}</div></div>
        <div class="m-stat"><div class="l">Ritmo actual</div><div class="v">${g.paceDay.toFixed(2)}/día</div></div>
      </div>
      <div class="icp">
        <span class="muted">Cliente ideal:</span>
        <span class="chip-icp">👤 ${I.resumen || "—"}</span>
        <span class="chip-icp">💶 desde ${I.inversionMin || 250} €</span>
        <span class="chip-icp">🇪🇸 España · CNMV</span>
      </div>`;
  }

  function renderCEO() {
    const A = state.agg, active = state.findings.filter(f => !f.acked);
    const by = (s) => active.filter(f => f.sev === s).length;
    const c = by("crit"), h = by("high"), m = by("med"), i = by("info");
    const top = active.find(f => f.sev === "crit") || active.find(f => f.sev === "high");
    let head = `Gestionando <b>${H.eur(A.aum)}</b> de ${A.clientCount} cliente(s) con <b>${A.activeAgents}</b> agente(s) activo(s). `;
    if (c) head += `<span style="color:var(--crit)">⚠ ${c} incidencia(s) crítica(s) requieren tu atención inmediata.</span>`;
    else if (h) head += `<span style="color:var(--high)">${h} asunto(s) de prioridad alta pendientes.</span>`;
    else if (active.length) head += `Operación estable; ${active.length} mejora(s)/aviso(s) menores.`;
    else head += `✅ Todo en orden: sin incidencias abiertas.`;
    if (top) head += `<br/><span class="muted">Prioridad del CEO → ${top.agentIcon} ${top.title}</span>`;
    $("#ceoHeadline").innerHTML = head;
    const sevBox = $("#ceoSev"); sevBox.innerHTML = "";
    [["crit", c], ["high", h], ["med", m], ["info", i]].forEach(([s, n]) => {
      const chip = el("span", "sev-chip", `<span class="dot-c" style="background:${SEVCOLOR[s]}"></span>${SEVNAME[s]} <b>${n}</b>`);
      sevBox.appendChild(chip);
    });
  }

  /* ---------- NEURAL MAP (SVG) ---------- */
  function renderNeuro() {
    const svg = $("#neuro"), W = 680, Hh = 500, cx = W / 2, cy = Hh / 2 - 6, R = 192;
    const sevFill = (s) => s >= 4 ? "var(--crit)" : s >= 3 ? "var(--high)" : s >= 2 ? "var(--med)" : "var(--ok)";
    const ns = "http://www.w3.org/2000/svg";
    let g = "";
    const n = AGENTS.length;
    const pos = AGENTS.map((a, idx) => {
      const ang = (-Math.PI / 2) + idx * (2 * Math.PI / n);
      return { a, x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
    });
    // líneas
    pos.forEach(p => {
      const off = LS.off.has(p.a.id);
      const sev = state.byAgentSev[p.a.id];
      const col = off ? "var(--dim)" : (sev ? sevFill(sev) : "var(--ok)");
      g += `<line x1="${cx}" y1="${cy}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="${col}" stroke-width="${off?1:1.6}" opacity="${off?.25:.5}">
        ${off?"":`<animate attributeName="opacity" values="0.25;0.7;0.25" dur="${(2.4+Math.random()).toFixed(1)}s" repeatCount="indefinite"/>`}</line>`;
    });
    // nodos agente
    pos.forEach(p => {
      const off = LS.off.has(p.a.id);
      const sev = state.byAgentSev[p.a.id];
      const col = off ? "var(--dim)" : (sev ? sevFill(sev) : "var(--ok)");
      const cnt = (state.agentCounts && state.agentCounts[p.a.id]) || 0;
      g += `<g class="node" data-agent="${p.a.id}" style="cursor:pointer">
        ${off?"":`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="30" fill="${col}" opacity="0.16"><animate attributeName="r" values="24;33;24" dur="3s" repeatCount="indefinite"/></circle>`}
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="22" fill="#0b1330" stroke="${col}" stroke-width="2.5"/>
        <text x="${p.x.toFixed(1)}" y="${(p.y+6).toFixed(1)}" font-size="18" text-anchor="middle">${p.a.icon}</text>
        ${cnt&&!off?`<circle cx="${(p.x+18).toFixed(1)}" cy="${(p.y-18).toFixed(1)}" r="9" fill="${col}"/><text x="${(p.x+18).toFixed(1)}" y="${(p.y-14.5).toFixed(1)}" font-size="10" font-weight="700" text-anchor="middle" fill="#06122a">${cnt}</text>`:""}
        <text x="${p.x.toFixed(1)}" y="${(p.y+38).toFixed(1)}" font-size="9.5" text-anchor="middle" fill="var(--muted)">${p.a.name.replace("Agente ","")}</text>
      </g>`;
    });
    // CEO
    g += `<circle cx="${cx}" cy="${cy}" r="46" fill="var(--cyan)" opacity="0.12"><animate attributeName="r" values="40;52;40" dur="3.5s" repeatCount="indefinite"/></circle>
      <circle cx="${cx}" cy="${cy}" r="34" fill="#0a1540" stroke="url(#ceoG)" stroke-width="3"/>
      <defs><linearGradient id="ceoG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00e5ff"/><stop offset="1" stop-color="#8b5cff"/></linearGradient></defs>
      <text x="${cx}" y="${cy-2}" font-size="20" text-anchor="middle">🧠</text>
      <text x="${cx}" y="${cy+16}" font-size="10" font-weight="700" text-anchor="middle" fill="var(--cyan)">CEO</text>`;
    svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
    svg.innerHTML = g;
    svg.querySelectorAll(".node").forEach(node => node.addEventListener("click", () => {
      findFilter.agent = node.dataset.agent; findFilter.sev = "all";
      buildToolbarFilters(); renderFindings();
      $("#findings").scrollIntoView({ behavior: "smooth", block: "center" });
    }));
  }

  /* ---------- ROSTER ---------- */
  function renderRoster() {
    const box = $("#roster"); box.innerHTML = "";
    AGENTS.forEach(a => {
      const off = LS.off.has(a.id);
      const cnt = (state.agentCounts && state.agentCounts[a.id]) || 0;
      const sev = state.byAgentSev && state.byAgentSev[a.id];
      let badge = `<span class="badge ok">Sin incidencias</span>`;
      if (off) badge = `<span class="badge warn">En pausa</span>`;
      else if (sev >= 3) badge = `<span class="badge bad">${cnt} hallazgo(s)</span>`;
      else if (cnt > 0) badge = `<span class="badge warn">${cnt} aviso(s)</span>`;
      const card = el("div", "agent" + (off ? " paused" : ""));
      card.innerHTML = `
        <div class="a-head">
          <div class="a-ico">${a.icon}</div>
          <div><div class="a-name">${a.name}</div><div class="a-role">${a.role}</div></div>
        </div>
        <div class="a-mission">${a.mission}</div>
        <div class="a-foot">${badge}<button class="switch ${off ? "" : "on"}" data-id="${a.id}" title="${off ? "Activar" : "Pausar"}"></button></div>`;
      card.querySelector(".switch").addEventListener("click", () => {
        if (LS.off.has(a.id)) LS.off.delete(a.id); else LS.off.add(a.id);
        LS.saveOff(); runAgents(); renderAll();
      });
      box.appendChild(card);
    });
  }

  /* ---------- FINDINGS ---------- */
  function buildToolbarFilters() {
    const tb = $("#findToolbar"); tb.innerHTML = "";
    const sevs = [["all", "Todo"], ["crit", "Crítico"], ["high", "Alto"], ["med", "Medio"], ["info", "Info"]];
    sevs.forEach(([k, lbl]) => {
      const c = el("button", "chip-f" + (findFilter.sev === k ? " active" : ""), lbl);
      c.onclick = () => { findFilter.sev = k; buildToolbarFilters(); renderFindings(); };
      tb.appendChild(c);
    });
    const sep = el("span", "", "&nbsp;"); tb.appendChild(sep);
    const all = el("button", "chip-f" + (findFilter.agent === "all" ? " active" : ""), "Todos los agentes");
    all.onclick = () => { findFilter.agent = "all"; buildToolbarFilters(); renderFindings(); };
    tb.appendChild(all);
    AGENTS.forEach(a => {
      if (LS.off.has(a.id)) return;
      const c = el("button", "chip-f" + (findFilter.agent === a.id ? " active" : ""), `${a.icon}`);
      c.title = a.name;
      c.onclick = () => { findFilter.agent = a.id; buildToolbarFilters(); renderFindings(); };
      tb.appendChild(c);
    });
  }
  function renderFindings() {
    const box = $("#findings"); box.innerHTML = "";
    let list = state.findings.filter(f =>
      (findFilter.sev === "all" || f.sev === findFilter.sev) &&
      (findFilter.agent === "all" || f.agentId === findFilter.agent));
    if (!list.length) { box.appendChild(el("div", "empty", "✅ Nada que reportar con este filtro.")); return; }
    list.forEach(f => {
      const row = el("div", `finding ${f.sev}${f.acked ? " done" : ""}`);
      const srcTag = f.source === "server" ? `<span class="tag" style="color:var(--cyan)">🛰️ 24/7</span>` : "";
      let btn;
      if (f.source === "server") {
        btn = f.acked
          ? `<button class="mini-btn" data-srv="${f.dbId}" data-st="open">↺ Reabrir</button>`
          : `<button class="mini-btn" data-srv="${f.dbId}" data-st="resolved">✓ Resolver</button>`;
      } else {
        btn = `<button class="mini-btn" data-ack="${f.key}">${f.acked ? "↺ Reabrir" : "✓ Revisado"}</button>`;
      }
      const acts = `<div class="f-actions">
        ${f.link ? `<a class="mini-btn" href="${f.link}" target="_blank" rel="noopener">${f.action || "Abrir"} ↗</a>` : ""}
        ${btn}</div>`;
      row.innerHTML = `<div class="f-body">
        <div class="f-title"><span class="sev-tag ${f.sev}">${SEVNAME[f.sev]}</span> ${f.title}</div>
        <div class="f-detail">${f.detail}</div>
        <div class="f-meta"><span class="tag">${f.agentIcon} ${f.agentName}</span>${srcTag}</div>
      </div>${acts}`;
      const ackBtn = row.querySelector("[data-ack]");
      if (ackBtn) ackBtn.addEventListener("click", () => {
        if (LS.ack.has(f.key)) LS.ack.delete(f.key); else LS.ack.add(f.key);
        LS.saveAck(); runAgents(); renderAll();
      });
      const srvBtn = row.querySelector("[data-srv]");
      if (srvBtn) srvBtn.addEventListener("click", async () => {
        srvBtn.disabled = true; srvBtn.innerHTML = '<span class="spin"></span>';
        const st = srvBtn.dataset.st;
        const patch = st === "resolved" ? { status: "resolved", resolved_at: new Date().toISOString() } : { status: "open", resolved_at: null };
        const { error } = await sb.from("neuron_findings").update(patch).eq("id", srvBtn.dataset.srv);
        if (error) { srvBtn.disabled = false; srvBtn.textContent = "Error"; console.error(error); return; }
        await refresh();
      });
      box.appendChild(row);
    });
  }

  /* ---------- TAREAS DE AGENTES ---------- */
  function renderTasks() {
    const addBox = $("#tasksAdd"), list = $("#tasksList"); if (!list) return;
    if (addBox) {
      const agents = (state.data.profiles || []).filter(p => p.role === "agent");
      const opts = ['<option value="">— Sin asignar —</option>'].concat(
        agents.map(a => `<option value="${a.id}">${a.full_name || a.email || a.id.slice(0, 8)}</option>`)).join("");
      addBox.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px";
      addBox.innerHTML = `
        <select id="tNewAgent" class="t-inp">${opts}</select>
        <input id="tNewTitle" class="t-inp" style="flex:1;min-width:160px" placeholder="Nueva tarea para el agente…">
        <select id="tNewPrio" class="t-inp"><option value="normal">Normal</option><option value="high">Alta</option><option value="low">Baja</option></select>
        <button class="mini-btn" id="tAdd">+ Asignar</button>`;
      $("#tAdd").addEventListener("click", addTask);
      $("#tNewTitle").addEventListener("keydown", e => { if (e.key === "Enter") addTask(); });
    }
    list.innerHTML = "";
    const tasks = state.data.tasks || [];
    if (!tasks.length) { list.appendChild(el("div", "empty", 'Sin tareas. Asigna la primera arriba, o díselo a ASI: "crea tarea para [agente]: …".')); return; }
    const nameOf = id => { const p = (state.data.profiles || []).find(x => x.id === id); return p ? (p.full_name || p.email) : "sin asignar"; };
    const stTag = s => s === "done" ? '<span class="tag" style="color:var(--green)">hecha ✅</span>' : s === "in_progress" ? '<span class="tag" style="color:var(--amber)">en curso</span>' : '<span class="tag" style="color:var(--cyan)">pendiente</span>';
    const prTag = p => p === "high" ? '<span class="tag" style="color:var(--red)">alta</span>' : p === "low" ? '<span class="tag">baja</span>' : "";
    tasks.slice(0, 40).forEach(t => {
      const row = el("div", "row");
      row.innerHTML = `<div class="av">📋</div>
        <div class="ftxt"><b>${t.title}</b>
          <div class="muted" style="font-size:11px">${nameOf(t.agent_id)} · ${timeAgo(t.created_at)} · ${stTag(t.status)} ${prTag(t.priority)}</div></div>`;
      const acts = el("div"); acts.style.cssText = "display:flex;gap:6px";
      acts.innerHTML = `<button class="mini-btn" data-cyc="1">${t.status === "done" ? "↺ Reabrir" : "▶ Avanzar"}</button><button class="mini-btn" data-del="1">✕</button>`;
      acts.querySelector("[data-cyc]").addEventListener("click", () => cycleTask(t));
      acts.querySelector("[data-del]").addEventListener("click", () => delTask(t.id));
      row.appendChild(acts);
      list.appendChild(row);
    });
  }
  async function addTask() {
    const title = $("#tNewTitle").value.trim(); if (!title) { $("#tNewTitle").focus(); return; }
    const { error } = await sb.from("agent_tasks").insert({ agent_id: $("#tNewAgent").value || null, title, priority: $("#tNewPrio").value, created_by: state.userId, status: "pending" });
    if (error) { alert("No se pudo crear la tarea: " + error.message); return; }
    await refresh();
  }
  async function cycleTask(t) {
    const next = t.status === "pending" ? "in_progress" : t.status === "in_progress" ? "done" : "pending";
    const { error } = await sb.from("agent_tasks").update({ status: next, updated_at: new Date().toISOString() }).eq("id", t.id);
    if (error) { console.error(error); return; } await refresh();
  }
  async function delTask(id) {
    const { error } = await sb.from("agent_tasks").delete().eq("id", id);
    if (error) { console.error(error); return; } await refresh();
  }

  /* ---------- LEADS ---------- */
  function renderLeads() {
    const box = $("#leadsList"); if (!box) return;
    box.innerHTML = "";
    const leads = (state.data.leads || []).slice(0, 40);
    if (!leads.length) { box.appendChild(el("div", "empty", "Aún no hay leads. Difunde la calculadora y la landing 🧲")); return; }
    const badgeOf = (s) => s === "converted" ? `<span class="tag" style="color:var(--green)">cliente ✅</span>`
      : s === "discarded" ? `<span class="tag">descartado</span>`
      : s === "contacted" ? `<span class="tag" style="color:var(--amber)">contactado</span>`
      : `<span class="tag" style="color:var(--cyan)">nuevo</span>`;
    leads.forEach(l => {
      const closed = l.status === "converted" || l.status === "discarded";
      const row = el("div", "row");
      row.innerHTML = `<div class="av">🧲</div>
        <div class="ftxt"><b>${l.full_name || "(sin nombre)"}</b> <span class="muted">· ${l.email}</span>
          <div class="muted" style="font-size:11px">${l.source || ""} · ${timeAgo(l.created_at)} · ${badgeOf(l.status)}</div></div>`;
      if (!closed) {
        const acts = el("div"); acts.style.cssText = "display:flex;gap:6px";
        acts.innerHTML = `<button class="mini-btn" data-conv="${l.id}">✓ Convertir</button>
                          <button class="mini-btn" data-disc="${l.id}">Descartar</button>`;
        acts.querySelector("[data-conv]").addEventListener("click", (e) => updateLead(l.id, "converted", e.target));
        acts.querySelector("[data-disc]").addEventListener("click", (e) => updateLead(l.id, "discarded", e.target));
        row.appendChild(acts);
      }
      box.appendChild(row);
    });
  }
  /* ---------- ACCIONES / APROBACIONES (ASI) ---------- */
  // Auto-ejecutables desde el chat solo las de bajo riesgo y resolubles (convert_lead/discard_lead, ver jCreateReq).
  async function execAction(a) {
    const p = a.params || {};
    try {
      if (a.action_type === "convert_lead" || a.action_type === "discard_lead") {
        const st = a.action_type === "convert_lead" ? "converted" : "discarded";
        const { error } = await sb.from("leads").update({ status: st }).eq("id", p.lead_id); if (error) throw error;
        return { ok: true, msg: `lead ${st}` };
      }
      if (a.action_type === "assign_client") {
        if (!p.client_id || !p.agent_id) return { ok: false, msg: "faltan el cliente o el agente; hazlo desde el panel" };
        const { error } = await sb.from("clients").update({ assigned_agent_id: p.agent_id }).eq("id", p.client_id); if (error) throw error;
        return { ok: true, msg: "cliente asignado" };
      }
      if (a.action_type === "add_note") {
        if (!p.client_id || !p.body) return { ok: false, msg: "falta el cliente o el texto de la nota" };
        const { error } = await sb.from("comments").insert({ client_id: p.client_id, body: p.body, author_id: state.userId, author_role: "admin", author_name: "ASI" }); if (error) throw error;
        return { ok: true, msg: "nota añadida" };
      }
      // dinero / crear agente: requieren Edge Function (fase 3) o flujo confirmado
      return { ok: false, deferred: true, msg: "aprobada — la ejecución se hará en la fase de Edge Function/Telegram" };
    } catch (e) { return { ok: false, msg: "error: " + (e.message || e) }; }
  }

  async function decideAction(a, decision, btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
    let status = decision, result = null;
    if (decision === "approved") { const ex = await execAction(a); status = ex.ok ? "executed" : (ex.deferred ? "approved" : "failed"); result = ex.msg; }
    const { error } = await sb.from("neuron_action_requests").update({ status, result, decided_by: state.userId, decided_at: new Date().toISOString() }).eq("id", a.id);
    if (error) { console.error(error); if (btn) btn.disabled = false; return; }
    await refresh();
  }

  function renderApprovals() {
    const box = $("#approvalsList"); if (!box) return; box.innerHTML = "";
    const acts = state.data.actions || [];
    if (!acts.length) { box.appendChild(el("div", "empty", "Sin acciones registradas. Pídeselo a ASI 🧠 (p. ej. \"crea un agente\").")); return; }
    const statusTag = (s) => s === "pending" ? `<span class="tag" style="color:var(--amber)">pendiente</span>`
      : s === "executed" ? `<span class="tag" style="color:var(--green)">ejecutada ✅</span>`
      : s === "approved" ? `<span class="tag" style="color:var(--green)">aprobada</span>`
      : s === "rejected" ? `<span class="tag" style="color:var(--red)">rechazada</span>`
      : s === "failed" ? `<span class="tag" style="color:var(--red)">error</span>` : `<span class="tag">${s}</span>`;
    const riskTag = (r) => r === "money" ? `<span class="tag" style="color:var(--red)">💶 dinero</span>` : r === "high" ? `<span class="tag" style="color:var(--amber)">alto</span>` : `<span class="tag">bajo</span>`;
    acts.slice(0, 30).forEach(a => {
      const row = el("div", "row");
      row.innerHTML = `<div class="av">🤖</div>
        <div class="ftxt"><b>${a.summary}</b>
          <div class="muted" style="font-size:11px">${a.action_type} · ${a.source} · ${timeAgo(a.created_at)} · ${riskTag(a.risk)} ${statusTag(a.status)}${a.result ? ` · ${a.result}` : ""}</div></div>`;
      if (a.status === "pending") {
        const acb = el("div"); acb.style.cssText = "display:flex;gap:6px";
        acb.innerHTML = `<button class="mini-btn" data-ap="${a.id}">✓ Aprobar</button><button class="mini-btn" data-rj="${a.id}">Rechazar</button>`;
        acb.querySelector("[data-ap]").addEventListener("click", (e) => decideAction(a, "approved", e.target));
        acb.querySelector("[data-rj]").addEventListener("click", (e) => decideAction(a, "rejected", e.target));
        row.appendChild(acb);
      }
      box.appendChild(row);
    });
  }

  async function updateLead(id, status, btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
    const { error } = await sb.from("leads").update({ status }).eq("id", id);
    if (error) { console.error(error); alert("No se pudo actualizar el lead."); if (btn) btn.disabled = false; return; }
    await refresh();
  }

  /* ---------- ACTIVITY FEED ---------- */
  const ACTICON = { "Inicio de sesión": "🔑", create_client: "🧑", create_agent: "🧑‍💼", create_operation: "📈",
    update_operation: "✏️", create_comment: "💬", create_agent_comment: "💬", update_client: "✏️", default: "•" };
  function timeAgo(d) {
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 60) return "ahora"; if (s < 3600) return Math.floor(s / 60) + " min";
    if (s < 86400) return Math.floor(s / 3600) + " h"; return Math.floor(s / 86400) + " d";
  }
  function renderFeed() {
    const box = $("#feed"); box.innerHTML = "";
    if (!state.data.audit.length) { box.appendChild(el("div", "empty", "Sin actividad reciente.")); return; }
    state.data.audit.slice(0, 40).forEach(a => {
      const ico = ACTICON[a.action] || ACTICON.default;
      const row = el("div", "row");
      row.innerHTML = `<div class="av">${ico}</div>
        <div class="ftxt"><b>${a.action || "evento"}</b> <span class="muted">· ${a.entity_type || ""}</span></div>
        <div class="ft">${timeAgo(a.created_at)}</div>`;
      box.appendChild(row);
    });
  }

  /* ---------- SITES HEALTH ---------- */
  function renderSites() {
    const box = $("#sites"); box.innerHTML = "";
    (C.SITES || []).forEach((s) => {
      const ping = (state.agg.sitePings || []).find(p => p.url === s.url) || {};
      const cls = ping.status === "up" ? "up" : ping.status === "down" ? "down" : "";
      const row = el("div", "site");
      row.innerHTML = `<span class="s-led ${cls}"></span><span class="s-name">${s.name}</span>
        <span class="s-ms">${ping.status === "up" ? (ping.ms + " ms") : ping.status === "down" ? "sin respuesta" : "—"}</span>
        <a class="mini-btn" href="${s.url}" target="_blank" rel="noopener">Abrir ↗</a>`;
      box.appendChild(row);
    });
  }
  async function pingSites() {
    const results = await Promise.all((C.SITES || []).map(async (s) => {
      const t0 = performance.now();
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 7000);
        await fetch(s.url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal });
        clearTimeout(to);
        return { url: s.url, name: s.name, status: "up", ms: Math.round(performance.now() - t0) };
      } catch (e) { return { url: s.url, name: s.name, status: "down", ms: 0 }; }
    }));
    state.agg.sitePings = results;
    if (state.data.profiles) { computeAgg(); runAgents(); renderAll(); } else { renderSites(); }
  }
  $("#pingBtn").addEventListener("click", pingSites);

  /* ---------- CHARTS ---------- */
  function renderCharts() {
    if (!window.Chart) return;
    const days = [], depByDay = [], witByDay = [];
    const dayKey = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x.getTime(); };
    const labels = []; const map = {};
    for (let i = 13; i >= 0; i--) { const x = new Date(); x.setHours(0,0,0,0); x.setDate(x.getDate()-i);
      labels.push(x.toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit"})); map[x.getTime()] = { dep:0, wit:0 }; }
    state.data.movements.forEach(m => { if (!/deposit|ingreso/i.test(m.type||"deposit")) return;
      const k = dayKey(m.created_at); if (map[k] && H.bucket(m.status) !== "rejected") map[k].dep += Number(m.amount)||0; });
    state.data.withdrawals.forEach(w => { const k = dayKey(w.requested_at||w.created_at);
      if (map[k] && H.bucket(w.status) !== "rejected") map[k].wit += Number(w.amount)||0; });
    Object.keys(map).sort().forEach(k => { depByDay.push(map[k].dep); witByDay.push(map[k].wit); });

    drawChart("chFlow", {
      type: "bar",
      data: { labels, datasets: [
        { label: "Depósitos", data: depByDay, backgroundColor: "rgba(38,230,166,.75)", borderRadius: 5 },
        { label: "Retiros", data: witByDay, backgroundColor: "rgba(255,84,112,.75)", borderRadius: 5 } ] },
      options: baseOpts()
    });

    // crecimiento clientes (acumulado)
    const sorted = [...state.data.clients].filter(c=>c.created_at).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
    let acc = 0; const cl = sorted.map(c => { acc++; return { x: new Date(c.created_at).toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit"}), y: acc }; });
    drawChart("chClients", {
      type: "line",
      data: { labels: cl.map(p=>p.x), datasets: [
        { label: "Clientes acumulados", data: cl.map(p=>p.y), borderColor: "#8b5cff",
          backgroundColor: "rgba(139,92,255,.18)", fill: true, tension: .35, pointRadius: 3 } ] },
      options: baseOpts()
    });

    // AUM y beneficio · histórico real del backend 24/7
    const md = state.data.metricsDaily || [];
    if (md.length) {
      drawChart("chAum", {
        type: "line",
        data: { labels: md.map(r => new Date(r.day).toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit"})),
          datasets: [
            { label: "AUM (€)", data: md.map(r=>Number(r.aum)||0), borderColor:"#00e5ff",
              backgroundColor:"rgba(0,229,255,.16)", fill:true, tension:.3, pointRadius:3 },
            { label: "Beneficio (€)", data: md.map(r=>Number(r.total_profit)||0), borderColor:"#26e6a6",
              backgroundColor:"rgba(38,230,166,.10)", fill:true, tension:.3, pointRadius:3 } ] },
        options: baseOpts()
      });
    } else if (state.charts["chAum"]) { state.charts["chAum"].destroy(); state.charts["chAum"] = null; }
  }

  function renderBotPill() {
    const pill = $("#botPill"); if (!pill) return;
    const ags = state.data.neuronAgents || [];
    const days = (state.data.metricsDaily || []).length;
    if (!ags.length) { pill.innerHTML = "🛰️ 24/7 inactivo"; pill.title = "Backend no detectado"; return; }
    let last = 0; ags.forEach(a => { if (a.last_run_at) { const t = new Date(a.last_run_at).getTime(); if (t > last) last = t; } });
    pill.innerHTML = `🛰️ 24/7 · últ. ${last ? timeAgo(last) : "—"} · ${days}d hist.`;
    pill.title = "Agentes en la nube (pg_cron): última ejecución y días de histórico guardados";
  }
  function baseOpts() {
    return { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#8da0c8", boxWidth: 12, font: { size: 11 } } } },
      scales: { x: { ticks: { color: "#5d6f9c", font: { size: 10 } }, grid: { color: "rgba(120,160,255,.07)" } },
                y: { ticks: { color: "#5d6f9c", font: { size: 10 } }, grid: { color: "rgba(120,160,255,.07)" } } } };
  }
  function drawChart(id, cfg) {
    const ctx = document.getElementById(id); if (!ctx) return;
    if (state.charts[id]) state.charts[id].destroy();
    state.charts[id] = new window.Chart(ctx, cfg);
  }

  /* ================= ORQUESTACIÓN ================= */
  function renderAll() {
    renderMision(); renderKPIs(); renderCEO(); renderNeuro(); renderRoster();
    buildToolbarFilters(); renderFindings(); renderApprovals(); renderTasks(); renderLeads(); renderFeed(); renderSites(); renderCharts(); renderBotPill();
    try { asiProactive(); } catch (e) { console.error("asiProactive", e); }
  }
  async function refresh() {
    $("#reloadBtn").innerHTML = '<span class="spin"></span> ';
    await fetchAll(); computeAgg(); runAgents(); renderAll();
    state.lastRefresh = Date.now();
    $("#reloadBtn").textContent = "↻ Actualizar";
  }
  $("#reloadBtn").addEventListener("click", refresh);

  /* ---------- realtime ---------- */
  function setupRealtime() {
    let deb;
    state.channel = sb.channel("neuron-rt")
      .on("postgres_changes", { event: "*", schema: "public" }, () => {
        clearTimeout(deb); deb = setTimeout(refresh, 1500);
      })
      .subscribe((status) => {
        state.realtimeOk = status === "SUBSCRIBED";
        const led = $("#rtLed"), txt = $("#rtTxt");
        led.classList.toggle("off", !state.realtimeOk);
        txt.textContent = state.realtimeOk ? "en vivo" : "sin realtime";
      });
  }

  /* ---------- auto refresh + reloj ---------- */
  function startAuto() {
    $("#autoBtn").addEventListener("click", () => {
      state.autoOn = !state.autoOn;
      $("#autoBtn").textContent = state.autoOn ? "⏸ Auto" : "▶ Auto";
      if (state.autoOn) scheduleAuto(); else clearInterval(state.autoTimer);
    });
    scheduleAuto();
  }
  function scheduleAuto() { clearInterval(state.autoTimer); state.autoTimer = setInterval(() => { if (state.autoOn) refresh(); }, C.REFRESH_MS); }
  function tickClock() {
    setInterval(() => {
      if (!state.lastRefresh) return;
      const s = Math.floor((Date.now() - state.lastRefresh) / 1000);
      $("#refreshTxt").textContent = "actualizado hace " + (s < 60 ? s + "s" : Math.floor(s/60) + "m");
    }, 1000);
  }

  /* ================= JARVIS · asistente ================= */
  let jVoiceOn = true, jGreeted = false;  // voz (femenina) activada por defecto
  const jn = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const jStatus = (s) => s === "ok" ? "en ritmo" : s === "warn" ? "algo por detrás" : s === "bad" ? "por detrás" : "—";
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  let asiInited = false;
  let asiHistory = [];   // historial del chat con el cerebro (Claude)

  // ---- memoria / aprendizaje (localStorage) ----
  const ASI_MEM = (() => { try { return JSON.parse(localStorage.getItem("asi-mem") || "{}"); } catch (e) { return {}; } })();
  ASI_MEM.facts = ASI_MEM.facts || []; ASI_MEM.cmd = ASI_MEM.cmd || {}; ASI_MEM.seenF = ASI_MEM.seenF || []; ASI_MEM.seenL = ASI_MEM.seenL || [];
  const asiMemSave = () => { try { localStorage.setItem("asi-mem", JSON.stringify(ASI_MEM)); } catch (e) {} };

  // ---- motor de frases naturales (variación + tokens) ----
  const jPickArr = (arr) => (arr && arr.length) ? arr[Math.floor(Math.random() * arr.length)] : "";
  function asiTokens(extra) {
    const A = state.agg || {}, g = A.goal || {}, eur = H.eur;
    const act = (state.findings || []).filter(f => !f.acked);
    const top = act.slice().sort((a, b) => SEV[b.sev] - SEV[a.sev])[0] || {};
    const m = {
      nombre: ASI_MEM.name ? (" " + ASI_MEM.name) : "",
      aum: eur(A.aum || 0), clientes: A.clientCount || 0, agentesActivos: A.activeAgents || 0,
      objCur: g.current || 0, objTgt: g.target || 2000, objPct: g.pct != null ? g.pct.toFixed(0) : "0",
      porSemana: g.perWeekNeeded != null ? Math.ceil(g.perWeekNeeded) : "—", porDia: g.perDayNeeded != null ? g.perDayNeeded.toFixed(1) : "—",
      diasRest: g.remaining != null ? g.remaining : "—", estadoObj: jStatus(g.status),
      crit: act.filter(f => f.sev === "crit").length, altas: A.newClientsToday || 0,
      leadsNuevos: (state.data.leads || []).filter(l => /^(new|nuevo)$/i.test((l.status || "").trim())).length,
      tituloTop: top.title || "", detalleTop: top.detail || "",
      depHoy: eur(A.depositedTodayConfirmed || 0), retPendN: A.withdrawalsPendingCount || 0, retPendEur: eur(A.withdrawalsPendingEur || 0),
      depPendN: A.depositsPendingCount || 0, depPendEur: eur(A.depositsPendingEur || 0),
      potenciales: A.potentialCount || 0, beneficio: eur(A.totalProfit || 0)
    };
    return Object.assign(m, extra || {});
  }
  const SING_NOUN = { alertas: "alerta", leads: "lead", retiros: "retiro", "depósitos": "depósito", depositos: "depósito", clientes: "cliente", "días": "día", dias: "día", altas: "alta", potenciales: "potencial", agentes: "agente", incidencias: "incidencia", avisos: "aviso" };
  const SING_ADJ = { nuevos: "nuevo", nuevas: "nueva", solicitados: "solicitado", pendientes: "pendiente", activos: "activo", abiertas: "abierta", recientes: "reciente" };
  function asiFill(str, tok) {
    let s = String(str).replace(/\{(\w+)\}/g, (_, k) => (tok[k] != null ? String(tok[k]) : ""));
    // concordancia singular cuando el valor es 1 ("1 alertas" -> "1 alerta", "1 lead nuevos" -> "1 lead nuevo")
    s = s.replace(/\b1 ([A-Za-zÁÉÍÓÚáéíóúñ]+)\b/g, (m, w) => SING_NOUN[w.toLowerCase()] ? "1 " + SING_NOUN[w.toLowerCase()] : m);
    s = s.replace(/(\b1 [A-Za-zÁÉÍÓÚáéíóúñ]+ )([A-Za-zÁÉÍÓÚáéíóúñ]+)\b/g, (m, head, adj) => SING_ADJ[adj.toLowerCase()] ? head + SING_ADJ[adj.toLowerCase()] : m);
    return s.replace(/\s+([,.!?:;])/g, "$1").replace(/ {2,}/g, " ").trim();
  }
  function asiSay(key, extra) {
    const lib = (window.ASI && window.ASI.say) || {};
    const out = asiFill(jPickArr(lib[key] || []) || "", asiTokens(extra));
    return out || "Vale, dame un segundo.";
  }

  function initJarvis() {
    const fab = $("#jarvisFab"), panel = $("#jarvis");
    if (!fab || fab.dataset.init) return; fab.dataset.init = "1";
    fab.addEventListener("click", () => {
      panel.classList.remove("hidden"); fab.classList.add("hidden");
      const b = $("#jBadge"); if (b) { b.style.display = "none"; b.textContent = "0"; } fab.classList.remove("alert");
      jarvisGreet();
    });
    $("#jClose").addEventListener("click", () => { panel.classList.add("hidden"); fab.classList.remove("hidden"); });
    $("#jSend").addEventListener("click", jSubmit);
    $("#jText").addEventListener("keydown", (e) => { if (e.key === "Enter") jSubmit(); });
    $("#jVoice").addEventListener("click", () => {
      jVoiceOn = !jVoiceOn; $("#jVoice").classList.toggle("on", jVoiceOn);
      $("#jVoice").textContent = jVoiceOn ? "🔊" : "🔇"; if (jVoiceOn) jSpeak("Voz activada. ¿En qué te ayudo?");
    });
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) $("#jMic").style.display = "none";
    else $("#jMic").addEventListener("click", () => jListen(SR));
    const sugs = ["¿Cómo vamos?", "Objetivo 2027", "Leads", "Alertas", "¿Qué priorizo?", "Salud portales"];
    const box = $("#jSugs"); box.innerHTML = "";
    sugs.forEach(s => { const b = el("button", "j-sug", s); b.onclick = () => { $("#jText").value = s; jSubmit(); }; box.appendChild(b); });
    // voz femenina activada por defecto
    $("#jVoice").classList.toggle("on", jVoiceOn);
    $("#jVoice").textContent = jVoiceOn ? "🔊" : "🔇";
    try { speechSynthesis.getVoices(); speechSynthesis.addEventListener("voiceschanged", () => {}); } catch (e) {}
  }
  function jarvisGreet() { if (jGreeted) return; jGreeted = true; jBot(asiSay("greet") + "\n\n" + jBriefing()); }
  function jSubmit() {
    const t = $("#jText").value.trim(); if (!t) return; jMe(t); $("#jText").value = "";
    const typing = el("div", "j-msg bot", "…"); $("#jLog").appendChild(typing); jScroll();
    asiRespond(t)
      .then(r => { typing.remove(); jBot(r); })
      .catch(e => { typing.remove(); jBot("Ups, error: " + (e.message || e)); });
  }
  // Contexto en vivo que ASI necesita para razonar y actuar
  function asiContext() {
    const A = state.agg || {}, g = A.goal || {}, leads = state.data.leads || [];
    return {
      fecha: new Date().toISOString().slice(0, 10),
      admin: state.adminName || "",
      memoria: { nombre: ASI_MEM.name || "", notas: (ASI_MEM.facts || []).slice(-8) },
      kpis: {
        aum: Math.round(A.aum || 0), clientes: A.clientCount || 0, clientes_activos: A.activeClients || 0,
        potenciales: A.potentialCount || 0, clientes_nuevos_hoy: A.newClientsToday || 0, clientes_sin_agente: A.clientsNoAgent || 0,
        agentes_activos: A.activeAgents || 0, agentes_total: A.totalAgents || 0,
        leads_total: A.leadsTotal || 0, leads_nuevos: A.leadsNew || 0, leads_hoy: A.leadsToday || 0,
        depositos_pendientes: A.depositsPendingCount || 0, depositos_pend_eur: Math.round(A.depositsPendingEur || 0),
        retiros_pendientes: A.withdrawalsPendingCount || 0, retiros_pend_eur: Math.round(A.withdrawalsPendingEur || 0),
        depositado_hoy: Math.round(A.depositedTodayConfirmed || 0), beneficio_total: Math.round(A.totalProfit || 0),
        tickets_abiertos: A.ticketsOpen || 0,
        alertas_criticas: (state.findings || []).filter(f => f.sev === "crit" && !f.acked).length
      },
      objetivo: g.target ? { meta: g.target, actual: g.current, faltan: g.left, dias_restantes: g.remaining, ritmo_dia: Number((g.perDayNeeded || 0).toFixed(1)), estado: jStatus(g.status) } : null,
      leads_nuevos_lista: leads.filter(l => /^(new|nuevo)$/i.test((l.status || "").trim())).slice(0, 8).map(l => ({ email: l.email, nombre: l.full_name || "" })),
      agentes_lista: (state.data.profiles || []).filter(p => p.role === "agent").slice(0, 20).map(p => ({ email: p.email, nombre: p.full_name || "" }))
    };
  }
  // Aprendizaje local (persiste en este navegador aunque responda el cerebro)
  function asiLearn(text) {
    let m;
    if ((m = text.match(/(?:me llamo|ll[aá]mame|puedes llamarme|mi nombre es)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ][\wÁÉÍÓÚáéíóúÑñ'-]{1,24})/i))) { ASI_MEM.name = cap(m[1].trim()); asiMemSave(); }
    if ((m = text.match(/(?:recuerda|apunta|no olvides|ten en cuenta)(?:\s+que)?\s+(.{3,200})/i))) { ASI_MEM.facts.push(m[1].trim()); if (ASI_MEM.facts.length > 60) ASI_MEM.facts.shift(); asiMemSave(); }
  }
  // Responde usando el CEREBRO (Claude vía Edge Function). Si no está disponible, usa el motor local (sin coste).
  async function asiRespond(text) {
    asiLearn(text);
    try {
      const { data, error } = await sb.functions.invoke("asi-brain", {
        body: { message: text, history: asiHistory.slice(-8), context: asiContext() }
      });
      if (error) throw error;
      if (data && typeof data.reply === "string" && data.reply.trim()) {
        asiHistory.push({ role: "user", content: text });
        asiHistory.push({ role: "assistant", content: data.reply });   // solo el texto, sin secretos
        if (asiHistory.length > 16) asiHistory = asiHistory.slice(-16);
        if (data.didActions) await refresh();
        const notices = Array.isArray(data.notices) ? data.notices.filter(Boolean) : [];
        return notices.length ? (data.reply + "\n\n" + notices.join("\n")) : data.reply;
      }
      throw new Error("sin-respuesta");
    } catch (e) {
      const r = jarvisHandle(text);
      return (r && typeof r.then === "function") ? await r : r;
    }
  }
  function jMe(t) { $("#jLog").appendChild(el("div", "j-msg me", jEsc(t))); jScroll(); }
  function jBot(t) { $("#jLog").appendChild(el("div", "j-msg bot", jEsc(t))); jScroll(); if (jVoiceOn) jSpeak(t); }
  function jScroll() { const l = $("#jLog"); l.scrollTop = l.scrollHeight; }
  function jEsc(s) { return (s || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function jPickVoice() {
    const vs = speechSynthesis.getVoices() || [];
    const es = vs.filter(v => /es[-_]/i.test(v.lang || ""));
    // nombres de voces femeninas en español habituales (macOS / Chrome / Edge)
    const pref = ["mónica","monica","paulina","marisol","helena","elvira","penélope","penelope",
                  "laura","lucía","lucia","sabina","ximena","google español"];
    for (const p of pref) { const v = es.find(x => (x.name || "").toLowerCase().includes(p)); if (v) return v; }
    const fem = es.find(x => /female|mujer|femenin/i.test(x.name || "")); if (fem) return fem;
    return es[0] || vs[0] || null;
  }
  function jSpeak(t) {
    try {
      const u = new SpeechSynthesisUtterance(String(t).replace(/[•🧠⚠️✅👌🔊🔇🎤🛰️🎯]/g, ""));
      const v = jPickVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "es-ES";
      u.rate = 1.04; u.pitch = 1.12; // tono ligeramente más alto → voz femenina
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) {}
  }
  function jListen(SR) {
    const mic = $("#jMic");
    try { const r = new SR(); r.lang = "es-ES"; r.interimResults = false; mic.classList.add("rec");
      r.onresult = (e) => { $("#jText").value = e.results[0][0].transcript; jSubmit(); };
      r.onend = () => mic.classList.remove("rec"); r.onerror = () => mic.classList.remove("rec"); r.start();
    } catch (e) { mic.classList.remove("rec"); }
  }

  function jarvisHandle(text) {
    const q = jn(text), A = state.agg || {};
    const has = (...ks) => ks.some(k => q.includes(k));
    if (!state.loaded) return "Dame un segundo, que estoy cargando los datos…";
    // ── APRENDIZAJE / MEMORIA ──
    let mm;
    if ((mm = text.match(/(?:me llamo|ll[aá]mame|puedes llamarme|mi nombre es)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ][\wÁÉÍÓÚáéíóúÑñ'-]{1,24})/i))) {
      ASI_MEM.name = cap(mm[1].trim()); asiMemSave(); return asiSay("learned") + ` Encantada, ${ASI_MEM.name}.`;
    }
    if ((mm = text.match(/(?:recuerda|apunta|no olvides|ten en cuenta)(?:\s+que)?\s+(.{3,200})/i))) {
      ASI_MEM.facts.push(mm[1].trim()); if (ASI_MEM.facts.length > 60) ASI_MEM.facts.shift(); asiMemSave(); return asiSay("learned");
    }
    if (has("que recuerdas", "que sabes de mi", "que tienes de mi", "como me llamo")) return jRecall();
    // ── TAREAS DE AGENTES ──
    if (has("tarea", "tareas") && has("crea", "crear", "asigna", "asignar", "nueva", "ponle", "pon ", "añade", "agrega", "anota", "encarga", "manda")) return jCreateTask(text);
    if (has("tarea", "tareas")) return jTasksList();
    // ── ACCIONES (registra solicitud; ejecuta sola las de bajo riesgo, encola el dinero) ──
    const _hasEmail = /[\w.+-]+@[\w.-]+\.\w+/.test(text);
    if (_hasEmail && has("agente", "asesor") && has("crea", "crear", "nuevo", "alta", "contrat", "fichar", "ficha", "incorpora", "da de alta")) return jCreateAgentReal(text);
    if (has("cliente", "clienta") && has("crea", "crear", "nuevo", "nueva", "registra", "alta", "añade", "agrega", "da de alta", "mete", "apunta")) return jCreateClient(text);
    if (has("cliente", "inversor") && has("busc", "conseg", "traer", "trae", "capta", "atrae", "atraer", "mas client", "mas inversor", "nuevos client")) return jGrowthPlan(text);
    if (has("captar", "capta", "captacion", "inversor", "conseguir", "crecer", "crecimiento", "mejora", "mejorar", "optimiz", "contrat", "fichar")) return jGrowthPlan(text);
    if (has("agente", "asesor") && has("crea", "crear", "alta", "nuevo", "incorpora", "da de alta")) return "Para fichar a un asesor dime su email (ej.: \"ficha al agente maria@correo.com\") y lo dejo preparado para tu aprobación. Y si quieres más inversores para su cartera, pídeme \"capta inversores\" y te doy el plan.";
    if (has("aprueba", "aprobar") && has("retiro", "retirada", "reintegro")) return jCreateReq("approve_withdrawal", "Aprobar un retiro (revisar importe y cliente en el panel)", { raw: text }, "money");
    if (has("rechaza", "rechazar") && has("retiro", "retirada", "reintegro")) return jCreateReq("reject_withdrawal", "Rechazar un retiro", { raw: text }, "money");
    if (has("deposito", "ingreso") && has("rechaz", "deniega", "denega", "no confirm", "no aprueb")) return jMoneyDeposits(text, "reject");
    if (has("deposito", "ingreso") && has("aprueba", "aprobar", "confirma", "acepta", "valida")) return jMoneyDeposits(text, "approve");
    if (has("denegalos", "deniegalos", "rechazalos", "denialos", "denegar los", "rechazar los")) return jMoneyDeposits(text, "reject");
    if (has("apruebalos", "confirmalos", "aceptalos", "validalos", "aprobar los", "confirmar los")) return jMoneyDeposits(text, "approve");
    if (has("convierte", "convertir") && has("lead")) return jReqLead(text, "convert_lead");
    if (has("descarta", "descartar") && has("lead")) return jReqLead(text, "discard_lead");
    if (has("asigna", "asignar") && has("cliente", "agente")) return "Para asignar con seguridad necesito saber el cliente y el agente exactos. Dímelos (o hazlo desde la sección de clientes del panel) y lo dejo preparado.";
    if (has("actualiza", "refresca", "recarga")) { refresh(); return "Actualizando los datos en vivo…"; }
    if (has("abre", "abrir")) return jOpen(q);
    if (has("objetivo", "mision", "meta", "2000", "registro", "ritmo", "2027")) return jGoal();
    if (has("lead", "captacion")) return jLeads();
    if (has("alerta", "hallazgo", "critic", "problema", "incidencia", "fallo", "urgente")) return jAlerts();
    if (has("deposito", "retiro", "caja", "tesoreria", "flujo", "dinero")) return jTreasury();
    if (has("cliente", "cartera", "aum", "patrimonio")) return jClients();
    if (has("agente", "equipo", "plantilla", "neurona")) return jAgents();
    if (has("priori", "que hago", "que hacer", "foco", "empiezo", "primero")) return jPriority();
    if (has("portal", "salud", "caido", "uptime", "sitio", "web")) return jHealth();
    if (has("ayuda", "puedes", "comandos", "opciones")) return jHelp();
    if (has("gracias", "genial", "perfecto")) return asiSay("thanks");
    if (has("hola", "buenas", "asi", "jarvis", "como vamos", "resumen", "estado", "que tal", "que hay")) return jBriefing();
    return asiSay("notUnderstood");
  }
  function jBriefing() { return asiSay("briefing"); }
  function jGoal() { return state.agg.goal ? asiSay("goal") : "El objetivo aún se está calculando, dame un segundo."; }
  function jLeads() {
    const ls = state.data.leads || [], by = s => ls.filter(l => l.status === s).length;
    return asiSay("leads") + `\n(${by("new")} nuevos · ${by("contacted")} contactados · ${by("converted")} convertidos)`;
  }
  function jAlerts() {
    const fs = (state.findings || []).filter(f => !f.acked);
    if (!fs.length) return asiSay("alertsNone");
    const top = [...fs.filter(f => f.sev === "crit"), ...fs.filter(f => f.sev === "high")].slice(0, 3).map(f => `• ${f.title}`).join("\n");
    return asiSay("alertsSome") + (top ? "\n" + top : "");
  }
  function jTreasury() { return asiSay("treasury"); }
  function jClients() { return asiSay("clients") + (state.agg.clientsNoAgent ? ` (${state.agg.clientsNoAgent} sin agente)` : ""); }
  function jAgents() {
    const wf = {}; (state.findings || []).filter(f => !f.acked).forEach(f => wf[f.agentId] = (wf[f.agentId] || 0) + 1);
    const busy = Object.entries(wf).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([id, n]) => { const a = AGENTS.find(x => x.id === id); return `${a ? a.icon : ""} ${a ? a.name : id} (${n})`; }).join(", ");
    return asiSay("agents") + (busy ? ` Con más lío: ${busy}.` : "");
  }
  function jPriority() {
    const fs = (state.findings || []).filter(f => !f.acked).sort((a, b) => SEV[b.sev] - SEV[a.sev]);
    return fs.length ? asiSay("prioritySome", { tituloTop: (fs[0].agentIcon ? fs[0].agentIcon + " " : "") + fs[0].title, detalleTop: fs[0].detail || "" }) : asiSay("priorityNone");
  }
  function jHealth() {
    const ps = state.agg.sitePings || [];
    if (!ps.length) return "Aún no he sondeado los portales; dame un momento o pulsa 'Sondear ahora'.";
    const down = ps.filter(s => s.status === "down");
    return down.length ? asiSay("healthDown", { detalleTop: down.map(s => s.name).join(", ") }) : asiSay("healthOk");
  }
  function jRecall() {
    const parts = [];
    if (ASI_MEM.name) parts.push("te llamas " + ASI_MEM.name);
    if (ASI_MEM.facts.length) parts.push("me pediste recordar: " + ASI_MEM.facts.slice(-6).join("; "));
    if (!parts.length) return "Aún no me has contado nada que recordar. Dime \"me llamo…\" o \"recuerda que…\" y lo guardo.";
    return "Esto es lo que tengo de ti: " + parts.join(". ") + ".";
  }
  function asiProactive() {
    const fab = $("#jarvisFab"), badge = $("#jBadge"); if (!fab || !badge) return;
    const crit = (state.findings || []).filter(f => f.sev === "crit" && !f.acked);
    const newLeads = (state.data.leads || []).filter(l => l.status === "new");
    const seenF = new Set(ASI_MEM.seenF), seenL = new Set(ASI_MEM.seenL);
    if (!asiInited) { // primera carga: marcar lo existente como visto, sin avisar
      crit.forEach(f => seenF.add(f.key)); newLeads.forEach(l => seenL.add(l.id));
      ASI_MEM.seenF = [...seenF].slice(-300); ASI_MEM.seenL = [...seenL].slice(-300); asiMemSave(); asiInited = true; return;
    }
    const freshC = crit.filter(f => !seenF.has(f.key)), freshL = newLeads.filter(l => !seenL.has(l.id));
    const msgs = [];
    if (freshC.length) msgs.push(asiSay("proactiveCrit", { tituloTop: freshC[0].title }));
    if (freshL.length) msgs.push(asiSay("proactiveLead", { leadsNuevos: freshL.length }));
    freshC.forEach(f => seenF.add(f.key)); freshL.forEach(l => seenL.add(l.id));
    ASI_MEM.seenF = [...seenF].slice(-300); ASI_MEM.seenL = [...seenL].slice(-300);
    // aviso de ritmo del objetivo: máx. 1 vez al día y solo si vamos por detrás
    const g = state.agg.goal, today = new Date().toISOString().slice(0, 10);
    if (!msgs.length && g && g.status === "bad" && ASI_MEM.lastPace !== today) { ASI_MEM.lastPace = today; msgs.push(asiSay("proactivePace")); }
    asiMemSave();
    if (!msgs.length) return;
    const open = !$("#jarvis").classList.contains("hidden");
    if (open) { msgs.forEach(m => jBot(m)); }  // con el chat abierto, jBot ya habla si la voz está activa
    else { // con el chat cerrado: solo aviso visual (los navegadores bloquean voz sin interacción)
      badge.textContent = (parseInt(badge.textContent || "0", 10) || 0) + msgs.length;
      badge.style.display = "flex"; fab.classList.add("alert");
    }
  }
  function jOpen(q) { const map = [["admin", /admin/], ["agente", /agent/], ["cliente", /client/], ["inicio", /inicio|publica|web/]];
    for (const [lbl, rx] of map) { if (rx.test(q)) { const s = (C.SITES || []).find(x => rx.test(jn(x.name)) || rx.test(lbl)); if (s) { window.open(s.url, "_blank"); return `Abriendo ${s.name}…`; } } }
    return "¿Qué portal abro? Di: abre admin, abre cliente, abre agente o abre inicio."; }
  function jHelp() { return asiSay("help") + `\n\nÓrdenes útiles: "convierte el lead correo@x.com", "crea un agente correo@x.com", "aprueba un retiro" (el dinero siempre te lo consulto), "abre admin/cliente/agente/inicio", "actualiza". Y para que aprenda: "me llamo…", "recuerda que…", "¿qué recuerdas?". 🎤 para hablar, 🔊 para que conteste en voz.`; }

  async function jCreateReq(type, summary, params, risk) {
    try {
      const { data, error } = await sb.from("neuron_action_requests")
        .insert({ source: "jarvis", action_type: type, summary, params: params || {}, risk, status: "pending", requested_by: state.userId })
        .select().single();
      if (error) throw error;
      if (type === "convert_lead" || type === "discard_lead") { // bajo riesgo y resoluble → ASI lo hace sola
        const ex = await execAction({ action_type: type, params });
        await sb.from("neuron_action_requests").update({ status: ex.ok ? "executed" : "failed", result: ex.msg, decided_by: state.userId, decided_at: new Date().toISOString() }).eq("id", data.id);
        await refresh();
        return ex.ok ? asiSay("actionDone") + ` (${summary})` : `No pude ejecutarlo: ${ex.msg}.`;
      }
      await refresh();
      return (risk === "money" ? asiSay("actionMoney") : asiSay("actionQueued")) + ` — "${summary}".`;
    } catch (e) { return "No pude registrar la acción: " + (e.message || e); }
  }
  function jFindLead(q) {
    const isOpen = s => /^(new|nuevo|contacted|contactado)$/i.test((s || "").trim());
    const ls = (state.data.leads || []).filter(l => isOpen(l.status));
    return ls.filter(l => (l.email && q.includes(jn(l.email))) || (l.full_name && l.full_name.length > 2 && q.includes(jn(l.full_name))));
  }
  function jReqLead(text, type) {
    const m = jFindLead(jn(text));
    if (!m.length) return Promise.resolve("No encuentro ese lead. Dime su email exacto, p. ej.: \"convierte el lead juan@email.com\".");
    if (m.length > 1) return Promise.resolve(`Hay ${m.length} leads que encajan. Especifica el email para no equivocarme.`);
    const l = m[0], verb = type === "convert_lead" ? "Convertir" : "Descartar";
    return jCreateReq(type, `${verb} lead ${l.email}`, { lead_id: l.id, email: l.email }, "low");
  }
  function jReqAgent(text) {
    const email = (text.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || null;
    return jCreateReq("create_agent", `Crear agente${email ? (" " + email) : ""}`, { raw: text, email }, "high");
  }
  // Tareas de agentes por chat/voz
  async function jCreateTask(text) {
    let m = text.match(/tarea\s+(?:para|a|de|al)\s+([^:]+?)\s*:\s*(.+)/i), agentId = null, agentName = "", title;
    if (m) {
      title = m[2].trim();
      const nm = jn(m[1]);
      const ag = (state.data.profiles || []).filter(p => p.role === "agent").find(p => jn(p.full_name || "").includes(nm) || jn(p.email || "").includes(nm));
      if (ag) { agentId = ag.id; agentName = ag.full_name || ag.email; }
      else return `No encuentro al agente "${m[1].trim()}". Dime el nombre exacto o créala sin asignar: "crea tarea: ${title}".`;
    } else {
      m = text.match(/tarea\s*:?\s*(.+)/i);
      if (!m) return 'Dímelo así: "crea tarea para [agente]: llamar a los leads nuevos".';
      title = m[1].trim();
    }
    const { error } = await sb.from("agent_tasks").insert({ agent_id: agentId, title, priority: "normal", created_by: state.userId, status: "pending" });
    if (error) return "No pude crear la tarea: " + error.message;
    await refresh();
    return `Hecho ✅ Tarea creada${agentName ? ` para ${agentName}` : " (sin asignar)"}: "${title}". ¿La pongo prioritaria o asigno a alguien?`;
  }
  function jTasksList() {
    const ts = state.data.tasks || [];
    if (!ts.length) return 'No hay tareas asignadas. Dime "crea tarea para [agente]: …" y la pongo.';
    const by = s => ts.filter(t => t.status === s).length;
    const pend = ts.filter(t => t.status !== "done").slice(0, 5).map(t => `• ${t.title}`).join("\n");
    return `Tareas: ${by("pending")} pendientes, ${by("in_progress")} en curso, ${by("done")} hechas.\n${pend}`;
  }

  // Dinero sobre depósitos pendientes (aprobar/rechazar) — siempre queda registrado, no se ejecuta solo
  async function jMoneyDeposits(text, mode) {
    const n = state.agg.depositsPendingCount || 0;
    if (!n) return "Ahora mismo no hay depósitos pendientes. ¿Te referías a otra cosa?";
    const verbo = mode === "reject" ? "rechazar" : "confirmar";
    try {
      await sb.from("neuron_action_requests").insert({ source: "jarvis", action_type: mode === "reject" ? "reject_deposit" : "approve_deposit", summary: (mode === "reject" ? "Rechazar " : "Confirmar ") + n + " deposito(s) pendiente(s)", params: { count: n, raw: text }, risk: "money", status: "pending", requested_by: state.userId });
      await refresh();
    } catch (e) { return "No pude registrarlo: " + (e.message || e); }
    return `Entendido: ${verbo} los ${n} depósito(s) pendientes. Como es dinero no lo ejecuto yo sola: lo dejé en el Centro de aprobaciones y el ${verbo} final lo confirmas en el panel admin (revisando cada uno). Tú mandas, pero con el dinero vamos sobre seguro. 💰`;
  }

  // Extrae nombre/email/teléfono de una frase en lenguaje natural
  function jParsePerson(text) {
    const email = (text.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || null;
    const phoneRaw = (text.match(/\+?\d[\d\s().-]{6,}\d/) || [])[0] || null;
    const phone = phoneRaw ? phoneRaw.replace(/[^\d+]/g, "") : null;
    let rest = text.replace(/[\w.+-]+@[\w.-]+\.\w+/g, " ").replace(/\+?\d[\d\s().-]{6,}\d/g, " ");
    rest = rest.replace(/\b(crea|crear|un|una|nuevo|nueva|cliente|clienta|agente|asesor|asesora|con|estos|datos|registra|alta|da|de|anade|añade|agrega|ficha|fichar|incorpora|telefono|tel[eé]fono|tel|movil|m[oó]vil|whatsapp|wasap|numero|n[uú]mero|email|correo|mail|nombre|llamad[oa]|se llama|y|el|la|al|para|por|favor|pon|ponle|esta|este)\b/gi, " ");
    const words = rest.split(/[\s,;:]+/).filter(w => w.length > 1 && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(w) && !/\d/.test(w) && !/@/.test(w));
    const name = words.slice(0, 3).join(" ").trim() || null;
    return { name, email, phone };
  }
  // CREAR CLIENTE de verdad (RLS admin) desde el chat
  async function jCreateClient(text) {
    const p = jParsePerson(text);
    if (!p.email && !p.name) return 'Para crear un cliente dime al menos nombre y email. Ej.: "crea un cliente Juan Pérez, juan@correo.com, 600111222".';
    const { error } = await sb.from("clients").insert({ full_name: p.name, email: p.email, phone: p.phone, status: "potential", crm_status: "NUEVO" });
    if (error) return "No pude crear el cliente: " + error.message;
    await refresh();
    return `Hecho ✅ Cliente creado: ${p.name || "(sin nombre)"}${p.email ? " · " + p.email : ""}${p.phone ? " · " + p.phone : ""}. Ya está en la cartera. ¿Le asigno un agente?`;
  }
  // CREAR AGENTE de verdad (vía Edge Function segura con service_role en el servidor)
  async function jCreateAgentReal(text) {
    const p = jParsePerson(text);
    if (!p.email) return 'Para crear un agente dime su email. Ej.: "crea un agente María López, maria@correo.com".';
    try {
      const { data, error } = await sb.functions.invoke("neuron-create-agent", { body: { email: p.email, full_name: p.name } });
      if (error) return "No pude crear el agente: " + (error.message || error);
      if (data && data.ok === false) return "No pude crear el agente: " + (data.error || "error");
      await refresh();
      return `Hecho ✅ Agente creado: ${p.name || p.email} (${p.email}). Contraseña temporal: ${data.password} — que la cambie al entrar. Ya puede atender clientes.`;
    } catch (e) { return "No pude crear el agente: " + (e.message || e); }
  }

  // Plan de crecimiento: entiende "captar inversores / mejorar / contratar agentes / crecer"
  function jGrowthPlan(text) {
    const q = jn(text), g = state.agg.goal || {};
    const recs = (state.findings || []).filter(f => ["marketing", "seo", "social", "captacion", "conversion"].includes(f.agentId) && !f.acked);
    const top = recs.slice(0, 5).map(f => `• ${f.title}`).join("\n")
      || "• 1 guía SEO de intención + 1 vídeo corto, difundidos en grupos 50+\n• 1 webinar mensual y pedir referidos a clientes\n• Alianzas con gestorías y colectivos de prejubilados";
    const base = /^https?:/.test(location.href) ? location.origin : "https://asi.nextstepasesor.com";
    let out = asiSay("growth");
    out += `\n\nObjetivo: ${g.target || 2000} registros antes de 2027 (vamos ${jStatus(g.status)}). Lo que movería ya para captar inversores:\n${top}`;
    out += `\n\nComparte estos enlaces y empezarán a entrar leads al panel:\n• ${base}/activos/landing-complementar-pension.html\n• ${base}/activos/calculadora-pension.html`;
    if (/contrat|fichar|ficha|agente|asesor/.test(q))
      out += `\n\nPara fichar un asesor dime su email (ej.: "ficha al agente maria@correo.com") y lo dejo preparado para tu aprobación.`;
    out += `\n\n¿Quieres que te prepare el contenido, que priorice los leads que ya tienes, o que fiche a alguien?`;
    return out;
  }

  /* ---------- arranque ---------- */
  sb.auth.onAuthStateChange((_e, session) => { if (!session) { /* logged out */ } });
  boot();
})();
