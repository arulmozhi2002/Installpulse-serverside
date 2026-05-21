require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { initializeWhatsApp } = require('./whatsapp')

const app = express()
const port = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

// In-memory data store for the prototype
const data = {
  status: 'disconnected',
  qr: null,
  messages: [],
  rules: [
    { id: 1, keyword: 'done', severity: 'success', active: true },
    { id: 2, keyword: 'delay', severity: 'warning', active: true },
    { id: 3, keyword: 'issue', severity: 'danger', active: true }
  ]
}

app.get('/api/status', (req, res) => {
  res.json({
    status: data.status,
    qr: data.qr,
    number: data.number || ''
  })
})

app.get('/api/messages', (req, res) => {
  res.json(data.messages)
})

app.get('/api/rules', (req, res) => {
  res.json(data.rules)
})

app.post('/api/rules', (req, res) => {
  data.rules = req.body.rules
  res.json({ success: true, message: 'Rules saved' })
})

// Helper to classify locally using custom rules
const classifyLocally = (text) => {
  const lowerText = text.toLowerCase();
  for (const rule of data.rules) {
    if (rule.active && lowerText.includes(rule.keyword.toLowerCase())) {
      return { severity: rule.severity, label: `Rule: ${rule.keyword}`, confidence: 100 };
    }
  }
  return { severity: 'warning', label: 'Unclassified', confidence: 0 };
}

app.post('/api/simulate', (req, res) => {
  const { text } = req.body;
  const classification = classifyLocally(text);
  
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
  
  data.messages.unshift(newMsg);
  res.json(newMsg);
})

app.listen(port, () => {
  console.log(`Server running on port ${port}`)
  initializeWhatsApp(data, classifyLocally)
})
