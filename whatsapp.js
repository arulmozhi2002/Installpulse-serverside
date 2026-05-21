const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

function initializeWhatsApp(tenantId, classifyFn) {
    console.log(`Initializing WhatsApp Client for Tenant: ${tenantId}...`);
    
    const store = new MongoStore({ mongoose: mongoose });

    const client = new Client({
        authStrategy: new RemoteAuth({ 
            clientId: tenantId,
            store: store,
            backupSyncIntervalMs: 300000
        }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--single-process',
                '--memory-pressure-off'
            ]
        }
    });

    client.on('remote_session_saved', () => {
        console.log(`[${tenantId}] Remote Session explicitly saved to MongoDB.`);
    });

    client.on('qr', async qr => {
        console.log(`[${tenantId}] QR Code Received`);
        await supabase.from('tenants').update({ status: 'disconnected', qr: qr }).eq('tenant_id', tenantId);
    });

    client.on('authenticated', async () => {
        console.log(`[${tenantId}] AUTHENTICATED successfully!`);
        await supabase.from('tenants').update({ status: 'authenticating', qr: null }).eq('tenant_id', tenantId);
    });

    client.on('auth_failure', async msg => {
        console.error(`[${tenantId}] AUTHENTICATION FAILURE`, msg);
        await supabase.from('tenants').update({ status: 'disconnected' }).eq('tenant_id', tenantId);
    });

    client.on('ready', async () => {
        console.log(`[${tenantId}] WhatsApp Client is ready!`);
        let number = 'Device Connected';
        if (client.info && client.info.wid) {
            number = '+' + client.info.wid.user;
        }
        await supabase.from('tenants').update({ status: 'connected', qr: null, number: number }).eq('tenant_id', tenantId);
    });

    client.on('message', async msg => {
        // Ignore WhatsApp statuses
        if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;

        console.log(`[${tenantId}] MESSAGE RECEIVED:`, msg.body);
        
        // Fetch current rules from Supabase for classification
        const { data: tenant } = await supabase.from('tenants').select('rules').eq('tenant_id', tenantId).single();
        const rules = tenant?.rules || [];
        
        const classification = classifyFn(msg.body, rules);
        
        let senderName = msg._data?.notifyName || msg.from.split('@')[0];
        let groupName = msg.from.includes('@g.us') ? 'WhatsApp Group' : 'Direct Message';
        
        const newMsg = {
            id: msg.id._serialized,
            tenant_id: tenantId,
            sender: senderName,
            group_name: groupName,
            message: msg.body,
            time: new Date().toLocaleTimeString(),
            severity: classification.severity,
            ai_label: classification.label,
            confidence: classification.confidence
        };
        
        // Save to Supabase
        const { error } = await supabase.from('messages').insert([newMsg]);
        if (error) console.error(`[${tenantId}] Error saving message to Supabase:`, error.message);
    });

    client.initialize().catch(async err => {
        console.error(`[${tenantId}] Initialization Error:`, err);
        await supabase.from('tenants').update({ is_initializing: false }).eq('tenant_id', tenantId);
    });
}

module.exports = { initializeWhatsApp };
