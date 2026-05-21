require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { initializeWhatsApp } = require('./whatsapp')

const app = express()
const port = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

// Multi-tenant in-memory store
const tenants = {}

// Helper to classify locally using custom rules
const classifyLocally = (text, rules) => {
  const lowerText = text.toLowerCase();
  for (const rule of rules) {
    if (rule.active && lowerText.includes(rule.keyword.toLowerCase())) {
      return { severity: rule.severity, label: `Rule: ${rule.keyword}`, confidence: 100 };
    }
  }
  return { severity: 'warning', label: 'Unclassified', confidence: 0 };
}

// Get or create tenant
function getTenant(tenantId) {
    if (!tenants[tenantId]) {
        tenants[tenantId] = {
            status: 'disconnected',
            qr: null,
            number: '',
            messages: [],
            rules: [
                { id: 1, keyword: 'done', severity: 'success', active: true },
                { id: 2, keyword: 'delay', severity: 'warning', active: true },
                { id: 3, keyword: 'issue', severity: 'danger', active: true }
            ],
            isInitializing: false
        }
    }
    return tenants[tenantId];
}

// Middleware to extract tenant ID
app.use((req, res, next) => {
    // If no tenant ID is provided, use a default fallback (so old endpoints don't instantly break)
    req.tenantId = req.headers['x-tenant-id'] || 'default_tenant';
    req.tenantData = getTenant(req.tenantId);
    next();
});

app.get('/api/status', (req, res) => {
  // Lazily initialize the WhatsApp client for this tenant if not already started
  if (!req.tenantData.isInitializing && req.tenantData.status === 'disconnected') {
      req.tenantData.isInitializing = true;
      initializeWhatsApp(req.tenantId, req.tenantData, classifyLocally);
  }

  res.json({
    status: req.tenantData.status,
    qr: req.tenantData.qr,
    number: req.tenantData.number || ''
  })
})

app.get('/api/messages', (req, res) => {
  res.json(req.tenantData.messages)
})

app.get('/api/rules', (req, res) => {
  res.json(req.tenantData.rules)
})

app.post('/api/rules', (req, res) => {
  req.tenantData.rules = req.body.rules
  res.json({ success: true, message: 'Rules saved' })
})

app.post('/api/simulate', (req, res) => {
  const { text } = req.body;
  const classification = classifyLocally(text, req.tenantData.rules);
  
  const newMsg = {
      id: Date.now().toString(),
      sender: 'Simulation Tool',
      group: 'Test Group',
      message: text,
      time: new Date().toLocaleTimeString(),
      severity: classification.severity,
      aiLabel: classification.label,
      confidence: classification.confidence
  };
  
  req.tenantData.messages.unshift(newMsg);
  res.json(newMsg);
})

app.listen(port, () => {
  console.log(`Multi-Tenant Server running on port ${port}`)
})
