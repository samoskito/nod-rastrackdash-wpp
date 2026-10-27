"use client";

import { useDraggable } from "@dnd-kit/core";
import {
  crmDaysInStageLabel,
  crmLeadOriginLabels,
  formatMoney,
  type CrmColumnDto,
  type CrmLeadCardDto,
} from "@wpptrack/shared";
import { ImageOff, Smartphone } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { PresentationMask } from "../../../components/presentation-mask";
import { usePresentationMode } from "../../../components/presentation-mode-toggle";
import {
  liveCreativeImageUrl,
  storedCreativeThumbnailSrc,
} from "../../../lib/creative-thumbnail";

export type CrmCardOptions = {
  showWhatsappNumber: boolean;
  /** Purchase-like column: the card shows the conversion value. */
  showValue: boolean;
  now: Date;
};

function CreativeThumb({ card }: { card: CrmLeadCardDto }) {
  const presentationMode = usePresentationMode();
  const sources = [
    storedCreativeThumbnailSrc(card.adId, card.creative.thumbnailVersion),
    liveCreativeImageUrl(card.creative.thumbnailUrl),
  ].filter((source): source is string => Boolean(source));
  const [failed, setFailed] = useState(0);
  const source = sources[failed];
  if (!source || presentationMode)
    return (
      <span className="crm-card-thumb is-empty" aria-hidden="true">
        <ImageOff size={13} strokeWidth={1.8} />
      </span>
    );
  return (
    <img
      className="crm-card-thumb"
      alt=""
      src={source}
      decoding="async"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed((count) => count + 1)}
      data-presentation-sensitive-media="true"
    />
  );
}

/** Card content (also the drag overlay). */
export function CrmCardBody({
  card,
  options,
}: {
  card: CrmLeadCardDto;
  options: CrmCardOptions;
}) {
  const adLine =
    [card.campaignName, card.adName].filter(Boolean).join(" · ") ||
    "Campanha não identificada";
  return (
    <>
      <span className="crm-card-head">
        <strong className="crm-card-name">
          <PresentationMask placeholder="Lead oculto">
            {card.name ?? "Lead sem nome"}
          </PresentationMask>
        </strong>
        <span className="crm-origin-badge" title="Clique no anúncio para o WhatsApp">
          {crmLeadOriginLabels[card.origin]}
        </span>
      </span>
      <span className="crm-card-phone">
        <PresentationMask placeholder="(00) 00000-0000">
          {card.phoneDisplay ?? "Telefone indisponível"}
        </PresentationMask>
      </span>
      <span className="crm-card-ad" title={adLine}>
        <CreativeThumb card={card} />
        <span className="crm-card-ad-text">
          <PresentationMask placeholder="Campanha oculta">{adLine}</PresentationMask>
        </span>
      </span>
      <span className="crm-card-foot">
        <span className="crm-card-age">
          {crmDaysInStageLabel(card.enteredStageAt, options.now)}
        </span>
        {options.showValue && card.valueCents != null ? (
          <strong className="crm-card-value">
            <PresentationMask placeholder="R$ ••••">
              {formatMoney(card.valueCents, card.currency)}
            </PresentationMask>
          </strong>
        ) : null}
      </span>
      {options.showWhatsappNumber && card.whatsappInstance ? (
        <span className="crm-card-number">
          <Smartphone aria-hidden="true" size={12} strokeWidth={2} />
          <PresentationMask placeholder="Número oculto">
            {card.whatsappInstance.name}
          </PresentationMask>
        </span>
      ) : null}
    </>
  );
}

function cardLabel(card: CrmLeadCardDto): string {
  return `${card.name ?? "Lead sem nome"}`;
}

/**
 * A lead card. Desktop owners/admins drag it (pointer, or keyboard: Space to
 * pick up, arrows to change column, Space/Enter to drop). Enter or a click
 * opens the lead detail. Mobile and analysts get a plain button, and movers
 * on mobile a "Mover para…" select (design §7).
 */
export function CrmCard({
  card,
  column,
  options,
  draggable,
  moveTargets,
  onOpen,
  onMove,
  pending,
}: {
  card: CrmLeadCardDto;
  column: CrmColumnDto;
  options: CrmCardOptions;
  draggable: boolean;
  /** Mobile "Mover para…" (owner/admin only); empty = no select. */
  moveTargets: CrmColumnDto[] | null;
  onOpen: (leadId: string) => void;
  onMove: (leadId: string, toKey: string) => void;
  pending: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.leadId,
    data: { fromKey: column.key },
    disabled: !draggable,
  });

  if (draggable) {
    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
      listeners?.onKeyDown?.(event);
      // While a keyboard drag is active Enter drops the card (dnd-kit listens
      // on the document, after this handler): it must not open the lead too.
      if (event.key === "Enter" && !event.defaultPrevented && !isDragging) {
        event.preventDefault();
        onOpen(card.leadId);
      }
    };
    return (
      <article
        ref={setNodeRef}
        className="crm-card is-draggable"
        data-dragging={isDragging ? "true" : undefined}
        data-pending={pending ? "true" : undefined}
        {...attributes}
        {...listeners}
        onKeyDown={onKeyDown}
        onClick={() => onOpen(card.leadId)}
        aria-label={`${cardLabel(card)}: abrir detalhes ou arrastar para outra etapa`}
      >
        <CrmCardBody card={card} options={options} />
      </article>
    );
  }

  return (
    <article
      className="crm-card"
      data-pending={pending ? "true" : undefined}
    >
      <button
        className="crm-card-open"
        type="button"
        onClick={() => onOpen(card.leadId)}
        aria-label={`Abrir detalhes de ${cardLabel(card)}`}
      >
        <CrmCardBody card={card} options={options} />
      </button>
      {moveTargets && moveTargets.length > 0 ? (
        <label className="crm-card-move">
          <span className="sr-only">Mover {cardLabel(card)} para outra etapa</span>
          <select
            value=""
            disabled={pending}
            onChange={(event) => {
              const toKey = event.currentTarget.value;
              if (toKey) onMove(card.leadId, toKey);
            }}
          >
            <option value="">Mover para…</option>
            {moveTargets.map((target) => (
              <option key={target.key} value={target.key}>
                {target.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </article>
  );
}
