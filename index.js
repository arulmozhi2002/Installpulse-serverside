require('dotenv').config()
const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose')
const { initializeWhatsApp } = require('./whatsapp')

const app = express()
const port = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

// Define MongoDB Schemas
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception (ignoring to keep server alive):', err);
});

const tenantSchema = new mongoose.Schema({
    tenant_id: { type: String, required: true, unique: true },
    status: { type: String, default: 'disconnected' },
    qr: { type: String, default: null },
    number: { type: String, default: '' },
    rules: { type: Array, default: [
        { id: 1, keyword: 'done', severity: 'success', active: true },
        { id: 2, keyword: 'delay', severity: 'warning', active: true },
        { id: 3, keyword: 'issue', severity: 'danger', active: true }
    ] }
});
const Tenant = mongoose.model('Tenant', tenantSchema);

const messageSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    tenant_id: String,
    sender: String,
    sender_dp: String,
    group_name: String,
    message: String,
    time: String,
    severity: String,
    ai_label: String,
    confidence: Number
}, { timestamps: true });
messageSchema.index({ tenant_id: 1, createdAt: -1 });
const Message = mongoose.model('Message', messageSchema);

// Helper to classify locally using custom rules
const classifyLocally = (text, rules) => {
  if (!rules) return { severity: 'warning', label: 'Unclassified', confidence: 0 };
  const lowerText = text.toLowerCase();
  for (const rule of rules) {
    if (rule.active && lowerText.includes(rule.keyword.toLowerCase())) {
      return { severity: rule.severity, label: `Rule: ${rule.keyword}`, confidence: 100 };
    }
  }
  return { severity: 'warning', label: 'Unclassified', confidence: 0 };
}

// Short-lived cache to avoid hitting MongoDB on every poll request
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

// Middleware to extract tenant ID and fetch data
app.use(async (req, res, next) => {
    req.tenantId = req.headers['x-tenant-id'] || 'default_tenant';
    try {
        req.tenantData = await getTenant(req.tenantId);
        next();
    } catch (err) {
        console.error('Error fetching tenant:', err);
        res.status(500).json({ error: 'Failed to fetch tenant data' });
    }
});

const initializingTenants = new Set();

app.get('/api/status', async (req, res) => {
  // Always read fresh from DB so QR appears immediately after it's generated
  const tenant = await Tenant.findOne({ tenant_id: req.tenantId });
  if (!tenant) return res.json({ status: 'disconnected', qr: null, number: '' });

  // Lazily initialize the WhatsApp client for this tenant if not already started
  if (!initializingTenants.has(req.tenantId) && (tenant.status === 'disconnected' || tenant.status === 'authenticating')) {
      console.log(`Calling initializeWhatsApp for ${req.tenantId}`);
      initializingTenants.add(req.tenantId);
      initializeWhatsApp(req.tenantId, classifyLocally,
          () => { initializingTenants.delete(req.tenantId); },
          () => { initializingTenants.delete(req.tenantId); },
          () => { initializingTenants.delete(req.tenantId); }
      );
  }

  res.json({
    status: tenant.status,
    qr: tenant.qr,
    number: tenant.number || ''
  })
})

app.get('/api/messages', async (req, res) => {
  const messages = await Message.find({ tenant_id: req.tenantId })
                                .sort({ createdAt: -1 })
                                .limit(100);
                                
  const formatted = messages.map(m => ({
      id: m.id,
      sender: m.sender,
      senderDp: m.sender_dp,
      group: m.group_name,
      message: m.message,
      time: m.time,
      severity: m.severity,
      aiLabel: m.ai_label,
      confidence: m.confidence
  }));
  res.json(formatted);
})

app.get('/api/rules', (req, res) => {
  res.json(req.tenantData.rules || []);
})

app.post('/api/rules', async (req, res) => {
  await Tenant.updateOne({ tenant_id: req.tenantId }, { rules: req.body.rules });
  res.json({ success: true, message: 'Rules saved to MongoDB' })
})

app.post('/api/simulate', async (req, res) => {
  const { text } = req.body;
  const classification = classifyLocally(text, req.tenantData.rules);
  
  const newMsg = new Message({
      id: Date.now().toString(),
      tenant_id: req.tenantId,
      sender: 'Simulation Tool',
      group_name: 'Test Group',
      message: text,
      time: new Date().toLocaleTimeString(),
      severity: classification.severity,
      ai_label: classification.label,
      confidence: classification.confidence
  });
  
  await newMsg.save();
  res.json(newMsg);
})

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/whatsapp_sessions";

mongoose.connect(MONGODB_URI).then(async () => {
  console.log('Connected to MongoDB for Session and Data Storage!');
  
  // Set previously connected tenants to authenticating so the frontend doesn't flash the QR code generator on server restart.
  await Tenant.updateMany({ status: 'connected' }, { status: 'authenticating', qr: null });
  // Ensure we clear QR codes for disconnected tenants as well just in case they were left lingering
  await Tenant.updateMany({ status: 'disconnected' }, { qr: null });
  
  console.log('Reset tenant statuses for seamless re-initialization.');

  const server = app.listen(port, () => {
    console.log(`Multi-Tenant Server running on port ${port}`)
  });
  
  const { destroyAllClients } = require('./whatsapp');
  
  const gracefulShutdown = async () => {
      console.log('Shutting down server, destroying WhatsApp clients...');
      await destroyAllClients();
      server.close(() => {
          mongoose.connection.close(false, () => {
              process.exit(0);
          });
      });
  };
  
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

