const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3001;

const qrCache = {};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const EVO_URL = process.env.EVOLUTION_API_URL || 'http://evolution-api:8080';
const EVO_KEY = process.env.EVOLUTION_API_KEY || '123456';
const N8N_URL = process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/customer-service';

const headers = { 'apikey': EVO_KEY, 'Content-Type': 'application/json' };

// Create instance + get QR in one call
app.post('/api/instance/create', async (req, res) => {
    try {
        const { instanceName } = req.body;

        const r = await fetch(`${EVO_URL}/instance/create`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                instanceName,
                qrcode: true,
                integration: 'WHATSAPP-BAILEYS'
            })
        });

        const data = await r.json();

        // Cache QR if returned
        if (data.qrcode?.base64) {
            qrCache[instanceName] = data.qrcode.base64;
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get QR (from cache first, then API)
app.get('/api/instance/qrcode/:name', async (req, res) => {
    const { name } = req.params;

    // Return cached QR immediately if we have it
    if (qrCache[name]) {
        return res.json({ base64: qrCache[name] });
    }

    // Try to fetch from API
    try {
        const r = await fetch(`${EVO_URL}/instance/qrcode/${name}`, { headers });
        const data = await r.json();
        if (data.qrcode?.base64) qrCache[name] = data.qrcode.base64;
        res.json(data);
    } catch {
        res.json({ base64: null });
    }
});

// Connection state
app.get('/api/instance/state/:name', async (req, res) => {
    try {
        const r = await fetch(`${EVO_URL}/instance/connectionState/${req.params.name}`, { headers });
        const data = await r.json();
        res.json(data);
    } catch {
        res.json({ state: 'disconnected' });
    }
});

// Set webhook
app.post('/api/instance/webhook/:name', async (req, res) => {
    try {
        const r = await fetch(`${EVO_URL}/instance/setWebhook/${req.params.name}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                webhook: { url: N8N_URL, byEvents: false, base64: false }
            })
        });
        res.json(await r.json());
    } catch (err) {
        res.json({ error: err.message });
    }
});

// Logout
app.post('/api/instance/logout/:name', async (req, res) => {
    try {
        const r = await fetch(`${EVO_URL}/instance/logout/${req.params.name}`, {
            method: 'DELETE',
            headers
        });
        res.json(await r.json());
    } catch (err) {
        res.json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`QR Connector running on http://0.0.0.0:${PORT}`);
});
