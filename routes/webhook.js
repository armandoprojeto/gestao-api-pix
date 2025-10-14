import express from "express";
import { getFirestore } from "firebase-admin/firestore";
import { obterPagamento } from "../services/mercadopago.js";

const router = express.Router();
const db = getFirestore();


// 🚨 Webhook Mercado Pago
router.post("/webhook/mercadopago", async (req, res) => {
    try {
        const { id, type } = req.body;

        if (type === "payment" && id) {
            // 📡 Consulta os detalhes do pagamento no Mercado Pago
            const pagamento = await obterPagamento(id);

            // 📎 Recupera o faturaId que foi salvo no metadata ou external_reference
            const faturaId = pagamento.metadata?.faturaId || pagamento.external_reference;

            if (pagamento.status === "approved" && faturaId) {
                // 💰 Atualiza a fatura no Firestore
                const faturaRef = db.collection("faturas").doc(faturaId);
                await faturaRef.update({
                    status: "pago",
                    pagoEm: new Date(),
                    mp_payment_id: id,
                });

                // 👤 Atualiza o usuário para liberar acesso
                const faturaSnap = await faturaRef.get();
                const { userId } = faturaSnap.data();

                if (userId) {
                    await db.collection("usuarios").doc(userId).update({
                        planoPago: true,
                        planoAtivoEm: new Date(),
                    });
                }

                console.log(`✅ Pagamento confirmado via MP! Fatura: ${faturaId}`);
            }
        }

        // ⚡ O MP exige resposta rápida
        res.sendStatus(200);
    } catch (err) {
        console.error("❌ Erro no webhook Mercado Pago:", err);
        res.sendStatus(500);
    }
});


// 🧭 Webhook PIX
router.post("/webhook/pix", async (req, res) => {
    try {
        const { txid, status } = req.body;

        console.log("📬 Webhook PIX recebido:", req.body);

        if (!txid) {
            return res.status(400).json({ error: "txid ausente" });
        }

        // 🔍 Busca fatura pelo txid
        const snapshot = await db.collection("faturas").where("txid", "==", txid).get();

        if (snapshot.empty) {
            console.log(`⚠️ Nenhuma fatura encontrada para txid ${txid}`);
            return res.status(200).send("OK (fatura não encontrada)");
        }

        const faturaDoc = snapshot.docs[0];
        const faturaId = faturaDoc.id;
        const faturaData = faturaDoc.data();

        if (status === "approved") {
            // ✅ Marca a fatura como paga
            await db.collection("faturas").doc(faturaId).update({
                status: "pago",
                pagoEm: new Date(),
                pixPaymentId: txid,
            });

            // 👤 Atualiza usuário vinculado
            if (faturaData.userId) {
                const vencimento = new Date();
                vencimento.setDate(vencimento.getDate() + 30); // exemplo: 30 dias de acesso

                await db.collection("usuarios").doc(faturaData.userId).update({
                    status: "pago",
                    plano: faturaData.plano,
                    dataPagamento: new Date(),
                    dataVencimento: vencimento,
                });
            }

            console.log(`✅ Pagamento PIX confirmado! Fatura: ${faturaId}`);
        } else {
            // Se cancelado, expirado, etc.
            await db.collection("faturas").doc(faturaId).update({
                status: status || "desconhecido",
                updatedAt: new Date(),
            });

            console.log(`ℹ️ Fatura ${faturaId} atualizada com status: ${status}`);
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("❌ Erro no webhook PIX:", err);
        res.sendStatus(500);
    }
});

export default router;
