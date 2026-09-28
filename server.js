const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const rootDirectory = __dirname;
const dataDirectory = process.env.DATA_DIR || path.join(rootDirectory, 'data');
const stateFile = path.join(dataDirectory, 'state.json');
const port = Number(process.env.PORT) || 3000;
const dashboardUser = process.env.DASHBOARD_USER || 'teacher';
const dashboardPassword = process.env.DASHBOARD_PASSWORD || 'local-preview-only-2026';
const clients = new Set();
let state = null;
let revision = 0;
let writeQueue = Promise.resolve();

const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
};

function sendJson(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
}

function matchesCredential(provided, expected) {
    const providedHash = crypto.createHash('sha256').update(provided).digest();
    const expectedHash = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(providedHash, expectedHash);
}

function isAuthorized(request) {
    const authorization = request.headers.authorization || '';
    if (!authorization.startsWith('Basic ')) return false;
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator !== -1 && matchesCredential(decoded.slice(0, separator), dashboardUser) &&
        matchesCredential(decoded.slice(separator + 1), dashboardPassword);
}

function broadcast(clientId) {
    const message = `data: ${JSON.stringify({ state, revision, clientId })}\n\n`;
    for (const client of clients) client.write(message);
}

async function readRequestBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
    }
}

async function serveStatic(request, response, pathname) {
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(pathname);
    } catch {
        response.writeHead(400).end('Bad request');
        return;
    }

    const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
    const filePath = path.resolve(rootDirectory, `.${requestedPath}`);
    if (!filePath.startsWith(`${rootDirectory}${path.sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
    }

    try {
        const content = await fs.readFile(filePath);
        response.writeHead(200, {
            'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
        response.writeHead(404).end('Not found');
    }
}

async function handleRequest(request, response) {
    if (!isAuthorized(request)) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ESL Teacher Dashboard", charset="UTF-8"' });
        response.end('Authentication required');
        return;
    }

    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (url.pathname === '/api/state' && request.method === 'GET') {
        sendJson(response, 200, { state, revision });
        return;
    }

    if (url.pathname === '/api/state' && request.method === 'PUT') {
        const expectedRevision = Number(request.headers['if-match']);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            sendJson(response, 428, { error: 'A valid If-Match revision is required.', state, revision });
            return;
        }

        let nextState;
        try {
            nextState = await readRequestBody(request);
        } catch (error) {
            sendJson(response, error.status || 400, { error: error.message });
            return;
        }
        if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
            sendJson(response, 400, { error: 'State must be a JSON object.' });
            return;
        }

        const operation = writeQueue.then(async () => {
            if (expectedRevision !== revision) {
                sendJson(response, 409, { error: 'State has changed on the server.', state, revision });
                return;
            }

            const nextRevision = revision + 1;
            await fs.mkdir(dataDirectory, { recursive: true });
            const temporaryFile = `${stateFile}.${process.pid}.tmp`;
            await fs.writeFile(temporaryFile, JSON.stringify({ state: nextState, revision: nextRevision }), 'utf8');
            await fs.rename(temporaryFile, stateFile);

            state = nextState;
            revision = nextRevision;
            sendJson(response, 200, { state, revision });
            broadcast(request.headers['x-client-id'] || null);
        });
        writeQueue = operation.catch(() => {});
        try {
            await operation;
        } catch (error) {
            if (!response.headersSent) sendJson(response, 500, { error: 'Could not persist state.' });
            console.error('State persistence failed:', error);
        }
        return;
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
        response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
        });
        response.write(': connected\n\n');
        clients.add(response);
        const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 25000);
        heartbeat.unref();
        response.on('close', () => {
            clearInterval(heartbeat);
            clients.delete(response);
        });
        return;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
        await serveStatic(request, response, url.pathname);
        return;
    }

    sendJson(response, 405, { error: 'Method not allowed.' });
}

async function start() {
    try {
        const stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        state = stored.state;
        revision = Number.isSafeInteger(stored.revision) ? stored.revision : 0;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const server = http.createServer((request, response) => {
        handleRequest(request, response).catch(error => {
            console.error('Request failed:', error);
            if (!response.headersSent) sendJson(response, 500, { error: 'Internal server error.' });
            else response.destroy();
        });
    });
    server.listen(port, () => console.log(`Dashboard listening on http://localhost:${port}`));
}

start().catch(error => {
    console.error('Could not load persisted state:', error);
    process.exitCode = 1;
});