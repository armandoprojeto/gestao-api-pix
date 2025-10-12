import express from "express";
import { getFirestore } from "firebase-admin/firestore";
import { obterPagamento } from "../services/mercadopago.js";

const router = express.Router();
const db = getFirestore();

// 🚨 Endpoint para receber notificações do Mercado Pago
router.post("/webhook/mercadopago", async (req, res) => {
    try {
        const { id, type } = req.body;

        if (type === "payment" && id) {
            // Consulta os detalhes do pagamento no MP
            const pagamento = await obterPagamento(id);

            // Pega o faturaId que você colocou no metadata ou external_reference
            const faturaId = pagamento.metadata?.faturaId || pagamento.external_reference;

            if (pagamento.status === "approved" && faturaId) {
                // Marca a fatura como paga no Firestore
                const faturaRef = db.collection("faturas").doc(faturaId);
                await faturaRef.update({
                    status: "pago",
                    pagoEm: new Date(),
                    mp_payment_id: id,
                });

                // Atualiza o usuário para liberar acesso
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

        // ⚡ MP exige resposta rápida (200 OK)
        res.sendStatus(200);

    } catch (err) {
        console.error("Erro no webhook Mercado Pago:", err);
        res.sendStatus(500);
    }
});

export default router;
