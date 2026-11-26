/* =========================================================
   UBMeal — lógica da aplicação (JavaScript puro)
   Estrutura:
   0. firebase         1. dados            2. estado + memória
   3. utilidades       4. telas (render)   5. carrinho
   6. pagamento/pix    7. conta (modais)   8. eventos   9. início
   ========================================================= */

/* ---------------------------------------------------------
   0. FIREBASE
   --------------------------------------------------------- */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBn5WErftcNsjl7xe1MVCPHDsPCiwXgJ-M",
  authDomain: "ubmeal-3cf8a.firebaseapp.com",
  projectId: "ubmeal-3cf8a",
  storageBucket: "ubmeal-3cf8a.firebasestorage.app",
  messagingSenderId: "200471380368",
  appId: "1:200471380368:web:96fb8d1579cc822797f315"
};

let fbAuth = null;
let fbDb = null;
let fbPronto = false;
let nuvemOk = false;        // só grava na nuvem depois de LER a nuvem com sucesso
let entrando = false;       // evita abrir dois popups do Google
let authResolvido = false;  // o Firebase já disse se existe sessão salva?

function iniciarFirebase() {
  if (!window.firebase || !FIREBASE_CONFIG.apiKey) {
    const el = document.getElementById('avisoDemo');
    if (el) el.hidden = false;
    return;
  }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    fbPronto = true;
    renderBotaoLogin();
    fbAuth.onAuthStateChanged(aoMudarLogin);
    /* quem entrou por redirecionamento (celular / popup bloqueado) volta para cá;
       sem isso, um erro no redirecionamento passava em silêncio */
    fbAuth.getRedirectResult().catch(tratarErroLogin);
  } catch (e) {
    console.error('Firebase não iniciou:', e);
    fbPronto = false;
  }
}

/* apaga os dados de conta guardados neste aparelho */
function zerarDadosLocais() {
  pararDeOuvirPedido();
  pararDeOuvirConta();
  estado.nome = ''; estado.email = '';
  estado.foto = ''; estado.fotoGoogle = ''; estado.fotoEm = 0;
  estado.tipo = null; estado.telefone = ''; estado.filho = '';
  estado.carrinho = []; estado.pedido = null; estado.pago = false; estado.pedidoPronto = false;
  estado.historico = []; estado.saldo = SALDO_INICIAL; estado.recargasPendentes = [];
  estado.senhaPag = null; estado.senhaEm = 0; estado.cartoes = [];
  estado.notif = { promo: false, pronto: false };
}

/* chamado sozinho quando o usuário entra ou sai */
function aoMudarLogin(user) {
  authResolvido = true;
  entrando = false;
  renderBotaoLogin();

  if (!user) {
    nuvemOk = false;
    pararDeOuvirPedido();
    pararDeOuvirConta();
    if (estado.tela !== 'login') irPara('login');
    return;
  }

  /* o que está salvo aqui é de outra conta (ou do modo demonstração): descarta */
  if (estado.uid !== user.uid) zerarDadosLocais();

  estado.uid = user.uid;
  estado.nome = user.displayName || estado.nome;   // o nome salvo na nuvem tem prioridade (ver carregarNuvem)
  estado.email = user.email || '';
  estado.fotoGoogle = user.photoURL || '';

  carregarNuvem().then(leu => {
    nuvemOk = leu;
    if (!leu) aviso('Sem conexão com a nuvem · seus dados não serão gravados agora');
    if (!estado.foto) estado.foto = estado.fotoGoogle;   // primeira vez: usa a do Google
    limparCarrinho();
    salvar();
    renderTipos();
    renderBarraCarrinho();
    irPara(estado.tipo ? 'home' : 'perfil');
    if (leu) ouvirConta();                              // saldo e recargas em tempo real
    return carregarPedidoAtivo();
  }).then(() => {
    renderIndicadorPedido();
    if (estado.tela === 'pedidos') renderPedidos();
  });
}

/* lê o documento do usuário em usuarios/{uid}.
   Devolve true se a leitura deu certo (mesmo que o documento ainda não exista)
   e false se falhou — nesse caso NÃO gravamos nada, senão os valores zerados
   deste aparelho apagariam o saldo e o histórico guardados na nuvem. */
function carregarNuvem() {
  if (!fbPronto || !estado.uid) return Promise.resolve(false);
  return fbDb.collection('usuarios').doc(estado.uid).get()
    .then(doc => {
      if (!doc.exists) return true;                  // conta nova: pode gravar
      const d = doc.data() || {};
      if (d.nome) estado.nome = d.nome;          // nome escolhido pela pessoa vence o do Google
      if (d.tipo) estado.tipo = d.tipo;
      if (d.telefone) estado.telefone = d.telefone;
      if (d.filho) estado.filho = d.filho;
      if (d.foto) estado.foto = d.foto;
      if (typeof d.fotoEm === 'number') estado.fotoEm = d.fotoEm;
      /* saldo em centavos. O campo antigo "saldo" (em reais, que o próprio aluno
         conseguia alterar) não é mais lido: ver "Estrutura do banco" no manual */
      estado.saldo = Number.isInteger(d.saldoCentavos) ? d.saldoCentavos : 0;
      if (typeof d.senhaPag === 'string') estado.senhaPag = d.senhaPag;
      if (typeof d.senhaEm === 'number') estado.senhaEm = d.senhaEm;
      if (Array.isArray(d.cartoes)) estado.cartoes = d.cartoes;
      if (Array.isArray(d.carrinho)) estado.carrinho = d.carrinho;
      if (Array.isArray(d.historico)) estado.historico = normalizarHistorico(d.historico);
      if (d.notif) estado.notif = { promo: !!d.notif.promo, pronto: !!d.notif.pronto };
      /* o pedido em andamento agora mora na coleção "pedidos" (ver carregarPedidoAtivo) */
      return true;
    })
    .catch(e => { console.error('Não deu para ler a nuvem:', e); return false; });
}

/* grava no Firestore com uma pausa, para não escrever a cada clique.
   O saldo NÃO vai aqui: ele só muda no mesmo lote que cria um pedido pago
   com saldo (criarPedidoNuvem) ou quando a cantina confere uma recarga.
   As regras recusam qualquer outra gravação do saldo. */
let nuvemTimer;
function salvarNuvem() {
  if (!fbPronto || !estado.uid || !nuvemOk) return;
  clearTimeout(nuvemTimer);
  nuvemTimer = setTimeout(() => {
    const apagar = firebase.firestore.FieldValue.delete();
    const dados = {
      nome: estado.nome,
      email: estado.email,
      tipo: estado.tipo,
      telefone: estado.telefone,
      filho: estado.filho,
      foto: estado.foto,
      fotoEm: estado.fotoEm,
      senhaPag: estado.senhaPag,
      senhaEm: estado.senhaEm,
      cartoes: estado.cartoes,
      carrinho: estado.carrinho,
      historico: estado.historico,
      notif: estado.notif,
      /* campos da versão antiga: o pedido saiu daqui e foi para "pedidos" */
      pedido: apagar,
      pago: apagar,
      pedidoPronto: apagar,
      atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
    };
    fbDb.collection('usuarios').doc(estado.uid).set(dados, { merge: true })
      .catch(e => console.error('Não deu para gravar na nuvem:', e));
  }, 700);
}

/* --- saldo e recargas em tempo real ---
   O saldo só sobe quando a cantina confere uma recarga (conferirRecarga),
   então a tela escuta o documento da conta e as recargas em conferência. */
let pararConta = null;
let pararRecargas = null;
function pararDeOuvirConta() {
  if (pararConta) { pararConta(); pararConta = null; }
  if (pararRecargas) { pararRecargas(); pararRecargas = null; }
}
function ouvirConta() {
  pararDeOuvirConta();
  if (!fbPronto || !estado.uid) return;
  pararConta = fbDb.collection('usuarios').doc(estado.uid).onSnapshot(
    snap => {
      if (!snap.exists) return;
      const s = snap.data().saldoCentavos;
      const novo = Number.isInteger(s) ? s : 0;
      if (novo === estado.saldo) return;
      const subiu = novo > estado.saldo;
      estado.saldo = novo;
      salvarLocal();
      if (subiu) aviso('A cantina conferiu sua recarga · saldo ' + brl(novo));
      atualizarTelasDoSaldo();
    },
    e => console.error('Parou de ouvir a conta:', e)
  );
  pararRecargas = fbDb.collection('recargas')
    .where('uid', '==', estado.uid)
    .where('status', '==', RECARGA.EM_CONFERENCIA)
    .onSnapshot(
      q => {
        estado.recargasPendentes = q.docs.map(d => ({ id: d.id, valor: d.data().valorCentavos || 0 }));
        atualizarTelasDoSaldo();
      },
      e => console.error('Parou de ouvir as recargas:', e)
    );
}
function atualizarTelasDoSaldo() {
  if (estado.tela === 'conta') renderConta();
  if (estado.tela === 'checkout') renderCheckout();
}

/* ---------------------------------------------------------
   0b. SERVIÇO DE PEDIDOS (Cloud Firestore, tempo real)
   Cada pedido é um documento em pedidos/{id}. Aluno, caixa e
   preparo escutam o MESMO documento com onSnapshot, então todo
   mundo vê o mesmo status sem recarregar a página.
   Quem pode mudar o quê está no arquivo firestore.rules.
   --------------------------------------------------------- */
const STATUS = {
  AGUARDANDO_PIX: 'aguardando_pix',          // pedido criado, Pix ainda não pago
  EM_CONFERENCIA: 'aguardando_conferencia',  // aluno disse que pagou; caixa confere no banco
  RECEBIDO:       'recebido',                // pago (saldo/cartão) ou paga no balcão
  EM_PREPARO:     'em_preparo',
  PRONTO:         'pronto',
  RETIRADO:       'retirado',
  CANCELADO:      'cancelado',
  NAO_RETIRADO:   'nao_retirado'
};
const STATUS_FINAIS = [STATUS.RETIRADO, STATUS.CANCELADO, STATUS.NAO_RETIRADO];
const STATUS_SEM_CODIGO = [STATUS.AGUARDANDO_PIX, STATUS.EM_CONFERENCIA];  // código de retirada ainda escondido
const PIX_MINUTOS = 10;

/* status de uma recarga de saldo (coleção recargas) */
const RECARGA = {
  EM_CONFERENCIA: 'aguardando_conferencia',  // aluno disse que pagou; o saldo ainda não mudou
  CONFERIDA:      'conferida',               // caixa achou o Pix no banco; saldo creditado
  RECUSADA:       'recusada'                 // o Pix não chegou
};

const ts = () => firebase.firestore.FieldValue.serverTimestamp();

/* "2026-11-10": separa os códigos por dia, então o mesmo UB-1234 pode voltar amanhã */
function hojeChave() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* aplica o status no estado que as telas já usam (pago / pedidoPronto) */
function aplicarStatus(status) {
  estado.pedido.status = status;
  estado.pago = !STATUS_SEM_CODIGO.includes(status);
  estado.pedidoPronto = status === STATUS.PRONTO;
}

/* grava o pedido reservando um código UB-XXXX que ninguém está usando hoje.
   A reserva fica em codigos/{dia}_{código}; a transação garante que dois
   alunos nunca recebam o mesmo código no mesmo dia.
   Pedido pago com saldo: o débito vai NA MESMA transação, lendo o saldo da
   nuvem (não o do aparelho). As regras conferem que o saldo caiu exatamente
   o total do pedido; sem o débito, o pedido é recusado. */
async function criarPedidoNuvem(dados) {
  const dia = hojeChave();
  const refUsuario = fbDb.collection('usuarios').doc(estado.uid);
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    const codigo = novoCodigo();
    const refCodigo = fbDb.collection('codigos').doc(dia + '_' + codigo);
    const refPedido = fbDb.collection('pedidos').doc();
    let saldoDepois;
    try {
      await fbDb.runTransaction(async tx => {
        /* primeiro todas as leituras, depois as gravações (regra das transações) */
        const reservado = await tx.get(refCodigo);
        if (reservado.exists) throw new Error('codigo-em-uso');
        const pedido = Object.assign({}, dados, {
          codigo: codigo, dia: dia, ativo: true,
          criadoEm: ts(), atualizadoEm: ts()
        });
        if (dados.pagamento === 'saldo') {
          const conta = await tx.get(refUsuario);
          const s = conta.exists ? conta.data().saldoCentavos : 0;
          const saldo = Number.isInteger(s) ? s : 0;
          if (saldo < dados.totalCentavos) {
            const e = new Error('saldo-insuficiente'); e.saldo = saldo; throw e;
          }
          saldoDepois = saldo - dados.totalCentavos;
          pedido.saldoDepoisCentavos = saldoDepois;
          tx.update(refUsuario, { saldoCentavos: saldoDepois, ultimoPedidoSaldo: refPedido.id, atualizadoEm: ts() });
        }
        tx.set(refCodigo, { uid: estado.uid, pedidoId: refPedido.id, criadoEm: ts() });
        tx.set(refPedido, pedido);
      });
      return { id: refPedido.id, codigo: codigo, saldoDepois: saldoDepois };
    } catch (e) {
      if (e.message !== 'codigo-em-uso') throw e;   // erro de verdade: sobe
    }
  }
  throw new Error('Não deu para gerar um código livre. Tente de novo.');
}

/* --- escuta o pedido em andamento --- */
let pararPedido = null;
function pararDeOuvirPedido() {
  if (pararPedido) { pararPedido(); pararPedido = null; }
}

function ouvirPedido(id) {
  pararDeOuvirPedido();
  if (!fbPronto || !id) return;
  pararPedido = fbDb.collection('pedidos').doc(id).onSnapshot(
    snap => {
      if (!snap.exists || !estado.pedido || estado.pedido.id !== id) return;
      const d = snap.data();
      const antes = estado.pedido.status;
      if (d.status === antes) return;

      if (STATUS_FINAIS.includes(d.status)) { encerrarPedido(d.status); return; }

      aplicarStatus(d.status);
      salvar();
      if (d.status === STATUS.PRONTO) {
        aviso('Seu pedido está pronto! Código ' + estado.pedido.codigo);
        if (estado.notif.pronto) notificar('Pedido pronto · ' + estado.pedido.codigo, 'Retire no balcão da ' + CANTINA + '.');
      } else if (antes === STATUS.EM_CONFERENCIA && estado.pago) {
        aviso('Pix conferido pela cantina · código liberado');
      }
      atualizarTelasDoPedido();
    },
    erro => console.error('Parou de ouvir o pedido:', erro)
  );
}

/* pedido saiu do ar (retirado, cancelado ou não retirado) */
function encerrarPedido(status) {
  pararDeOuvirPedido();
  clearInterval(pixTimer);
  if (status === STATUS.RETIRADO) {
    arquivarPedido();
    aviso('Pedido retirado · bom lanche!');
  } else {
    estado.pedido = null; estado.pago = false; estado.pedidoPronto = false;
    salvar();
    aviso(status === STATUS.CANCELADO ? 'Seu pedido foi cancelado' : 'O pedido não foi retirado a tempo');
  }
  atualizarTelasDoPedido();
}

function atualizarTelasDoPedido() {
  renderIndicadorPedido();
  if (estado.tela === 'ok') renderOk();
  if (estado.tela === 'pedidos') renderPedidos();
  if (estado.pedido && estado.pedido.status === STATUS.AGUARDANDO_PIX) iniciarContagem();
}

/* ao entrar: procura na nuvem um pedido ainda ativo deste usuário */
function carregarPedidoAtivo() {
  if (!fbPronto || !estado.uid) return Promise.resolve();
  return fbDb.collection('pedidos')
    .where('uid', '==', estado.uid)
    .where('ativo', '==', true)
    .get()
    .then(q => {
      if (q.empty) {
        estado.pedido = null; estado.pago = false; estado.pedidoPronto = false;
        salvar();
        return;
      }
      /* deveria existir só um; se tiver mais, fica com o mais novo */
      const docs = q.docs.slice().sort((a, b) => millis(b.data().criadoEm) - millis(a.data().criadoEm));
      const doc = docs[0];
      estado.pedido = pedidoDaNuvem(doc.id, doc.data());
      aplicarStatus(doc.data().status);
      salvar();
      ouvirPedido(doc.id);
      if (estado.pedido.status === STATUS.AGUARDANDO_PIX) iniciarContagem();
    })
    .catch(e => console.error('Não deu para buscar o pedido ativo:', e));
}

function millis(t) { return t && t.toMillis ? t.toMillis() : 0; }

/* monta o objeto que as telas usam a partir do documento da nuvem */
function pedidoDaNuvem(id, d) {
  const itens = Array.isArray(d.itens) ? d.itens : [];
  const prim = itens[0] && produto(itens[0].id);
  const slot = SLOTS.find(s => s.id === d.horario);
  const quando = d.criadoEm && d.criadoEm.toDate ? d.criadoEm.toDate() : new Date();
  return {
    id: id,
    status: d.status,
    codigo: d.codigo,
    total: centavosDe(d.totalCentavos, d.total),
    resumo: itens.map(i => i.qty + '× ' + i.nome).join(', '),
    itens: itens,
    tint: prim ? prim.tint : '#F0E4C6',
    data: quando.getDate() + ' ' + MESES[quando.getMonth()],
    pagamento: d.pagamentoNome || '',
    viaSaldo: d.pagamento === 'saldo',
    saldoDepois: Number.isInteger(d.saldoDepoisCentavos) ? d.saldoDepoisCentavos : undefined,
    retirada: d.retirada === 'horario' && slot ? 'Hoje, ' + slot.hora : 'Fila · avisamos quando ficar pronto',
    texto: d.retirada === 'horario' && slot
      ? 'Retirada hoje às ' + slot.hora + ' (' + slot.label + '), no balcão da ' + CANTINA + '.'
      : 'Você entrou na fila. Avisamos assim que o pedido estiver pronto para retirada.',
    filho: d.filho || '',
    pix: d.pagamento === 'pix' ? pixPayload(PIX_CANTINA, centavosDe(d.totalCentavos, d.total)) : '',
    expiraEm: d.expiraEm || 0
  };
}

/* aluno avisa que pagou: o pedido vai para a conferência do caixa
   (o código só aparece quando o caixa confirmar no app do banco) */
function declararPix() {
  const p = estado.pedido;
  if (!p) return;
  if (!fbPronto || !p.id) {                 // modo demonstração: não tem caixa, libera direto
    aplicarStatus(STATUS.RECEBIDO);
    clearInterval(pixTimer);
    salvar();
    aviso('Pagamento confirmado!');
    renderOk();
    return;
  }
  fbDb.collection('pedidos').doc(p.id)
    .update({ status: STATUS.EM_CONFERENCIA, atualizadoEm: ts() })
    .then(() => {
      aplicarStatus(STATUS.EM_CONFERENCIA);
      clearInterval(pixTimer);
      salvar();
      aviso('Avisamos a cantina · aguarde a conferência');
      atualizarTelasDoPedido();
    })
    .catch(e => { console.error(e); aviso('Não deu para avisar a cantina. Tente de novo.'); });
}

/* acabaram os 10 minutos sem pagamento: cancela */
function expirarPix() {
  const p = estado.pedido;
  if (!p || p.status !== STATUS.AGUARDANDO_PIX) return;
  if (!fbPronto || !p.id) { encerrarPedido(STATUS.CANCELADO); return; }
  fbDb.collection('pedidos').doc(p.id)
    .update({ status: STATUS.CANCELADO, ativo: false, atualizadoEm: ts() })
    .then(() => encerrarPedido(STATUS.CANCELADO))
    .catch(e => console.error('Não deu para cancelar o Pix vencido:', e));
}

/* usado pelo painel da cantina (caixa e preparo). As regras do Firestore
   recusam esta chamada para quem não estiver na coleção "equipe" e para
   qualquer mudança fora da ordem do ciclo (ex.: de retirado de volta para
   em_preparo). A ordem permitida está em PROXIMOS_STATUS. */
const PROXIMOS_STATUS = {
  aguardando_pix:         [STATUS.EM_PREPARO, STATUS.CANCELADO],
  aguardando_conferencia: [STATUS.EM_PREPARO, STATUS.CANCELADO],
  recebido:               [STATUS.EM_PREPARO, STATUS.CANCELADO],
  em_preparo:             [STATUS.PRONTO, STATUS.CANCELADO],
  pronto:                 [STATUS.RETIRADO, STATUS.NAO_RETIRADO]
};
function mudarStatusPedido(id, novoStatus) {
  return fbDb.collection('pedidos').doc(id).update({
    status: novoStatus,
    ativo: !STATUS_FINAIS.includes(novoStatus),
    atualizadoEm: ts(),
    atualizadoPor: fbAuth.currentUser ? fbAuth.currentUser.uid : null
  });
}

/* também para o painel: o caixa achou (ou não) o Pix da recarga no app do banco.
   Conferida: a recarga muda de status e o saldo do aluno sobe, no MESMO lote;
   as regras só aceitam os dois juntos e com o valor exato da recarga. */
async function conferirRecarga(id, conferida) {
  const ref = fbDb.collection('recargas').doc(id);
  const r = (await ref.get()).data();
  const lote = fbDb.batch();
  lote.update(ref, {
    status: conferida ? RECARGA.CONFERIDA : RECARGA.RECUSADA,
    atualizadoEm: ts(),
    atualizadoPor: fbAuth.currentUser.uid
  });
  if (conferida) {
    lote.update(fbDb.collection('usuarios').doc(r.uid), {
      saldoCentavos: firebase.firestore.FieldValue.increment(r.valorCentavos),
      ultimaRecarga: id
    });
  }
  return lote.commit();
}

/* --- login: mensagens de erro em português --- */
function tratarErroLogin(err) {
  entrando = false;
  renderBotaoLogin();
  if (!err || !err.code) return;
  const ignorar = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'];
  if (ignorar.includes(err.code)) return;
  const msgs = {
    'auth/network-request-failed': 'Sem internet. Confira a conexão e tente de novo.',
    'auth/unauthorized-domain': 'Este endereço não está autorizado no Firebase (Authentication › Configurações › Domínios autorizados).',
    'auth/too-many-requests': 'Muitas tentativas. Espere um pouco e tente de novo.',
    'auth/user-disabled': 'Esta conta foi desativada.',
    'auth/web-storage-unsupported': 'O navegador está bloqueando o login. Saia da aba anônima ou libere os cookies.'
  };
  console.error(err);
  aviso(msgs[err.code] || 'Não deu para entrar (' + err.code + ')');
}

/* enquanto o Firebase verifica se já existe sessão, o botão fica travado
   (antes a tela de login piscava e dava para abrir dois popups) */
function renderBotaoLogin() {
  const b = document.querySelector('[data-act="google-login"]');
  if (!b) return;
  const ocupado = fbPronto && (!authResolvido || entrando);
  b.disabled = ocupado;
  b.innerHTML = ocupado
    ? (entrando ? 'Entrando…' : 'Verificando sua conta…')
    : '<span class="gmark">G</span> Entrar com o Google';
}

/* ---------------------------------------------------------
   1. DADOS
   --------------------------------------------------------- */
const CANTINA = 'Universidade do Lanche';

const CATS = [
  { id: 'todos',     nome: 'Tudo' },
  { id: 'salgados',  nome: 'Salgados' },
  { id: 'lanches',   nome: 'Lanches' },
  { id: 'bebidas',   nome: 'Bebidas' },
  { id: 'doces',     nome: 'Doces' },
  { id: 'combos',    nome: 'Combos' }
];

/* preço em centavos: 750 = R$ 7,50 (o firestore.rules tem a mesma tabela) */
const PRODUTOS = [
  { id: 'coxinha',    nome: 'Coxinha de frango',        desc: 'Massa crocante, recheio de frango desfiado com catupiry.', preco: 750,  cat: 'salgados', tint: '#F3DCBE', pop: true },
  { id: 'paoqueijo',  nome: 'Pão de queijo (2 un.)',    desc: 'Assado na hora, queijo minas curado.',                     preco: 600,  cat: 'salgados', tint: '#F0E4C6', pop: true },
  { id: 'esfiha',     nome: 'Esfiha de carne',          desc: 'Aberta, carne temperada com limão.',                       preco: 700,  cat: 'salgados', tint: '#EFD9C4' },
  { id: 'empada',     nome: 'Empada de palmito',        desc: 'Massa amanteigada com palmito cremoso.',                   preco: 800,  cat: 'salgados', tint: '#F2E3C8' },
  { id: 'xburguer',   nome: 'X-Burguer UBMeal',         desc: 'Blend 120 g, queijo prato, alface, tomate e molho da casa.', preco: 1800, cat: 'lanches',  tint: '#EFCFAE', pop: true },
  { id: 'misto',      nome: 'Misto quente',             desc: 'Pão de forma na chapa, presunto e queijo.',                preco: 950,  cat: 'lanches',  tint: '#F1DEC2' },
  { id: 'natural',    nome: 'Sanduíche natural',        desc: 'Pão integral, frango, cenoura e requeijão light.',         preco: 1100, cat: 'lanches',  tint: '#DFEAD4' },
  { id: 'hotdog',     nome: 'Hot dog completo',         desc: 'Salsicha, purê, batata palha, milho e ervilha.',           preco: 1400, cat: 'lanches',  tint: '#F1D5C4' },
  { id: 'suco',       nome: 'Suco de laranja 300 ml',   desc: 'Espremido na hora, sem açúcar.',                           preco: 800,  cat: 'bebidas',  tint: '#F7E2B8', pop: true },
  { id: 'refri',      nome: 'Refrigerante lata',        desc: 'Escolha entre cola, guaraná ou limão.',                    preco: 650,  cat: 'bebidas',  tint: '#DCE4F2' },
  { id: 'cafe',       nome: 'Café com leite',           desc: 'Copo 200 ml, coado na hora.',                              preco: 500,  cat: 'bebidas',  tint: '#E3D2C0' },
  { id: 'agua',       nome: 'Água mineral 500 ml',      desc: 'Com ou sem gás.',                                          preco: 350,  cat: 'bebidas',  tint: '#DFEBF0' },
  { id: 'brigadeiro', nome: 'Brigadeiro gourmet',       desc: 'Chocolate belga com granulado crocante.',                  preco: 450,  cat: 'doces',    tint: '#E6D3C6' },
  { id: 'bolo',       nome: 'Bolo de cenoura (fatia)',  desc: 'Cobertura generosa de chocolate.',                         preco: 700,  cat: 'doces',    tint: '#F2D9B4' },
  { id: 'comborec',   nome: 'Combo Recreio',            desc: 'Coxinha + suco de laranja 300 ml.',                        preco: 1350, cat: 'combos',   tint: '#F6DCC0', pop: true },
  { id: 'comboalm',   nome: 'Combo Almoço',             desc: 'X-Burguer + batata + refrigerante lata.',                  preco: 2600, cat: 'combos',   tint: '#EFCBA8' }
];

const TIPOS = [
  { id: 'faculdade',   nome: 'Aluno da faculdade',            desc: 'Graduação, pós ou técnico.' },
  { id: 'basica',      nome: 'Aluno do fundamental / médio',  desc: 'Ensino fundamental ou médio.' },
  { id: 'funcionario', nome: 'Funcionário da instituição',    desc: 'Professores, limpeza, administrativo.' },
  { id: 'pais',        nome: 'Pai, mãe ou responsável',       desc: 'Compra para alunos da educação infantil.' }
];

const SLOTS = [
  { id: '09:40', hora: '9h40',  label: 'recreio fund./médio' },
  { id: '10:15', hora: '10h15', label: 'intervalo faculdade' },
  { id: '12:00', hora: '12h00', label: 'almoço' },
  { id: '15:20', hora: '15h20', label: 'recreio da tarde' }
];

/* "cartao" fica desativado (off) até existir cobrança de verdade (item 22 do
   backlog, Won't): sem gateway, o pedido iria para o preparo sem ser pago.
   Quem quiser pagar com cartão escolhe "Pagar na retirada" e usa a maquininha. */
const PAGAMENTOS = [
  { id: 'pix',    nome: 'Pix na hora',                  desc: 'QR code aparece após confirmar.',   tag: 'instantâneo' },
  { id: 'cartao', nome: 'Cartão de crédito ou débito',  desc: 'Ainda não disponível no app. Para pagar com cartão, escolha Pagar na retirada e use a maquininha.', tag: 'em breve', off: true },
  { id: 'balcao', nome: 'Pagar na retirada',            desc: 'Dinheiro ou cartão na maquininha do balcão.', tag: 'no local' },
  { id: 'saldo',  nome: 'Saldo UBMeal',                 desc: 'Carteira pré-paga da instituição.', tag: '' }
];

/* conta nova começa zerada: só entra saldo por recarga conferida pela cantina */
const SALDO_INICIAL = 0;
const DIAS_FOTO = 60;      // intervalo mínimo entre trocas de foto
const DIAS_SENHA = 90;     // validade da senha das formas de pagamento
const MAX_QTD = 20;        // limite de unidades do mesmo item no carrinho
const MAX_OBS = 140;       // tamanho máximo da observação de um item
const MAX_LINHAS = 10;     // itens diferentes por pedido (o firestore.rules confere até 10)
const RECARGA_MIN = 100;         // R$ 1,00 (centavos)
const RECARGA_MAX = 50000;       // R$ 500,00 (centavos)

const PIX_RECARGA = { chave: '24999466024', nome: 'NOAN RODRIGUES', cidade: 'BARRA MANSA' };
const PIX_CANTINA = { chave: 'ubmeal@cantina.edu.br', nome: 'UBMEAL CANTINA', cidade: 'BARRA MANSA' };

/* ---------------------------------------------------------
   2. ESTADO
   --------------------------------------------------------- */
const estado = {
  tela: 'login',
  uid: null,
  nome: '',
  email: '',
  foto: '',              // foto em uso (a do Google ou a enviada pelo usuário)
  fotoGoogle: '',        // a que veio da conta Google
  fotoEm: 0,             // quando a foto foi trocada pela última vez
  tipo: null,
  telefone: '',
  cat: 'todos',
  busca: '',
  carrinho: [],
  produtoAberto: null,
  produtoQty: 1,
  obs: '',
  retirada: 'horario',
  slot: '09:40',
  filho: '',
  pagamento: 'pix',
  pago: false,
  pedido: null,
  pedidoPronto: false,   // vira true quando a cantina marcar o pedido como pronto
  historico: [],
  abaPedidos: 'atual',
  saldo: SALDO_INICIAL,  // em centavos
  recargasPendentes: [], // recargas que a cantina ainda vai conferir
  senhaPag: null,
  senhaEm: 0,            // quando a senha foi criada
  cartoes: [],
  notif: { promo: false, pronto: false },
  removerIdx: null,      // posição da linha do carrinho que vai ser removida
  enviando: false,       // pedido sendo gravado (trava o botão Confirmar)
  pixCopiado: false,
  /* transitórios */
  modal: null,
  pin: '',
  pinTmp: '',
  senhaEtapa: 'entrar',
  recarga: { etapa: 'valor', valor: 0, payload: '' }
};

/* v2: a partir de 24/11/2026 os valores ficam em centavos.
   Os dados da v1 (em reais) são descartados: com o Firebase ligado,
   tudo volta da nuvem no login. */
const MEMORIA = 'ubmeal.v2';
const MEMORIA_ANTIGA = 'ubmeal.v1';

function salvarLocal() {
  try {
    localStorage.setItem(MEMORIA, JSON.stringify({
      uid: estado.uid,
      nome: estado.nome,
      email: estado.email,
      foto: estado.foto,
      fotoGoogle: estado.fotoGoogle,
      fotoEm: estado.fotoEm,
      tipo: estado.tipo,
      telefone: estado.telefone,
      carrinho: estado.carrinho,
      historico: estado.historico,
      saldoCentavos: estado.saldo,
      pedido: estado.pedido,
      pago: estado.pago,
      pedidoPronto: estado.pedidoPronto,
      filho: estado.filho,
      senhaPag: estado.senhaPag,
      senhaEm: estado.senhaEm,
      cartoes: estado.cartoes,
      notif: estado.notif
    }));
  } catch (e) { /* navegador sem localStorage */ }
}

function salvar() {
  salvarLocal();
  salvarNuvem();
}

function carregar() {
  try { localStorage.removeItem(MEMORIA_ANTIGA); } catch (e) { /* ignora */ }
  try {
    const d = JSON.parse(localStorage.getItem(MEMORIA) || '{}');
    if (d.uid) estado.uid = d.uid;
    if (d.nome) estado.nome = d.nome;
    if (d.email) estado.email = d.email;
    if (d.foto) estado.foto = d.foto;
    if (d.fotoGoogle) estado.fotoGoogle = d.fotoGoogle;
    if (typeof d.fotoEm === 'number') estado.fotoEm = d.fotoEm;
    if (d.tipo) estado.tipo = d.tipo;
    if (d.telefone) estado.telefone = d.telefone;
    if (d.filho) estado.filho = d.filho;
    if (Array.isArray(d.carrinho))  estado.carrinho  = d.carrinho;
    if (Array.isArray(d.historico)) estado.historico = normalizarHistorico(d.historico);
    if (Array.isArray(d.cartoes))   estado.cartoes   = d.cartoes;
    if (Number.isInteger(d.saldoCentavos)) estado.saldo = d.saldoCentavos;
    if (typeof d.senhaPag === 'string') estado.senhaPag = d.senhaPag;
    if (typeof d.senhaEm === 'number') estado.senhaEm = d.senhaEm;
    if (d.notif) estado.notif = { promo: !!d.notif.promo, pronto: !!d.notif.pronto };
    if (d.pedido) {
      estado.pedido = d.pedido;
      /* pedidos salvos pela versão antiga não tinham status */
      if (!estado.pedido.status) {
        estado.pedido.status = d.pago
          ? (d.pedidoPronto ? STATUS.PRONTO : STATUS.RECEBIDO)
          : STATUS.AGUARDANDO_PIX;
      }
      aplicarStatus(estado.pedido.status);
    }
  } catch (e) { /* dados inválidos: começa limpo */ }
  limparCarrinho();
}

/* ---------------------------------------------------------
   3. UTILIDADES
   --------------------------------------------------------- */
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
/* DINHEIRO: todo valor no app é um número inteiro em centavos (1250 = R$ 12,50).
   Somar inteiros nunca dá 0,30000000000000004, e as regras do Firestore
   conseguem conferir o total exato do pedido. Só vira "R$ 12,50" na tela. */
const brl = (c) => 'R$ ' + (Math.round(Number(c) || 0) / 100).toFixed(2).replace('.', ',');
/* valor gravado em centavos; se só existir o campo antigo em reais, converte */
const centavosDe = (centavos, reais) =>
  Number.isInteger(centavos) ? centavos : Math.round((Number(reais) || 0) * 100);
/* "12,50" ou "12.50" digitado pela pessoa → 1250 */
function paraCentavos(texto) {
  const t = String(texto || '').trim().replace(/\s/g, '');
  const n = parseFloat(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const produto = (id) => PRODUTOS.find(p => p.id === id);
const slug = (p) => p.nome.split(' ')[0].toLowerCase();
const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* histórico salvo antes de 24/11/2026 guardava o total em reais */
function normalizarHistorico(lista) {
  return lista.filter(h => h && typeof h === 'object').map(h => ({
    resumo: h.resumo || '',
    itens: Array.isArray(h.itens) ? h.itens : [],
    data: h.data || '',
    totalCentavos: centavosDe(h.totalCentavos, h.total),
    tint: h.tint || '#F0E4C6'
  }));
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function dataCurta() {
  const d = new Date();
  return d.getDate() + ' ' + MESES[d.getMonth()];
}
function dataLonga(ms) {
  const d = new Date(ms);
  return d.getDate() + ' de ' + MESES[d.getMonth()] + ' de ' + d.getFullYear();
}

function nomeExibido() { return estado.nome.trim() || 'Visitante'; }
function inicial() { return nomeExibido().charAt(0).toUpperCase(); }
function emailExibido() {
  if (estado.email) return estado.email;
  const p = estado.nome.trim() ? estado.nome.trim().split(' ')[0].toLowerCase() : 'aluno';
  return p + '@institucional.edu.br';
}
function nomeTipo() {
  const t = TIPOS.find(x => x.id === estado.tipo);
  return t ? t.nome : 'Tipo não definido';
}
function ehResponsavel() { return estado.tipo === 'pais'; }

/* ----- foto de perfil ----- */
function podeTrocarFoto() {
  if (!estado.fotoEm) return { ok: true, dias: 0 };
  const passados = (Date.now() - estado.fotoEm) / 86400000;
  const faltam = Math.ceil(DIAS_FOTO - passados);
  return faltam > 0 ? { ok: false, dias: faltam } : { ok: true, dias: 0 };
}
function proximaTroca() { return dataLonga(estado.fotoEm + DIAS_FOTO * 86400000); }

/* ----- senha das formas de pagamento ----- */
function senhaVencida() {
  if (!estado.senhaPag) return false;
  if (!estado.senhaEm) return true;                 // senha antiga, sem data: pede uma nova
  return (Date.now() - estado.senhaEm) / 86400000 >= DIAS_SENHA;
}
function proximaSenha() { return dataLonga(estado.senhaEm + DIAS_SENHA * 86400000); }

function pintarAvatar(el) {
  if (!el) return;
  if (estado.foto) {
    el.innerHTML = '<img src="' + esc(estado.foto) + '" alt="Foto de perfil" referrerpolicy="no-referrer" />';
  } else {
    el.textContent = inicial();
  }
}

/* redimensiona a imagem escolhida e devolve um data URL leve */
function prepararFoto(arquivo) {
  return new Promise((ok, erro) => {
    if (!arquivo || !/^image\//.test(arquivo.type)) { erro('Escolha um arquivo de imagem'); return; }
    if (arquivo.size > 8 * 1024 * 1024) { erro('Imagem muito grande (máximo 8 MB)'); return; }
    const leitor = new FileReader();
    leitor.onerror = () => erro('Não deu para ler o arquivo');
    leitor.onload = () => {
      const img = new Image();
      img.onerror = () => erro('Arquivo de imagem inválido');
      img.onload = () => {
        const lado = Math.min(img.width, img.height);          // corta quadrado no centro
        const x = (img.width - lado) / 2;
        const y = (img.height - lado) / 2;
        const cv = document.createElement('canvas');
        cv.width = 256; cv.height = 256;
        cv.getContext('2d').drawImage(img, x, y, lado, lado, 0, 0, 256, 256);
        ok(cv.toDataURL('image/jpeg', 0.85));
      };
      img.src = leitor.result;
    };
    leitor.readAsDataURL(arquivo);
  });
}

let toastTimer;
function aviso(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

function copiar(texto, msg) {
  const fim = () => aviso(msg || 'Copiado');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(fim).catch(antigo);
  } else { antigo(); }
  function antigo() {
    const t = document.createElement('textarea');
    t.value = texto;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    try { document.execCommand('copy'); } catch (e) { /* sem permissão */ }
    document.body.removeChild(t);
    fim();
  }
}

/* ----- Pix: monta o BR Code (padrão EMV do Banco Central) ----- */
function crc16(txt) {
  let crc = 0xFFFF;
  for (let i = 0; i < txt.length; i++) {
    crc ^= txt.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function semAcento(t) {
  return String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}
/* centavos: valor em centavos (1250 vira "12.50" dentro do código Pix) */
function pixPayload(conta, centavos) {
  const c = (id, v) => id + String(v.length).padStart(2, '0') + v;
  const gui = c('00', 'BR.GOV.BCB.PIX') + c('01', conta.chave);
  let p = c('00', '01') + c('26', gui) + c('52', '0000') + c('53', '986');
  if (centavos > 0) p += c('54', (Math.round(centavos) / 100).toFixed(2));
  p += c('58', 'BR') + c('59', semAcento(conta.nome).slice(0, 25)) +
       c('60', semAcento(conta.cidade).slice(0, 15)) + c('62', c('05', '***'));
  p += '6304';
  return p + crc16(p);
}

/* QR decorativo, usado só se a biblioteca de QR não carregar */
const QR_FALLBACK = (function () {
  const n = 25, m = 4, size = n + m * 2;
  let seed = 1987;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const canto = (x, y) => (x < 7 && y < 7) || (x > n - 8 && y < 7) || (x < 7 && y > n - 8);
  let cells = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (canto(x, y)) { rnd(); continue; }
      if (rnd() > 0.5) cells += '<rect x="' + (x + m) + '" y="' + (y + m) + '" width="1" height="1"/>';
    }
  }
  const olho = (fx, fy) =>
    '<rect x="' + (fx + m + .5) + '" y="' + (fy + m + .5) + '" width="6" height="6" fill="none" stroke="#2B1710"/>' +
    '<rect x="' + (fx + m + 2) + '" y="' + (fy + m + 2) + '" width="3" height="3"/>';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges">' +
    '<rect width="' + size + '" height="' + size + '" fill="#FFFFFF"/><g fill="#2B1710">' +
    cells + olho(0, 0) + olho(n - 7, 0) + olho(0, n - 7) + '</g></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
})();

function desenharQR(el, texto) {
  if (!el) return;
  el.src = QR_FALLBACK;
  if (window.QRCode && QRCode.toDataURL) {
    QRCode.toDataURL(texto, { margin: 1, width: 460, color: { dark: '#2B1710', light: '#FFFFFF' } })
      .then(url => { el.src = url; })
      .catch(() => { /* fica o decorativo */ });
  }
}

/* ----- notificações do navegador -----
   A permissão fica guardada aqui; o disparo do aviso de
   "pedido pronto" vai vir do painel da cantina. */
function temNotificacao() { return 'Notification' in window; }
function textoPermissao() {
  if (!temNotificacao()) return 'Este navegador não suporta notificações.';
  if (Notification.permission === 'granted') return 'Notificações liberadas neste aparelho.';
  if (Notification.permission === 'denied') return 'As notificações estão bloqueadas. Libere no cadeado da barra de endereço.';
  return 'Ao ligar uma opção o navegador vai pedir permissão.';
}
function pedirPermissao() {
  if (!temNotificacao()) return Promise.resolve(false);
  if (Notification.permission === 'granted') return Promise.resolve(true);
  return Notification.requestPermission().then(p => p === 'granted');
}
function notificar(titulo, corpo) {
  if (!temNotificacao() || Notification.permission !== 'granted') return;
  try { new Notification(titulo, { body: corpo, icon: 'img/ubmeal-logo.png' }); } catch (e) { /* ignora */ }
}

/* bandeira a partir dos primeiros dígitos */
function bandeiraDe(numero) {
  const s = String(numero).replace(/\D/g, '');
  if (/^(4011|4312|4389|4514|4576|5041|5066|5067|509|6277|6362|6363|650|6516|6550)/.test(s)) return 'Elo';
  if (/^(606282|3841)/.test(s)) return 'Hiper';
  if (/^3[47]/.test(s)) return 'Amex';
  if (/^3(0[0-5]|[68])/.test(s)) return 'Diners';
  if (/^4/.test(s)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(s)) return 'Master';
  return 'Cartão';
}

/* ---------------------------------------------------------
   4. NAVEGAÇÃO E TELAS
   --------------------------------------------------------- */
function irPara(tela) {
  /* sem itens não tem o que pagar: volta para o carrinho vazio */
  if (tela === 'checkout' && !estado.carrinho.length) tela = 'carrinho';
  estado.tela = tela;
  $$('.screen').forEach(s => { s.hidden = true; });
  const alvo = $('#s-' + tela);
  if (alvo) alvo.hidden = false;

  const logado = tela !== 'login' && tela !== 'perfil';
  $('#topbar').hidden = !logado;
  $('#tabbar').hidden = !logado;
  document.body.classList.toggle('sem-tabbar', !logado);

  $$('.tab').forEach(b => b.classList.toggle('is-on', b.dataset.go === tela));
  $$('.navlink').forEach(b => b.classList.toggle('is-on', b.dataset.go === tela));

  if (tela === 'home')     { renderCategorias(); renderMenu(); }
  if (tela === 'cantina')  { renderCategorias(); renderMenu(); }
  if (tela === 'produto')  renderProduto();
  if (tela === 'busca')    { renderBusca(); setTimeout(() => $('#inBusca').focus(), 60); }
  if (tela === 'carrinho') renderCarrinho();
  if (tela === 'checkout') renderCheckout();
  if (tela === 'ok')       renderOk();
  if (tela === 'pedidos')  renderPedidos();
  if (tela === 'conta')    renderConta();

  renderBarraCarrinho();
  renderIndicadorPedido();
  window.scrollTo(0, 0);
}

/* --- perfil --- */
function renderTipos() {
  $('#tipos').innerHTML = TIPOS.map(t => `
    <button class="optcard ${estado.tipo === t.id ? 'is-on' : ''}" data-act="tipo" data-val="${t.id}">
      <span class="optcard__row"><span class="radio"></span><strong>${esc(t.nome)}</strong></span>
      <small class="optcard__desc">${esc(t.desc)}</small>
    </button>`).join('');
  const inp = $('#inNome');
  inp.value = estado.nome;      // vem do Google, mas pode ser editado
  inp.readOnly = false;
}

/* --- início --- */
function renderCategorias() {
  const html = CATS.map(c => `
    <button class="chip ${estado.cat === c.id ? 'is-on' : ''}" data-act="cat" data-val="${c.id}">${esc(c.nome)}</button>`).join('');
  ['#cats', '#cats2'].forEach(sel => { const el = $(sel); if (el) el.innerHTML = html; });
}

function itemTile(p) {
  return `
  <article class="tile">
    <button class="tile__ph ph" data-act="abrir" data-val="${p.id}" style="background-color:${p.tint}">
      <span>foto · ${esc(slug(p))}</span>
    </button>
    <div class="tile__body">
      <div class="tile__nome">${esc(p.nome)}</div>
      <div class="tile__desc">${esc(p.desc)}</div>
      <div class="tile__foot">
        <span class="preco preco--g">${brl(p.preco)}</span>
        <button class="add add--round" data-act="add" data-val="${p.id}" aria-label="Adicionar ${esc(p.nome)}">
          <svg class="ico" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </div>
  </article>`;
}

function itemMenu(p) {
  return `
  <article class="item">
    <button class="thumb" data-act="abrir" data-val="${p.id}" style="background-color:${p.tint}" aria-label="Ver ${esc(p.nome)}"></button>
    <button class="item__txt" data-act="abrir" data-val="${p.id}">
      <span class="item__nome">${esc(p.nome)}</span>
      <span class="item__desc">${esc(p.desc)}</span>
      <span class="preco" style="display:block;margin-top:6px">${brl(p.preco)}</span>
    </button>
    <button class="add" data-act="add" data-val="${p.id}" aria-label="Adicionar ${esc(p.nome)}">
      <svg class="ico" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
    </button>
  </article>`;
}

function renderMenu() {
  const lista = estado.cat === 'todos' ? PRODUTOS : PRODUTOS.filter(p => p.cat === estado.cat);
  if ($('#menuTiles')) $('#menuTiles').innerHTML = lista.map(itemTile).join('');
  if ($('#menu2'))     $('#menu2').innerHTML = lista.map(itemMenu).join('');
}

/* --- produto --- */
function renderProduto() {
  const p = produto(estado.produtoAberto) || PRODUTOS[0];
  const cat = CATS.find(c => c.id === p.cat);
  $('#prodView').innerHTML = `
    <div class="prod__foto ph" style="background-color:${p.tint}">
      <button class="iconbtn prod__back" data-act="voltar" aria-label="Voltar">
        <svg class="ico" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>
      </button>
    </div>
    <div class="prod__body">
      <p class="eyebrow">${esc(cat ? cat.nome : '')}</p>
      <h1 class="display">${esc(p.nome)}</h1>
      <p class="lead" style="margin-bottom:14px">${esc(p.desc)}</p>
      <div class="prod__preco">${brl(p.preco)}</div>
      <label class="label" for="inObs">Alguma observação?</label>
      <textarea class="textarea" id="inObs" maxlength="${MAX_OBS}" placeholder="Ex.: sem maionese, embalar separado…">${esc(estado.obs)}</textarea>
    </div>
    <div class="prod__bar">
      <div class="stepper stepper--branco">
        <button data-act="prod-menos" aria-label="Diminuir"><svg class="ico" viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
        <span>${estado.produtoQty}</span>
        <button data-act="prod-mais" aria-label="Aumentar"><svg class="ico" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
      <button class="btn btn--primary" style="flex:1" data-act="add-prod">Adicionar · ${brl(p.preco * estado.produtoQty)}</button>
    </div>`;
}

/* --- busca --- */
function renderBusca() {
  const q = estado.busca.trim().toLowerCase();
  const achados = q
    ? PRODUTOS.filter(p => (p.nome + ' ' + p.desc + ' ' + p.cat).toLowerCase().includes(q))
    : [];

  if (!q) {
    $('#buscaEstado').innerHTML = `
      <p class="label">Buscas recentes</p>
      <div class="chips" style="flex-wrap:wrap">
        ${['Coxinha', 'Suco de laranja', 'Combo Recreio', 'Pão de queijo']
          .map(n => `<button class="chip" data-act="busca-rapida" data-val="${esc(n)}">${esc(n)}</button>`).join('')}
      </div>`;
  } else if (!achados.length) {
    $('#buscaEstado').innerHTML = `
      <div class="vazio"><strong>Nada encontrado</strong>Tente “coxinha”, “suco” ou “combo”.</div>`;
  } else {
    $('#buscaEstado').innerHTML = '';
  }
  $('#resultados').innerHTML = achados.map(itemMenu).join('');
}

/* ---------------------------------------------------------
   5. CARRINHO
   --------------------------------------------------------- */
/* Cada linha do carrinho é { id, qty, obs }.
   O mesmo produto com observações diferentes vira linhas separadas
   ("Misto quente" e "Misto quente · sem tomate"). */
function limparObs(t) { return String(t || '').trim().replace(/\s+/g, ' ').slice(0, MAX_OBS); }

/* tira do carrinho o que não existe mais no cardápio ou veio corrompido
   (antes um id antigo salvo no aparelho quebrava o app inteiro) */
function limparCarrinho() {
  const juntas = [];
  (Array.isArray(estado.carrinho) ? estado.carrinho : []).forEach(l => {
    if (!l || !produto(l.id)) return;
    const qty = Math.min(MAX_QTD, Math.floor(Number(l.qty)));
    if (!(qty >= 1)) return;
    const obs = limparObs(l.obs);
    const igual = juntas.find(x => x.id === l.id && x.obs === obs);
    if (igual) igual.qty = Math.min(MAX_QTD, igual.qty + qty);
    else if (juntas.length < MAX_LINHAS) juntas.push({ id: l.id, qty: qty, obs: obs });
  });
  estado.carrinho = juntas;
}

function linhas() {
  return estado.carrinho
    .map((l, i) => {
      const p = produto(l.id);
      return p ? { i: i, p: p, qty: l.qty, obs: l.obs || '', total: p.preco * l.qty } : null;   // centavos
    })
    .filter(Boolean);
}
function totalItens() { return linhas().reduce((a, l) => a + l.qty, 0); }
function subtotal()  { return linhas().reduce((a, l) => a + l.total, 0); }       // centavos

function adicionar(id, qty, obs) {
  const p = produto(id);
  if (!p) { aviso('Este item não está mais no cardápio'); return; }
  const n = Math.max(1, Math.floor(qty || 1));
  const o = limparObs(obs);
  const l = estado.carrinho.find(x => x.id === id && (x.obs || '') === o);
  const atual = l ? l.qty : 0;
  if (!l && estado.carrinho.length >= MAX_LINHAS) {
    aviso('No máximo ' + MAX_LINHAS + ' itens diferentes por pedido');
    return;
  }
  if (atual >= MAX_QTD) { aviso('Máximo de ' + MAX_QTD + ' unidades por item'); return; }
  const somar = Math.min(n, MAX_QTD - atual);
  if (l) l.qty += somar;
  else estado.carrinho.push({ id: id, qty: somar, obs: o });
  salvar();
  aviso(somar < n
    ? 'Limite de ' + MAX_QTD + ' unidades · ' + (atual + somar) + '× ' + p.nome + ' no carrinho'
    : somar + '× ' + p.nome + ' no carrinho');
  renderBarraCarrinho();
  if (estado.tela === 'carrinho') renderCarrinho();
}

/* i = posição da linha no carrinho */
function mudarQty(i, delta) {
  const l = estado.carrinho[i];
  if (!l) return;
  const qty = l.qty + delta;
  if (qty < 1) { abrirAlerta(i); return; }
  if (qty > MAX_QTD) { aviso('Máximo de ' + MAX_QTD + ' unidades por item'); return; }
  l.qty = qty;
  salvar();
  renderCarrinho();
  renderBarraCarrinho();
}

function abrirAlerta(i) {
  const l = estado.carrinho[i];
  const p = l && produto(l.id);
  if (!p) return;
  estado.removerIdx = i;
  $('#dlgThumb').style.backgroundColor = p.tint;
  $('#dlgTexto').textContent = p.nome + (l.obs ? ' (' + l.obs + ')' : '') + ' vai sair do seu pedido.';
  $('#overlay').hidden = false;
}
function fecharAlerta() { estado.removerIdx = null; $('#overlay').hidden = true; }
function removerConfirmado() {
  if (estado.removerIdx === null) { fecharAlerta(); return; }
  estado.carrinho.splice(estado.removerIdx, 1);
  fecharAlerta();
  salvar();
  aviso('Item removido');
  renderCarrinho();
  renderBarraCarrinho();
}

function renderBarraCarrinho() {
  const qtd = totalItens();
  const tot = brl(subtotal());
  const escondida = qtd === 0 || ['carrinho', 'checkout', 'ok', 'produto', 'login', 'perfil'].includes(estado.tela);
  $('#cartbar').hidden = escondida;
  $('#barQty').textContent = qtd;
  $('#barTotal').textContent = tot;
  $('#topCartQty').textContent = qtd;
  $('#topCartTotal').textContent = tot;
  const badge = $('#homeBadge');
  if (badge) { badge.hidden = qtd === 0; badge.textContent = qtd; }
}

function renderIndicadorPedido() {
  const d = $('#tabPedidoDot');
  if (d) d.hidden = !estado.pedido;
}

function renderCarrinho() {
  const ls = linhas();
  if (!ls.length) {
    $('#cartView').innerHTML = `
      <div class="carrinho-vazio">
        <div class="carrinho-vazio__box">
          <svg class="ico" viewBox="0 0 24 24"><path d="M5 8h14l-1.2 12H6.2z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>
        </div>
        <h2 class="display display--sm">Carrinho vazio</h2>
        <p class="lead">Escolha um lanche no cardápio para começar.</p>
        <button class="btn btn--primary" data-go="home">Ver o cardápio</button>
      </div>`;
    return;
  }

  $('#cartView').innerHTML = `
    <div class="stack" style="padding-top:16px">
      ${ls.map(l => `
      <article class="cartline">
        <span class="thumb" style="background-color:${l.p.tint}"><em class="thumb__tag">foto</em></span>
        <div class="cartline__body">
          <div class="cartline__top">
            <div style="flex:1;min-width:0">
              <div class="item__nome">${esc(l.p.nome)}</div>
              <div class="item__desc">${esc(l.obs ? 'Obs.: ' + l.obs : l.p.desc)}</div>
            </div>
            <button class="trash" data-act="pedir-remover" data-val="${l.i}" title="Remover item" aria-label="Remover ${esc(l.p.nome)}">
              <svg class="ico" viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M10 4h4"/><path d="M6.5 7l.9 13h9.2l.9-13"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>
          <div class="cartline__foot">
            <div class="stepper">
              <button data-act="menos" data-val="${l.i}" aria-label="Diminuir"><svg class="ico" viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
              <span>${l.qty}</span>
              <button data-act="mais" data-val="${l.i}" aria-label="Adicionar" ${l.qty >= MAX_QTD ? 'disabled' : ''}><svg class="ico" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
            </div>
            <span class="preco preco--g">${brl(l.total)}</span>
          </div>
        </div>
      </article>`).join('')}
    </div>

    <button class="btn btn--dashed btn--block mt-md" data-go="cantina">+ Adicionar mais itens</button>

    <div class="card card--hard pad mt-md">
      <div class="linha"><span class="muted">Subtotal (${totalItens()} itens)</span><strong>${brl(subtotal())}</strong></div>
      <div class="linha"><span class="muted">Taxa de entrega</span><span class="gratis">Retirada · R$ 0,00</span></div>
      <div class="divisor"></div>
      <div class="total"><strong>Total</strong><span class="preco preco--xg">${brl(subtotal())}</span></div>
    </div>

    <button class="btn btn--primary btn--block mt-md" data-go="checkout">Ir para o pagamento</button>`;
}

/* ---------------------------------------------------------
   6. PAGAMENTO E PIX
   --------------------------------------------------------- */
function descPagamento(p) { return p.desc; }
function tagPagamento(p) {
  if (p.id === 'saldo') return brl(estado.saldo);
  return p.tag;
}

function renderCheckout() {
  $('#optHorario').classList.toggle('is-on', estado.retirada === 'horario');
  $('#optFila').classList.toggle('is-on', estado.retirada === 'fila');

  $('#retiradaDetalhe').innerHTML = estado.retirada === 'horario'
    ? `<div class="slots">${SLOTS.map(s => `
        <button class="slot ${estado.slot === s.id ? 'is-on' : ''}" data-act="slot" data-val="${s.id}">
          <strong>${s.hora}</strong><small>${esc(s.label)}</small>
        </button>`).join('')}</div>`
    : `<div class="fila-box"><b>6</b><small>pedidos na frente do seu · previsão de <strong>12 a 15 min</strong> depois de confirmar.</small></div>`;

  const bf = $('#blocoFilho');
  if (ehResponsavel()) {
    bf.hidden = false;
    if (!bf.dataset.pronto) {
      bf.innerHTML = `
        <p class="mono-label">02 · Quem vai retirar?</p>
        <input class="input" id="inFilho" maxlength="80" placeholder="Nome completo do aluno" value="${esc(estado.filho)}" />
        <p class="pix__nota nota--esq" style="margin:-18px 0 0">A cantina só entrega o pedido para o aluno indicado aqui.</p>`;
      bf.dataset.pronto = '1';
    }
  } else {
    bf.hidden = true;
    bf.innerHTML = '';
    delete bf.dataset.pronto;
  }
  $('#lblPagamento').textContent = (ehResponsavel() ? '03' : '02') + ' · Forma de pagamento';

  const tot = subtotal();
  if (PAGAMENTOS.some(p => p.id === estado.pagamento && p.off)) estado.pagamento = 'pix';

  $('#pags').innerHTML = PAGAMENTOS.map(p => {
    const semSaldo = p.id === 'saldo' && estado.saldo < tot;
    const desligado = p.off || semSaldo;
    const desc = semSaldo ? 'Saldo insuficiente para este pedido.' : descPagamento(p);
    return `
    <button class="optcard pag ${estado.pagamento === p.id ? 'is-on' : ''} ${desligado ? 'pag--off' : ''}" data-act="pagamento" data-val="${p.id}" ${p.off ? 'aria-disabled="true"' : ''}>
      <span class="radio"></span>
      <span style="flex:1;min-width:0">
        <strong>${esc(p.nome)}</strong>
        <small>${esc(desc)}</small>
      </span>
      <span class="pag__tag">${esc(tagPagamento(p))}</span>
    </button>`;
  }).join('');

  const ls = linhas();
  const pendente = estado.recargasPendentes.reduce((a, r) => a + r.valor, 0);
  $('#resumo').innerHTML = `
    <strong style="display:block;margin-bottom:12px">Resumo</strong>
    ${ls.map(l => `<div class="linha"><span class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.qty}× ${esc(l.p.nome)}${l.obs ? ' · ' + esc(l.obs) : ''}</span><strong>${brl(l.total)}</strong></div>`).join('')}
    <div class="divisor"></div>
    <div class="total"><strong>Total</strong><span class="preco preco--xg">${brl(tot)}</span></div>
    ${estado.pagamento === 'saldo'
      ? `<div class="linha" style="margin-top:12px"><span class="muted">Saldo depois do pedido</span><strong>${brl(Math.max(0, estado.saldo - tot))}</strong></div>
         ${pendente ? `<p class="muted" style="margin-top:4px">${brl(pendente)} de recarga ainda em conferência pela cantina.</p>` : ''}`
      : ''}
    <p class="muted" style="margin-top:8px">${esc(textoRetirada())}</p>`;

  renderBotaoConfirmar();
}

function slotAtual() { return SLOTS.find(s => s.id === estado.slot) || SLOTS[0]; }
function nomePagamento() {
  const p = PAGAMENTOS.find(x => x.id === estado.pagamento);
  return p ? p.nome : '';
}
function textoRetirada() {
  const s = slotAtual();
  return estado.retirada === 'horario'
    ? 'Retirada hoje às ' + s.hora + ' (' + s.label + '), no balcão da ' + CANTINA + '.'
    : 'Você entrou na fila. Avisamos assim que o pedido estiver pronto para retirada.';
}
function retiradaCurta() {
  return estado.retirada === 'horario'
    ? 'Hoje, ' + slotAtual().hora
    : 'Fila · avisamos quando ficar pronto';
}
function novoCodigo() { return 'UB-' + Math.floor(1000 + Math.random() * 9000); }

function temPedidoAtivo() {
  return !!(estado.pedido && !STATUS_FINAIS.includes(estado.pedido.status));
}

async function confirmarPedido() {
  if (estado.enviando) return;                      // clique duplo não cria dois pedidos
  limparCarrinho();
  if (!estado.carrinho.length) { aviso('Seu carrinho está vazio'); renderCarrinho(); return; }

  /* um pedido por vez: assim aluno, caixa e preparo acompanham o mesmo pedido */
  if (temPedidoAtivo()) {
    aviso('Você já tem o pedido ' + estado.pedido.codigo + ' em andamento');
    irPara('pedidos');
    return;
  }

  const total = subtotal();                         // centavos

  if (ehResponsavel() && !estado.filho.trim()) {
    aviso('Diga o nome do aluno que vai retirar');
    const el = $('#inFilho'); if (el) el.focus();
    return;
  }
  const forma = PAGAMENTOS.find(p => p.id === estado.pagamento);
  if (!forma || forma.off) {
    aviso('Pagamento com cartão ainda não está disponível. Escolha Pagar na retirada.');
    return;
  }
  if (estado.pagamento === 'saldo' && estado.saldo < total) {
    aviso('Saldo insuficiente · faltam ' + brl(total - estado.saldo));
    return;
  }

  const ehPix = estado.pagamento === 'pix';
  const viaSaldo = estado.pagamento === 'saldo';

  /* o que vai para a nuvem: os itens levam nome e preço (em centavos) do momento da compra.
     nome, email, tipo e filho também são copiados de propósito: ver "Dados copiados no pedido"
     na estrutura do banco */
  const dados = {
    uid: estado.uid,
    nome: nomeExibido(),
    email: estado.email,
    tipo: estado.tipo,
    filho: ehResponsavel() ? estado.filho.trim() : '',
    itens: linhas().map(l => ({ id: l.p.id, nome: l.p.nome, precoCentavos: l.p.preco, qty: l.qty, obs: l.obs })),
    totalCentavos: total,
    pagamento: estado.pagamento,
    pagamentoNome: nomePagamento(),
    retirada: estado.retirada,
    horario: estado.retirada === 'horario' ? estado.slot : null,
    status: ehPix ? STATUS.AGUARDANDO_PIX : STATUS.RECEBIDO,
    expiraEm: ehPix ? Date.now() + PIX_MINUTOS * 60000 : null
  };

  let id = null;
  let codigo = novoCodigo();
  let saldoDepois = viaSaldo ? estado.saldo - total : undefined;   // modo demonstração

  if (fbPronto) {
    estado.enviando = true;
    renderBotaoConfirmar();
    try {
      const r = await criarPedidoNuvem(dados);
      id = r.id; codigo = r.codigo;
      if (viaSaldo) saldoDepois = r.saldoDepois;      // calculado com o saldo da nuvem
    } catch (e) {
      console.error('Pedido não foi gravado:', e);
      if (e.message === 'saldo-insuficiente') {
        estado.saldo = e.saldo;
        salvarLocal();
        renderCheckout();
        aviso('Saldo insuficiente · faltam ' + brl(total - e.saldo));
      } else {
        aviso(e.code === 'permission-denied'
          ? 'A cantina recusou o pedido. Atualize a página e tente outra vez.'
          : 'Não deu para enviar o pedido. Confira a internet e tente de novo.');
      }
      return;                                         // carrinho e saldo continuam como estavam
    } finally {
      estado.enviando = false;
      renderBotaoConfirmar();
    }
  }

  /* gravou (ou modo demonstração): só agora mexe no saldo e no carrinho */
  if (viaSaldo) dados.saldoDepoisCentavos = saldoDepois;
  estado.pedido = pedidoDaNuvem(id, Object.assign({}, dados, { codigo: codigo }));
  aplicarStatus(dados.status);
  estado.pedidoPronto = false;

  if (viaSaldo) {
    estado.saldo = saldoDepois;
    aviso('Debitado do saldo · restam ' + brl(estado.saldo));
  }

  estado.carrinho = [];
  estado.abaPedidos = 'atual';
  estado.pixCopiado = false;
  salvar();
  if (id) ouvirPedido(id);
  irPara('ok');
  if (ehPix) iniciarContagem();
}

function renderBotaoConfirmar() {
  const b = $('#btnConfirmar');
  if (!b) return;
  b.disabled = estado.enviando;
  b.textContent = estado.enviando ? 'Enviando pedido…' : 'Confirmar pedido · ' + brl(subtotal());
}

function arquivarPedido() {
  const p = estado.pedido;
  if (!p) return;
  estado.historico.unshift({
    resumo: p.resumo,
    itens: (p.itens || []).map(i => ({ id: i.id, qty: i.qty, obs: i.obs || '' })),
    data: p.data,
    totalCentavos: p.total,
    tint: p.tint
  });
  if (estado.historico.length > 12) estado.historico.pop();
  estado.pedido = null;
  estado.pago = false;
  estado.pedidoPronto = false;
  salvar();
  renderIndicadorPedido();
}

function repetirPedido(i) {
  const h = estado.historico[i];
  if (!h || !Array.isArray(h.itens) || !h.itens.length) { aviso('Pedido sem itens para repetir'); return; }
  let n = 0;
  h.itens.forEach(it => {
    if (!produto(it.id)) return;
    const obs = limparObs(it.obs);
    const l = estado.carrinho.find(x => x.id === it.id && (x.obs || '') === obs);
    if (l) l.qty += it.qty; else estado.carrinho.push({ id: it.id, qty: it.qty, obs: obs });
    n += it.qty;
  });
  if (!n) { aviso('Esses itens não estão mais no cardápio'); return; }
  limparCarrinho();                                  // aplica o limite de unidades
  salvar();
  aviso(n + (n > 1 ? ' itens no carrinho' : ' item no carrinho'));
  irPara('carrinho');
}

/* a contagem do Pix vem de expiraEm (gravado no pedido), então
   recarregar a página não zera os 10 minutos */
let pixTimer;
function segundosPix() {
  const p = estado.pedido;
  if (!p || !p.expiraEm) return PIX_MINUTOS * 60;
  return Math.max(0, Math.round((p.expiraEm - Date.now()) / 1000));
}
function iniciarContagem() {
  clearInterval(pixTimer);
  const passo = () => {
    if (!estado.pedido || estado.pedido.status !== STATUS.AGUARDANDO_PIX) { clearInterval(pixTimer); return; }
    const el = $('#pixTempo');
    if (el) el.textContent = tempoPix();
    if (segundosPix() === 0) { clearInterval(pixTimer); expirarPix(); }
  };
  passo();
  pixTimer = setInterval(passo, 1000);
}
function tempoPix() {
  const s = segundosPix();
  return 'expira em ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function copiarPix() {
  const chave = (estado.pedido && estado.pedido.pix) || pixPayload(PIX_CANTINA, 0);
  copiar(chave, 'Código Pix copiado');
  estado.pixCopiado = true;
  renderOk();
  setTimeout(() => { estado.pixCopiado = false; if (estado.tela === 'ok') renderOk(); }, 2400);
}

function renderOk() {
  const ped = estado.pedido || { total: 0, resumo: '', codigo: 'UB-0000', pagamento: '', retirada: '', texto: '', pix: '' };
  const esperandoPix = !estado.pago;
  const emConferencia = ped.status === STATUS.EM_CONFERENCIA;

  const blocoPix = !esperandoPix ? '' : emConferencia ? `
    <div class="ticket">
      <div class="ticket__topo">
        <span class="dot"></span>
        <strong>Pix em conferência</strong>
        <span class="ticket__tempo">aguarde</span>
      </div>
      <div class="pix">
        <p class="pix__ajuda">A cantina está conferindo o seu Pix no app do banco. O código de retirada aparece aqui sozinho assim que for confirmado.</p>
      </div>
    </div>` : `
    <div class="ticket">
      <div class="ticket__topo">
        <span class="dot"></span>
        <strong>Aguardando pagamento Pix</strong>
        <span class="ticket__tempo" id="pixTempo">${tempoPix()}</span>
      </div>
      <div class="pix">
        <img class="pix__qr" id="qrPedido" alt="QR code para pagamento Pix" />
        <p class="pix__ajuda">Abra o app do banco, escaneie o QR code e o pedido vai para a cozinha na hora.</p>
      </div>
      <div class="serrilha"></div>
      <div class="pix__cola">
        <p class="mono-label">pix copia e cola</p>
        <div class="pix__key">${esc(ped.pix)}</div>
        <button class="btn btn--primary btn--block ${estado.pixCopiado ? 'btn--copiado' : ''}" data-act="copiar-pix">
          <svg class="ico" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a1 1 0 0 0-1 1v9"/></svg>
          ${estado.pixCopiado ? 'Código copiado!' : 'Copiar código Pix'}
        </button>
        <button class="btn btn--dashed btn--block" style="margin-top:9px" data-act="ja-paguei">Já fiz o pagamento</button>
        <p class="pix__nota">O código de retirada aparece aqui assim que o Pix for confirmado.</p>
      </div>
    </div>`;

  const codigo = esperandoPix ? `
    <div class="ticket__codigo ticket__bloqueado">
      <p class="mono-label" style="margin-top:0">código de retirada</p>
      <div class="cadeado">
        <svg class="ico" viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>
        <span>•••••</span>
      </div>
      <small>Liberado assim que o pagamento for confirmado.</small>
    </div>` : `
    <div class="ticket__codigo">
      <p class="mono-label" style="margin-top:0">código de retirada</p>
      <b>${esc(ped.codigo)}</b>
      <small>Mostre este código no balcão da cantina.</small>
    </div>`;

  $('#okView').innerHTML = `
    <div class="selo ${esperandoPix ? 'selo--espera' : 'selo--ok'}">
      ${esperandoPix
        ? '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>'
        : '<svg class="ico" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg>'}
    </div>
    <h1 class="display">${emConferencia ? 'Conferindo seu Pix' : esperandoPix ? 'Falta o pagamento' : 'Pedido confirmado!'}</h1>
    <p class="lead">${esc(ped.texto || textoRetirada())}</p>
    ${blocoPix}
    <div class="ticket">
      ${codigo}
      <div class="serrilha"></div>
      <div class="ticket__dados">
        <div><span>Local</span><span>${CANTINA}</span></div>
        <div><span>Retirada</span><span>${esc(ped.retirada || retiradaCurta())}</span></div>
        ${ped.filho ? `<div><span>Retira em nome de</span><span>${esc(ped.filho)}</span></div>` : ''}
        <div><span>Pagamento</span><span>${esc(ped.pagamento)}</span></div>
        <div><span>Total</span><span class="preco preco--g">${brl(ped.total)}</span></div>
        ${ped.viaSaldo ? `<div><span>Saldo restante</span><span>${brl(ped.saldoDepois)}</span></div>` : ''}
      </div>
    </div>
    <div class="acoes">
      <button class="btn btn--primary" data-go="pedidos">Acompanhar pedido</button>
      <button class="btn btn--outline" data-go="home">Voltar ao início</button>
    </div>`;

  if (esperandoPix && !emConferencia) desenharQR($('#qrPedido'), ped.pix);
}

/* texto e etapa (0 a 3) de cada status, para a barra de progresso */
const ETAPAS = {
  aguardando_pix:         { txt: 'Aguardando pagamento', etapa: 0, dir: 'aguardando Pix' },
  aguardando_conferencia: { txt: 'Conferindo pagamento', etapa: 0, dir: 'em conferência' },
  recebido:               { txt: 'Pedido recebido',      etapa: 1 },
  em_preparo:             { txt: 'Em preparo',           etapa: 2 },
  pronto:                 { txt: 'Pronto para retirar',  etapa: 3 }
};

/* --- meus pedidos --- */
function renderPedidos() {
  const ped = estado.pedido;
  const e = (ped && ETAPAS[ped.status]) || ETAPAS.recebido;

  $$('.aba').forEach(b => b.classList.toggle('is-on', b.dataset.val === estado.abaPedidos));
  $('#abaAtual').hidden     = estado.abaPedidos !== 'atual';
  $('#abaHistorico').hidden = estado.abaPedidos !== 'historico';

  $('#pedidoAtivo').innerHTML = !ped ? `
    <div class="vazio"><strong>Nenhum pedido em andamento</strong>Seus pedidos aparecem aqui depois da compra.</div>` : `
    <div class="pedido">
      <div class="ticket__topo">
        <span class="dot"></span>
        <strong>${esc(e.txt)}</strong>
        <span class="ticket__tempo">${estado.pago ? esc(ped.codigo) : esc(e.dir || '')}</span>
      </div>
      <div class="pad">
        <div class="progresso"><i class="${e.etapa >= 1 ? 'on' : ''}"></i><i class="${e.etapa >= 2 ? 'on' : ''}"></i><i class="${e.etapa >= 3 ? 'on' : ''}"></i></div>
        <div class="progresso-txt"><span>recebido</span><span>preparando</span><span>pronto</span></div>
        <strong>${esc(ped.resumo)}</strong>
        <small class="muted">${esc(ped.retirada || '')} · ${brl(ped.total)}</small>
        ${ped.filho ? `<small class="muted">Retira em nome de ${esc(ped.filho)}</small>` : ''}
        ${ped.status === STATUS.AGUARDANDO_PIX
          ? `<small class="muted" style="margin-top:8px">Falta o pagamento para liberar o código de retirada · ${esc(tempoPix())}.</small>
             <button class="btn btn--primary btn--block mt-md" data-act="ver-pix">
               <svg class="ico" viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><path d="M13 13h3v3M20 20v-3M16.5 20H20"/></svg>
               Ver QR code e copia e cola
             </button>`
          : ped.status === STATUS.EM_CONFERENCIA
          ? '<small class="muted" style="margin-top:8px">A cantina está conferindo o seu Pix. Esta tela atualiza sozinha.</small>'
          : fbPronto && ped.id
          ? `<small class="muted" style="margin-top:8px">${estado.pedidoPronto
              ? 'Mostre o código ' + esc(ped.codigo) + ' no balcão.'
              : 'Esta tela atualiza sozinha quando a cantina mudar o status.'}</small>`
          : '<button class="btn btn--outline btn--block mt-md" data-act="retirei">Já retirei o pedido</button>'}
      </div>
    </div>`;

  $('#historico').innerHTML = estado.historico.length
    ? estado.historico.map((h, i) => `
      <article class="hist">
        <span class="thumb thumb--sm" style="background-color:${h.tint || '#F0E4C6'}"></span>
        <div class="hist__txt"><strong>${esc(h.resumo)}</strong><small>${esc(h.data)} · retirado</small></div>
        <div class="hist__dir"><strong>${brl(h.totalCentavos)}</strong><button class="repetir" data-act="repetir" data-val="${i}">Repetir</button></div>
      </article>`).join('')
    : `<div class="vazio"><strong>Sem pedidos anteriores</strong>Quando você retirar um pedido ele fica registrado aqui.</div>`;
}

/* --- conta --- */
function renderConta() {
  pintarAvatar($('#contaAvatar'));
  $('#contaNome').textContent = nomeExibido();
  $('#contaTipo').textContent = nomeTipo();
  $('#contaSaldo').textContent = brl(estado.saldo);
  const pendente = estado.recargasPendentes.reduce((a, r) => a + r.valor, 0);
  const elRec = $('#contaRecarga');
  if (elRec) {
    elRec.hidden = !pendente;
    elRec.textContent = pendente ? '+ ' + brl(pendente) + ' em conferência pela cantina' : '';
  }

  const seta = '<svg class="ico" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
  const itens = [
    { act: 'conta-dados',      txt: 'Dados pessoais' },
    { act: 'conta-tipo',       txt: 'Tipo de usuário: ' + nomeTipo() },
    { act: 'conta-pagamentos', txt: 'Formas de pagamento' },
    { act: 'conta-notif',      txt: 'Notificações' }
  ];
  $('#contaItens').innerHTML =
    itens.map(i => `<button class="row" data-act="${i.act}"><span>${esc(i.txt)}</span>${seta}</button>`).join('') +
    `<button class="row row--sair" data-act="pedir-sair"><span>Sair da conta</span>${seta}</button>`;
}

/* ---------------------------------------------------------
   7. CONTA — MODAIS
   --------------------------------------------------------- */
function abrirModal(nome) {
  estado.modal = nome;
  renderModal();
  $('#modal').hidden = false;
}
function fecharModal() {
  estado.modal = null;
  estado.pin = '';
  estado.pinTmp = '';
  $('#modal').hidden = true;
}

function renderModal() {
  const tit = $('#modalTitulo');
  const body = $('#modalBody');

  /* ---- dados pessoais ---- */
  if (estado.modal === 'dados') {
    const troca = podeTrocarFoto();
    tit.textContent = 'Dados pessoais';
    body.innerHTML = `
      <div class="foto-linha">
        <span class="avatar avatar--xl" id="fotoAtual"></span>
        <div>
          <button class="btn btn--outline btn--mini" data-act="trocar-foto" ${troca.ok ? '' : 'disabled'}>
            <svg class="ico" viewBox="0 0 24 24"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/></svg>
            Trocar foto
          </button>
          ${estado.fotoGoogle && estado.foto !== estado.fotoGoogle && troca.ok
            ? '<button class="btn btn--dashed btn--mini" style="margin-top:8px" data-act="foto-google">Voltar para a do Google</button>'
            : ''}
          <small>${troca.ok
            ? 'A foto pode ser trocada uma vez a cada ' + DIAS_FOTO + ' dias.'
            : 'Você já trocou a foto recentemente. A próxima troca fica liberada em ' + troca.dias + (troca.dias === 1 ? ' dia' : ' dias') + ', no dia ' + proximaTroca() + '.'}</small>
        </div>
      </div>

      <div class="campo"><span>nome</span><div class="campo__ro">${esc(nomeExibido())}</div></div>
      <div class="campo"><span>e-mail da conta Google</span><div class="campo__ro">${esc(emailExibido())}</div></div>
      <div class="campo"><span>tipo de usuário</span><div class="campo__ro">${esc(nomeTipo())}</div></div>
      <div class="campo">
        <span>telefone para contato</span>
        <input class="input" id="inTelefone" inputmode="tel" maxlength="16" placeholder="(24) 90000-0000" value="${esc(estado.telefone)}" />
      </div>
      <p class="pix__nota nota--esq">O e-mail vem da sua conta do Google. O telefone só é usado se acontecer algum problema com o seu pedido.</p>
      <button class="btn btn--primary btn--block mt-md" data-act="salvar-telefone">Salvar telefone</button>`;
    pintarAvatar($('#fotoAtual'));
    return;
  }

  /* ---- tipo de usuário ---- */
  if (estado.modal === 'tipo') {
    tit.textContent = 'Tipo de usuário';
    body.innerHTML = `
      <p class="lead" style="margin-bottom:14px">A cantina usa isso para organizar os horários de retirada.</p>
      <div class="stack">
        ${TIPOS.map(t => `
        <button class="optcard ${estado.tipo === t.id ? 'is-on' : ''}" data-act="set-tipo" data-val="${t.id}">
          <span class="optcard__row"><span class="radio"></span><strong>${esc(t.nome)}</strong></span>
          <small class="optcard__desc">${esc(t.desc)}</small>
        </button>`).join('')}
      </div>
      ${ehResponsavel() ? '<p class="pix__nota nota--esq">Como responsável, você vai informar o nome do aluno antes de fechar cada pedido.</p>' : ''}
      <button class="btn btn--primary btn--block mt-md" data-act="fechar-modal">Concluir</button>`;
    return;
  }

  /* ---- senha de 6 dígitos ---- */
  if (estado.modal === 'senha') {
    const textos = {
      criar:     ['Crie uma senha', 'Seis números para proteger seus cartões.'],
      confirmar: ['Repita a senha', 'Digite os mesmos seis números.'],
      entrar:    ['Digite sua senha', 'Seis números para abrir suas formas de pagamento.']
    };
    const t = textos[estado.senhaEtapa] || textos.entrar;
    const vencida = estado.senhaEtapa === 'criar' && estado.senhaPag;
    tit.textContent = t[0];
    body.innerHTML = `
      <p class="lead" style="margin-bottom:6px">${t[1]}</p>
      <div class="pin" id="pin">
        ${[0,1,2,3,4,5].map(i => `<i class="pin__box ${i < estado.pin.length ? 'is-fill' : ''}"></i>`).join('')}
        <input class="pin__input" id="inPin" type="tel" inputmode="numeric" maxlength="6" autocomplete="one-time-code" value="${estado.pin}" />
      </div>
      <p class="pix__nota">${vencida
        ? 'Por segurança, a senha é trocada a cada ' + DIAS_SENHA + ' dias. A anterior venceu.'
        : 'Esta senha protege só a tela de cartões. Não use a mesma senha do seu banco.'}</p>`;
    setTimeout(() => { const el = $('#inPin'); if (el) el.focus(); }, 80);
    return;
  }

  /* ---- cartões salvos ---- */
  if (estado.modal === 'cartoes') {
    tit.textContent = 'Formas de pagamento';
    body.innerHTML = `
      ${estado.cartoes.length ? estado.cartoes.map(c => `
        <div class="cartao">
          <span class="cartao__band">${esc(c.bandeira)}</span>
          <div class="cartao__txt">
            <strong>•••• ${esc(c.last4)}</strong>
            <small>${esc(c.tipo)} · vence ${esc(c.validade)}</small>
          </div>
          <button class="trash" data-act="del-cartao" data-val="${c.id}" aria-label="Apagar cartão">
            <svg class="ico" viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M10 4h4"/><path d="M6.5 7l.9 13h9.2l.9-13"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>`).join('')
        : '<div class="vazio"><strong>Nenhum cartão salvo</strong>Adicione um cartão para pagar mais rápido.</div>'}
      <button class="btn btn--dashed btn--block mt-md" data-act="add-cartao">+ Adicionar cartão</button>
      <button class="btn btn--outline btn--block" style="margin-top:10px" data-act="trocar-senha">Trocar senha agora</button>
      <p class="pix__nota nota--esq">A senha vale ${DIAS_SENHA} dias${estado.senhaEm ? ' · próxima troca em ' + proximaSenha() : ''}.</p>
      <p class="pix__nota nota--esq">O pagamento com cartão pelo app ainda não está disponível. Para pagar com cartão, escolha <strong>Pagar na retirada</strong> e use a maquininha do balcão.</p>`;
    return;
  }

  /* ---- novo cartão ---- */
  if (estado.modal === 'addcartao') {
    tit.textContent = 'Adicionar cartão';
    body.innerHTML = `
      <div class="campo"><span>número do cartão</span>
        <input class="input" id="inNumCartao" inputmode="numeric" maxlength="19" placeholder="0000 0000 0000 0000" /></div>
      <div class="campo"><span>nome impresso no cartão</span>
        <input class="input" id="inNomeCartao" placeholder="NOAN R ESCOBAR" /></div>
      <div class="campo"><span>validade</span>
        <input class="input" id="inValCartao" inputmode="numeric" maxlength="5" placeholder="MM/AA" /></div>
      <div class="campo"><span>tipo</span>
        <select class="input" id="inTipoCartao">
          <option value="Crédito">Crédito</option>
          <option value="Débito">Débito</option>
        </select></div>
      <button class="btn btn--primary btn--block" data-act="salvar-cartao">Salvar cartão</button>
      <button class="btn btn--outline btn--block" style="margin-top:10px" data-act="ver-cartoes">Voltar</button>
      <p class="pix__nota nota--esq">Guardamos apenas os quatro últimos dígitos, a bandeira e a validade. O número completo não fica salvo.</p>`;
    return;
  }

  /* ---- notificações ---- */
  if (estado.modal === 'notif') {
    tit.textContent = 'Notificações';
    body.innerHTML = `
      <button class="sw ${estado.notif.promo ? 'is-on' : ''}" data-act="toggle-notif" data-val="promo">
        <span class="sw__txt"><strong>Futuras promoções</strong><small>Avisamos quando a cantina lançar combo ou desconto.</small></span>
        <span class="sw__led"></span>
      </button>
      <button class="sw ${estado.notif.pronto ? 'is-on' : ''}" data-act="toggle-notif" data-val="pronto">
        <span class="sw__txt"><strong>Pedido pronto</strong><small>Avisamos assim que a cantina marcar o seu pedido como pronto.</small></span>
        <span class="sw__led"></span>
      </button>
      <p class="pix__nota nota--esq">${esc(textoPermissao())} O aviso de pedido pronto passa a chegar quando o painel da cantina estiver no ar.</p>`;
    return;
  }

  /* ---- recarga de saldo (só Pix) ---- */
  if (estado.modal === 'recarga') {
    if (estado.recarga.etapa === 'valor') {
      tit.textContent = 'Recarregar saldo';
      body.innerHTML = `
        <p class="lead" style="margin-bottom:14px">A recarga é feita <strong>somente por Pix</strong>. O saldo entra depois que a cantina conferir o Pix no app do banco.</p>
        <div class="valores">
          ${[1000, 2000, 5000].map(v => `<button class="chip" data-act="recarga-valor" data-val="${v}">${brl(v)}</button>`).join('')}
        </div>
        <div class="campo"><span>valor da recarga</span>
          <input class="input" id="inRecarga" inputmode="decimal" placeholder="0,00" value="${estado.recarga.valor ? (estado.recarga.valor / 100).toFixed(2).replace('.', ',') : ''}" /></div>
        <button class="btn btn--primary btn--block" data-act="recarga-gerar">Gerar Pix</button>`;
    } else {
      tit.textContent = 'Pix da recarga';
      body.innerHTML = `
        <div class="pix" style="padding:0 0 12px">
          <img class="pix__qr" id="qrRecarga" alt="QR code Pix da recarga" />
          <p class="pix__ajuda">Escaneie no app do banco ou use o copia e cola abaixo.</p>
        </div>
        <p class="mono-label" style="margin-top:0">pix copia e cola</p>
        <div class="pix__key">${esc(estado.recarga.payload)}</div>
        <button class="btn btn--primary btn--block" style="margin-top:10px" data-act="recarga-copiar">
          <svg class="ico" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a1 1 0 0 0-1 1v9"/></svg>
          Copiar código Pix
        </button>
        <button class="btn btn--dashed btn--block" style="margin-top:9px" data-act="recarga-paguei" ${estado.recarga.enviando ? 'disabled' : ''}>${estado.recarga.enviando ? 'Avisando a cantina…' : 'Já fiz o pagamento'}</button>
        <p class="pix__nota">Recarga de <strong>${brl(estado.recarga.valor)}</strong> · chave ${PIX_RECARGA.chave} · ${esc(PIX_RECARGA.nome)}. O saldo entra quando a cantina conferir o Pix.</p>`;
      desenharQR($('#qrRecarga'), estado.recarga.payload);
    }
    return;
  }

  /* ---- sair da conta ---- */
  if (estado.modal === 'sair') {
    tit.textContent = 'Sair da conta?';
    body.innerHTML = `
      <p class="lead">Você realmente deseja sair da conta?</p>
      <div class="dialog__acts">
        <button class="btn btn--outline" data-act="fechar-modal">Ficar</button>
        <button class="btn btn--danger" data-act="confirmar-sair">Sair</button>
      </div>`;
    return;
  }
}

function renderPinDots() {
  const n = estado.pin.length;
  $$('#pin .pin__box').forEach((b, i) => b.classList.toggle('is-fill', i < n));
}

function passoSenha() {
  const pin = estado.pin;
  if (estado.senhaEtapa === 'criar') {
    estado.pinTmp = pin;
    estado.pin = '';
    estado.senhaEtapa = 'confirmar';
    renderModal();
    return;
  }
  if (estado.senhaEtapa === 'confirmar') {
    if (pin !== estado.pinTmp) {
      estado.pin = '';
      estado.pinTmp = '';
      estado.senhaEtapa = 'criar';
      renderModal();
      aviso('As senhas não bateram. Tente de novo.');
      return;
    }
    estado.senhaPag = pin;
    estado.senhaEm = Date.now();       // reinicia a contagem dos 90 dias
    estado.pin = '';
    estado.pinTmp = '';
    salvar();
    aviso('Senha criada · vale por ' + DIAS_SENHA + ' dias');
    abrirModal('cartoes');
    return;
  }
  if (pin === estado.senhaPag) {
    estado.pin = '';
    abrirModal('cartoes');
  } else {
    estado.pin = '';
    renderModal();
    aviso('Senha incorreta');
  }
}

function salvarCartao() {
  const num = ($('#inNumCartao').value || '').replace(/\D/g, '');
  const nome = ($('#inNomeCartao').value || '').trim();
  const val = ($('#inValCartao').value || '').trim();
  const tipo = $('#inTipoCartao').value;

  if (num.length < 13) { aviso('Número do cartão incompleto'); return; }
  if (!nome) { aviso('Digite o nome impresso no cartão'); return; }
  if (!/^\d{2}\/\d{2}$/.test(val)) { aviso('Validade no formato MM/AA'); return; }

  estado.cartoes.push({
    id: 'c' + Date.now(),
    last4: num.slice(-4),
    bandeira: bandeiraDe(num),
    tipo: tipo,
    validade: val,
    nome: nome
  });
  salvar();
  aviso('Cartão salvo');
  abrirModal('cartoes');
}

/* "Já fiz o pagamento" da recarga: cria o pedido de conferência em recargas/{id}.
   O saldo NÃO sobe aqui (item 23): só quando o caixa achar o Pix no app do
   banco e chamar conferirRecarga(). A tela atualiza sozinha (ouvirConta). */
async function avisarRecarga() {
  const v = estado.recarga.valor;
  if (!fbPronto || !estado.uid) {               // modo demonstração: não tem caixa, credita direto
    estado.saldo += v;
    salvar(); fecharModal(); renderConta();
    aviso('Saldo atualizado · ' + brl(estado.saldo));
    return;
  }
  if (estado.recarga.enviando) return;
  estado.recarga.enviando = true;
  renderModal();
  try {
    await fbDb.collection('recargas').add({
      uid: estado.uid,
      nome: nomeExibido(),
      email: estado.email,
      valorCentavos: v,
      status: RECARGA.EM_CONFERENCIA,
      criadoEm: ts(),
      atualizadoEm: ts()
    });
    fecharModal(); renderConta();
    aviso('Avisamos a cantina · o saldo entra depois da conferência');
  } catch (e) {
    console.error('Recarga não foi registrada:', e);
    estado.recarga.enviando = false;
    renderModal();
    aviso('Não deu para avisar a cantina. Tente de novo.');
  } finally {
    estado.recarga.enviando = false;
  }
}

/* ---------------------------------------------------------
   8. EVENTOS
   --------------------------------------------------------- */
function entrarComGoogle() {
  /* sem configuração do Firebase, entra no modo demonstração */
  if (!fbPronto) {
    irPara(estado.nome && estado.tipo ? 'home' : 'perfil');
    renderTipos();
    return;
  }
  if (entrando || !authResolvido) return;           // já tem um login em andamento
  entrando = true;
  renderBotaoLogin();

  const provedor = new firebase.auth.GoogleAuthProvider();
  provedor.setCustomParameters({ prompt: 'select_account' });
  /* o popup é o caminho principal, inclusive no iPhone: o redirecionamento
     costuma falhar no Safari quando o site não está no domínio do Firebase */
  fbAuth.signInWithPopup(provedor).catch(err => {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
      fbAuth.signInWithRedirect(provedor).catch(tratarErroLogin);   // popup bloqueado
    } else {
      tratarErroLogin(err);
    }
  });
}

function sairDaConta() {
  const limpar = () => {
    estado.uid = null;
    zerarDadosLocais();
    try { localStorage.removeItem(MEMORIA); } catch (e) { /* ignora */ }
    fecharModal();
    irPara('login');
  };
  if (fbPronto) fbAuth.signOut().then(limpar).catch(limpar);
  else limpar();
}

document.addEventListener('click', (ev) => {
  const nav = ev.target.closest('[data-go]');
  if (nav) { irPara(nav.dataset.go); return; }

  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const val = btn.dataset.val;

  switch (btn.dataset.act) {
    case 'google-login': entrarComGoogle(); break;

    case 'tipo':
      estado.tipo = val; salvar(); renderTipos(); break;

    case 'salvar-perfil':
      estado.nome = ($('#inNome').value || '').trim();
      if (!estado.nome) { aviso('Digite o seu nome'); return; }
      if (!estado.tipo) { aviso('Escolha o seu perfil'); return; }
      salvar(); irPara('home'); break;

    case 'cat':
      estado.cat = val; renderCategorias(); renderMenu(); break;

    case 'abrir':
      estado.produtoAberto = val; estado.produtoQty = 1; estado.obs = '';
      irPara('produto'); break;

    case 'voltar': irPara('home'); break;

    case 'prod-mais':
      if (estado.produtoQty >= MAX_QTD) { aviso('Máximo de ' + MAX_QTD + ' unidades por item'); return; }
      estado.produtoQty++; renderProduto(); break;
    case 'prod-menos': estado.produtoQty = Math.max(1, estado.produtoQty - 1); renderProduto(); break;

    case 'add': adicionar(val, 1, ''); break;
    case 'add-prod':
      adicionar(estado.produtoAberto, estado.produtoQty, estado.obs);   // a observação agora vai junto
      estado.obs = '';
      irPara('home'); break;

    case 'busca-rapida':
      estado.busca = val; $('#inBusca').value = val; renderBusca(); break;

    case 'mais':  mudarQty(Number(val), +1); break;
    case 'menos': mudarQty(Number(val), -1); break;

    case 'pedir-remover':      abrirAlerta(Number(val)); break;
    case 'cancelar-remover':   fecharAlerta(); break;
    case 'confirmar-remover':  removerConfirmado(); break;

    case 'retirada':   estado.retirada = val; renderCheckout(); break;
    case 'slot':       estado.slot = val; renderCheckout(); break;
    case 'pagamento': {
      const p = PAGAMENTOS.find(x => x.id === val);
      if (p && p.off) { aviso('Cartão pelo app ainda não está disponível · use Pagar na retirada'); return; }
      estado.pagamento = val; renderCheckout(); break;
    }

    case 'confirmar':  confirmarPedido(); break;
    case 'copiar-pix': copiarPix(); break;
    case 'ja-paguei':  declararPix(); break;

    /* volta para a tela do Pix de um pedido que ainda não foi pago */
    case 'ver-pix':
      if (!estado.pedido) { aviso('Nenhum pedido em andamento'); return; }
      irPara('ok');
      if (estado.pedido.status === STATUS.AGUARDANDO_PIX) iniciarContagem();
      break;

    case 'aba':
      estado.abaPedidos = val; renderPedidos(); break;

    /* só no modo demonstração: com o Firebase ligado, quem confirma a retirada é o caixa */
    case 'retirei':
      if (fbPronto && estado.pedido && estado.pedido.id) return;
      arquivarPedido(); estado.abaPedidos = 'historico';
      aviso('Pedido concluído'); renderPedidos(); break;

    case 'repetir':
      repetirPedido(Number(val)); break;

    /* ----- conta ----- */
    case 'conta-dados': abrirModal('dados'); break;

    case 'trocar-foto': {
      const t = podeTrocarFoto();
      if (!t.ok) { aviso('Faltam ' + t.dias + (t.dias === 1 ? ' dia' : ' dias') + ' para trocar a foto'); return; }
      $('#inFoto').click();
      break;
    }

    case 'foto-google': {
      const t = podeTrocarFoto();
      if (!t.ok) { aviso('Faltam ' + t.dias + (t.dias === 1 ? ' dia' : ' dias') + ' para trocar a foto'); return; }
      estado.foto = estado.fotoGoogle;
      estado.fotoEm = Date.now();
      salvar(); renderModal(); renderConta();
      aviso('Foto do Google restaurada');
      break;
    }

    case 'salvar-telefone':
      estado.telefone = ($('#inTelefone').value || '').trim();
      salvar(); renderConta(); fecharModal();
      aviso(estado.telefone ? 'Telefone salvo' : 'Telefone removido');
      break;

    case 'conta-tipo': abrirModal('tipo'); break;

    case 'set-tipo':
      estado.tipo = val;
      if (!ehResponsavel()) estado.filho = '';
      salvar(); renderModal(); renderConta();
      break;

    case 'conta-pagamentos':
      estado.pin = ''; estado.pinTmp = '';
      if (!estado.senhaPag) {
        estado.senhaEtapa = 'criar';
      } else if (senhaVencida()) {
        estado.senhaEtapa = 'criar';
        aviso('Sua senha passou de ' + DIAS_SENHA + ' dias. Crie uma nova.');
      } else {
        estado.senhaEtapa = 'entrar';
      }
      abrirModal('senha');
      break;

    case 'trocar-senha':
      estado.pin = ''; estado.pinTmp = ''; estado.senhaEtapa = 'criar';
      abrirModal('senha');
      break;

    case 'ver-cartoes': abrirModal('cartoes'); break;
    case 'add-cartao':  abrirModal('addcartao'); break;
    case 'salvar-cartao': salvarCartao(); break;

    case 'del-cartao':
      estado.cartoes = estado.cartoes.filter(c => c.id !== val);
      salvar(); renderModal(); aviso('Cartão removido');
      break;

    case 'conta-notif': abrirModal('notif'); break;

    case 'toggle-notif': {
      const chave = val;
      if (estado.notif[chave]) {
        estado.notif[chave] = false; salvar(); renderModal();
      } else {
        pedirPermissao().then(ok => {
          estado.notif[chave] = ok;
          if (!ok) aviso('O navegador não liberou as notificações');
          salvar(); renderModal();
        });
      }
      break;
    }

    /* ----- recarga ----- */
    case 'recarregar':
      estado.recarga = { etapa: 'valor', valor: 0, payload: '' };
      abrirModal('recarga');
      break;

    case 'recarga-valor':
      $('#inRecarga').value = (Number(val) / 100).toFixed(2).replace('.', ',');
      break;

    case 'recarga-gerar': {
      const v = paraCentavos($('#inRecarga').value);           // centavos
      if (v < RECARGA_MIN) { aviso('Digite um valor a partir de ' + brl(RECARGA_MIN)); return; }
      if (v > RECARGA_MAX) { aviso('O limite por recarga é ' + brl(RECARGA_MAX)); return; }
      estado.recarga.valor = v;
      estado.recarga.payload = pixPayload(PIX_RECARGA, v);
      estado.recarga.etapa = 'pix';
      renderModal();
      break;
    }

    case 'recarga-copiar':
      copiar(estado.recarga.payload, 'Código Pix copiado');
      break;

    case 'recarga-paguei': avisarRecarga(); break;

    /* ----- sair ----- */
    case 'pedir-sair': abrirModal('sair'); break;
    case 'confirmar-sair': sairDaConta(); break;

    case 'fechar-modal': fecharModal(); break;
  }
});

/* fecha os alertas clicando fora ou com Esc */
$('#overlay').addEventListener('click', (ev) => { if (ev.target.id === 'overlay') fecharAlerta(); });
$('#modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') fecharModal(); });
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  fecharAlerta();
  fecharModal();
});

/* arquivo da foto de perfil */
document.addEventListener('change', (ev) => {
  if (ev.target.id !== 'inFoto') return;
  const arquivo = ev.target.files && ev.target.files[0];
  ev.target.value = '';                     // permite escolher a mesma imagem de novo
  if (!arquivo) return;

  const t = podeTrocarFoto();
  if (!t.ok) { aviso('Faltam ' + t.dias + ' dias para trocar a foto'); return; }

  prepararFoto(arquivo).then(dataUrl => {
    estado.foto = dataUrl;
    estado.fotoEm = Date.now();
    salvar();
    renderModal();
    renderConta();
    aviso('Foto atualizada · próxima troca em ' + DIAS_FOTO + ' dias');
  }).catch(msg => aviso(typeof msg === 'string' ? msg : 'Não deu para usar essa imagem'));
});

document.addEventListener('input', (ev) => {
  const id = ev.target.id;
  if (id === 'inNome')  estado.nome = ev.target.value;
  if (id === 'inObs')   estado.obs = ev.target.value;
  if (id === 'inFilho') estado.filho = ev.target.value;
  if (id === 'inBusca') { estado.busca = ev.target.value; renderBusca(); }

  if (id === 'inValCartao') {           // MM/AA automático
    let v = ev.target.value.replace(/\D/g, '').slice(0, 4);
    if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2);
    ev.target.value = v;
  }

  if (id === 'inPin') {
    estado.pin = ev.target.value.replace(/\D/g, '').slice(0, 6);
    ev.target.value = estado.pin;
    renderPinDots();
    if (estado.pin.length === 6) setTimeout(passoSenha, 160);
  }
});

/* ---------------------------------------------------------
   9. INÍCIO
   --------------------------------------------------------- */
carregar();
renderTipos();
renderBarraCarrinho();
renderIndicadorPedido();
iniciarFirebase();

if (fbPronto) {
  irPara('login');            // o onAuthStateChanged decide para onde ir
} else {
  irPara(estado.nome && estado.tipo ? 'home' : 'login');
}