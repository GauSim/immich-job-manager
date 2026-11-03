import { Init1793713360422 } from './1793713360422-Init.js';
import { JobAlbumNames1793715748738 } from './1793715748738-JobAlbumNames.js';
import { CandidateFileName1793718000000 } from './1793718000000-CandidateFileName.js';

/**
 * Every migration, in order. Generate new ones with
 * `npm run migration:generate -- src/persistence/migrations/<Name>`, and review
 * them: for SQLite, TypeORM often rebuilds tables (DROP + copy), which cascades
 * deletes through foreign keys. Prefer hand-written `ALTER TABLE … ADD COLUMN`.
 */
export const MIGRATIONS = [
  Init1793713360422,
  JobAlbumNames1793715748738,
  CandidateFileName1793718000000,
];
