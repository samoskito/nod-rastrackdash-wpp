"use client";

import type { MetaAssetsDto } from "@wpptrack/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchableSelect } from "../../../components/searchable-select";
import { SubmitButton } from "../../../components/submit-button";

type SaveMetaConversionDestinationAction = (
  formData: FormData,
) => void | Promise<void>;

type MetaConversionDestinationFormProps = {
  action: SaveMetaConversionDestinationAction;
  assets: MetaAssetsDto;
  loadBusinessAssetsAction: LoadMetaBusinessAssetsAction;
};

type LoadMetaBusinessAssetsAction = (
  businessId: string,
) => Promise<Pick<MetaAssetsDto, "pixels" | "pages">>;

function firstId<T extends { id: string }>(items: T[]): string {
  return items[0]?.id ?? "";
}

function pixelsForBusiness(assets: MetaAssetsDto, businessId: string) {
  if (!businessId) {
    return [];
  }

  return assets.pixels.filter((pixel) => pixel.businessId === businessId);
}

export function metaPagesForBusiness(
  assets: MetaAssetsDto,
  businessId: string,
) {
  if (!businessId) {
    return [];
  }

  return (assets.pages ?? []).filter((page) => page.businessId === businessId);
}

function initialBusinessId(assets: MetaAssetsDto): string {
  const destination = assets.conversionDestination;
  const selectedPixel = assets.pixels.find(
    (pixel) => pixel.id === destination?.pixelId,
  );
  const selectedPage = (assets.pages ?? []).find(
    (page) => page.id === destination?.pageId,
  );
  const selectedBusinessId = assets.selection.businessId;

  return (
    selectedPixel?.businessId ??
    selectedPage?.businessId ??
    (selectedBusinessId &&
    assets.businesses.some((business) => business.id === selectedBusinessId)
      ? selectedBusinessId
      : null) ??
    firstId(assets.businesses)
  );
}

export function MetaConversionDestinationForm({
  action,
  assets,
  loadBusinessAssetsAction,
}: MetaConversionDestinationFormProps) {
  const destination = assets.conversionDestination;
  const [businessId, setBusinessId] = useState(() => initialBusinessId(assets));
  const businessIdRef = useRef(businessId);
  const [availablePixels, setAvailablePixels] = useState(() => assets.pixels);
  const [availablePages, setAvailablePages] = useState(
    () => assets.pages ?? [],
  );
  const [isLoadingBusinessAssets, setIsLoadingBusinessAssets] = useState(false);
  const loadSequence = useRef(0);
  const pixels = useMemo(
    () => pixelsForBusiness({ ...assets, pixels: availablePixels }, businessId),
    [assets, availablePixels, businessId],
  );
  const pages = useMemo(
    () =>
      metaPagesForBusiness({ ...assets, pages: availablePages }, businessId),
    [assets, availablePages, businessId],
  );
  const [pixelId, setPixelId] = useState(() =>
    destination?.pixelId &&
    pixels.some((pixel) => pixel.id === destination.pixelId)
      ? destination.pixelId
      : firstId(pixels),
  );
  const [pageId, setPageId] = useState(() =>
    destination?.pageId && pages.some((page) => page.id === destination.pageId)
      ? destination.pageId
      : firstId(pages),
  );
  const selectedPixel = useMemo(
    () => pixels.find((pixel) => pixel.id === pixelId),
    [pixels, pixelId],
  );
  const selectedPage = useMemo(
    () => pages.find((page) => page.id === pageId),
    [pages, pageId],
  );

  useEffect(() => {
    const currentBusinessId = businessIdRef.current;
    const nextBusinessId = assets.businesses.some(
      (business) => business.id === currentBusinessId,
    )
      ? currentBusinessId
      : initialBusinessId(assets);
    const nextPixels = pixelsForBusiness(assets, nextBusinessId);
    const nextPages = metaPagesForBusiness(assets, nextBusinessId);

    businessIdRef.current = nextBusinessId;
    setBusinessId(nextBusinessId);
    setAvailablePixels(assets.pixels);
    setAvailablePages(assets.pages ?? []);
    setPixelId(
      destination?.pixelId &&
        nextPixels.some((item) => item.id === destination.pixelId)
        ? destination.pixelId
        : firstId(nextPixels),
    );
    setPageId(
      destination?.pageId &&
        nextPages.some((item) => item.id === destination.pageId)
        ? destination.pageId
        : firstId(nextPages),
    );
  }, [assets, destination?.pageId, destination?.pixelId]);

  async function handleBusinessChange(nextBusinessId: string) {
    const sequence = loadSequence.current + 1;

    loadSequence.current = sequence;
    businessIdRef.current = nextBusinessId;
    setBusinessId(nextBusinessId);
    setPixelId("");
    setPageId("");

    if (!nextBusinessId) {
      setAvailablePixels([]);
      setAvailablePages([]);
      setIsLoadingBusinessAssets(false);
      return;
    }

    setIsLoadingBusinessAssets(true);

    try {
      const nextAssets = await loadBusinessAssetsAction(nextBusinessId);

      if (loadSequence.current !== sequence) {
        return;
      }

      setAvailablePixels(nextAssets.pixels);
      setAvailablePages(nextAssets.pages ?? []);
      setPixelId(firstId(nextAssets.pixels));
      setPageId(firstId(nextAssets.pages ?? []));
    } catch {
      if (loadSequence.current !== sequence) {
        return;
      }

      setAvailablePixels([]);
      setAvailablePages([]);
    } finally {
      if (loadSequence.current === sequence) {
        setIsLoadingBusinessAssets(false);
      }
    }
  }

  return (
    <form className="filter-bar" action={action}>
      <input type="hidden" name="pixelName" value={selectedPixel?.name ?? ""} />
      <input type="hidden" name="pageName" value={selectedPage?.name ?? ""} />
      <SearchableSelect
        name="businessId"
        value={businessId}
        options={assets.businesses.map((business) => ({
          value: business.id,
          label: business.name,
          description: business.id,
        }))}
        onValueChange={handleBusinessChange}
        ariaLabel="Business Manager do destino de conversão"
        placeholder="Buscar BM"
        presentationPlaceholder="BM oculto"
        disabled={isLoadingBusinessAssets}
        sensitive
      />
      <SearchableSelect
        name="pixelId"
        value={pixelId}
        options={pixels.map((pixel) => ({
          value: pixel.id,
          label: pixel.name,
          description: pixel.id,
        }))}
        onValueChange={setPixelId}
        ariaLabel="Pixel do destino de conversão"
        placeholder="Buscar Pixel"
        presentationPlaceholder="Pixel oculto"
        disabled={isLoadingBusinessAssets}
        sensitive
      />
      <SearchableSelect
        name="pageId"
        value={pageId}
        options={pages.map((page) => ({
          value: page.id,
          label: page.name,
          description: page.id,
        }))}
        onValueChange={setPageId}
        ariaLabel="Página Facebook principal"
        placeholder="Buscar página"
        presentationPlaceholder="Página oculta"
        disabled={isLoadingBusinessAssets}
        sensitive
      />
      <SubmitButton
        disabled={isLoadingBusinessAssets || !businessId || !pixelId || !pageId}
        pendingLabel="Salvando destino..."
        statusText="Salvando Pixel e página principal."
      >
        {isLoadingBusinessAssets ? "Carregando ativos" : "Salvar destino"}
      </SubmitButton>
    </form>
  );
}
