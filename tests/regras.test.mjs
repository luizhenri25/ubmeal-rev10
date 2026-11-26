/* Testes automatizados das regras do Firestore (firestore.rules).
   Rodam no emulador do Firestore, sem tocar no banco de verdade:
     npm install
     npm test
   Precisa de Java 11 ou mais novo (o emulador é um programa Java). */
import { readFileSync } from 'node:fs';
import { before, after, beforeEach, describe, test } from 'node:test';
import {
  initializeTestEnvironment, assertFails, assertSucceeds
} from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';

const FV = firebase.firestore.FieldValue;
const ts = () => FV.serverTimestamp();

let env;
const ALUNO = { uid: 'aluno1', email: 'aluno1@ubm.br' };
const OUTRO = { uid: 'aluno2', email: 'aluno2@ubm.br' };
const CAIXA = { uid: 'caixa1', email: 'caixa@cantina.br' };

const db = (conta) => env.authenticatedContext(conta.uid, { email: conta.email }).firestore();
const hoje = '2026-11-24';

/* pedido válido de 1 coxinha (750) + 1 misto (950) = 1700 centavos */
function pedidoBase(extra) {
  return Object.assign({
    uid: ALUNO.uid, nome: 'Ana Teste', email: ALUNO.email, tipo: 'faculdade', filho: '',
    itens: [
      { id: 'coxinha', nome: 'Coxinha de frango', precoCentavos: 750, qty: 1, obs: '' },
      { id: 'misto', nome: 'Misto quente', precoCentavos: 950, qty: 1, obs: 'sem tomate' }
    ],
    totalCentavos: 1700, pagamento: 'balcao', pagamentoNome: 'Pagar na retirada',
    retirada: 'fila', horario: null, status: 'recebido', expiraEm: null,
    dia: hoje, ativo: true, criadoEm: ts(), atualizadoEm: ts()
  }, extra);
}

/* grava pedido + reserva do código na mesma transação, como o app faz */
function criarPedido(fs, codigo, dados, extraNaTransacao) {
  const refPed = fs.collection('pedidos').doc();
  const refCod = fs.collection('codigos').doc(hoje + '_' + codigo);
  return fs.runTransaction(async tx => {
    await tx.get(refCod);
    if (extraNaTransacao) await extraNaTransacao(tx, refPed);
    tx.set(refCod, { uid: ALUNO.uid, pedidoId: refPed.id, criadoEm: ts() });
    tx.set(refPed, Object.assign({ codigo }, dados));
  }).then(() => refPed.id);
}

/* coloca dados direto no banco, sem passar pelas regras */
async function semear(caminho, dados) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(caminho).set(dados);
  });
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-ubmeal',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await semear('equipe/' + CAIXA.uid, { papel: 'caixa' });
  await semear('usuarios/' + ALUNO.uid, { nome: 'Ana Teste', email: ALUNO.email, saldoCentavos: 2000 });
});

describe('conta do usuário', () => {
  test('o aluno edita os próprios dados', async () => {
    await assertSucceeds(db(ALUNO).doc('usuarios/aluno1').set({ nome: 'Ana Paula', telefone: '24999990000' }, { merge: true }));
  });
  test('o aluno NÃO grava o próprio saldo (item 23)', async () => {
    await assertFails(db(ALUNO).doc('usuarios/aluno1').update({ saldoCentavos: 99999 }));
  });
  test('conta nova não nasce com saldo', async () => {
    await assertFails(db(OUTRO).doc('usuarios/aluno2').set({ nome: 'Bia', saldoCentavos: 5000 }));
    await assertSucceeds(db(OUTRO).doc('usuarios/aluno2').set({ nome: 'Bia' }));
  });
  test('a senha antiga em texto puro não pode ser gravada de novo', async () => {
    await assertFails(db(ALUNO).doc('usuarios/aluno1').update({ senhaPag: '123456' }));
  });
  test('ninguém lê a conta dos outros', async () => {
    await assertFails(db(OUTRO).doc('usuarios/aluno1').get());
  });
});

describe('criar pedido', () => {
  test('pedido certo (pagar na retirada) é aceito', async () => {
    await assertSucceeds(criarPedido(db(ALUNO), 'UB-1001', pedidoBase()));
  });
  test('pedido Pix com prazo de 10 minutos é aceito', async () => {
    await assertSucceeds(criarPedido(db(ALUNO), 'UB-1002', pedidoBase({
      pagamento: 'pix', pagamentoNome: 'Pix na hora', status: 'aguardando_pix', expiraEm: Date.now() + 600000
    })));
  });
  test('preço diferente do cardápio é negado', async () => {
    const d = pedidoBase();
    d.itens[0].precoCentavos = 1; d.totalCentavos = 951;
    await assertFails(criarPedido(db(ALUNO), 'UB-1003', d));
  });
  test('total que não bate com a soma dos itens é negado (ex.: R$ 0,01)', async () => {
    await assertFails(criarPedido(db(ALUNO), 'UB-1004', pedidoBase({ totalCentavos: 1 })));
  });
  test('pagamento com cartão (desativado) é negado', async () => {
    await assertFails(criarPedido(db(ALUNO), 'UB-1005', pedidoBase({ pagamento: 'cartao' })));
  });
  test('status inicial errado é negado (Pix já "pronto")', async () => {
    await assertFails(criarPedido(db(ALUNO), 'UB-1006', pedidoBase({
      pagamento: 'pix', status: 'pronto', expiraEm: Date.now() + 600000
    })));
  });
  test('pedido sem a reserva do código no mesmo lote é negado', async () => {
    const ref = db(ALUNO).collection('pedidos').doc();
    await assertFails(ref.set(Object.assign({ codigo: 'UB-1007' }, pedidoBase())));
  });
  test('código já usado hoje por outro pedido é negado', async () => {
    await criarPedido(db(ALUNO), 'UB-1008', pedidoBase());
    const ref = db(ALUNO).collection('pedidos').doc();
    await assertFails(ref.set(Object.assign({ codigo: 'UB-1008' }, pedidoBase())));
  });
  test('pedido em nome de outro aluno é negado', async () => {
    await assertFails(criarPedido(db(ALUNO), 'UB-1009', pedidoBase({ uid: OUTRO.uid })));
  });
});

describe('pagar com saldo', () => {
  test('pedido + débito do saldo no mesmo lote é aceito', async () => {
    const fs = db(ALUNO);
    const refPed = fs.collection('pedidos').doc();
    const refCod = fs.collection('codigos').doc(hoje + '_UB-2001');
    const conta = fs.doc('usuarios/aluno1');
    await assertSucceeds(fs.runTransaction(async tx => {
      await tx.get(refCod); await tx.get(conta);
      tx.update(conta, { saldoCentavos: 300, ultimoPedidoSaldo: refPed.id, atualizadoEm: ts() });
      tx.set(refCod, { uid: ALUNO.uid, pedidoId: refPed.id, criadoEm: ts() });
      tx.set(refPed, Object.assign({ codigo: 'UB-2001' }, pedidoBase({
        pagamento: 'saldo', pagamentoNome: 'Saldo UBMeal', saldoDepoisCentavos: 300
      })));
    }));
  });
  test('pedido "pago com saldo" sem debitar o saldo é negado', async () => {
    await assertFails(criarPedido(db(ALUNO), 'UB-2002', pedidoBase({
      pagamento: 'saldo', pagamentoNome: 'Saldo UBMeal', saldoDepoisCentavos: 2000
    })));
  });
  test('débito menor que o total é negado', async () => {
    const fs = db(ALUNO);
    const refPed = fs.collection('pedidos').doc();
    const refCod = fs.collection('codigos').doc(hoje + '_UB-2003');
    const conta = fs.doc('usuarios/aluno1');
    await assertFails(fs.runTransaction(async tx => {
      await tx.get(refCod); await tx.get(conta);
      tx.update(conta, { saldoCentavos: 1999, ultimoPedidoSaldo: refPed.id, atualizadoEm: ts() });
      tx.set(refCod, { uid: ALUNO.uid, pedidoId: refPed.id, criadoEm: ts() });
      tx.set(refPed, Object.assign({ codigo: 'UB-2003' }, pedidoBase({
        pagamento: 'saldo', pagamentoNome: 'Saldo UBMeal', saldoDepoisCentavos: 1999
      })));
    }));
  });
  test('saldo não pode ficar negativo', async () => {
    const fs = db(ALUNO);
    const d = pedidoBase({ pagamento: 'saldo', pagamentoNome: 'Saldo UBMeal', saldoDepoisCentavos: -400 });
    d.itens = [{ id: 'xburguer', nome: 'X-Burguer UBMeal', precoCentavos: 1800, qty: 2, obs: '' }];
    d.totalCentavos = 3600;
    const refPed = fs.collection('pedidos').doc();
    const refCod = fs.collection('codigos').doc(hoje + '_UB-2004');
    const conta = fs.doc('usuarios/aluno1');
    await assertFails(fs.runTransaction(async tx => {
      await tx.get(refCod); await tx.get(conta);
      tx.update(conta, { saldoCentavos: -1600, ultimoPedidoSaldo: refPed.id, atualizadoEm: ts() });
      tx.set(refCod, { uid: ALUNO.uid, pedidoId: refPed.id, criadoEm: ts() });
      tx.set(refPed, Object.assign({ codigo: 'UB-2004' }, d));
    }));
  });
});

describe('status do pedido', () => {
  let id;
  beforeEach(async () => {
    id = await criarPedido(db(ALUNO), 'UB-3001', pedidoBase({
      pagamento: 'pix', pagamentoNome: 'Pix na hora', status: 'aguardando_pix', expiraEm: Date.now() + 600000
    }));
  });
  const mudar = (conta, status, ativo, extra) => db(conta).doc('pedidos/' + id).update(Object.assign({
    status, ativo, atualizadoEm: ts()
  }, extra));

  test('aluno avisa que pagou o Pix', async () => {
    await assertSucceeds(mudar(ALUNO, 'aguardando_conferencia', true));
  });
  test('aluno não marca o próprio pedido como pronto', async () => {
    await assertFails(mudar(ALUNO, 'pronto', true));
  });
  test('equipe segue a ordem do ciclo até retirado', async () => {
    await assertSucceeds(mudar(CAIXA, 'em_preparo', true, { atualizadoPor: CAIXA.uid }));
    await assertSucceeds(mudar(CAIXA, 'pronto', true, { atualizadoPor: CAIXA.uid }));
    await assertSucceeds(mudar(CAIXA, 'retirado', false, { atualizadoPor: CAIXA.uid }));
  });
  test('equipe não pula etapas (aguardando_pix → retirado)', async () => {
    await assertFails(mudar(CAIXA, 'retirado', false, { atualizadoPor: CAIXA.uid }));
  });
  test('equipe não volta um pedido retirado para em_preparo', async () => {
    await mudar(CAIXA, 'em_preparo', true, { atualizadoPor: CAIXA.uid });
    await mudar(CAIXA, 'pronto', true, { atualizadoPor: CAIXA.uid });
    await mudar(CAIXA, 'retirado', false, { atualizadoPor: CAIXA.uid });
    await assertFails(mudar(CAIXA, 'em_preparo', true, { atualizadoPor: CAIXA.uid }));
  });
  test('ativo precisa combinar com o status', async () => {
    await assertFails(mudar(CAIXA, 'em_preparo', false, { atualizadoPor: CAIXA.uid }));
  });
  test('equipe não altera o total do pedido', async () => {
    await assertFails(db(CAIXA).doc('pedidos/' + id).update({ totalCentavos: 1 }));
  });
});

describe('recargas', () => {
  let rid;
  beforeEach(async () => {
    const ref = await db(ALUNO).collection('recargas').add({
      uid: ALUNO.uid, nome: 'Ana Teste', email: ALUNO.email, valorCentavos: 2000,
      status: 'aguardando_conferencia', criadoEm: ts(), atualizadoEm: ts()
    });
    rid = ref.id;
  });
  const conferir = (conta, valor) => {
    const b = db(conta).batch();
    b.update(db(conta).doc('recargas/' + rid), { status: 'conferida', atualizadoEm: ts(), atualizadoPor: conta.uid });
    b.update(db(conta).doc('usuarios/aluno1'), { saldoCentavos: FV.increment(valor), ultimaRecarga: rid });
    return b.commit();
  };
  test('recarga acima de R$ 500,00 é negada', async () => {
    await assertFails(db(ALUNO).collection('recargas').add({
      uid: ALUNO.uid, nome: 'Ana', email: ALUNO.email, valorCentavos: 50001,
      status: 'aguardando_conferencia', criadoEm: ts(), atualizadoEm: ts()
    }));
  });
  test('aluno não confere a própria recarga', async () => {
    await assertFails(conferir(ALUNO, 2000));
  });
  test('caixa confere e credita o valor exato no mesmo lote', async () => {
    await assertSucceeds(conferir(CAIXA, 2000));
  });
  test('caixa não credita valor diferente da recarga', async () => {
    await assertFails(conferir(CAIXA, 5000));
  });
  test('a mesma recarga não credita duas vezes', async () => {
    await conferir(CAIXA, 2000);
    await assertFails(conferir(CAIXA, 2000));
  });
  test('caixa marca recarga como recusada sem mexer no saldo', async () => {
    await assertSucceeds(db(CAIXA).doc('recargas/' + rid).update({
      status: 'recusada', atualizadoEm: ts(), atualizadoPor: CAIXA.uid
    }));
  });
});
