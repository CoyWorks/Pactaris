export const catalogActions=['catalogList','catalogRead','catalogCreate','catalogUpdate','catalogArchive','catalogRestore'] as const;
export type CatalogAction=typeof catalogActions[number];
export const isCatalogAction=(v:unknown):v is CatalogAction=>typeof v==='string'&&(catalogActions as readonly string[]).includes(v);
