require('dotenv').config()
const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose')
const { createClient } = require('@supabase/supabase-js');
const { initializeWhatsApp } = require('./whatsapp')

const app = express()
const port = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

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

// Get or create tenant in Supabase
async function getTenant(tenantId) {
    let { data: tenant, error } = await supabase.from('tenants').select('*').eq('tenant_id', tenantId).single();
    
    if (!tenant) {
        tenant = {
            tenant_id: tenantId,
            status: 'disconnected',
            qr: null,
            number: '',
            is_initializing: false,
            rules: [
                { id: 1, keyword: 'done', severity: 'success', active: true },
                { id: 2, keyword: 'delay', severity: 'warning', active: true },
                { id: 3, keyword: 'issue', severity: 'danger', active: true }
            ]
        };
        await supabase.from('tenants').insert([tenant]);
    }
    return tenant;
}

// Middleware to extract tenant ID and fetch data from Supabase
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

app.get('/api/status', async (req, res) => {
  // Lazily initialize the WhatsApp client for this tenant if not already started
  if (!req.tenantData.is_initializing && req.tenantData.status === 'disconnected') {
      await supabase.from('tenants').update({ is_initializing: true }).eq('tenant_id', req.tenantId);
      initializeWhatsApp(req.tenantId, classifyLocally);
  }

  res.json({
    status: req.tenantData.status,
    qr: req.tenantData.qr,
    number: req.tenantData.number || ''
  })
})

app.get('/api/messages', async (req, res) => {
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false })
    .limit(100);
    
  const formatted = (messages || []).map(m => ({
      id: m.id,
      sender: m.sender,
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
  await supabase.from('tenants').update({ rules: req.body.rules }).eq('tenant_id', req.tenantId);
  res.json({ success: true, message: 'Rules saved to Supabase' })
})

app.post('/api/simulate', async (req, res) => {
  const { text } = req.body;
  const classification = classifyLocally(text, req.tenantData.rules);
  
  const newMsg = {
      id: Date.now().toString(),
      tenant_id: req.tenantId,
      sender: 'Simulation Tool',
      group_name: 'Test Group',
      message: text,
      time: new Date().toLocaleTimeString(),
      severity: classification.severity,
      ai_label: classification.label,
      confidence: classification.confidence
  };
  
  await supabase.from('messages').insert([newMsg]);
  res.json(newMsg);
})

const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://arul:<db_password>@revotra.6vsus04.mongodb.net/?appName=Revotra";

mongoose.connect(MONGODB_URI).then(() => {
  console.log('Connected to MongoDB for Session Storage!');
  app.listen(port, () => {
    console.log(`Multi-Tenant Server running on port ${port}`)
  });
}).catch(err => {
  console.error('MongoDB connection error:', err);
});
