# Controllo Conferme d'Ordine — Deploy con GitHub + Railway + Netlify

Stesso flusso del chatbot: codice su GitHub, backend su Railway, frontend su Netlify.
Nota: il backend Railway serve anche il frontend, quindi Netlify è facoltativo —
se vuoi fare prima, basta Railway da solo (vedi "Scorciatoia" in fondo).

## Struttura

- `server/`   → backend Node/Express (Railway): chiama l'AI, custodisce la chiave API
- `frontend/` → l'app web (Netlify)

## Passo 1 — Chiave API Anthropic

Su https://console.anthropic.com: account, piccolo credito, genera una API key
(sezione "API Keys"). Costo indicativo: pochi centesimi per documento analizzato.

## Passo 2 — GitHub

Crea un repository e carica tutta questa cartella mantenendo la struttura.

## Passo 3 — Railway (backend)

1. https://railway.app → New Project → Deploy from GitHub repo → scegli il repository.
2. Nelle impostazioni del servizio imposta **Root Directory: `server`**
   (Railway rileva Node e usa `npm start` automaticamente).
3. Variables → aggiungi:
   - `ANTHROPIC_API_KEY` = la tua chiave
   - `ACCESS_CODE`       = un codice a tua scelta (consigliato)
4. Settings → Networking → **Generate Domain**: ottieni l'URL del backend,
   tipo `https://xxxx.up.railway.app`. Copialo.

⚠️ Root Directory `server`: in questo modo Railway vede solo il backend, ma il
server serve il frontend dalla cartella `../frontend` — perciò se preferisci che
Railway serva anche la pagina, lascia Root Directory vuota e imposta
**Start Command: `npm start --prefix server`** (e installa con
`npm install --prefix server`). La via più semplice resta: Root = `server` per
solo-API + Netlify per la pagina, come sotto.

## Passo 4 — Netlify (frontend)

1. Apri `frontend/index.html` e in cima allo script trovi:
   `const BACKEND_URL = '';`
   Incolla l'URL Railway: `const BACKEND_URL = 'https://xxxx.up.railway.app';`
2. Su https://app.netlify.com → Add new site → **Deploy manually** → trascina la
   cartella `frontend` (oppure collega il repo GitHub con publish directory `frontend`).
3. Ottieni l'indirizzo pubblico, es. `https://controlli-serkios.netlify.app`.
   Cambiabile in Site settings → Domain management (anche dominio personalizzato,
   es. controlli.fibersflow.com).
4. (Consigliato) Su Railway aggiungi la variabile
   `ALLOWED_ORIGIN = https://controlli-serkios.netlify.app`
   così solo il tuo sito Netlify può usare il backend.

## Scorciatoia: solo Railway

Se vuoi un solo servizio: deploy del repo su Railway con Root Directory vuota,
Build command `npm install --prefix server`, Start command `npm start --prefix server`,
stesse variabili. Il dominio Railway servirà sia la pagina sia l'API
(lascia `BACKEND_URL = ''` nel frontend).

## Uso

Gli utenti aprono il link, inseriscono il codice di accesso, trascinano i PDF
(ordini, conferme o file combinati) e premono "Avvia controllo". Abbinamento
automatico per numero d'ordine, criterio di corrispondenza esatta al 100%,
export CSV del report.

## Sicurezza e dati

- La chiave API vive solo nelle variabili Railway, mai nel browser.
- ACCESS_CODE impedisce a estranei di consumare il vostro credito.
- I PDF non vengono salvati: transitano per l'analisi e basta.
