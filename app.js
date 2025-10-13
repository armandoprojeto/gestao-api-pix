// app.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { criarPagamentoPix, obterPagamento } from './services/mercadopago.js';
import { marcarFaturaPaga } from './lib/firestore.js';

//
// 🟡 Inicializa Firebase Admin com segurança
//
let serviceAccount;
try {
    if (!process.env.FIREBASE_ADMIN_KEY) {
        throw new Error('FIREBASE_ADMIN_KEY ausente nas variáveis de ambiente.');
    }
    serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase Admin inicializado com sucesso.');
} catch (err) {
    console.error('❌ Erro ao inicializar Firebase Admin:', err.message);
    process.exit(1);
}

//
// 🌐 Configuração do Express + CORS
//
const app = express();

const allowedOrigins = [
    'http://localhost:3000',
    'https://gestaobancar.vercel.app',
];

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                console.log('🚫 CORS bloqueado para:', origin);
                callback(new Error('CORS não permitido'));
            }
        },
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    })
);

app.options('*', cors());
app.use(express.json());

//
// 🌐 Log da origem para debug
//
app.use((req, _res, next) => {
    console.log('🌐 Origem da requisição:', req.headers.origin);
    next();
});

//
// 📝 Logs de requisição
//
app.use((req, res, next) => {
    const inicio = Date.now();
    res.on('finish', () => {
        console.log(`[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - inicio}ms)`);
    });
    next();
});

//
// 🛡️ Middleware de autenticação Firebase
//
async function autenticarFirebase(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ ok: false, msg: 'Token ausente ou inválido' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (e) {
        console.error('[auth error]', e.message);
        return res.status(401).json({ ok: false, msg: 'Token inválido ou expirado' });
    }
}

//
// 🌡️ Healthcheck
//
app.get('/health', (_req, res) => res.json({ ok: true, service: 'pix-api' }));

//
// 🧪 Debug do ambiente
//
app.get('/env-check', (_req, res) => {
    res.json({
        mpToken: !!process.env.MERCADO_PAGO_ACCESS_TOKEN,
        firebaseKey: !!process.env.FIREBASE_ADMIN_KEY,
        webhookUrl: process.env.MP_WEBHOOK_URL || null,
    });
});

//
// 💳 Criar cobrança Pix (protegido)
//
app.post('/api/pix', autenticarFirebase, async (req, res) => {
    try {
        const { faturaId, descricao, valor, payerName, payerCpf, payerEmail } = req.body || {};

        if (!faturaId || typeof valor !== 'number') {
            return res.status(400).json({ ok: false, msg: 'faturaId e valor numérico são obrigatórios' });
        }

        const uid = req.user.uid;
        console.log('💰 Criando cobrança para UID:', uid);

        const pagamento = await criarPagamentoPix({
            faturaId,
            descricao,
            valor,
            payerName,
            payerCpf,
            payerEmail,
        });

        return res.json({
            ok: true,
            faturaId,
            paymentId: pagamento.paymentId,
            status: pagamento.status,
            qr_copia_cola: pagamento.qr_copia_cola,
            qr_base64: pagamento.qr_base64,
        });
    } catch (e) {
        console.error('[/api/pix] erro:', e.message);
        return res.status(400).json({ ok: false, msg: e.message });
    }
});

//
// 🔀 Rota alternativa /pix (sem /api) — compatibilidade com front antigo
//
app.post('/pix', autenticarFirebase, (req, res) => {
    req.url = '/api/pix';
    app._router.handle(req, res);
});

//
// 📡 Consultar status (protegido)
//
app.get('/pix/status/:paymentId', autenticarFirebase, async (req, res) => {
    try {
        const pay = await obterPagamento(req.params.paymentId);
        res.json({ ok: true, status: pay.status, detail: pay.status_detail, data: pay });
    } catch (e) {
        res.status(400).json({ ok: false, msg: e.message });
    }
});

//
// 🌐 Webhook Mercado Pago (sem autenticação — chamado pelo MP)
//
app.post('/webhook/mercadopago', async (req, res) => {
    try {
        const { type, data } = req.body || {};
        if (type === 'payment' && data?.id) {
            const pay = await obterPagamento(data.id);
            console.log('[webhook] pagamento recebido:', data.id, pay.status);

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

                console.log('[webhook] ✅ Fatura marcada como paga:', faturaId);
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('[webhook] erro:', e.message);
        res.sendStatus(200);
    }
});

//
// 🚀 Start Server
//
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ PIX API rodando na porta ${PORT}`));
