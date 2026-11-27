-- Aditiva: marcador persistido de "preview ausente/falhou" por anúncio.
ALTER TABLE "MetaAd" ADD COLUMN "previewMissUntil" TIMESTAMP(3);
