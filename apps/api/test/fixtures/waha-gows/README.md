# Fixtures WAHA GoWS (sintéticas)

Eventos de webhook da WAHA com o motor **GoWS**, um arquivo por caso, usados
pelos testes do parser `waha` v2 e do receptor `POST /webhooks/whatsapp/:id`
(`apps/api/test/waha-gows/`).

## De onde veio o formato

- **Estrutura:** o envelope da WAHA (`id`, `timestamp`, `event`, `session`,
  `me`, `payload`, `engine`, `environment`) e o evento bruto do GoWS em
  `payload._data` (`Info` com `Chat`, `Sender`, `SenderAlt`, `RecipientAlt`,
  `IsFromMe`, `IsGroup`, `AddressingMode`, `ID`, `PushName`, `Timestamp`…, e
  `Message` com a mensagem do WhatsApp, onde fica o
  `contextInfo.externalAdReply` do anúncio). É o formato que o parser WAHA do
  Rastrackapp lê em produção.
- **Proporções e formatos reais, sem os valores:** o banco do Rastrackapp
  guarda só um resumo estrutural de cada webhook (nome do evento, tamanho,
  nomes de campos reconhecidos), nunca o corpo. Desse resumo e dos registros
  de CTWA detectado vieram os formatos usados aqui: `ctwaClid` começa com
  `Af` e usa base64url (cerca de 100 caracteres), `sourceID` tem de 13 a 18
  dígitos e `sourceURL` é `fb.me/…`, `instagram.com/p/…` ou `wa.me/wamo/…`.
- **Anúncios sem clid:** a auditoria do Rastrackapp (`CLAUDE.md`, ~linha 530)
  achou, em 30 dias, 1.932 payloads únicos com `ctwaPayload`, dos quais 436
  (**cerca de 22%**) vieram sem `externalAdReply.ctwaClid` — boa parte de
  anúncios no Status do WhatsApp, em que a Meta omite o clid. Nos registros de
  lead CTWA detectado da janela atual (22/09 a 22/10) a fração foi menor
  (70 de 1.502, ~5%); a diferença entre as duas medidas não foi investigada.
  Use os 22% da auditoria como referência. Decisão de produto (Samuel): na
  WAHA, esses cliques criam lead de anúncio pelo `sourceID`, como no
  Rastrackapp, sem evento à Meta (não há `ctwa_clid` e o `ctwaPayload` nunca
  é usado como clid).
- **Valores:** todos sintéticos. Nenhum payload real foi copiado.

## Regras de anonimização (conferidas por teste)

`waha-gows-fixtures-anonymity.test.ts` falha se aparecer qualquer valor fora
destes padrões:

| Campo | Valor sintético |
| --- | --- |
| Telefones | DDD `00` (inexistente): `5500900000101`…, loja `5500900009999`; um caso com 12 dígitos (`550000000107`) |
| LID | `1000000000001xx@lid` (mesmo contato = mesmo LID em todos os campos) |
| Nomes (`PushName`, `notifyName`, `VerifiedName`) | `Contato Sintético NN`, `Loja Sintética`, `Loja Sintética Verificada` |
| Textos e legendas | terminam em “(mensagem sintética)” |
| `ctwaClid` | `AfSint3tico-CtwaClid_Fixture…` (100 caracteres, base64url) |
| `ctwaPayload`, `conversionData`, miniaturas | base64 de textos sintéticos |
| `sourceID` / `sourceURL` | `12020000000000000N` / `1202000000000000NN`, `https://fb.me/0SynthN`, `https://wa.me/wamo/0Synth2` |
| URLs de mídia e miniatura | domínios `.invalid` |
| IDs de mensagem / evento | `3EB0…NN`, `evt_01k8…NN` |
| Sessão | `aluno-sessao-teste` |

## Casos

| Arquivo | Caso |
| --- | --- |
| `message-ctwa-clid.json` | Clique em anúncio com `externalAdReply.ctwaClid`; contato por `@lid` com telefone em `SenderAlt` |
| `message-ctwa-source-id-only.json` | Anúncio de Status: só `sourceID`, sem clid (com `ctwaPayload`, que nunca é clid) |
| `message-organic.json` | Mensagem orgânica, chat por telefone, LID em `SenderAlt` |
| `message-any-team-recipient-alt.json` | Mensagem do time (`message.any`, `fromMe`) para chat `@lid`, telefone em `RecipientAlt`, loja com sufixo `:7` |
| `message-any-team-no-recipient-alt.json` | Mensagem do time sem `RecipientAlt` (telefone em `payload.to`), loja com `:0` |
| `message-any-inbound-duplicate.json` | Cópia `message.any` de uma mensagem recebida (descartada) |
| `message-jid-device-suffix.json` | JID com sufixo `:23` no `Sender`/`SenderAlt` |
| `message-ctwa-image-first.json` | Primeira mensagem com imagem e legenda, vinda de anúncio |
| `message-ctwa-ephemeral.json` | Mensagem temporária (`ephemeralMessage`) com anúncio |
| `message-ctwa-view-once.json` | Visualização única (`viewOnceMessageV2`) com anúncio |
| `message-group.json` | Grupo (`@g.us`, `IsGroup`) — descartado |
| `message-status-broadcast.json` | Status (`status@broadcast`) — descartado |
| `message-lid-without-sender-alt.json` | Só LID, sem `SenderAlt` — telefone não resolvido |
| `session-status-*.json` | `session.status`: WORKING, SCAN_QR_CODE, FAILED, STOPPED |

## Regenerar

`node apps/api/test/fixtures/waha-gows/generate.mjs apps/api/test/fixtures/waha-gows`
recria os arquivos a partir do gerador (só valores sintéticos). Ao trocar por
amostras reais anonimizadas no futuro, mantenha os padrões da tabela acima
para o teste de anonimização continuar valendo.
