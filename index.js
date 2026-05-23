require('dotenv').config()
const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose')
const { initializeWhatsApp, destroyClient, destroyAllClients, requestPairingCode, clearAuthState, logoutClient } = require('./whatsapp')

const app = express()
const port = process.env.PORT || 3000

const allowedOrigins = [
  'http://localhost:5173',
  'https://installpulse-frontend.vercel.app',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
]
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error('Not allowed by CORS'))
  }
}))
app.use(express.json())

// Keep server alive on unexpected errors; log for debugging
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

// ── Schemas ─────────────────────────────────────────────────────────────────

const tenantSchema = new mongoose.Schema({
    tenant_id: { type: String, required: true, unique: true },
    status:    { type: String, default: 'disconnected' },
    qr:        { type: String, default: null },
    number:    { type: String, default: '' },
    rules:     { type: Array, default: [
        { id: 1, keyword: 'done',  severity: 'success', active: true },
        { id: 2, keyword: 'delay', severity: 'warning', active: true },
        { id: 3, keyword: 'issue', severity: 'danger',  active: true }
    ]}
});
const Tenant = mongoose.model('Tenant', tenantSchema);

const messageSchema = new mongoose.Schema({
    id:         { type: String, unique: true },
    tenant_id:  String,
    sender:     String,
    sender_dp:  String,
    group_name: String,
    message:    String,
    time:       String,
    severity:   String,
    ai_label:   String,
    confidence: Number
}, { timestamps: true });

// Fast lookup when fetching messages
messageSchema.index({ tenant_id: 1, createdAt: -1 });
// Auto-delete messages older than 30 days to stay within 512 MB Atlas limit
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const Message = mongoose.model('Message', messageSchema);

// ── Helpers ──────────────────────────────────────────────────────────────────

const classifyLocally = (text, rules) => {
    if (!rules || !text) return { severity: 'warning', label: 'Unclassified', confidence: 0 };
    const lower = text.toLowerCase();
    for (const rule of rules) {
        if (rule.active && lower.includes(rule.keyword.toLowerCase())) {
            return { severity: rule.severity, label: `Rule: ${rule.keyword}`, confidence: 100 };
        }
    }
    return { severity: 'warning', label: 'Unclassified', confidence: 0 };
};

// Short-lived cache — avoids hitting MongoDB on every /api/messages poll
const tenantCache = new Map();
async function getTenant(tenantId) {
    const cached = tenantCache.get(tenantId);
    if (cached && Date.now() - cached.ts < 4000) return cached.tenant;
    let tenant = await Tenant.findOne({ tenant_id: tenantId });
    if (!tenant) {
        tenant = new Tenant({ tenant_id: tenantId });
        await tenant.save();
    }
    tenantCache.set(tenantId, { tenant, ts: Date.now() });
    return tenant;
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(async (req, res, next) => {
    req.tenantId = req.headers['x-tenant-id'] || 'default_tenant';
    try {
        req.tenantData = await getTenant(req.tenantId);
        next();
    } catch (err) {
        console.error('Tenant middleware error:', err);
        res.status(500).json({ error: 'Failed to fetch tenant data' });
    }
});

// ── Initialization tracker ───────────────────────────────────────────────────

const initializingTenants = new Map(); // tenantId → startTime
const INIT_TIMEOUT_MS = 300_000;       // 5 min — give users enough time to enter pairing code

function needsInit(tenantId, status) {
    if (status !== 'disconnected' && status !== 'authenticating') return false;
    if (!initializingTenants.has(tenantId)) return true;
    const elapsed = Date.now() - initializingTenants.get(tenantId);
    if (elapsed > INIT_TIMEOUT_MS) {
        console.log(`[${tenantId}] Init timed out (${elapsed}ms) — retrying`);
        initializingTenants.delete(tenantId);
        destroyClient(tenantId).then(() => startInit(tenantId));
        return false;
    }
    return false;
}

function startInit(tenantId) {
    initializingTenants.set(tenantId, Date.now());
    initializeWhatsApp(
        tenantId,
        classifyLocally,
        () => { initializingTenants.delete(tenantId); },   // onInitError
        () => { initializingTenants.delete(tenantId); },   // onReady
        () => { initializingTenants.delete(tenantId); }    // onDisconnected
    );
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Render health check — must respond 200 or Render marks service as down
app.get('/health', (req, res) => res.json({ ok: true }));

// Always reads fresh from DB so QR appears immediately after generation
app.get('/api/status', async (req, res) => {
    try {
        const tenant = await Tenant.findOne({ tenant_id: req.tenantId });
        if (!tenant) return res.json({ status: 'disconnected', qr: null, number: '' });

        if (needsInit(req.tenantId, tenant.status)) {
            console.log(`Starting init for ${req.tenantId}`);
            startInit(req.tenantId); // only reached on first init; timeout-retry is handled inside needsInit
        }

        res.json({ status: tenant.status, qr: tenant.qr, number: tenant.number || '' });
    } catch (err) {
        console.error('Error in /api/status:', err);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// Request a pairing code for phone-number-based login (no QR scan needed)
app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });
    try {
        // Always destroy any existing socket and wipe stored credentials so Baileys
        // starts a clean connection. If credentials exist from a prior session Baileys
        // reconnects silently (no QR event), sockQrReady never fires, and WhatsApp
        // never sends the pairing notification to the phone.
        await destroyClient(req.tenantId);
        await clearAuthState(req.tenantId);
        initializingTenants.delete(req.tenantId);
        tenantCache.delete(req.tenantId);
        await Tenant.updateOne(
            { tenant_id: req.tenantId },
            { status: 'disconnected', qr: null, number: '' }
        );

        startInit(req.tenantId);

        const code = await requestPairingCode(req.tenantId, phoneNumber);
        // Reset init timer so the socket isn't destroyed while the user enters the code
        initializingTenants.set(req.tenantId, Date.now());
        res.json({ code });
    } catch (err) {
        console.error('Error in /api/pair:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Logout: unlinks device from WhatsApp, wipes saved credentials, resets state
app.post('/api/logout', async (req, res) => {
    try {
        await logoutClient(req.tenantId);
        initializingTenants.delete(req.tenantId);
        await Tenant.updateOne(
            { tenant_id: req.tenantId },
            { status: 'disconnected', qr: null, number: '' }
        );
        tenantCache.delete(req.tenantId);
        res.json({ success: true });
    } catch (err) {
        console.error('Error in /api/logout:', err);
        res.status(500).json({ error: 'Failed to logout' });
    }
});

app.get('/api/messages', async (req, res) => {
    try {
        const messages = await Message.find({ tenant_id: req.tenantId })
            .sort({ createdAt: -1 })
            .limit(100);
        res.json(messages.map(m => ({
            id:         m.id,
            sender:     m.sender,
            senderDp:   m.sender_dp,
            group:      m.group_name,
            message:    m.message,
            time:       m.time,
            severity:   m.severity,
            aiLabel:    m.ai_label,
            confidence: m.confidence
        })));
    } catch (err) {
        console.error('Error in /api/messages:', err);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

app.get('/api/rules', (req, res) => {
    res.json(req.tenantData.rules || []);
});

app.post('/api/rules', async (req, res) => {
    const { rules } = req.body;
    if (!Array.isArray(rules)) return res.status(400).json({ error: 'rules must be an array' });
    const valid = rules.every(r => r && typeof r.keyword === 'string' && typeof r.severity === 'string');
    if (!valid) return res.status(400).json({ error: 'each rule must have keyword and severity' });
    try {
        await Tenant.updateOne({ tenant_id: req.tenantId }, { rules });
        tenantCache.delete(req.tenantId);
        res.json({ success: true });
    } catch (err) {
        console.error('Error in /api/rules:', err);
        res.status(500).json({ error: 'Failed to save rules' });
    }
});

app.post('/api/simulate', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'text is required' });
        const cls = classifyLocally(text, req.tenantData.rules);
        const msg = new Message({
            id:         Date.now().toString(),
            tenant_id:  req.tenantId,
            sender:     'Simulation Tool',
            group_name: 'Test Group',
            message:    text,
            time:       new Date().toLocaleTimeString(),
            severity:   cls.severity,
            ai_label:   cls.label,
            confidence: cls.confidence
        });
        await msg.save();
        res.json(msg);
    } catch (err) {
        console.error('Error in /api/simulate:', err);
        res.status(500).json({ error: 'Failed to simulate message' });
    }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/whatsapp_sessions';

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
}).then(async () => {
    console.log('MongoDB connected');
    await Tenant.updateMany({}, { qr: null });
    console.log('Cleared stale QR codes');

    const server = app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });

    const gracefulShutdown = async () => {
        console.log('Shutting down...');
        await destroyAllClients();
        server.close(() => {
            mongoose.connection.close(false, () => process.exit(0));
        });
    };

    process.on('SIGINT',  gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);

}).catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
});
