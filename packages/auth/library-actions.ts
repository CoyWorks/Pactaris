export const libraryActions=['documentList','documentRead','documentCreate','documentUpdate','documentPublish','documentArchive','documentRestore','documentDelete','documentAcknowledge'] as const;
export type LibraryAction=typeof libraryActions[number];
export const isLibraryAction=(v:unknown):v is LibraryAction=>typeof v==='string'&&(libraryActions as readonly string[]).includes(v);
