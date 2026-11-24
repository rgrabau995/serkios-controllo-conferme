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
const num = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const str = { anyOf: [{ type: 'string' }, { type: 'null' }] };
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
      tipo: { type: 'string', enum: ['ordine', 'conferma'] },
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

const SCHEMA2 = obj({
  documenti: {
    type: 'array',
    items: obj({
      tipo: { type: 'string', enum: ['fattura', 'conferma'] },
      fornitore: str,
      n_doc: str,
      n_ordine_serchio: str,
      data: str,
      piva_buyer: str,
      indirizzo_consegna: str,
      pagamento: str,
      massa_netta_kg: num,
      cod_nomenclatura: str,
      righe: {
        type: 'array',
        items: obj({
          desc: str,
          gram_carta: num,
          gram_pe: num,
          largh_mm: num,
          diam_mm: num,
          foro_mm: num,
          q_kg: num,
          prezzo_eur_ton: num,
          importo_eur: num,
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
Il PDF può contenere un solo documento oppure entrambi.

Per OGNI documento estrai i dati. NORMALIZZA SEMPRE:
- quantità in KG (TO/tonnellate x1000)
- prezzi in EUR per KG (EUR/1000kg o EUR/TO diviso 1000)
- larghezza/altezza bobina, diametro e foro (anima) in CM (mm diviso 10)
Se una riga della conferma include un supplemento prezzo (es. delivery surcharge EUR/TO), usa il prezzo NETTO finale e spiegalo in "nota". Se c'è uno sconto percentuale (es. sconto stock), metti il prezzo NETTO in p_eur_kg e la percentuale in sconto_pct. Le voci non-merce (spese trasporto, surcharge separati) vanno in "voci_extra" con il relativo importo, non nelle righe.

"n_ordine_cliente" è SEMPRE il numero d'ordine di Serchio: nel documento Serchio è il campo NUMERO ORDINE; nelle conferme è indicato come Buyer's Order No., Customer Order Number, Customer PO Number, Vostro numero d'ordine, Your Order No., Customer's Ref, Riferimento cliente, VS. ORDINE, YOUR ORDER, PO/Reference No., Customer Ref o simili (solo il numero, senza data). Se il riferimento è composto (es. "216-65054", "133 dtd 02.04.2026"), riporta SOLO il numero d'ordine del cliente, cioè il primo numero (es. "216", "133").
Se una conferma evade più ordini Serchio, indica in "n_ordine_riga" di ogni riga il numero d'ordine Serchio a cui si riferisce quella riga; altrimenti null.

"destinazione": luogo di consegna della merce (Consignee, Ship-to, Delivery address, Destinazione, Luogo di consegna): nome + via + città.

Includi TUTTE le righe merce, una per una, così come compaiono nel documento (non unirle e non sommarle). Usa null per i valori assenti.`;

const PROMPT2 = `Questo PDF contiene uno o più documenti commerciali del settore carta: una FATTURA fornitore intracomunitaria e/o una CONFERMA D'ORDINE.

TIPO DOCUMENTO:
- "fattura": invoice emessa dal fornitore verso Serchio Distribuzione
- "conferma": conferma d'ordine del fornitore

NUMERO ORDINE SERCHIO (n_ordine_serchio): cerca "Your Order", "Customer Order No", "Buyer's Order No", "VS. ORDINE", "PO/Reference No", "Customer Ref", "Order no", "Comanda". Estrai SOLO il numero (es. "177", "36", "127").

NORMALIZZAZIONE:
- Quantità in KG (se TO x1000)
- Prezzo in EUR/tonnellata (se EUR/kg x1000; se EUR/1000kg è già EUR/ton)
- largh_mm, foro_mm, diam_mm sempre in MM (se cm x10)

GRAMMATURA: gram_carta = g/m2 carta, gram_pe = g/m2 polietilene (es. Tiger "45+9": gram_carta=45, gram_pe=9; null se assente).

MASSA NETTA (massa_netta_kg) per Intrastat: "net weight", "nett kg", "peso netto", "net mass". In KG.

CODICE NOMENCLATURA (cod_nomenclatura): "CN Code", "CN", "HS number", "Tariff No", "Codice Intra", "CUSTOM TARIF". Codice esatto.

P.IVA SERCHIO (piva_buyer): la partita IVA dell'acquirente riportata nel documento, esattamente come scritta (dovrebbe essere IT05147461007).

INDIRIZZO CONSEGNA (indirizzo_consegna): Consignee/Ship-to/Delivery address. Nome + via + città.

PAGAMENTO (pagamento): testo esatto delle condizioni.

RIGHE: includi TUTTE le righe merce, una per una, così come compaiono nel documento (non unirle e non sommarle). Usa null per i valori assenti.`;

// ---------- Chiamata al modello ----------
async function callAI(pdf, prompt, schema) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    // Se il modello rifiuta per errore un documento, la richiesta viene ripetuta su un modello di riserva.
    fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
        { type: 'text', text: prompt },
      ],
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
  return JSON.parse(txt);
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
  if (!req.body?.pdf || typeof req.body.pdf !== 'string') {
    res.status(400).json({ error: 'Nessun PDF ricevuto.' });
    return false;
  }
  return true;
}

function route(prompt, schema) {
  return async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const parsed = await callAI(req.body.pdf, prompt, schema);
      res.json({ documenti: parsed.documenti || [] });
    } catch (e) {
      console.error('Estrazione non riuscita:', e);
      res.status(422).json({ error: 'Estrazione non riuscita: ' + describeError(e) });
    }
  };
}

// Tool 1 — Conferme d'Ordine
app.post('/api/analizza', route(PROMPT1, SCHEMA1));
// Tool 2 — Fatture Fornitore
app.post('/api/analizza2', route(PROMPT2, SCHEMA2));

// Pagina del tool: servita direttamente da Railway (non serve più Vercel)
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (_, res) => res.json({ status: 'ok', tool: 'suite-controlli' }));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Suite Controlli attiva sulla porta ' + port));
}

module.exports = { app, SCHEMA1, SCHEMA2 };
