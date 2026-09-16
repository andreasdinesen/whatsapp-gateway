# WhatsApp Gateway

Lille HTTP-bro oven på WhatsApp Web ([Baileys](https://github.com/WhiskeySockets/Baileys)).
Sender WhatsApp-beskeder — til både **telefonnumre** og **gruppechats** — via et simpelt
`POST /send`. Bygget til at modtage notifikationer fra
[Tilmeld](https://github.com/andreasdinesen/tilmeld), men virker med alt der kan lave et
HTTP-kald.

Pakket som [yggdrasil](https://github.com/kristianwind/yggdrasil)-rune.

## API

| Endpoint  | Beskrivelse |
|-----------|-------------|
| `POST /send` | Send en besked. Body: `{"to": "<nummer eller gruppe-id>", "message": "<tekst>"}` |
| `GET /qr`  | Vis QR-kode til første login + forbindelsesstatus |
| `GET /groups` | List grupper kontoen er med i (navn + `@g.us`-id) — så du kan finde gruppe-id'et til Tilmeld. Auth som `/send`; i browser: `/groups?key=<API_KEY>` |
| `GET /health` | `200 OK` + JSON-status |

### `POST /send`

```
POST /send
Authorization: Bearer <API_KEY>      # kun hvis API_KEY er sat
Content-Type: application/json

{ "to": "4512345678", "message": "Hej fra gatewayen" }
```

**`to` kan være:**

| Type | Eksempel | Behandling |
|------|----------|------------|
| Telefonnummer | `4512345678` | → `4512345678@s.whatsapp.net` |
| Fuld JID | `4512345678@s.whatsapp.net` | bruges som-is |
| Gruppe (fuld JID) | `120363012345678901@g.us` | bruges som-is |
| Gruppe (moderne id, 16+ cifre) | `120363012345678901` | → `...@g.us` |
| Gruppe (ældre id) | `4512345678-1600000000` | → `...@g.us` |

> Tip: For grupper er det mest robust at angive det fulde JID med `@g.us`.

Svar: `200 {"ok": true, ...}` ved succes; `401` ved forkert/manglende nøgle;
`503` hvis ikke forbundet til WhatsApp (scan QR); `502` hvis selve afsendelsen fejler.

## Konfiguration (env)

| Variabel | Default | Beskrivelse |
|----------|---------|-------------|
| `API_KEY` | _(tom)_ | Hvis sat: krævet som `Authorization: Bearer <API_KEY>`. Tom = åben adgang. |
| `PORT` | `8080` | HTTP-port |
| `DATA_DIR` | `/data` | Hvor WhatsApp-sessionen gemmes. Falder tilbage til `./data` hvis `/data` ikke er skrivbar. |

## Kør lokalt (Mac)

```bash
npm install
API_KEY=hemmelig DATA_DIR=./data PORT=8080 npm start
```

Åbn http://localhost:8080/qr og scan koden i WhatsApp → **Indstillinger → Tilknyttede
enheder → Tilknyt enhed**. Sessionen gemmes i `./data`, så du kun skal scanne én gang.

Send en testbesked:

```bash
curl -X POST http://localhost:8080/send \
  -H "Authorization: Bearer hemmelig" \
  -H "Content-Type: application/json" \
  -d '{"to":"4512345678","message":"hej"}'
```

## Kør med Docker

```bash
docker run -d --name whatsapp-gateway \
  -p 8080:8080 \
  -e API_KEY=hemmelig \
  -v whatsapp-data:/data \
  ghcr.io/andreasdinesen/whatsapp-gateway:latest
```

## Som yggdrasil-rune

Image bygges multi-arch (amd64 + arm64) til GHCR via GitHub Actions ved push til `main`.
Installér i yggdrasil via **Browse runes on GitHub**:

- Repository: `andreasdinesen/whatsapp-gateway`
- Folder: `runes`

→ Install → Start → åbn `/qr` → scan → `/send` virker.

Ud over `API_KEY` og `PORT` har runen feltet `IMAGE_TAG` (standard `latest`) — se
nedenfor.

### Opdatering

Panelet har to trin, og de henter hver sin ting:

1. **Runes → Browse GitHub → Reload** henter kun rune-definitionen (YAML'en) —
   nye felter og den nye version i listen. Imaget røres ikke.
2. **Restart** eller **Settings → Update/Reinstall** henter imaget. Panelet laver
   `docker pull` på image-tagget, hver gang containeren skabes på ny — med
   `IMAGE_TAG=latest` er hver Restart altså også en opdatering. **Reinstall** er
   desuden det trin, der lægger runens standard-overvågning (se nedenfor) ind på en
   eksisterende server.

WhatsApp-sessionen i `/data` overlever begge trin — der skal ikke scannes igen.

**Lås versionen:** Hvert push til `main` udgiver imaget som både `latest` og
`v<rune-version>`. Sæt `IMAGE_TAG` til fx `v5` for at blive på runens version 5 —
eller for at rulle tilbage, hvis en udgivelse driller — og tryk Restart.
Versions-taggene findes fra den udgivelse, der indførte feltet; ældre versioner findes
kun som `latest`.

**Tomt felt:** `IMAGE_TAG` må aldrig stå tomt. Panelet bruger ikke standardværdien for et
tomt felt, men gemmer det tomme, så image-adressen ender på `:` og hverken install eller
Start kan hente imaget. Står feltet tomt, så skriv `latest`, gem og tryk Restart.

### Overvågning

Runen giver tre log-watchers, der sender en notifikation i panelet:

| Watcher | Linje i loggen | Betyder |
|---------|----------------|---------|
| WhatsApp-forbindelsen er gået i stå | `[whatsapp] reconnect-fejl` / `start-fejl` | Forbindelsen kunne ikke genoprettes, og der forsøges ikke igen — **Restart** serveren |
| WhatsApp logget ud | `[whatsapp] Forbindelse lukket … Logget ud` | Sessionen er ugyldig; scan `/qr` igen |
| Beskeder kunne ikke sendes | `[send] afvist …` / `[send] -> …: FEJL` / `[groups] FEJL` | En notifikation kom ikke ud |

Almindelige `Forbindelse lukket … Genopretter...`-linjer udløser ingenting — WhatsApp
lukker forbindelsen jævnligt, og gatewayen forbinder selv igen.

### Wipe = log ud

**Wipe** sletter `auth/` — WhatsApp-sessionen. Ved næste start viser gatewayen en ny
QR-kode, og `/qr` skal scannes igen, før der kan sendes. Brug den, når sessionen er i
stykker. Den gamle enhed står stadig under *Tilknyttede enheder* på telefonen, til du
fjerner den dér. Panelet tilbyder en backup først. Planlæg aldrig en wipe.

## Kobl til Tilmeld

I Tilmeld under **master → Opsætning → WhatsApp**:

- Gateway-URL: `http://<vært>:<port>/send`
- API-nøgle: samme som `API_KEY`
