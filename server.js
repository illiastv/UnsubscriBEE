const express = require('express');
const { google } = require('googleapis');
const open = require('open');
const path = require('path');

// --- 1. КОНФИГУРАЦИЯ ---
// !! ВАЖНО !!
// Вставьте сюда ваши Client ID и Client Secret из Google Cloud Console
const GOOGLE_CLIENT_ID = '675940421997-d3a1ooq01nip3h0aocn558ilr0e907kj.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

// Области доступа (Scopes), которые мы запрашиваем
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send'
];

const app = express();
const port = 3000;

// OAuth2 клиент
const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
);

// Временное хранилище для токенов (в реальном приложении здесь была бы база данных)
let tokens = null;

// --- 2. MIDDLEWARE ---
// Позволяет нам получать JSON в запросах (для отписки)
app.use(express.json());

// --- 3. МАРШРУТЫ (ROUTES) ---

// Главная страница: отдаем наш index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Маршрут для аутентификации
// Генерирует URL для входа и перенаправляет пользователя на страницу Google
app.get('/auth', (req, res) => {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline', // 'offline' нужен, чтобы получить refresh_token
        scope: SCOPES,
    });
    res.redirect(authUrl);
});

// Callback-маршрут, на который Google перенаправляет после входа
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).send('Missing authorization code');
    }
    try {
        // Обмениваем 'code' на 'tokens'
        const { tokens: newTokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(newTokens);
        tokens = newTokens; // Сохраняем токены
        console.log('Successfully authenticated!');
        // Перенаправляем пользователя обратно на главную страницу
        res.redirect('/');
    } catch (error) {
        console.error('Error exchanging code for tokens:', error.message);
        res.status(500).send('Authentication failed');
    }
});

// Проверка статуса аутентификации (для клиента)
app.get('/auth-status', (req, res) => {
    res.json({ isAuthenticated: !!tokens });
});

// Выход (просто очищаем токены)
app.get('/signout', (req, res) => {
    tokens = null;
    oAuth2Client.setCredentials(null);
    res.json({ success: true, message: 'Signed out' });
});


// --- 4. GMAIL API МАРШРУТЫ ---

// Получение подписок
app.get('/fetch-subscriptions', async (req, res) => {
    if (!tokens) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    oAuth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    try {
        // 1. Получаем список сообщений
        const listResponse = await gmail.users.messages.list({
            userId: 'me',
            q: 'has:list-unsubscribe',
            maxResults: 100,
        });

        const messages = listResponse.data.messages;
        if (!messages || messages.length === 0) {
            return res.json({ senders: [] });
        }

        // 2. Используем Batch-запрос (как и раньше, но на сервере)
        const batch = google.batch({ auth: oAuth2Client });
        const gmailBatch = google.gmail({ version: 'v1' });
        
        const senders = new Map();

        messages.forEach(message => {
            batch.add({
                method: 'GET',
                path: `/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe`,
            });
        });

        // 3. Выполняем Batch
        // Прямой вызов batch.run() может быть сложным,
        // Вместо этого мы будем использовать Promise.all для параллельных запросов
        // Это проще для понимания и достаточно эффективно
        
        const messagePromises = messages.map(msg => 
            gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'metadata',
                metadataHeaders: ['From', 'List-Unsubscribe']
            })
        );
        
        const messageResults = await Promise.all(messagePromises);

        // 4. Обрабатываем результаты
        for (const result of messageResults) {
            const headers = result.data.payload.headers;
            const from = findHeader(headers, 'From');
            const listUnsubscribe = findHeader(headers, 'List-Unsubscribe');

            if (from && listUnsubscribe && !senders.has(from)) {
                senders.set(from, {
                    listUnsubscribeHeader: listUnsubscribe,
                });
            }
        }
        
        // 5. Отправляем клиенту готовый результат
        // Преобразуем Map в массив
        const sendersArray = Array.from(senders.entries()).map(([from, data]) => ({
            from,
            ...data
        }));
        
        res.json({ senders: sendersArray });

    } catch (error) {
        console.error('Error fetching subscriptions:', error.message);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});

// Отписка по Email
app.post('/unsubscribe-mailto', async (req, res) => {
    if (!tokens) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { mailtoData } = req.body;
    if (!mailtoData || !mailtoData.to) {
        return res.status(400).json({ error: 'Invalid mailto data' });
    }

    oAuth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    try {
        let rawEmail = `To: ${mailtoData.to}\r\n`;
        if (mailtoData.subject) {
            rawEmail += `Subject: ${mailtoData.subject}\r\n`;
        }
        rawEmail += '\r\n'; // Empty body

        const base64Email = Buffer.from(rawEmail).toString('base64');
        const safeBase64Email = base64Email.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: safeBase64Email
            }
        });
        
        res.json({ success: true, message: `Unsubscribe email sent to ${mailtoData.to}` });

    } catch (error) {
        console.error('Error sending unsubscribe email:', error.message);
        res.status(500).json({ error: 'Failed to send unsubscribe email' });
    }
});


// --- 5. ХЕЛПЕРЫ И ЗАПУСК СЕРВЕРА ---

/**
 * Вспомогательная функция для поиска заголовка
 */
function findHeader(headers, name) {
    const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : null;
}

// Запускаем сервер
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Visit http://localhost:${port} to start`);
    open(`http://localhost:${port}`); // Автоматически открываем браузер
});