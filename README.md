# Suite Controlli — Serchio Distribuzione

App web per il controllo automatico di documenti commerciali nel settore carta. Confronta ordini, conferme e fatture fornitore segnalando discrepanze in automatico.

## Struttura del repo

```
server.js          → Backend Node/Express (Railway): lettura PDF con Claude, abbinamento righe, serve la pagina
index.html         → Pagina del tool (servita da Railway su /)
recon.js           → Logica di riconciliazione ordine ↔ conferme ↔ fatture (usata dalla pagina e dai test)
test/              → Prova completa con l'AI (`test/e2e.js`); i test con i dati reali dei PDF restano solo in locale
package.json
tool2-fatture-intra/
  server.js        → (legacy, non più usato)
  package.json     → (legacy, non più usato)
```

## Tool disponibili

| Tool | Funzione | Stato |
|---|---|---|
| **Conferme d'Ordine** | Confronta ordini Serchio con conferme fornitore | ✅ Live |
| **Ordini · Conferme · Fatture** | Riconcilia ordine Serchio, conferme e fatture fornitore per numero d'ordine: righe, quantità, prezzi, date, residui da confermare/fatturare, anche con più conferme e più fatture | ✅ Live |
| **Fatture Estere** | Fornitori extra-UE (Turchia, UK, Asia) | ⏳ In arrivo |

## Architettura

```
GitHub (questo repo)
  └── Railway (backend Node/Express)
        ├── POST /api/analizza    → Tool 1: lettura ordini e conferme
        ├── POST /api/abbina      → Tool 1: abbinamento righe ordine ↔ conferma
        ├── POST /api/analizza3   → Tool 2: lettura ordini, conferme, fatture (schema unico)
        └── POST /api/riconcilia  → Tool 2: abbinamento articoli ordine ↔ conferme ↔ fatture
              ↑
        Netlify (frontend HTML singolo)
```

## Deploy Railway

Variabili d'ambiente da impostare:

| Variabile | Valore |
|---|---|
| `ANTHROPIC_API_KEY` | sk-ant-... |
| `ACCESS_CODE` | codice di accesso scelto |
| `ALLOWED_ORIGIN` | URL del sito Netlify |

Railway legge `server.js` dalla root del repo e si aggiorna automaticamente ad ogni push su `main`.

## Deploy Netlify

Il frontend è il file `index.html` dentro `NETLIFY_suite_unificata.zip` — già configurato con l'URL Railway corretto. Caricare tramite drag & drop nella dashboard Netlify.

## Verifica backend

Aprire nel browser: `https://[URL-RAILWAY]/health`

Risposta attesa: `{"status":"ok","tool":"suite-controlli"}`
