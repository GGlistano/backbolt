require('dotenv').config(); // local dev; no Railway ignora

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

/* ---------------------------------------------
   Firebase Admin
----------------------------------------------*/
const admin = require('firebase-admin');

// Configuração do Firebase Admin
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
} catch (error) {
  console.error('❌ Erro ao carregar credenciais do Firebase:', error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();

/* ---------------------------------------------
   Express Setup
----------------------------------------------*/
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Chave secreta para JWT (adicione no seu .env)
const JWT_SECRET = process.env.JWT_SECRET || 'sua-chave-secreta-super-forte-aqui';

// Debug rápido de envs críticos (não loga secretos!)
console.log('🔧 CLIENT_ID:', process.env.CLIENT_ID ? 'OK' : 'MISSING');
console.log('🔧 E2_BASE_URL:', process.env.E2_BASE_URL || 'MISSING');
console.log('🔧 MPESA_WALLET_ID:', process.env.MPESA_WALLET_ID ? 'OK' : 'MISSING');
console.log('🔧 EMOLA_WALLET_ID:', process.env.EMOLA_WALLET_ID ? 'OK' : 'MISSING');

/* ---------------------------------------------
   Nodemailer Setup
----------------------------------------------*/
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/* ---------------------------------------------
   Utilitários
----------------------------------------------*/
function formatPhoneNumber(n) {
  if (!n) return '';
  n = n.toString().replace(/\D/g, '');
  return n.startsWith('+') ? n : `+${n}`;
}

/* ---------------------------------------------
   JWT Utils para Upsell
----------------------------------------------*/
function gerarUpsellToken(dadosCliente) {
  const payload = {
    msisdn: dadosCliente.phone,
    method: dadosCliente.metodo,
    email: dadosCliente.email,
    nome: dadosCliente.nome,
    whatsapp: dadosCliente.whatsapp,
    parentTxn: dadosCliente.reference,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (30 * 60) // 30 minutos
  };
  
  return jwt.sign(payload, JWT_SECRET);
}

function validarUpsellToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw new Error('Token inválido ou expirado');
  }
}

async function verificarTransacaoPrincipal(parentTxn) {
  try {
    const snapshot = await db.collection('compras')
      .where('reference', '==', parentTxn)
      .get();
    
    return !snapshot.empty;
  } catch (error) {
    console.error('Erro ao verificar transação principal:', error);
    return false;
  }
}

async function verificarUpsellJaProcessado(parentTxn, upsellLevel) {
  try {
    const colecao = `upsell${upsellLevel}_compras`;
    const snapshot = await db.collection(colecao)
      .where('parentTxn', '==', parentTxn)
      .get();
    
    return !snapshot.empty;
  } catch (error) {
    console.error('Erro ao verificar upsell processado:', error);
    return false;
  }
}

/* ---------------------------------------------
   Rota Principal de Compra
----------------------------------------------*/
app.post('/api/comprar', async (req, res) => {
  const { phone, metodo, email, nome: nomeCliente, whatsapp } = req.body;

  // validações básicas
  if (!phone || !metodo || !email) {
    return res.status(400).json({ status: 'error', message: 'Campos obrigatórios: phone, metodo, email' });
  }

  if (!['mpesa', 'emola'].includes(metodo)) {
    return res.status(400).json({ status: 'error', message: 'Método deve ser mpesa ou emola' });
  }

  try {
    // 1) determinar wallet e token
    let walletId, token;
    if (metodo === 'mpesa') {
      walletId = process.env.MPESA_WALLET_ID;
      token = process.env.MPESA_TOKEN;
    } else {
      walletId = process.env.EMOLA_WALLET_ID;
      token = process.env.EMOLA_TOKEN;
    }

    if (!walletId || !token) {
      return res.status(500).json({ status: 'error', message: `Configuração ${metodo} não encontrada` });
    }

    // 2) gerar referência única
    const reference = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // 3) URL da API externa
    const url = `${process.env.E2_BASE_URL}/v1/c2b/${metodo}-payment/${walletId}`;

    // 4) chamada para API externa de pagamento
    const response = await axios.post(
      url,
      {
        client_id: process.env.CLIENT_ID,
        amount: '99',
        phone,
        reference,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      }
    );

    // 5) salvar compra no Firebase
    await db.collection('compras').add({
      nome: nomeCliente || '',
      email,
      phone,
      whatsapp: whatsapp || '',
      metodo,
      amount: 99,
      reference,
      created_at: new Date(),
    });

    // 6) enviar email de confirmação
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Confirmação de Compra - Ebook Receitas',
      html: `
        <h2>Obrigado pela sua compra!</h2>
        <p>Olá ${nomeCliente || 'Cliente'},</p>
        <p>Sua compra foi processada com sucesso.</p>
        <p><strong>Referência:</strong> ${reference}</p>
        <p><strong>Valor:</strong> 99 MT</p>
        <p><strong>Método:</strong> ${metodo.toUpperCase()}</p>
        <p>Em breve você receberá o link para download do seu ebook.</p>
        <br>
        <p>Atenciosamente,<br>Equipe Receitas</p>
      `
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log('✅ Email enviado para:', email);
    } catch (emailError) {
      console.error('❌ Erro ao enviar email:', emailError.message);
    }

    // 7) log de sucesso
    console.log('✅ Compra processada:', {
      reference,
      phone,
      email,
      metodo,
      amount: 99
    });

    // 8) resposta final ÚNICA
    // Gerar token de upsell após compra bem-sucedida
    const upsellToken = gerarUpsellToken({
      phone, metodo, email, nome: nomeCliente, whatsapp, reference
    });
    
    return res.json({ 
      status: 'ok', 
      data: response.data,
      upsellToken: upsellToken,
      redirectUrl: `https://seudominio.com/upsell1?token=${upsellToken}`
    });

  } catch (err) {
    console.error('❌ Erro na compra:', err.message);
    
    // Se for erro da API externa, retorna detalhes
    if (err.response) {
      return res.status(err.response.status).json({
        status: 'error',
        message: 'Erro no processamento do pagamento',
        details: err.response.data
      });
    }
    
    // Erro genérico
    return res.status(500).json({
      status: 'error',
      message: 'Erro interno do servidor'
    });
  }
});

/* ---------------------------------------------
   Função genérica: processarUpsell (ATUALIZADA)
----------------------------------------------*/
async function processarUpsell({ dadosToken, amount, upsellLevel, novaReference }) {
  const { msisdn: phone, method: metodo, email, nome, whatsapp } = dadosToken;
  
  let walletId, authToken;
  if (metodo === 'mpesa') {
    walletId = process.env.MPESA_WALLET_ID;
    authToken = process.env.MPESA_TOKEN;
  } else if (metodo === 'emola') {
    walletId = process.env.EMOLA_WALLET_ID;
    authToken = process.env.EMOLA_TOKEN;
  } else {
    throw new Error('Método inválido. Use mpesa ou emola.');
  }

  const url = `https://mpesaemolatech.com/v1/c2b/${metodo}-payment/${walletId}`;

  // chamada para API externa de pagamento
  const response = await axios.post(
    url,
    {
      client_id: process.env.CLIENT_ID,
      amount: amount.toString(),
      phone,
      reference: novaReference,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
    }
  );

  // salva compra no Firebase
  const colecao = `upsell${upsellLevel}_compras`;
  await db.collection(colecao).add({
    nome,
    email,
    phone,
    whatsapp: whatsapp || '',
    metodo,
    amount,
    reference: novaReference,
    parentTxn: dadosToken.parentTxn,
    created_at: new Date(),
  });

  // Gerar próximo token de upsell se não for o último
  let proximoToken = null;
  if (upsellLevel < 3) {
    proximoToken = gerarUpsellToken({
      phone, metodo, email, nome, whatsapp, 
      reference: dadosToken.parentTxn // mantém referência original
    });
  }

  return { 
    paymentData: response.data,
    proximoToken,
    proximoUpsell: upsellLevel < 3 ? upsellLevel + 1 : null
  };
}

/* ---------------------------------------------
   Rotas de Upsell (ATUALIZADAS COM JWT)
----------------------------------------------*/
app.post('/api/upsell1', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ status: 'error', message: 'Token de upsell obrigatório' });
  }
  
  try {
    // Validar token
    const dadosToken = validarUpsellToken(token);
    
    // Verificar se transação principal existe
    const transacaoValida = await verificarTransacaoPrincipal(dadosToken.parentTxn);
    if (!transacaoValida) {
      return res.status(400).json({ status: 'error', message: 'Transação principal não encontrada' });
    }
    
    // Verificar se upsell já foi processado
    const jaProcessado = await verificarUpsellJaProcessado(dadosToken.parentTxn, 1);
    if (jaProcessado) {
      return res.status(400).json({ status: 'error', message: 'Upsell 1 já foi processado' });
    }
    
    const resultado = await processarUpsell({
      dadosToken,
      amount: 349,
      upsellLevel: 1,
      novaReference: `UPSELL1-${dadosToken.parentTxn}-${Date.now()}`
    });
    
    const response = { 
      status: 'ok', 
      data: resultado.paymentData 
    };
    
    // Adicionar próximo upsell se existir
    if (resultado.proximoToken) {
      response.proximoUpsellToken = resultado.proximoToken;
      response.proximoUpsellUrl = `https://seudominio.com/upsell${resultado.proximoUpsell}?token=${resultado.proximoToken}`;
    }
    
    res.json(response);
  } catch (err) {
    console.error('❌ Erro no upsell1:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/upsell2', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ status: 'error', message: 'Token de upsell obrigatório' });
  }
  
  try {
    const dadosToken = validarUpsellToken(token);
    
    const transacaoValida = await verificarTransacaoPrincipal(dadosToken.parentTxn);
    if (!transacaoValida) {
      return res.status(400).json({ status: 'error', message: 'Transação principal não encontrada' });
    }
    
    const jaProcessado = await verificarUpsellJaProcessado(dadosToken.parentTxn, 2);
    if (jaProcessado) {
      return res.status(400).json({ status: 'error', message: 'Upsell 2 já foi processado' });
    }
    
    const resultado = await processarUpsell({
      dadosToken,
      amount: 250,
      upsellLevel: 2,
      novaReference: `UPSELL2-${dadosToken.parentTxn}-${Date.now()}`
    });
    
    const response = { 
      status: 'ok', 
      data: resultado.paymentData 
    };
    
    if (resultado.proximoToken) {
      response.proximoUpsellToken = resultado.proximoToken;
      response.proximoUpsellUrl = `https://seudominio.com/upsell${resultado.proximoUpsell}?token=${resultado.proximoToken}`;
    }
    
    res.json(response);
  } catch (err) {
    console.error('❌ Erro no upsell2:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/upsell3', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ status: 'error', message: 'Token de upsell obrigatório' });
  }
  
  try {
    const dadosToken = validarUpsellToken(token);
    
    const transacaoValida = await verificarTransacaoPrincipal(dadosToken.parentTxn);
    if (!transacaoValida) {
      return res.status(400).json({ status: 'error', message: 'Transação principal não encontrada' });
    }
    
    const jaProcessado = await verificarUpsellJaProcessado(dadosToken.parentTxn, 3);
    if (jaProcessado) {
      return res.status(400).json({ status: 'error', message: 'Upsell 3 já foi processado' });
    }
    
    const resultado = await processarUpsell({
      dadosToken,
      amount: 149,
      upsellLevel: 3,
      novaReference: `UPSELL3-${dadosToken.parentTxn}-${Date.now()}`
    });
    
    // Último upsell - não há próximo
    res.json({ 
      status: 'ok', 
      data: resultado.paymentData,
      finalUpsell: true 
    });
  } catch (err) {
    console.error('❌ Erro no upsell3:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* ---------------------------------------------
   Rota para validar token (opcional - para debug)
----------------------------------------------*/
app.post('/api/validate-token', async (req, res) => {
  const { token } = req.body;
  
  try {
    const dadosToken = validarUpsellToken(token);
    const transacaoValida = await verificarTransacaoPrincipal(dadosToken.parentTxn);
    
    res.json({
      status: 'ok',
      valid: true,
      dados: dadosToken,
      transacaoValida
    });
  } catch (err) {
    res.json({
      status: 'error',
      valid: false,
      message: err.message
    });
  }
});

/* ---------------------------------------------
   Start
----------------------------------------------*/
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
