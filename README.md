# Suite Controlli — Serchio Distribuzione

App web per il controllo automatico di documenti commerciali nel settore carta. Confronta ordini, conferme e fatture fornitore segnalando discrepanze in automatico.

## Struttura del repo

```
server.js          → Backend Node/Express (Railway) — gestisce Tool 1 e Tool 2
package.json
index.html         → Frontend di riferimento (non usato in produzione)
tool2-fatture-intra/
  server.js        → (legacy, non più usato)
  package.json     → (legacy, non più usato)
```

## Tool disponibili

| Tool | Funzione | Stato |
|---|---|---|
| **Conferme d'Ordine** | Confronta ordini Serchio con conferme fornitore | ✅ Live |
| **Fatture Fornitore** | Confronta fatture UE + Mondi con conferme d'ordine | ✅ Live |
| **Fatture Estere** | Fornitori extra-UE (Turchia, UK, Asia) | ⏳ In arrivo |

## Architettura

```
GitHub (questo repo)
  └── Railway (backend Node/Express)
        ├── POST /api/analizza   → Tool 1 Conferme d'Ordine
        └── POST /api/analizza2  → Tool 2 Fatture Fornitore
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
