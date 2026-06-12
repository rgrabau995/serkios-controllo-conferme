// Backend per Railway — Controllo Conferme d'Ordine (Serchio / Fibersflow)
// Tiene la chiave API e il prompt lato server. Serve anche il frontend, quindi
// può funzionare da solo su Railway oppure in coppia con Netlify.
//
// Variabili d'ambiente su Railway:
//   ANTHROPIC_API_KEY  (obbligatoria) - chiave da console.anthropic.com
//   ACCESS_CODE        (consigliata)  - codice richiesto agli utenti dell'app
//   ALLOWED_ORIGIN     (opzionale)    - URL Netlify per restringere il CORS,
//                                       es. https://controlli-serkios.netlify.app

const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '30mb' }));

// CORS: aperto di default, restringibile con ALLOWED_ORIGIN
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve anche il frontend (così Railway da solo basta, Netlify è opzionale)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PROMPT = `Questo PDF contiene uno o piu documenti commerciali del settore carta. I tipi possibili sono:
- "ordine": ordine d'acquisto emesso da Serchio Distribuzione S.r.l. (intestazione rossa SERCHIO, campo TIPO DOCUMENTO: ORDINE A FORNITORE)
- "conferma": conferma d'ordine del fornitore (order confirmation, order acknowledgement, sales confirmation, conferma di vendita)
Il PDF puo contenere un solo documento oppure entrambi.

Per OGNI documento estrai i dati. NORMALIZZA SEMPRE: quantita in KG (TO/tonnellate x1000); prezzi in EUR per KG (EUR/1000kg o EUR/TO diviso 1000); larghezza bobina in CM (mm diviso 10). Se una riga della conferma include un supplemento prezzo (es. delivery surcharge EUR/TO), usa il prezzo NETTO finale e indicalo in "nota". Le voci non-merce (spese trasporto, surcharge separati) vanno in "voci_extra" con relativo importo, non nelle righe.

"n_ordine_cliente" e SEMPRE il numero d'ordine di Serchio: nel documento Serchio e il campo NUMERO ORDINE; nelle conferme e indicato come Buyer's Order No., Customer Order Number, Customer PO Number, Vostro numero d'ordine, Your Order No., Customer's Ref, Riferimento cliente, VS. ORDINE, YOUR ORDER, PO/Reference No., Customer Ref o simili (solo il numero, senza data). Se il riferimento e composto (es. "216-65054", "133 dtd 02.04.2026"), riporta SOLO il numero d'ordine del cliente, cioe il primo numero (es. "216", "133").

Rispondi SOLO con JSON minificato valido, nessun testo prima o dopo, nessun markdown. Schema:
{"documenti":[{"tipo":"ordine|conferma","fornitore":"nome fornitore","n_ordine_cliente":"","n_doc":"numero del documento stesso","data":"GG/MM/AAAA","pagamento":"","righe":[{"desc":"breve","largh_cm":0,"gram":0,"q_kg":0,"p_eur_kg":0}],"totale":0,"voci_extra":[{"desc":"","importo":0}]}]}
Usa null per i valori assenti. Numeri con punto decimale. Includi tutte le righe merce.`;

app.post('/api/analizza', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(500).json({ error: 'Configurazione mancante: impostare ANTHROPIC_API_KEY su Railway.' });

  const { pdf, code } = req.body || {};
  if (process.env.ACCESS_CODE && code !== process.env.ACCESS_CODE)
    return res.status(401).json({ error: 'Codice di accesso errato.' });
  if (!pdf || typeof pdf !== 'string')
    return res.status(400).json({ error: 'Nessun PDF ricevuto.' });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
            { type: 'text', text: PROMPT }
          ]
        }]
      })
    });
    const data = await resp.json();
    if (data.error)
      return res.status(502).json({ error: 'API: ' + (data.error.message || 'errore sconosciuto') });

    const txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
    res.json({ documenti: parsed.documenti || [] });
  } catch (e) {
    res.status(422).json({ error: 'Estrazione non riuscita: il documento potrebbe essere illeggibile (scansione di bassa qualità). Riprova o verifica il PDF.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Controllo Conferme attivo sulla porta ' + port));
