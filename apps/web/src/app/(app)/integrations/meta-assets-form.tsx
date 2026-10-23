"use client";

import type { MetaAssetsDto } from "@wpptrack/shared";
import { useEffect, useMemo, useRef, useState } from "react";

type SaveMetaAssetsAction = (formData: FormData) => void | Promise<void>;
type LoadMetaBusinessAssetsAction = (
  businessId: string
) => Promise<Pick<MetaAssetsDto, "adAccounts" | "pixels">>;

type MetaAssetsFormProps = {
  action: SaveMetaAssetsAction;
  assets: MetaAssetsDto;
  loadBusinessAssetsAction: LoadMetaBusinessAssetsAction;
};

export function metaAdAccountsForBusiness(
  assets: MetaAssetsDto,
  businessId: string
) {
  if (!businessId) {
    return [];
  }

  return assets.adAccounts.filter((adAccount) =>
    adAccount.businessId === businessId
  );
}

export function metaPixelsForBusiness(assets: MetaAssetsDto, businessId: string) {
  if (!businessId) {
    return [];
  }

  return assets.pixels.filter((pixel) => pixel.businessId === businessId);
}

function firstId<T extends { id: string }>(items: T[]): string {
  return items[0]?.id ?? "";
}

function initialBusinessId(assets: MetaAssetsDto): string {
  return assets.selection.businessId ?? firstId(assets.businesses);
}

function initialAdAccountId(assets: MetaAssetsDto, businessId: string): string {
  const selected = assets.selection.adAccountId;
  const accounts = metaAdAccountsForBusiness(assets, businessId);

  return selected && accounts.some((item) => item.id === selected)
    ? selected
    : firstId(accounts);
}

function initialPixelId(assets: MetaAssetsDto, businessId: string): string {
  const selected = assets.selection.pixelId;
  const pixels = metaPixelsForBusiness(assets, businessId);

  return selected && pixels.some((item) => item.id === selected)
    ? selected
    : firstId(pixels);
}

export function MetaAssetsForm({
  action,
  assets,
  loadBusinessAssetsAction
}: MetaAssetsFormProps) {
  const [businessId, setBusinessId] = useState(() => initialBusinessId(assets));
  const [availableAdAccounts, setAvailableAdAccounts] = useState(
    () => assets.adAccounts
  );
  const [availablePixels, setAvailablePixels] = useState(() => assets.pixels);
  const [isLoadingBusinessAssets, setIsLoadingBusinessAssets] = useState(false);
  const loadSequence = useRef(0);

  const businessAdAccounts = useMemo(
    () =>
      metaAdAccountsForBusiness(
        { ...assets, adAccounts: availableAdAccounts },
        businessId
      ),
    [assets, availableAdAccounts, businessId]
  );
  const businessPixels = useMemo(
    () => metaPixelsForBusiness({ ...assets, pixels: availablePixels }, businessId),
    [assets, availablePixels, businessId]
  );

  const [adAccountId, setAdAccountId] = useState(() =>
    initialAdAccountId(assets, initialBusinessId(assets))
  );
  const [pixelId, setPixelId] = useState(() =>
    initialPixelId(assets, initialBusinessId(assets))
  );

  useEffect(() => {
    const nextBusinessId = initialBusinessId(assets);

    setBusinessId(nextBusinessId);
    setAvailableAdAccounts(assets.adAccounts);
    setAvailablePixels(assets.pixels);
    setAdAccountId(initialAdAccountId(assets, nextBusinessId));
    setPixelId(initialPixelId(assets, nextBusinessId));
  }, [assets]);

  async function handleBusinessChange(nextBusinessId: string) {
    const sequence = loadSequence.current + 1;

    loadSequence.current = sequence;
    setBusinessId(nextBusinessId);
    setAdAccountId("");
    setPixelId("");

    if (!nextBusinessId) {
      setAvailableAdAccounts([]);
      setAvailablePixels([]);
      setIsLoadingBusinessAssets(false);
      return;
    }

    setIsLoadingBusinessAssets(true);

    try {
      const nextAssets = await loadBusinessAssetsAction(nextBusinessId);

      if (loadSequence.current !== sequence) {
        return;
      }

      setAvailableAdAccounts(nextAssets.adAccounts);
      setAvailablePixels(nextAssets.pixels);
      setAdAccountId(firstId(nextAssets.adAccounts));
      setPixelId(firstId(nextAssets.pixels));
    } catch {
      if (loadSequence.current !== sequence) {
        return;
      }

      setAvailableAdAccounts([]);
      setAvailablePixels([]);
    } finally {
      if (loadSequence.current === sequence) {
        setIsLoadingBusinessAssets(false);
      }
    }
  }

  return (
    <form className="filter-bar" action={action}>
      <select
        className="filter-control"
        name="businessId"
        value={businessId}
        onChange={(event) => handleBusinessChange(event.currentTarget.value)}
        aria-label="Business Manager Meta"
      >
        <option value="">Sem BM</option>
        {assets.businesses.map((business) => (
          <option key={business.id} value={business.id}>
            {business.name}
          </option>
        ))}
      </select>
      <select
        className="filter-control"
        name="adAccountId"
        value={adAccountId}
        onChange={(event) => setAdAccountId(event.currentTarget.value)}
        aria-label="Conta de anúncio Meta"
        disabled={isLoadingBusinessAssets}
      >
        <option value="">Sem conta</option>
        {businessAdAccounts.map((adAccount) => (
          <option key={adAccount.id} value={adAccount.id}>
            {adAccount.name}
          </option>
        ))}
      </select>
      <select
        className="filter-control"
        name="pixelId"
        value={pixelId}
        onChange={(event) => setPixelId(event.currentTarget.value)}
        aria-label="Pixel Meta"
        disabled={isLoadingBusinessAssets}
      >
        <option value="">Sem Pixel</option>
        {businessPixels.map((pixel) => (
          <option key={pixel.id} value={pixel.id}>
            {pixel.name}
          </option>
        ))}
      </select>
      <button className="button" type="submit">
        {isLoadingBusinessAssets ? "Carregando ativos" : "Salvar seleção Meta"}
      </button>
    </form>
  );
}
