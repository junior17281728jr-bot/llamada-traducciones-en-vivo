import { useCallback, useEffect, useState } from 'react';
import {
  selectableLanguages,
  type LanguageCatalog,
  type LanguageCode,
  type LanguageInfo,
  type LanguageRole,
} from '@tw/shared';
import { api } from './http';

let cached: LanguageCatalog | null = null;
let inflight: Promise<LanguageCatalog> | null = null;

/** Test helper. */
export function resetCatalogCache(): void {
  cached = null;
  inflight = null;
}

async function loadCatalog(force = false): Promise<LanguageCatalog> {
  if (cached && !force) return cached;
  inflight ??= api
    .getLanguages()
    .then((catalog) => {
      cached = catalog;
      return catalog;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export interface UseLanguageCatalog {
  catalog: LanguageCatalog | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Languages the user may pick for a role: only those the catalogue confirms. Empty while loading. */
  options: (role: LanguageRole) => LanguageInfo<LanguageCode>[];
}

/** The language catalogue of the server (documentation list or a live refresh). */
export function useLanguageCatalog(): UseLanguageCatalog {
  const [catalog, setCatalog] = useState<LanguageCatalog | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(cached === null);

  const load = useCallback((force: boolean) => {
    setLoading(true);
    loadCatalog(force)
      .then((value) => {
        setCatalog(value);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'No se pudo cargar la lista de idiomas'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!cached) load(false);
  }, [load]);

  return {
    catalog,
    error,
    loading,
    reload: () => load(true),
    options: (role) => (catalog ? selectableLanguages(catalog, role) : []),
  };
}
