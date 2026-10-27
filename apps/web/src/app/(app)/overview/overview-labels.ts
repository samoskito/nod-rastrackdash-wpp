import {
  whatsappNumberLabel,
  type WhatsappNumberOption,
} from "../../../lib/whatsapp-number-options";

/** Name plus the masked phone suffix, shared by the filter bar and notes. */
export function instanceLabel(instance: WhatsappNumberOption): string {
  return whatsappNumberLabel(instance);
}
