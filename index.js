require('dotenv').config()
const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose')
const { initializeWhatsApp, destroyClient, destroyAllClients } = require('./whatsapp')

const app = express()
const port = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
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
    id:        { type: String, unique: true },
    tenant_id: String,
    sender:    String,
    sender_dp: String,
    group_name: String,
    message:   String,
    time:      String,
    severity:  String,
    ai_label:  String,
    confidence: Number
}, { timestamps: true });
messageSchema.index({ tenant_id: 1, createdAt: -1 });
const Message = mongoose.model('Message', messageSchema);

// ── Helpers ──────────────────────────────────────────────────────────────────

const classifyLocally = (text, rules) => {
    if (!rules) return { severity: 'warning', label: 'Unclassified', confidence: 0 };
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

// Maps tenantId → Date.now() when init started, so we can detect stuck inits
const initializingTenants = new Map();
const INIT_TIMEOUT_MS = 120_000; // 2 minutes

function needsInit(tenantId, status) {
    if (status !== 'disconnected' && status !== 'authenticating') return false;
    if (!initializingTenants.has(tenantId)) return true;
    // Allow retry if stuck for too long (Chrome crash without events)
    const elapsed = Date.now() - initializingTenants.get(tenantId);
    if (elapsed > INIT_TIMEOUT_MS) {
        console.log(`[${tenantId}] Init timed out after ${elapsed}ms — retrying`);
        initializingTenants.delete(tenantId);
        destroyClient(tenantId);
        return true;
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

// Always reads fresh from DB so the QR appears immediately after it is generated
app.get('/api/status', async (req, res) => {
    const tenant = await Tenant.findOne({ tenant_id: req.tenantId });
    if (!tenant) return res.json({ status: 'disconnected', qr: null, number: '' });

    if (needsInit(req.tenantId, tenant.status)) {
        console.log(`Starting init for ${req.tenantId}`);
        startInit(req.tenantId);
    }

    res.json({ status: tenant.status, qr: tenant.qr, number: tenant.number || '' });
});

// Force logout + destroy session → triggers fresh QR on next status poll
app.post('/api/logout', async (req, res) => {
    await destroyClient(req.tenantId);
    initializingTenants.delete(req.tenantId);
    await Tenant.updateOne(
        { tenant_id: req.tenantId },
        { status: 'disconnected', qr: null, number: '' }
    );
    tenantCache.delete(req.tenantId);
    res.json({ success: true });
});

app.get('/api/messages', async (req, res) => {
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
});

app.get('/api/rules', (req, res) => {
    res.json(req.tenantData.rules || []);
});

app.post('/api/rules', async (req, res) => {
    await Tenant.updateOne({ tenant_id: req.tenantId }, { rules: req.body.rules });
    tenantCache.delete(req.tenantId);
    res.json({ success: true });
});

app.post('/api/simulate', async (req, res) => {
    const { text } = req.body;
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
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/whatsapp_sessions';

mongoose.connect(MONGODB_URI).then(async () => {
    console.log('MongoDB connected');

    // On startup: clear stale QR codes; leave status unchanged so RemoteAuth
    // can restore sessions without re-scanning QR
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
