// Prova completa con l'AI vera sui PDF di prova: lettura dei 3 documenti + abbinamento + report.
// Richiede il server avviato con ANTHROPIC_API_KEY e ACCESS_CODE, es.:
//   ANTHROPIC_API_KEY=... ACCESS_CODE=prova-locale PORT=3210 node server.js
//   ACCESS_CODE=prova-locale node test/e2e.js ["../Trial PDF - Controllo Fatture"] [http://localhost:3210]
const fs = require('fs');
const path = require('path');
const R = require('../recon.js');

const dir = process.argv[2] || path.join(__dirname, '..', '..', 'Trial PDF - Controllo Fatture');
const base = process.argv[3] || 'http://localhost:3210';
const code = process.env.ACCESS_CODE || 'prova-locale';
const slotOf = n => /^GEORDF|ordine/i.test(n) ? 'ordine' : /conferma|confirmation/i.test(n) ? 'conferma' : 'fattura';

async function post(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, code }) });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || r.status);
  return d;
}

(async () => {
  const pdfs = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'));
  const docs = (await Promise.all(pdfs.map(async f => {
    const t = Date.now();
    const d = await post('/api/analizza3', { pdf: fs.readFileSync(path.join(dir, f)).toString('base64'), atteso: slotOf(f) });
    console.log(`letto ${f} in ${((Date.now() - t) / 1000).toFixed(0)}s → ${d.documenti.map(x => `${x.tipo} ${x.n_doc} (${x.righe.length} righe)`).join(', ')}`);
    return d.documenti.map(x => ({ ...x, _file: f }));
  }))).flat();
  fs.writeFileSync(path.join(__dirname, 'e2e-estratti.json'), JSON.stringify(docs, null, 2));
  for (const o of R.buildOrders(docs)) {
    let ai = null;
    try { ai = await post('/api/riconcilia', R.matchPayload(o)); } catch (e) { console.log('abbinamento AI non riuscito:', e.message); }
    const ev = R.evaluateOrder(o, ai);
    console.log(`\n=== Ordine ${ev.key} · ${ev.fornitore} · ${ev.sev} · ${ev.avanzamento} · AI: ${ev.ai ? 'sì' : 'no'}`);
    console.log(`kg ord ${ev.totals.kgO} · conf ${ev.totals.kgC} · fatt ${ev.totals.kgF} · da conf ${ev.totals.daConf} · da fatt ${ev.totals.daFatt}`);
    for (const r of ev.rows) console.log(`  [${r.sev}] ${r.code || ''} ${r.name} | ord ${r.qO} conf ${r.qC} fatt ${r.qF} | res conf ${r.daConf} fatt ${r.daFatt} | ${r.stato}`);
    for (const f of [...ev.flags, ...ev.rows.flatMap(r => r.flags)]) console.log(`  - ${f.sev}: ${f.text}`);
  }
})().catch(e => { console.error('ERRORE:', e.message); process.exit(1); });
