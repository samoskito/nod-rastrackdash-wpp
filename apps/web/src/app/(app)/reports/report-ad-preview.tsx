"use client";

import { ImageOff, Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePresentationMode } from "../../../components/presentation-mode-toggle";

type HoverPosition = {
  left: number;
  top: number;
};

const hoverWidth = 312;
const hoverHeight = 468;
const hoverGap = 10;

export function ReportAdPreview({
  adName,
  previewUrl,
  thumbnailUrl,
}: {
  adName: string;
  previewUrl?: string | null;
  thumbnailUrl?: string | null;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const presentationMode = usePresentationMode();
  const [hoverPosition, setHoverPosition] = useState<HoverPosition | null>(
    null,
  );
  const thumbnailSource =
    (!thumbnailFailed && thumbnailUrl) ||
    (!previewFailed && previewUrl) ||
    null;
  const previewSource =
    (!previewFailed && previewUrl) ||
    (!thumbnailFailed && thumbnailUrl) ||
    null;
  const imageAvailable = Boolean(thumbnailSource && previewSource);

  useEffect(() => {
    setPreviewFailed(false);
    setThumbnailFailed(false);
  }, [previewUrl, thumbnailUrl]);

  useEffect(() => {
    if (presentationMode) {
      setHoverPosition(null);
      dialogRef.current?.close();
    }
  }, [presentationMode]);

  function showHoverPreview() {
    if (!imageAvailable || !buttonRef.current) {
      return;
    }

    const rect = buttonRef.current.getBoundingClientRect();
    const fitsOnRight = rect.right + hoverGap + hoverWidth < window.innerWidth;
    const left = fitsOnRight
      ? rect.right + hoverGap
      : Math.max(12, rect.left - hoverWidth - hoverGap);
    const top = Math.min(
      Math.max(12, rect.top - 70),
      Math.max(12, window.innerHeight - hoverHeight),
    );

    setHoverPosition({ left, top });
  }

  function hideHoverPreview() {
    setHoverPosition(null);
  }

  function openPreview() {
    hideHoverPreview();
    dialogRef.current?.showModal();
  }

  function handleThumbnailError() {
    if (thumbnailSource === thumbnailUrl) {
      setThumbnailFailed(true);
      return;
    }

    setPreviewFailed(true);
  }

  function handlePreviewError() {
    if (previewSource === previewUrl) {
      setPreviewFailed(true);
      return;
    }

    setThumbnailFailed(true);
  }

  if (presentationMode || !imageAvailable) {
    return (
      <span
        aria-label={
          presentationMode ? "Criativo oculto" : "Miniatura indisponível"
        }
        className="report-ad-thumbnail unavailable"
        role="img"
        title={presentationMode ? "Criativo oculto" : "Miniatura indisponível"}
      >
        <ImageOff aria-hidden="true" size={17} strokeWidth={1.7} />
      </span>
    );
  }

  return (
    <>
      <button
        aria-label={`Ampliar criativo do anúncio ${adName}`}
        className="report-ad-thumbnail"
        data-presentation-sensitive-media="true"
        onBlur={hideHoverPreview}
        onClick={openPreview}
        onFocus={showHoverPreview}
        onMouseEnter={showHoverPreview}
        onMouseLeave={hideHoverPreview}
        ref={buttonRef}
        title="Ampliar criativo"
        type="button"
      >
        <img
          alt=""
          loading="lazy"
          onError={handleThumbnailError}
          referrerPolicy="no-referrer"
          src={thumbnailSource ?? undefined}
        />
        <span aria-hidden="true" className="report-ad-thumbnail-action">
          <Maximize2 size={13} strokeWidth={2.2} />
        </span>
      </button>

      {hoverPosition
        ? createPortal(
            <div
              aria-hidden="true"
              className="report-ad-hover-preview"
              style={hoverPosition}
            >
              <img
                alt=""
                onError={handlePreviewError}
                referrerPolicy="no-referrer"
                src={previewSource ?? undefined}
              />
              <strong>{adName}</strong>
            </div>,
            document.body,
          )
        : null}

      <dialog className="report-ad-preview-dialog" ref={dialogRef}>
        <div className="report-ad-preview-header">
          <div>
            <span className="micro-label">Criativo do anúncio</span>
            <h3>{adName}</h3>
          </div>
          <button
            aria-label="Fechar"
            className="meta-dialog-close"
            onClick={() => dialogRef.current?.close()}
            title="Fechar"
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        <div className="report-ad-preview-stage">
          <img
            alt={`Criativo do anúncio ${adName}`}
            onError={handlePreviewError}
            referrerPolicy="no-referrer"
            src={previewSource ?? undefined}
          />
        </div>
      </dialog>
    </>
  );
}
