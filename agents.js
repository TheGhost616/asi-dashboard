/* =====================================================================
 *  NEURON · Motor de agentes proactivos
 *  Cada agente recibe un contexto (ctx) con los datos en vivo y devuelve
 *  una lista de "hallazgos" (findings): fallos, riesgos o mejoras.
 *  Severidades: 'crit' | 'high' | 'med' | 'info'
 *  El CEO (en app.js) agrega y prioriza todo esto.
 * ===================================================================== */
(function () {
  "use strict";

  // --- Buckets de estado (tolerante a ES/EN y mayúsculas) ---
  const DONE = ["approved","completed","confirmed","done","paid","success","settled",
                "aprobado","completado","confirmado","pagado","exitoso","liquidado","ok"];
  const PENDING = ["pending","in_review","review","processing","hold","new",
                   "pendiente","en_revision","revision","procesando","retenido","nuevo"];
  const REJECTED = ["rejected","cancelled","canceled","failed","denied",
                    "rechazado","cancelado","fallido","denegado"];
  function bucket(s) {
    const v = (s || "").toString().trim().toLowerCase();
    if (DONE.includes(v)) return "done";
    if (PENDING.includes(v)) return "pending";
    if (REJECTED.includes(v)) return "rejected";
    return "other";
  }

  const H = {
    bucket,
    hoursSince: (d) => d ? (Date.now() - new Date(d).getTime()) / 3.6e6 : Infinity,
    daysSince:  (d) => d ? (Date.now() - new Date(d).getTime()) / 8.64e7 : Infinity,
    eur: (n) => (Number(n) || 0).toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }),
    isToday: (d) => { if (!d) return false; const t = new Date(d), n = new Date();
      return t.getFullYear() === n.getFullYear() && t.getMonth() === n.getMonth() && t.getDate() === n.getDate(); },
    clientName: (ctx, id) => (ctx.byClient[id] && (ctx.byClient[id].full_name || ctx.byClient[id].email)) || "cliente",
  };

  // Atajos a los paneles operativos para "ir a resolver"
  const LINKS = (NEURON.SITES || []).reduce((m, s) => {
    if (/admin/i.test(s.name)) m.admin = s.url;
    if (/agente/i.test(s.name)) m.agent = s.url;
    if (/cliente/i.test(s.name)) m.client = s.url;
    return m;
  }, {});

  const f = (sev, title, detail, extra) => Object.assign({ sev, title, detail }, extra || {});

  // Comprueba el estado de UN portal concreto a partir de los sondeos (sitePings)
  function itCheck(ctx, rx, label) {
    const out = [], SLA = ctx.SLA || {};
    const slow = SLA.siteSlowMs || 3500;
    const s = (ctx.agg.sitePings || []).find(p => rx.test(p.name || ""));
    if (!s) return out; // todavía sin sondeo
    if (s.status === "down") out.push(f("crit", `${label}: caído`,
      `Sin respuesta de ${s.url}. Revisa el despliegue / DNS / certificado.`, { link: s.url, action: "Abrir" }));
    else if (s.status === "up" && s.ms > slow) out.push(f("med", `${label}: lento (${s.ms} ms)`,
      `Responde por encima de ${slow} ms. Revisa rendimiento / CDN.`, { link: s.url, action: "Abrir" }));
    return out;
  }

  // ---------------------------------------------------------------
  const AGENTS = [
    /* 1 ── TESORERÍA */
    {
      id: "tesoreria", name: "Agente Tesorería", role: "Depósitos y retiros", icon: "💰",
      mission: "Vigila el flujo de caja: depósitos por confirmar, retiros pendientes y saldos anómalos.",
      run(ctx) {
        const out = [], S = ctx.SLA;
        const depsPend = ctx.data.movements.filter(m => /deposit|ingreso/i.test(m.type) && bucket(m.status) === "pending");
        const depLate = depsPend.filter(m => H.hoursSince(m.created_at) > S.depositReviewHours);
        if (depLate.length) out.push(f("high", `${depLate.length} depósito(s) sin confirmar > ${S.depositReviewHours}h`,
          `Hay depósitos pendientes de validar. Confírmalos o recházalos para no bloquear al cliente.`,
          { link: LINKS.admin, action: "Revisar depósitos" }));
        const noProof = depsPend.filter(m => !m.proof_path);
        if (noProof.length) out.push(f("med", `${noProof.length} depósito(s) sin comprobante`,
          `Depósitos pendientes que no adjuntan justificante de pago. Solicítalo antes de confirmar.`));

        const wPend = ctx.data.withdrawals.filter(w => bucket(w.status) === "pending");
        const wLate = wPend.filter(w => H.hoursSince(w.requested_at || w.created_at) > S.withdrawalReviewHours);
        if (wLate.length) out.push(f("high", `${wLate.length} retiro(s) pendiente(s) > ${S.withdrawalReviewHours}h`,
          `Retiros esperando aprobación más allá del SLA. Riesgo de queja del cliente.`,
          { link: LINKS.admin, action: "Revisar retiros" }));

        const neg = ctx.data.clients.filter(c => Number(c.current_balance) < 0);
        if (neg.length) out.push(f("high", `${neg.length} cliente(s) con saldo negativo`,
          `Saldo por debajo de 0 € — posible error de cálculo o sobregiro: ${neg.slice(0,3).map(c=>c.full_name||c.email).join(", ")}.`));

        if (ctx.agg.netFlowToday < 0 && Math.abs(ctx.agg.netFlowToday) > 0)
          out.push(f("info", `Flujo neto negativo hoy: ${H.eur(ctx.agg.netFlowToday)}`,
            `Hoy salen más fondos de los que entran. Vigila la tendencia de retiros.`));
        return out;
      }
    },

    /* 2 ── CUMPLIMIENTO / AML */
    {
      id: "cumplimiento", name: "Agente Cumplimiento", role: "AML · KYC · CNMV", icon: "🛡️",
      mission: "Detecta riesgos regulatorios: retiros grandes, KYC incompleto y SLA de revisión AML.",
      run(ctx) {
        const out = [], S = ctx.SLA;
        const big = ctx.data.withdrawals.filter(w => Number(w.amount) >= S.largeWithdrawalEur && bucket(w.status) !== "rejected");
        if (big.length) out.push(f("high", `${big.length} retiro(s) de importe alto (≥ ${H.eur(S.largeWithdrawalEur)})`,
          `Importes elevados que requieren doble verificación AML antes de pagar.`,
          { link: LINKS.admin, action: "Revisar AML" }));

        const wCrit = ctx.data.withdrawals.filter(w => bucket(w.status) === "pending" && H.hoursSince(w.requested_at||w.created_at) > S.withdrawalReviewHours * 2);
        if (wCrit.length) out.push(f("crit", `${wCrit.length} retiro(s) muy retrasado(s) (> ${S.withdrawalReviewHours*2}h)`,
          `Incumplimiento severo de SLA de revisión. Resuelve de inmediato.`, { link: LINKS.admin }));

        // KYC: clientes con movimiento/retiro pero sin documentos
        const docByClient = ctx.agg.docsByClient;
        const movedClients = new Set([...ctx.data.movements.map(m=>m.client_id), ...ctx.data.withdrawals.map(w=>w.client_id)]);
        const noKyc = ctx.data.clients.filter(c => movedClients.has(c.id) && !(docByClient[c.id] > 0));
        if (noKyc.length) out.push(f("high", `${noKyc.length} cliente(s) con operativa pero sin documentación KYC`,
          `Clientes que mueven dinero sin documentos cargados. Requisito de cumplimiento.`));
        return out;
      }
    },

    /* 3 ── CRM / CLIENTES */
    {
      id: "crm", name: "Agente CRM", role: "Clientes y conversión", icon: "👥",
      mission: "Cuida la cartera: potenciales sin convertir, clientes sin agente y cuentas sin fondear.",
      run(ctx) {
        const out = [];
        const pot = ctx.data.clients.filter(c => /potential|potencial|lead/i.test(c.status||"") || /potential|potencial|lead/i.test(c.crm_status||""));
        if (pot.length) out.push(f("med", `${pot.length} cliente(s) potencial(es) sin convertir`,
          `Leads en el embudo. Asigna seguimiento comercial para acelerar la conversión.`, { link: LINKS.agent }));

        const noAgent = ctx.data.clients.filter(c => !c.assigned_agent_id);
        if (noAgent.length) out.push(f("high", `${noAgent.length} cliente(s) sin agente asignado`,
          `Clientes huérfanos: nadie los gestiona. Asígnales un asesor.`, { link: LINKS.admin }));

        const unfunded = ctx.data.clients.filter(c => bucket(c.status) !== "rejected" && Number(c.current_balance) <= 0 && !/potential|potencial|lead/i.test(c.status||""));
        if (unfunded.length) out.push(f("med", `${unfunded.length} cuenta(s) activa(s) sin fondos`,
          `Clientes activos con saldo 0 €. Impulsa el primer depósito.`));

        const newToday = ctx.data.clients.filter(c => H.isToday(c.created_at));
        if (newToday.length) out.push(f("info", `${newToday.length} cliente(s) nuevo(s) hoy 🎉`,
          `Da la bienvenida y agenda el onboarding para asegurar el primer depósito.`));
        return out;
      }
    },

    /* 4 ── OPERACIONES */
    {
      id: "operaciones", name: "Agente Operaciones", role: "Trading y posiciones", icon: "📈",
      mission: "Supervisa posiciones abiertas demasiado tiempo, pérdidas grandes y datos anómalos.",
      run(ctx) {
        const out = [], S = ctx.SLA;
        const open = ctx.data.operations.filter(o => bucket(o.status) !== "done" && (o.status||"").toLowerCase() !== "closed");
        const stale = open.filter(o => H.daysSince(o.opened_at || o.created_at) > S.operationOpenDays);
        if (stale.length) out.push(f("med", `${stale.length} operación(es) abiertas > ${S.operationOpenDays} días`,
          `Posiciones antiguas sin cerrar. Revisa si procede cerrar o actualizar.`, { link: LINKS.agent }));

        const bigLoss = ctx.data.operations.filter(o => Number(o.profit_loss) <= -S.bigLossEur);
        if (bigLoss.length) out.push(f("high", `${bigLoss.length} operación(es) con pérdida > ${H.eur(S.bigLossEur)}`,
          `Pérdidas relevantes (total ${H.eur(bigLoss.reduce((a,o)=>a+Number(o.profit_loss||0),0))}). Avisa al cliente y documenta.`));

        const anom = ctx.data.operations.filter(o => Math.abs(Number(o.profitability)) > 500);
        if (anom.length) out.push(f("info", `${anom.length} operación(es) con rentabilidad anómala (>500%)`,
          `Valores extremos: posible error de captura de datos. Verifica.`));
        return out;
      }
    },

    /* 5 ── SOPORTE */
    {
      id: "soporte", name: "Agente Soporte", role: "Tickets y atención", icon: "🎧",
      mission: "Garantiza que ningún cliente se quede sin respuesta dentro del SLA.",
      run(ctx) {
        const out = [], S = ctx.SLA;
        const openT = ctx.data.tickets.filter(t => /abierto|open|pendiente|pending/i.test(t.status||""));
        const late = openT.filter(t => H.hoursSince(t.updated_at || t.created_at) > S.ticketReplyHours);
        if (late.length) out.push(f("high", `${late.length} ticket(s) sin atender > ${S.ticketReplyHours}h`,
          `Tickets abiertos fuera de SLA de respuesta.`, { link: LINKS.admin, action: "Ir a soporte" }));
        else if (openT.length) out.push(f("info", `${openT.length} ticket(s) abierto(s)`,
          `Soporte dentro de plazo. Mantén el ritmo de respuesta.`));
        return out;
      }
    },

    /* 6 ── IT · DIRECTOR (datos e infraestructura transversal) */
    {
      id: "infra", name: "IT · Director", role: "División IT · datos e infraestructura", icon: "🩺",
      division: "it",
      mission: "Coordina la salud técnica: datos de mercado, realtime y los 4 portales (vía sus sub-IT).",
      run(ctx) {
        const out = [];
        const mp = ctx.data.market_prices || [];
        const freshest = mp.reduce((a, p) => Math.max(a, p.updated_at ? new Date(p.updated_at).getTime() : 0), 0);
        if (!mp.length) out.push(f("med", "Sin precios de mercado en caché",
          `La tabla market_prices está vacía. Revisa la función de mercado (Massive.com).`));
        else if ((Date.now() - freshest) / 3.6e6 > 1) out.push(f("med", "Precios de mercado desactualizados",
          `El último precio tiene más de 1 hora. Puede afectar a la valoración de carteras.`));
        if (!ctx.agg.realtimeOk) out.push(f("info", "Realtime no conectado",
          `La suscripción en tiempo real no está activa; el panel se actualizará por intervalo.`));
        const down = (ctx.agg.sitePings || []).filter(s => s.status === "down").length;
        if (down) out.push(f("high", `${down} portal(es) con incidencia`,
          `Revisa los sub-IT por portal para el detalle y el enlace de cada uno.`));
        return out;
      }
    },

    /* 6.1 ── SUB-IT · INICIO (web pública) */
    {
      id: "it-inicio", name: "Sub-IT · Inicio", role: "División IT · web pública", icon: "🌐", division: "it",
      mission: "Vigila la web pública (inicio): que esté online y responda con rapidez.",
      run(ctx) { return itCheck(ctx, /p[úu]blica|inicio|home/i, "Web pública (inicio)"); }
    },
    /* 6.2 ── SUB-IT · CLIENTE */
    {
      id: "it-cliente", name: "Sub-IT · Cliente", role: "División IT · portal cliente", icon: "👤", division: "it",
      mission: "Vigila el portal del cliente: disponibilidad y latencia.",
      run(ctx) { return itCheck(ctx, /cliente|client/i, "Portal cliente"); }
    },
    /* 6.3 ── SUB-IT · AGENTE */
    {
      id: "it-agente", name: "Sub-IT · Agente", role: "División IT · portal agente", icon: "🧑‍💼", division: "it",
      mission: "Vigila el portal del agente: disponibilidad y latencia.",
      run(ctx) { return itCheck(ctx, /agente|agent/i, "Portal agente"); }
    },
    /* 6.4 ── SUB-IT · ADMIN */
    {
      id: "it-admin", name: "Sub-IT · Admin", role: "División IT · panel admin", icon: "🛠️", division: "it",
      mission: "Vigila el panel de administración: disponibilidad y latencia.",
      run(ctx) { return itCheck(ctx, /admin/i, "Panel admin"); }
    },

    /* ════════ DIVISIÓN DE CRECIMIENTO (contratada por el CEO) ════════
       Objetivo: 2000 registros antes de 2027. Tráfico ORGÁNICO + captación
       del cliente ideal (empleados 40+, ideal 60-65, ticket mínimo 250€).
       Estos subagentes DETECTAN, INVESTIGAN y RECOMIENDAN; la ejecución
       (publicar, campañas) la hace el humano o herramientas conectadas. */

    /* 7 ── DIRECTOR DE MARKETING (lugarteniente del CEO para el objetivo) */
    {
      id: "marketing", name: "Director de Marketing", role: "División Crecimiento · objetivo 2027", icon: "🎯",
      division: "growth",
      mission: "Es dueño del objetivo de 2000 registros. Marca el ritmo, prioriza el foco semanal y garantiza el cumplimiento.",
      run(ctx) {
        const out = [], g = ctx.agg.goal;
        if (g) {
          const perWeek = Math.ceil(g.perWeekNeeded);
          if (g.status === "bad") out.push(f("high", `Por detrás del objetivo 2027 (${g.current}/${g.target})`,
            `Necesitas ~${perWeek} registros/semana (${g.perDayNeeded.toFixed(1)}/día) y faltan ${g.remaining} días. Activa esta semana: 1 artículo SEO + 1 vídeo corto + difusión en grupos. Proyección actual: ${g.projection}.`));
          else if (g.status === "warn") out.push(f("med", `Ritmo algo por debajo del objetivo`,
            `Aprieta a ~${perWeek} registros/semana para llegar a ${g.target} antes de 2027.`));
          else out.push(f("info", `Ritmo OK hacia ${g.target} registros`,
            `Mantén ~${perWeek}/semana. Proyección a 2027: ${g.projection}.`));
        }
        out.push(f("info", "Foco semanal sugerido (orgánico)",
          `1) Publicar 1 guía SEO de intención. 2) 1 vídeo/short educativo. 3) Difundir en 2 grupos/comunidades. 4) Reactivar potenciales. 5) Preparar el próximo webinar.`));
        out.push(f("info", "Cumplimiento en TODA comunicación (CNMV + RGPD)",
          `Sin promesas de rentabilidad ni "sin riesgo"; incluir advertencia de riesgo y test de idoneidad; consentimiento RGPD en cada formulario. Cuidado reforzado con público 60-65 (consumidor potencialmente vulnerable).`));
        return out;
      }
    },

    /* 8 ── SEO & CONTENIDOS */
    {
      id: "seo", name: "SEO & Contenidos", role: "División Crecimiento · tráfico orgánico", icon: "🔎",
      division: "growth",
      mission: "Capta búsquedas de Google de tu cliente ideal con contenido de intención y autoridad (E-E-A-T).",
      run(ctx) {
        const I = ctx.ICP || {};
        return [
          f("info", "Ataca long-tail donde la banca no llega",
            `Crea guías de intención: "cómo complementar la pensión desde ${I.inversionMin || 250}€", "invertir con poco dinero a los 60", "fondos vs plan de pensiones 2026", "invertir siendo jubilado en España". Long-tail informacional = menos competencia que Bankinter/BBVA/Openbank.`),
          f("info", "E-E-A-T (finanzas = contenido YMYL)",
            `Autor con credenciales visibles, página "sobre nosotros" con nº de registro/CNMV, fuentes citadas, fecha de actualización y testimonios reales. Google premia la confianza en temas de dinero.`),
          f("info", "Optimiza para buscadores de IA (AEO/GEO)",
            `Empieza cada artículo con un TL;DR y usa tablas comparativas para que ChatGPT/Gemini/Perplexity te citen. Añade FAQ con schema.org (FAQPage) para los fragmentos destacados.`),
          f("info", "Lead magnet que también posiciona",
            `Publica una calculadora "¿cuánto necesito para complementar mi pensión?" + guía PDF descargable. Capta email (lead) y atrae enlaces/tráfico.`),
        ];
      }
    },

    /* 9 ── SOCIAL ORGÁNICO & VÍDEO */
    {
      id: "social", name: "Social orgánico & vídeo", role: "División Crecimiento · alcance", icon: "📣",
      division: "growth",
      mission: "Construye alcance y confianza donde vive tu público (YouTube, Facebook, vídeo corto) sin pagar anuncios.",
      run(ctx) {
        return [
          f("info", "YouTube = tráfico orgánico a largo plazo",
            `37M de usuarios en España. Vídeos educativos: "3 formas de complementar tu pensión", "Empezar a invertir con 250€ a los 60". Enlaza siempre a la guía/landing de registro.`),
          f("info", "Embudo de mayor ROI: short-video → SEO → comunidad",
            `Vídeo corto (Reels/Shorts/TikTok) atrae → artículo SEO convierte → grupo (Facebook/WhatsApp/Telegram) retiene y reactiva. Orquéstalos, no los lleves sueltos.`),
          f("info", "Grupos de Facebook 50+",
            `Tu público está en Facebook. Aporta valor en grupos de "ahorro/jubilación" (o crea el tuyo). Nada de spam: responde dudas y enlaza recursos útiles.`),
        ];
      }
    },

    /* 10 ── CAPTACIÓN DE INVERSORES */
    {
      id: "captacion", name: "Captación de inversores", role: "División Crecimiento · leads", icon: "🧲",
      division: "growth",
      mission: "Encuentra y convierte inversores del perfil objetivo en registros, con canales de bajo coste.",
      run(ctx) {
        const I = ctx.ICP || {};
        return [
          f("info", "Webinar mensual de captación",
            `"¿Cómo hacer que tus ahorros trabajen tras los 55?" — los webinars convierten muy bien con este público. Cada inscripción es un lead cualificado del perfil objetivo.`),
          f("info", `Hook del ticket bajo (desde ${I.inversionMin || 250}€)`,
            `Comunica el mínimo como barrera mínima de entrada: "empieza con ${I.inversionMin || 250}€". Reduce el miedo y dispara el primer registro.`),
          f("info", "Alianzas para llegar a empleados 55-65",
            `Acuerdos de derivación con gestorías, asesorías fiscales y colectivos de prejubilados/sindicatos. Acceso directo al perfil con trabajo e ingresos estables.`),
          f("info", "Programa de referidos",
            `Tu público confía en el boca a boca. Incentiva que cada cliente traiga a 1 conocido (respetando la normativa sobre incentivos).`),
        ];
      }
    },

    /* 11 ── CONVERSIÓN & LANDING */
    {
      id: "conversion", name: "Conversión & landing", role: "División Crecimiento · embudo", icon: "🛬",
      division: "growth",
      mission: "Convierte el tráfico en registros: landings por intención, confianza y mínima fricción.",
      run(ctx) {
        const out = [];
        out.push(f("info", "Landing por intención + señales de confianza",
          `Una landing por audiencia (jubilación / complementar pensión) con sello CNMV, testimonios, foto del equipo y un CTA claro: "Regístrate gratis".`));
        out.push(f("info", "Reduce la fricción del registro",
          `Pide lo mínimo (email + teléfono); el resto, después. Cada campo extra baja la conversión.`));
        if (ctx.agg.leadsNew > 0) out.push(f("med", `${ctx.agg.leadsNew} lead(s) sin contactar`,
          `Leads de la calculadora/landing pendientes de gestión. Contáctalos pronto: cuentan hacia el objetivo 2027.`, { link: LINKS.admin, action: "Ver leads" }));
        if (ctx.agg.potentialCount > 0) out.push(f("med", `${ctx.agg.potentialCount} potencial(es) a un paso del registro`,
          `Reactívalos por email/llamada: son los leads más cercanos a sumar al objetivo 2027.`, { link: LINKS.agent }));
        if (ctx.agg.depositsTodayCount === 0) out.push(f("info", "0 depósitos hoy",
          `Sin ingresos hoy. Lanza un recordatorio a registrados sin fondear y empuja el "primer paso desde 250€".`));
        return out;
      }
    },
  ];

  window.NEURON_AGENTS = AGENTS;
  window.NEURON_H = H;
})();
