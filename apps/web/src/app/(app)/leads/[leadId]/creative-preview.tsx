"use client";

import { ExternalLink, ImageOff } from "lucide-react";
import { useState } from "react";
import { PresentationMask } from "../../../../components/presentation-mask";
import { usePresentationMode } from "../../../../components/presentation-mode-toggle";
import {
  liveCreativeImageUrl,
  storedCreativeThumbnailSrc,
} from "../../../../lib/creative-thumbnail";

type CreativePreviewProps = {
  adId?: string | null;
  adName: string;
  destinationUrl: string | null;
  thumbnailUrl: string | null;
  thumbnailVersion?: string | null;
};

export function creativePreviewSources(input: {
  adId?: string | null;
  thumbnailUrl: string | null;
  thumbnailVersion?: string | null;
}): string[] {
  return [
    storedCreativeThumbnailSrc(input.adId, input.thumbnailVersion),
    liveCreativeImageUrl(input.thumbnailUrl),
  ].filter((source): source is string => Boolean(source));
}

export function CreativePreview({
  adId,
  adName,
  destinationUrl,
  thumbnailUrl,
  thumbnailVersion,
}: CreativePreviewProps) {
  const [failedCount, setFailedCount] = useState(0);
  const presentationMode = usePresentationMode();
  const sources = creativePreviewSources({
    adId,
    thumbnailUrl,
    thumbnailVersion,
  });
  const source = sources[failedCount] ?? null;
  const showImage = Boolean(source) && !presentationMode;

  return (
    <aside className="lead-creative-panel" aria-label="Criativo do anúncio">
      <div
        className="lead-creative-media"
        data-presentation-sensitive-media="true"
      >
        <span className="lead-creative-badge">Criativo</span>
        {showImage ? (
          <img
            alt={`Miniatura do anúncio ${adName}`}
            decoding="async"
            key={source ?? undefined}
            onError={() => setFailedCount((count) => count + 1)}
            referrerPolicy="no-referrer"
            src={source ?? undefined}
          />
        ) : (
          <div className="lead-creative-placeholder">
            <ImageOff aria-hidden="true" size={24} strokeWidth={1.7} />
            <span>
              {presentationMode ? "Criativo oculto" : "Miniatura indisponível"}
            </span>
          </div>
        )}
      </div>

      <div className="lead-creative-caption">
        <div>
          <span className="micro-label">Anúncio atribuído</span>
          <strong>
            <PresentationMask placeholder="Anúncio oculto">
              {adName}
            </PresentationMask>
          </strong>
        </div>
        {destinationUrl && !presentationMode ? (
          <a
            aria-label="Ver anúncio no Instagram em uma nova aba"
            className="button lead-creative-link"
            href={destinationUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" size={16} strokeWidth={1.9} />
            Ver no Instagram
          </a>
        ) : null}
      </div>
    </aside>
  );
}
