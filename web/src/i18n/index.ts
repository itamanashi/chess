/**
 * Point d'entrée i18n. Aujourd'hui : français uniquement (`fr.ts`).
 * Ajouter une langue = créer `en.ts` avec les mêmes exports nommés et
 * sélectionner ici le dictionnaire actif. Les modules métier importent
 * toujours depuis `i18n/` (jamais `fr` directement de préférence).
 */
export * from './fr';
