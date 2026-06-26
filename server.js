const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PROMPT1 = `Questo PDF contiene uno o piu documenti commerciali del settore carta. I tipi possibili sono:
- "ordine": ordine d'acquisto emesso da Serchio Distribuzione S.r.l. (intestazione rossa SERCHIO, campo TIPO DOCUMENTO: ORDINE A FORNITORE)
- "conferma": conferma d'ordine del fornitore (order confirmation, order acknowledgement, sales confirmation, conferma di vendita)
Il PDF puo contenere un solo documento oppure entrambi.

Per OGNI documento estrai i dati. NORMALIZZA SEMPRE: quantita in KG (TO/tonnellate x1000); prezzi in EUR per KG (EUR/1000kg o EUR/TO diviso 1000); larghezza bobina in CM (mm diviso 10). Se una riga della conferma include un supplemento prezzo (es. delivery surcharge EUR/TO), usa il prezzo NETTO finale e indicalo in "nota". Le voci non-merce (spese trasporto, surcharge separati) vanno in "voci_extra" con relativo importo, non nelle righe.

"n_ordine_cliente" e SEMPRE il numero d'ordine di Serchio: nel documento Serchio e il campo NUMERO ORDINE; nelle conferme e indicato come Buyer's Order No., Customer Order Number, Customer PO Number, Vostro numero d'ordine, Your Order No., Customer's Ref, Riferimento cliente, VS. ORDINE, YOUR ORDER, PO/Reference No., Customer Ref o simili (solo il numero, senza data). Se il riferimento e composto (es. "216-65054", "133 dtd 02.04.2026"), riporta SOLO il numero d'ordine del cliente, cioe il primo numero (es. "216", "133").

Rispondi SOLO con JSON minificato valido, nessun testo prima o dopo, nessun markdown. Schema:
{"documenti":[{"tipo":"ordine|conferma","fornitore":"nome fornitore","n_ordine_cliente":"","n_doc":"numero del documento stesso","data":"GG/MM/AAAA","pagamento":"","righe":[{"desc":"breve","largh_cm":0,"gram":0,"q_kg":0,"p_eur_kg":0}],"totale":0,"voci_extra":[{"desc":"","importo":0}]}]}
Usa null per i valori assenti. Numeri con punto decimale. Includi tutte le righe merce.`;

const PROMPT2 = `Questo PDF contiene uno o piu documenti commerciali del settore carta: una FATTURA fornitore intracomunitaria e/o una CONFERMA D'ORDINE.

TIPO DOCUMENTO:
- "fattura": invoice emessa dal fornitore verso Serchio Distribuzione
- "conferma": conferma d'ordine del fornitore

NUMERO ORDINE SERCHIO (n_ordine_serchio): Cerca: "Your Order", "Customer Order No", "Buyer's Order No", "VS. ORDINE", "PO/Reference No", "Customer Ref", "Order no", "Comanda". Estrai SOLO il numero (es. "177", "36", "127").

NORMALIZZAZIONE:
- Quantita in KG (se TO x1000)
- Prezzo in EUR/tonnellata (se EUR/kg x1000; se EUR/1000kg e gia EUR/ton)
- largh_mm, foro_mm, diam_mm sempre in MM (se cm x10)

GRAMMATURA: gram_carta = g/m2 carta, gram_pe = g/m2 polietilene (es Tiger "45+9": gram_carta=45, gram_pe=9; null se assente)

MASSA NETTA (massa_netta_kg) per Intrastat: "net weight","nett kg","peso netto","net mass". In KG.

CODICE NOMENCLATURA (cod_nomenclatura): "CN Code","CN","HS number","Tariff No","Codice Intra","CUSTOM TARIF". Codice esatto.

P.IVA SERCHIO (piva_buyer): deve essere IT05147461007.

INDIRIZZO CONSEGNA (indirizzo_consegna): Consignee/Ship-to/Delivery address. Nome + via + citta.

PAGAMENTO (pagamento): testo esatto condizioni.

RIGHE: desc, gram_carta, gram_pe(null), largh_mm, diam_mm(null), foro_mm(null), q_kg, prezzo_eur_ton, importo_eur, cod_nomenclatura_riga(null).

Rispondi SOLO JSON minificato. Schema:
{"documenti":[{"tipo":"fattura|conferma","fornitore":"","n_doc":"","n_ordine_serchio":"","data":"","piva_buyer":"","indirizzo_consegna":"","pagamento":"","massa_netta_kg":null,"cod_nomenclatura":"","righe":[{"desc":"","gram_carta":null,"gram_pe":null,"largh_mm":null,"diam_mm":null,"foro_mm":null,"q_kg":null,"prezzo_eur_ton":null,"importo_eur":null,"cod_nomenclatura_riga":null}]}]}`;

async function callAI(pdf, prompt, maxTokens) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });
  const data = await resp.json();
  if (data.error) throw new Error('API: ' + (data.error.message || 'errore sconosciuto'));
  const txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  return JSON.parse(txt.replace(/```json|```/g, '').trim());
}

function checkAuth(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Configurazione mancante: impostare ANTHROPIC_API_KEY su Railway.' });
    return false;
  }
  const { code } = req.body || {};
  if (process.env.ACCESS_CODE && code !== process.env.ACCESS_CODE) {
    res.status(401).json({ error: 'Codice di accesso errato.' });
    return false;
  }
  if (!req.body?.pdf || typeof req.body.pdf !== 'string') {
    res.status(400).json({ error: 'Nessun PDF ricevuto.' });
    return false;
  }
  return true;
}

// Tool 1 — Conferme d'Ordine
app.post('/api/analizza', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const parsed = await callAI(req.body.pdf, PROMPT1, 2000);
    res.json({ documenti: parsed.documenti || [] });
  } catch (e) {
    res.status(422).json({ error: 'Estrazione non riuscita: ' + e.message });
  }
});

// Tool 2 — Fatture Fornitore
app.post('/api/analizza2', async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const parsed = await callAI(req.body.pdf, PROMPT2, 4000);
    res.json({ documenti: parsed.documenti || [] });
  } catch (e) {
    res.status(422).json({ error: 'Estrazione non riuscita: ' + e.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', tool: 'suite-controlli' }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Suite Controlli attiva sulla porta ' + port));
