// app.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { criarPagamentoPix, obterPagamento } from './services/mercadopago.js';
import { marcarFaturaPaga } from './lib/firestore.js';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ✅ Inicializa Firebase Admin
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

// 🧠 Middleware de autenticação Firebase
async function autenticarFirebase(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token ausente ou inválido' });
        }
        const token = authHeader.split('Bearer ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (error) {
        console.error('Erro de autenticação Firebase:', error);
        return res.status(401).json({ error: 'Não autorizado' });
    }
}

// Logs de requisição
app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
        console.log(`[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - t0}ms)`);
    });
    next();
});

// Healthcheck e variáveis
app.get('/health', (_req, res) => res.json({ ok: true, service: 'pix-api' }));

app.get('/env-check', (_req, res) => {
    res.json({
        mpToken: !!process.env.MERCADO_PAGO_ACCESS_TOKEN,
        projectId: !!process.env.FIREBASE_PROJECT_ID,
        clientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
        pk: !!process.env.FIREBASE_PRIVATE_KEY,
        webhookUrl: process.env.MP_WEBHOOK_URL || null,
    });
});

// Criar cobrança PIX (Handler)
async function handleCriarPix(req, res) {
    try {
        const {
            faturaId, descricao, valor, vencimentoISO,
            idempotencyKey, payerName, payerCpf, payerEmail, externalReference
        } = req.body || {};

        if (!faturaId || typeof valor !== 'number') {
            return res.status(400).json({ ok: false, msg: 'faturaId e valor (number) são obrigatórios' });
        }
        if (!payerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payerEmail))) {
            return res.status(400).json({ ok: false, msg: 'payerEmail obrigatório e válido' });
        }

        const p = await criarPagamentoPix({
            faturaId, descricao, valor, vencimentoISO, idempotencyKey,
            payerName, payerCpf, payerEmail, externalReference
        });

        return res.json({
            ok: true,
            faturaId,
            paymentId: p.paymentId,
            status: p.status,
            qr_copia_cola: p.qr_copia_cola,
            qr_base64: p.qr_base64,
        });
    } catch (e) {
        console.error('[/pix/criar] erro:', e.message);
        return res.status(400).json({ ok: false, msg: e.message });
    }
}

// 🛡️ Rotas protegidas
app.post('/pix/criar', autenticarFirebase, handleCriarPix);
app.post('/pix/gerar', autenticarFirebase, handleCriarPix);
app.post('/api/pix/gerar', autenticarFirebase, handleCriarPix);
app.post('/api/pix', autenticarFirebase, handleCriarPix);

// Consultar status manualmente (também protegido)
app.get('/pix/status/:paymentId', autenticarFirebase, async (req, res) => {
    try {
        const pay = await obterPagamento(req.params.paymentId);
        res.json({ ok: true, status: pay.status, detail: pay.status_detail, data: pay });
    } catch (e) {
        res.status(400).json({ ok: false, msg: e.message });
    }
});

// Webhook Mercado Pago (sem autenticação, é chamado pelo MP)
app.post('/webhook/mercadopago', async (req, res) => {
    try {
        const { type, data } = req.body || {};
        if (type === 'payment' && data?.id) {
            const pay = await obterPagamento(data.id);
            console.log('[webhook] payment', data.id, pay.status);

            if (pay.status === 'approved') {
                const valorPago = pay.transaction_amount;
                const faturaId =
                    pay.description?.replace('Fatura ', '') ||
                    pay.metadata?.faturaId ||
                    pay.external_reference;

                await marcarFaturaPaga({
                    faturaId,
                    paymentId: pay.id,
                    valorPago,
                    aprovadoEmISO: pay.date_approved,
                    raw: pay,
                });

                console.log('[webhook] fatura marcada como paga:', { faturaId, paymentId: pay.id, valorPago });
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('[/webhook/mercadopago] erro:', e.message);
        res.sendStatus(200);
    }
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ PIX API rodando na porta :${PORT}`));
