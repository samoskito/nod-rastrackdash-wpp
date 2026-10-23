"use client";

import { ExternalLink, ImageOff } from "lucide-react";
import { useState } from "react";
import { PresentationMask } from "../../../../components/presentation-mask";
import { usePresentationMode } from "../../../../components/presentation-mode-toggle";

type CreativePreviewProps = {
  adName: string;
  destinationUrl: string | null;
  thumbnailUrl: string | null;
};

export function CreativePreview({
  adName,
  destinationUrl,
  thumbnailUrl,
}: CreativePreviewProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const presentationMode = usePresentationMode();
  const showImage = Boolean(thumbnailUrl) && !imageFailed && !presentationMode;

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
            onError={() => setImageFailed(true)}
            src={thumbnailUrl ?? undefined}
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
