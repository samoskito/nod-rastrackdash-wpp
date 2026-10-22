// Gera as fixtures sintéticas WAHA GoWS (nenhum dado real). Uso: node generate.mjs <pasta>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
mkdirSync(out, { recursive: true });

const SESSION = "aluno-sessao-teste";
const SELF = "5500900009999";
const SELF_LID = "100000000009999";
const ENV = { version: "2026.9.2", engine: "GOWS", tier: "CORE", browser: null };
const me = { id: `${SELF}@c.us`, lid: `${SELF_LID}@lid`, pushName: "Loja Sintética" };
const THUMB_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAFNJTlRFVElDT19USFVNQk5BSUw=";

function clid(n) {
  const body = `Sint3tico-CtwaClid_Fixture${n}`;
  let s = "Af";
  while (s.length < 100) s += body;
  return s.slice(0, 100);
}
function ctwaPayload(n) {
  return Buffer.from(`synthetic-ctwa-payload-${n}-`.repeat(14)).toString("base64");
}
function msgId(n) {
  return `3EB0${String(n).padStart(18, "0")}`;
}
function iso(ts) {
  return new Date((ts - 3 * 3600) * 1000).toISOString().replace(".000Z", "-03:00");
}

function adReply(n, { withClid = true, sourceUrl } = {}) {
  return {
    title: `Anúncio sintético ${n}`,
    body: "Texto sintético do anúncio para teste.",
    mediaType: 1,
    thumbnailURL: `https://cdn.example.invalid/thumb/${n}.jpg`,
    thumbnail: THUMB_B64,
    sourceType: "ad",
    sourceID: `12020000000000000${n}`,
    sourceURL: sourceUrl ?? `https://fb.me/0Synth${n}`,
    containsAutoReply: false,
    renderLargerThumbnail: true,
    showAdAttribution: true,
    ...(withClid ? { ctwaClid: clid(n) } : {}),
    ...(withClid ? {} : { adContextPreviewDismissed: false }),
  };
}

function adContext(n, opts) {
  return {
    externalAdReply: adReply(n, opts),
    conversionSource: "FB_Ads",
    conversionData: Buffer.from(`synthetic-conversion-${n}`).toString("base64"),
    conversionDelaySeconds: 0,
    entryPointConversionSource: opts?.entry ?? "ctwa_ad",
    entryPointConversionApp: opts?.app ?? "instagram",
    entryPointConversionDelaySeconds: 4,
    ctwaPayload: ctwaPayload(n),
  };
}

function info({
  chat,
  sender,
  senderAlt = "",
  recipientAlt = "",
  fromMe = false,
  isGroup = false,
  addressing = "",
  id,
  type = "text",
  mediaType = "",
  pushName = "",
  ts,
}) {
  return {
    Chat: chat,
    Sender: sender,
    IsFromMe: fromMe,
    IsGroup: isGroup,
    AddressingMode: addressing,
    SenderAlt: senderAlt,
    RecipientAlt: recipientAlt,
    BroadcastListOwner: "",
    BroadcastRecipients: null,
    ID: id,
    ServerID: 0,
    Type: type,
    PushName: pushName,
    Timestamp: iso(ts),
    Category: "",
    Multicast: false,
    MediaType: mediaType,
    Edit: "",
    MsgBotInfo: { EditType: "", EditTargetID: "", EditSenderTimestampMS: "0001-01-01T00:00:00Z" },
    MsgMetaInfo: { TargetID: "", TargetSender: "", TargetChat: "", DeprecatedLIDSession: null, ThreadMessageID: "", ThreadMessageSenderJID: "" },
    VerifiedName: null,
    DeviceSentMeta: null,
  };
}

function flags(extra = {}) {
  return {
    IsEphemeral: false,
    IsViewOnce: false,
    IsViewOnceV2: false,
    IsViewOnceV2Extension: false,
    IsDocumentWithCaption: false,
    IsLottieSticker: false,
    IsBotInvoke: false,
    IsEdit: false,
    SourceWebMsg: null,
    UnavailableRequestID: "",
    RetryCount: 0,
    NewsletterMeta: null,
    ...extra,
  };
}

function envelope(n, event, payload, ts) {
  return {
    id: `evt_01k8${String(n).padStart(22, "0")}`,
    timestamp: ts * 1000 + 250,
    event,
    session: SESSION,
    me,
    payload,
    engine: "GOWS",
    environment: ENV,
  };
}

function messagePayload({ id, ts, from, to, fromMe, body, hasMedia = false, media = null, data, source = "app" }) {
  return {
    id: `${fromMe}_${(fromMe ? to : from).replace(/@.*/, "")}@${(fromMe ? to : from).endsWith("@lid") ? "lid" : "c.us"}_${id}`,
    timestamp: ts,
    from,
    fromMe,
    source,
    to,
    participant: null,
    body,
    hasMedia,
    media,
    ack: fromMe ? 1 : 2,
    ackName: fromMe ? "SERVER" : "DEVICE",
    replyTo: null,
    _data: data,
  };
}

const files = {};
const ts0 = 1_792_000_000; // 2026-10 (synthetic)

// 1. CTWA with clid; contact addressed by LID, phone in SenderAlt.
{
  const n = 1, id = msgId(n), ts = ts0 + n;
  const phone = "5500900000101", lid = "100000000000101";
  files["message-ctwa-clid.json"] = envelope(n, "message", messagePayload({
    id, ts, from: `${lid}@lid`, to: `${SELF}@c.us`, fromMe: false,
    body: "Olá! Vi o anúncio e quero saber mais (mensagem sintética).",
    data: {
      Info: info({ chat: `${lid}@lid`, sender: `${lid}@lid`, senderAlt: `${phone}@s.whatsapp.net`, addressing: "lid", id, pushName: "Contato Sintético 01", ts }),
      Message: { extendedTextMessage: { text: "Olá! Vi o anúncio e quero saber mais (mensagem sintética).", previewType: 0, contextInfo: adContext(n), inviteLinkGroupTypeV2: 0 } },
      ...flags(),
    },
  }), ts);
}

// 2. Status ad: sourceID only, no ctwaClid (Meta omits it for WhatsApp Status placements).
{
  const n = 2, id = msgId(n), ts = ts0 + n;
  const phone = "5500900000102", lid = "100000000000102";
  files["message-ctwa-source-id-only.json"] = envelope(n, "message", messagePayload({
    id, ts, from: `${lid}@lid`, to: `${SELF}@c.us`, fromMe: false,
    body: "Oi, tenho interesse (mensagem sintética).",
    data: {
      Info: info({ chat: `${lid}@lid`, sender: `${lid}@lid`, senderAlt: `${phone}@s.whatsapp.net`, addressing: "lid", id, pushName: "Contato Sintético 02", ts }),
      Message: { extendedTextMessage: { text: "Oi, tenho interesse (mensagem sintética).", contextInfo: adContext(n, { withClid: false, entry: "ctwa_ad", app: "whatsapp", sourceUrl: "https://wa.me/wamo/0Synth2" }) } },
      ...flags(),
    },
  }), ts);
}

// 3. Organic message, phone-addressed chat; SenderAlt carries the LID.
{
  const n = 3, id = msgId(n), ts = ts0 + n;
  const phone = "5500900000103", lid = "100000000000103";
  files["message-organic.json"] = envelope(n, "message", messagePayload({
    id, ts, from: `${phone}@c.us`, to: `${SELF}@c.us`, fromMe: false,
    body: "Bom dia, qual o horário de atendimento? (mensagem sintética)",
    data: {
      Info: info({ chat: `${phone}@s.whatsapp.net`, sender: `${phone}@s.whatsapp.net`, senderAlt: `${lid}@lid`, addressing: "pn", id, pushName: "Contato Sintético 03", ts }),
      Message: { conversation: "Bom dia, qual o horário de atendimento? (mensagem sintética)" },
      ...flags(),
    },
  }), ts);
}

files["message-organic.json"].payload.notifyName = "Contato Sintético 03";

// 4. Team message (message.any, fromMe) to a LID chat, phone in RecipientAlt, self with :NN device.
{
  const n = 4, id = msgId(n), ts = ts0 + n;
  const phone = "5500900000101", lid = "100000000000101";
  files["message-any-team-recipient-alt.json"] = envelope(n, "message.any", messagePayload({
    id, ts, from: `${SELF}@c.us`, to: `${lid}@lid`, fromMe: true,
    body: "Olá! Segue o link de pagamento (mensagem sintética).",
    data: {
      Info: info({ chat: `${lid}@lid`, sender: `${SELF_LID}:7@lid`, senderAlt: `${SELF}:7@s.whatsapp.net`, recipientAlt: `${phone}@s.whatsapp.net`, fromMe: true, addressing: "lid", id, pushName: "Loja Sintética", ts }),
      Message: { extendedTextMessage: { text: "Olá! Segue o link de pagamento (mensagem sintética)." } },
      ...flags(),
    },
  }), ts);
}

// 5. Team message (message.any, fromMe) without RecipientAlt, phone chat.
{
  const n = 5, id = msgId(n), ts = ts0 + n;
  const phone = "5500900000103";
  files["message-any-team-no-recipient-alt.json"] = envelope(n, "message.any", messagePayload({
    id, ts, from: `${SELF}@c.us`, to: `${phone}@c.us`, fromMe: true, source: "api",
    body: "Pedido confirmado (mensagem sintética).",
    data: {
      Info: info({ chat: `${phone}@s.whatsapp.net`, sender: `${SELF}:0@s.whatsapp.net`, senderAlt: "", recipientAlt: "", fromMe: true, addressing: "pn", id, pushName: "Loja Sintética", ts }),
      Message: { conversation: "Pedido confirmado (mensagem sintética)." },
      ...flags(),
    },
  }), ts);
}

// 6. message.any copy of an inbound message (fromMe=false): duplicate of "message".
{
  const base = structuredClone(files["message-ctwa-clid.json"]);
  base.event = "message.any";
  base.id = `evt_01k8${"6a".padStart(22, "0")}`;
  files["message-any-inbound-duplicate.json"] = base;
}

// 7. JID with :NN device suffix on the sender (phone in SenderAlt with suffix).
{
  const n = 7, id = msgId(n), ts = ts0 + n;
  const phone = "550000000107", lid = "100000000000107"; // 12 digits (no 9th digit)
  files["message-jid-device-suffix.json"] = envelope(n, "message", messagePayload({
    id, ts, from: `${lid}@lid`, to: `${SELF}@c.us`, fromMe: false,
    body: "Mensagem enviada do computador (sintética).",
    data: {
      Info: info({ chat: `${lid}@lid`, sender: `${lid}:23@lid`, senderAlt: `${phone}:23@s.whatsapp.net`, addressing: "lid", id, pushName: "Contato Sintético 07", ts }),
      Message: { conversation: "Mensagem enviada do computador (sintética)." },
      ...flags(),
    },
  }), ts);
}

// 8. First message is an image (caption) coming from an ad, with clid.
{
  const n = 8, id = msgId(n), ts = ts0 + n;
  const phone = "5500900000108", lid = "100000000000108";
  files["message-ctwa-image-first.json"] = envelope(n, "message", messagePayload({
    id, ts, from: `${lid}@lid`, to: `${SELF}@c.us`, fromMe: false,
    body: "Quero esse modelo (legenda sintética)",
    hasMedia: true,
    media: { url: `https://waha.example.invalid/api/files/${SESSION}/${id}.jpeg`, mimetype: "image/jpeg", filename: null, error: null },
    data: {
      Info: info({ chat: `${lid}@lid`, sender: `${lid}@lid`, senderAlt: `${phone}@s.whatsapp.net`, addressing: "lid", id, type: "media", mediaType: "image", pushName: "Contato Sintético 08", ts }),
      Message: {
        imageMessage: {
          URL: "https://mmg.example.invalid/synthetic-image.enc",
          mimetype: "image/jpeg",
          caption: "Quero esse modelo (legenda sintética)",
          fileSHA256: "U1lOVEhFVElDLVNIQTI1Ng==",
          fileLength: 12345,
          height: 640,
          width: 480,
          mediaKey: "U1lOVEhFVElDLU1FRElBLUtFWQ==",
          jpegThumbnail: THUMB_B64,
          contextInfo: adContext(n, { app: "facebook" }),
        },
      },
      ...flags(),
    },
  }), ts);
}

// Business contact: verified name (WhatsApp Business) is a display name too.
files["message-ctwa-image-first.json"].payload._data.Info.VerifiedName = {
  Certificate: { details: "U1lOVEhFVElDLUNFUlQ=", signature: "U1lOVEhFVElDLVNJRw==" },
  Details: { serial: 1, issuer: "smb:wa", verifiedName: "Loja Sintética Verificada" },
};

// 9. Ephemeral (disappearing messages) wrapper with ad context, clid.
{
  const n = 9, id = msgId(n), ts = ts0 + n;
  const phone = "5500900000109";
  const inner = { extendedTextMessage: { text: "Oi! (mensagem temporária sintética)", contextInfo: { ...adContext(n), expiration: 604800 } } };
  files["message-ctwa-ephemeral.json"] = envelope(n, "message", messagePayload({
    id, ts, from: `${phone}@c.us`, to: `${SELF}@c.us`, fromMe: false,
    body: "Oi! (mensagem temporária sintética)",
    data: {
      Info: info({ chat: `${phone}@s.whatsapp.net`, sender: `${phone}@s.whatsapp.net`, addressing: "pn", id, pushName: "Contato Sintético 09", ts }),
      Message: { ephemeralMessage: { message: inner } },
      RawMessage: { ephemeralMessage: { message: inner } },
      ...flags({ IsEphemeral: true }),
    },
  }), ts);
}

// 10. View-once (V2) image with ad context, clid.
{
  const n = 10, id = msgId(n), ts = ts0 + n;
  const phone = "5500900000110", lid = "100000000000110";
  files["message-ctwa-view-once.json"] = envelope(n, "message", messagePayload({
    id, ts, from: `${lid}@lid`, to: `${SELF}@c.us`, fromMe: false,
    body: "",
    hasMedia: true,
    media: { url: `https://waha.example.invalid/api/files/${SESSION}/${id}.jpeg`, mimetype: "image/jpeg", filename: null, error: null },
    data: {
      Info: info({ chat: `${lid}@lid`, sender: `${lid}@lid`, senderAlt: `${phone}@s.whatsapp.net`, addressing: "lid", id, type: "media", mediaType: "image", pushName: "Contato Sintético 10", ts }),
      Message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg", viewOnce: true, jpegThumbnail: THUMB_B64, contextInfo: adContext(n) } } } },
      ...flags({ IsViewOnce: true, IsViewOnceV2: true }),
    },
  }), ts);
}

// 11. Group message: never a lead.
{
  const n = 11, id = msgId(n), ts = ts0 + n;
  const phone = "5500900000111";
  files["message-group.json"] = envelope(n, "message", messagePayload({
    id, ts, from: "120300000000000011@g.us", to: `${SELF}@c.us`, fromMe: false,
    body: "Bom dia, grupo (mensagem sintética)",
    data: {
      Info: info({ chat: "120300000000000011@g.us", sender: `${phone}@s.whatsapp.net`, isGroup: true, addressing: "pn", id, pushName: "Contato Sintético 11", ts }),
      Message: { conversation: "Bom dia, grupo (mensagem sintética)" },
      ...flags(),
    },
  }), ts);
  files["message-group.json"].payload.participant = `${phone}@c.us`;
}

// 12. WhatsApp Status (status@broadcast): never a lead.
{
  const n = 12, id = msgId(n), ts = ts0 + n;
  const lid = "100000000000112";
  files["message-status-broadcast.json"] = envelope(n, "message", messagePayload({
    id, ts, from: "status@broadcast", to: `${SELF}@c.us`, fromMe: false,
    body: "",
    hasMedia: true,
    media: { url: `https://waha.example.invalid/api/files/${SESSION}/${id}.jpeg`, mimetype: "image/jpeg", filename: null, error: null },
    data: {
      Info: info({ chat: "status@broadcast", sender: `${lid}@lid`, isGroup: true, addressing: "lid", id, type: "media", mediaType: "image", pushName: "Contato Sintético 12", ts }),
      Message: { imageMessage: { mimetype: "image/jpeg", jpegThumbnail: THUMB_B64 } },
      ...flags(),
    },
  }), ts);
  files["message-status-broadcast.json"].payload.participant = `${lid}@lid`;
}

// 13. LID only, no SenderAlt: phone cannot be resolved.
{
  const n = 13, id = msgId(n), ts = ts0 + n;
  const lid = "100000000000113";
  files["message-lid-without-sender-alt.json"] = envelope(n, "message", messagePayload({
    id, ts, from: `${lid}@lid`, to: `${SELF}@c.us`, fromMe: false,
    body: "Olá (mensagem sintética)",
    data: {
      Info: info({ chat: `${lid}@lid`, sender: `${lid}@lid`, senderAlt: "", addressing: "lid", id, pushName: "Contato Sintético 13", ts }),
      Message: { extendedTextMessage: { text: "Olá (mensagem sintética)", contextInfo: adContext(n) } },
      ...flags(),
    },
  }), ts);
}

// 14-17. session.status
const statuses = ["WORKING", "SCAN_QR_CODE", "FAILED", "STOPPED"];
statuses.forEach((status, index) => {
  const n = 14 + index, ts = ts0 + n;
  files[`session-status-${status.toLowerCase().replace(/_/g, "-")}.json`] = {
    id: `evt_01k8${String(n).padStart(22, "0")}`,
    timestamp: ts * 1000,
    event: "session.status",
    session: SESSION,
    me: status === "WORKING" ? me : null,
    payload: { status, statuses: [{ status: "STARTING", timestamp: ts * 1000 - 5000 }, { status, timestamp: ts * 1000 }] },
    engine: "GOWS",
    environment: ENV,
  };
});

for (const [name, value] of Object.entries(files)) {
  writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");
}
console.log(Object.keys(files).length, "fixtures");
