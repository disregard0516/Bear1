# BakaBoost Static

This is the cleaned static HTML/CSS/JS version with a local Node backend.

## Local Preview

```bash
npm run preview
```

Open:

```text
http://127.0.0.1:3005/
```

Do not use VS Code Live Server for webhook testing. Live Server only serves files and does not run `/api/order`.

## Webhook

Discord orders are sent through `server.js` at `/api/order`.

If you upload this to a static-only host, the website can show but webhook orders will not send unless that host runs a backend route like `server.js`.
