const express = require('express');
const { google } = require('googleapis');
const open = require('open');
const path = require('path');

// Configuration
const GOOGLE_CLIENT_ID = '675940421997-d3a1ooq01nip3h0aocn558ilr0e907kj.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify'
];

const app = express();
const port = 3000;

const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
);

let tokens = null;

app.use(express.json());

// Helper Functions

function findHeader(headers, name) {
    if (!headers) return null;
    const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : null;
}

function hasUnsubscribeInfo(headers) {
    if (!headers) return false;
    return headers.some(h => {
        const name = h.name.toLowerCase();
        const value = (h.value || '').toLowerCase();
        return name === 'list-unsubscribe' || 
               name === 'x-unsubscribe' ||
               name === 'list-unsubscribe-post' ||
               value.includes('unsubscribe');
    });
}

function extractUnsubscribeData(headers) {
    const listUnsubscribe = findHeader(headers, 'List-Unsubscribe');
    const from = findHeader(headers, 'From');
    
    if (!listUnsubscribe || !from) return null;

    // Parse mailto: or http links
    const mailtoMatch = listUnsubscribe.match(/mailto:([^>?\s]+)(\?[^>]*)?/);
    const httpMatch = listUnsubscribe.match(/https?:\/\/[^>\s]+/);

    return {
        from,
        listUnsubscribe,
        mailto: mailtoMatch ? mailtoMatch[1] : null,
        mailtoParams: mailtoMatch && mailtoMatch[2] ? mailtoMatch[2] : null,
        httpLink: httpMatch ? httpMatch[0] : null
    };
}

// Basic Routes

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/auth', (req, res) => {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
    });
    res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).send('Missing authorization code');
    }
    try {
        const { tokens: newTokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(newTokens);
        tokens = newTokens;
        console.log('✅ Authentication successful! Tokens received.');
        res.redirect('/');
    } catch (error) {
        console.error('❌ Error obtaining tokens:', error.message);
        res.status(500).send('Authentication failed');
    }
});

app.get('/auth-status', (req, res) => {
    res.json({ isAuthenticated: !!tokens });
});

app.get('/signout', (req, res) => {
    tokens = null;
    oAuth2Client.setCredentials(null);
    console.log('👋 User signed out.');
    res.json({ success: true, message: 'Signed out' });
});

// Test Endpoint (for debugging)

app.get('/test-headers', async (req, res) => {
    if (!tokens) return res.status(401).json({ error: 'Not authenticated' });
    
    oAuth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    try {
        console.log('🔍 Test request: loading first 20 messages...');
        
        const listResponse = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 20
        });

        const messages = listResponse.data.messages || [];
        console.log(`📧 Messages found: ${messages.length}`);

        if (messages.length === 0) {
            return res.json({ error: 'No messages found', headers: [] });
        }

        const details = await Promise.all(
            messages.map(msg => 
                gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'metadata'
                }).then(r => r.data).catch(e => null)
            )
        );

        const analysis = details.filter(d => d).map(d => {
            const from = findHeader(d.payload.headers, 'From');
            const hasUnsub = hasUnsubscribeInfo(d.payload.headers);
            const listUnsub = findHeader(d.payload.headers, 'List-Unsubscribe');
            
            return {
                from,
                hasUnsubscribe: hasUnsub,
                listUnsubscribe: listUnsub,
                allHeaders: d.payload.headers.map(h => h.name)
            };
        });

        const withUnsub = analysis.filter(a => a.hasUnsubscribe);
        console.log(`✅ Messages with unsubscribe: ${withUnsub.length} out of ${analysis.length}`);

        res.json({ 
            total: analysis.length,
            withUnsubscribe: withUnsub.length,
            details: analysis 
        });
    } catch (error) {
        console.error('❌ Error in test-headers:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Main Subscription Search

app.get('/fetch-subscriptions', async (req, res) => {
    if (!tokens) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    oAuth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    const MAX_EMAILS_TO_CHECK = 1000;
    const PAGE_SIZE = 100;
    let allMessages = [];
    let pageToken = null;

    try {
        console.log(`🚀 Starting subscription search (up to ${MAX_EMAILS_TO_CHECK} emails)...`);

        // Step 1: Collect message IDs
        do {
            console.log(`📥 Loading message page (pageToken: ${pageToken || 'first'})...`);
            
            const listResponse = await gmail.users.messages.list({
                userId: 'me',
                q: 'unsubscribe',
                maxResults: PAGE_SIZE,
                pageToken: pageToken
            });
            
            console.log('API Response:', {
                messagesCount: listResponse.data.messages?.length || 0,
                hasNextPage: !!listResponse.data.nextPageToken
            });

            const messages = listResponse.data.messages;
            if (messages && messages.length > 0) {
                allMessages = allMessages.concat(messages);
                console.log(`✅ Found ${messages.length} more messages. Total: ${allMessages.length}`);
            } else {
                console.log('⚠️ This page returned no messages');
            }

            pageToken = listResponse.data.nextPageToken;

        } while (pageToken && allMessages.length < MAX_EMAILS_TO_CHECK);

        if (allMessages.length === 0) {
            console.log('❌ Gmail found no messages with "unsubscribe".');
            return res.json({ senders: [], total: 0 });
        }

        console.log(`📊 ID collection complete. Total found: ${allMessages.length}. Starting detail loading...`);

        // Step 2: Load message details in batches
        const BATCH_SIZE = 50;
        const senders = new Map();
        let processedCount = 0;

        for (let i = 0; i < allMessages.length; i += BATCH_SIZE) {
            const batch = allMessages.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(allMessages.length / BATCH_SIZE);
            
            console.log(`🔄 Processing batch ${batchNum}/${totalBatches} (messages ${i + 1}-${Math.min(i + BATCH_SIZE, allMessages.length)})...`);

            const batchPromises = batch.map(msg => 
                gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'metadata',
                    metadataHeaders: ['From', 'List-Unsubscribe', 'X-Unsubscribe']
                }).then(res => res.data).catch(err => {
                    console.error(`⚠️ Error loading message ${msg.id}:`, err.message);
                    return null;
                })
            );
            
            const results = await Promise.all(batchPromises);

            // Process batch results
            for (const data of results) {
                if (!data || !data.payload) continue;
                
                const unsubData = extractUnsubscribeData(data.payload.headers);
                
                if (unsubData && !senders.has(unsubData.from)) {
                    senders.set(unsubData.from, {
                        listUnsubscribeHeader: unsubData.listUnsubscribe,
                        mailto: unsubData.mailto,
                        httpLink: unsubData.httpLink
                    });
                    processedCount++;
                }
            }

            console.log(`   ✓ Unique subscriptions found: ${senders.size}`);

            // Pause between batches
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        console.log(`🎉 Processing complete! Found ${senders.size} unique subscriptions from ${allMessages.length} emails.`);
        
        const sendersArray = Array.from(senders.entries()).map(([from, data]) => ({
            from,
            ...data
        }));
        
        res.json({ 
            senders: sendersArray,
            total: sendersArray.length,
            scanned: allMessages.length
        });

    } catch (error) {
        console.error('💥 Global error during subscription search:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ error: 'Failed to fetch subscriptions', details: error.message });
    }
});

// Unsubscribe

app.post('/unsubscribe-mailto', async (req, res) => {
    if (!tokens) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { mailtoData } = req.body;
    console.log(`📧 Attempting email unsubscribe for: ${mailtoData.to}`);

    oAuth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    try {
        let rawEmail = `To: ${mailtoData.to}\r\n`;
        if (mailtoData.subject) {
            rawEmail += `Subject: ${mailtoData.subject}\r\n`;
        }
        rawEmail += '\r\n';

        const base64Email = Buffer.from(rawEmail)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: base64Email
            }
        });
        
        console.log(`✅ Unsubscribe email sent to ${mailtoData.to}`);
        res.json({ success: true, message: `Unsubscribe email sent to ${mailtoData.to}` });

    } catch (error) {
        console.error('❌ Error sending email:', error.message);
        res.status(500).json({ error: 'Failed to send unsubscribe email' });
    }
});

// Start Server

app.listen(port, () => {
    console.log(`\n🚀 Server running: http://localhost:${port}`);
    console.log(`📝 Available endpoints:`);
    console.log(`   - GET  /              Main page`);
    console.log(`   - GET  /auth          Authorization`);
    console.log(`   - GET  /test-headers  Test (20 messages)`);
    console.log(`   - GET  /fetch-subscriptions  Full search`);
    console.log(`   - POST /unsubscribe-mailto   Unsubscribe\n`);
});
