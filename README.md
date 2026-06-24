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

## Kobl til Tilmeld

I Tilmeld under **master → Opsætning → WhatsApp**:

- Gateway-URL: `http://<vært>:<port>/send`
- API-nøgle: samme som `API_KEY`
