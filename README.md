# Sistema de Upsell com JWT - Visionpay

Sistema completo de upsell de 1 clique usando JWT para autenticação segura.

## 🚀 Como Funciona

### 1. Fluxo Principal
1. Cliente faz compra principal no checkout
2. Backend gera JWT com dados do cliente
3. Cliente é redirecionado para página de upsell com token
4. Na página de upsell, cliente só clica "Aceitar"
5. Sistema processa automaticamente usando dados do JWT
6. Push USSD aparece para confirmar PIN

### 2. Funil de 3 Upsells
- **Upsell 1**: 349 MZN - Curso avançado
- **Upsell 2**: 250 MZN - Pacote premium  
- **Upsell 3**: 149 MZN - Acesso básico premium

## 📦 Instalação

```bash
# Instalar dependências
npm install

# Configurar variáveis de ambiente
cp .env.example .env
# Edite o .env com suas credenciais

# Iniciar servidor
npm start
```

## 🔧 Configuração

### 1. Backend
- Adicione `JWT_SECRET` forte no `.env`
- Configure suas credenciais da E2Payments
- Configure Firebase para armazenamento

### 2. Frontend - Checkout Principal
- Use `checkout-principal.html` como base
- Após compra bem-sucedida, cliente é redirecionado automaticamente

### 3. Páginas de Upsell
- `upsell1.html` - Primeira oferta
- `upsell2.html` - Segunda oferta  
- `upsell3.html` - Oferta final

## 🎯 Implementação nas Suas Páginas

### Opção 1: Páginas Completas
Copie os arquivos `upsell1.html`, `upsell2.html`, `upsell3.html` para seu servidor.

### Opção 2: Widget Incorporado
```html
<!-- Em qualquer página HTML -->
<div id="upsell-container"></div>
<script src="upsell-widget.js"></script>
```

### Opção 3: Inicialização Manual
```javascript
// Inicializar widget manualmente
const widget = new UpsellWidget({
    apiUrl: 'https://seu-backend.com',
    upsellLevel: 1 // 1, 2 ou 3
});
```

## 🔒 Segurança

- **JWT com expiração**: Tokens expiram em 30 minutos
- **Validação de transação**: Verifica se compra principal existe
- **Prevenção de reuso**: Cada upsell só pode ser processado uma vez
- **Chave secreta**: JWT assinado com chave secreta forte

## 📊 Monitoramento

### Coleções Firebase Criadas:
- `compras` - Compras principais
- `upsell1_compras` - Upsells nível 1
- `upsell2_compras` - Upsells nível 2  
- `upsell3_compras` - Upsells nível 3
- `transacoes_falhadas` - Falhas de pagamento

### Endpoints da API:
- `POST /api/pagar` - Checkout principal
- `POST /api/upsell1` - Processar upsell 1
- `POST /api/upsell2` - Processar upsell 2
- `POST /api/upsell3` - Processar upsell 3
- `POST /api/validate-token` - Validar token (debug)

## 🎨 Personalização

### Modificar Ofertas:
Edite o objeto `upsellConfig` em `upsell-widget.js`:

```javascript
this.upsellConfig = {
    1: {
        titulo: 'Seu Título',
        descricao: 'Sua descrição',
        preco: 'XXX MZN',
        beneficios: ['✅ Benefício 1', '✅ Benefício 2']
    }
};
```

### Modificar Valores:
Edite os valores em `server.js` nas funções de upsell:

```javascript
amount: 349, // Altere aqui
```

## 🚨 Importante

1. **Mude o JWT_SECRET** em produção
2. **Configure HTTPS** para produção
3. **Teste todos os fluxos** antes de usar
4. **Monitore logs** para debugar problemas

## 📞 Suporte

Para dúvidas sobre implementação, verifique os logs do servidor e do navegador.