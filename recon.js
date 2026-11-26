// Riconciliazione a tre documenti: ordine Serchio ↔ conferme fornitore ↔ fatture fornitore.
// Logica pura (nessuna chiamata di rete): usata dalla pagina nel browser e dai test in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Recon = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Tolleranze ----------
  const QTOL = 10;      // % quantità: entro questa soglia la differenza è "da verificare" (tolleranze di produzione)
  const PTOL = 0.05;    // EUR/ton: differenza di prezzo ammessa (arrotondamenti)
  const KGTOL = 0.5;    // kg: sotto questa soglia due quantità sono uguali
  const EURTOL = 1;     // EUR: differenza ammessa su importi e totali (arrotondamenti)

  // ---------- Utilità ----------
  const tokens = s => String(s == null ? '' : s).match(/\d+/g) || [];
  const normOrd = s => { const t = tokens(s); return t.length ? String(Number(t[0])) : null; };
  const normPos = s => { const t = tokens(s); return t.length ? String(Number(t[0])) : null; };
  const alnum = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const splitRefs = s => String(s == null ? '' : s).split(/[\/,;+&]|\s+e\s+|\s+and\s+/i).map(x => x.trim()).filter(Boolean);
  const digits = s => String(s == null ? '' : s).replace(/\D/g, '');
  const sum = arr => arr.reduce((s, v) => s + (v || 0), 0);
  const round = (v, d = 3) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
  const uniq = arr => [...new Set(arr.filter(v => v != null && v !== ''))];
  const pct = (base, v) => (base == null || v == null || !base) ? null : (v - base) / base * 100;

  const fmtN = (v, dec = 2) => v == null ? '—' : v.toLocaleString('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: 'always' });
  const fmtKg = v => v == null ? '—' : v.toLocaleString('it-IT', { maximumFractionDigits: 0, useGrouping: 'always' });
  const fmtP = v => v == null ? '—' : v.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
  const fmtPct = p => (p > 0 ? '+' : '') + p.toLocaleString('it-IT', { maximumFractionDigits: 1, useGrouping: 'always' }) + '%';
  // Date: il modello le restituisce come AAAA-MM-GG
  const isoDate = s => {
    const t = String(s || '').trim();
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
    if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
  };
  const fmtD = s => { const d = isoDate(s); return d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—'; };

  // Prima cifra del riferimento che corrisponde a un ordine caricato, altrimenti la prima cifra.
  function pickKey(ref, known) {
    const t = tokens(ref).map(x => String(Number(x)));
    return t.find(x => known.has(x)) || t[0] || null;
  }

  const docLabel = d => d.tipo === 'ordine' ? 'Ord.' : d.tipo === 'conferma' ? 'Conf.' : 'Fatt.';

  // ---------- 1. Raggruppa righe e documenti per numero d'ordine Serchio ----------
  // docs: documenti estratti (tipo ordine | conferma | fattura), ognuno con _file.
  // Una conferma o una fattura può riferirsi a più ordini Serchio: ogni RIGA va all'ordine indicato sulla riga.
  function buildOrders(docs) {
    const known = new Set();
    for (const d of docs) if (d.tipo === 'ordine') { const k = normOrd(d.n_doc) || normOrd(d.n_ordine_serchio); if (k) known.add(k); }
    // N. conferma fornitore → ordine Serchio (serve se la fattura cita solo la conferma)
    const confToOrder = new Map();
    for (const d of docs) {
      if (d.tipo !== 'conferma') continue;
      const k = pickKey(d.n_ordine_serchio, known) || pickKey((d.righe || []).map(r => r.n_ordine_serchio_riga).find(Boolean), known);
      if (k && d.n_doc) confToOrder.set(alnum(d.n_doc), k);
    }
    const orders = new Map();
    const get = k => {
      if (!orders.has(k)) orders.set(k, { key: k, ordini: [], conferme: [], fatture: [], O: [], C: [], F: [] });
      return orders.get(k);
    };
    const attach = (o, list, d) => { if (!o[list].includes(d)) o[list].push(d); };
    const put = (k, d, r, i) => {
      const o = get(k), isConf = d.tipo === 'conferma';
      attach(o, isConf ? 'conferme' : 'fatture', d);
      o[isConf ? 'C' : 'F'].push({ ...r, _doc: d, _i: i, _key: k });
      d._orders.add(k);
    };
    // Ordini citati in testata (es. "512/518" oppure conferme "PT0001111/PT0002222")
    const confKey = ref => splitRefs(ref).map(c => confToOrder.get(alnum(c))).find(Boolean) || null;
    const headerKeys = d => {
      const ks = uniq([
        ...tokens(d.n_ordine_serchio).map(x => String(Number(x))).filter(x => known.has(x)),
        ...splitRefs(d.n_conferma_fornitore).map(c => confToOrder.get(alnum(c))),
      ]);
      return ks.length ? ks : [pickKey(d.n_ordine_serchio, known) || confKey(d.n_conferma_fornitore)].filter(Boolean);
    };
    const rank = { ordine: 0, conferma: 1, fattura: 2 };
    const ambiguous = [];
    for (const d of [...docs].sort((a, b) => rank[a.tipo] - rank[b.tipo])) {
      const righe = d.righe || [];
      d._orders = new Set();
      if (d.tipo === 'ordine') {
        const k = normOrd(d.n_doc) || normOrd(d.n_ordine_serchio) || '?';
        const o = get(k);
        attach(o, 'ordini', d); d._orders.add(k);
        righe.forEach((r, i) => o.O.push({ ...r, _doc: d, _i: i, _key: k }));
        continue;
      }
      const hk = headerKeys(d);
      righe.forEach((r, i) => {
        const k = pickKey(r.n_ordine_serchio_riga, known) || confKey(r.n_conferma_riga);
        if (k) put(k, d, r, i);
        else if (hk.length > 1) ambiguous.push({ d, r, i, cand: hk });
        else put(hk[0] || '?', d, r, i);
      });
      if (!righe.length) { const k = hk[0] || '?'; attach(get(k), d.tipo === 'conferma' ? 'conferme' : 'fatture', d); d._orders.add(k); }
    }
    // Righe di un documento che copre più ordini senza dire a quale appartengono:
    // vanno all'ordine che ha lo stesso articolo (grammatura + altezza) con la quantità ancora aperta più vicina.
    ambiguous.sort((a, b) => (b.r.q_kg || 0) - (a.r.q_kg || 0));
    for (const { d, r, i, cand } of ambiguous) {
      let best = cand[0], bestScore = Infinity;
      for (const k of cand) {
        const o = get(k), base = (o.C.length ? o.C : o.O).filter(x => spec(x) === spec(r));
        if (!base.length) continue;
        const open = sum(base.map(x => x.q_kg)) - sum(o.F.filter(x => spec(x) === spec(r)).map(x => x.q_kg));
        const score = Math.abs(open - (r.q_kg || 0));
        if (score < bestScore) { bestScore = score; best = k; }
      }
      put(best, d, r, i);
    }
    for (const o of orders.values()) o.F.sort((a, b) => a._i - b._i);
    return [...orders.values()].sort((a, b) => (a.key === '?') - (b.key === '?') || Number(a.key) - Number(b.key));
  }

  // ---------- 2. Dati da mandare all'AI per l'abbinamento ----------
  const LINE_FIELDS = ['pos', 'cod_articolo_serchio', 'cod_articolo_fornitore', 'desc', 'gram_carta', 'gram_pe', 'largh_mm',
    'diam_mm', 'foro_mm', 'q_kg', 'prezzo_eur_ton', 'data_consegna', 'data_consegna_fine', 'n_conferma_riga', 'pos_conferma_riga'];
  function compact(lines) {
    return lines.map((r, i) => {
      const o = { i, doc: r._doc.n_doc || r._doc._file || '' };
      for (const f of LINE_FIELDS) if (r[f] != null && r[f] !== '') o[f] = r[f];
      return o;
    });
  }
  function textPairs(o) {
    const ord = o.ordini[0], conf = o.conferme[0], fat = o.fatture[0];
    const t = [];
    const add = (campo, A, B) => { if (A && B) t.push({ campo, A, B }); };
    add('pagamento_ordine_conferma', ord && ord.pagamento, conf && conf.pagamento);
    add('pagamento_conferma_fattura', conf && conf.pagamento, fat && fat.pagamento);
    if (!conf) add('pagamento_ordine_fattura', ord && ord.pagamento, fat && fat.pagamento);
    add('consegna_ordine_conferma', ord && ord.indirizzo_consegna, conf && conf.indirizzo_consegna);
    add('consegna_conferma_fattura', conf && conf.indirizzo_consegna, fat && fat.indirizzo_consegna);
    if (!conf) add('consegna_ordine_fattura', ord && ord.indirizzo_consegna, fat && fat.indirizzo_consegna);
    return t;
  }
  function matchPayload(o) {
    return { O: compact(o.O), C: compact(o.C), F: compact(o.F), testi: textPairs(o) };
  }

  // ---------- 3. Gruppi di righe (un gruppo = un articolo dell'ordine) ----------
  const spec = r => `${Math.round(r.gram_carta || 0)}|${Math.round(r.largh_mm || 0)}`;
  // Riga di conferma esplicitamente citata dalla riga di fattura ("Our Order No.: 4400123 Item: 000007")
  function confRef(o, f) {
    const cn = alnum(f.n_conferma_riga || f._doc.n_conferma_fornitore);
    const pos = normPos(f.pos_conferma_riga);
    if (!cn || !pos) return -1;
    return o.C.findIndex(c => alnum(c._doc.n_doc) === cn && normPos(c.pos) === pos);
  }
  function codeRef(o, r) {
    const c = alnum(r.cod_articolo_serchio);
    return c ? o.O.findIndex(x => alnum(x.cod_articolo_serchio) === c) : -1;
  }

  // Abbinamento a regole (se l'AI non risponde): codice articolo Serchio, riferimenti espliciti, poi grammatura + altezza.
  function fallbackGroups(o) {
    const groups = o.O.map((_, i) => ({ o: [i], c: [], f: [] }));
    const qOf = (g, L, list) => sum(g[L].map(i => o[list][i].q_kg));
    const bySpec = (r, needOrder) => {
      let best = -1, bestScore = Infinity;
      groups.forEach((g, gi) => {
        const ref = g.o.length ? o.O[g.o[0]] : g.c.length ? o.C[g.c[0]] : null;
        if (!ref || (needOrder && !g.o.length) || spec(ref) !== spec(r)) return;
        const base = g.o.length ? qOf(g, 'o', 'O') : qOf(g, 'c', 'C');
        const done = needOrder ? qOf(g, 'c', 'C') : qOf(g, 'f', 'F');
        const score = Math.abs(base - done - (r.q_kg || 0));
        if (score < bestScore) { bestScore = score; best = gi; }
      });
      return best;
    };
    const cGroup = new Map();
    o.C.forEach((c, j) => {
      let gi = codeRef(o, c);
      if (gi < 0) gi = bySpec(c, true);
      if (gi < 0) { groups.push({ o: [], c: [j], f: [] }); gi = groups.length - 1; } else groups[gi].c.push(j);
      cGroup.set(j, gi);
    });
    o.F.forEach((f, k) => {
      const j = confRef(o, f);
      let gi = j >= 0 ? cGroup.get(j) : codeRef(o, f);
      if (gi < 0 || gi == null) gi = bySpec(f, false);
      if (gi < 0) groups.push({ o: [], c: [], f: [k] }); else groups[gi].f.push(k);
    });
    return groups.map(g => ({ ...g, motivo: '', differenze: '' }));
  }

  // Gruppi proposti dall'AI, ripuliti: indici validi e unici, righe dimenticate in gruppi propri,
  // e le righe di fattura che citano esplicitamente una riga di conferma vanno nel gruppo di quella riga.
  function cleanGroups(o, aiGroups) {
    const used = { o: new Set(), c: new Set(), f: new Set() };
    const len = { o: o.O.length, c: o.C.length, f: o.F.length };
    const groups = [];
    for (const g of aiGroups || []) {
      const ng = { o: [], c: [], f: [], motivo: g.motivo || '', differenze: g.differenze || '' };
      for (const L of ['o', 'c', 'f']) for (const i of g[L] || []) {
        if (Number.isInteger(i) && i >= 0 && i < len[L] && !used[L].has(i)) { used[L].add(i); ng[L].push(i); }
      }
      if (ng.o.length || ng.c.length || ng.f.length) groups.push(ng);
    }
    for (const L of ['o', 'c', 'f']) for (let i = 0; i < len[L]; i++) {
      if (!used[L].has(i)) groups.push({ o: L === 'o' ? [i] : [], c: L === 'c' ? [i] : [], f: L === 'f' ? [i] : [], motivo: '', differenze: '' });
    }
    o.F.forEach((f, k) => {
      const j = confRef(o, f);
      if (j < 0) return;
      const gf = groups.find(g => g.f.includes(k)), gc = groups.find(g => g.c.includes(j));
      if (gf && gc && gf !== gc) { gf.f.splice(gf.f.indexOf(k), 1); gc.f.push(k); }
    });
    return groups.filter(g => g.o.length || g.c.length || g.f.length);
  }

  // ---------- 4. Valutazione ----------
  function sameAddress(a, b) {
    const STOP = new Set(['srl', 'spa', 'snc', 'sas', 'ditta', 'via', 'viale', 'loc', 'localita', 'presso', 'c', 'o', 'co', 'n', 'nr', 'it', 'i', 'di', 'del', 'della', 'the']);
    const words = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ')
      .split(' ').filter(w => w.length > 1 && !STOP.has(w));
    const A = new Set(words(a)), B = new Set(words(b));
    if (!A.size || !B.size) return false;
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    let hit = 0; small.forEach(w => { if (big.has(w)) hit++; });
    return hit / small.size >= 0.6;
  }

  const lineRef = r => `${docLabel(r._doc)} ${r._doc.n_doc || r._doc._file || ''}${r.pos ? ' pos. ' + normPos(r.pos) : ''}`;
  const firstVal = (lines, f) => { for (const r of lines) if (r[f] != null && r[f] !== '') return r[f]; return null; };
  // Prezzo medio ponderato sulle quantità
  const avgPrice = lines => {
    const p = lines.filter(r => r.prezzo_eur_ton != null);
    if (!p.length) return null;
    const kg = sum(p.map(r => r.q_kg));
    return kg ? round(sum(p.map(r => r.prezzo_eur_ton * (r.q_kg || 0))) / kg, 2) : p[0].prezzo_eur_ton;
  };

  const SPEC = [
    ['gram_carta', 'Grammatura', 'g/m²', 'err'], ['gram_pe', 'Grammatura PE', 'g/m²', 'err'], ['largh_mm', 'Altezza', 'mm', 'err'],
    ['diam_mm', 'Diametro', 'mm', 'warn'], ['foro_mm', 'Foro/anima', 'mm', 'warn'],
  ];

  function evaluateGroup(o, g, hasOrder, hasConf) {
    const O = g.o.map(i => o.O[i]), C = g.c.map(i => o.C[i]), F = g.f.map(i => o.F[i]);
    const any = O[0] || C[0] || F[0];
    const name = (O[0] && O[0].desc) || (C[0] && C[0].desc) || (F[0] && F[0].desc) || '—';
    const gram = firstVal([...O, ...C, ...F], 'gram_carta'), pe = firstVal([...O, ...C, ...F], 'gram_pe');
    const largh = firstVal([...O, ...C, ...F], 'largh_mm');
    const sub = `${gram ?? '?'}${pe ? '+' + pe + ' PE' : ''} g/m² · H ${largh ?? '?'} mm`;
    const code = firstVal(O, 'cod_articolo_serchio') || firstVal(C, 'cod_articolo_serchio') || firstVal(F, 'cod_articolo_serchio');
    const flags = [], cells = {};
    const add = (sev, text, cell) => { flags.push({ sev, text: `${name}: ${text}` }); if (cell && (cells[cell] !== 'err')) cells[cell] = sev; };

    const qO = O.length ? round(sum(O.map(r => r.q_kg)), 1) : null;
    const qC = C.length ? round(sum(C.map(r => r.q_kg)), 1) : null;
    const qF = F.length ? round(sum(F.map(r => r.q_kg)), 1) : null;
    const pO = avgPrice(O), pC = avgPrice(C), pF = avgPrice(F);

    // Presenza dell'articolo nei tre documenti
    if (hasOrder && !O.length) {
      if (C.length) add('err', `confermato (${fmtKg(qC)} kg) ma non presente nell'ordine Serchio`, 'qC');
      else if (F.length) add('err', `fatturato (${fmtKg(qF)} kg) ma non presente né nell'ordine né in conferma`, 'qF');
    }
    if (hasConf && !C.length && O.length) add('warn', `non ancora confermato dal fornitore (${fmtKg(qO)} kg da confermare)`, 'qC');
    if (F.length && !C.length && hasConf && !(hasOrder && !O.length)) add('err', `fatturato (${fmtKg(qF)} kg) ma non presente nelle conferme caricate`, 'qF');

    // Quantità confermata vs ordinata
    if (O.length && C.length) {
      const d = pct(qO, qC);
      if (Math.abs(qC - qO) > KGTOL) {
        if (Math.abs(d) > QTOL) add('err', `confermati ${fmtKg(qC)} kg su ${fmtKg(qO)} ordinati (${fmtPct(d)}, oltre la tolleranza del ${QTOL}%)`, 'qC');
        else add('warn', `confermati ${fmtKg(qC)} kg su ${fmtKg(qO)} ordinati (${fmtPct(d)}, entro la tolleranza del ${QTOL}%)`, 'qC');
      }
      if (C.length > 1) flags.push({ sev: 'info', text: `${name}: confermato in ${C.length} righe (${C.map(r => fmtKg(r.q_kg)).join(' + ')} kg)` });
    }
    // Quantità fatturata vs confermata (o ordinata se manca la conferma)
    const base = C.length ? qC : qO;
    const baseLbl = C.length ? 'confermati' : 'ordinati';
    if (F.length && base != null && qF - base > KGTOL) {
      const d = pct(base, qF);
      if (d > QTOL) add('err', `fatturati ${fmtKg(qF)} kg, più dei ${fmtKg(base)} kg ${baseLbl} (${fmtPct(d)}, oltre la tolleranza)`, 'qF');
      else add('warn', `fatturati ${fmtKg(qF)} kg su ${fmtKg(base)} ${baseLbl} (${fmtPct(d)}, entro la tolleranza)`, 'qF');
    }

    // Prezzi: conferma vs ordine, fattura vs conferma (riga citata) o ordine
    for (const c of C) {
      if (pO != null && c.prezzo_eur_ton != null && Math.abs(c.prezzo_eur_ton - pO) > PTOL)
        add('err', `prezzo confermato ${fmtP(c.prezzo_eur_ton)} €/t invece di ${fmtP(pO)} €/t ordinati (${lineRef(c)})`, 'pC');
    }
    for (const f of F) {
      if (f.prezzo_eur_ton == null) continue;
      const j = confRef(o, f);
      const ref = j >= 0 && o.C[j].prezzo_eur_ton != null ? o.C[j].prezzo_eur_ton : (pC != null ? pC : pO);
      const lbl = (j >= 0 || pC != null) ? 'confermati' : 'ordinati';
      if (ref != null && Math.abs(f.prezzo_eur_ton - ref) > PTOL)
        add('err', `prezzo fatturato ${fmtP(f.prezzo_eur_ton)} €/t invece di ${fmtP(ref)} €/t ${lbl} (${lineRef(f)})`, 'pF');
      // Importo riga = kg × prezzo
      if (f.importo_eur != null && f.q_kg != null) {
        const calc = f.q_kg / 1000 * f.prezzo_eur_ton;
        if (Math.abs(calc - f.importo_eur) > Math.max(EURTOL, f.importo_eur * 0.001))
          add('err', `importo fatturato ${fmtN(f.importo_eur)} € ma ${fmtKg(f.q_kg)} kg × ${fmtP(f.prezzo_eur_ton)} €/t = ${fmtN(calc)} € (${lineRef(f)})`, 'pF');
      }
    }

    // Caratteristiche tecniche
    for (const [k, label, unit, sev] of SPEC) {
      const vals = uniq([...O, ...C, ...F].map(r => r[k]));
      if (vals.length > 1) {
        const parts = [['ord.', O], ['conf.', C], ['fatt.', F]].map(([l, L]) => { const v = uniq(L.map(r => r[k])); return v.length ? `${l} ${v.join('/')}` : null; }).filter(Boolean);
        add(sev, `${label} diversa tra i documenti (${parts.join(' · ')} ${unit})`, k);
      }
    }
    if (g.differenze) add('warn', g.differenze, 'desc');

    // Date: consegna richiesta → consegna confermata → spedizione fatturata
    const dO = uniq(O.map(r => isoDate(r.data_consegna))).sort()[0] || null;
    const cFrom = uniq(C.map(r => isoDate(r.data_consegna))).sort();
    const cTo = uniq(C.map(r => isoDate(r.data_consegna_fine) || isoDate(r.data_consegna))).sort();
    const dCfrom = cFrom[0] || null, dCto = cTo[cTo.length - 1] || null;
    if (dO && dCfrom && dCfrom > dO) add('warn', `consegna confermata dal ${fmtD(dCfrom)}, richiesta per il ${fmtD(dO)}`, 'dC');
    const limit = dCto || dO;
    for (const f of F) {
      const ds = isoDate(f.data_spedizione);
      if (ds && limit && ds > limit) add('warn', `spedito il ${fmtD(ds)}, dopo la consegna ${dCto ? 'confermata (entro il ' : 'richiesta (il '}${fmtD(limit)})${f.n_ddt ? ' · DDT ' + f.n_ddt : ''}`, 'dF');
    }

    // Residui
    const daConf = O.length ? round(qO - (qC || 0), 1) : null;
    const daFatt = base != null ? round(base - (qF || 0), 1) : null;
    const inTol = (res, b) => b ? Math.abs(res) <= b * QTOL / 100 : false;
    let stato;
    if (!C.length && !F.length) stato = 'da confermare';
    else if (!F.length) stato = 'da fatturare';
    else if (daFatt != null && (Math.abs(daFatt) <= KGTOL || (daFatt > 0 && inTol(daFatt, base)))) stato = Math.abs(daFatt) <= KGTOL ? 'evaso' : 'evaso in tolleranza';
    else if (daFatt != null && daFatt < 0) stato = 'fatturato in eccesso';
    else stato = 'fatturato in parte';
    if (stato === 'evaso in tolleranza') flags.push({ sev: 'info', text: `${name}: fatturati ${fmtKg(qF)} kg su ${fmtKg(base)} ${baseLbl}; mancano ${fmtKg(daFatt)} kg, entro la tolleranza del ${QTOL}% (verificare se il fornitore spedirà il resto)` });

    // Dettaglio righe dei documenti, per mostrare da dove vengono i numeri
    const details = [
      ...O.map(r => `${lineRef(r)}${r.cod_articolo_serchio ? ' · ' + r.cod_articolo_serchio : ''} · ${fmtKg(r.q_kg)} kg · ${fmtP(r.prezzo_eur_ton)} €/t${r.data_consegna ? ' · consegna ' + fmtD(r.data_consegna) : ''}`),
      ...C.map(r => `${lineRef(r)} · ${fmtKg(r.q_kg)} kg · ${fmtP(r.prezzo_eur_ton)} €/t${r.data_consegna ? ' · consegna ' + fmtD(r.data_consegna) + (r.data_consegna_fine && isoDate(r.data_consegna_fine) !== isoDate(r.data_consegna) ? '–' + fmtD(r.data_consegna_fine) : '') : ''}`),
      ...F.map(r => `${lineRef(r)} · ${fmtKg(r.q_kg)} kg · ${fmtP(r.prezzo_eur_ton)} €/t${r.n_ddt ? ' · DDT ' + r.n_ddt : ''}${r.data_spedizione ? ' del ' + fmtD(r.data_spedizione) : ''}`),
    ];

    const sev = flags.some(f => f.sev === 'err') ? 'err' : flags.some(f => f.sev === 'warn') ? 'warn' : 'ok';
    return {
      name, sub, code, O, C, F, qO, qC, qF, pO, pC, pF, daConf, daFatt, stato, sev, cells, flags, details,
      dO, dCfrom, dCto, dF: uniq(F.map(r => isoDate(r.data_spedizione))).sort(),
      motivo: g.motivo || '',
      eurO: O.length ? sum(O.map(r => (r.q_kg || 0) / 1000 * (r.prezzo_eur_ton || 0))) : null,
      eurC: C.length ? sum(C.map(r => (r.q_kg || 0) / 1000 * (r.prezzo_eur_ton || 0))) : null,
      eurF: F.length ? sum(F.map(r => r.importo_eur != null ? r.importo_eur : (r.q_kg || 0) / 1000 * (r.prezzo_eur_ton || 0))) : null,
      _any: any,
    };
  }

  // Controlli di testata su una fattura (valgono per tutta la fattura, anche se copre più ordini)
  function invoiceChecks(fat, conferme) {
    const flags = [];
    const righe = fat.righe || [];
    const nd = fat.n_doc || fat._file;
    if (!digits(fat.piva_buyer).endsWith('05147461007'))
      flags.push({ sev: 'err', text: `Fattura ${nd}: P.IVA Serchio "${fat.piva_buyer || 'assente'}" (attesa IT05147461007)` });
    const tot = sum(righe.map(r => r.importo_eur));
    if (fat.totale_merce != null && righe.some(r => r.importo_eur != null) && Math.abs(tot - fat.totale_merce) > EURTOL)
      flags.push({ sev: 'err', text: `Fattura ${nd}: totale merce ${fmtN(fat.totale_merce)} € ma la somma delle righe è ${fmtN(tot)} €` });
    const kg = sum(righe.map(r => r.q_kg));
    if (fat.massa_netta_kg != null && kg && Math.abs(fat.massa_netta_kg - kg) > Math.max(KGTOL, kg * 0.005))
      flags.push({ sev: 'warn', text: `Fattura ${nd}: massa netta Intrastat ${fmtKg(fat.massa_netta_kg)} kg ma le righe sommano ${fmtKg(kg)} kg` });
    const cnF = uniq([fat.cod_nomenclatura, ...righe.map(r => r.cod_nomenclatura_riga)].map(digits));
    const cnC = uniq(conferme.flatMap(c => [c.cod_nomenclatura, ...(c.righe || []).map(r => r.cod_nomenclatura_riga)]).map(digits));
    for (const a of cnF) {
      if (cnC.length && !cnC.some(b => a === b || a.startsWith(b) || b.startsWith(a)))
        flags.push({ sev: 'err', text: `Fattura ${nd}: codice nomenclatura ${a} non presente in conferma (${cnC.join(', ')})` });
    }
    return { doc: fat, flags, kg, tot };
  }

  const TEXT_LABELS = {
    pagamento_ordine_conferma: ['Pagamento', 'ordine', 'conferma'],
    pagamento_conferma_fattura: ['Pagamento', 'conferma', 'fattura'],
    pagamento_ordine_fattura: ['Pagamento', 'ordine', 'fattura'],
    consegna_ordine_conferma: ['Indirizzo di consegna', 'ordine', 'conferma'],
    consegna_conferma_fattura: ['Indirizzo di consegna', 'conferma', 'fattura'],
    consegna_ordine_fattura: ['Indirizzo di consegna', 'ordine', 'fattura'],
  };

  // ai: risposta di /api/riconcilia ({ articoli, testi }) oppure null → abbinamento a regole
  function evaluateOrder(o, ai) {
    const hasOrder = o.ordini.length > 0, hasConf = o.conferme.length > 0, hasFatt = o.fatture.length > 0;
    const groups = ai && Array.isArray(ai.articoli) ? cleanGroups(o, ai.articoli) : fallbackGroups(o);
    const rows = groups.map(g => evaluateGroup(o, g, hasOrder, hasConf))
      .sort((a, b) => (a.O.length ? a.O[0]._i : 1e6 + (a.C.length ? a.C[0]._i : 1e6 + (a.F[0] ? a.F[0]._i : 0))) -
                      (b.O.length ? b.O[0]._i : 1e6 + (b.C.length ? b.C[0]._i : 1e6 + (b.F[0] ? b.F[0]._i : 0))));
    const flags = [];
    if (!ai) flags.push({ sev: 'info', text: 'Abbinamento intelligente non disponibile: righe abbinate con le regole (codice articolo, riferimenti, grammatura e altezza).' });
    if (o.key === '?') flags.push({ sev: 'warn', text: 'Numero d\'ordine Serchio non leggibile in questi documenti: le righe non possono essere collegate a un ordine.' });
    if (!hasOrder && o.key !== '?') flags.push({ sev: 'warn', text: `Ordine Serchio n. ${o.key} non caricato: confronto solo tra conferma e fattura.` });
    if (!hasConf) flags.push({ sev: 'warn', text: 'Nessuna conferma del fornitore caricata per questo ordine.' });
    if (o.ordini.length > 1) flags.push({ sev: 'warn', text: `Ordine n. ${o.key} caricato ${o.ordini.length} volte: righe sommate, verificare.` });

    // Testi (pagamento, consegna): verdetto dell'AI, altrimenti confronto di riserva
    const pairs = textPairs(o);
    const texts = pairs.map(p => {
      const v = ai && Array.isArray(ai.testi) ? ai.testi.find(t => t.campo === p.campo) : null;
      const isAddr = p.campo.startsWith('consegna');
      const ok = v ? v.equivalenti : (isAddr ? sameAddress(p.A, p.B) : alnum(p.A) === alnum(p.B));
      const [label, a, b] = TEXT_LABELS[p.campo];
      if (!ok) flags.push({ sev: isAddr ? 'err' : 'warn', text: `${label} diverso tra ${a} e ${b}${v && v.nota ? ': ' + v.nota : ''} — ${a}: "${p.A}" · ${b}: "${p.B}"` });
      return { ...p, ok, label, a, b, nota: v ? v.nota : '' };
    });

    const invoices = o.fatture.map(f => {
      const chk = invoiceChecks(f, o.conferme);
      const altri = [...(f._orders || [])].filter(k => k !== o.key);
      return { ...chk, altriOrdini: altri };
    });
    invoices.forEach(i => flags.push(...i.flags));

    const tot = k => rows.some(r => r[k] != null) ? sum(rows.map(r => r[k])) : null;
    const totals = {
      kgO: tot('qO'), kgC: tot('qC'), kgF: tot('qF'),
      eurO: tot('eurO'), eurC: tot('eurC'), eurF: tot('eurF'),
      daConf: hasOrder ? sum(rows.map(r => r.daConf != null && r.daConf > 0 ? r.daConf : 0)) : null,
      daFatt: sum(rows.filter(r => r.stato !== 'evaso in tolleranza').map(r => r.daFatt != null && r.daFatt > 0 ? r.daFatt : 0)),
    };
    const ord = o.ordini[0];
    if (ord && ord.totale_merce != null && totals.eurO != null && Math.abs(ord.totale_merce - totals.eurO) > EURTOL)
      flags.push({ sev: 'warn', text: `Totale ordine ${fmtN(ord.totale_merce)} € ma le righe lette sommano ${fmtN(totals.eurO)} € (verificare la lettura del PDF)` });

    const all = [...flags, ...rows.flatMap(r => r.flags)];
    const sev = all.some(f => f.sev === 'err') ? 'err' : all.some(f => f.sev === 'warn') ? 'warn' : 'ok';
    let avanzamento;
    if (!hasConf && !hasFatt) avanzamento = 'da confermare';
    else if (!hasFatt) avanzamento = totals.daConf > KGTOL ? 'confermato in parte' : 'confermato, da fatturare';
    else if (rows.every(r => r.stato === 'evaso' || r.stato === 'evaso in tolleranza' || r.stato === 'fatturato in eccesso')) avanzamento = 'fatturato completamente';
    else avanzamento = 'fatturato in parte';
    const fornitore = (o.conferme[0] && o.conferme[0].fornitore) || (o.fatture[0] && o.fatture[0].fornitore) || (ord && ord.fornitore) || 'Fornitore';
    return { key: o.key, order: o, fornitore, rows, flags, texts, invoices, totals, sev, avanzamento, ai: !!ai };
  }

  return {
    QTOL, PTOL, KGTOL, buildOrders, matchPayload, fallbackGroups, cleanGroups, evaluateOrder,
    fmtN, fmtKg, fmtP, fmtD, normOrd, isoDate, sameAddress, lineRef,
  };
});
