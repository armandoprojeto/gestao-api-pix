// routes/webhook.js
import express from "express";
import admin from "firebase-admin";
import { obterPagamento } from "../services/mercadopago.js";

const router = express.Router();

/* =====================================================
   🧠 Lazy init do Firestore (só inicializa se precisar)
===================================================== */
function getDb() {
    if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        console.log("🔥 Firebase Admin inicializado (lazy)");
    }
    return admin.firestore();
}

/* =====================================================
   🧮 Função utilitária — calcular vencimento
===================================================== */
function calcularVencimento(plano) {
    const diasPorPlano = {
        Mensal: 30,
        Trimestral: 90,
        Semestral: 180,
        Anual: 365,
    };
    const dias = diasPorPlano[plano] || 30;
    const venc = new Date();
    venc.setDate(venc.getDate() + dias);
    return venc;
}

/* =====================================================
   💳 Webhook Mercado Pago
===================================================== */
router.post("/webhook/mercadopago", async (req, res) => {
    try {
        // ⚙️ Filtra chamadas de teste ou vazias
        if (!req.body || Object.keys(req.body).length === 0) {
            console.log("⚪ Webhook MP vazio, ignorado.");
            return res.sendStatus(200);
        }

        const { id, type } = req.body;

        if (type !== "payment" || !id) {
            console.log("⚪ Webhook MP sem dados relevantes, ignorado.");
            return res.sendStatus(200);
        }

        // 🔍 Consulta os detalhes do pagamento
        const pagamento = await obterPagamento(id);
        const faturaId = pagamento.metadata?.faturaId || pagamento.external_reference;

        if (pagamento.status !== "approved" || !faturaId) {
            console.log(`ℹ️ Pagamento não aprovado (${pagamento.status}) ou sem faturaId.`);
            return res.sendStatus(200);
        }

        // ⚙️ Inicializa Firestore só agora
        const db = getDb();

        const faturaRef = db.collection("faturas").doc(faturaId);
        const faturaSnap = await faturaRef.get();

        // 🚫 Evita retrabalho em fatura já paga
        if (faturaSnap.exists && faturaSnap.data()?.status === "pago") {
            console.log(`⚪ Fatura ${faturaId} já processada, ignorando retry.`);
            return res.sendStatus(200);
        }

        // ✅ Atualiza fatura
        await faturaRef.set(
            {
                status: "pago",
                pagoEm: new Date(),
                mp_payment_id: id,
            },
            { merge: true }
        );

        // 👤 Atualiza usuário vinculado
        const faturaData = faturaSnap.data();
        if (faturaData?.userId) {
            const vencimento = calcularVencimento(faturaData.plano);
            await db
                .collection("usuarios")
                .doc(faturaData.userId)
                .set(
                    {
                        status: "pago",
                        plano: faturaData.plano,
                        valorPlano: faturaData.valor,
                        dataPagamento: new Date(),
                        dataVencimento: vencimento,
                    },
                    { merge: true }
                );
        }

        console.log(`✅ Pagamento confirmado via Mercado Pago! Fatura: ${faturaId}`);
        res.sendStatus(200);
    } catch (err) {
        console.error("❌ Erro no webhook Mercado Pago:", err.message);
        res.sendStatus(200); // MP só precisa de 200 pra parar retry
    }
});

/* =====================================================
   💰 Webhook PIX
===================================================== */
router.post("/webhook/pix", async (req, res) => {
    try {
        // Ignora chamadas vazias
        if (!req.body || Object.keys(req.body).length === 0) {
            console.log("⚪ Webhook PIX vazio, ignorado.");
            return res.sendStatus(200);
        }

        const { txid, status } = req.body;
        if (!txid) {
            console.log("⚠️ Webhook PIX sem txid, ignorado.");
            return res.sendStatus(200);
        }

        console.log("📬 Webhook PIX recebido:", req.body);

        const db = getDb();
        const snapshot = await db.collection("faturas").where("txid", "==", txid).get();

        if (snapshot.empty) {
            console.log(`⚠️ Nenhuma fatura encontrada para txid ${txid}`);
            return res.sendStatus(200);
        }

        const faturaDoc = snapshot.docs[0];
        const faturaId = faturaDoc.id;
        const faturaData = faturaDoc.data();

        if (status === "approved") {
            // ✅ Marca fatura como paga
            await db.collection("faturas").doc(faturaId).set(
                {
                    status: "pago",
                    pagoEm: new Date(),
                    pixPaymentId: txid,
                },
                { merge: true }
            );

            // 👤 Atualiza usuário vinculado
            if (faturaData.userId) {
                const vencimento = calcularVencimento(faturaData.plano);
                await db.collection("usuarios").doc(faturaData.userId).set(
                    {
                        status: "pago",
                        plano: faturaData.plano,
                        valorPlano: faturaData.valor,
                        dataPagamento: new Date(),
                        dataVencimento: vencimento,
                    },
                    { merge: true }
                );
            }

            console.log(`✅ Pagamento PIX confirmado! Fatura: ${faturaId}`);
        } else {
            await db.collection("faturas").doc(faturaId).set(
                {
                    status: status || "desconhecido",
                    updatedAt: new Date(),
                },
                { merge: true }
            );

            console.log(`ℹ️ Fatura ${faturaId} atualizada com status: ${status}`);
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("❌ Erro no webhook PIX:", err.message);
        res.sendStatus(200);
    }
});

export default router;
