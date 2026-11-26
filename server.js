const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const MODEL = 'claude-sonnet-5-5';
// Limite di risposta alto: ordini/fatture con molte righe non vengono più troncati.
const MAX_TOKENS = 32000;

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// ---------- Schemi JSON: la risposta del modello è sempre valida e completa ----------
// L'API accetta al massimo 16 campi "valore oppure null" per schema: per questo ogni campo
// è una stringa ("" = assente) e normalize() la converte poi in numero o null.
const num = { type: 'string' };
const str = { type: 'string' };
const NUM_FIELDS = new Set([
  'largh_cm', 'gram', 'diam_cm', 'foro_cm', 'q_kg', 'p_eur_kg', 'sconto_pct', 'totale', 'importo',
  'massa_netta_kg', 'gram_carta', 'gram_pe', 'largh_mm', 'diam_mm', 'foro_mm', 'prezzo_eur_ton', 'importo_eur', 'totale_merce',
]);

function toNum(v) {
  if (v == null) return null;
  let t = String(v).trim().replace(/\s/g, '');
  if (!t || /^(null|n\/?a|-)$/i.test(t)) return null;
  if (t.includes('.') && t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (t.includes(',')) t = t.replace(',', '.');
  const n = Number(t.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Converte le stringhe del modello: campi numerici -> numero, "" -> null.
function normalize(x, key) {
  if (Array.isArray(x)) return x.map(v => normalize(v));
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) out[k] = normalize(v, k);
    return out;
  }
  if (NUM_FIELDS.has(key)) return toNum(x);
  if (typeof x === 'string' && x.trim() === '') return null;
  return x;
}

const FORMAT_NOTE = `

FORMATO: tutti i valori sono stringhe. Se un valore è assente usa "" (stringa vuota). Scrivi i numeri senza separatore delle migliaia e con il punto come separatore decimale (es. "5000", "0.905", "12.5").`;
const obj = (props) => ({
  type: 'object',
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});

const SCHEMA1 = obj({
  documenti: {
    type: 'array',
    items: obj({
      tipo: { type: 'string', enum: ['ordine', 'conferma', 'fattura'] },
      fornitore: str,
      n_ordine_cliente: str,
      n_doc: str,
      data: str,
      pagamento: str,
      destinazione: str,
      righe: {
        type: 'array',
        items: obj({
          desc: str,
          n_ordine_riga: str,
          largh_cm: num,
          gram: num,
          diam_cm: num,
          foro_cm: num,
          q_kg: num,
          p_eur_kg: num,
          sconto_pct: num,
          nota: str,
        }),
      },
      totale: num,
      voci_extra: { type: 'array', items: obj({ desc: str, importo: num }) },
    }),
  },
});

// Controllo 2: un solo schema per i tre documenti (ordine Serchio, conferma fornitore, fattura fornitore).
const SCHEMA3 = obj({
  documenti: {
    type: 'array',
    items: obj({
      tipo: { type: 'string', enum: ['ordine', 'conferma', 'fattura'] },
      fornitore: str,
      n_doc: str,
      data: str,
      n_ordine_serchio: str,
      n_conferma_fornitore: str,
      piva_buyer: str,
      indirizzo_consegna: str,
      pagamento: str,
      massa_netta_kg: num,
      cod_nomenclatura: str,
      totale_merce: num,
      righe: {
        type: 'array',
        items: obj({
          pos: str,
          n_ordine_serchio_riga: str,
          n_conferma_riga: str,
          pos_conferma_riga: str,
          cod_articolo_serchio: str,
          cod_articolo_fornitore: str,
          desc: str,
          gram_carta: num,
          gram_pe: num,
          largh_mm: num,
          diam_mm: num,
          foro_mm: num,
          q_kg: num,
          prezzo_eur_ton: num,
          importo_eur: num,
          data_consegna: str,
          data_consegna_fine: str,
          n_ddt: str,
          data_spedizione: str,
          cod_nomenclatura_riga: str,
        }),
      },
    }),
  },
});

// ---------- Prompt ----------
const PROMPT1 = `Questo PDF contiene uno o più documenti commerciali del settore carta. I tipi possibili sono:
- "ordine": ordine d'acquisto emesso da Serchio Distribuzione S.r.l. (intestazione rossa SERCHIO, campo TIPO DOCUMENTO: ORDINE A FORNITORE)
- "conferma": conferma d'ordine del fornitore (order confirmation, order acknowledgement, sales confirmation, conferma di vendita)
- "fattura": fattura del fornitore (invoice). Non serve a questo controllo: classificala come "fattura" ed estrai comunque fornitore, n_doc e n_ordine_cliente.
Il PDF può contenere un solo documento oppure più documenti.

Per OGNI documento estrai i dati. NORMALIZZA SEMPRE:
- quantità in KG (TO/tonnellate x1000)
- prezzi in EUR per KG (EUR/1000kg o EUR/TO diviso 1000)
- larghezza/altezza bobina, diametro e foro (anima) in CM (mm diviso 10)
Se una riga della conferma include un supplemento prezzo (es. delivery surcharge EUR/TO), usa il prezzo NETTO finale e spiegalo in "nota". Se c'è uno sconto percentuale (es. sconto stock), metti il prezzo NETTO in p_eur_kg e la percentuale in sconto_pct. Le voci non-merce (spese trasporto, surcharge separati) vanno in "voci_extra" con il relativo importo, non nelle righe.

"n_ordine_cliente" è SEMPRE il numero d'ordine di Serchio: nel documento Serchio è il campo NUMERO ORDINE; nelle conferme è indicato come Buyer's Order No., Customer Order Number, Customer PO Number, Vostro numero d'ordine, Your Order No., Customer's Ref, Riferimento cliente, VS. ORDINE, YOUR ORDER, PO/Reference No., Customer Ref o simili (solo il numero, senza data). Se il riferimento è composto (es. "216-65054", "133 dtd 02.04.2026"), riporta SOLO il numero d'ordine del cliente, cioè il primo numero (es. "216", "133").
Se una conferma evade più ordini Serchio, indica in "n_ordine_riga" di ogni riga il numero d'ordine Serchio a cui si riferisce quella riga; altrimenti null.

"destinazione": luogo di consegna della merce (Consignee, Ship-to, Delivery address, Destinazione, Luogo di consegna): nome + via + città.

Includi TUTTE le righe merce, una per una, così come compaiono nel documento (non unirle e non sommarle).` + FORMAT_NOTE;

const PROMPT3 = (atteso) => `Questo PDF contiene uno o più documenti commerciali del settore carta (bobine). L'utente lo ha caricato come: ${atteso}. Usalo come indicazione, ma classifica ogni documento per quello che è davvero.

TIPO DOCUMENTO (tipo):
- "ordine": ordine d'acquisto emesso da Serchio Distribuzione S.r.l. (intestazione rossa SERCHIO, TIPO DOCUMENTO: ORDINE A FORNITORE)
- "conferma": conferma d'ordine del fornitore (Order Confirmation, Order Acknowledgement, Sales Confirmation, Conferma d'ordine)
- "fattura": fattura del fornitore (Invoice, Rechnung, Facture). Se la fattura contiene anche packing list o dichiarazioni, è comunque UN solo documento "fattura".

TESTATA:
- n_doc: numero del documento (ordine: NUMERO ORDINE; conferma: il numero d'ordine/conferma del fornitore, es. "Our Order No."; fattura: numero fattura, es. "Document No.").
- data: data del documento.
- n_ordine_serchio: il numero d'ordine di Serchio. Nell'ordine Serchio è NUMERO ORDINE; negli altri documenti: Your Order No., Customer Order No., Buyer's Order No., Customer PO, Vostro ordine, VS. ORDINE, PO/Reference No., Customer Ref. Solo il numero d'ordine Serchio, senza data né codici aggiunti dal fornitore (es. "512/10.01.2026" → "512"; "512-60011" → "512"). Se il documento ne cita più d'uno, riportali tutti separati da "/" (es. "Customer Ref.: 512-60011/518-60020" → "512/518") e indica quello di ogni riga in n_ordine_serchio_riga.
- n_conferma_fornitore: SOLO per la fattura: numero della conferma/ordine del fornitore citato ("Our Order No.", "Order Nº", "Sales Order", "Auftragsnummer"); se sono più d'uno, tutti separati da "/" (es. "PT0001111/PT0002222"). Per la conferma ripeti il suo n_doc. Per l'ordine "".
- piva_buyer: partita IVA dell'acquirente (Serchio) esattamente come scritta (attesa IT05147461007).
- indirizzo_consegna: Ship-to / Consignee / Delivery address / Destinatario della merce: nome + via + città.
- pagamento: testo esatto delle condizioni di pagamento.
- massa_netta_kg: peso netto totale (Net weight, Peso netto) in KG.
- cod_nomenclatura: codice doganale (Custom Tariff Number, CN, HS, Codice Intra) se unico per il documento.
- totale_merce: totale imponibile della merce (Net Amount, Totale merce), senza IVA.

RIGHE: includi TUTTE le righe merce, una per una, così come compaiono nel documento, nello stesso ordine e con le stesse quantità: due righe con lo stesso articolo restano DUE righe, non unirle e non sommarle. Le spese di trasporto e le note non sono righe merce. In una fattura le righe sono SOLO quelle della fattura vera e propria: packing list, delivery note/DDT e CMR allegati NON aggiungono righe (servono solo per leggere i riferimenti).
FATTURA CHE COPRE PIÙ ORDINI: se la riga di fattura non dice a quale ordine appartiene, ricavalo dalla packing list o dalla delivery note allegata, dove la merce è divisa in sezioni "Your Order / Our Order" (o "Customer PO / Sales Order") con prodotto e peso totale: la riga appartiene alla sezione con lo stesso prodotto e lo stesso peso (es. riga 3 "KR/70/1200" 3,210 t = sezione "Your Order 518 / Our Order PT0002222", "Total 3.210 kg"). Metti allora l'ordine Serchio in n_ordine_serchio_riga e la conferma in n_conferma_riga.
- pos: numero di posizione della riga nel documento (Item, Pos.), come scritto.
- n_ordine_serchio_riga: numero d'ordine Serchio indicato sulla riga (es. "Your Order No.: 512" → "512"), altrimenti "".
- n_conferma_riga e pos_conferma_riga: SOLO in fattura, la conferma e la posizione citate sulla riga (es. "Our Order No.: 4400123 Item: 000007" → "4400123" e "000007"; "Sales Order/Item 4400123/7" → "4400123" e "7"). Altrimenti "".
- cod_articolo_serchio: codice articolo di Serchio (nell'ordine: CODICE ARTICOLO; in conferma/fattura: Customer material no., Your article, Vs. codice). Altrimenti "".
- cod_articolo_fornitore: codice materiale del fornitore (es. "MB074-050-0550-1000").
- desc: descrizione completa su una riga.
- gram_carta: grammatura carta g/m²; gram_pe: grammatura polietilene se carta accoppiata (es. "45+9" → 45 e 9), altrimenti "".
- largh_mm (larghezza/altezza bobina), diam_mm (diametro), foro_mm (anima/core) SEMPRE in MM (cm × 10; es. "WIDTH 55 CM" → 550, "CORE 7,6 CM" → 76).
- q_kg: quantità in KG (TO/tonnellate × 1000; per le fatture usa il peso fatturato, "Invoiced weight").
- prezzo_eur_ton: prezzo NETTO in EUR per tonnellata (EUR/kg × 1000; EUR/1000kg = EUR/ton). Se c'è uno sconto o un supplemento sulla riga, usa il prezzo netto finale.
- importo_eur: importo netto della riga in EUR.
- data_consegna e data_consegna_fine: data di consegna richiesta o confermata della riga, formato AAAA-MM-GG; se è un intervallo (es. "16.11.2026 - 20.11.2026") metti inizio e fine, altrimenti solo data_consegna. Nell'ordine Serchio è la colonna DATA CONSEGNA (es. "16/11/26" → "2026-11-16").
- n_ddt e data_spedizione: SOLO in fattura, numero del documento di trasporto (Delivery note, DDT, Lieferschein) e data di spedizione (Dispatched on) della riga, data in formato AAAA-MM-GG.
- cod_nomenclatura_riga: codice doganale indicato sulla riga.
Tutte le date in formato AAAA-MM-GG.` + FORMAT_NOTE;

// ---------- Chiamata al modello ----------
async function callAI(content, schema) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    // Se il modello rifiuta per errore un documento, la richiesta viene ripetuta su un modello di riserva.
    fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{
      role: 'user',
      content,
    }],
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === 'refusal') {
    throw new Error('il modello non ha potuto elaborare questo documento');
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new Error('documento troppo lungo: la risposta è stata troncata');
  }
  const txt = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
  return normalize(JSON.parse(txt));
}

function describeError(e) {
  if (e instanceof Anthropic.RateLimitError) return 'troppe richieste in poco tempo, riprova tra un minuto';
  if (e instanceof Anthropic.AuthenticationError) return 'chiave API Anthropic non valida (controllare ANTHROPIC_API_KEY su Railway)';
  if (e instanceof Anthropic.BadRequestError) return 'PDF non leggibile o troppo grande (' + e.message + ')';
  if (e instanceof Anthropic.APIError) return 'servizio AI non disponibile (' + (e.status || 'rete') + '), riprova';
  return e.message;
}

// ---------- Controllo accesso ----------
function sameCode(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkAuth(req, res) {
  if (!client) {
    res.status(500).json({ error: 'Configurazione mancante: impostare ANTHROPIC_API_KEY su Railway.' });
    return false;
  }
  // Senza ACCESS_CODE il servizio resta chiuso: nessuno può usarlo a vostre spese.
  if (!process.env.ACCESS_CODE) {
    res.status(500).json({ error: 'Configurazione mancante: impostare ACCESS_CODE su Railway.' });
    return false;
  }
  const { code } = req.body || {};
  if (!code || !sameCode(code, process.env.ACCESS_CODE)) {
    res.status(401).json({ error: 'Codice di accesso errato.' });
    return false;
  }
  return true;
}

function hasPdf(req, res) {
  if (!req.body?.pdf || typeof req.body.pdf !== 'string') {
    res.status(400).json({ error: 'Nessun PDF ricevuto.' });
    return false;
  }
  return true;
}

function route(prompt, schema) {
  return async (req, res) => {
    if (!checkAuth(req, res) || !hasPdf(req, res)) return;
    try {
      const parsed = await callAI([
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.body.pdf } },
        { type: 'text', text: prompt },
      ], schema);
      res.json({ documenti: parsed.documenti || [] });
    } catch (e) {
      console.error('Estrazione non riuscita:', e);
      res.status(422).json({ error: 'Estrazione non riuscita: ' + describeError(e) });
    }
  };
}

// Tool 1 — Conferme d'Ordine
app.post('/api/analizza', route(PROMPT1, SCHEMA1));
// Tool 2 — Ordini, conferme e fatture fornitore (riconciliazione a tre documenti)
const ATTESI = { ordine: "ordine d'acquisto Serchio", conferma: "conferma d'ordine del fornitore", fattura: 'fattura del fornitore' };
app.post('/api/analizza3', (req, res) =>
  route(PROMPT3(ATTESI[req.body?.atteso] || 'non indicato'), SCHEMA3)(req, res));

// ---------- Abbinamento intelligente delle righe ----------
// Dopo l'estrazione, l'AI abbina le righe dei due documenti come farebbe una persona:
// descrizioni scritte in modo diverso, dati mancanti, prodotti spezzati su più righe.
const MATCH_SCHEMA = obj({
  gruppi: {
    type: 'array',
    items: obj({
      a: { type: 'array', items: { type: 'integer' } },
      b: { type: 'array', items: { type: 'integer' } },
      motivo: { type: 'string' },
      differenze: { type: 'string' },
    }),
  },
  testi: {
    type: 'array',
    items: obj({ campo: { type: 'string' }, equivalenti: { type: 'boolean' }, nota: { type: 'string' } }),
  },
});

const MATCH_PROMPT = (labelA, labelB) => `Sei un esperto acquisti nel settore carta. Ti do le righe merce di due documenti dello stesso ordine: A = ${labelA}, B = ${labelB}. I dati sono già stati estratti dai PDF, quindi possono contenere piccole imprecisioni di lettura.

COMPITO 1 — Abbina le righe di A con le righe di B che si riferiscono allo STESSO prodotto, ragionando come una persona che confronta i due fogli:
- le descrizioni possono essere scritte in modo diverso (lingua, abbreviazioni, codici articolo, nome commerciale);
- un dato può mancare in uno dei due documenti, o essere scritto in un'altra unità (mm/cm, kg/t);
- un prodotto può essere SPEZZATO in più righe nell'altro documento (es. 5.000 kg in A = 2.000 + 3.000 kg in B): in quel caso metti tutte quelle righe nello stesso gruppo;
- abbina in base a tipo di carta, grammatura, formato/altezza, diametro/foro, prezzo e quantità; la quantità può essere diversa (tolleranze di produzione delle cartiere, consegne parziali): conta che il prodotto sia lo stesso;
- se nel documento sono indicati riferimenti alle righe dell'altro documento (es. "Item: 000007", "Customer material no."), usali;
- una riga di B senza corrispondenza in A è normale quando B è una conferma e A una fattura (consegna/fatturazione parziale): lasciala fuori;
- NON abbinare prodotti davvero diversi; una riga che non ha corrispondenza non va messa in nessun gruppo;
- ogni indice può comparire al massimo in un gruppo. "motivo": breve spiegazione in italiano.
- "differenze": SOLO differenze sostanziali di prodotto tra le righe abbinate (qualità o tipo di carta diverso, finitura diversa, grammatura o formato diversi) spiegate in breve in italiano; NON segnalare differenze di scrittura, lingua, unità di misura, quantità o prezzo (quelle sono controllate a parte). Se non ce ne sono: "".

COMPITO 2 — Per ogni coppia di testi in "testi_da_confrontare", indica se hanno lo STESSO SIGNIFICATO (es. "30 days net" e "30 gg data fattura" sì; due indirizzi dello stesso stabilimento scritti in modo diverso sì; città o condizioni diverse no). "nota": breve spiegazione in italiano se non sono equivalenti, altrimenti "".

DATI:
`;

app.post('/api/abbina', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { a, b, labelA, labelB, testi } = req.body || {};
  if (!Array.isArray(a) || !Array.isArray(b)) return res.status(400).json({ error: 'Dati mancanti.' });
  try {
    const dati = JSON.stringify({ A: a, B: b, testi_da_confrontare: testi || [] });
    const out = await callAI([{ type: 'text', text: MATCH_PROMPT(labelA || 'ordine', labelB || 'conferma') + dati }], MATCH_SCHEMA);
    res.json(out);
  } catch (e) {
    console.error('Abbinamento non riuscito:', e);
    res.status(422).json({ error: 'Abbinamento non riuscito: ' + describeError(e) });
  }
});

// ---------- Riconciliazione a tre documenti (Controllo 2) ----------
// Per ogni ordine Serchio l'AI raggruppa le righe di ordine (O), conferme (C) e fatture (F) per articolo.
const RECON_SCHEMA = obj({
  articoli: {
    type: 'array',
    items: obj({
      o: { type: 'array', items: { type: 'integer' } },
      c: { type: 'array', items: { type: 'integer' } },
      f: { type: 'array', items: { type: 'integer' } },
      motivo: { type: 'string' },
      differenze: { type: 'string' },
    }),
  },
  testi: MATCH_SCHEMA.properties.testi,
});

const RECON_PROMPT = `Sei un esperto acquisti nel settore carta. Ti do le righe merce di TRE tipi di documento che riguardano lo stesso ordine d'acquisto di Serchio Distribuzione:
- O = righe dell'ordine d'acquisto Serchio al fornitore;
- C = righe delle conferme d'ordine del fornitore (possono essere più conferme: il campo "doc" dice quale);
- F = righe delle fatture del fornitore (possono essere più fatture, anche parziali).
I dati sono già stati estratti dai PDF e possono contenere piccole imprecisioni di lettura. Unità: larghezza/diametro/foro in mm, quantità in kg, prezzi in EUR/ton.

COMPITO 1 — Raggruppa le righe per ARTICOLO, come farebbe una persona che confronta i tre fogli. Ogni gruppo = un articolo dell'ordine con le righe di conferma e di fattura che lo riguardano:
- di solito un gruppo ha UNA riga O; le righe C e F possono essere più d'una (il fornitore può spezzare una riga d'ordine in più righe di conferma, e fatturare a più riprese);
- PRIMA usa i riferimenti espliciti: una riga F con n_conferma_riga + pos_conferma_riga va nel gruppo della riga C di quella conferma ("doc") con quella posizione ("pos"); cod_articolo_serchio uguale (ignora spazi) collega C/F alla riga O;
- poi abbina per tipo di carta, grammatura, larghezza, diametro/foro, prezzo e quantità; le descrizioni possono essere scritte in modo diverso (lingua, abbreviazioni, nome commerciale);
- se più righe O hanno le stesse caratteristiche, distribuisci le righe C/F in modo che le quantità tornino;
- quantità diverse sono normali (tolleranze di produzione, consegne e fatturazioni parziali): conta che il prodotto sia lo stesso;
- NON mettere insieme prodotti davvero diversi (grammatura o larghezza diverse): una riga senza corrispondenza va in un gruppo da sola;
- ogni indice compare al massimo una volta. "motivo": breve spiegazione in italiano.
- "differenze": SOLO differenze sostanziali di prodotto tra le righe del gruppo (qualità o tipo di carta diverso, es. HIGH GLOSS ordinato e WHITE FLEX confermato; finitura, colore, lato avvolgimento) spiegate in breve in italiano, dicendo in quale documento. NON segnalare differenze di scrittura, lingua, unità di misura, quantità, prezzo o date (controllate a parte). Se non ce ne sono: "".

COMPITO 2 — Per ogni coppia di testi in "testi_da_confrontare", indica se hanno lo STESSO SIGNIFICATO (es. "30 days net" e "30 gg data fattura" sì; due indirizzi dello stesso stabilimento scritti in modo diverso sì; città, termini di pagamento o sconti diversi no). "nota": breve spiegazione in italiano se non sono equivalenti, altrimenti "".

DATI:
`;

app.post('/api/riconcilia', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { O, C, F, testi } = req.body || {};
  if (!Array.isArray(O) || !Array.isArray(C) || !Array.isArray(F)) return res.status(400).json({ error: 'Dati mancanti.' });
  try {
    const dati = JSON.stringify({ O, C, F, testi_da_confrontare: testi || [] });
    res.json(await callAI([{ type: 'text', text: RECON_PROMPT + dati }], RECON_SCHEMA));
  } catch (e) {
    console.error('Riconciliazione non riuscita:', e);
    res.status(422).json({ error: 'Riconciliazione non riuscita: ' + describeError(e) });
  }
});

// Logica di riconciliazione condivisa con la pagina
app.get('/recon.js', (_, res) => res.sendFile(path.join(__dirname, 'recon.js')));

// Pagina del tool: servita direttamente da Railway (non serve più Vercel)
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (_, res) => res.json({ status: 'ok', tool: 'suite-controlli' }));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Suite Controlli attiva sulla porta ' + port));
}

module.exports = { app, SCHEMA1, SCHEMA3, RECON_SCHEMA };
