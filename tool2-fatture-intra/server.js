const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '50mb' }));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ACCESS_CODE = process.env.ACCESS_CODE || '';

const PROMPT = `Questo PDF contiene uno o piu documenti commerciali del settore carta: una FATTURA fornitore intracomunitaria e/o una CONFERMA D'ORDINE.

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

app.post('/api/analizza', async (req, res) => {
  try {
    const { pdf, code } = req.body;
    if (ACCESS_CODE && code !== ACCESS_CODE) {
      return res.status(401).json({ error: 'Codice di accesso non valido' });
    }
    if (!pdf) return res.status(400).json({ error: 'PDF mancante' });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
          { type: 'text', text: PROMPT }
        ]
      }]
    });

    const txt = message.content.filter(c => c.type === 'text').map(c => c.text).join('');
    const parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
    res.json({ documenti: parsed.documenti || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Errore interno del server' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', tool: 'fatture-intra' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server fatture-intra in ascolto su porta ${PORT}`));
