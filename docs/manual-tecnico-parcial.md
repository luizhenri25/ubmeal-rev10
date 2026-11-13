# Manual Técnico Parcial — UBMeal

Versão: 1.0 · Data: 10/11/2026 · Repositório: https://github.com/[usuario-ou-organizacao]/ubmeal

## 1. Público-alvo e tarefas

Este manual se destina a: desenvolvedor que vai assumir a manutenção do UBMeal no próximo período, ou integrante que entrar no grupo agora, e que vai começar pelo painel da cantina (telas do caixa e do preparo). A pessoa já sabe JavaScript e já rodou o projeto seguindo o [README](../README.md).

Ao final da leitura, essa pessoa deve conseguir:

- construir o painel da cantina lendo e alterando os documentos certos no Cloud Firestore, sem quebrar a ligação entre usuário, pedido e código de retirada (resolvida na seção 2)
- alterar o fluxo do pedido (status, Pix, retirada) ou o carrinho sem violar uma regra combinada com a cantina parceira (resolvida na seção 3)

## 2. Estrutura do banco de dados

### Visão geral

O UBMeal usa o **Cloud Firestore** (banco NoSQL do Firebase, SDK 10.12.2). No Firestore não há tabelas: os dados ficam em **coleções**, e cada coleção guarda **documentos** com campos. Este manual chama cada coleção de "tabela" para seguir o modelo da disciplina. São 4 coleções: `usuarios`, `pedidos`, `codigos` e `equipe`.

O app web conversa direto com o Firestore pelo SDK, sem API própria no meio. Por isso, quem decide o que cada pessoa pode ler e gravar é o arquivo `firestore.rules`, na raiz do repositório (ver RN12 e RN13 na seção 3).

O cardápio ainda não está no banco: os produtos ficam na constante `PRODUTOS`, no `script.js`. Levar o cardápio para uma coleção `produtos` é o item 12 do Product Backlog.

O diagrama abaixo está em `docs/img/der-firestore.png`.

![Diagrama das coleções do Cloud Firestore](img/der-firestore.png)

#### Tabela usuarios

Guarda a conta, as preferências e o saldo de cada pessoa que entrou com o Google. Caminho: `usuarios/{uid}`.

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| (id do documento) | string | Sim | o `uid` da conta no Firebase Authentication |
| nome | string | Sim | nome mostrado no app e no pedido; começa com o nome do Google e pode ser editado |
| email | string | Sim | e-mail da conta Google |
| tipo | string ou null | Sim | `faculdade`, `basica`, `funcionario` ou `pais`; fica `null` até o primeiro acesso ser concluído |
| telefone | string | Não | contato para problemas com o pedido |
| filho | string | Não | último nome de aluno informado por um responsável (`tipo = pais`) |
| foto | string | Não | endereço da foto do Google ou imagem JPEG 256×256 em data URL |
| fotoEm | number | Não | data da última troca de foto, em milissegundos (regra dos 60 dias) |
| saldo | number | Sim | saldo pré-pago em reais, com duas casas (ex.: `12.5`) |
| senhaPag | string ou null | Não | senha de 6 dígitos da tela de cartões. Atenção: hoje fica em texto puro |
| senhaEm | number | Não | data de criação da senha, em milissegundos (validade de 90 dias) |
| cartoes | array de map | Não | cartões salvos: `id`, `last4`, `bandeira`, `tipo`, `validade`, `nome`. O número completo nunca é gravado |
| carrinho | array de map | Não | itens ainda não pedidos: `id` do produto, `qty` (1 a 20) e `obs` (até 140 caracteres) |
| historico | array de map | Não | últimos 12 pedidos retirados: `resumo`, `itens`, `data`, `total`, `tint` |
| notif | map | Não | `promo` e `pronto` (boolean): avisos que a pessoa ligou |
| atualizadoEm | timestamp | Sim | hora da última gravação, preenchida pelo servidor |

Relacionamentos: um usuário tem vários pedidos (`pedidos.uid` aponta para o id deste documento). O `historico` é uma cópia resumida dos pedidos retirados, guardada aqui para a tela de histórico abrir sem consultar a coleção `pedidos`.

#### Tabela pedidos

Guarda cada pedido feito no app. É o documento que o aluno, o caixa e o preparo acompanham em tempo real. Caminho: `pedidos/{id gerado pelo Firestore}`.

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| (id do documento) | string | Sim | gerado automaticamente pelo Firestore |
| uid | string | Sim | dono do pedido (id em `usuarios`) |
| codigo | string | Sim | código de retirada no formato `UB-` + 4 dígitos (ex.: `UB-4821`), único no dia |
| dia | string | Sim | dia do pedido no formato `AAAA-MM-DD`; junto com `codigo`, forma o id em `codigos` |
| status | string | Sim | etapa do pedido; os valores possíveis estão no diagrama de status da seção 3 |
| ativo | boolean | Sim | `true` enquanto o pedido está em andamento; `false` em `retirado`, `cancelado` ou `nao_retirado` |
| itens | array de map | Sim | cada item: `id`, `nome`, `preco` (preço na hora da compra), `qty` e `obs` |
| total | number | Sim | valor total em reais, maior que zero |
| pagamento | string | Sim | `pix`, `saldo`, `balcao` ou `cartao` |
| pagamentoNome | string | Sim | nome da forma de pagamento mostrado na tela (ex.: `Pix na hora`) |
| retirada | string | Sim | `horario` (horário escolhido) ou `fila` |
| horario | string ou null | Sim | `09:40`, `10:15`, `12:00` ou `15:20`; `null` quando `retirada = fila` |
| nome | string | Sim | nome do cliente, que o caixa confere na retirada |
| email | string | Sim | e-mail do cliente |
| tipo | string | Sim | tipo de usuário na hora do pedido |
| filho | string | Sim | aluno que vai retirar, quando quem pediu é responsável; vazio nos outros casos |
| expiraEm | number ou null | Sim | prazo do Pix em milissegundos (10 min depois da criação); `null` se não for Pix |
| saldoDepois | number | Não | saldo que sobrou; só existe quando `pagamento = saldo` |
| criadoEm | timestamp | Sim | hora de criação, preenchida pelo servidor |
| atualizadoEm | timestamp | Sim | hora da última mudança, preenchida pelo servidor |
| atualizadoPor | string | Não | `uid` do membro da equipe que mudou o status por último |

Relacionamentos: cada pedido pertence a um usuário, pela chave `uid`. Cada pedido reserva exatamente um documento em `codigos`, ligado pelo campo `pedidoId` de lá. O campo `atualizadoPor` aponta para um documento de `equipe`.

Para o painel da cantina: o app do aluno só usa filtros de igualdade (`uid ==` e `ativo ==`), que não precisam de índice. Uma consulta como "pedidos ativos ordenados por horário" (`where('ativo', '==', true).orderBy('horario')`) precisa de um índice composto. O próprio erro do Firestore traz o link para criá-lo no console. Para mudar o status, use a função `mudarStatusPedido(id, status)` do `script.js`: ela já atualiza `ativo`, `atualizadoEm` e `atualizadoPor` como as regras exigem.

#### Tabela codigos

Reserva o código de retirada de cada dia, para que dois pedidos nunca recebam o mesmo `UB-XXXX` no mesmo dia. Caminho: `codigos/{dia}_{codigo}` (ex.: `codigos/2026-11-13_UB-4821`).

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| (id do documento) | string | Sim | `dia` + `_` + `codigo` |
| uid | string | Sim | usuário que fez o pedido |
| pedidoId | string | Sim | id do documento em `pedidos` |
| criadoEm | timestamp | Sim | hora da reserva, preenchida pelo servidor |

Relacionamentos: cada código pertence a um pedido, pela chave `pedidoId`, e a um usuário, pela chave `uid`. O documento e o pedido são gravados juntos, numa transação (`criarPedidoNuvem` no `script.js`). As regras não deixam alterar nem apagar uma reserva.

#### Tabela equipe

Lista as contas que trabalham na cantina e podem mudar o status dos pedidos. Caminho: `equipe/{uid}`.

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| (id do documento) | string | Sim | o `uid` da conta Google da pessoa no Firebase Authentication |
| papel | string | Sim | `caixa`, `preparo` ou `dono` |

Relacionamentos: o id do documento é o mesmo `uid` de Authentication. Um membro da equipe pode alterar vários pedidos (`pedidos.atualizadoPor`). Esta coleção só é criada e editada pelo Console do Firebase: as regras bloqueiam qualquer gravação feita pelo app.

## 3. Regras de negócio

### Visão geral

As regras abaixo vieram dos requisitos e das histórias de usuário do Product Backlog (itens 1 a 22) e do que foi combinado com a cantina Universidade do Lanche no levantamento dos processos AS-IS e TO-BE. Cada uma, se for quebrada, faz o app entregar o pedido errado, cobrar errado ou perder dados.

Algumas regras são aplicadas em dois lugares: no `script.js`, para a tela reagir na hora, e no `firestore.rules`, para que ninguém consiga contornar a regra pelo console do navegador. Quando alterar uma delas, altere os dois arquivos.

![Ciclo de vida do campo pedidos.status](img/fluxo-status-pedido.png)

| Código | Regra | Onde é aplicada no código | Exemplo do que acontece |
|---|---|---|---|
| RN01 | Só faz pedido quem entrou com uma conta Google | `script.js` → `entrarComGoogle()` e `aoMudarLogin()`; `firestore.rules` → `logado()` | Sem login, o app mostra só a tela de entrada; uma gravação em `pedidos` sem login é negada |
| RN02 | No primeiro acesso, a pessoa informa nome e tipo de usuário antes de ver a cantina | `script.js` → ação `salvar-perfil` | Tocar em **Continuar** sem escolher o tipo mostra "Escolha o seu perfil" |
| RN03 | Responsável (`tipo = pais`) informa o nome do aluno que vai retirar | `script.js` → `confirmarPedido()` | Sem o nome do aluno, o pedido não é enviado e o campo recebe o foco |
| RN04 | No máximo 20 unidades do mesmo item e observação com até 140 caracteres | `script.js` → `adicionar()`, `mudarQty()`, `limparCarrinho()` (constantes `MAX_QTD` e `MAX_OBS`) | Ao chegar a 20, o botão **+** desativa e aparece "Máximo de 20 unidades por item" |
| RN05 | O mesmo produto com observações diferentes vira linhas separadas no carrinho e no pedido | `script.js` → `adicionar()` e `limparCarrinho()` | "Misto quente" e "Misto quente · sem tomate" aparecem como duas linhas para a cantina |
| RN06 | Cada pessoa tem no máximo um pedido em andamento | `script.js` → `temPedidoAtivo()` em `confirmarPedido()` | Com um pedido ativo, **Confirmar** mostra "Você já tem o pedido UB-XXXX em andamento" e abre **Pedidos** |
| RN07 | O código de retirada `UB-XXXX` é único no dia | `script.js` → `criarPedidoNuvem()`; `firestore.rules` → `match /codigos/{id}` | Se o código sorteado já foi usado hoje, a transação sorteia outro (até 6 tentativas) |
| RN08 | O status inicial depende do pagamento: Pix começa em `aguardando_pix`; saldo, cartão e balcão começam em `recebido` | `script.js` → `confirmarPedido()`; `firestore.rules` → `allow create` em `pedidos` | Um pedido Pix criado já como `pronto` é negado pelas regras |
| RN09 | O Pix vence em 10 minutos; depois disso o pedido é cancelado | `script.js` → `iniciarContagem()`, `expirarPix()` (constante `PIX_MINUTOS`) | A contagem segue o campo `expiraEm`, então recarregar a página não zera o tempo; em 0:00 o status vira `cancelado`. Se o app estiver fechado, o cancelamento acontece quando o aluno abrir o app de novo |
| RN10 | "Já fiz o pagamento" não confirma o Pix: o pedido vai para conferência e o caixa confere no app do banco | `script.js` → `declararPix()`; `firestore.rules` → `allow update` do dono | O status passa a `aguardando_conferencia` e a tela mostra "Conferindo seu Pix" |
| RN11 | O código de retirada só aparece depois que o pagamento é confirmado | `script.js` → `STATUS_SEM_CODIGO`, `aplicarStatus()`, `renderOk()` | Em `aguardando_pix` e `aguardando_conferencia`, o ticket mostra um cadeado no lugar do código |
| RN12 | Depois de pedir, o aluno só pode passar o próprio Pix de `aguardando_pix` para `aguardando_conferencia` ou `cancelado`; qualquer outra mudança é da cantina | `firestore.rules` → `allow update` em `pedidos` | O aluno rodando `mudarStatusPedido(id, 'pronto')` no console recebe `permission-denied` |
| RN13 | A equipe da cantina muda só `status`, `ativo`, `atualizadoEm` e `atualizadoPor`, e só para os status do ciclo | `firestore.rules` → `ehEquipe()` e `soMuda()` | Um caixa tentando mudar o `total` ou gravar um status inventado é negado |
| RN14 | Pagar com saldo exige saldo maior ou igual ao total; o valor só é debitado depois que o pedido foi gravado | `script.js` → `confirmarPedido()` | Com R$ 5,00 de saldo e pedido de R$ 12,00 aparece "Saldo insuficiente · faltam R$ 7,00"; se a internet cair, o saldo não muda |
| RN15 | Pagar com cartão exige um cartão salvo (a cobrança no cartão está fora desta entrega, item 22 = Won't) | `script.js` → `confirmarPedido()` | Sem cartão: "Adicione um cartão em Conta › Formas de pagamento" |
| RN16 | Recarga de saldo só por Pix, de R$ 1,00 a R$ 500,00 | `script.js` → ação `recarga-gerar` | Pedir R$ 600,00 mostra "O limite por recarga é R$ 500,00" |
| RN17 | A senha de pagamento tem 6 dígitos e vence em 90 dias | `script.js` → `senhaVencida()`, `passoSenha()` (constante `DIAS_SENHA`) | Depois de 90 dias, abrir **Formas de pagamento** pede uma senha nova |
| RN18 | A foto de perfil pode ser trocada uma vez a cada 60 dias | `script.js` → `podeTrocarFoto()` (constante `DIAS_FOTO`) | Antes do prazo, o botão **Trocar foto** fica desativado e mostra a data liberada |
| RN19 | Quem confirma a retirada é o caixa, conferindo o código e o nome; o app do aluno só reage | `script.js` → `ouvirPedido()` e `encerrarPedido()`; `firestore.rules` → `ehEquipe()` | Quando o status vira `retirado`, o pedido sai de **Pedido** e vai para **Histórico** sozinho |
| RN20 | Os dados da conta só são gravados na nuvem depois de serem lidos com sucesso | `script.js` → `carregarNuvem()` e `salvarNuvem()` (variável `nuvemOk`) | Sem internet no login, o app avisa "Sem conexão com a nuvem" e não sobrescreve o saldo nem o histórico guardados |

Regras combinadas com a cantina que ainda não estão no código:

| Código | Regra | Situação |
|---|---|---|
| RN21 | Pedido cancelado que foi pago com saldo devolve o valor ao saldo UBMeal | Prevista no item 18 do backlog (Could). Hoje o cancelamento não devolve o saldo |
| RN22 | Estorno de Pix é combinado entre o dono da cantina e o aluno (saldo, Pix ou dinheiro) | Fica fora do sistema; o painel só vai registrar o cancelamento |
| RN23 | Pedido pronto e não retirado não tem reembolso | O status `nao_retirado` já existe e as regras permitem; a tela do painel que marca esse status ainda será feita |
| RN24 | Horários de retirada que já passaram não podem ser escolhidos | Ainda não aplicada: a tela de pagamento mostra os 4 horários do dia (constante `SLOTS`) sem bloquear os que passaram |

## 4. Próximas seções previstas

| Seção prevista | Quando será incluída |
|---|---|
| Arquitetura básica (C), com o diagrama de componentes e o painel da cantina | Reunião de 04/12/2026 |
| Implantação no servidor (A): publicar no Netlify e configurar os domínios autorizados do Firebase | Reunião de 04/12/2026 |
| Solução de problemas (A): erros de login, regras do Firestore e índices | Entrega final do semestre |
| Referência da API (B1) | Não se aplica por enquanto: o app não tem API própria e fala direto com o Firestore. Entra se a equipe criar Cloud Functions (por exemplo, para a confirmação automática do Pix) |
